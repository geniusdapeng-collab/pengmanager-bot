import { deliveryScorecard, geoPeriodReport } from "./scorecard.mjs";
import {
  assertRevision, DAY, fail, hash, identifier, identity, instant, integer, json, key,
  modeOf, newId, object, objects, openStore, parse, sha, string,
} from './core-store.mjs';
import {
  basePlan, capabilityBinding, capabilityKey, channelsOf, decideOpportunity, normalizeMandate, normalizePlan,
} from './core-plans.mjs';
import { DRAFT_CONTINUATION_ACTION, DRAFT_CONTINUATION_KEY, isSettledTruncatedResponse } from "./draft-continuation.mjs";
import { createEffectService } from './core-effects.mjs';

export { BotError } from './core-store.mjs';
export { CHANNEL_IDS, decideOpportunity } from './core-plans.mjs';

const READ_ROLES = ['owner', 'worker', 'reviewer', 'connector', 'reader', 'system'];
const TASK_WRITERS = ['owner', 'system'];
const WORK_ROLES = ['worker', 'reviewer', 'connector', 'system'];
const STEP_ROLES = {
  discover: ['worker', 'system'],
  research: ['worker', 'system'],
  prepare: ['worker', 'system'],
  review: ['reviewer'],
  publish: ['connector'],
  reconcile: ['connector'],
  observe: ['worker', 'system'],
};
const FOLLOWUPS = {
  discover: ['research', 'prepare', 'observe'],
  research: ['prepare', 'observe'],
  prepare: ['review', 'research'],
  review: ['prepare', 'publish'],
  publish: ['reconcile', 'observe'],
  reconcile: ['publish', 'observe'],
  observe: [],
};
const USABLE_TASK_STATES = ['queued', 'running', 'waiting_input', 'needs_reconcile', 'succeeded', 'partial'];
const IN_PROGRESS_STATES = ['queued', 'running', 'waiting_input', 'needs_reconcile'];
const CHANNEL_RESULT = ['succeeded', 'partial', 'failed', 'expired', 'cancelled'];
const LIVE_RECONCILE = ['reconcile'];
const MAX_FOLLOWUPS = 32;
const QUEUE_AGE_MS = 60 * 60_000;
const QUEUE_DEADLINE_MS = 4 * 60 * 60_000;

