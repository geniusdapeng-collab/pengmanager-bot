import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CHANNEL_IDS, createBotCore, decideOpportunity } from '../src/bot/core.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-27T00:00:00Z');
const owner = { workspaceId: 'workspace', projectId: 'pengmanager', actorId: 'owner-1', role: 'owner' };
const system = { ...owner, actorId: 'clock', role: 'system' };
const worker = { ...owner, actorId: 'production', role: 'worker' };
const reviewer = { ...owner, actorId: 'independent', role: 'reviewer' };
const connector = { ...owner, actorId: 'owned-site-connector', role: 'connector' };
const site = { channelId: 'official-site', accountId: 'site-author', destination: 'articles', form: 'article',
  action: 'publish', visibility: 'public' };
const external = { ...site, channelId: 'zhihu', accountId: 'zhihu-author', destination: 'answers', form: 'answer' };
const hashes = { package: '1'.repeat(64), edited: '2'.repeat(64), review: '3'.repeat(64), editedReview: '4'.repeat(64) };

const rejects = (fn, code) => assert.throws(fn, error => error.code === code);
const safeWrite = { official: true, safeDedup: true, businessReadback: true,
  policyRef: 'test-policy-r1', evidenceRef: 'test-connector-proof', expiresAt: NOW + 30 * DAY };

function instance(t, options = {}) {
  let current = NOW;
  const core = createBotCore({ ...options, clock: () => current });
  t.after(() => core.close());
  return { core, time: value => { current = value; } };
}

function allow(core, config = {}) {
  return core.createMandate({ objective: 'Produce one checked tutorial', allowedActions: [{ ...site, maxDaily: 4 }],
    requiredOutcomes: [{ id: 'website-article', channelId: site.channelId, outcome: 'public' }],
    budget: { currency: 'CNY', limitMinor: 1000 },
    optionalTargets: ['zhihu'], sources: ['upstream'], idempotencyKey: 'mandate-0001', ...config }, owner);
}

function task(core, mandate, fields = {}) {
  return core.createTask({ mandateId: mandate.id, title: 'Checked output', idempotencyKey: 'task-0001', ...fields }, owner);
}

function fixtureMaterial(core, work, target = site) {
  core.recordArtifact({ ...target, taskId: work.id, packageHash: hashes.package, artifactRef: 'fixture-artifact' }, worker);
  core.recordReview({ taskId: work.id, channelId: target.channelId, packageHash: hashes.package,
    reportHash: hashes.review, verified: true, outcome: 'passed' }, reviewer);
}

function permit(core, work, fields = {}) {
  return core.issuePermit({ ...site, taskId: work.id, packageHash: hashes.package, expectedPreviousReleaseId: null,
    idempotencyKey: 'permit-0001', ...fields }, system);
}

function register(core, target = site, fields = {}) {
  return core.recordCapability({ ...target, ...safeWrite, idempotencyKey: `capability-${target.channelId}`, ...fields }, owner);
}

function fixtureVerified(issued, fields = {}) {
  return { operationKey: issued.operationKey, status: 'verified', remoteId: 'result-object', receiptRef: 'actual-readback-fixture',
    packageHash: hashes.package, accountId: site.accountId, visibility: 'public', publishedAt: NOW,
    verifiedAt: NOW, url: 'https://profile.example/articles/test', ...fields };
}

test('mandate preview and exact state mutations require trusted roles and stay scoped', t => {
  const { core } = instance(t);
  const input = { objective: 'Research a verified topic', sources: ['upstream'], idempotencyKey: 'grant-0001' };
  assert.equal(core.previewMandate(input, owner).draft, true);
  assert.equal(core.listMandates(owner).length, 0);
  rejects(() => core.createMandate(input, worker), 'ROLE_DENIED');
  const result = core.createMandate(input, owner);
  assert.deepEqual(core.createMandate(input, owner), result);
  rejects(() => core.createMandate({ ...input, objective: 'Other activity' }, owner), 'IDEMPOTENCY_CONFLICT');
  rejects(() => core.getMandate(result.id, { ...owner, workspaceId: 'other' }), 'MANDATE_NOT_FOUND');
  rejects(() => core.renewMandate(result.id, { idempotencyKey: 'renew-0001' }, owner), 'PRECONDITION_REQUIRED');
  rejects(() => core.revokeMandate(result.id, { expectedRevision: 0, idempotencyKey: 'stop-0001' }, owner), 'PRECONDITION_FAILED');
  rejects(() => core.revokeMandate(result.id, { expectedRevision: 1, idempotencyKey: 'stop-0001' }, { ...owner, actorId: 'other-owner' }), 'OWNER_REQUIRED');
  assert.equal(core.renewMandate(result.id, { expectedRevision: 1, budget: { limitMinor: 200 }, idempotencyKey: 'renew-0001' }, owner).revision, 2);
});

test('signal ingestion deduplicates source and syndicated facts before creating work', t => {
  const { core } = instance(t);
  const mandate = allow(core, { sources: ['upstream', 'other'] });
  const source = { sourceId: 'upstream', eventKey: 'a-1', factKey: 'announced-policy-v2', payloadRef: 'source:a',
    occurredAt: NOW, cursor: 'cursor-a' };
  const first = core.ingestEvent(source, system);
  const repeated = core.ingestEvent(source, system);
  assert.equal(repeated.duplicate, true);
  assert.equal(first.tasks[0].id, repeated.tasks[0].id);
  assert.equal(core.ingestEvent({ ...source, sourceId: 'other', eventKey: 'other-2', payloadRef: 'source:b' }, worker).tasks[0].id, first.tasks[0].id);
  rejects(() => core.ingestEvent({ ...source, payloadRef: 'replaced' }, system), 'SOURCE_EVENT_CONFLICT');
  rejects(() => core.ingestEvent({ ...source, sourceId: 'closed' }, system), 'SOURCE_NOT_AUTHORIZED');
  const work = core.getTask(first.tasks[0].id, owner);
  assert.equal(work.mandateId, mandate.id);
  assert.equal(core.listTasks({ mandateId: mandate.id }, owner).length, 1);
  assert.deepEqual(work.channels.map(row => row.channelId), [...CHANNEL_IDS]);
  assert.equal(work.channels.find(row => row.channelId === 'maimai').disposition, 'archived');
  assert.equal(work.requiredOutcomes.length, 1);
});

