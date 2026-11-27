import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashObject } from '../src/domain/hash.mjs';
import { articleSceneBinding, articleSceneFraming, articleSceneProof, articleSceneStatement, articleSceneWorkOrder } from '../src/video-runtime/article-visuals.mjs';
import { articleIllustrationSceneBriefHash, validateIllustrationEvidence } from '../src/domain/article-illustrations.mjs';
import { createWorkbenchServer } from '../src/video-runtime/web.mjs';
import { parseVideoArgs } from '../scripts/video-cli.mjs';

const sourceHash = 'a'.repeat(64);
const sourceSha = 'b'.repeat(64);
const outputSha = 'c'.repeat(64);
function workOrder(imageGeneration = true) {
  const result = { schema: 'pengmanager.article-illustration-work-order/v1', planId: 'AIP-01', storyId: 'STY-01',
    sourceHash, title: '夜班交接', slot: { id: 'scene', kind: 'scene', imageGeneration, description: '员工用交接单回看现场处置。' } };
  result.slot.sceneBriefHash = articleIllustrationSceneBriefHash({ ...result, slotId: result.slot.id,
    articleTitle: result.title, sceneDescription: result.slot.description, imageGeneration });
  return result;
}
const order = workOrder();

test('article-only launcher keeps the native full workbench mode separate', () => {
  assert.equal(parseVideoArgs(['--with-article-workbench'], 'start').articleWorkbenchOnly, true);
  assert.throws(() => parseVideoArgs(['--with-article-workbench', '--with-workbench'], 'start'), { code: 'ARGUMENT_INVALID' });
  assert.throws(() => parseVideoArgs(['--with-article-workbench'], 'setup'), { code: 'ARGUMENT_INVALID' });
});

test('scene framing preserves the canvas, actually changes crop and clamps operator focus at the edges', () => {
  const image = { width: 1536, height: 1024 };
  const context = articleSceneFraming({ mode: 'environment', focusX: 0, focusY: 0 }, image);
  const detail = articleSceneFraming({ mode: 'detail', focusX: 100, focusY: 100 }, image);
  assert.equal(context.width, detail.width);
  assert.equal(context.height, detail.height);
  assert.equal(context.photo.x, 0);
  assert(detail.photo.width > context.photo.width);
  assert.equal(detail.photo.x + detail.photo.width, image.width);
  assert.equal(detail.photo.y + detail.photo.height, image.height);
  assert.throws(() => articleSceneFraming({ mode: 'environment', focusX: 101, focusY: 10 }, image), { code: 'ARTICLE_SCENE_FRAMING_INVALID' });
});

function ledgerFixture(input = order) {
  const binding = articleSceneWorkOrder(input);
  const outputPath = '/private/fixture/work/scene.png';
  const image = { sha256: outputSha, bytes: 143408, width: 1024, height: 768 };
  const agent = { type: 'agent', id: 'visual-designer' };
  const recipe = { who: agent, object: { type: 'design_recipe' }, rule_impact: [{ rule_id: 'G-VIS4', result: 'review' }],
    decision: { action: 'visualwrite.compose', kind: 'review', tool: 'visualwrite.compose', step_id: 's1', fingerprint: 'fixture-fingerprint',
      params: { source_image_sha256: sourceSha, image_generation_required: binding.imageGeneration,
        declared_source_kind: binding.imageGeneration ? 'imagegen' : 'authorized_asset',
        design_brief: binding.brief, design_brief_sha256: binding.briefHash } } };
  const gesture = { who: { type: 'human', id: 'MEM-001' }, object: { type: 'review', id: 'E-1' }, links: ['E-1'],
    decision: { action: 'approval.gesture', after: { gesture: 'approve', approvalId: 'apr-e-1' } } };
  const real = { mode: 'real', synced: true };
  return { binding, thread: { id: binding.threadId, title: `视觉工位任务：${binding.marker} 夜班交接`, mode: 'quest',
    preset_key: 'visual-designer', status: 'completed', plan_version: 1, progress_done: 2, progress_total: 2 },
  review: { review_payload: recipe, approval_id: 'apr-e-1', event_id: 'E-1', review_seq: '1',
    gesture_payload: gesture, gesture_event_id: 'E-2', gesture_seq: '2', status: 'approved', decided_by: 'MEM-001' },
  events: [{ event_id: 'E-3', seq: '3', payload: { who: agent, receipt: real,
    decision: { action: 'visualwrite.compose', kind: 'execute', tool: 'visualwrite.compose', step_id: 's1',
      fingerprint: 'fixture-fingerprint', after: { result: { ok: true, outputs: [{ output: outputPath, sha256: outputSha, bytes: image.bytes }] } } } } },
  { event_id: 'E-4', seq: '4', payload: { who: agent, receipt: real,
    decision: { action: 'visualread.verify', kind: 'execute', tool: 'visualread.verify', step_id: 's2',
      after: { result: { ok: true, path: outputPath, sha256: outputSha, size_bytes: image.bytes, image: { width: image.width, height: image.height } } } } } }],
  outputPath, image, sourceSha };
}

