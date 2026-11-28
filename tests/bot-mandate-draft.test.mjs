import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseMandateDraft, stopMandateSelection } from '../public/bot/mandate-draft.js';
import { createBotCore } from '../src/bot/core.mjs';
import { createBotHttp } from '../src/bot/http.mjs';
import { createBotOperations, runBotStep } from '../src/bot/operations.mjs';
import { openIntentJournal } from '../src/bot/files.mjs';

const day = 86_400_000;
const today = new Date(2026, 10, 27, 12);
const owner = { workspaceId: 'onboarding-workspace', projectId: 'project', actorId: 'onboarding-owner', role: 'owner' };
const worker = { ...owner, actorId: 'onboarding-worker', role: 'worker' };

test('natural draft derives bounded cadence, delivery and private work mode without deriving grants or amounts', () => {
  const objective = '每天跟踪已登记公告，接单后三天内交付，仅研究，委托有效期两周，预算 500 元，代办发布到外站。';
  const draft = parseMandateDraft(objective, today);
  assert.equal(draft.objective, objective);
  assert.equal(draft.intervalMs, day);
  assert.equal(draft.resultWindowMs, 3 * day);
  assert.equal(draft.expiryDate, '2026-12-11');
  assert.equal(draft.workMode, 'research_only');
  assert.equal(draft.ambiguous, false);
  assert.equal(draft.notes.length, 2);
  const spaced = parseMandateDraft('每天整理公告，交付时限为 3 天，先试 2 周。', today);
  assert.equal(spaced.resultWindowMs, 3 * day);
  assert.equal(spaced.expiryDate, '2026-12-11');
  assert.equal(parseMandateDraft('2 天内 交付研究结论。', today).resultWindowMs, 2 * day);
  for (const field of ['budget', 'allowedActions', 'sources', 'presence', 'actorId']) assert.equal(Object.hasOwn(draft, field), false);
  assert.equal(parseMandateDraft('每隔两天跟进；七天内交第一份草稿，只起草。委托到期日为 2026年12月5日', today).expiryDate, '2026-12-05');
  assert.equal(parseMandateDraft('每隔两天跟进；七天内交第一份草稿，只起草。', today).intervalMs, 2 * day);
  assert.equal(parseMandateDraft('按事件触发，三十小时内给出，内部草稿。', today).intervalMs, null);
  assert.equal(parseMandateDraft('按事件触发，三十小时内给出，内部草稿。', today).resultWindowMs, 30 * 3_600_000);
  assert.equal(parseMandateDraft('每周一次，半天内交第一份草稿。', today).intervalMs, 7 * day);
  assert.equal(parseMandateDraft('每周一次，半天内交第一份草稿。', today).resultWindowMs, 12 * 3_600_000);
  assert.equal(parseMandateDraft('不要自动发布', today).workMode, 'draft_only');
});

test('natural draft leaves conflict, unsupported time, invalid dates and unsafe commands out of generated values', () => {
  for (const objective of [
    '不要每天，改成每周处理', '不要每两天自动更新', '每周一处理', '每月处理', '每天最多两次', '每周 两次', '每天 9 点',
    '每周。接单后七天完成；另一个说法接单后三天完成。', '委托到期日为 2026-02-30', '委托到期日为 2026-01-01',
    '先只研究，也只起草', '并非仅研究',
  ]) assert.equal(parseMandateDraft(objective, today).ambiguous, true, objective);
  for (const objective of ['停发', '停止外发。', '', ' '.repeat(30), '文'.repeat(1601)]) {
    assert.throws(() => parseMandateDraft(objective, today));
  }
  assert.equal(parseMandateDraft('整理项目事实', today).intervalMs, undefined);
  assert.equal(parseMandateDraft('整理项目事实', today).workMode, undefined);
});