test('persisted scheduler coalesces missed triggers and materializes the weekly outbox after restart', t => {
  const folder = mkdtempSync(join(tmpdir(), 'pengmanager-bot-core-'));
  t.after(() => rmSync(folder, { recursive: true }));
  const dbPath = join(folder, 'bot.sqlite');
  const setup = createBotCore({ dbPath, clock: () => NOW });
  const mandate = allow(setup, { schedule: { intervalMs: DAY, startsAt: NOW, reportStartsAt: NOW + 7 * DAY } });
  const first = setup.tick(system);
  assert.equal(first.tasks.length, 1);
  assert.equal(setup.tick(system).tasks.length, 0);
  setup.close();

  const restarted = createBotCore({ dbPath, clock: () => NOW + 7 * DAY });
  try {
    const next = restarted.tick(system);
    assert.equal(next.tasks.length, 1);
    assert.equal(next.tasks[0].input.missedOccurrences, 6);
    assert.equal(next.reports, 1);
    assert.equal(restarted.tick(system).reports, 0);
    assert.equal(restarted.outcomes(mandate.id, owner).reports.length, 1);
    assert.equal(restarted.listNotifications(owner).length, 1);
    const [notice] = restarted.listNotifications(owner);
    const delivered = restarted.ackNotification({ id: notice.id, status: 'delivered', receiptRef: 'fixture-delivery' }, system);
    assert.equal(delivered.state, 'delivered');
    assert.equal(restarted.ackNotification(notice.id, {}, owner).state, 'read');
  } finally {
    restarted.close();
  }
});

test('role-bound leasing preserves stable checkpoint, fences late reports, and atomically adds dependent work', t => {
  const { core, time } = instance(t);
  const work = task(core, allow(core, { requiredOutcomes: [] }));
  rejects(() => core.claim({ kinds: ['publish'] }, worker), 'WORK_KIND_DENIED');
  const first = core.claim({ kinds: ['discover'], leaseMs: 1000 }, worker);
  assert.equal(first.taskId, work.id);
  const other = { ...worker, actorId: 'another-worker' };
  assert.equal(core.claim({ kinds: ['discover'] }, other), null);
  core.checkpoint({ id: first.id, epoch: first.epoch, output: { nativeJobId: 'durable-original-job' } }, worker);
  time(NOW + 1001);
  const second = core.claim({ kinds: ['discover'], leaseMs: 1000 }, other);
  assert.equal(second.id, first.id);
  assert.equal(second.epoch, first.epoch + 1);
  assert.deepEqual(second.output, { nativeJobId: 'durable-original-job' });
  rejects(() => core.report({ id: first.id, epoch: first.epoch, status: 'succeeded' }, worker), 'STALE_LEASE');
  const reported = { id: second.id, epoch: second.epoch, status: 'succeeded', output: second.output,
    followups: [{ key: 'prepare-site', kind: 'prepare', input: { channelId: 'official-site' } }] };
  core.report(reported, other);
  core.report(reported, other);
  const latest = core.getTask(work.id, owner);
  assert.equal(latest.steps.length, 2);
  assert.equal(latest.steps[1].input.channelId, 'official-site');
  const events = core.listEvents(work.id, { after: 0 }, owner);
  assert.equal(events.filter(event => event.type === 'worker.late_report').length, 1);
  assert.equal(core.listEvents(work.id, { after: events.at(-1).seq }, owner).length, 0);
});

test('plan retains commitments while distrusting proposed automation and archived destinations', t => {
  const { core } = instance(t);
  register(core);
  const work = task(core, allow(core));
  const claim = core.claim({ kinds: ['discover'] }, worker);
  const decision = decideOpportunity({ novelty: 55, readerValue: 65, urgency: 40, availableMinor: 50, estimatedCostMinor: 12,
    evidenceRefs: ['source:001'], existingTopicId: 'existing-article' });
  assert.equal(decision.action, 'update');
  assert.equal(decideOpportunity({ novelty: 80, duplicate: true }).action, 'ignore');
  assert.equal(decideOpportunity({ novelty: 80 }).action, 'research');
  core.report({ ...claim, status: 'succeeded', decision, channelPlan: [
    { ...site, disposition: 'auto_publish', reason: 'Target ready', machinePublish: true },
    { ...external, disposition: 'auto_publish', reason: 'Model calls it ready', machinePublish: true, required: true },
    { channelId: 'maimai', disposition: 'auto_publish', reason: 'Ignored archive', machinePublish: true },
  ] }, worker);
  const latest = core.getTask(work.id, owner);
  assert.equal(latest.channels.length, 28);
  assert.equal(latest.channels.find(row => row.channelId === 'official-site').machinePublish, true);
  assert.equal(latest.channels.find(row => row.channelId === 'zhihu').disposition, 'prepare_only');
  assert.equal(latest.channels.find(row => row.channelId === 'zhihu').required, false);
  assert.equal(latest.channels.find(row => row.channelId === 'maimai').disposition, 'archived');
  assert.equal(latest.state, 'partial');
});