test('native scene proof binds exact work order, human gesture, verified bytes and provider input digest', () => {
  const fixture = ledgerFixture();
  const statement = articleSceneStatement(fixture);
  assert.equal(statement.sceneBriefHash, order.slot.sceneBriefHash);
  assert.equal(statement.imageGenInputSha256, sourceSha);
  assert.equal(statement.sha256, outputSha);
  assert.equal(statement.gestureEventId, 'E-2');
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicReceipt = articleSceneProof(null, privateKey);
  const proof = articleSceneProof(statement, privateKey);
  assert.equal(proof.producerKeyId, publicReceipt.producerKeyId);
  const publicKey = createPublicKey({ key: Buffer.from(publicReceipt.publicKey, 'base64url'), type: 'spki', format: 'der' });
  const sorted = Object.fromEntries(Object.keys(statement).sort().map(key => [key, statement[key]]));
  assert.equal(verify(null, Buffer.from(JSON.stringify(sorted)), publicKey, Buffer.from(proof.signature, 'base64url')), true);
  assert.equal('imageGenInputSha256' in articleSceneStatement(ledgerFixture(workOrder(false))), false);
  assert.throws(() => articleSceneWorkOrder({ ...order, slot: { ...order.slot, kind: 'logic' } }), { code: 'ARTICLE_SCENE_WORK_ORDER_INVALID' });
});

test('native G-VIS4 scene proof is accepted by editorial only for the exact scene brief', () => {
  const input = workOrder(false), ledger = ledgerFixture(input);
  const { privateKey } = generateKeyPairSync('ed25519');
  const key = articleSceneProof(null, privateKey);
  const proof = articleSceneProof(articleSceneStatement(ledger), privateKey);
  const plan = { id: input.planId, storyId: input.storyId, title: input.title, sourceHash };
  const asset = { kind: 'image', status: 'reviewed', id: 'MED-fixture', size: ledger.image.bytes,
    sha256: outputSha, width: ledger.image.width, height: ledger.image.height,
    review: { sha256: outputSha, rightsConfirmed: true, privacyConfirmed: true } };
  const request = { slotId: input.slot.id, assetId: asset.id, sha256: asset.sha256, designerCompositor: proof };
  const keys = [{ id: key.producerKeyId, publicKey: key.publicKey }];
  assert.equal(validateIllustrationEvidence(request, plan, input.slot, asset, keys).assetId, asset.id);
  const changedSlot = { ...input.slot, description: '另一段图位描述。' };
  assert.throws(() => articleSceneWorkOrder({ ...input, slot: changedSlot }), { code: 'ARTICLE_SCENE_BRIEF_MISMATCH' });
  assert.throws(() => validateIllustrationEvidence(request, plan, changedSlot, asset, keys), { code: 'ILLUSTRATION_SCENE_BRIEF_MISMATCH' });
  assert.throws(() => validateIllustrationEvidence(request, { ...plan, storyId: 'STY-02' }, input.slot, asset, keys), { code: 'ILLUSTRATION_SCENE_BRIEF_MISMATCH' });
});

test('AI scene receipt binds the system actor and its original attempt without reusing the owner identity', () => {
  const input = workOrder(false), fixture = ledgerFixture(input);
  const actor = { type: 'system', id: 'review-console' };
  const evidenceHash = 'd'.repeat(64);
  const verdict = { outcome: 'approve', evidenceHash, reason: '取景清晰，符合场景。', checks: { sceneFit: true },
    providerReceipt: { provider: 'deepseek', responseId: 'isolated-fixture', requestHash: 'e'.repeat(64) } };
  const decisionHash = hashObject(verdict);
  fixture.events[0].seq = '4';
  fixture.events[1].seq = '5';
  fixture.events.unshift({ event_id: 'E-2', seq: '2', payload: { who: actor,
    decision: { action: 'approval.ai_attempt_started', after: { approvalId: 'apr-e-1', evidenceHash } } } });
  Object.assign(fixture.review, { decided_by: 'review-console', gesture_event_id: 'E-3', gesture_seq: '3',
    gesture_payload: { who: actor, object: { type: 'review', id: 'E-1' }, links: ['E-1', 'E-2'],
      decision: { action: 'approval.ai_decision', after: { approvalId: 'apr-e-1', authority: 'ai', decisionHash, ...verdict } } } });
  const statement = articleSceneStatement(fixture);
  assert.equal(statement.approvalAuthority, 'ai');
  assert.equal(statement.approvalDecisionHash, decisionHash);
  assert.equal(statement.gestureEventId, 'E-3');
  const { privateKey } = generateKeyPairSync('ed25519');
  const key = articleSceneProof(null, privateKey);
  const plan = { id: input.planId, storyId: input.storyId, title: input.title, sourceHash };
  const asset = { kind: 'image', status: 'reviewed', id: 'MED-fixture', size: fixture.image.bytes,
    sha256: outputSha, width: fixture.image.width, height: fixture.image.height,
    review: { sha256: outputSha, rightsConfirmed: true, privacyConfirmed: true } };
  const keys = [{ id: key.producerKeyId, publicKey: key.publicKey }];
  const bindingRequest = designerCompositor => ({ slotId: input.slot.id, assetId: asset.id, sha256: asset.sha256, designerCompositor });
  assert.equal(validateIllustrationEvidence(bindingRequest(articleSceneProof(statement, privateKey)), plan, input.slot, asset, keys).assetId, asset.id);
  assert.throws(() => validateIllustrationEvidence(bindingRequest(articleSceneProof({ ...statement, approvalDecisionHash: 'bad' }, privateKey)),
    plan, input.slot, asset, keys), { code: 'ILLUSTRATION_RECEIPT_MISMATCH' });
  const mismatched = structuredClone(fixture);
  mismatched.review.gesture_payload.decision.after.reason = '更换原因';
  assert.throws(() => articleSceneStatement(mismatched), { code: 'ARTICLE_SCENE_REVIEW_UNVERIFIED' });
  fixture.events.shift();
  assert.throws(() => articleSceneStatement(fixture), { code: 'ARTICLE_SCENE_REVIEW_UNVERIFIED' });
});