test('only an affirmative exact stop command and one selected current owned mandate yield a revision', () => {
  const valid = { id: 'mandate-a', ownerId: owner.actorId, state: 'active', revision: 4, expiresAt: today.getTime() + day };
  const other = { ...valid, id: 'mandate-b', ownerId: 'another-owner' };
  const expired = { ...valid, id: 'mandate-c', expiresAt: today.getTime() };
  const mandates = [valid, other, expired];
  assert.deepEqual(stopMandateSelection('停发。', valid.id, mandates, owner.actorId, today.getTime()), { id: valid.id, revision: 4 });
  for (const [text, selected, candidates] of [
    ['停发所有委托', valid.id, mandates], ['不要停发', valid.id, mandates], ['停发', '', mandates],
    ['停发', other.id, mandates], ['停发', expired.id, mandates], ['停发', valid.id, [valid, valid]],
    ['停发', valid.id, [{ ...valid, revision: 0 }]], ['停发', valid.id, [{ ...valid, state: 'revoked' }]],
  ]) assert.throws(() => stopMandateSelection(text, selected, candidates, owner.actorId, today.getTime()));
});

test('signed research and draft mandates restrict paid planning, native preparation and followups to their own scope', async t => {
  const core = createBotCore({ clock: () => today.getTime() });
  t.after(core.close);
  const observations = [];
  const claims = [{ claimId: 'fact-A', state: 'approved', expiresAt: null, sourceUrl: 'https://www.sqlite.org/lang_transaction.html' }];
  const operations = createBotOperations({ mode: 'fixture',
    native: { mode: 'fixture', async resolveClaims(ids) { return claims.filter(row => ids.includes(row.claimId)); },
      async prepareArticle(input) {
        observations.push(['prepare', input.privateDraft]);
        return { state: 'succeeded', jobId: 'job-a', contentHash: 'a'.repeat(64),
          privateDraft: { title: 'Draft article', body: 'A signed private preparation for this specific test.' } };
      },
    },
    semanticPlanner: async () => {
      observations.push(['plan']);
      return { action: 'prepare', reason: 'Isolated approved fact', claimIds: ['fact-A'] };
    },
  });
  const privateMode = (workMode) => core.createMandate({ idempotencyKey: `private-${workMode}`, workMode,
    objective: `Run ${workMode}` }, owner);
  assert.throws(() => core.previewMandate({ objective: 'Conflict', workMode: 'research_only',
    allowedActions: [{ channelId: 'official-site', accountId: 'example-owner', destination: 'example-site', form: 'article' }] }, owner),
  { code: 'PRIVATE_WORK_SCOPE_CONFLICT' });
  assert.throws(() => core.previewMandate({ objective: 'Bad string', workMode: 'publish_anywhere' }, owner), { code: 'INVALID_WORK_MODE' });
  const research = privateMode('research_only');
  const create = (mandate, claimIds = ['fact-A']) => core.createTask({ mandateId: mandate.id, title: 'Private task',
    idempotencyKey: `${mandate.id}-${claimIds.length}`, input: { opportunity: { title: 'Private task', claimIds } } }, owner);
  const researchTask = create(research);
  await runBotStep(core, operations, core.claim({ taskId: researchTask.id, kinds: ['discover'] }, worker), worker);
  assert.equal(core.getTask(researchTask.id, owner).steps.length, 1);
  assert.deepEqual(core.getTask(researchTask.id, owner).steps[0].output.privateWork.claims, claims);
  assert.deepEqual(observations, []);
  const evidenceGap = create(research, []);
  await runBotStep(core, operations, core.claim({ taskId: evidenceGap.id, kinds: ['discover'] }, worker), worker);
  assert.equal(core.getTask(evidenceGap.id, owner).steps[0].output.privateWork.state, 'evidence_gap');
  const configured = core.createMandate({ idempotencyKey: 'selected-private-fact', workMode: 'research_only',
    objective: 'Research one owner-selected fact without event claims', trustScope: { claimIds: ['fact-A', 'expired', 'fact-A'] } }, owner);
  assert.deepEqual(configured.trustScope.claimIds, ['fact-A', 'expired']);
  const selected = create(configured, []);
  await runBotStep(core, operations, core.claim({ taskId: selected.id, kinds: ['discover'] }, worker), worker);
  assert.deepEqual(core.getTask(selected.id, owner).steps[0].output.privateWork.claims, claims);
  assert.deepEqual(observations, []);

  const draft = privateMode('draft_only');
  const draftTask = create(draft);
  await runBotStep(core, operations, core.claim({ taskId: draftTask.id, kinds: ['discover'] }, worker), worker);
  await runBotStep(core, operations, core.claim({ taskId: draftTask.id, kinds: ['prepare'] }, worker), worker);
  const finished = core.getTask(draftTask.id, owner);
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.steps.length, 2);
  assert.equal(finished.steps.find(row => row.kind === 'prepare').output.privateWork.title, 'Draft article');
  assert.ok(finished.channels.every(row => row.machinePublish !== true && !row.packageHash));
  assert.deepEqual(observations, [['plan'], ['prepare', true]]);
  assert.equal(core.outcomes(draft.id, owner).effects.length, 0);
});