test('expense reservation is atomic, unknown commitments carry into future periods, and stale work does not continue', t => {
  const { core, time } = instance(t);
  const mandate = allow(core, { budget: { currency: 'CNY', limitMinor: 1000, windowMs: 1000 } });
  const work = task(core, mandate, { kind: 'prepare' });
  const lease = core.claim({ kinds: ['prepare'], leaseMs: 200 }, worker);
  const input = { id: lease.id, epoch: lease.epoch, requestKey: 'provider-001', currency: 'CNY', reservedMinor: 750 };
  const cost = core.reserveCost(input, worker);
  assert.equal(core.reserveCost(input, worker).id, cost.id);
  rejects(() => core.reserveCost({ ...input, reservedMinor: 751 }, worker), 'COST_IDEMPOTENCY_CONFLICT');
  rejects(() => core.reserveCost({ ...input, requestKey: 'provider-002', reservedMinor: 251 }, worker), 'BUDGET_EXCEEDED');
  assert.equal(core.markCostDispatched({ costId: cost.id, id: lease.id, epoch: lease.epoch }, worker).execute, true);
  assert.equal(core.markCostDispatched({ costId: cost.id, id: lease.id, epoch: lease.epoch }, worker).execute, false);
  time(NOW + 101);
  const reported = core.report({ id: lease.id, epoch: lease.epoch, status: 'succeeded',
    followups: [{ key: 'review-site', kind: 'review', input: { channelId: 'official-site' } }] }, worker);
  assert.equal(reported.state, 'needs_reconcile');
  assert.equal(core.getTask(work.id, owner).steps.length, 1);
  time(NOW + 1050);
  assert.equal(core.getBudget(mandate.id, owner).unknownMinor, 750);
  assert.equal(core.getBudget(mandate.id, owner).availableMinor, 250);
  rejects(() => core.settleCost({ costId: cost.id, status: 'not_dispatched' }, worker), 'NON_EXECUTION_EVIDENCE_REQUIRED');
  core.settleCost({ costId: cost.id, status: 'settled', actualMinor: 600, providerRef: 'provider-actual-1', evidenceRef: 'provider-cost-proof' }, worker);
  assert.equal(core.getBudget(mandate.id, owner).unknownMinor, 0);
  assert.equal(core.getTask(work.id, owner).steps[0].state, 'waiting_input');
});

test('exact publish permit requires the independent current package, then consumes once across withdrawal', t => {
  const { core } = instance(t);
  register(core);
  const mandate = allow(core);
  const work = task(core, mandate);
  rejects(() => permit(core, work), 'PACKAGE_NOT_APPROVED');
  fixtureMaterial(core, work);
  rejects(() => permit(core, work, { accountId: 'wrong-account', idempotencyKey: 'wrong-permit' }), 'TARGET_NOT_AUTHORIZED');
  const issued = permit(core, work);
  const activated = core.consumePermit({ permitId: issued.id }, connector);
  assert.equal(activated.execute, true);
  assert.equal(core.consumePermit({ permitId: issued.id }, connector).execute, false);
  const revoked = core.revokeMandate(mandate.id, { expectedRevision: 1, idempotencyKey: 'revoke-0001' }, owner);
  assert.deepEqual(revoked.inFlight, [issued.operationKey]);
  assert.equal(core.consumePermit({ permitId: issued.id }, connector).execute, false);
  assert.equal(core.recordEffect({ operationKey: issued.operationKey, status: 'unknown' }, connector).state, 'unknown');
  rejects(() => core.recordEffect(fixtureVerified(issued, { visibility: 'private' }), connector), 'READBACK_BINDING_MISMATCH');
  const verified = core.recordEffect(fixtureVerified(issued, { dataMode: 'real' }), connector);
  assert.equal(verified.dataMode, 'fixture');
  assert.equal(core.outcomes(mandate.id, owner).counts.publicVerified, 0);
  assert.equal(core.outcomes(mandate.id, owner).counts.fixturePublicVerified, 1);
});

test('replacement binds expected prior version and edited packages or pre-dispatch revocation invalidate permits', t => {
  const { core } = instance(t);
  const target = { ...site, action: 'replace' };
  register(core, target);
  const mandate = allow(core, { allowedActions: [target] });
  const work = task(core, mandate);
  fixtureMaterial(core, work, target);
  const first = permit(core, work, { ...target, expectedPreviousReleaseId: 'revision-1' });
  rejects(() => core.consumePermit({ permitId: first.id, expectedPreviousReleaseId: 'revision-2' }, connector), 'PREVIOUS_RELEASE_CONFLICT');
  core.recordArtifact({ ...target, taskId: work.id, packageHash: hashes.edited, artifactRef: 'fixture-edited' }, worker);
  rejects(() => core.consumePermit({ permitId: first.id, expectedPreviousReleaseId: 'revision-1' }, connector), 'PERMIT_INACTIVE');
  rejects(() => core.recordReview({ taskId: work.id, channelId: site.channelId, packageHash: hashes.package,
    reportHash: hashes.review, verified: true, outcome: 'passed' }, reviewer), 'PACKAGE_STALE');
  const approval = { taskId: work.id, channelId: site.channelId, packageHash: hashes.edited, reportHash: hashes.editedReview, verified: true, outcome: 'passed' };
  rejects(() => core.recordReview(approval, { ...reviewer, actorId: worker.actorId }), 'INDEPENDENT_REVIEW_REQUIRED');
  core.recordReview(approval, reviewer);
  const second = permit(core, work, { ...target, packageHash: hashes.edited, expectedPreviousReleaseId: 'revision-1', idempotencyKey: 'permit-0002' });
  core.revokeMandate(mandate.id, { expectedRevision: 1, idempotencyKey: 'revoke-0002' }, owner);
  rejects(() => core.consumePermit({ permitId: second.id, expectedPreviousReleaseId: 'revision-1' }, connector), 'PERMIT_INACTIVE');
});

