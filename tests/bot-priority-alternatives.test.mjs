import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY, hash } from '../src/bot/core-store.mjs';
import { createBotCore } from '../src/bot/core.mjs';
import { createBotOperations, planChannels, runBotStep, validateStrategy } from '../src/bot/operations.mjs';

const START = Date.parse('2026-11-27T00:00:00Z');
const HOUR = 3600000;
const owner = { workspaceId: 'fixtures', projectId: 'priorities', actorId: 'owner', role: 'owner' };
const system = { ...owner, actorId: 'system-lease', role: 'system' };
const worker = { ...owner, actorId: 'worker-lease', role: 'worker' };
const reviewer = { ...owner, actorId: 'reviewer-lease', role: 'reviewer' };
const connector = { ...owner, actorId: 'connector-lease', role: 'connector' };
const site = { channelId: 'official-site', accountId: 'exact-site', destination: 'articles', form: 'article', action: 'publish', visibility: 'public' };

function tester(t) {
  let now = START;
  const core = createBotCore({ clock: () => now });
  t.after(() => core.close());
  const create = (id, input = {}) => core.createMandate({ objective: 'Deliver accountable results', idempotencyKey: 'mandate-' + id, ...input }, owner);
  const task = (mandate, id, input = {}) => core.createTask({ mandateId: mandate.id, title: id, idempotencyKey: 'task-' + id, ...input }, owner);
  function capability() {
    core.recordCapability({ ...site, official: true, safeDedup: true, businessReadback: true,
      expiresAt: START + 30 * DAY, policyRef: 'readable-policy', evidenceRef: 'fixture-own-site', idempotencyKey: 'site-capability' }, owner);
  }
  return { core, create, task, capability, clock: () => now, time: at => { now = at; } };
}

test('queue honors due deadlines and required work before feed rank; aging protects a low-priority opportunity', t => {
  const { core, create, task, time } = tester(t);
  const optional = create('optional');
  const committed = create('committed', { requiredOutcomes: [{ id: 'result', outcome: 'result' }] });
  const old = task(optional, 'old-optional', { priority: 0 });
  const popular = task(optional, 'popular', { priority: 100 });
  const important = task(committed, 'ordinary-commitment', { priority: 0 });
  const urgent = task(committed, 'early-deadline', { priority: 0, deadlineAt: START + 30 * 60000 });
  assert.equal(core.claim({ kinds: ['discover'] }, worker).taskId, urgent.id);
  assert.equal(core.claim({ kinds: ['discover'] }, worker).taskId, important.id);
  time(START + HOUR + 10);
  task(committed, 'new-critical', { priority: 100, deadlineAt: START + 2 * HOUR });
  assert.equal(core.claim({ kinds: ['discover'] }, worker).taskId, old.id);
  assert.equal(core.claim({ kinds: ['discover'] }, worker).taskId, popular.id);
});

test('next-phase queue uses finished approved-evidence counts and then bounded model score', t => {
  const { core, create, task } = tester(t);
  const m = create('evidence');
  const tasks = [
    [task(m, 'reported-topical', { priority: 100 }), 1, 100],
    [task(m, 'more-verified', { priority: 0 }), 3, 10],
    [task(m, 'same-evidence-higher-model', { priority: 0 }), 3, 60],
  ];
  for (const [work, verifiedClaims, modelPriority] of tasks) {
    const step = core.claim({ taskId: work.id, kinds: ['discover'] }, worker);
    core.report({ id: step.id, epoch: step.epoch, output: { queue: { verifiedClaims, modelPriority } },
      followups: [{ kind: 'prepare', key: 'downstream' }] }, worker);
  }
  assert.equal(core.claim({ kinds: ['prepare'] }, worker).taskId, tasks[2][0].id);
  assert.equal(core.claim({ kinds: ['prepare'] }, worker).taskId, tasks[1][0].id);
  assert.equal(core.claim({ kinds: ['prepare'] }, worker).taskId, tasks[0][0].id);
  const finding = { action: 'prepare', reason: 'Has checked facts', claimIds: ['claim-1'], priority: 101 };
  assert.throws(() => validateStrategy(finding, [{ claimId: 'claim-1' }]), { code: 'STRATEGY_ASSESSMENT_INVALID' });
  assert.equal(validateStrategy({ ...finding, priority: 0 }, [{ claimId: 'claim-1' }]).priority, 0);
});