test('same private owner task reuses its defer and reassesses only after its reviewed evidence changes', async t => {
  const primary = mkdtempSync(join(realpathSync(tmpdir()), 'pm-source-check-'));
  const journal = mkdtempSync(join(realpathSync(tmpdir()), 'pm-source-journal-'));
  const core = createBotCore({ clock: () => today.getTime(), mode: 'real',
    journal: openIntentJournal(journal, { primaryDirectory: primary, requireSeparateVolume: false }) });
  t.after(() => { core.close(); rmSync(journal, { recursive: true, force: true }); rmSync(primary, { recursive: true, force: true }); });
  const claimId = 'fixture-source';
  const fact = { claimId, state: 'approved', text: 'Historical fixture release', sourceUrl: 'https://source.example.org/history' };
  let calls = 0;
  const operations = createBotOperations({ mode: 'real', modelReady: true,
    native: { mode: 'real', resolveClaims: () => [{ ...fact }] },
    costPolicy: () => ({ currency: 'CNY', reservedMinor: 2,
      measure: () => ({ actualMinor: 1, providerRef: 'isolated-response-' + calls, evidenceRef: 'isolated-evidence-' + calls }) }),
    semanticPlanner: async input => {
      calls++;
      assert.equal(input.workMode, 'draft_only');
      return { action: input.facts[0].reviewedSource ? 'prepare' : 'defer', reason: 'Use the approved source bytes.', claimIds: [claimId] };
    } });
  const mandate = core.createMandate({ objective: 'Read a historical source for the owner', workMode: 'draft_only',
    trustScope: { claimIds: [claimId] }, budget: { currency: 'CNY', limitMinor: 5 }, idempotencyKey: 'same-private-review' }, owner);
  const task = core.createTask({ mandateId: mandate.id, idempotencyKey: 'one-private-task', title: 'Read the original source',
    input: { provenance: 'owner_request', opportunity: { title: 'Read the original source', claimIds: [claimId] } } }, owner);
  const discover = () => runBotStep(core, operations, core.claim({taskId: task.id, kinds: ['discover']}, worker), worker);
  const resume = () => {
    const current = core.getTask(task.id, owner);
    core.controlTask(task.id, { action: 'resume', expectedRevision: current.revision, idempotencyKey: 'resume-' + current.revision }, owner);
  };
  await discover();
  const initial = core.getTask(task.id, owner);
  assert.equal(initial.state, 'waiting_input');
  assert.equal(initial.steps[0].output.assessment.action, 'defer');
  assert.match(initial.steps[0].output.assessmentInputHash, /^[a-f0-9]{64}$/);
  resume();
  await discover();
  assert.equal(calls, 1);
  assert.equal(core.getBudget(mandate.id, owner).spentMinor, 1);
  // The earlier worker persisted the waiting code while dropping the assessment checkpoint.
  resume();
  const oldLease = core.claim({ taskId: task.id, kinds: ['discover'] }, worker);
  core.report({ id: oldLease.id, epoch: oldLease.epoch, status: 'waiting_input',
    output: { code: 'BOT_PRIVATE_DRAFT_DEFERRED', dataMode: 'real' } }, worker);
  resume();
  await discover();
  assert.equal(core.getTask(task.id, owner).state, 'waiting_input');
  assert.equal(calls, 1);
  assert.equal(core.getBudget(mandate.id, owner).spentMinor, 1);
  fact.reviewedSource = { excerpt: 'Original approved text.', sha256: 'a'.repeat(64) };
  resume();
  await discover();
  assert.equal(calls, 2);
  assert.deepEqual(core.listCosts(owner, mandate.id).map(row => [row.state, row.actualMinor]), [['settled',1], ['settled',1]]);
  const reviewed = core.getTask(task.id, owner);
  assert.ok(reviewed.steps.some(step => step.kind === 'prepare'));
  assert.equal(JSON.stringify(reviewed).includes('Original approved text.'), false);

  const uncertainTask = core.createTask({ mandateId: mandate.id, idempotencyKey: 'unresolved-prior-decision',
    title: 'Read the original source', input: { provenance: 'owner_request', opportunity: { claimIds: [claimId] } } }, owner);
  const pending = core.claim({ taskId: uncertainTask.id, kinds: ['discover'] }, worker);
  const cost = core.reserveCost({ id: pending.id, epoch: pending.epoch, requestKey: 'an-older-provider-request',
    currency: 'CNY', reservedMinor: 2 }, worker);
  core.markCostDispatched({ costId: cost.id, id: pending.id, epoch: pending.epoch }, worker);
  const withPending = core.checkpoint({ id: pending.id, epoch: pending.epoch,
    output: { code: 'BOT_PRIVATE_DRAFT_DEFERRED', dataMode: 'real' } }, worker);
  await runBotStep(core, operations, withPending, worker);
  assert.equal(calls, 2);
  assert.equal(core.getTask(uncertainTask.id, owner).state, 'needs_reconcile');
  assert.equal(core.listCosts(owner, mandate.id).find(row => row.id === cost.id).state, 'unknown');
});