test('official write capability with owner confirmation yields only an exact owner handoff', t => {
  const { core } = instance(t);
  const mandate = allow(core, { allowedActions: [external], requiredOutcomes: [{ channelId: external.channelId, outcome: 'public' }] });
  register(core, external, { confirmationRequired: true });
  const work = task(core, mandate);
  fixtureMaterial(core, work, external);
  const channel = core.getTask(work.id, owner).channels.find(row => row.channelId === external.channelId);
  rejects(() => permit(core, work, external), 'CHANNEL_CAPABILITY_DENIED');
  const input = { ...external, taskId: work.id, packageHash: hashes.package, expectedRevision: channel.revision, idempotencyKey: 'confirm-0001' };
  rejects(() => core.confirmTarget(input, worker), 'ROLE_DENIED');
  rejects(() => core.confirmTarget({ ...input, packageHash: hashes.edited }, owner), 'CONFIRMATION_STALE');
  assert.equal(core.confirmTarget(input, owner).state, 'owner_confirmed');
  assert.equal(core.outcomes(mandate.id, owner).counts.ownerTouches, 1);
});

test('an unconfirmed exact handoff expires at its task deadline even while the mandate remains active', t => {
  const { core, time } = instance(t);
  const deadlineAt = NOW + 1000;
  const mandate = allow(core, { expiresAt: NOW + DAY, allowedActions: [external],
    requiredOutcomes: [{ channelId: external.channelId, outcome: 'public' }] });
  register(core, external, { confirmationRequired: true });
  const work = task(core, mandate, { deadlineAt });
  const discovery = core.claim({ kinds: ['discover'] }, worker);
  core.report({ id: discovery.id, epoch: discovery.epoch, status: 'succeeded',
    channelPlan: [{ ...external, disposition: 'owner_confirmation', reason: 'Exact platform confirmation is required.' }] }, worker);
  fixtureMaterial(core, work, external);
  const awaiting = core.getTask(work.id, owner);
  assert.equal(awaiting.state, 'waiting_input');
  assert.equal(awaiting.canResume, false);
  rejects(() => core.controlTask(work.id, { action: 'resume', expectedRevision: awaiting.revision,
    idempotencyKey: 'resume-unconfirmed-owner' }, owner), 'OWNER_HANDOFF_REQUIRED');
  time(deadlineAt);
  rejects(() => core.confirmTarget({ ...external, taskId: work.id, packageHash: hashes.package,
    expectedRevision: awaiting.channels.find(row => row.channelId === external.channelId).revision,
    idempotencyKey: 'after-handoff-deadline' }, owner), 'TASK_NOT_EXECUTABLE');
  core.tick(system);
  assert.equal(core.getMandate(mandate.id, owner).state, 'active');
  assert.equal(core.getTask(work.id, owner).state, 'expired');
  assert.equal(core.outcomes(mandate.id, owner).autonomy.missed, 1);
});

test('verified publication schedules each retest from actual publication time even after the writing deadline', t => {
  const { core, time } = instance(t);
  register(core);
  const mandate = allow(core);
  const work = task(core, mandate, { deadlineAt: NOW + 1000 });
  fixtureMaterial(core, work);
  const dispatched = core.consumePermit({ permitId: permit(core, work).id }, connector);
  core.recordEffect(fixtureVerified(dispatched), connector);
  const views = core.getTask(work.id, owner).observations;
  assert.deepEqual(views.map(item => [item.day, item.dueAt]), [[1, NOW + DAY], [3, NOW + 3 * DAY], [7, NOW + 7 * DAY]]);
  rejects(() => core.recordObservation({ observationId: views[0].id, evidenceRef: 'metric' }, worker), 'OBSERVATION_NOT_DUE');
  time(NOW + DAY);
  const retest = core.claim({ kinds: ['observe'] }, worker);
  assert.equal(retest.input.observationId, views[0].id);
  const recorded = core.recordObservation({ observationId: views[0].id, stepId: retest.id, epoch: retest.epoch,
    evidenceRef: 'fixture-observation', denominator: 10, paired: 7, citations: 2 }, worker);
  assert.equal(recorded.failed, 3);
  assert.equal(recorded.rate, 2 / 7);
  assert.equal(recorded.dataMode, 'fixture');
  core.report({ id: retest.id, epoch: retest.epoch, status: 'succeeded' }, worker);
  time(NOW + 3 * DAY - 1);
  assert.equal(core.claim({ kinds: ['observe'] }, worker), null);
  time(NOW + 3 * DAY);
  assert.equal(core.claim({ kinds: ['observe'] }, worker).input.day, 3);
});

test('alerts group by owner and root cause, while optional exceptions stay in the activity log', t => {
  const { core } = instance(t);
  const mandate = allow(core);
  const one = task(core, mandate);
  const two = task(core, mandate, { idempotencyKey: 'task-0002' });
  const item = { mandateId: mandate.id, taskId: one.id, rootCause: 'account-renewal', summary: 'Renew authorized account access.', actionable: true };
  assert.equal(core.recordException(item, worker).notificationId, null);
  const urgent = core.recordException({ ...item, necessary: true }, worker);
  const grouped = core.recordException({ ...item, taskId: two.id, necessary: true }, worker);
  assert.equal(urgent.id, grouped.id);
  assert.equal(grouped.taskIds.length, 2);
  assert.equal(core.listNotifications(owner).length, 1);
  assert.equal(core.listNotifications({ ...owner, actorId: 'other-owner' }).length, 0);
});