test('a due GEO round with an actual budget hold outranks a new optional discovery', t => {
  const { core, create, task, capability, time } = tester(t);
  capability();
  const m = create('budget-held', { allowedActions: [site], requiredOutcomes: [site.channelId],
    trustScope: { geo: { queryIds: ['query-1'], reserveMinorPerRound: 20, provider: 'fixture' } },
    budget: { currency: 'CNY', limitMinor: 200 } });
  const work = task(m, 'planned-site');
  const pkg = hash('budget-test');
  core.recordArtifact({ ...site, taskId: work.id, artifactRef: 'isolated-origin', packageHash: pkg }, worker);
  core.recordReview({ taskId: work.id, channelId: site.channelId, packageHash: pkg,
    reportHash: hash('review-test'), verified: true, outcome: 'passed' }, reviewer);
  const permit = core.issuePermit({ ...site, taskId: work.id, packageHash: pkg, expectedPreviousReleaseId: null, idempotencyKey: 'geo-permit' }, system);
  const sent = core.consumePermit({ permitId: permit.id, expectedPreviousReleaseId: null }, connector);
  core.recordEffect({ status: 'verified', operationKey: sent.operationKey, packageHash: pkg, visibility: 'public', accountId: site.accountId,
    publishedAt: START, verifiedAt: START, remoteId: 'isolated-release', receiptRef: 'exact-fake-http', url: 'https://site.example.test/article' }, connector);
  // Finish the initial fixture discovery so the age rule applies only to queued candidates.
  const initial = core.claim({ kinds: ['discover'] }, worker);
  core.report({ id: initial.id, epoch: initial.epoch, output: {} }, worker);
  time(START + DAY);
  const optional = create('budget-optional');
  task(optional, 'new-high-feed-rank', { priority: 100, deadlineAt: START + DAY + HOUR });
  const claimed = core.claim({ kinds: ['discover', 'observe'] }, worker);
  assert.equal(claimed.kind, 'observe');
  assert.equal(claimed.input.day, 1);
  assert.equal(claimed.taskId, work.id);
});

function isolatedNative(clock) {
  return {
    mode: 'fixture',
    resolveClaims: async () => [{ claimId: 'claim-1', state: 'approved' }],
    prepareArticle: async () => ({ state: 'succeeded', jobId: 'isolated-native-job', contentHash: hash('frozen-article') }),
    reviewChannel: async ({ channel }) => {
      const packageRecord = { channelId: channel.channelId, expectedPreviousReleaseId: null, editionHash: hash('frozen-edition'),
        canonicalPath: '/en/articles/signed-fallback' };
      return { state: 'succeeded', packageRecord, packageHash: hash(packageRecord), reportHash: hash('independent-review'),
        artifactRef: 'isolated-native-edition' };
    },
    async publishWebsite({ packageRecord, beforeActivate, packageHash }) {
      const effect = await beforeActivate({ previousReleaseId: null, editionSnapshotHash: packageRecord.editionHash,
        canonicalPath: packageRecord.canonicalPath });
      assert.equal(effect.execute, true);
      return { status: 'verified', packageHash, remoteId: 'isolated-public-fallback', receiptRef: 'isolated-readback',
        accountId: site.accountId, visibility: 'public', url: 'https://site.example.test/en/articles/signed-fallback',
        publishedAt: clock(), verifiedAt: clock(), verificationMethod: 'server_readback' };
    },
  };
}

const original = { id: 'original-video-must-publish', channelId: 'bilibili', outcome: 'public' };

test('a separately signed public fallback completes under its own exact scope and never fulfills the original outcome', async t => {
  const { core, create, task, capability, clock } = tester(t);
  capability();
  const substitute = { ...site, forOutcomeId: original.id, outcome: 'public' };
  assert.throws(() => create('bad-alternative', { allowedActions: [{ ...site, accountId: 'another-account' }],
    requiredOutcomes: [original], allowedSubstitutions: [substitute] }), { code: 'SUBSTITUTION_NOT_AUTHORIZED' });
  const m = create('fallback-public', { requiredOutcomes: [original], allowedActions: [site], allowedSubstitutions: [substitute] });
  const due = task(m, 'public-fallback', { input: { title: 'Source has evidence but lacks playable video', forms: ['video'], claimIds: ['claim-1'] } });
  const ops = createBotOperations({ native: isolatedNative(clock), mode: 'fixture', clock,
    semanticPlanner: async () => ({ action: 'prepare', reason: 'Only a source-backed article is feasible.', claimIds: ['claim-1'], priority: 20 }) });
  const initial = core.claim({ kinds: ['discover'] }, worker);
  assert.throws(() => core.report({ id: initial.id, epoch: initial.epoch, channelPlan: [
    { ...site, accountId: 'wrong', disposition: 'publish', machinePublish: true, reason: 'forged',
      substitution: { forOutcomeId: original.id, outcome: 'public' } },
  ] }, worker), { code: 'SUBSTITUTION_SCOPE_DENIED' });
  assert.equal((await runBotStep(core, ops, initial, worker)).state, 'succeeded');
  for (const [kind, role] of [['prepare', worker], ['review', reviewer], ['publish', connector]]) {
    const step = core.claim({ kinds: [kind] }, role);
    assert.ok(step, kind);
    const result = await runBotStep(core, ops, step, role);
    assert.equal(result.state, 'succeeded', JSON.stringify(result.output));
  }
  const taskNow = core.getTask(due.id, owner);
  assert.deepEqual(taskNow.requiredOutcomes, [original]);
  assert.equal(taskNow.channels.find(row => row.channelId === original.channelId).disposition, 'blocked');
  assert.equal(taskNow.substitutions[0].achieved, true);
  assert.equal(taskNow.substitutions[0].receiptRef, 'isolated-readback');
  assert.equal(core.outcomes(m.id, owner).items.find(row => row.taskId === due.id).outcomes[0].fulfilled, false);
});