test('scene proof rejects old or different threads, simulated receipts, altered source and output bytes and mismatched gesture', () => {
  const frozen = ledgerFixture();
  const change = edits => { const fixture = structuredClone(frozen); edits(fixture); return fixture; };
  for (const [alter, code] of [
    [f => { f.thread.status = 'pending_review'; }, 'ARTICLE_SCENE_NOT_COMPLETE'],
    [f => { f.binding = articleSceneBinding({ ...f.binding, slotId: 'other' }); }, 'ARTICLE_SCENE_NOT_COMPLETE'],
    [f => { f.review.gesture_payload.who.type = 'agent'; }, 'ARTICLE_SCENE_REVIEW_UNVERIFIED'],
    [f => { f.review.gesture_payload.object.id = 'E-OTHER'; }, 'ARTICLE_SCENE_REVIEW_UNVERIFIED'],
    [f => { f.review.review_payload.rule_impact = []; }, 'ARTICLE_SCENE_REVIEW_UNVERIFIED'],
    [f => { f.events[0].payload.receipt.mode = 'simulated'; }, 'ARTICLE_SCENE_RECEIPTS_UNVERIFIED'],
    [f => { f.events[1].seq = '2'; }, 'ARTICLE_SCENE_RECEIPTS_UNVERIFIED'],
    [f => { f.image.sha256 = 'd'.repeat(64); }, 'ARTICLE_SCENE_BYTES_CHANGED'],
    [f => { delete f.review.review_payload.decision.params.design_brief_sha256; }, 'ARTICLE_SCENE_BRIEF_MISMATCH'],
    [f => { f.review.review_payload.decision.params.design_brief.sceneDescription = '原生审批后出现新的描述。'; }, 'ARTICLE_SCENE_BRIEF_MISMATCH'],
    [f => { f.sourceSha = 'd'.repeat(64); }, 'ARTICLE_SCENE_BYTES_CHANGED'],
    [f => { f.review.review_payload.decision.params.overlay_asset_sha256 = 'e'.repeat(64); }, 'ARTICLE_SCENE_BYTES_CHANGED'],
  ]) assert.throws(() => articleSceneStatement(change(alter)), { code });
});

test('workbench scene handoff requires its HttpOnly cookie, current origin and CSRF', async t => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pm-scene-workbench-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seen = [];
  const server = createWorkbenchServer({ config: { ports: { web: port, backend: 1 }, webRoot: directory, articleWorkbenchOnly: true },
    nativeSession: () => { throw new Error('test must use only the explicit scene routes'); }, health: () => ({}), safe: String,
    articleVisuals: async (action, input) => { seen.push([action, input]); return { state: 'pending_review' }; } });
  await server.start();
  t.after(() => server.stop());
  const page = await fetch(`${base}/article-visuals`);
  assert.equal(page.status, 200);
  assert.equal((await fetch(`${base}/ai-video/assets`)).status, 404);
  const cookie = page.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /name="workOrderFile"/);
  assert.doesNotMatch(html, /批准此配方并继续合成/);
  assert.doesNotThrow(() => new Function(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]));
  const csrf = JSON.parse(html.match(/const csrf = ("[a-f0-9]+");/)[1]);
  const post = (headers, endpoint = 'status', body = '{}') => fetch(`${base}/_pengmanager/video/article-scenes/${endpoint}`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await post({}, 'status')).status, 403);
  const valid = { cookie: cookie.split(';')[0], origin: base, 'x-pengmanager-video-csrf': csrf };
  assert.equal((await post({ ...valid, origin: 'https://foreign.example' })).status, 403);
  assert.equal((await post({ ...valid, 'x-pengmanager-video-csrf': 'wrong' }, 'source')).status, 403);
  assert.equal((await post(valid, 'approve')).status, 404);
  assert.equal((await post(valid, 'run-arbitrary')).status, 404);
  assert.equal((await post(valid, 'status', '[]')).status, 400);
  assert.equal((await post(valid)).status, 200);
  assert.deepEqual(seen, [['status', {}]]);
});