function injectedJournal() {
  const entries = new Map();
  let unavailable = false;
  let lostAcknowledgment = null;
  return {
    get({ scope, key }) {
      if (unavailable) throw new Error('test journal unavailable');
      return structuredClone(entries.get(JSON.stringify([scope, key])) ?? null);
    },
    append(entry) {
      if (unavailable) throw new Error('test journal unavailable');
      const key = JSON.stringify([entry.scope, entry.key]);
      assert.equal(entries.has(key), false);
      entries.set(key, structuredClone(entry));
      if (lostAcknowledgment && entry.kind === lostAcknowledgment) {
        lostAcknowledgment = null;
        throw new Error('test acknowledgment lost after append');
      }
      return { key: entry.key, digest: entry.digest };
    },
    list({ scope }) {
      if (unavailable) throw new Error('test journal unavailable');
      return structuredClone([...entries.values()].filter(entry => entry.scope === scope));
    },
    access(value) { unavailable = !value; },
    loseAck(kind) { lostAcknowledgment = kind; },
  };
}

function realLedgerMaterial(core, fields = {}) {
  register(core);
  const mandate = allow(core, fields.mandate ?? {});
  const work = task(core, mandate, { kind: 'prepare' });
  const producer = core.claim({ kinds: ['prepare'] }, worker);
  core.recordArtifact({ ...site, ...producer, taskId: work.id, packageHash: hashes.package, artifactRef: 'test-private-artifact' }, worker);
  const cost = fields.dispatchCost ? core.reserveCost({ id: producer.id, epoch: producer.epoch, requestKey: 'provider-101',
    currency: 'CNY', reservedMinor: 600 }, worker) : null;
  if (cost) {
    assert.equal(core.markCostDispatched({ costId: cost.id, id: producer.id, epoch: producer.epoch }, worker).execute, true);
    core.settleCost({ costId: cost.id, status: 'settled', actualMinor: 550, providerRef: 'preparation-usage-1', evidenceRef: 'isolated-test-usage' }, worker);
  }
  core.report({ id: producer.id, epoch: producer.epoch, status: 'succeeded',
    followups: [{ kind: 'review', key: 'review-web', input: { channelId: 'official-site' } }] }, worker);
  const reviewWork = core.claim({ kinds: ['review'] }, reviewer);
  core.recordReview({ id: reviewWork.id, epoch: reviewWork.epoch, taskId: work.id, channelId: 'official-site',
    packageHash: hashes.package, reportHash: hashes.review, evidenceRef: 'test-independent-report', verified: true, outcome: 'passed' }, reviewer);
  core.report({ id: reviewWork.id, epoch: reviewWork.epoch, status: 'succeeded',
    followups: [{ kind: 'publish', key: 'publish-web', input: { channelId: 'official-site' } }] }, reviewer);
  const publication = core.claim({ kinds: ['publish'] }, connector);
  return { mandate, work, cost, publication, issued: fields.skipPermit ? null : permit(core, work) };
}

test('real mode declines new work with no durable journal and refuses to reuse a fixture database', t => {
  const { core } = instance(t, { mode: 'real' });
  assert.equal(core.health(owner).ready, false);
  rejects(() => allow(core), 'JOURNAL_UNAVAILABLE');
  assert.equal(core.listMandates(owner).length, 0);
  const folder = mkdtempSync(join(tmpdir(), 'pengmanager-mode-'));
  t.after(() => rmSync(folder, { recursive: true }));
  const dbPath = join(folder, 'bot.sqlite');
  const original = createBotCore({ dbPath });
  original.close();
  rejects(() => createBotCore({ dbPath, mode: 'real' }), 'DATA_MODE_MISMATCH');
});

test('a lost independent acknowledgment never yields a second dispatch permission', t => {
  const journal = injectedJournal();
  const { core } = instance(t, { mode: 'real', journal });
  const { publication, issued } = realLedgerMaterial(core);
  rejects(() => core.consumePermit({ permitId: issued.id }, connector), 'PREVIOUS_RELEASE_REQUIRED');
  const intent = { permitId: issued.id, id: publication.id, epoch: publication.epoch, expectedPreviousReleaseId: null };
  rejects(() => core.consumePermit({ ...intent, epoch: -1 }, connector), 'STALE_LEASE');
  journal.loseAck('effect');
  rejects(() => core.consumePermit(intent, connector), 'JOURNAL_UNAVAILABLE');
  const resumed = core.consumePermit(intent, connector);
  assert.equal(resumed.execute, false);
  assert.equal(resumed.state, 'unknown');
  assert.equal(core.getTask(publication.taskId, owner).steps.filter(step => step.kind === 'reconcile').length, 1);
  assert.equal(core.recordEffect({ operationKey: resumed.operationKey, status: 'not_executed', authoritative: true,
    receiptRef: 'test-provider-no-write' }, connector).state, 'not_executed');
  assert.equal(core.consumePermit(intent, connector).execute, false);
});

test('a real-mode isolated recovery rebuilds accepted work, honors newer revocation and keeps external intent unresolved', t => {
  const journal = injectedJournal();
  const primary = createBotCore({ mode: 'real', journal, clock: () => NOW });
  const { mandate, work, cost, publication, issued } = realLedgerMaterial(primary, { dispatchCost: true });
  const intent = { permitId: issued.id, id: publication.id, epoch: publication.epoch, expectedPreviousReleaseId: null };
  assert.equal(primary.consumePermit(intent, connector).execute, true);
  assert.equal(primary.revokeMandate(mandate.id, { expectedRevision: 1, idempotencyKey: 'revoke-0001' }, owner).state, 'revoked');
  primary.close();
  const { core } = instance(t, { mode: 'real', journal, recoveryMode: true });
  assert.equal(core.health(owner).readOnly, true);
  rejects(() => core.restoreJournal({ writerFenced: false }, system), 'WRITER_FENCE_REQUIRED');
  const restored = core.restoreJournal({ writerFenced: true }, system);
  assert.equal(restored.unsettledEffects, 1);
  assert.equal(restored.unsettledCosts, 0);
  assert.equal(core.getBudget(mandate.id, owner).spentMinor, 550);
  assert.equal(core.getMandate(mandate.id, owner).state, 'revoked');
  assert.equal(core.getTask(work.id, owner).id, work.id);
  assert.equal(core.getEffect(issued.operationKey, connector).state, 'unknown');
  assert.equal(core.claim({ kinds: ['prepare'] }, worker), null);
  assert.equal(core.claim({ kinds: ['reconcile'] }, connector).input.operationKey, issued.operationKey);
  rejects(() => core.completeRecovery({ writerFenced: true }, system), 'RECOVERY_RECONCILIATION_REQUIRED');
  core.recordEffect({ operationKey: issued.operationKey, status: 'not_executed', authoritative: true,
    receiptRef: 'test-old-writer-never-reached-platform' }, connector);
  assert.equal(core.completeRecovery({ writerFenced: true }, system).readOnly, false);
  assert.equal(core.getMandate(mandate.id, owner).revision, 2);
  assert.equal(core.getBudget(mandate.id, owner).unknownMinor, 0);
  assert.equal(cost.reservedMinor, 600);
});