test('a preparation-only substitute cannot mint a publish step or an equivalent permit', async t => {
  const { core, create, task, capability, clock } = tester(t);
  capability();
  const m = create('fallback-prepared', { requiredOutcomes: [original], allowedActions: [{ ...site, risk: 'human' }],
    allowedSubstitutions: [{ ...site, forOutcomeId: original.id, outcome: 'prepared' }] });
  const work = task(m, 'private-copy-fallback', { input: { title: 'Use allowed article copy when video is missing', forms: ['video'], claimIds: ['claim-1'] } });
  const ops = createBotOperations({ native: isolatedNative(clock), mode: 'fixture', clock,
    semanticPlanner: async () => ({ action: 'prepare', reason: 'A public-source fact is qualified.', claimIds: ['claim-1'] }) });
  for (const [kind, role] of [['discover', worker], ['prepare', worker], ['review', reviewer]]) {
    const step = core.claim({ kinds: [kind] }, role);
    assert.ok(step, kind);
    const result = await runBotStep(core, ops, step, role);
    assert.equal(result.state, 'succeeded', JSON.stringify(result.output));
  }
  assert.equal(core.claim({ kinds: ['publish'] }, connector), null);
  const state = core.getTask(work.id, owner);
  assert.equal(state.state, 'partial');
  assert.equal(state.substitutions[0].outcome, 'prepared');
  assert.equal(state.substitutions[0].achieved, true);
  assert.equal(state.substitutions[0].receiptRef, null);
  const channel = state.channels.find(row => row.channelId === site.channelId);
  assert.throws(() => core.issuePermit({ ...site, taskId: work.id, packageHash: channel.packageHash,
    expectedPreviousReleaseId: null, idempotencyKey: 'invalid-alternate-publish' }, system), { code: 'TARGET_NOT_AUTHORIZED' });
});

test('a signed alternate stays dormant while the original route is available', t => {
  const { core, create, task, capability, clock } = tester(t);
  capability();
  const primary = { id: 'website-public', channelId: site.channelId, outcome: 'public' };
  const target = { channelId: 'zhihu', accountId: 'question-author', destination: 'question', form: 'article', action: 'publish', visibility: 'public' };
  const m = create('primary-available', { requiredOutcomes: [primary], allowedActions: [site, { ...target, risk: 'human' }],
    allowedSubstitutions: [{ ...target, forOutcomeId: primary.id, outcome: 'prepared' }] });
  const decision = planChannels({ now: clock(), mandate: m, capabilities: core.listCapabilities(owner),
    opportunity: { forms: ['article'], facts: [{ claimId: 'claim-1', state: 'approved' }], questionRef: 'the-question' } });
  assert.equal(decision.channels.find(row => row.channelId === site.channelId).machinePublish, true);
  assert.deepEqual(decision.substitutions, []);

  const queued = task(m, 'unneeded-signed-fallback');
  const step = core.claim({ taskId: queued.id, kinds: ['discover'] }, worker);
  assert.throws(() => core.report({ id: step.id, epoch: step.epoch, channelPlan: [
    { ...site, disposition: 'publish', machinePublish: true, reason: 'available' },
    { ...target, disposition: 'prepare', reason: 'unnecessary fallback', substitution: m.allowedSubstitutions[0] },
  ] }, worker), { code: 'SUBSTITUTION_ORIGINAL_AVAILABLE' });
});
