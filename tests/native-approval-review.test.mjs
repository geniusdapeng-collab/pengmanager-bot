import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { articleSceneBinding, articleSceneFraming } from '../src/video-runtime/article-visuals.mjs';
import { createNativeApprovalReviewer } from '../src/video-runtime/native-approval-review.mjs';
import { SCOPE } from '../src/video-runtime/config.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, { overlay = false, styleYear } = {}) {
  const dataRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pm-ai-approval-')));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const { key, threadId } = articleSceneBinding({ planId: 'ILP-00001', slotId: 'slot-3', sourceHash: 'a'.repeat(64) });
  const staging = path.join(dataRoot, 'article-scenes', key);
  const output = path.join(dataRoot, 'tools', 'compositor', 'tenants', SCOPE.workspaceId, 'out', 'article-scenes', key);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const width = 512, height = 384;
  const sourcePath = path.join(staging, 'source.png'), overlayPath = path.join(staging, 'overlay.png');
  const source = await sharp({ create: { width, height, channels: 3, background: '#3658a0' } }).png().toBuffer();
  await writeFile(sourcePath, source, { mode: 0o600 });
  const framed = articleSceneFraming({ mode: 'detail', focusX: 30, focusY: 80 }, { width, height });
  const layers = [{ type: 'image', name: 'scene', source: sourcePath, ...framed.photo, opacity: 1 }];
  let overlaySha = null;
  if (overlay) {
    const marker = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#cc3388ff' } }).png().toBuffer();
    const bytes = await sharp({ create: { width, height, channels: 4, background: '#00000000' } })
      .composite([{ input: marker, left: 100, top: 100 }]).png().toBuffer();
    await writeFile(overlayPath, bytes, { mode: 0o600 });
    overlaySha = sha(bytes);
    layers.push({ type: 'image', name: 'article-detail', source: overlayPath, x: 0, y: 0, width, height, opacity: 1 });
  }
  const params = { source_image_sha256: sha(source), overlay_asset_sha256: overlaySha,
    has_portrait: false, has_third_party_asset: false, declared_source_kind: 'imagegen', image_generation_required: true,
    design_brief: { storyId: 'STY-00002', articleTitle: '门店交接', sceneDescription: '夜班员工核对实际交接现场。',
      ...(styleYear === undefined ? {} : { styleYear }) },
    design_brief_sha256: 'c'.repeat(64), scene_framing: framed, out_dir: output, recipe_status: 'pending_review',
    recipe: { recipe_version: 1, name: 'article-scene', canvas: { width, height, resolution: 72 }, layers, exports: [{ format: 'png', path: 'scene.png' }] } };
  return { dataRoot, sourcePath, record: { ...SCOPE, approvalId: 'apr-e-1', eventId: 'E-1', threadId,
    snapshot: { step_fingerprint: 'native-fixture', params }, event: { who: { type: 'agent', id: 'visual-designer' },
      object: { type: 'design_recipe' }, rule_impact: [{ rule_id: 'G-VIS4', result: 'review' }],
      decision: { action: 'visualwrite.compose', kind: 'review', tool: 'visualwrite.compose', step_id: 's1', fingerprint: 'native-fixture', params } } } };
}

function responseFor(prepared, edits = {}) {
  return { value: { outcome: 'approve', evidenceHash: prepared.evidenceHash, reason: '物件位置和层级与场景一致。',
    checks: Object.fromEntries(prepared.checks.map(key => [key, true])), ...edits },
  receipt: { schemaVersion: 'workloom.model-receipt/v1', policy: { scene: 'approval.native' }, registry: { provider: 'deepseek' },
    requestedModel: 'deepseek-flash', returnedModel: 'deepseek-flash', finishReason: 'stop', responseId: 'isolated-model-response',
    requestHash: '1'.repeat(64), responseHash: '2'.repeat(64), contentHash: '3'.repeat(64), policyHash: '4'.repeat(64),
    usage: { inputTokens: 970, outputTokens: 55, totalTokens: 1025 } } };
}