test('local revocation blocks publication immediately when remote journal cannot acknowledge it', t => {
  const journal = injectedJournal();
  const { core } = instance(t, { mode: 'real', journal });
  const { mandate, publication, issued } = realLedgerMaterial(core);
  journal.access(false);
  const stopped = core.revokeMandate(mandate.id, { expectedRevision: 1, idempotencyKey: 'revoke-0001' }, owner);
  assert.equal(stopped.state, 'revoked');
  rejects(() => core.consumePermit({ permitId: issued.id, id: publication.id, epoch: publication.epoch, expectedPreviousReleaseId: null }, connector), 'PERMIT_INACTIVE');
  rejects(() => core.tick(system), 'JOURNAL_UNAVAILABLE');
  journal.access(true);
  core.tick(system);
  assert.equal(journal.list({ scope: JSON.stringify([owner.workspaceId, owner.projectId]) })
    .some(entry => entry.kind === 'mandate' && entry.data.row.state === 'revoked'), true);
});

test('the same native signed order can remain pending without enabling another provider dispatch', t => {
  const { core, time } = instance(t);
  const work = task(core, allow(core), { kind: 'review' });
  const first = core.claim({ kinds: ['review'] }, reviewer);
  const submitted = { id: first.id, epoch: first.epoch, provider: 'native_signed_order', requestHash: hashes.package,
    requestKey: 'signed-order-key', currency: 'CNY', reservedMinor: 500 };
  const pending = core.reserveCost(submitted, reviewer);
  assert.equal(core.markCostDispatched({ costId: pending.id, id: first.id, epoch: first.epoch }, reviewer).execute, true);
  rejects(() => core.report({ id: first.id, epoch: first.epoch, status: 'retry', pendingCostIds: ['missing'] }, reviewer), 'NATIVE_ORDER_BINDING_REQUIRED');
  assert.equal(core.report({ id: first.id, epoch: first.epoch, status: 'retry', retryAt: NOW + 1000, pendingCostIds: [pending.id] }, reviewer).state, 'queued');
  assert.equal(core.getBudget(work.mandateId, owner).reservedMinor, 500);
  assert.equal(core.getBudget(work.mandateId, owner).unknownMinor, 0);
  time(NOW + 1001);
  const reassigned = { ...reviewer, actorId: 'restarted-reviewer' };
  const second = core.claim({ kinds: ['review'] }, reassigned);
  assert.equal(second.id, first.id);
  assert.equal(core.reserveCost({ ...submitted, epoch: second.epoch }, reassigned).nativeOrderRef, hashes.package);
  assert.equal(core.markCostDispatched({ costId: pending.id, id: second.id, epoch: second.epoch }, reassigned).execute, false);
  core.settleCost({ costId: pending.id, status: 'settled', actualMinor: 400, providerRef: 'test-order-used', evidenceRef: 'test-signed-usage' }, reassigned);
  core.report({ id: second.id, epoch: second.epoch, status: 'succeeded' }, reassigned);
  assert.equal(core.getBudget(work.mandateId, owner).spentMinor, 400);
});

test('owner-reported manual submission is exact, authenticated and outside public verification', t => {
  const { core } = instance(t);
  const mandate = allow(core, { allowedActions: [external], requiredOutcomes: [{ channelId: external.channelId, outcome: 'public' }] });
  const work = task(core, mandate);
  const discovery = core.claim({ kinds: ['discover'] }, worker);
  core.report({ id: discovery.id, epoch: discovery.epoch, status: 'succeeded',
    channelPlan: [{ ...external, disposition: 'manual', reason: 'A personal original answer requires its author.' }] }, worker);
  fixtureMaterial(core, work, external);
  const current = core.getTask(work.id, owner);
  const channel = current.channels.find(row => row.channelId === external.channelId);
  const input = { ...external, taskId: work.id, taskRevision: current.revision, expectedRevision: channel.revision, packageHash: hashes.package,
    receiptRef: 'owner-submitted-copy', ownerMinutes: 7, idempotencyKey: 'owner-submission-key' };
  rejects(() => core.recordOwnerSubmission({ ...input, taskRevision: 0 }, owner), 'PRECONDITION_FAILED');
  rejects(() => core.recordOwnerSubmission({ ...input, packageHash: hashes.edited }, owner), 'PACKAGE_NOT_APPROVED');
  rejects(() => core.recordOwnerSubmission({ ...input, ownerMinutes: -1 }, owner), 'INVALID_INPUT');
  const handoff = { taskId: work.id, channelId: external.channelId, leaseId: 'handoff-lease-id' };
  assert.deepEqual(core.recordBrowserHandoff(handoff, owner), core.recordBrowserHandoff(handoff, owner));
  assert.equal(core.recordOwnerSubmission(input, owner).state, 'owner_reported');
  assert.deepEqual(core.recordOwnerSubmission(input, owner), core.recordOwnerSubmission(input, owner));
  const overview = core.outcomes(mandate.id, owner);
  assert.equal(overview.counts.publicVerified, 0);
  assert.equal(overview.effects.length, 0);
  assert.equal(overview.counts.ownerTouches, 2);
  assert.equal(overview.autonomy.humanMinutes, 7);
  assert.equal(overview.autonomy.recordedTimeEntries, 1);
  assert.equal(overview.channels.find(row => row.channelId === external.channelId).ownerSubmissionRef, 'owner-submitted-copy');
});