test('same-origin authenticated preview is side-effect-free and exact revision revocation leaves the other mandate active', async t => {
  const core = createBotCore({ clock: () => today.getTime() });
  const server = createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); core.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const inventory = { accounts: [], facts: [{ id: 'fact-A', label: 'First approved fixture fact' }],
    content: { verifiedClaims: 3, stories: 1, verifiedPublicReleases: 0 }, modelReady: false };
  const password = 'workbench-onboarding-fixture-password';
  const handler = createBotHttp({ core, ctx: owner, ownerPassword: password, origin, clock: () => today.getTime(),
    describeOnboarding: () => inventory });
  const request = (path, options) => fetch(origin + path, options);
  const asset = await request('/bot/mandate-draft.js');
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /parseMandateDraft/u);
  assert.equal((await request('/api/bot/v1/dashboard')).status, 401);
  const login = await request('/api/bot/v1/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }) });
  assert.equal(login.status, 201);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await login.json();
  const dashboard = await request('/api/bot/v1/dashboard', { headers: { Cookie: cookie } });
  assert.deepEqual((await dashboard.json()).onboarding, inventory);
  const post = (path, key, payload, overrides) => request(`/api/bot/v1${path}`, { method: 'POST', headers: { Cookie: cookie,
    Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': key,
    ...overrides }, body: JSON.stringify(payload) });
  const proposed = { objective: 'Track evidence, only research', workMode: 'research_only' };
  const preview = await post('/mandates/preview', 'draft-preview', proposed);
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).workMode, 'research_only');
  assert.deepEqual(core.listMandates(owner), []);
  const chosen = await (await post('/mandates', 'draft-create-a', proposed)).json();
  const spared = await (await post('/mandates', 'draft-create-b', { objective: 'Other mandate' })).json();
  const selection = stopMandateSelection('停发', chosen.id, [chosen, spared], owner.actorId, today.getTime());
  const route = `/mandates/${selection.id}/revoke`;
  const reason = { reason: 'owner_revoked' };
  assert.equal((await post(route, 'draft-revoke', reason, { Origin: 'https://elsewhere.example', 'If-Match': '1' })).status, 403);
  assert.equal((await post(route, 'draft-revoke', reason, { 'X-CSRF-Token': 'x'.repeat(43), 'If-Match': '1' })).status, 403);
  assert.equal((await post(route, 'draft-revoke', reason, { 'If-Match': '0' })).status, 412);
  const revoke = await post(route, 'draft-revoke', reason, { 'If-Match': String(selection.revision) });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).state, 'revoked');
  assert.equal(core.getMandate(spared.id, owner).state, 'active');
});