export function createBotCore({
  dbPath = ':memory:', clock = Date.now, mode = 'fixture', channels, journal = null, recoveryMode = false, geoPreflight, readProviderReceipt, providerQuotaFingerprint, readTruncatedRevision,
} = {}) {
  if (typeof clock !== 'function') fail(422, 'INVALID_CLOCK', 'A synchronous clock function is required.');
  modeOf(mode);
  const catalog = channelsOf(channels);
  const store = openStore(dbPath, mode);
  const { run, get, all, transaction } = store;
  const recoveryKey = 'recovery_gate';
  if (recoveryMode === true) run("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, 'locked')", recoveryKey);
  let restoring = get('SELECT value FROM metadata WHERE key = ?', recoveryKey)?.value === 'locked';
  const now = () => instant(clock(), 'clock');

  function mandateRow(id, ctx, owned = false) {
    const row = get('SELECT * FROM mandates WHERE scope = ? AND id = ?', ctx.scope, identifier(id, 'mandateId'));
    if (!row) fail(404, 'MANDATE_NOT_FOUND', 'Mandate is not present in this project.');
    if (owned && ctx.role !== 'system' && row.owner_id !== ctx.actorId) fail(403, 'OWNER_REQUIRED', 'Only the mandate owner may make this change.');
    return row;
  }

  function taskRow(id, ctx) {
    const row = get('SELECT * FROM tasks WHERE scope = ? AND id = ?', ctx.scope, identifier(id, 'taskId'));
    if (!row) fail(404, 'TASK_NOT_FOUND', 'Task is not present in this project.');
    return row;
  }

  function rowStep(id, ctx) {
    const row = get('SELECT * FROM steps WHERE scope = ? AND id = ?', ctx.scope, identifier(id, 'stepId'));
    if (!row) fail(404, 'STEP_NOT_FOUND', 'Step is not present in this project.');
    return row;
  }

  function mandateView(row) {
    return {
      ...parse(row.config), id: row.id, revision: row.version, version: row.version, state: row.state,
      ownerId: row.owner_id, revocationEpoch: row.revocation_epoch, createdAt: row.created_at,
      nextRunAt: row.next_run_at, nextReportAt: row.next_report_at, dataMode: mode,
    };
  }

  function stepView(row, task) {
    const link = row.step_key === DRAFT_CONTINUATION_KEY && get('SELECT * FROM draft_continuations WHERE step_id = ?', row.id);
    return {
      ...(link ? { draftContinuation: { sourceStepId: link.source_step_id, jobId: link.job_id, costId: link.cost_id,
        sourceSha256: link.source_sha256, scopeStepId: link.scope_step_id, quotaFingerprint: link.quota_fingerprint } } : {}),
      id: row.id, taskId: row.task_id, mandateId: task.mandate_id, key: row.step_key, kind: row.kind,
      state: row.state, status: row.state, dueAt: row.due_at, epoch: row.epoch, leaseUntil: row.lease_until,
      actorId: row.holder, input: parse(row.input), output: row.output === null ? null : parse(row.output), dataMode: mode,
    };
  }

  function planView(taskId) {
    return all('SELECT * FROM channel_plans WHERE task_id = ? ORDER BY rowid', taskId).map(row => ({ ...parse(row.data), revision: row.version }));
  }

  function taskView(row, detailed = false) {
    const view = {
      id: row.id, mandateId: row.mandate_id, mandateRevision: row.mandate_version, triggerKey: row.trigger_key,
      title: row.title, state: row.state, status: row.state, revision: row.version, version: row.version,
      createdAt: row.created_at, deadlineAt: row.deadline_at, priority: row.priority, input: parse(row.input),
      requiredOutcomes: parse(row.commitments), dataMode: mode,
    };
    if (row.state === 'waiting_input') {
      view.canResume = Boolean(get("SELECT id FROM steps WHERE task_id = ? AND state = 'waiting_input' LIMIT 1", row.id));
    }
    if (row.state === 'partial') {
      const mandate = get('SELECT * FROM mandates WHERE id = ?', row.mandate_id);
      view.canRetryTruncatedDraft = Boolean(draftContinuationSource(row, mandate));
    }
    if (!detailed) return view;
    const channels = planView(row.id);
    const substitutions = channels.filter(channel => channel.substitution).map(channel => ({
      ...channel.substitution, disposition: channel.disposition, artifactRef: channel.artifactRef ?? null,
      receiptRef: channel.receiptRef ?? null,
      achieved: channel.substitution.outcome === 'prepared' ? Boolean(channel.packageHash) && channel.reviewState === 'passed' :
        channel.substitution.outcome === 'public' ? channel.disposition === 'public_verified' : channel.disposition === 'restricted_verified',
    }));
    return {
      ...view, channels, substitutions,
      steps: all('SELECT * FROM steps WHERE task_id = ? ORDER BY rowid', row.id).map(step => stepView(step, row)),
      observations: all('SELECT * FROM observations WHERE task_id = ? ORDER BY due_at, id', row.id).map(observationView),
    };
  }

  function observationView(row) {
    return { ...parse(row.data), id: row.id, taskId: row.task_id, operationKey: row.operation_key, day: row.epoch_day,
      dueAt: row.due_at, state: row.state, dataMode: mode };
  }

  function pushEvent(ctx, type, data, task = null, mandateId = task?.mandate_id ?? null, at = now()) {
    const inserted = run('INSERT INTO events(scope, mandate_id, task_id, actor, at, type, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ctx.scope, mandateId, task?.id ?? null, ctx.actorId, at, type, json(data));
    return Number(inserted.lastInsertRowid);
  }

  function replay(ctx, operation, requestKey, input, fn) {
    const normalized = key(requestKey);
    const operationScope = json([operation, ctx.actorId]);
    const digest = hash(input);
    const previous = get('SELECT * FROM idempotency WHERE scope = ? AND operation = ? AND request_key = ?', ctx.scope, operationScope, normalized);
    if (previous) {
      if (digest !== previous.digest) fail(409, 'IDEMPOTENCY_CONFLICT', 'This key was used for a different request.');
      return parse(previous.response);
    }
    const result = fn();
    run('INSERT INTO idempotency(scope, operation, request_key, digest, response) VALUES (?, ?, ?, ?, ?)',
      ctx.scope, operationScope, normalized, digest, json(result));
    return result;
  }

  function validateEntry(entry, scope, journalKey) {
    object(entry, 'journal entry');
    if (entry.scope !== scope || entry.key !== journalKey || entry.digest !== hash({ scope: entry.scope, key: entry.key, kind: entry.kind, at: entry.at, data: entry.data })) {
      fail(503, 'JOURNAL_INTEGRITY_ERROR', 'Independent journal returned a mismatched record.');
    }
    instant(entry.at, 'entry.at');
    return entry;
  }

  function readJournal(ctx, journalKey) {
    if (mode === 'fixture') return null;
    requireJournal();
    const entry = journalCall('get', { scope: ctx.scope, key: journalKey });
    return entry === null || entry === undefined ? null : validateEntry(entry, ctx.scope, journalKey);
  }

  function requireJournal() {
    if (!journal || ['append', 'get', 'list'].some(method => typeof journal[method] !== 'function')) {
      fail(503, 'JOURNAL_UNAVAILABLE', 'The independent durable journal is unavailable.');
    }
  }

  function journalCall(method, input) {
    try {
      const response = journal[method](input);
      if (response && typeof response.then === 'function') fail(503, 'JOURNAL_UNAVAILABLE', 'The journal must return a synchronous durable receipt.');
      return response;
    } catch {
      fail(503, 'JOURNAL_UNAVAILABLE', 'The independent journal could not be reached.');
    }
  }

  function durable(ctx, journalKey, kind, data, at = now()) {
    if (mode === 'fixture') return { data };
    const previous = readJournal(ctx, journalKey);
    if (previous) {
      if (previous.kind !== kind || hash(previous.data) !== hash(data)) {
        fail(409, 'JOURNAL_CONFLICT', 'This stable journal key contains a different intent.');
      }
      return previous;
    }
    const descriptor = { scope: ctx.scope, key: journalKey, kind, at, data };
    const entry = { ...descriptor, digest: hash(descriptor) };
    const receipt = journalCall('append', entry);
    if (receipt?.digest !== entry.digest || receipt?.key !== entry.key) {
      fail(503, 'JOURNAL_ACK_REQUIRED', 'An independent durable journal receipt is required.');
    }
    return entry;
  }

  function assertOperational() {
    if (restoring) fail(503, 'RECOVERY_READ_ONLY', 'This BOT instance is reconciling a restored journal.');
  }

  function assertActive(row, at = now()) {
    if (row.state !== 'active' || row.expires_at !== null && row.expires_at <= at) {
      fail(403, 'MANDATE_INACTIVE', 'This mandate is paused, revoked, or expired.');
    }
  }

  function ownerId(ctx, mandate) {
    if (ctx.role !== 'system' && ctx.actorId !== mandate.owner_id) fail(403, 'OWNER_REQUIRED', 'Only this mandate owner may make the requested change.');
  }

  function previewMandate(input, auth) {
    const ctx = identity(auth, ['owner', 'system']);
    const config = normalizeMandate(input, now(), catalog);
    const targets = config.allowedActions.map(binding => {
      const { risk, maxDaily, ...target } = binding;
      const row = get('SELECT * FROM capabilities WHERE scope = ? AND capability_key = ?', ctx.scope, capabilityKey(target));
      return { ...binding, ready: risk === 'low' && capable(row, now()), capabilityRevision: row?.version ?? null };
    });
    return { ...config, draft: true, targets, channelCount: catalog.size, dataMode: mode };
  }

  function insertMandate(row) {
    run(`INSERT INTO mandates(id, scope, owner_id, version, revocation_epoch, state, created_at, expires_at, next_run_at, next_report_at, config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, revocation_epoch = excluded.revocation_epoch,
      state = excluded.state, expires_at = excluded.expires_at, next_run_at = excluded.next_run_at,
      next_report_at = excluded.next_report_at, config = excluded.config
      WHERE mandates.scope = excluded.scope AND mandates.version < excluded.version`,
    row.id, row.scope, row.owner_id, row.version, row.revocation_epoch, row.state, row.created_at, row.expires_at,
    row.next_run_at, row.next_report_at, row.config);
  }

  function createMandate(input, auth) {
    const ctx = identity(auth, ['owner']);
    assertOperational();
    object(input, 'mandate');
    return transaction(() => replay(ctx, 'mandate.create', input.idempotencyKey, input, () => {
      const id = `mandate-${hash([ctx.scope, ctx.actorId, input.idempotencyKey]).slice(0, 40)}`;
      const journalKey = `mandate:${id}:1`;
      const prior = readJournal(ctx, journalKey);
      if (prior) {
        if (prior.kind !== 'mandate' || prior.data.requestHash !== hash(input)) fail(409, 'JOURNAL_CONFLICT', 'This mandate key already represents a different request.');
        insertMandate(prior.data.row);
      } else {
        const at = now();
        const config = normalizeMandate(input, at, catalog);
        const row = { id, scope: ctx.scope, owner_id: ctx.actorId, version: 1, revocation_epoch: 0, state: 'active',
          created_at: at, expires_at: config.expiresAt, next_run_at: config.schedule.intervalMs === null ? null : config.schedule.startsAt,
          next_report_at: config.schedule.reportStartsAt, config: json(config) };
        durable(ctx, journalKey, 'mandate', { row, requestHash: hash(input) }, at);
        insertMandate(row);
      }
      pushEvent(ctx, 'mandate.created', { id, revision: 1 }, null, id);
      return mandateView(mandateRow(id, ctx));
    }));
  }

  function renewMandate(id, input, auth) {
    const ctx = identity(auth, ['owner']);
    assertOperational();
    object(input, 'mandate revision');
    return transaction(() => replay(ctx, `mandate.renew:${id}`, input.idempotencyKey, input, () => {
      const prior = mandateRow(id, ctx, true);
      assertRevision(prior, input);
      const previous = parse(prior.config);
      const incoming = input.mandate ?? input;
      const at = now();
      const config = normalizeMandate({ ...previous, ...incoming }, at, catalog);
      const row = { ...prior, version: prior.version + 1, revocation_epoch: prior.revocation_epoch + 1, state: 'active',
        expires_at: config.expiresAt,
        next_run_at: config.schedule.intervalMs === null ? null : incoming.schedule ? Math.max(at, config.schedule.startsAt) : prior.next_run_at ?? at,
        next_report_at: incoming.schedule ? config.schedule.reportStartsAt : prior.next_report_at, config: json(config) };
      commitMandateRevision(ctx, row, input, 'mandate.renewed', at);
      return mandateView(mandateRow(id, ctx));
    }));
  }

  function commitMandateRevision(ctx, row, input, type, at) {
    const journalKey = `mandate:${row.id}:${row.version}`;
    const entry = readJournal(ctx, journalKey);
    if (entry && (entry.kind !== 'mandate' || entry.data.requestHash !== hash(input))) {
      fail(409, 'JOURNAL_CONFLICT', 'This mandate revision has a different durable request.');
    }
    if (!entry) durable(ctx, journalKey, 'mandate', { row, requestHash: hash(input) }, at);
    insertMandate(entry?.data.row ?? row);
    run("UPDATE permits SET state = 'revoked' WHERE state = 'issued' AND task_id IN (SELECT id FROM tasks WHERE mandate_id = ?)", row.id);
    pushEvent(ctx, type, { revision: row.version, revocationEpoch: row.revocation_epoch }, null, row.id, at);
  }

  function revokeMandate(id, input, auth) {
    const ctx = identity(auth, ['owner']);
    object(input, 'revocation');
    return transaction(() => replay(ctx, `mandate.revoke:${id}`, input.idempotencyKey, input, () => {
      const prior = mandateRow(id, ctx, true);
      assertRevision(prior, input);
      if (prior.state === 'revoked') return mandateView(prior);
      const at = now();
      const state = input.action === 'pause' ? 'paused' : 'revoked';
      const row = { ...prior, version: prior.version + 1, revocation_epoch: prior.revocation_epoch + 1, state, next_run_at: null };
      // A lost independent receipt must not prevent a local stop. Restoration still requires the full remote watermark.
      try {
        commitMandateRevision(ctx, row, input, `mandate.${state}`, at);
      } catch (error) {
        if (mode !== 'real' || error.status !== 503) throw error;
        insertMandate(row);
        run("UPDATE permits SET state = 'revoked' WHERE state = 'issued' AND task_id IN (SELECT id FROM tasks WHERE mandate_id = ?)", row.id);
        run('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)',
          `pending_revoke:${ctx.scope}:${row.id}:${row.version}`, json({ scope: ctx.scope, row, requestHash: hash(input) }));
        pushEvent(ctx, `mandate.${state}`, { revision: row.version, revocationEpoch: row.revocation_epoch, journalPending: true }, null, row.id, at);
      }
      const affected = all("SELECT * FROM tasks WHERE mandate_id = ? AND state IN ('queued', 'running', 'waiting_input', 'needs_reconcile')", row.id);
      for (const task of affected) {
        cancelLeases(task, ctx, at, state === 'revoked' ? 'cancelled' : 'paused');
      }
      if (state === 'revoked') {
        effects.releaseGeoMandate(row.id, at);
        run("UPDATE observations SET state = 'cancelled' WHERE state = 'scheduled' AND task_id IN (SELECT id FROM tasks WHERE mandate_id = ?)", row.id);
      }
      return { ...mandateView(mandateRow(id, ctx)),
        inFlight: all("SELECT operation_key FROM effects WHERE mandate_id = ? AND state IN ('in_flight', 'unknown', 'accepted')", id).map(item => item.operation_key) };
    }));
  }

  function listMandates(auth) {
    const ctx = identity(auth, READ_ROLES);
    return all('SELECT * FROM mandates WHERE scope = ? ORDER BY created_at, id', ctx.scope).map(mandateView);
  }

  function getMandate(id, auth) {
    return mandateView(mandateRow(id, identity(auth, READ_ROLES)));
  }

  function syncPendingRevocations(ctx) {
    const rows = all("SELECT * FROM metadata WHERE key LIKE 'pending_revoke:%'").map(item => ({ ...item, payload: parse(item.value) }));
    for (const { key: storageKey, payload } of rows) {
      if (payload.scope !== ctx.scope) continue;
      durable(ctx, `mandate:${payload.row.id}:${payload.row.version}`, 'mandate',
        { row: payload.row, requestHash: payload.requestHash });
      run('DELETE FROM metadata WHERE key = ?', storageKey);
    }
    const pendingControls = all("SELECT * FROM metadata WHERE key LIKE 'pending_control:%'").map(item => ({ ...item, payload: parse(item.value) }));
    for (const { key: storageKey, payload } of pendingControls) {
      if (payload.scope !== ctx.scope) continue;
      const entry = durable(ctx, payload.key, 'task_control', payload.data, payload.at);
      rememberReplayEntry(entry);
      run('DELETE FROM metadata WHERE key = ?', storageKey);
    }
  }

  function assertNoPendingRevocation(ctx) {
    const pending = all("SELECT value FROM metadata WHERE key LIKE 'pending_revoke:%' OR key LIKE 'pending_control:%'");
    if (pending.some(entry => parse(entry.value).scope === ctx.scope)) {
      fail(503, 'REVOCATION_NOT_REPLICATED', 'Sync the independent revocation watermark before new outward writes.');
    }
  }

  function rememberReplayEntry(entry) {
    if (entry?.digest) run('INSERT OR IGNORE INTO recovered_journal(scope, key, digest) VALUES (?, ?, ?)', entry.scope, entry.key, entry.digest);
  }

  function addStep(task, input, at = now(), ownerContinuation = false) {
    const kind = identifier(input.kind, 'kind');
    if (!STEP_ROLES[kind]) fail(422, 'UNKNOWN_WORK_KIND', 'The worker kind is not registered.', { kind });
    const stepKey = identifier(input.key ?? kind, 'stepKey');
    if (stepKey === DRAFT_CONTINUATION_KEY && !ownerContinuation) fail(409, 'OWNER_DRAFT_CONTINUATION_REQUIRED', 'The owner must authorize continuation of a truncated draft.');
    const payload = json(object(input.input ?? {}, 'step input'));
    const dueAt = input.dueAt === undefined ? at : instant(input.dueAt, 'dueAt');
    const prior = get('SELECT * FROM steps WHERE task_id = ? AND step_key = ?', task.id, stepKey);
    if (prior) {
      if (prior.kind !== kind || prior.input !== payload) fail(409, 'STEP_CONFLICT', 'This task step key is already bound to other work.');
      return prior;
    }
    const id = input.restoreId ?? newId('step');
    run('INSERT INTO steps(id, scope, task_id, step_key, kind, state, due_at, input) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, task.scope, task.id, stepKey, kind, 'queued', dueAt, payload);
    return get('SELECT * FROM steps WHERE id = ?', id);
  }

  function insertTask(row, step) {
    run(`INSERT OR IGNORE INTO tasks(id, scope, mandate_id, trigger_key, title, state, version, priority, created_at,
      deadline_at, mandate_version, input, commitments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.scope, row.mandate_id, row.trigger_key, row.title, row.state, row.version, row.priority, row.created_at,
    row.deadline_at, row.mandate_version, row.input, row.commitments);
    for (const plan of basePlan(catalog, parse(row.commitments))) {
      run('INSERT OR IGNORE INTO channel_plans(task_id, channel_id, version, data) VALUES (?, ?, 1, ?)', row.id, plan.channelId, json(plan));
    }
    addStep(row, step, row.created_at);
  }

  function acceptTask(input, mandate, triggerKey, ctx, at = now()) {
    const prior = get('SELECT * FROM tasks WHERE mandate_id = ? AND trigger_key = ?', mandate.id, triggerKey);
    if (prior) return prior;
    assertActive(mandate, at);
    const id = `task-${hash([ctx.scope, mandate.id, triggerKey]).slice(0, 42)}`;
    const journalKey = `task:${id}`;
    const recovered = readJournal(ctx, journalKey);
    if (recovered) {
      if (recovered.kind !== 'task' || recovered.data.requestHash !== hash(input)) {
        fail(409, 'JOURNAL_CONFLICT', 'This task key was already bound to another accepted request.');
      }
      insertTask(recovered.data.row, recovered.data.step);
      pushEvent(ctx, 'task.recovered_acceptance', { triggerKey }, recovered.data.row, mandate.id, at);
      return taskRow(id, ctx);
    }
    const config = parse(mandate.config);
    const latestPossible = mandate.expires_at;
    const requested = input.deadlineAt === undefined || input.deadlineAt === null ? null : instant(input.deadlineAt, 'deadlineAt');
    const windowEnd = config.resultWindowMs ? at + config.resultWindowMs : Infinity;
    const cutoff = Math.min(requested ?? Infinity, latestPossible ?? Infinity, windowEnd);
    const deadlineAt = Number.isFinite(cutoff) ? cutoff : null;
    if (deadlineAt !== null && at >= deadlineAt) fail(422, 'DEADLINE_EXPIRED', 'The task deadline is already due.');
    const payload = { ...object(input.input ?? input.payload ?? {}, 'task payload') };
    if (input.sourceRef !== undefined) payload.sourceRef = string(input.sourceRef, 'sourceRef', 500);
    if (payload.adminOnly === true && (input.kind !== 'review' || ctx.role !== 'owner' || config.trustScope.adminReviews !== true)) {
      fail(403, 'ADMIN_REVIEW_NOT_AUTHORIZED', 'Administrative review needs a dedicated owner mandate and the independent review work kind.');
    }
    const commitments = payload.adminOnly === true ? [] : config.requiredOutcomes;
    const row = { id, scope: ctx.scope, mandate_id: mandate.id, trigger_key: triggerKey,
      title: string(input.title ?? config.objective, 'title', 1600), state: 'queued', version: 1,
      priority: integer(input.priority ?? 0, 'priority', 0, 100), created_at: at, deadline_at: deadlineAt,
      mandate_version: mandate.version, input: json(payload), commitments: json(commitments) };
    const step = { key: 'initial', kind: input.kind ?? 'discover', input: payload, dueAt: at,
      restoreId: `step-${hash([id, 'initial']).slice(0, 42)}` };
    durable(ctx, journalKey, 'task', { row, step, requestHash: hash(input) }, at);
    insertTask(row, step);
    pushEvent(ctx, 'task.accepted', { triggerKey, mandateRevision: mandate.version, requiredOutcomes: commitments }, row, mandate.id, at);
    return row;
  }

  function createTask(input, auth) {
    const ctx = identity(auth, TASK_WRITERS);
    assertOperational();
    object(input, 'task');
    return transaction(() => {
      assertNoPendingRevocation(ctx);
      const mandate = mandateRow(input.mandateId, ctx, true);
      return replay(ctx, `task.create:${mandate.id}`, input.idempotencyKey, input, () => {
        const triggerKey = `manual:${hash([ctx.actorId, input.idempotencyKey])}`;
        return taskView(acceptTask(input, mandate, triggerKey, ctx), true);
      });
    });
  }

  function ingestEvent(input, auth) {
    const ctx = identity(auth, ['owner', 'system', 'worker']);
    assertOperational();
    object(input, 'source event');
    return transaction(() => {
      assertNoPendingRevocation(ctx);
      const at = now();
      const sourceId = identifier(input.sourceId, 'sourceId');
      const eventKey = identifier(input.eventKey, 'eventKey');
      const factKey = string(input.factKey ?? `${sourceId}:${eventKey}`, 'factKey', 400);
      const occurredAt = input.occurredAt === undefined ? null : instant(input.occurredAt, 'occurredAt');
      if (occurredAt !== null && occurredAt > at + 60_000) fail(422, 'INVALID_SOURCE_TIME', 'Source event time is in the future.');
      const data = { sourceId, eventKey, factKey, occurredAt, payloadRef: string(input.payloadRef ?? input.sourceRef, 'payloadRef', 500),
        cursor: string(input.cursor, 'cursor', 500, true) };
      const digest = hash(data);
      const old = get('SELECT * FROM source_events WHERE scope = ? AND source_id = ? AND event_key = ?', ctx.scope, sourceId, eventKey);
      if (old) {
        if (old.digest !== digest) fail(409, 'SOURCE_EVENT_CONFLICT', 'The same event keys identify a different source event.');
        return { sourceId, eventKey, duplicate: true, tasks: all('SELECT * FROM tasks WHERE scope = ? AND trigger_key = ?', ctx.scope, `source:${hash(factKey)}`).map(task => taskView(task)) };
      }
      const mandates = input.mandateId ? [mandateRow(input.mandateId, ctx, ctx.role === 'owner')] : all(
        "SELECT * FROM mandates WHERE scope = ? AND state = 'active'", ctx.scope);
      const accepted = mandates.filter(row => row.state === 'active' && (row.expires_at === null || row.expires_at > at) &&
        parse(row.config).trustScope.sources.includes(sourceId));
      if (accepted.length === 0) fail(403, 'SOURCE_NOT_AUTHORIZED', 'No current mandate grants access to this source.');
      run('INSERT INTO source_events(scope, source_id, event_key, digest, occurred_at, received_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ctx.scope, sourceId, eventKey, digest, occurredAt ?? at, at, json(data));
      if (data.cursor !== null) {
        run(`INSERT INTO source_cursors(scope, source_id, occurred_at, cursor) VALUES (?, ?, ?, ?)
          ON CONFLICT(scope, source_id) DO UPDATE SET occurred_at = excluded.occurred_at, cursor = excluded.cursor
          WHERE excluded.occurred_at >= source_cursors.occurred_at`, ctx.scope, sourceId, occurredAt ?? at, data.cursor);
      }
      const taskInput = { title: input.title ?? `Source signal ${sourceId}`, input: data, priority: input.priority ?? 0 };
      const tasks = accepted.map(row => taskView(acceptTask(taskInput, row, `source:${hash(factKey)}`, ctx, at)));
      return { sourceId, eventKey, duplicate: false, tasks };
    });
  }

  function listTasks(authOrQuery, maybeAuth) {
    const query = maybeAuth ? object(authOrQuery, 'task query') : {};
    const ctx = identity(maybeAuth ?? authOrQuery, READ_ROLES);
    const rows = query.mandateId === undefined
      ? all('SELECT * FROM tasks WHERE scope = ? ORDER BY created_at DESC, id', ctx.scope)
      : all('SELECT * FROM tasks WHERE scope = ? AND mandate_id = ? ORDER BY created_at DESC, id', ctx.scope, identifier(query.mandateId, 'mandateId'));
    return rows.map(row => taskView(row));
  }

  function getTask(id, auth) {
    return taskView(taskRow(id, identity(auth, READ_ROLES)), true);
  }

  function listEvents(id, input, auth) {
    const ctx = identity(auth, READ_ROLES);
    taskRow(id, ctx);
    const after = integer(input?.after ?? 0, 'after');
    const limit = integer(input?.limit ?? 100, 'limit', 1, 250);
    return all('SELECT * FROM events WHERE scope = ? AND task_id = ? AND seq > ? ORDER BY seq LIMIT ?', ctx.scope, id, after, limit)
      .map(row => ({ seq: row.seq, id: row.seq, taskId: row.task_id, mandateId: row.mandate_id, actorId: row.actor, at: row.at,
        type: row.type, data: parse(row.data), dataMode: mode }));
  }

  function listProjectEvents(auth) {
    const ctx = identity(auth, READ_ROLES);
    return all('SELECT * FROM events WHERE scope = ? ORDER BY seq DESC LIMIT 100', ctx.scope)
      .map(row => ({ seq: row.seq, id: row.seq, taskId: row.task_id, mandateId: row.mandate_id, actorId: row.actor, at: row.at,
        type: row.type, data: parse(row.data), dataMode: mode }));
  }

  function setTaskState(task, state) {
    run('UPDATE tasks SET state = ?, version = version + 1 WHERE id = ?', state, task.id);
  }

  function requiredResult(task, item) {
    if (item.outcome === 'observation') {
      return Boolean(get(`SELECT o.id FROM observations o JOIN effects e ON e.operation_key = o.operation_key
        WHERE o.task_id = ? AND o.state = 'verified' AND (? IS NULL OR e.channel_id = ?)
        AND (? IS NULL OR o.epoch_day = ?) LIMIT 1`, task.id, item.channelId ?? null, item.channelId ?? null, item.day ?? null, item.day ?? null));
    }
    if (item.outcome === 'result') {
      return Boolean(get("SELECT id FROM steps WHERE task_id = ? AND state = 'succeeded' AND output IS NOT NULL LIMIT 1", task.id));
    }
    if (item.outcome === 'prepared') {
      return planView(task.id).some(row => (!item.channelId || row.channelId === item.channelId) && row.packageHash && row.reviewState === 'passed');
    }
    const effects = all("SELECT * FROM effects WHERE task_id = ? AND state = 'verified'", task.id);
    return effects.some(effect => (!item.channelId || effect.channel_id === item.channelId) &&
      (item.outcome === 'public' ? parse(effect.settlement).visibility === 'public' : parse(effect.settlement).visibility !== 'public'));
  }

  function awaitingRequiredHandoff(task, unmet) {
    const channels = new Set(unmet.filter(item => ['public', 'restricted', 'observation'].includes(item.outcome)).map(item => item.channelId));
    return channels.size > 0 && planView(task.id).some(channel => channels.has(channel.channelId) &&
      channel.packageHash && channel.reviewState === 'passed' && !channel.ownerSubmissionId &&
      ['manual', 'owner_confirmation', 'handoff'].includes(channel.plannedDisposition ?? channel.disposition));
  }

  function projectTask(task, ctx) {
    if (!USABLE_TASK_STATES.includes(task.state)) return task;
    const states = all(`SELECT s.state FROM steps s WHERE s.task_id = ? AND NOT EXISTS (
      SELECT 1 FROM draft_continuations c JOIN steps successor ON successor.id = c.step_id
      WHERE c.task_id = s.task_id AND c.source_step_id = s.id AND s.state = 'failed' AND successor.state = 'succeeded'
    )`, task.id).map(item => item.state);
    const uncertain = Boolean(get("SELECT operation_key FROM effects WHERE task_id = ? AND state IN ('in_flight', 'unknown', 'accepted')", task.id)) ||
      Boolean(get("SELECT id FROM costs WHERE task_id = ? AND state = 'unknown'", task.id));
    let state;
    if (uncertain || states.includes('needs_reconcile')) state = 'needs_reconcile';
    else if (states.includes('leased')) state = 'running';
    else if (states.includes('queued')) state = 'queued';
    else if (states.includes('waiting_input')) state = 'waiting_input';
    else {
      const unmet = parse(task.commitments).filter(item => !requiredResult(task, item));
      if (unmet.length) state = awaitingRequiredHandoff(task, unmet) ? 'waiting_input' : 'partial';
      else if (states.includes('failed')) state = states.includes('succeeded') ? 'partial' : 'failed';
      else state = 'succeeded';
    }
    if (task.state !== state) {
      setTaskState(task, state);
      pushEvent(ctx, 'task.state', { from: task.state, to: state }, task);
    }
    return taskRow(task.id, ctx);
  }

  function assertLease(step, epoch, ctx, at = now()) {
    if (!STEP_ROLES[step.kind].includes(ctx.role) || step.state !== 'leased' || step.holder !== ctx.actorId ||
      step.epoch !== epoch || step.lease_until <= at) {
      fail(409, 'STALE_LEASE', 'This lease is expired or does not belong to the current worker epoch.', { epoch: step.epoch, state: step.state });
    }
    return step;
  }

  function requireLiveTask(task, ctx, kind, at = now()) {
    const mandate = mandateRow(task.mandate_id, ctx);
    if (LIVE_RECONCILE.includes(kind)) return mandate;
    assertOperational();
    assertActive(mandate, at);
    if (kind === 'observe' && !['cancelled', 'paused'].includes(task.state)) return mandate;
    if (!USABLE_TASK_STATES.includes(task.state) || task.deadline_at !== null && task.deadline_at <= at) {
      fail(409, 'TASK_NOT_EXECUTABLE', 'Task is stopped or past its deadline.');
    }
    return mandate;
  }

  function cancelLeases(task, ctx, at, next) {
    const keepObservations = next === 'expired';
    const leasedSteps = all("SELECT * FROM steps WHERE task_id = ? AND state = 'leased' AND kind != 'reconcile' AND (? = 0 OR kind != 'observe')",
      task.id, Number(keepObservations));
    for (const step of leasedSteps) markUncertain(step, task, ctx, at, 'stopped');
    const blockedState = next === 'paused' ? 'paused' : 'cancelled';
    run(`UPDATE steps SET state = ?, lease_until = NULL, holder = NULL
      WHERE task_id = ? AND kind != 'reconcile' AND (? = 0 OR kind != 'observe') AND state IN ('queued', 'leased', 'waiting_input', 'paused')`,
    blockedState, task.id, Number(keepObservations));
    run("UPDATE permits SET state = 'revoked' WHERE task_id = ? AND state = 'issued'", task.id);
    if (next === 'cancelled') {
      effects.releaseGeoTask(task.id, at);
      run("UPDATE observations SET state = 'cancelled' WHERE task_id = ? AND state = 'scheduled'", task.id);
    }
    setTaskState(task, next);
    pushEvent(ctx, `task.${next}`, { from: task.state }, task, task.mandate_id, at);
  }

  function markUncertain(step, task, ctx, at, cause, pendingCosts = []) {
    const costs = all("SELECT id FROM costs WHERE step_id = ? AND state IN ('dispatched', 'unknown')", step.id)
      .filter(cost => !pendingCosts.includes(cost.id));
    const effects = all("SELECT * FROM effects WHERE task_id = ? AND state IN ('in_flight', 'unknown', 'accepted')", task.id)
      .filter(effect => parse(effect.binding).stepId === step.id);
    run("UPDATE costs SET state = 'released' WHERE step_id = ? AND state = 'reserved'", step.id);
    for (const cost of costs) run("UPDATE costs SET state = 'unknown' WHERE id = ? AND state = 'dispatched'", cost.id);
    for (const effect of effects) {
      if (effect.state === 'in_flight') run("UPDATE effects SET state = 'unknown' WHERE operation_key = ?", effect.operation_key);
      addStep(task, { kind: 'reconcile', key: `reconcile:${effect.operation_key}:${effect.attempt}`, input: { operationKey: effect.operation_key } }, at);
    }
    if (costs.length || effects.length) {
      pushEvent(ctx, 'worker.uncertain', { stepId: step.id, epoch: step.epoch, reservations: costs.map(cost => cost.id),
        operations: effects.map(effect => effect.operation_key), cause }, task, task.mandate_id, at);
    }
    return Boolean(costs.length || effects.length);
  }

  function nativePendingCosts(input, step, ctx, status) {
    const ids = [...new Set(objects(input.pendingCostIds ?? [], 'pendingCostIds', 12).map(id => identifier(id, 'costId')))];
    if (ids.length && status !== 'retry') fail(422, 'PENDING_COST_RETRY_ONLY', 'A signed order can remain pending only during an explicit retry.');
    for (const id of ids) {
      const row = get("SELECT * FROM costs WHERE scope = ? AND id = ? AND step_id = ? AND state = 'dispatched'", ctx.scope, id, step.id);
      const data = row && parse(row.data);
      if (!data || data.provider !== 'native_signed_order' || data.reservedRole !== ctx.role && data.reservedBy !== ctx.actorId ||
        !/^[a-f0-9]{64}$/u.test(data.nativeOrderRef ?? '')) {
        fail(409, 'NATIVE_ORDER_BINDING_REQUIRED', 'Only this step’s previous exact signed order may remain pending.');
      }
    }
    return step.epoch >= 5 ? [] : ids;
  }

  function recoverLeases(ctx, at) {
    const expiredTasks = all(`SELECT t.* FROM tasks t WHERE t.scope = ? AND t.deadline_at IS NOT NULL AND t.deadline_at <= ?
      AND (t.state IN ('queued','running','waiting_input','needs_reconcile','paused') OR t.state = 'partial' AND EXISTS (
        SELECT 1 FROM channel_plans p WHERE p.task_id = t.id AND json_extract(p.data, '$.reviewState') = 'passed'
        AND json_extract(p.data, '$.ownerSubmissionId') IS NULL
        AND COALESCE(json_extract(p.data, '$.plannedDisposition'), json_extract(p.data, '$.disposition')) IN ('manual','owner_confirmation','handoff')))
      `, ctx.scope, at)
      .filter(task => task.state !== 'partial' || awaitingRequiredHandoff(task,
        parse(task.commitments).filter(item => !requiredResult(task, item))));
    for (const task of expiredTasks) cancelLeases(task, ctx, at, 'expired');
    const expired = all("SELECT * FROM steps WHERE scope = ? AND state = 'leased' AND lease_until <= ?", ctx.scope, at);
    for (const step of expired) {
      const task = taskRow(step.task_id, ctx);
      const uncertain = markUncertain(step, task, ctx, at, 'lease_expired');
      run('UPDATE steps SET state = ?, due_at = ?, holder = NULL, lease_until = NULL WHERE id = ?',
        uncertain && step.kind !== 'reconcile' ? 'needs_reconcile' : 'queued', at, step.id);
      pushEvent(ctx, 'worker.lease_expired', { stepId: step.id, epoch: step.epoch, uncertain }, task, task.mandate_id, at);
      projectTask(task, ctx);
    }
    return expired.length + expiredTasks.length;
  }

  function claim(input = {}, auth) {
    const ctx = identity(auth, WORK_ROLES);
    object(input, 'claim');
    const available = Object.keys(STEP_ROLES).filter(kind => STEP_ROLES[kind].includes(ctx.role));
    const kinds = [...new Set(objects(input.kinds ?? available, 'kinds', Object.keys(STEP_ROLES).length).map(kind => identifier(kind, 'kind')))];
    if (kinds.some(kind => !available.includes(kind))) fail(403, 'WORK_KIND_DENIED', 'The authenticated role does not hold these worker capabilities.');
    const usable = restoring ? kinds.filter(kind => LIVE_RECONCILE.includes(kind)) : kinds;
    const leaseMs = integer(input.leaseMs ?? 90_000, 'leaseMs', 100, 300_000);
    const taskId = input.taskId === null || input.taskId === undefined ? null : identifier(input.taskId, 'taskId');
    const adminOnly = input.adminOnly === true;
    if (adminOnly && (ctx.role !== 'reviewer' || !taskId)) fail(403, 'ADMIN_REVIEW_NOT_AUTHORIZED', 'Administrative review requires its exact dedicated task.');
    if (!usable.length) return null;
    return transaction(() => {
      const at = now();
      recoverLeases(ctx, at);
      const kindsSql = usable.map(() => '?').join(', ');
      const step = get(`SELECT s.* FROM steps s JOIN tasks t ON t.id = s.task_id JOIN mandates m ON t.mandate_id = m.id
        WHERE s.scope = ? AND s.kind IN (${kindsSql}) AND s.state = 'queued' AND s.due_at <= ?
        AND (? IS NULL OR t.id = ?)
        AND ((? = 1 AND json_extract(s.input, '$.adminOnly') = 1)
          OR (? = 0 AND json_extract(s.input, '$.adminOnly') IS NOT 1))
        AND (s.kind = 'reconcile' OR (m.state = 'active' AND (m.expires_at IS NULL OR m.expires_at > ?)
          AND (s.kind = 'observe' AND t.state NOT IN ('paused','cancelled')
            OR t.state IN ('queued','running','waiting_input','needs_reconcile','succeeded','partial')
              AND (t.deadline_at IS NULL OR t.deadline_at > ?))))
        ORDER BY CASE
          WHEN s.due_at <= ? THEN 0
          WHEN s.kind = 'reconcile' THEN 1
          WHEN s.kind = 'observe' AND EXISTS (
            SELECT 1 FROM geo_commitments g WHERE g.task_id = s.task_id AND g.state = 'reserved'
            AND g.operation_key = json_extract(s.input, '$.operationKey')
            AND g.epoch_day = json_extract(s.input, '$.day')
          ) THEN 2
          WHEN s.kind NOT IN ('observe', 'reconcile') AND t.deadline_at IS NOT NULL AND t.deadline_at <= ? THEN 3
          ELSE 4
        END,
        CASE WHEN s.due_at <= ? THEN s.due_at END,
        CASE WHEN s.due_at <= ? THEN s.rowid END,
        CASE WHEN json_array_length(t.commitments) > 0 THEN 0 ELSE 1 END,
        CASE WHEN t.deadline_at IS NULL OR s.kind = 'observe' THEN 1 ELSE 0 END,
        CASE WHEN s.kind <> 'observe' THEN t.deadline_at END,
        COALESCE((SELECT MAX(MIN(40, MAX(0, CAST(json_extract(d.output, '$.queue.verifiedClaims') AS INTEGER))))
          FROM steps d WHERE d.task_id = s.task_id AND d.kind IN ('discover','research') AND d.state = 'succeeded'), 0) DESC,
        COALESCE((SELECT MAX(MIN(100, MAX(0, CAST(json_extract(d.output, '$.queue.modelPriority') AS INTEGER))))
          FROM steps d WHERE d.task_id = s.task_id AND d.kind IN ('discover','research') AND d.state = 'succeeded'), 0) DESC,
        t.priority DESC, s.due_at, s.rowid LIMIT 1`, ctx.scope, ...usable, at, taskId, taskId,
      Number(adminOnly), Number(adminOnly), at, at, at - QUEUE_AGE_MS, at + QUEUE_DEADLINE_MS, at - QUEUE_AGE_MS, at - QUEUE_AGE_MS);
      if (!step) return null;
      const task = taskRow(step.task_id, ctx);
      const mandate = mandateRow(task.mandate_id, ctx);
      const stop = step.kind === 'reconcile' ? at + leaseMs
        : Math.min(at + leaseMs, step.kind === 'observe' ? Infinity : task.deadline_at ?? Infinity, mandate.expires_at ?? Infinity);
      run("UPDATE steps SET state = 'leased', epoch = epoch + 1, holder = ?, lease_until = ? WHERE id = ?", ctx.actorId, stop, step.id);
      pushEvent(ctx, 'worker.claimed', { stepId: step.id, kind: step.kind, epoch: step.epoch + 1, leaseUntil: stop }, task, task.mandate_id, at);
      projectTask(task, ctx);
      return stepView(rowStep(step.id, ctx), task);
    });
  }

  function heartbeat(input, auth) {
    const ctx = identity(auth, WORK_ROLES);
    object(input, 'heartbeat');
    return transaction(() => {
      const at = now();
      const step = assertLease(rowStep(input.id, ctx), input.epoch, ctx, at);
      const task = taskRow(step.task_id, ctx);
      const mandate = requireLiveTask(task, ctx, step.kind, at);
      const extension = at + integer(input.leaseMs ?? 90_000, 'leaseMs', 100, 300_000);
      const stop = step.kind === 'reconcile' ? extension
        : Math.min(extension, step.kind === 'observe' ? Infinity : task.deadline_at ?? Infinity, mandate.expires_at ?? Infinity);
      run('UPDATE steps SET lease_until = ? WHERE id = ?', stop, step.id);
      return stepView(rowStep(step.id, ctx), task);
    });
  }

  function checkpoint(input, auth) {
    const ctx = identity(auth, WORK_ROLES);
    object(input, 'checkpoint');
    return transaction(() => {
      const step = assertLease(rowStep(input.id, ctx), input.epoch, ctx);
      const task = taskRow(step.task_id, ctx);
      requireLiveTask(task, ctx, step.kind);
      const payload = json(object(input.output, 'checkpoint payload'));
      if (payload !== step.output) {
        run('UPDATE steps SET output = ? WHERE id = ?', payload, step.id);
        pushEvent(ctx, 'worker.checkpoint', { stepId: step.id, epoch: step.epoch, outputHash: hash(input.output) }, task);
      }
      return stepView(rowStep(step.id, ctx), task);
    });
  }

  function capable(row, at) {
    if (!row) return false;
    const data = parse(row.data);
    return data.active === true && data.official === true && data.confirmationRequired === false &&
      data.safeDedup === true && data.businessReadback === true && (data.expiresAt === null || data.expiresAt > at);
  }

  function lookupGrant(mandate, binding) {
    const targetKey = capabilityKey(binding);
    return parse(mandate.config).allowedActions.find(({ risk, maxDaily, ...target }) => capabilityKey(target) === targetKey);
  }

  function applyPlan(task, channelPlan, ctx, at) {
    const mandate = mandateRow(task.mandate_id, ctx);
    const signed = mandate.version === task.mandate_version ? parse(mandate.config).allowedSubstitutions ?? [] : [];
    const checked = row => {
      if (!row.accountId || !row.destination || !row.form) return {};
      const binding = capabilityBinding(row, catalog);
      return { binding, registered: get('SELECT * FROM capabilities WHERE scope = ? AND capability_key = ?', ctx.scope, capabilityKey(binding)) };
    };
    const candidates = normalizePlan(channelPlan, catalog, parse(task.commitments), mandate.next_run_at, row => {
      if (mandate.state !== 'active' || mandate.version !== task.mandate_version || mandate.expires_at !== null && mandate.expires_at <= at) return false;
      const { binding, registered } = checked(row);
      return Boolean(binding) && lookupGrant(mandate, binding)?.risk === 'low' && capable(registered, at);
    }, row => {
      const { registered } = checked(row);
      return registered && parse(registered.data).restored === true;
    }, signed);
    for (const candidate of candidates.filter(row => row.substitution)) {
      const original = candidates.find(row => row.channelId === candidate.substitution.originalChannelId);
      if (original?.machinePublish) fail(409, 'SUBSTITUTION_ORIGINAL_AVAILABLE', 'The original signed result still has a current automatic route.');
    }
    for (const candidate of candidates) {
      const row = get('SELECT * FROM channel_plans WHERE task_id = ? AND channel_id = ?', task.id, candidate.channelId);
      const prior = parse(row.data);
      const next = { ...prior, ...candidate, plannedDisposition: candidate.disposition };
      if (prior.packageHash && (next.form !== prior.form || next.accountId !== prior.accountId || next.destination !== prior.destination)) {
        fail(409, 'FROZEN_CHANNEL_BINDING', 'A channel with a frozen package requires a new revision of the task.');
      }
      const payload = json(next);
      if (payload === row.data) continue;
      run('UPDATE channel_plans SET version = version + 1, data = ? WHERE task_id = ? AND channel_id = ?', payload, task.id, candidate.channelId);
      if (candidate.substitution && !prior.substitution) {
        pushEvent(ctx, 'decision.substitution_selected', { channelId: candidate.channelId, ...candidate.substitution }, task, task.mandate_id, at);
      }
    }
    pushEvent(ctx, 'decision.channels', { count: catalog.size, assessmentHash: hash(candidates) }, task, task.mandate_id, at);
  }

  function report(input, auth) {
    const ctx = identity(auth, WORK_ROLES);
    object(input, 'worker report');
    const result = transaction(() => {
      const at = now();
      const step = rowStep(input.id, ctx);
      const task = taskRow(step.task_id, ctx);
      const digest = hash([ctx.actorId, input]);
      if (step.outcome_digest === digest && step.epoch === input.epoch) return stepView(step, task);
      if (!STEP_ROLES[step.kind].includes(ctx.role) || step.state !== 'leased' || step.holder !== ctx.actorId || step.epoch !== input.epoch || step.lease_until <= at) {
        pushEvent(ctx, 'worker.late_report', { stepId: step.id, submittedEpoch: integer(input.epoch, 'epoch'), currentEpoch: step.epoch, digest }, task);
        return { staleLease: true };
      }
      requireLiveTask(task, ctx, step.kind, at);
      const recognized = ['succeeded', 'retry', 'failed', 'waiting_input', 'needs_reconcile'];
      const status = input.status ?? 'succeeded';
      if (!recognized.includes(status)) fail(422, 'INVALID_STEP_STATUS', 'Worker result is outside the state machine.');
      const followups = objects(input.followups ?? [], 'followups', MAX_FOLLOWUPS);
      if (step.step_key === DRAFT_CONTINUATION_KEY) {
        const link = get('SELECT job_id FROM draft_continuations WHERE step_id = ?', step.id);
        const draft = input.output?.privateWork;
        if (!link || followups.length || (status === 'succeeded' && (input.output?.jobId !== link.job_id ||
            !/^[a-f0-9]{64}$/.test(input.output?.contentHash ?? '') || draft?.kind !== 'draft' ||
            draft.state !== 'prepared' || !draft.title?.trim() || !draft.body?.trim()))) {
          fail(409, 'DRAFT_CONTINUATION_RESULT_INVALID', 'A continued private draft must return the approved original native job and private article.');
        }
      }
      if (followups.length && status !== 'succeeded') fail(422, 'FOLLOWUPS_REQUIRE_SUCCESS', 'Continuation requires the current step to succeed.');
      if (input.channelPlan !== undefined) {
        if (step.kind !== 'discover' && step.kind !== 'research') fail(403, 'PLAN_WRITER_REQUIRED', 'Only discovery or research may update the plan.');
        applyPlan(task, input.channelPlan, ctx, at);
      }
      if (input.decision !== undefined) {
        const decision = object(input.decision, 'decision');
        pushEvent(ctx, 'decision.recorded', { stepId: step.id, inputHash: hash(parse(step.input)), decision }, task, task.mandate_id, at);
      }
      const pendingCosts = nativePendingCosts(input, step, ctx, status);
      const uncertain = markUncertain(step, task, ctx, at, `report:${status}`, pendingCosts);
      for (const next of uncertain ? [] : followups) {
        object(next, 'followup');
        if (!FOLLOWUPS[step.kind].includes(next.kind)) fail(422, 'INVALID_STEP_TRANSITION', 'This followup cannot be dispatched from the current work kind.');
        if (next.kind === 'prepare' && step.kind === 'review') {
          const attempts = get("SELECT count(*) AS count FROM steps WHERE task_id = ? AND kind = 'prepare' AND json_extract(input, '$.channelId') IS ?",
            task.id, next.input?.channelId ?? null).count;
          if (attempts >= 3) fail(409, 'REPAIR_LIMIT', 'Scoped candidate repair is capped at two followup attempts.');
        }
        if (next.kind === 'publish' && step.kind === 'reconcile') {
          const operationKey = parse(step.input).operationKey;
          const effect = get('SELECT state FROM effects WHERE scope = ? AND operation_key = ?', ctx.scope, operationKey ?? '');
          if (effect?.state !== 'not_executed') fail(409, 'RECONCILIATION_REQUIRED', 'A reconciled operation may only retry after proven non-execution.');
        }
        addStep(task, next, at);
      }
      let state = status;
      let due = step.due_at;
      if (status === 'retry') {
        const awaitsOriginal = step.kind === 'reconcile' || ['AI_APPROVAL_PENDING', 'NATIVE_ARTICLE_RUNNING',
          'SIGNED_ILLUSTRATIONS_REQUIRED', 'CONTENT_JOB_BUSY', 'AI_APPROVAL_PROVIDER_RATE_LIMIT'].includes(input.output?.code);
        state = step.epoch >= 5 && !awaitsOriginal ? 'failed' : 'queued';
        due = input.retryAt === undefined ? at + 10_000 : instant(input.retryAt, 'retryAt');
        if (due < at) fail(422, 'INVALID_RETRY_TIME', 'Retry time cannot be in the past.');
        if (awaitsOriginal && step.epoch > 2) due = Math.max(due, at + Math.min(3600000, 30000 * 2 ** Math.min(step.epoch - 2, 8)));
      }
      if (uncertain && step.kind !== 'reconcile') state = 'needs_reconcile';
      const payload = input.output === undefined || input.output === null ? step.output : json(object(input.output, 'step output'));
      run('UPDATE steps SET state = ?, due_at = ?, lease_until = NULL, output = ?, outcome_digest = ? WHERE id = ?',
        state, due, payload, digest, step.id);
      pushEvent(ctx, 'worker.reported', { stepId: step.id, kind: step.kind, epoch: step.epoch, state, outputDigest: payload === null ? null : hash(parse(payload)) },
        task, task.mandate_id, at);
      projectTask(task, ctx);
      return stepView(rowStep(step.id, ctx), task);
    });
    if (result.staleLease) fail(409, 'STALE_LEASE', 'The late report was recorded for audit without advancing the task.');
    return result;
  }

  function draftContinuationSource(task, mandate, reportReceiptError = false) {
    if (typeof readProviderReceipt !== 'function' || restoring || task.state !== 'partial' ||
        mandate.state !== 'active' || mandate.version !== task.mandate_version ||
        (mandate.expires_at !== null && mandate.expires_at <= now()) || (task.deadline_at !== null && task.deadline_at <= now()) ||
        parse(mandate.config).workMode !== 'draft_only' || parse(task.commitments).length ||
        get('SELECT task_id FROM draft_continuations WHERE task_id = ?', task.id)) return null;
    const steps = all('SELECT * FROM steps WHERE task_id = ? ORDER BY rowid', task.id);
    const failed = steps.find(s => s.kind === 'prepare' && s.step_key === 'private-draft' && s.state === 'failed');
    if (steps.length !== 2 || !steps.some(s => s.kind === 'discover' && s.state === 'succeeded') || !failed ||
        get('SELECT operation_key FROM effects WHERE task_id = ? LIMIT 1', task.id)) return null;
    const output = parse(failed.output ?? '{}');
    const input = parse(failed.input);
    if (output.code !== 'MODEL_OUTPUT_TRUNCATED' || !/^CDJ-[0-9a-f]{20}$/.test(output.jobId ?? '') ||
        !Array.isArray(input.channelIds) || input.channelIds.length || !input.opportunity?.facts?.length) return null;
    const target = readTruncatedRevision?.(output.jobId);
    if (!target) return null;
    if (get(`SELECT id FROM costs WHERE task_id = ? AND (state NOT IN ('settled','released') OR
        (state = 'released' AND json_extract(data, '$.dispatchedAt') IS NOT NULL)) LIMIT 1`, task.id)) return null;
    const budget = effects.budgetView(mandate, now());
    if (budget.reservedMinor || budget.unknownMinor || budget.availableMinor <= 0 || budget.currencyConflict) return null;
    const cost = get("SELECT * FROM costs WHERE step_id = ? AND state = 'settled' ORDER BY rowid DESC LIMIT 1", failed.id);
    if (!cost || cost.task_id !== task.id) return null;
    try {
      if (!isSettledTruncatedResponse(cost, readProviderReceipt(cost.id))) return null;
    } catch (error) {
      if (reportReceiptError) fail(409, 'DRAFT_CONTINUATION_RECEIPT_UNAVAILABLE', 'The original provider evidence could not be verified.');
      return null;
    }
    const quotaFingerprint = providerQuotaFingerprint?.(task.id) ?? null;
    if (parse(cost.data).providerTokenHold && !quotaFingerprint) return null;
    return { failed, cost, jobId: output.jobId, quotaFingerprint, target };
  }

  function applyDraftContinuation(task, link, ctx, at) {
    if (get('SELECT step_id FROM draft_continuations WHERE task_id = ?', task.id)) return;
    const prior = get("SELECT * FROM steps WHERE id = ? AND task_id = ? AND kind = 'prepare' AND state = 'failed'", link.sourceStepId, task.id);
    const cost = get("SELECT id FROM costs WHERE id = ? AND step_id = ? AND state = 'settled'", link.costId, link.sourceStepId);
    if (!prior || !cost || parse(prior.output ?? '{}').jobId !== link.jobId || parse(prior.output ?? '{}').code !== 'MODEL_OUTPUT_TRUNCATED') {
      fail(409, 'DRAFT_CONTINUATION_HISTORY_REQUIRED', 'Restore the original failed step and its settled provider evidence first.');
    }
    const child = addStep(task, { kind: 'prepare', key: DRAFT_CONTINUATION_KEY, restoreId: link.stepId, input: parse(prior.input) }, at, true);
    run('INSERT INTO draft_continuations(task_id,source_step_id,step_id,job_id,cost_id,source_sha256,scope_step_id,quota_fingerprint) VALUES (?,?,?,?,?,?,?,?)',
      task.id, prior.id, child.id, link.jobId, link.costId, link.sourceSha256, link.scopeStepId, link.quotaFingerprint);
    pushEvent(ctx, 'task.truncated_draft_continued', link, task, task.mandate_id, at);
    projectTask(task, ctx);
  }

  function controlTask(id, input, auth) {
    const ctx = identity(auth, ['owner']);
    object(input, 'task control');
    return transaction(() => replay(ctx, `task.control:${id}`, input.idempotencyKey, input, () => {
      const task = taskRow(id, ctx);
      const mandate = mandateRow(task.mandate_id, ctx, true);
      assertRevision(task, input);
      const at = now();
      let action, continuation;
      if (input.action === DRAFT_CONTINUATION_ACTION) {
        assertOperational();
        assertActive(mandate);
        assertNoPendingRevocation(ctx);
        const source = draftContinuationSource(task, mandate, true);
        if (!source) {
          fail(409, 'DRAFT_CONTINUATION_UNAVAILABLE', 'A settled truncated private revision of the original job is required.');
        }
        continuation = { sourceStepId: source.failed.id, jobId: source.jobId, costId: source.cost.id, ...source.target,
          stepId: 'step-' + hash([ctx.scope, task.id, DRAFT_CONTINUATION_KEY]).slice(0, 42), quotaFingerprint: source.quotaFingerprint };
        action = input.action;
      } else if (input.action === 'resume') {
        assertOperational();
        assertActive(mandate);
        if (!['paused', 'waiting_input'].includes(task.state)) fail(409, 'INVALID_TASK_TRANSITION', 'Only paused work or a step awaiting material may resume.');
        if (task.deadline_at !== null && task.deadline_at <= at) fail(409, 'DEADLINE_EXPIRED', 'Task is already past its deadline.');
        if (task.state === 'waiting_input' && !taskView(task).canResume) {
          fail(409, 'OWNER_HANDOFF_REQUIRED', 'Complete the exact owner handoff before advancing this task.');
        }
        assertNoPendingRevocation(ctx);
        action = 'resume';
      } else if (input.action === 'pause' || input.action === 'cancel') {
        if (CHANNEL_RESULT.includes(task.state) && task.state !== 'partial') fail(409, 'INVALID_TASK_TRANSITION', 'This task cannot accept this control.');
        action = input.action;
      } else {
        fail(422, 'INVALID_TASK_CONTROL', 'Use pause, resume, or cancel.');
      }
      const journalKey = `task-control:${hash([ctx.scope, task.id, input.idempotencyKey])}`;
      const data = { taskId: task.id, action, ...(continuation ? { continuation } : {}), controlVersion: task.version + 1, authorizedBy: ctx.actorId, requestHash: hash(input) };
      try {
        const entry = durable(ctx, journalKey, 'task_control', data, at);
        rememberReplayEntry(entry);
      } catch (error) {
        if (mode !== 'real' || error.status !== 503 || action === 'resume' || continuation) throw error;
        run('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)', `pending_control:${journalKey}`,
          json({ scope: ctx.scope, key: journalKey, data, at }));
      }
      applyTaskControl(task, action, ctx, at, continuation);
      return taskView(taskRow(id, ctx), true);
    }));
  }

  function applyTaskControl(task, action, ctx, at, continuation) {
    if (action === DRAFT_CONTINUATION_ACTION) return applyDraftContinuation(task, continuation, ctx, at);
    if (action !== 'resume') {
      cancelLeases(task, ctx, at, action === 'pause' ? 'paused' : 'cancelled');
      return;
    }
    run("UPDATE steps SET state = 'queued', due_at = ? WHERE task_id = ? AND state IN ('paused', 'waiting_input')", at, task.id);
    setTaskState(task, 'queued');
    pushEvent(ctx, 'task.resumed', {}, task);
    projectTask(taskRow(task.id, ctx), ctx);
  }

  function raiseException(input, auth) {
    const ctx = identity(auth, TASK_WRITERS.concat(WORK_ROLES));
    object(input, 'exception');
    const mandate = mandateRow(input.mandateId, ctx, ctx.role === 'owner');
    const task = input.taskId === undefined || input.taskId === null ? null : taskRow(input.taskId, ctx);
    if (task && task.mandate_id !== mandate.id) fail(403, 'WORK_BINDING_DENIED', 'The exception references a different mandate.');
    const at = now();
    const rootCause = identifier(input.rootCause, 'rootCause');
    const severity = input.severity ?? 'normal';
    if (!['normal', 'urgent'].includes(severity)) fail(422, 'INVALID_SEVERITY', 'Severity must be normal or urgent.');
    const actionable = input.actionable === true;
    const necessary = input.necessary === true;
    const result = { rootCause, severity, actionable, necessary,
      summary: string(input.summary, 'summary', 1000),
      nextCheck: input.nextCheck === undefined || input.nextCheck === null ? null : instant(input.nextCheck, 'nextCheck'),
      options: objects(input.options ?? [], 'exception options', 10), taskIds: task ? [task.id] : [],
      dataMode: mode };
    pushEvent(ctx, 'exception.recorded', result, task, mandate.id, at);
    if (severity !== 'urgent' && (!necessary || !actionable)) return { ...result, notificationId: null };
    const interval = severity === 'urgent' ? DAY : 7 * DAY;
    return enqueueNotification(mandate, ctx, rootCause, Math.floor(at / interval), result, at);
  }

  function enqueueNotification(mandate, ctx, cause, window, payload, at = now()) {
    const group = hash([mandate.owner_id, cause, mandate.id, mandate.version, window]);
    const prior = get('SELECT * FROM notifications WHERE scope = ? AND group_key = ?', ctx.scope, group);
    if (prior) {
      const old = parse(prior.data);
      const taskIds = [...new Set([...(old.taskIds ?? []), ...(payload.taskIds ?? [])])];
      run('UPDATE notifications SET data = ? WHERE id = ?', json({ ...old, taskIds }), prior.id);
      return notificationView(get('SELECT * FROM notifications WHERE id = ?', prior.id));
    }
    const id = newId('notification');
    const data = { ...payload, ownerId: mandate.owner_id, rootCause: cause, grantRevision: mandate.version };
    run('INSERT INTO notifications(id, scope, mandate_id, group_key, state, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, ctx.scope, mandate.id, group, 'pending', at, json(data));
    return notificationView(get('SELECT * FROM notifications WHERE id = ?', id));
  }

  function weeklyNoticeSummary(due, missed, autonomous) {
    return `本期有 ${due} 项承诺到期，按时自主交付 ${autonomous} 项，到期未达 ${missed} 项。`;
  }

  function notificationView(row) {
    const data = parse(row.data);
    if (data.kind === 'weekly_report' && data.rootCause === 'weekly-report' && data.reportId) {
      const legacy = /^(\d+) items due, (\d+) missed, (\d+) delivered autonomously on time\.$/.exec(data.summary);
      if (legacy) data.summary = weeklyNoticeSummary(legacy[1], legacy[2], legacy[3]);
    }
    return { ...data, id: row.id, notificationId: row.id, mandateId: row.mandate_id, state: row.state,
      createdAt: row.created_at, dataMode: mode };
  }

  function recordException(input, auth) {
    return transaction(() => raiseException(input, auth));
  }

  function listNotifications(auth) {
    const ctx = identity(auth, ['owner', 'system', 'reader']);
    const rows = all('SELECT * FROM notifications WHERE scope = ? ORDER BY created_at DESC, id', ctx.scope).map(notificationView);
    return ctx.role === 'owner' ? rows.filter(row => row.ownerId === ctx.actorId) : rows;
  }

  function ackNotification(idOrInput, inputOrAuth, maybeAuth) {
    const input = maybeAuth ? { ...inputOrAuth, id: idOrInput } : idOrInput;
    const ctx = identity(maybeAuth ?? inputOrAuth, ['system', 'owner']);
    object(input, 'notification acknowledgment');
    return transaction(() => {
      const id = identifier(input.notificationId ?? input.id, 'notificationId');
      const row = get('SELECT * FROM notifications WHERE scope = ? AND id = ?', ctx.scope, id);
      if (!row) fail(404, 'NOTIFICATION_NOT_FOUND', 'This notification does not exist in the project.');
      const view = notificationView(row);
      if (ctx.role === 'owner' && ctx.actorId !== view.ownerId) fail(403, 'OWNER_REQUIRED', 'Only this owner may acknowledge the notification.');
      const status = input.status ?? (ctx.role === 'owner' ? 'read' : 'delivered');
      if (ctx.role === 'owner' && status !== 'read' || ctx.role === 'system' && !['delivered', 'failed'].includes(status)) {
        fail(403, 'INVALID_NOTIFICATION_TRANSITION', 'Platform delivery and owner read are separate receipts.');
      }
      if (status === 'delivered' && row.state === 'read' || row.state === status) return view;
      if (row.state === 'read' || row.state === 'delivered' && status === 'failed') {
        fail(409, 'NOTIFICATION_ALREADY_DELIVERED', 'A delivery receipt cannot be overwritten by a later failed send.');
      }
      const payload = parse(row.data);
      if (status === 'delivered') {
        payload.deliveryRef = string(input.receiptRef, 'receiptRef', 600);
        payload.deliveredAt = now();
      } else if (status === 'read') {
        payload.readAt = now();
        payload.readBy = ctx.actorId;
      } else {
        payload.deliveryError = identifier(input.errorCode ?? 'delivery_failed', 'errorCode');
      }
      run('UPDATE notifications SET state = ?, data = ? WHERE id = ?', status, json(payload), id);
      return notificationView(get('SELECT * FROM notifications WHERE id = ?', id));
    });
  }

  const effects = createEffectService({
    store, mode, catalog, now, rowStep, taskRow, mandateRow, assertOperational, assertNoPendingRevocation,
    requireLiveTask, assertLease, ownerId, capable, lookupGrant, pushEvent, addStep, replay, readJournal, durable, projectTask, raiseException, geoPreflight,
  });

  function recordBrowserHandoff(input, auth) {
    const ctx = identity(auth, ['owner']);
    const task = taskRow(input.taskId, ctx);
    mandateRow(task.mandate_id, ctx, true);
    const channelId = identifier(input.channelId, 'channelId');
    if (!catalog.has(channelId)) fail(422, 'UNKNOWN_CHANNEL', 'Choose a registered channel.');
    return transaction(() => replay(ctx, 'browser-handoff', input.leaseId, input, () => ({
      eventId: pushEvent(ctx, 'channel.owner_takeover', { channelId, leaseId: input.leaseId }, task),
    })));
  }

  function summarize(mandate, ctx, periodStart = 0, periodEnd = now()) {
    const tasks = all('SELECT * FROM tasks WHERE mandate_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at, id',
      mandate.id, periodStart, periodEnd);
    const rawEffects = all('SELECT * FROM effects WHERE mandate_id = ? AND consumed_at <= ? ORDER BY consumed_at, operation_key', mandate.id, periodEnd);
    const historical = periodStart > 0;
    const events = all('SELECT seq,task_id,actor,at,type,data FROM events WHERE mandate_id = ? AND at <= ? ORDER BY at,seq', mandate.id, periodEnd);
    const effectEvents = new Map(), taskStates = new Map(), prepared = new Map(), substitutions = [], sampled = new Map(), stepsAtCutoff = new Map();
    for (const event of events) {
      const data = parse(event.data);
      if (event.type.startsWith('effect.')) effectEvents.set(data.operationKey, { ...data, at:event.at, state:event.type.slice(7) });
      if (event.type === 'task.state') taskStates.set(event.task_id, data.to);
      if (['task.cancelled','task.paused','task.expired','task.resumed'].includes(event.type)) {
        taskStates.set(event.task_id, event.type === 'task.resumed' ? 'queued' : event.type.slice(5));
      }
      const key = json([event.task_id,data.channelId ?? null]);
      if (event.type === 'artifact.frozen' || event.type === 'review.recorded') prepared.set(key, event.type === 'review.recorded' && data.outcome === 'passed');
      if (event.type === 'decision.substitution_selected') substitutions.push({ ...data, taskId:event.task_id, selectedAt:event.at });
      if (event.type === 'observation.recorded') sampled.set(data.observationId, data);
      if (event.type === 'worker.reported' && data.state === 'succeeded') stepsAtCutoff.set(data.stepId, data.outputDigest);
    }
    const periodEffects = rawEffects.flatMap(effect => {
      const current = effects.effectView(effect);
      if (!historical) return [current];
      const last = effectEvents.get(effect.operation_key);
      if (!last || last.at < periodStart && effect.consumed_at < periodStart) return [];
      if (last.state === current.state && last.attempt === current.attempt) return [current];
      return [{ ...parse(effect.binding), operationKey:effect.operation_key, dataMode:mode, attempt:last.attempt,
        state:last.state === 'dispatch_recorded' ? 'in_flight' : last.state, consumedAt:effect.consumed_at,
        remoteId:last.remoteId ?? null, receiptRef:last.receiptRef ?? null }];
    });
    const visible = periodEffects.filter(effect => effect.state === 'verified' && effect.verifiedAt <= periodEnd);
    const evidence = {start:periodStart-1,end:periodEnd,mode,ownerId:mandate.owner_id,events,effects:rawEffects,
      observations:all('SELECT o.id,o.operation_key FROM observations o JOIN tasks t ON t.id = o.task_id WHERE t.mandate_id = ?',mandate.id)};
    const autonomy = deliveryScorecard({...evidence,
      tasks:all('SELECT id, deadline_at, commitments FROM tasks WHERE mandate_id = ? AND created_at <= ? AND (deadline_at IS NULL OR deadline_at BETWEEN ? AND ?)',mandate.id,periodEnd,periodStart,periodEnd)});
    const cutoff = historical ? deliveryScorecard({...evidence,tasks:tasks.map(task=>({...task,deadline_at:periodEnd}))}) : null;
    const reached = new Set(cutoff?.items.filter(item=>item.onTime).map(item=>json([item.taskId,item.goalId])) ?? []);
    const items = tasks.map(task=>({taskId:task.id,state:historical ? taskStates.get(task.id) ?? 'queued' : task.state,
      outcomes:parse(task.commitments).map(goal=>({...goal,fulfilled:historical ? reached.has(json([task.id,goal.id])) : requiredResult(task,goal)}))}));
    const expected=items.reduce((n,t)=>n+t.outcomes.length,0);
    const fulfilled=items.reduce((n,t)=>n+t.outcomes.filter(o=>o.fulfilled).length,0);
    const rounds = all(`SELECT s.id,s.output FROM steps s JOIN tasks t ON t.id = s.task_id
      WHERE t.mandate_id = ? AND s.kind = 'observe' AND s.state = 'succeeded'
        AND json_extract(s.output, '$.observedAt') BETWEEN ? AND ? ORDER BY s.due_at, s.id`, mandate.id, periodStart, periodEnd);
    const completedRounds = rounds.filter(row => !historical || stepsAtCutoff.get(row.id) === hash(parse(row.output)));
    const geo = geoPeriodReport(completedRounds.map(row => parse(row.output)), visible, periodStart, periodEnd, mode);
    const distinct = rows => new Set(rows.map(row=>json([row.target?.channelId ?? null,row.accountId ?? null,row.remoteId ?? null]))).size;
    const publicCount = distinct(visible.filter(effect=>effect.visibility === 'public'));
    const restrictedCount = distinct(visible.filter(effect=>effect.visibility !== 'public'));
    const observations = all(`SELECT o.* FROM observations o JOIN tasks t ON t.id = o.task_id
      WHERE t.mandate_id = ? AND o.due_at >= ? ORDER BY o.due_at, o.id`, mandate.id, periodStart).map(observationView).flatMap(row => {
        if (!historical) return [row];
        if (effectEvents.get(row.operationKey)?.state !== 'verified') return [];
        const prior = sampled.get(row.id);
        if (prior) return [{...row,state:prior.state}];
        return [{id:row.id,taskId:row.taskId,operationKey:row.operationKey,day:row.day,dueAt:row.dueAt,
          state:'scheduled_at_publication',dataMode:mode}];
      });
    const next = historical ? observations.filter(row => row.dueAt > periodEnd && row.state === 'scheduled_at_publication')
      .slice(0,12).map(row=>({id:row.id,kind:'observe',dueAt:row.dueAt,taskId:row.taskId})) : all(`SELECT s.id, s.kind, s.due_at AS dueAt, s.task_id AS taskId FROM steps s JOIN tasks t ON t.id = s.task_id
      WHERE s.scope = ? AND t.mandate_id = ? AND s.state = 'queued' ORDER BY s.due_at LIMIT 12`, ctx.scope, mandate.id)
      .map(row => ({ ...row }));
    return {
      mandateId: mandate.id, periodStart, periodEnd, dataMode: mode, items,
      autonomy, geo, substitutions:substitutions.map(target=>{
        const receipt = [...effectEvents.values()].find(event => event.state === 'verified' &&
          rawEffects.some(effect=>effect.operation_key === event.operationKey && effect.task_id === target.taskId &&
            effect.channel_id === target.channelId && parse(effect.settlement ?? '{}').visibility === target.outcome));
        return {...target, achieved:target.outcome === 'prepared' ? prepared.get(json([target.taskId,target.channelId])) === true : Boolean(receipt),
          receiptRef:receipt?.receiptRef ?? null};
      }),
      counts: { tasks: tasks.length, expected, fulfilled, realFulfilled: mode === 'real' ? fulfilled : 0, ownerTouches: autonomy.ownerTouches,
        prepared: historical ? [...prepared.values()].filter(Boolean).length : tasks.reduce((count, task) => count + planView(task.id).filter(row => row.packageHash && row.reviewState === 'passed').length, 0),
        publicVerified: mode === 'real' ? publicCount : 0, restrictedVerified: mode === 'real' ? restrictedCount : 0,
        fixturePublicVerified: mode === 'fixture' ? publicCount : 0, fixtureRestrictedVerified: mode === 'fixture' ? restrictedCount : 0,
        unresolved: periodEffects.filter(effect => ['unknown', 'accepted', 'in_flight'].includes(effect.state)).length },
      effects: periodEffects,
      observations, next, budget: effects.budgetView(mandate, periodEnd),
    };
  }

  function outcomes(id, auth) {
    const ctx = identity(auth, READ_ROLES);
    const mandate = mandateRow(id, ctx);
    const summary = summarize(mandate, ctx);
    const latest = get('SELECT id FROM tasks WHERE mandate_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', mandate.id);
    return { ...summary, channels: latest ? planView(latest.id) : basePlan(catalog, parse(mandate.config).requiredOutcomes, mandate.next_run_at),
      reports: all('SELECT * FROM weekly_reports WHERE mandate_id = ? ORDER BY period_end DESC', mandate.id)
        .map(row => ({ ...parse(row.data), id: row.id })) };
  }

  function createWeeklyReport(mandate, ctx, at, periodEnd, terminal) {
    const config = parse(mandate.config);
    const previous = get('SELECT max(period_end) AS end FROM weekly_reports WHERE mandate_id = ? AND period_end < ?',
      mandate.id, periodEnd).end;
    const periodStart = previous == null ? mandate.created_at : previous + 1;
    const terminalReason = terminal ? 'mandate_expired' : null;
    const summary = { ...summarize(mandate, ctx, periodStart, periodEnd), terminalReason };
    const id = `report-${hash([mandate.id, periodEnd]).slice(0, 40)}`;
    const inserted = run('INSERT OR IGNORE INTO weekly_reports(id, scope, mandate_id, period_end, data) VALUES (?, ?, ?, ?, ?)',
      id, ctx.scope, mandate.id, periodEnd, json(summary));
    if (Number(inserted.changes) > 0) {
      enqueueNotification(mandate, ctx, 'weekly-report', periodEnd, { reportId: id, kind: 'weekly_report', periodStart,
        periodEnd, terminalReason,
        summary: weeklyNoticeSummary(summary.autonomy.due, summary.autonomy.missed, summary.autonomy.autonomous),
        dataMode: mode, taskIds: [] }, at);
      pushEvent(ctx, 'report.weekly_created', { reportId: id, periodEnd, terminalReason, counts: summary.counts }, null, mandate.id, at);
    }
    if (periodEnd === mandate.next_report_at) {
      run('UPDATE mandates SET next_report_at = ? WHERE id = ?', periodEnd + config.schedule.reportIntervalMs, mandate.id);
    }
  }

  function tick(auth) {
    const ctx = identity(auth, ['system']);
    const at = now();
    const recovered = transaction(() => {
      const recovered = recoverLeases(ctx, at);
      if (restoring) return recovered;
      const expired = all("SELECT * FROM mandates WHERE scope = ? AND state IN ('active','paused') AND expires_at <= ?", ctx.scope, at);
      for (const mandate of expired) {
        run("UPDATE mandates SET state = 'expired', next_run_at = NULL WHERE id = ?", mandate.id);
        run("UPDATE permits SET state = 'revoked' WHERE state = 'issued' AND task_id IN (SELECT id FROM tasks WHERE mandate_id = ?)", mandate.id);
        effects.releaseGeoMandate(mandate.id, at);
        run("UPDATE observations SET state = 'cancelled' WHERE state = 'scheduled' AND task_id IN (SELECT id FROM tasks WHERE mandate_id = ?)", mandate.id);
        pushEvent(ctx, 'mandate.expired', { revision: mandate.version, deadlineAt: mandate.expires_at }, null, mandate.id, at);
      }
      return recovered;
    });
    const tasks = [];
    if (restoring) return { at, recovered, tasks, reports: 0, recoveryMode: true };

    // A failed independent intent write can stop new work without rolling back the reporting ledger.
    let schedulingError;
    try {
      transaction(() => {
        if (mode === 'real') syncPendingRevocations(ctx);
        const due = all("SELECT * FROM mandates WHERE scope = ? AND state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id", ctx.scope, at);
        for (const mandate of due) {
          const config = parse(mandate.config);
          const interval = config.schedule.intervalMs;
          const scheduledFor = mandate.next_run_at;
          const skipped = Math.floor((at - scheduledFor) / interval);
          const actualOccurrence = scheduledFor + skipped * interval;
          const input = { title: config.objective, input: { trigger: 'schedule', scheduledFor: actualOccurrence, missedOccurrences: skipped } };
          const task = acceptTask(input, mandate, `schedule:${actualOccurrence}`, ctx, at);
          tasks.push(taskView(task));
          run('UPDATE mandates SET next_run_at = ? WHERE id = ?', actualOccurrence + interval, mandate.id);
        }
      });
    } catch (error) { schedulingError = error; }

    const reports = transaction(() => {
      let count = 0;
      const dueReports = all(`SELECT m.* FROM mandates m WHERE m.scope = ? AND (
        (m.next_report_at <= ? AND (m.state IN ('active','paused') OR m.next_report_at <= m.expires_at)) OR
        (m.state = 'expired' AND m.expires_at <= ? AND NOT EXISTS
          (SELECT id FROM weekly_reports WHERE mandate_id = m.id AND period_end = m.expires_at)))
        ORDER BY m.next_report_at, m.id`, ctx.scope, at, at);
      for (const item of dueReports) {
        let row = item;
        for (let reportsForMandate = 0; reportsForMandate < 12; reportsForMandate += 1) {
          const periodEnd = row.state === 'expired' ? Math.min(row.next_report_at, row.expires_at) : row.next_report_at;
          if (periodEnd > at || row.state === 'revoked' && periodEnd > (row.expires_at ?? 0)) break;
          const terminal = row.state === 'expired' && periodEnd === row.expires_at;
          if (periodEnd < row.created_at) {
            const interval = parse(row.config).schedule.reportIntervalMs;
            run('UPDATE mandates SET next_report_at = ? WHERE id = ?',
              periodEnd + Math.ceil((row.created_at - periodEnd) / interval) * interval, row.id);
          } else {
            createWeeklyReport(row, ctx, at, periodEnd, terminal);
            count += 1;
          }
          if (terminal) break;
          row = mandateRow(row.id, ctx);
        }
      }
      return count;
    });
    if (schedulingError) throw schedulingError;
    return { at, recovered, tasks, reports, recoveryMode: false };
  }

  function restoreJournal(input, auth) {
    const ctx = identity(auth, ['system']);
    object(input, 'journal restore');
    if (!restoring) fail(409, 'RECOVERY_MODE_REQUIRED', 'Open a database snapshot in recovery mode before replaying its journal.');
    if (input.writerFenced !== true) fail(409, 'WRITER_FENCE_REQUIRED', 'Fence the previous writer before replaying its independent journal.');
    if (mode === 'real') requireJournal();
    return transaction(() => {
      if (mode === 'real') syncPendingRevocations(ctx);
      const received = mode === 'fixture' ? [] : journalCall('list', { scope: ctx.scope });
      const entries = objects(received, 'journal list', 500_000).map(row => validateEntry(row, ctx.scope, row?.key));
      const byKind = { mandate: 0, task: 1, effect: 2, cost: 3, effect_receipt: 4, cost_receipt: 4, observation_receipt: 5, task_control: 6 };
      entries.sort((left, right) => (byKind[left.kind] ?? 100) - (byKind[right.kind] ?? 100) || left.at - right.at ||
        (left.data.controlVersion ?? 0) - (right.data.controlVersion ?? 0));
      let exported = 0;
      for (const entry of entries) {
        const prior = get('SELECT digest FROM recovered_journal WHERE scope = ? AND key = ?', ctx.scope, entry.key);
        if (prior) {
          if (prior.digest !== entry.digest) fail(503, 'JOURNAL_INTEGRITY_ERROR', 'A previously applied remote record changed.');
          continue;
        }
        if (entry.kind === 'mandate') insertMandate(entry.data.row);
        else if (entry.kind === 'task') insertTask(entry.data.row, entry.data.step);
        else if (entry.kind === 'task_control') applyTaskControl(taskRow(entry.data.taskId, ctx), entry.data.action, ctx, entry.at, entry.data.continuation);
        else effects.restoreEffectEntry(ctx, entry);
        rememberReplayEntry(entry);
        exported += 1;
      }
      const at = now();
      for (const mandate of all("SELECT id FROM mandates WHERE scope = ? AND state IN ('revoked','expired')", ctx.scope)) {
        effects.releaseGeoMandate(mandate.id, at);
        run("UPDATE observations SET state = 'cancelled' WHERE state = 'scheduled' AND task_id IN (SELECT id FROM tasks WHERE mandate_id = ?)", mandate.id);
      }
      // Remote input is only reconciled after fencing. Any interrupted local leases lose the old owner at once.
      run("UPDATE steps SET lease_until = ? WHERE scope = ? AND state = 'leased'", at, ctx.scope);
      recoverLeases(ctx, at);
      const unsettledEffects = get("SELECT count(*) AS n FROM effects WHERE scope = ? AND state IN ('unknown','accepted','in_flight')", ctx.scope).n;
      const unsettledCosts = get("SELECT count(*) AS n FROM costs WHERE scope = ? AND state IN ('unknown','dispatched')", ctx.scope).n;
      pushEvent(ctx, 'recovery.replayed', { exported, unsettledEffects, unsettledCosts }, null, null, at);
      return { replayed: exported, unsettledEffects, unsettledCosts, readOnly: true };
    });
  }

  function completeRecovery(input, auth) {
    const ctx = identity(auth, ['system']);
    object(input, 'recovery completion');
    if (!restoring) return { readOnly: false };
    if (input.writerFenced !== true) fail(409, 'WRITER_FENCE_REQUIRED', 'The previous writer must remain fenced.');
    const replayed = restoreJournal(input, ctx);
    if (replayed.unsettledEffects || replayed.unsettledCosts) fail(409, 'RECOVERY_RECONCILIATION_REQUIRED', 'Independent intents are still waiting for reconciliation.', replayed);
    transaction(() => run('DELETE FROM metadata WHERE key = ?', recoveryKey));
    restoring = false;
    return { ...replayed, readOnly: false };
  }

  function health(auth) {
    const ctx = identity(auth, READ_ROLES);
    const readOnly = restoring;
    const journalReady = mode === 'fixture' || Boolean(journal && ['append', 'get', 'list'].every(method => typeof journal[method] === 'function'));
    return { ready: !readOnly && journalReady, readOnly, journalReady, channelCount: catalog.size, dataMode: mode,
      tasks: get('SELECT count(*) AS n FROM tasks WHERE scope = ?', ctx.scope).n };
  }

  const { restoreEffectEntry, effectView, budgetView, releaseGeoTask, releaseGeoMandate, ...effectApi } = effects;
  return {
    close: store.close, health, previewMandate, createMandate, listMandates, getMandate, renewMandate, revokeMandate,
    ingestEvent, tick, createTask, listTasks, getTask, listEvents, listProjectEvents, controlTask, recordBrowserHandoff, outcomes,
    claim, heartbeat, checkpoint, report, recordException, listNotifications, ackNotification,
    restoreJournal, completeRecovery, ...effectApi,
  };
}