test('restored gate persists across restarts and dedicated admin reviews cannot be leased by the routine worker', t => {
  const { core } = instance(t);
  const permission = allow(core, { trustScope: { adminReviews: true } });
  const administrative = task(core, permission, { kind: 'review', input: { adminOnly: true } });
  assert.equal(core.claim({ kinds: ['review'] }, reviewer), null);
  const dedicated = core.claim({ kinds: ['review'], taskId: administrative.id, adminOnly: true }, reviewer);
  assert.equal(dedicated.taskId, administrative.id);
  const folder = mkdtempSync(join(tmpdir(), 'pengmanager-recovery-gate-'));
  t.after(() => rmSync(folder, { recursive: true }));
  const dbPath = join(folder, 'bot.sqlite');
  const restoring = createBotCore({ dbPath, recoveryMode: true });
  restoring.close();
  const accidentallyStarted = createBotCore({ dbPath });
  try {
    assert.equal(accidentallyStarted.health(owner).readOnly, true);
    rejects(() => allow(accidentallyStarted), 'RECOVERY_READ_ONLY');
    assert.equal(accidentallyStarted.completeRecovery({ writerFenced: true }, system).readOnly, false);
  } finally { accidentallyStarted.close(); }
});

test('pre-dispatch GEO earmarks consume from their planned future windows and clear without a double deduction', t => {
  const { core, time } = instance(t);
  register(core);
  const mandate = allow(core, { budget: { currency: 'CNY', limitMinor: 210, windowMs: 7 * DAY },
    trustScope: { geo: { provider: 'fixture', queryIds: ['fixture-q1'], questionRevision: 'questions-v1', reserveMinorPerRound: 100 } } });
  const work = task(core, mandate, { idempotencyKey: 'geo-work-0001' });
  fixtureMaterial(core, work);
  const first = permit(core, work);
  const dispatched = core.consumePermit({ permitId: first.id }, connector);
  assert.deepEqual(dispatched.geoFunding.map(entry => entry.windowStart), [NOW, NOW, NOW + 7 * DAY]);
  assert.equal(core.getBudget(mandate.id, owner).geoReservedMinor, 200);
  assert.equal(core.consumePermit({ permitId: first.id }, connector).execute, false);
  assert.equal(core.getBudget(mandate.id, owner).geoReservedMinor, 200);
  core.recordEffect(fixtureVerified(first, { url: 'http://127.0.0.1:4320/zh/articles/geo-fixture' }), connector);

  const unrelated = task(core, mandate, { idempotencyKey: 'unrelated-cost', kind: 'prepare' });
  const draft = core.claim({ kinds: ['prepare'], taskId: unrelated.id }, worker);
  rejects(() => core.reserveCost({ id: draft.id, epoch: draft.epoch, requestKey: 'spend-other', currency: 'CNY', reservedMinor: 11 }, worker), 'BUDGET_EXCEEDED');
  time(NOW + DAY);
  const observation = core.claim({ kinds: ['observe'] }, worker);
  const cost = core.reserveCost({ id: observation.id, epoch: observation.epoch, requestKey: 'geo-round-1-search', currency: 'CNY', reservedMinor: 60 }, worker);
  assert.equal(core.getBudget(mandate.id, owner).reservedMinor, 200);
  assert.equal(core.markCostDispatched({ costId: cost.id, id: observation.id, epoch: observation.epoch }, worker).execute, true);
  core.settleCost({ costId: cost.id, status: 'settled', actualMinor: 40, providerRef: 'geo-billing-proof', evidenceRef: 'geo-receipt-1' }, worker);
  assert.equal(core.getBudget(mandate.id, owner).geoReservedMinor, 160);
  const record = { observationId: observation.input.observationId, stepId: observation.id, epoch: observation.epoch,
    denominator: 1, paired: 1, citations: 0, evidenceRef: 'test-original-sampled-proof' };
  rejects(() => core.recordObservation({ ...record, questionSetRef: 'new-questions' }, worker), 'GEO_QUESTION_SCOPE_CHANGED');
  core.recordObservation({ ...record, questionSetRef: 'questions-v1' }, worker);
  core.report({ id: observation.id, epoch: observation.epoch, status: 'succeeded' }, worker);
  const after = core.getBudget(mandate.id, owner);
  assert.equal(after.spentMinor, 40);
  assert.equal(after.geoReservedMinor, 100);
  assert.equal(after.availableMinor, 70);
  time(NOW + 7 * DAY);
  const future = core.getBudget(mandate.id, owner);
  assert.equal(future.geoReservedMinor, 100);
  assert.equal(future.spentMinor, 0);
  core.revokeMandate(mandate.id, { expectedRevision: 1, idempotencyKey: 'revoke-geo-task' }, owner);
  assert.equal(core.getBudget(mandate.id, owner).geoReservedMinor, 0);
  assert.equal(core.claim({ kinds: ['observe'] }, worker), null);
});