test('native AI receives the byte-bound crop and overlay through the structured vision dispatcher', async t => {
  const { dataRoot, record, sourcePath } = await fixture(t, { overlay: true });
  let response, called = 0;
  const reviewer = createNativeApprovalReviewer({ dataRoot, dispatcher: { async completeTask(request) {
    called += 1;
    assert.equal(request.scene, 'approval.native');
    assert.equal(request.messages[1].content.length, 2);
    const url = request.messages[1].content[1].image_url.url;
    const png = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
    assert.equal(sha(png), prepared.body.submission.previewSha256);
    assert.equal((await sharp(png).metadata()).width, 512);
    assert.doesNotMatch(request.messages[1].content[0].text, /\/article-scenes\//);
    return response;
  } } });
  const prepared = await reviewer.prepare(record);
  response = responseFor(prepared);
  const verdict = await reviewer.review(prepared);
  assert.equal(verdict.providerReceipt.model, 'deepseek-flash');
  assert.equal(verdict.outcome, 'approve');
  response = responseFor(prepared, { evidenceHash: 'e'.repeat(64) });
  await assert.rejects(reviewer.review(prepared), { code: 'NATIVE_APPROVAL_VERDICT_INVALID' });
  response = responseFor(prepared, { checks: { sceneFit: false, framing: true, readability: true, visualSafety: true } });
  await assert.rejects(reviewer.review(prepared), { code: 'NATIVE_APPROVAL_VERDICT_INVALID' });
  response = responseFor(prepared);
  delete response.receipt.usage;
  await assert.rejects(reviewer.review(prepared), { code: 'NATIVE_APPROVAL_RECEIPT_INVALID' });
  assert.equal(called, 4);
  await writeFile(sourcePath, await sharp({ create: { width: 512, height: 384, channels: 3, background: '#983e23' } }).png().toBuffer());
  await assert.rejects(reviewer.prepare(record), { code: 'ARTICLE_SCENE_BYTES_CHANGED' });
  await assert.rejects(reviewer.prepare({ ...record, workspaceId: 'foreign-workspace' }), { code: 'NATIVE_APPROVAL_SCOPE_INVALID' });
});


test('new native reviews require a contemporary style verdict grounded in reviewed pixels', async t => {
  const { dataRoot, record } = await fixture(t, { styleYear: 2026 });
  let verdict;
  const reviewer = createNativeApprovalReviewer({ dataRoot, dispatcher: { async completeTask({ messages }) {
    const [instruction, image] = messages[1].content;
    assert.match(instruction.text, /contemporaryStyle.*2026 年/u);
    assert.match(instruction.text, /门店、工厂/u);
    assert.match(instruction.text, /不得仅根据简报/u);
    const imageBytes = Buffer.from(image.image_url.url.split(',')[1], 'base64');
    assert.equal(sha(imageBytes), prepared.body.submission.previewSha256);
    return verdict;
  } } });
  const prepared = await reviewer.prepare(record);
  assert.ok(prepared.checks.includes('contemporaryStyle'));
  verdict = responseFor(prepared);
  assert.equal((await reviewer.review(prepared)).checks.contemporaryStyle, true);
  const oldChecks = { ...verdict.value.checks };
  delete oldChecks.contemporaryStyle;
  verdict = responseFor(prepared, { checks: oldChecks });
  await assert.rejects(reviewer.review(prepared), { code: 'NATIVE_APPROVAL_VERDICT_INVALID' });
  const checks = { ...oldChecks, contemporaryStyle: false };
  verdict = responseFor(prepared, { checks });
  await assert.rejects(reviewer.review(prepared), { code: 'NATIVE_APPROVAL_VERDICT_INVALID' });
  verdict = responseFor(prepared, { outcome: 'reject', reason: '画面使用陈旧办公设备。', checks });
  assert.equal((await reviewer.review(prepared)).outcome, 'reject');
});
