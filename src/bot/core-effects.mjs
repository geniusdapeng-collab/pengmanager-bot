import {
  assertRevision, DAY, fail, hash, identifier, identity, instant, integer, json, key, newId, object, parse, sha, string,
} from './core-store.mjs';
import { capabilityBinding, capabilityKey, dayBoundary } from './core-plans.mjs';
import { budgetWindow, createGeoFunding } from './core-geo.mjs';

const WORK = ['worker', 'reviewer', 'connector', 'system'];
const READ = ['owner', ...WORK, 'reader'];
const CONNECT = ['connector'];
const DONE = ['verified', 'rejected', 'not_executed'];
const VERIFIERS = ['server_readback', 'official_api_readback', 'browser_readback', 'manual_readback', 'fixture_readback'];

function evidenceUrl(value, mode, visibility) {
  if (value === undefined || value === null) {
    if (visibility === 'public') fail(422, 'READBACK_URL_REQUIRED', 'A verified public result requires its public URL.');
    return null;
  }
  let url;
  try { url = new URL(string(value, 'url', 1500)); }
  catch (error) {
    if (error.code === 'INVALID_INPUT') throw error;
    fail(422, 'INVALID_READBACK_URL', 'Readback URL is invalid.');
  }
  const fixtureLoopback = mode === 'fixture' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !fixtureLoopback || url.username || url.password || url.port && !fixtureLoopback || [...url.searchParams.keys()]
    .some(name => /(?:token|apikey|passwd|password|secret|signature|authorization|session|cookie)/iu.test(name))) {
    fail(422, 'INVALID_READBACK_URL', 'Use a public HTTPS URL without embedded credentials.');
  }
  if (mode === 'real' && (/(?:^localhost$|\.(?:localhost|test|invalid|example|local)$|^\d+\.\d+\.\d+\.\d+$|^\[)/iu.test(url.hostname)
    || /(^|\.)example\.(com|net|org)$/iu.test(url.hostname))) {
    fail(422, 'INVALID_READBACK_URL', 'Real evidence must refer to a real platform host.');
  }
  return url.href;
}