test('a required real observation denies publication without full provider quote, budget and coverage through day seven', t => {
  const journal = injectedJournal();
  let check = { ready: true, minimumMinor: 75 };
  const { core } = instance(t, { mode: 'real', journal, geoPreflight: () => check });
  const base = { requiredOutcomes: [{ channelId: site.channelId, outcome: 'observation' }],
    budget: { currency: 'CNY', limitMinor: 200 }, expiresAt: NOW + 10 * DAY,
    trustScope: { geo: { provider: 'deepseek-search', queryIds: ['approved-q'], reserveMinorPerRound: 80 } } };
  const real = realLedgerMaterial(core, { mandate: base, skipPermit: true });
  check = { ready: false };
  rejects(() => permit(core, real.work), 'GEO_RUNTIME_NOT_READY');
  check = { ready: true, minimumMinor: 81 };
  rejects(() => permit(core, real.work), 'GEO_ROUND_BUDGET_EXCEEDED');
  check = { ready: true, minimumMinor: 75 };
  const qualified = permit(core, real.work);
  const dispatched = core.consumePermit({ permitId: qualified.id, id: real.publication.id, epoch: real.publication.epoch, expectedPreviousReleaseId: null }, connector);
  assert.equal(dispatched.geoFunding.length, 3);
  assert.equal(journal.list({ scope: JSON.stringify([owner.workspaceId, owner.projectId]) })
    .find(entry => entry.kind === 'effect').data.binding.includes('geoFunding'), true);
  const unqualified = [
    [{ trustScope: {}, expiresAt: NOW + 12 * DAY }, 'GEO_RESERVATION_REQUIRED'],
    [{ expiresAt: NOW + 7 * DAY }, 'GEO_COVERAGE_WINDOW_REQUIRED'],
    [{ budget: { currency: 'CNY', limitMinor: 150 } }, 'GEO_FUTURE_BUDGET_EXCEEDED'],
  ];
  for (const [parameters, expected] of unqualified) {
    const testJournal = injectedJournal();
    const ledger = createBotCore({ mode: 'real', journal: testJournal, clock: () => NOW, geoPreflight: () => check });
    try {
      const work = realLedgerMaterial(ledger, { mandate: { ...base, ...parameters }, skipPermit: true }).work;
      rejects(() => permit(ledger, work), expected);
    } finally { ledger.close(); }
  }
});

test('GEO protected escrow restarts during uncertain publication, and historical reports exclude later expenses', t => {
  const journal = injectedJournal();
  const primary = createBotCore({ mode: 'real', journal, clock: () => NOW, geoPreflight: () => ({ ready: true, minimumMinor: 40 }) });
  const real = realLedgerMaterial(primary, { mandate: {
    budget: { currency: 'CNY', limitMinor: 175 }, requiredOutcomes: [{ channelId: site.channelId, outcome: 'observation' }],
    trustScope: { geo: { provider: 'deepseek-search', queryIds: ['q-fixed'], reserveMinorPerRound: 50 } },
  } });
  primary.consumePermit({ permitId: real.issued.id, id: real.publication.id, epoch: real.publication.epoch, expectedPreviousReleaseId: null }, connector);
  primary.close();
  const { core: restored } = instance(t, { mode: 'real', journal, recoveryMode: true });
  const report = restored.restoreJournal({ writerFenced: true }, system);
  assert.equal(report.unsettledEffects, 1);
  assert.equal(restored.getBudget(real.mandate.id, owner).geoReservedMinor, 100);
  restored.recordEffect({ operationKey: real.issued.operationKey, status: 'not_executed', authoritative: true,
    receiptRef: 'fixture-confirmed-no-remote-action' }, connector);
  assert.equal(restored.getBudget(real.mandate.id, owner).geoReservedMinor, 0);
  assert.equal(restored.completeRecovery({ writerFenced: true }, system).readOnly, false);

  const { core, time } = instance(t);
  const mandate = allow(core, { schedule: { reportStartsAt: NOW + DAY }, budget: { currency: 'CNY', limitMinor: 1000, windowMs: 8 * DAY } });
  const work = task(core, mandate, { kind: 'prepare' });
  time(NOW + 2 * DAY);
  const lease = core.claim({ kinds: ['prepare'], taskId: work.id }, worker);
  const cost = core.reserveCost({ id: lease.id, epoch: lease.epoch, requestKey: 'future-during-window', currency: 'CNY', reservedMinor: 600 }, worker);
  core.markCostDispatched({ costId: cost.id, id: lease.id, epoch: lease.epoch }, worker);
  core.settleCost({ costId: cost.id, status: 'settled', actualMinor: 550, providerRef: 'future-bill', evidenceRef: 'future-bill-proof' }, worker);
  core.tick(system);
  assert.equal(core.getBudget(mandate.id, owner).spentMinor, 550);
  assert.equal(core.outcomes(mandate.id, owner).reports[0].budget.spentMinor, 0);
});

test('an individually cancelled task is durably restored with GEO holds released and its outflow still unknown', t => {
  const journal = injectedJournal();
  const primary = createBotCore({ mode: 'real', journal, clock: () => NOW, geoPreflight: () => ({ ready: true, minimumMinor: 40 }) });
  const live = realLedgerMaterial(primary, { mandate: {
    budget: { currency: 'CNY', limitMinor: 150 }, requiredOutcomes: [{ channelId: site.channelId, outcome: 'observation' }],
    trustScope: { geo: { provider: 'deepseek-search', queryIds: ['q-fixed'], reserveMinorPerRound: 50 } },
  } });
  primary.consumePermit({ permitId: live.issued.id, id: live.publication.id, epoch: live.publication.epoch, expectedPreviousReleaseId: null }, connector);
  const version = primary.getTask(live.work.id, owner).revision;
  primary.controlTask(live.work.id, { action: 'cancel', expectedRevision: version, idempotencyKey: 'cancel-goe-01' }, owner);
  primary.close();
  const { core: restored } = instance(t, { mode: 'real', journal, recoveryMode: true });
  assert.equal(restored.restoreJournal({ writerFenced: true }, system).unsettledEffects, 1);
  assert.equal(restored.getTask(live.work.id, owner).state, 'cancelled');
  assert.equal(restored.getBudget(live.mandate.id, owner).geoReservedMinor, 0);
});