export function createEffectService({
  store, mode, catalog, now, rowStep, taskRow, mandateRow, assertOperational, assertNoPendingRevocation,
  requireLiveTask, assertLease, ownerId, capable, lookupGrant, pushEvent, addStep, replay, readJournal, durable, projectTask, raiseException, geoPreflight,
}) {
  const { get, run, all, transaction } = store;
  const geo = createGeoFunding({ store, mode, now, preflight: geoPreflight });

  function capabilityRow(ctx, binding) {
    return get('SELECT * FROM capabilities WHERE scope = ? AND capability_key = ?', ctx.scope, capabilityKey(binding));
  }

  function capabilityView(row) {
    return { ...parse(row.data), key: row.capability_key, revision: row.version, version: row.version, dataMode: mode };
  }

  function listCapabilities(auth) {
    const ctx = identity(auth, READ);
    return all('SELECT * FROM capabilities WHERE scope = ? ORDER BY channel_id, capability_key', ctx.scope).map(capabilityView);
  }

  function recordCapability(input, auth) {
    const ctx = identity(auth, ['owner']);
    assertOperational();
    object(input, 'channel capability');
    return transaction(() => replay(ctx, 'capability.save', input.idempotencyKey, input, () => {
      const binding = capabilityBinding(input, catalog);
      const prior = capabilityRow(ctx, binding);
      if (prior) assertRevision(prior, input);
      const at = now();
      const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : instant(input.expiresAt, 'expiresAt');
      if (expiresAt !== null && expiresAt <= at) fail(422, 'CAPABILITY_EXPIRED', 'Supply an unexpired capability record.');
      const restoreEvidenceRef = string(input.restoreEvidenceRef, 'restoreEvidenceRef', 500, true);
      const restored = input.restored === true && restoreEvidenceRef !== null;
      const recordMode = input.mode ?? null;
      if (![null, 'manual', 'platform_confirmation', 'official', 'official_api', 'api', 'owned', 'prepare', 'prepare_only'].includes(recordMode)) {
        fail(422, 'INVALID_CAPABILITY_MODE', 'Channel capability mode is outside the runtime contract.');
      }
      const frozen = { ...binding, active: input.active !== false && (!catalog.get(binding.channelId).archived || restored),
        official: input.official === true || input.officialWrite === true,
        confirmationRequired: input.confirmationRequired === true || input.requiresConfirmation === true || recordMode === 'platform_confirmation',
        safeDedup: input.safeDedup === true || input.reliableDedup === true,
        businessReadback: input.businessReadback === true || input.businessLookup === true,
        policyRef: string(input.policyRef, 'policyRef', 500, true), evidenceRef: string(input.evidenceRef, 'evidenceRef', 500, true),
        rulesHash: input.rulesHash === null || input.rulesHash === undefined ? null : sha(input.rulesHash, 'rulesHash'),
        mode: recordMode, restored, restoreEvidenceRef,
        expiresAt, reviewedBy: ctx.actorId, verifiedAt: at, cooldownUntil: input.cooldownUntil === undefined || input.cooldownUntil === null
          ? null : instant(input.cooldownUntil, 'cooldownUntil') };
      if (mode === 'real' && frozen.official && (!frozen.policyRef || !frozen.evidenceRef || expiresAt === null)) {
        fail(422, 'CAPABILITY_EVIDENCE_REQUIRED', 'A real write capability requires reviewed policy and expiring account-specific evidence.');
      }
      run(`INSERT INTO capabilities(scope, capability_key, channel_id, version, data) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(scope, capability_key) DO UPDATE SET version = capabilities.version + 1, data = excluded.data`,
      ctx.scope, capabilityKey(binding), binding.channelId, json(frozen));
      pushEvent(ctx, 'capability.changed', { key: capabilityKey(binding), channelId: binding.channelId, active: frozen.active });
      return capabilityView(capabilityRow(ctx, binding));
    }));
  }

  function planRow(task, channelId) {
    const row = get('SELECT * FROM channel_plans WHERE task_id = ? AND channel_id = ?', task.id, identifier(channelId, 'channelId'));
    if (!row) fail(404, 'CHANNEL_NOT_FOUND', 'Task has no such channel.');
    return row;
  }

  function updatePlan(task, channelId, patch) {
    const row = planRow(task, channelId);
    const data = parse(row.data);
    const payload = json({ ...data, ...patch });
    if (payload !== row.data) run('UPDATE channel_plans SET version = version + 1, data = ? WHERE task_id = ? AND channel_id = ?', payload, task.id, channelId);
  }

  function authorizeArtifactWork(input, task, ctx, kind) {
    requireLiveTask(task, ctx, kind);
    const stepId = input.id ?? input.stepId;
    if (stepId === undefined && mode === 'fixture' && kind === 'prepare') return null;
    const step = assertLease(rowStep(stepId, ctx), input.epoch, ctx);
    if (step.task_id !== task.id || step.kind !== kind) fail(403, 'WORK_BINDING_DENIED', 'The active work lease belongs to a different task or work kind.');
    const stepChannel = parse(step.input).channelId;
    if (stepChannel !== undefined && stepChannel !== input.channelId) fail(403, 'WORK_BINDING_DENIED', 'The work lease belongs to another channel.');
    return step;
  }

  function recordArtifact(input, auth) {
    const ctx = identity(auth, ['worker', 'system', 'reviewer']);
    object(input, 'artifact');
    if (mode === 'real' && input.dataMode === 'fixture') fail(422, 'ARTIFACT_DATA_MODE', 'Fixture artifacts cannot enter a real ledger.');
    return transaction(() => {
      const task = taskRow(input.taskId, ctx);
      let producer = ctx.actorId;
      if (ctx.role === 'reviewer') {
        const reviewStep = authorizeArtifactWork(input, task, ctx, 'review');
        const jobId = parse(reviewStep.input).jobId;
        const preparation = typeof jobId === 'string' && get(`SELECT holder FROM steps WHERE task_id = ? AND kind = 'prepare' AND state = 'succeeded'
          AND json_extract(output, '$.jobId') = ? AND holder IS NOT NULL ORDER BY rowid DESC LIMIT 1`, task.id, jobId);
        if (!preparation || preparation.holder === ctx.actorId) {
          fail(403, 'INDEPENDENT_NATIVE_ORIGIN_REQUIRED', 'Native review can register a candidate only from an exact independent preparation step.');
        }
        producer = preparation.holder;
      } else {
        authorizeArtifactWork(input, task, ctx, 'prepare');
      }
      const plan = planRow(task, input.channelId);
      const current = parse(plan.data);
      if (current.disposition === 'archived') fail(403, 'CHANNEL_ARCHIVED', 'Archived destinations cannot run work.');
      const binding = capabilityBinding({ ...current, ...input, channelId: plan.channel_id }, catalog);
      if (['form', 'accountId', 'destination'].some(field => current[field] !== null && current[field] !== binding[field])) {
        fail(409, 'CHANNEL_PACKAGE_MISMATCH', 'The package belongs to a different destination or form.');
      }
      const packageHash = sha(input.packageHash, 'packageHash');
      const payload = {
        binding, packageHash, artifactRef: string(input.artifactRef ?? input.nativeRef, 'artifactRef', 600),
        manifestRef: string(input.manifestRef, 'manifestRef', 600, true), producer,
        dataMode: mode, createdAt: now(),
      };
      const existing = get('SELECT * FROM artifacts WHERE task_id = ? AND channel_id = ? AND package_hash = ?', task.id, binding.channelId, packageHash);
      if (existing) {
        const old = parse(existing.data);
        if (hash({ ...old, createdAt: 0 }) !== hash({ ...payload, createdAt: 0 })) {
          fail(409, 'ARTIFACT_CONFLICT', 'The frozen package already has different artifact metadata.');
        }
        return old;
      }
      run('INSERT INTO artifacts(task_id, channel_id, package_hash, producer, created_at, data) VALUES (?, ?, ?, ?, ?, ?)',
        task.id, binding.channelId, packageHash, producer, payload.createdAt, json(payload));
      updatePlan(task, binding.channelId, { ...binding, packageHash, artifactRef: payload.artifactRef,
        disposition: 'prepared', reviewState: null, reportHash: null });
      run("UPDATE permits SET state = 'revoked' WHERE task_id = ? AND state = 'issued' AND json_extract(binding, '$.target.channelId') = ?", task.id, binding.channelId);
      pushEvent(ctx, 'artifact.frozen', { channelId: binding.channelId, packageHash, artifactRef: payload.artifactRef, supersedes: current.packageHash ?? null }, task);
      projectTask(task, ctx);
      return payload;
    });
  }

  function recordReview(input, auth) {
    const ctx = identity(auth, ['reviewer']);
    object(input, 'independent review');
    if (mode === 'real' && input.dataMode === 'fixture') fail(422, 'REVIEW_DATA_MODE', 'Fixture review cannot enter a real ledger.');
    return transaction(() => {
      const task = taskRow(input.taskId, ctx);
      if (mode === 'real' || input.id !== undefined || input.stepId !== undefined) authorizeArtifactWork(input, task, ctx, 'review');
      else requireLiveTask(task, ctx, 'review');
      const plan = planRow(task, input.channelId);
      const current = parse(plan.data);
      const packageHash = sha(input.packageHash, 'packageHash');
      const reportHash = sha(input.reportHash, 'reportHash');
      const artifact = get('SELECT * FROM artifacts WHERE task_id = ? AND channel_id = ? AND package_hash = ?', task.id, plan.channel_id, packageHash);
      if (!artifact || packageHash !== current.packageHash) fail(409, 'PACKAGE_STALE', 'Review must cover the current frozen package.');
      if (artifact.producer === ctx.actorId) fail(403, 'INDEPENDENT_REVIEW_REQUIRED', 'The producer cannot independently review this package.');
      const outcome = input.outcome ?? input.status;
      if (!['passed', 'rejected', 'needs_repair'].includes(outcome)) fail(422, 'INVALID_REVIEW_OUTCOME', 'Unsupported independent review outcome.');
      const verified = input.verified === true;
      if (outcome === 'passed' && !verified) fail(422, 'REVIEW_EVIDENCE_REQUIRED', 'A passing review requires verified coverage evidence.');
      const evidenceRef = string(input.evidenceRef ?? input.reportRef ?? (mode === 'fixture' ? reportHash : undefined), 'evidenceRef', 600);
      const payload = { taskId: task.id, channelId: plan.channel_id, packageHash, reportHash,
        reviewedBy: ctx.actorId, evidenceRef, verified, outcome, dataMode: mode };
      const existing = get('SELECT * FROM reviews WHERE task_id = ? AND channel_id = ? AND package_hash = ? AND report_hash = ?',
        task.id, plan.channel_id, packageHash, reportHash);
      if (existing) {
        if (existing.data !== json(payload)) fail(409, 'REVIEW_CONFLICT', 'This report hash already has different review evidence.');
        return parse(existing.data);
      }
      run('INSERT INTO reviews(task_id, channel_id, package_hash, report_hash, reviewer, state, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        task.id, plan.channel_id, packageHash, reportHash, ctx.actorId, outcome, now(), json(payload));
      updatePlan(task, plan.channel_id, { reviewState: outcome, reportHash, reviewRef: evidenceRef, disposition: outcome === 'passed' ? 'reviewed' : 'needs_input' });
      run("UPDATE permits SET state = 'revoked' WHERE task_id = ? AND state = 'issued' AND json_extract(binding, '$.target.channelId') = ?",
        task.id, plan.channel_id);
      pushEvent(ctx, 'review.recorded', { channelId: plan.channel_id, packageHash, reportHash, outcome }, task);
      projectTask(task, ctx);
      return payload;
    });
  }

  function confirmTarget(input, auth) {
    const ctx = identity(auth, ['owner']);
    object(input, 'external confirmation');
    return transaction(() => replay(ctx, `confirmation:${input.taskId}:${input.channelId}`, input.idempotencyKey, input, () => {
      const task = taskRow(input.taskId, ctx);
      const mandate = requireLiveTask(task, ctx, 'publish');
      ownerId(ctx, mandate);
      if (input.taskRevision !== undefined) assertRevision(task, { expectedRevision: input.taskRevision });
      const row = planRow(task, input.channelId);
      assertRevision(row, input);
      const plan = parse(row.data);
      const current = capabilityBinding(plan, catalog);
      const target = capabilityBinding({ ...plan, ...input }, catalog);
      if (capabilityKey(current) !== capabilityKey(target) || plan.packageHash !== input.packageHash ||
        plan.reviewState !== 'passed' || task.mandate_version !== mandate.version) {
        fail(409, 'CONFIRMATION_STALE', 'Confirmation must match the current account, task revision, and approved package.');
      }
      const capability = capabilityRow(ctx, target);
      if (!capability || !parse(capability.data).confirmationRequired || !parse(capability.data).active ||
        parse(capability.data).expiresAt !== null && parse(capability.data).expiresAt <= now()) {
        fail(422, 'CONFIRMATION_NOT_REQUIRED', 'There is no active requirement for owner confirmation at this destination.');
      }
      const ticketId = newId('confirmation');
      const payload = { ticketId, target, packageHash: plan.packageHash, ownerId: ctx.actorId,
        reportHash: plan.reportHash, grantRevision: mandate.version, reviewedAt: now(), state: 'owner_confirmed', dataMode: mode };
      run('INSERT INTO confirmations(task_id, channel_id, ticket_id, content) VALUES (?, ?, ?, ?)', task.id, row.channel_id, ticketId, json(payload));
      updatePlan(task, row.channel_id, { disposition: 'handoff', confirmationId: ticketId });
      pushEvent(ctx, 'channel.owner_confirmed', { channelId: row.channel_id, ticketId, packageHash: payload.packageHash }, task);
      return payload;
    }));
  }

  function recordOwnerSubmission(input, auth) {
    const ctx = identity(auth, ['owner']);
    object(input, 'owner submission receipt');
    return transaction(() => replay(ctx, `owner-submission:${input.taskId}:${input.channelId}`, input.idempotencyKey, input, () => {
      const task = taskRow(input.taskId, ctx);
      const mandate = mandateRow(task.mandate_id, ctx);
      ownerId(ctx, mandate);
      assertRevision(task, { expectedRevision: input.taskRevision });
      const row = planRow(task, input.channelId);
      assertRevision(row, input);
      const plan = parse(row.data);
      if (plan.machinePublish || !['manual', 'owner_confirmation', 'handoff'].includes(plan.plannedDisposition ?? plan.disposition)) {
        fail(403, 'OWNER_HANDOFF_REQUIRED', 'Record owner submissions only for a scoped manual or confirmation handoff.');
      }
      const target = capabilityBinding(input, catalog);
      const packageHash = sha(input.packageHash, 'packageHash');
      currentPublication(task, target, packageHash, ctx);
      if (plan.plannedDisposition === 'owner_confirmation' && !plan.confirmationId) {
        fail(409, 'OWNER_CONFIRMATION_REQUIRED', 'Complete the exact handoff confirmation before recording a submission.');
      }
      if (plan.ownerSubmissionId) fail(409, 'OWNER_SUBMISSION_ALREADY_RECORDED', 'This handoff already has its owner receipt.');
      const at = now();
      const submittedAt = input.submittedAt === undefined || input.submittedAt === null ? null : instant(input.submittedAt, 'submittedAt');
      if (submittedAt !== null && submittedAt > at + 60_000) fail(422, 'INVALID_READBACK_TIME', 'The reported time is in the future.');
      const ticketId = newId('owner-submission');
      const receipt = { ticketId, taskId: task.id, target, packageHash, receiptRef: string(input.receiptRef, 'receiptRef', 600),
        url: input.url === null || input.url === undefined ? null : evidenceUrl(input.url, mode, target.visibility),
        remoteId: string(input.remoteId, 'remoteId', 240, true), submittedAt, reportedAt: at, ownerId: ctx.actorId,
        ownerMinutes: input.ownerMinutes == null ? null : integer(input.ownerMinutes, 'ownerMinutes', 0, 10080),
        state: 'owner_reported', evidenceKind: 'owner_attestation', dataMode: mode };
      run('INSERT INTO confirmations(task_id, channel_id, ticket_id, content) VALUES (?, ?, ?, ?)', task.id, row.channel_id, ticketId, json(receipt));
      updatePlan(task, row.channel_id, { disposition: 'owner_reported', ownerSubmissionId: ticketId, ownerSubmissionRef: receipt.receiptRef });
      pushEvent(ctx, 'channel.owner_reported', { channelId: row.channel_id, ticketId, packageHash, receiptRef: receipt.receiptRef, ownerMinutes: receipt.ownerMinutes }, task);
      if (task.deadline_at === null || at < task.deadline_at) projectTask(task, ctx);
      return receipt;
    }));
  }

  function currentPublication(task, target, packageHash, ctx) {
    const row = planRow(task, target.channelId);
    const plan = parse(row.data);
    const artifact = get('SELECT * FROM artifacts WHERE task_id = ? AND channel_id = ? AND package_hash = ?', task.id, row.channel_id, packageHash);
    if (!artifact || plan.packageHash !== packageHash || !plan.reportHash || plan.reviewState !== 'passed' ||
      capabilityKey(parse(artifact.data).binding) !== capabilityKey(target)) {
      fail(409, 'PACKAGE_NOT_APPROVED', 'The exact account, format, package and independent review must match.');
    }
    const review = get('SELECT * FROM reviews WHERE task_id = ? AND channel_id = ? AND package_hash = ? AND report_hash = ?',
      task.id, row.channel_id, packageHash, plan.reportHash);
    if (!review || review.state !== 'passed' || review.reviewer === artifact.producer || parse(review.data).verified !== true) {
      fail(409, 'REVIEW_NOT_CURRENT', 'This exact package lacks a current independent approval.');
    }
    return { plan, review };
  }

  function writeGate(task, target, ctx, at) {
    assertNoPendingRevocation(ctx);
    const mandate = requireLiveTask(task, ctx, 'publish', at);
    if (task.mandate_version !== mandate.version) fail(409, 'MANDATE_REVISION_CHANGED', 'The task was accepted under another mandate revision.');
    const grant = lookupGrant(mandate, target);
    if (!grant || grant.risk !== 'low') fail(403, 'TARGET_NOT_AUTHORIZED', 'The standing mandate does not allow this exact low-risk side effect.');
    if (mode === 'real' && (target.form !== 'article' || target.channelId === 'official-site' && !['publish','replace'].includes(target.action) ||
      target.channelId === 'devto' && target.action !== 'publish' || !['official-site','devto'].includes(target.channelId))) {
      fail(403, 'NATIVE_CONNECTOR_NOT_READY', 'This target and action lack an implemented unattended connector.');
    }
    const capability = capabilityRow(ctx, target);
    if (!capable(capability, at)) fail(403, 'CHANNEL_CAPABILITY_DENIED', 'This account and form lack active official write, safe deduplication, or business readback.');
    const data = parse(capability.data);
    if (data.cooldownUntil !== null && data.cooldownUntil > at) fail(409, 'CHANNEL_COOLDOWN', 'The destination is still in its authorized cooldown.');
    return { mandate, grant, capability };
  }

  function permitView(row) {
    return { ...parse(row.binding), permitId: row.id, id: row.id, operationKey: row.operation_key,
      state: row.state, expiresAt: row.expires_at, dataMode: mode };
  }

  function issuePermit(input, auth) {
    const ctx = identity(auth, ['system']);
    object(input, 'permit');
    return transaction(() => replay(ctx, `permit.issue:${input.taskId}`, input.idempotencyKey, input, () => {
      const at = now();
      const task = taskRow(input.taskId, ctx);
      const target = capabilityBinding(input, catalog);
      const packageHash = sha(input.packageHash, 'packageHash');
      const { mandate, capability } = writeGate(task, target, ctx, at);
      const { review } = currentPublication(task, target, packageHash, ctx);
      if (!Object.hasOwn(input, 'expectedPreviousReleaseId') && (mode === 'real' || target.action === 'replace')) {
        fail(422, 'PREVIOUS_RELEASE_REQUIRED', 'An explicit previous release identity or null is required.');
      }
      const previousRelease = input.expectedPreviousReleaseId === null || input.expectedPreviousReleaseId === undefined ? null
        : identifier(input.expectedPreviousReleaseId, 'expectedPreviousReleaseId');
      const stable = { taskId: task.id, mandateId: mandate.id, target, packageHash, previousRelease };
      const operationKey = hash([ctx.scope, target, packageHash, previousRelease]);
      const effect = get('SELECT * FROM effects WHERE scope = ? AND operation_key = ?', ctx.scope, operationKey);
      if (!effect || effect.state === 'not_executed') {
        geo.assessment({ mandate, task, target, operationKey, attempt: (effect?.attempt ?? 0) + 1, at, budgetView });
      }
      const id = newId('permit');
      const expires = at + integer(input.ttlMs ?? 900_000, 'ttlMs', 100, 3_600_000);
      const expiresAt = Math.min(expires, task.deadline_at ?? Infinity, mandate.expires_at ?? Infinity, parse(capability.data).expiresAt ?? Infinity);
      const binding = { ...stable, reportHash: review.report_hash, capabilityRevision: capability.version,
        grantRevision: mandate.version, revocationEpoch: mandate.revocation_epoch, issuedAt: at, issuedBy: ctx.actorId };
      run('INSERT INTO permits(id, scope, task_id, operation_key, state, expires_at, binding) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, ctx.scope, task.id, operationKey, 'issued', expiresAt, json(binding));
      pushEvent(ctx, 'permit.issued', { permitId: id, operationKey, target, packageHash, reportHash: review.report_hash, expiresAt }, task);
      return permitView(get('SELECT * FROM permits WHERE id = ?', id));
    }));
  }

  function effectView(row) {
    if (!row) return null;
    return { ...parse(row.binding), ...parse(row.settlement ?? '{}'), operationKey: row.operation_key, state: row.state,
      status: row.state, attempt: row.attempt, consumedAt: row.consumed_at, dataMode: mode };
  }

  function getEffect(operationKey, auth) {
    const ctx = identity(auth, READ);
    const row = get('SELECT * FROM effects WHERE scope = ? AND operation_key = ?', ctx.scope, sha(operationKey, 'operationKey'));
    if (!row) fail(404, 'EFFECT_NOT_FOUND', 'No operation with that key exists in this project.');
    return effectView(row);
  }

  function insertEffect(row) {
    run(`INSERT INTO effects(operation_key, scope, mandate_id, task_id, channel_id, state, attempt, consumed_at, settlement, binding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_key) DO UPDATE SET state = excluded.state, attempt = excluded.attempt, consumed_at = excluded.consumed_at,
      settlement = excluded.settlement, binding = excluded.binding WHERE effects.attempt < excluded.attempt AND effects.scope = excluded.scope`,
    row.operation_key, row.scope, row.mandate_id, row.task_id, row.channel_id, row.state, row.attempt, row.consumed_at, row.settlement, row.binding);
  }

  function consumePermit(input, auth) {
    const ctx = identity(auth, CONNECT);
    object(input, 'consume permit');
    return transaction(() => {
      const permit = get('SELECT * FROM permits WHERE scope = ? AND id = ?', ctx.scope, identifier(input.permitId, 'permitId'));
      if (!permit) fail(404, 'PERMIT_NOT_FOUND', 'No permit with that ID exists in this project.');
      const task = taskRow(permit.task_id, ctx);
      const prior = get('SELECT * FROM effects WHERE scope = ? AND operation_key = ?', ctx.scope, permit.operation_key);
      if (prior && (prior.state !== 'not_executed' || permit.state === 'consumed')) return { ...effectView(prior), execute: false };
      const at = now();
      if (permit.state !== 'issued' || permit.expires_at <= at) fail(403, 'PERMIT_INACTIVE', 'The single-use permit expired or was revoked.');
      const binding = parse(permit.binding);
      const { mandate, grant, capability } = writeGate(task, binding.target, ctx, at);
      const { review } = currentPublication(task, binding.target, binding.packageHash, ctx);
      if (mandate.version !== binding.grantRevision || mandate.revocation_epoch !== binding.revocationEpoch ||
        capability.version !== binding.capabilityRevision || review.report_hash !== binding.reportHash) {
        fail(409, 'PERMIT_STALE', 'Policy, capability, or review changed after permit issuance.');
      }
      if (mode === 'real' && !Object.hasOwn(input, 'expectedPreviousReleaseId')) {
        fail(422, 'PREVIOUS_RELEASE_REQUIRED', 'The executing connector must provide the current previous release identity.');
      }
      if ((input.expectedPreviousReleaseId ?? null) !== binding.previousRelease) {
        fail(409, 'PREVIOUS_RELEASE_CONFLICT', 'The original destination points to a different revision.');
      }
      const stepId = input.id ?? input.stepId ?? null;
      if (mode === 'real' || stepId !== null) {
        const step = assertLease(rowStep(stepId, ctx), input.epoch, ctx, at);
        if (step.kind !== 'publish' || step.task_id !== task.id || parse(step.input).channelId !== undefined &&
          parse(step.input).channelId !== binding.target.channelId) {
          fail(403, 'WORK_BINDING_DENIED', 'The publication permit must cross a live connector lease for this exact task and target.');
        }
      }
      const tz = parse(mandate.config).timeZone;
      const day = dayBoundary(at, tz);
      const frequency = all("SELECT * FROM effects WHERE scope = ? AND state != 'not_executed' AND consumed_at > ?",
        ctx.scope, at - 2 * DAY).filter(row => {
          const target = parse(row.binding).target;
          return target.accountId === binding.target.accountId && target.channelId === binding.target.channelId && dayBoundary(row.consumed_at, tz) === day;
        }).length;
      if (frequency >= grant.maxDaily) fail(409, 'PUBLICATION_RATE_LIMIT', 'The account has reached the authorized daily submit limit.');
      const attempt = (prior?.attempt ?? 0) + 1;
      const journalKey = `effect:${permit.operation_key}:${attempt}`;
      const outstanding = readJournal(ctx, journalKey);
      if (outstanding) {
        if (outstanding.kind !== 'effect' || outstanding.data.operation_key !== permit.operation_key) {
          fail(409, 'JOURNAL_CONFLICT', 'This operation has an inconsistent independent intent.');
        }
        insertEffect({ ...outstanding.data, state: 'unknown' });
        geo.insert(parse(outstanding.data.binding).geoFunding ?? []);
        run("UPDATE permits SET state = 'consumed' WHERE id = ?", permit.id);
        addStep(task, { kind: 'reconcile', key: `reconcile:${permit.operation_key}:${attempt}`, input: { operationKey: permit.operation_key } }, at);
        projectTask(task, ctx);
        return { ...getEffect(permit.operation_key, ctx), execute: false };
      }
      const geoFunding = geo.assessment({ mandate, task, target: binding.target, operationKey: permit.operation_key, attempt, at, budgetView });
      const row = { operation_key: permit.operation_key, scope: ctx.scope, mandate_id: mandate.id, task_id: task.id,
        channel_id: binding.target.channelId, state: 'in_flight', attempt, consumed_at: at, settlement: null,
        binding: json({ ...binding, permitId: permit.id, stepId, leaseEpoch: input.epoch ?? null,
          connectorId: ctx.actorId, geoFunding }) };
      durable(ctx, journalKey, 'effect', row, at);
      insertEffect(row);
      geo.insert(geoFunding);
      run("UPDATE permits SET state = 'consumed' WHERE id = ?", permit.id);
      pushEvent(ctx, 'effect.dispatch_recorded', { operationKey: permit.operation_key, attempt, permitId: permit.id, stepId }, task);
      projectTask(task, ctx);
      return { ...effectView(row), execute: true };
    });
  }

  function recordEffect(input, auth) {
    const ctx = identity(auth, CONNECT);
    object(input, 'effect receipt');
    return transaction(() => {
      const at = now();
      const operationKey = sha(input.operationKey, 'operationKey');
      const row = get('SELECT * FROM effects WHERE scope = ? AND operation_key = ?', ctx.scope, operationKey);
      if (!row) fail(404, 'EFFECT_NOT_FOUND', 'No original dispatch is available for this operation.');
      const task = taskRow(row.task_id, ctx);
      const binding = parse(row.binding);
      const status = input.status;
      if (!['unknown', 'accepted', 'verified', 'not_executed', 'rejected'].includes(status)) {
        fail(422, 'INVALID_EFFECT_STATUS', 'The connector must report an understood result state.');
      }
      if (input.attempt !== undefined && input.attempt !== row.attempt) fail(409, 'STALE_ATTEMPT', 'Receipt belongs to an older dispatch attempt.');
      const existing = parse(row.settlement ?? '{}');
      if (status === 'unknown' && (row.state === 'accepted' || DONE.includes(row.state))) return effectView(row);
      const receipt = { ...existing, reason: string(input.reason, 'reason', 500, true) };
      if (input.remoteId !== undefined && input.remoteId !== null) {
        receipt.remoteId = string(input.remoteId, 'remoteId', 240);
        if (existing.remoteId && existing.remoteId !== receipt.remoteId) fail(409, 'REMOTE_OBJECT_CONFLICT', 'This operation already has a different remote result.');
        const duplicate = get(`SELECT operation_key FROM effects WHERE scope = ? AND channel_id = ? AND operation_key != ?
          AND json_extract(binding, '$.target.accountId') = ? AND json_extract(settlement, '$.remoteId') = ?`,
        ctx.scope, row.channel_id, operationKey, binding.target.accountId, receipt.remoteId);
        if (duplicate) fail(409, 'DUPLICATE_REMOTE_OBJECT', 'Another operation has already recorded this remote business object.');
      }
      if (input.receiptRef !== undefined && input.receiptRef !== null) receipt.receiptRef = string(input.receiptRef, 'receiptRef', 600);
      if (status === 'accepted' && !receipt.remoteId && !receipt.receiptRef) fail(422, 'ACCEPTANCE_EVIDENCE_REQUIRED', 'Provider acceptance needs a business ID or an acceptance receipt.');
      if (status === 'not_executed' || status === 'rejected') {
        if (!receipt.receiptRef || input.authoritative !== true || existing.remoteId) {
          fail(422, 'NON_EXECUTION_EVIDENCE_REQUIRED', 'Retry requires authoritative evidence that the original request did not execute.');
        }
      }
      if (status === 'verified') {
        if (!receipt.remoteId || !receipt.receiptRef || input.packageHash !== binding.packageHash ||
          input.accountId !== binding.target.accountId || input.visibility !== binding.target.visibility) {
          fail(422, 'READBACK_BINDING_MISMATCH', 'Readback must identify the exact remote object, account, package, and expected visibility.');
        }
        const publishedAt = instant(input.publishedAt, 'publishedAt');
        const verifiedAt = instant(input.verifiedAt, 'verifiedAt');
        if (publishedAt < row.consumed_at - 60_000 || verifiedAt < publishedAt || verifiedAt > at + 60_000) {
          fail(422, 'INVALID_READBACK_TIME', 'Readback times are inconsistent with the recorded dispatch.');
        }
        const method = input.verificationMethod ?? (mode === 'fixture' ? 'fixture_readback' : null);
        if (!VERIFIERS.includes(method) || mode === 'real' && method === 'fixture_readback' || mode === 'real' && input.dataMode !== 'real') {
          fail(422, 'READBACK_METHOD_REQUIRED', 'Real readback requires an approved actual verification method.');
        }
        Object.assign(receipt, { packageHash: binding.packageHash, accountId: binding.target.accountId, visibility: binding.target.visibility,
          publishedAt, verifiedAt, verificationMethod: method, url: evidenceUrl(input.url, mode, binding.target.visibility), verifiedBy: ctx.actorId });
      }
      const payload = json(receipt);
      if (row.state === status && row.settlement === payload) return effectView(row);
      if (DONE.includes(row.state)) fail(409, 'EFFECT_ALREADY_RESOLVED', 'A terminal effect cannot be replaced by a different receipt.');
      if (mode === 'real') {
        durable(ctx, `receipt:${operationKey}:${row.attempt}:${hash([status, receipt])}`, 'effect_receipt',
          { operationKey, attempt: row.attempt, state: status, settlement: payload }, at);
      }
      run('UPDATE effects SET state = ?, settlement = ? WHERE operation_key = ?', status, payload, operationKey);
      if (status === 'verified') {
        updatePlan(task, row.channel_id, { disposition: receipt.visibility === 'public' ? 'public_verified' : 'restricted_verified',
          operationKey, receiptRef: receipt.receiptRef, publishedAt: receipt.publishedAt, dataMode: mode });
        if (receipt.visibility === 'public') scheduleObservations(task, operationKey, row.attempt, receipt, ctx);
      } else if (status === 'unknown' || status === 'accepted') {
        updatePlan(task, row.channel_id, { disposition: status === 'unknown' ? 'needs_reconcile' : 'accepted', operationKey });
        addStep(task, { kind: 'reconcile', key: `reconcile:${operationKey}:${row.attempt}`, input: { operationKey }, dueAt: at + 1000 }, at);
      }
      if (DONE.includes(status) && binding.stepId !== null) {
        run("UPDATE steps SET state = ? WHERE id = ? AND state = 'needs_reconcile'", status === 'verified' ? 'succeeded' : 'failed', binding.stepId);
      }
      if (DONE.includes(status)) {
        run("UPDATE steps SET state = 'succeeded' WHERE task_id = ? AND step_key = ? AND state IN ('queued','needs_reconcile')",
          task.id, `reconcile:${operationKey}:${row.attempt}`);
      }
      if (status === 'not_executed' || status === 'rejected') geo.releaseForOperation(operationKey, row.attempt, at);
      pushEvent(ctx, `effect.${status}`, { operationKey, attempt: row.attempt, remoteId: receipt.remoteId ?? null, receiptRef: receipt.receiptRef ?? null }, task);
      projectTask(task, ctx);
      return getEffect(operationKey, ctx);
    });
  }

  function scheduleObservations(task, operationKey, attempt, receipt, ctx) {
    const mandate = mandateRow(task.mandate_id, ctx);
    for (const day of [1, 3, 7]) {
      const dueAt = receipt.publishedAt + day * DAY;
      const id = `observation-${hash([operationKey, day]).slice(0, 36)}`;
      const geoHold = geo.align(operationKey, attempt, day, dueAt, mandate);
      const stopped = ['revoked', 'expired'].includes(mandate.state) || task.state === 'cancelled' ||
        mandate.expires_at !== null && mandate.expires_at <= dueAt;
      const data = { basePublicationAt: receipt.publishedAt, taskId: task.id, operationKey,
        targetUrl: receipt.url, expectedPackageHash: receipt.packageHash,
        geoCommitmentId: geoHold?.id ?? null, expectedQuestionSetRef: geoHold?.question_ref ?? null };
      const inserted = run('INSERT OR IGNORE INTO observations(id, scope, task_id, operation_key, epoch_day, due_at, state, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, ctx.scope, task.id, operationKey, day, dueAt, stopped ? 'cancelled' : 'scheduled', json(data));
      if (Number(inserted.changes) > 0 && !stopped) {
        addStep(task, { kind: 'observe', key: `observe:${operationKey}:${day}`, input: { observationId: id, operationKey, day, targetUrl: receipt.url }, dueAt }, dueAt);
      }
    }
  }

  function recordObservation(input, auth) {
    const ctx = identity(auth, ['worker', 'system']);
    object(input, 'observation');
    return transaction(() => {
      const observationId = identifier(input.observationId ?? input.id, 'observationId');
      const row = get('SELECT * FROM observations WHERE scope = ? AND id = ?', ctx.scope, observationId);
      if (!row) fail(404, 'OBSERVATION_NOT_FOUND', 'This observation is not scheduled in the project.');
      const task = taskRow(row.task_id, ctx);
      const at = now();
      if (at < row.due_at) fail(409, 'OBSERVATION_NOT_DUE', 'A retest may run from the actual public time plus its prescribed observation window.');
      const stepId = input.stepId ?? (input.observationId === undefined ? undefined : input.id);
      if (mode === 'real' || stepId !== undefined) {
        const step = assertLease(rowStep(stepId, ctx), input.epoch, ctx, at);
        if (step.kind !== 'observe' || step.task_id !== task.id || parse(step.input).observationId !== observationId) {
          fail(403, 'WORK_BINDING_DENIED', 'This observation must be recorded under its own live work lease.');
        }
      }
      const state = input.status ?? 'verified';
      if (!['verified', 'sample_insufficient', 'unavailable'].includes(state)) fail(422, 'INVALID_OBSERVATION_STATUS', 'Unsupported observation outcome.');
      const actual = instant(input.observedAt ?? at, 'observedAt');
      if (actual < row.due_at || actual > at + 60_000) fail(422, 'INVALID_OBSERVATION_TIME', 'Observation time is outside its real window.');
      const denominator = integer(input.denominator ?? 0, 'denominator', 0, 100_000);
      const paired = integer(input.paired ?? denominator, 'paired', 0, denominator);
      const citations = integer(input.citations ?? 0, 'citations', 0, paired);
      if (mode === 'real' && input.dataMode !== 'real') fail(422, 'OBSERVATION_DATA_MODE', 'Fixture observation cannot enter a real ledger.');
      if (mode === 'real' && state === 'verified' && (denominator === 0 || paired !== denominator)) {
        fail(422, 'OBSERVATION_COVERAGE_REQUIRED', 'A verified observation needs a complete nonempty set of paired samples.');
      }
      const original = parse(row.data);
      const payload = { ...original, evidenceRef: string(input.evidenceRef, 'evidenceRef', 600),
        questionSetRef: string(input.questionSetRef ?? (mode === 'fixture' ? 'fixture-questions' : undefined), 'questionSetRef', 500),
        observedAt: actual, denominator, paired, citations, failed: denominator - paired,
        rate: paired > 0 && state === 'verified' ? citations / paired : null, recordedBy: ctx.actorId };
      if (row.state !== 'scheduled') {
        if (row.state === state && row.data === json(payload)) return { ...payload, id: observationId, state, dataMode: mode };
        fail(409, 'OBSERVATION_ALREADY_RECORDED', 'This window already has a different observation receipt.');
      }
      if (original.expectedQuestionSetRef !== null && original.expectedQuestionSetRef !== undefined &&
        payload.questionSetRef !== original.expectedQuestionSetRef) {
        fail(409, 'GEO_QUESTION_SCOPE_CHANGED', 'This observation must use its original reserved question set.');
      }
      if (mode === 'real') {
        durable(ctx, `observation:${observationId}`, 'observation_receipt',
          { id: observationId, state, data: json(payload), geoCommitmentId: original.geoCommitmentId ?? null }, at);
      }
      run('UPDATE observations SET state = ?, data = ? WHERE id = ?', state, json(payload), observationId);
      geo.releaseRound(original.geoCommitmentId, at);
      pushEvent(ctx, 'observation.recorded', { observationId, day: row.epoch_day, state, denominator, paired, citations, evidenceRef: payload.evidenceRef }, task);
      projectTask(task, ctx);
      return { ...payload, id: observationId, state, dataMode: mode };
    });
  }

  function costView(row) {
    return { ...parse(row.data), id: row.id, costId: row.id, taskId: row.task_id, mandateId: row.mandate_id,
      stepId: row.step_id, state: row.state, status: row.state, currency: row.currency, reservedMinor: row.reserved,
      actualMinor: row.actual, actual: row.actual, windowStart: row.window_start, dataMode: mode };
  }

  function budgetView(mandate, at, asOf = at) {
    const { start: windowStart, end: windowEnd, ...budget } = budgetWindow(mandate, at);
    const paid = all(`SELECT * FROM costs WHERE mandate_id = ? AND state = 'settled'
      AND window_start >= ? AND window_start < ? AND COALESCE(json_extract(data, '$.settledAt'), json_extract(data, '$.reservedAt'), 0) <= ?`,
    mandate.id, windowStart, windowEnd, asOf);
    const holds = all(`SELECT * FROM costs WHERE mandate_id = ? AND
      COALESCE(json_extract(data, '$.reservedAt'), 0) <= ? AND (state IN ('reserved','dispatched','unknown')
        OR state IN ('settled','released') AND json_extract(data, '$.settledAt') > ?)`, mandate.id, asOf, asOf);
    const observations = geo.forWindow(mandate, windowStart, windowEnd, asOf);
    const currencies = new Set([...paid, ...holds, ...observations].map(item => item.currency));
    if ([...currencies].some(currency => currency !== budget.currency)) {
      return { ...budget, windowStart, windowEnd, spentMinor: null, reservedMinor: null, unknownMinor: null,
        geoReservedMinor: null, availableMinor: 0, currencyConflict: true };
    }
    const spentMinor = paid.reduce((total, item) => total + item.actual, 0);
    const geoReservedMinor = observations.reduce((total, item) => total + item.remaining, 0);
    const reservedMinor = holds.reduce((total, item) => total + item.reserved, geoReservedMinor);
    const unknownMinor = holds.filter(item => item.state === 'unknown').reduce((total, item) => total + item.reserved, 0);
    return { ...budget, windowStart, windowEnd, spentMinor, reservedMinor, unknownMinor, geoReservedMinor,
      availableMinor: Math.max(0, budget.limitMinor - spentMinor - reservedMinor),
      currencyConflict: false };
  }

  function getBudget(id, auth) {
    const ctx = identity(auth, READ);
    return budgetView(mandateRow(id, ctx), now());
  }

  function listCosts(auth, mandateId) {
    const ctx = identity(auth, READ);
    if (mandateId) return all('SELECT * FROM costs WHERE scope = ? AND mandate_id = ? ORDER BY rowid',
      ctx.scope, identifier(mandateId, 'mandateId')).map(costView);
    return all('SELECT * FROM costs WHERE scope = ? ORDER BY rowid DESC LIMIT 500', ctx.scope).map(costView);
  }

  function reserveCost(input, auth, admitProvider) {
    const ctx = identity(auth, WORK);
    object(input, 'cost reservation');
    return transaction(() => {
      const at = now();
      const step = assertLease(rowStep(input.id ?? input.stepId, ctx), input.epoch, ctx, at);
      const task = taskRow(step.task_id, ctx);
      const mandate = requireLiveTask(task, ctx, step.kind === 'observe' ? 'observe' : 'prepare', at);
      if (mandate.version !== task.mandate_version) fail(409, 'COST_AUTHORIZATION_STALE', 'The task was accepted under another mandate revision.');
      const requestKey = key(input.requestKey ?? input.idempotencyKey);
      const id = `cost-${hash([ctx.scope, task.id, step.id, requestKey]).slice(0, 42)}`;
      const amount = integer(input.reservedMinor, 'reservedMinor', 1, 1_000_000_000);
      const budget = budgetView(mandate, at);
      if (budget.currency !== input.currency) fail(422, 'BUDGET_CURRENCY_MISMATCH', 'The reservation must use the authorized currency.');
      const requestHash = hash([amount, input.currency, input.provider ?? null, requestKey, input.requestHash ?? null]);
      const existing = get('SELECT * FROM costs WHERE id = ?', id);
      if (existing && parse(existing.data).requestHash !== requestHash) fail(409, 'COST_IDEMPOTENCY_CONFLICT', 'The cost request key already identifies different work.');
      let providerTokenHold;
      if (admitProvider && (!existing || existing.state === 'reserved' || existing.state === 'released' && !parse(existing.data).dispatchedAt)) {
        const rowsForTasks = ids => {
          ids.forEach(taskId => taskRow(taskId, ctx));
          return all(`SELECT * FROM costs WHERE scope = ? AND task_id IN (${ids.map(() => '?').join(',')})`, ctx.scope, ...ids).map(costView);
        };
        providerTokenHold = admitProvider({ id, taskId: task.id, rowsForTasks });
        if (existing?.state === 'reserved' && providerTokenHold) {
          run('UPDATE costs SET data = ? WHERE id = ?', json({ ...parse(existing.data), providerTokenHold }), id);
        }
      }
      if (existing && (existing.state !== 'released' || parse(existing.data).dispatchedAt)) return costView(existing);
      if (budget.currencyConflict) fail(409, 'BUDGET_EXCEEDED', 'Available authorization does not cover this reservation.', budget);
      const geoCommitmentId = geo.reservedForStep(mandate, step, amount, budget, at);
      if (!geoCommitmentId && amount > budget.availableMinor) fail(409, 'BUDGET_EXCEEDED', 'Available authorization does not cover this reservation.', budget);
      const provider = string(input.provider, 'provider', 160, true);
      const nativeOrderRef = provider === 'native_signed_order' ? sha(input.requestHash, 'native signed order evidence hash') : null;
      const data = { requestKey, requestHash, provider, nativeOrderRef, geoCommitmentId, epoch: step.epoch,
        ...(providerTokenHold ? { providerTokenHold } : {}),
        reservedBy: ctx.actorId, reservedRole: ctx.role, reservedAt: at };
      run(`INSERT INTO costs(id, scope, mandate_id, task_id, step_id, state, reserved, actual, currency, window_start, data)
        VALUES (?, ?, ?, ?, ?, 'reserved', ?, NULL, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET state = 'reserved', window_start = excluded.window_start, data = excluded.data`,
      id, ctx.scope, mandate.id, task.id, step.id, amount, input.currency, budget.windowStart, json(data));
      pushEvent(ctx, 'cost.reserved', { costId: id, stepId: step.id, epoch: step.epoch, reservedMinor: amount, currency: input.currency }, task);
      return costView(get('SELECT * FROM costs WHERE id = ?', id));
    });
  }

  function insertCost(row) {
    const stepId = row.step_id !== null && get('SELECT id FROM steps WHERE id = ?', row.step_id) ? row.step_id : null;
    run(`INSERT OR IGNORE INTO costs(id, scope, mandate_id, task_id, step_id, state, reserved, actual, currency, window_start, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.scope, row.mandate_id, row.task_id, stepId, row.state, row.reserved, row.actual, row.currency, row.window_start, row.data);
  }

  function markCostDispatched(input, auth) {
    const ctx = identity(auth, WORK);
    object(input, 'provider dispatch');
    return transaction(() => {
      const at = now();
      const row = get('SELECT * FROM costs WHERE scope = ? AND id = ?', ctx.scope, identifier(input.costId, 'costId'));
      if (!row) fail(404, 'COST_NOT_FOUND', 'No reservation matches this dispatch.');
      if (row.state === 'dispatched' || row.state === 'unknown' || row.state === 'settled') return { ...costView(row), execute: false };
      if (row.state !== 'reserved') fail(409, 'COST_NOT_RESERVED', 'This reservation is no longer eligible to dispatch.');
      const step = assertLease(rowStep(input.id ?? input.stepId, ctx), input.epoch, ctx, at);
      const task = taskRow(step.task_id, ctx);
      const mandate = requireLiveTask(task, ctx, step.kind === 'observe' ? 'observe' : 'prepare', at);
      assertNoPendingRevocation(ctx);
      const data = parse(row.data);
      if (row.step_id !== step.id || row.mandate_id !== mandate.id || data.epoch !== step.epoch || data.reservedBy !== ctx.actorId ||
        task.mandate_version !== mandate.version) {
        fail(409, 'COST_AUTHORIZATION_STALE', 'This reservation cannot be dispatched by an old lease or mandate revision.');
      }
      const availability = budgetView(mandate, at);
      if (availability.currencyConflict || availability.spentMinor + availability.reservedMinor > availability.limitMinor) {
        fail(409, 'BUDGET_EXCEEDED', 'Actual usage no longer fits the authorized budget.', availability);
      }
      const journalKey = `cost:${row.id}`;
      const prior = readJournal(ctx, journalKey);
      if (prior) {
        if (prior.kind !== 'cost' || parse(prior.data.data).requestHash !== data.requestHash) fail(409, 'COST_JOURNAL_CONFLICT', 'This cost intent conflicts with the independent ledger.');
        run("UPDATE costs SET state = 'unknown', data = ? WHERE id = ?", prior.data.data, row.id);
        projectTask(task, ctx);
        return { ...costView(get('SELECT * FROM costs WHERE id = ?', row.id)), execute: false };
      }
      const next = { ...row, state: 'dispatched', data: json({ ...data, dispatchedAt: at, grantRevision: mandate.version,
        revocationEpoch: mandate.revocation_epoch }) };
      durable(ctx, journalKey, 'cost', next, at);
      run("UPDATE costs SET state = 'dispatched', data = ? WHERE id = ?", next.data, row.id);
      pushEvent(ctx, 'cost.dispatch_recorded', { costId: row.id, reservedMinor: row.reserved, currency: row.currency }, task);
      return { ...costView(next), execute: true };
    });
  }

  function settleCost(input, auth) {
    const ctx = identity(auth, WORK);
    object(input, 'cost settlement');
    return transaction(() => {
      const row = get('SELECT * FROM costs WHERE scope = ? AND id = ?', ctx.scope, identifier(input.costId, 'costId'));
      if (!row) fail(404, 'COST_NOT_FOUND', 'No reservation matches this settlement.');
      const data = parse(row.data);
      if (data.reservedBy !== ctx.actorId && ctx.role !== 'system') {
        const step = row.step_id && get('SELECT * FROM steps WHERE id = ?', row.step_id);
        if (!step || step.state !== 'leased' || step.lease_until <= now() || step.holder !== ctx.actorId || data.reservedRole !== ctx.role) {
          fail(403, 'COST_OWNER_REQUIRED', 'Only the reservation owner or authorized reconciliation service may settle it.');
        }
      }
      const task = taskRow(row.task_id, ctx);
      const state = input.status;
      if (!['settled', 'unknown', 'not_dispatched'].includes(state)) fail(422, 'INVALID_COST_STATUS', 'Cost state is outside the settlement contract.');
      if (state === 'unknown' && !['dispatched', 'unknown'].includes(row.state)) fail(409, 'COST_NOT_DISPATCHED', 'An unstarted request cannot have unknown provider usage.');
      if (state === 'settled' && !['dispatched', 'unknown', 'settled'].includes(row.state)) fail(409, 'COST_NOT_DISPATCHED', 'A settled cost must have a recognized dispatch.');
      let actual = null;
      if (state === 'settled') actual = integer(input.actualMinor, 'actualMinor', 0, 1_000_000_000);
      const providerRef = string(input.providerRef ?? data.providerRef, 'providerRef', 500, true);
      const evidenceRef = string(input.evidenceRef ?? data.evidenceRef, 'evidenceRef', 500, true);
      if (state === 'settled' && (!providerRef || !evidenceRef)) fail(422, 'USAGE_EVIDENCE_REQUIRED', 'Settlement requires a provider ID and actual-use evidence.');
      if (state === 'not_dispatched' && ['dispatched', 'unknown'].includes(row.state) && (input.authoritative !== true || !evidenceRef)) {
        fail(422, 'NON_EXECUTION_EVIDENCE_REQUIRED', 'A dispatched hold can only clear with authoritative non-execution evidence.');
      }
      if (providerRef && state === 'settled' && get(`SELECT id FROM costs WHERE scope = ? AND id != ? AND state = 'settled'
        AND json_extract(data, '$.providerRef') = ? AND json_extract(data, '$.provider') IS ?`, ctx.scope, row.id, providerRef, data.provider)) {
        fail(409, 'DUPLICATE_USAGE_RECEIPT', 'Provider usage evidence has been used by another reservation.');
      }
      const nextState = state === 'not_dispatched' ? 'released' : state;
      const settledAt = ['settled', 'released'].includes(nextState) ? data.settledAt ?? now() : null;
      const payload = json({ ...data, providerRef, evidenceRef, settledAt });
      if (nextState === row.state && actual === row.actual && payload === row.data) return costView(row);
      if (row.state === 'settled' || row.state === 'released') fail(409, 'COST_ALREADY_RESOLVED', 'A terminal cost cannot be overwritten.');
      if (mode === 'real' && row.state !== 'reserved') {
        durable(ctx, `costreceipt:${row.id}:${hash([nextState, actual, payload])}`, 'cost_receipt',
          { id: row.id, state: nextState, actual, data: payload });
      }
      run('UPDATE costs SET state = ?, actual = ?, data = ? WHERE id = ?', nextState, actual, payload, row.id);
      const next = get('SELECT * FROM costs WHERE id = ?', row.id);
      pushEvent(ctx, `cost.${nextState}`, { costId: row.id, reservedMinor: row.reserved, actualMinor: actual, currency: row.currency }, task);
      if (actual !== null && actual > row.reserved) raiseException({ mandateId: task.mandate_id, taskId: task.id,
        rootCause: 'provider-cost-exceeded', severity: 'urgent', actionable: true, summary: 'Provider actual usage exceeded its recorded reservation.' }, ctx);
      if (next.state === 'settled' || next.state === 'released') {
        const unknown = get("SELECT id FROM costs WHERE step_id IS ? AND state IN ('unknown','dispatched') LIMIT 1", next.step_id);
        const effect = get(`SELECT operation_key FROM effects WHERE task_id = ? AND state IN ('unknown','in_flight','accepted') AND
          json_extract(binding, '$.stepId') IS ? LIMIT 1`, task.id, next.step_id);
        if (next.step_id !== null && !unknown && !effect) {
          run("UPDATE steps SET state = 'waiting_input' WHERE id = ? AND state = 'needs_reconcile'", next.step_id);
        }
      }
      projectTask(task, ctx);
      return costView(next);
    });
  }

  function restoreEffectEntry(ctx, entry) {
    const { data } = entry;
    if (entry.kind === 'effect') {
      const prior = get('SELECT * FROM effects WHERE scope = ? AND operation_key = ?', ctx.scope, data.operation_key);
      if (prior && prior.attempt >= data.attempt) return;
      const task = taskRow(data.task_id, ctx);
      if (prior) geo.releaseForOperation(prior.operation_key, prior.attempt, entry.at);
      insertEffect({ ...data, state: 'unknown' });
      geo.insert(parse(data.binding).geoFunding ?? []);
      addStep(task, { kind: 'reconcile', key: `reconcile:${data.operation_key}:${data.attempt}`, input: { operationKey: data.operation_key } });
      return;
    }
    if (entry.kind === 'effect_receipt') {
      const row = get('SELECT * FROM effects WHERE scope = ? AND operation_key = ?', ctx.scope, data.operationKey);
      if (!row || row.attempt !== data.attempt || DONE.includes(row.state)) return;
      run('UPDATE effects SET state = ?, settlement = ? WHERE operation_key = ?', data.state, data.settlement, data.operationKey);
      if (data.state === 'verified') {
        const task = taskRow(row.task_id, ctx);
        const receipt = parse(data.settlement);
        updatePlan(task, row.channel_id, { disposition: receipt.visibility === 'public' ? 'public_verified' : 'restricted_verified',
          operationKey: row.operation_key, receiptRef: receipt.receiptRef, publishedAt: receipt.publishedAt, dataMode: mode });
        if (receipt.visibility === 'public') scheduleObservations(task, row.operation_key, row.attempt, receipt, ctx);
      }
      if (data.state === 'not_executed' || data.state === 'rejected') geo.releaseForOperation(row.operation_key, row.attempt, entry.at);
      return;
    }
    if (entry.kind === 'cost') {
      insertCost({ ...data, state: 'unknown' });
      run("UPDATE costs SET state = 'unknown', data = ? WHERE id = ? AND state = 'reserved'", data.data, data.id);
      return;
    }
    if (entry.kind === 'cost_receipt') {
      run("UPDATE costs SET state = ?, actual = ?, data = ? WHERE scope = ? AND id = ? AND state IN ('reserved','dispatched','unknown')",
        data.state, data.actual, data.data, ctx.scope, data.id);
      return;
    }
    if (entry.kind === 'observation_receipt') {
      run("UPDATE observations SET state = ?, data = ? WHERE id = ? AND scope = ? AND state = 'scheduled'",
        data.state, data.data, data.id, ctx.scope);
      geo.releaseRound(data.geoCommitmentId, entry.at);
      return;
    }
    fail(503, 'JOURNAL_ENTRY_UNSUPPORTED', 'The independent journal includes an unsupported event.');
  }

  return {
    recordCapability, listCapabilities, recordArtifact, recordReview, confirmTarget, recordOwnerSubmission, issuePermit,
    consumePermit, recordEffect, getEffect, recordObservation, getBudget, listCosts, reserveCost, markCostDispatched,
    settleCost, restoreEffectEntry, effectView, budgetView,
    releaseGeoTask: geo.releaseForTask, releaseGeoMandate: geo.releaseForMandate,
  };
}
