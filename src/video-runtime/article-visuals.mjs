import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { articleIllustrationStyleRule, isArticleIllustrationStyleYear } from '../../public/article-illustration-style.js';
import { inspectMediaBytes } from '../services/media-assets.mjs';
import { genericProductNamingFindings } from '../domain/product-naming.mjs';
import { articleIllustrationSceneBriefHash } from '../domain/article-illustrations.mjs';
import { hashObject } from '../domain/hash.mjs';
import { scanSensitiveText } from '../domain/policy.mjs';
import { inside, privateDirectory, SCOPE, VideoRuntimeError } from './config.mjs';
import { readArticleWorkspaceStage } from './article-workspace-stage.mjs';

export const ARTICLE_SCENE_MAX_BYTES = 16 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRESET = 'visual-designer';
const RULE = 'G-VIS4';
const SOURCE = 'pengmanager-designer-compositor';
const own = process.getuid?.();

function fail(code, message) { throw new VideoRuntimeError(code, message); }
function require(condition, code, message) { if (!condition) fail(code, message); }
const digest = value => createHash('sha256').update(value).digest('hex');

export function articleSceneBinding({ planId, slotId, sourceHash }) {
  require(typeof planId === 'string' && typeof slotId === 'string' && ID.test(planId) && ID.test(slotId)
    && typeof sourceHash === 'string' && SHA.test(sourceHash), 'ARTICLE_SCENE_BINDING_INVALID', '请填写有效的插图计划、图位及原稿摘要。');
  const key = digest(JSON.stringify(['pengmanager-article-scene/v1', planId, slotId, sourceHash]));
  return { planId, slotId, sourceHash, key, threadId: `thr-pm-visual-${key}`, marker: `PM-ARTICLE-SCENE:${key}` };
}

export function articleSceneWorkOrder(order) {
  require(order?.schema === 'pengmanager.article-illustration-work-order/v1' && order.slot?.kind === 'scene'
    && typeof order.storyId === 'string' && ID.test(order.storyId) && typeof order.title === 'string' && order.title.trim().length > 0
    && order.title.length <= 300 && typeof order.slot.description === 'string' && order.slot.description.trim().length > 0
    && order.slot.description.length <= 1500 && typeof order.slot.imageGeneration === 'boolean',
    'ARTICLE_SCENE_WORK_ORDER_INVALID', '请选择编辑出版导出的场景图工单。');
  const binding = articleSceneBinding({ planId: order.planId, slotId: order.slot.id, sourceHash: order.sourceHash });
  const { styleYear } = order;
  require(styleYear === undefined || isArticleIllustrationStyleYear(styleYear) && order.visualStyle === articleIllustrationStyleRule('scene', styleYear),
    'ARTICLE_SCENE_STYLE_INVALID', '工作单的当代风格要求不一致，请重新从编辑出版下载。');
  const brief = { storyId: order.storyId, articleTitle: order.title.trim(), sceneDescription: order.slot.description.trim(),
    ...(styleYear === undefined ? {} : { styleYear }) };
  const imageGeneration = order.slot.imageGeneration;
  const briefHash = articleIllustrationSceneBriefHash({ ...binding, ...brief, imageGeneration });
  require(order.slot.sceneBriefHash === briefHash, 'ARTICLE_SCENE_BRIEF_MISMATCH', '工单的场景简报已变化或缺少摘要，请重新从编辑出版下载。');
  return { ...binding, imageGeneration, brief, briefHash };
}

export function articleSceneFraming({ mode, focusX, focusY }, { width, height }) {
  require(['environment', 'detail'].includes(mode) && [focusX, focusY].every(value=>Number.isInteger(value)&&value>=0&&value<=100),
    'ARTICLE_SCENE_FRAMING_INVALID', '请选择现场或细节取景并设置有效的画面焦点。');
  const zoom = mode === 'detail' ? 1.38 : 1.15;
  const scaledWidth = Math.ceil(width * zoom), scaledHeight = Math.ceil(height * zoom);
  // Align the selected content to the center when possible and clamp at source edges.
  const offset = (original, scaled, focus) => Math.round(Math.max(original - scaled, Math.min(0, original / 2 - scaled * focus / 100)));
  return { mode, focusX, focusY, width, height,
    photo: { x: offset(width, scaledWidth, focusX), y: offset(height, scaledHeight, focusY), width: scaledWidth, height: scaledHeight } };
}

function reviewEvent(payload) {
  return payload?.who?.type === 'agent' && payload.who.id === PRESET
    && payload?.object?.type === 'design_recipe' && payload?.decision?.kind === 'review'
    && payload.decision.action === 'visualwrite.compose' && payload.decision.tool === 'visualwrite.compose'
    && payload.decision.step_id === 's1' && typeof payload.decision.fingerprint === 'string'
    && payload.rule_impact?.some(item => item.rule_id === RULE && item.result === 'review');
}

function realExecution(row, action, step) {
  const event = row.payload;
  return event?.who?.type === 'agent' && event.who.id === PRESET && event?.decision?.kind === 'execute'
    && event.decision.action === action && event.decision.tool === action && event.decision.step_id === step
    && event.receipt?.mode === 'real' && event.receipt.synced === true;
}

function threadMatches(thread, binding) {
  return thread.id === binding.threadId && thread.preset_key === PRESET && thread.mode === 'quest'
    && thread.title.startsWith(`视觉工位任务：${binding.marker} `);
}

function reviewedSceneBriefHash(binding, params) {
  const brief = params?.design_brief;
  require(typeof brief?.storyId === 'string' && ID.test(brief.storyId)
    && typeof brief.articleTitle === 'string' && brief.articleTitle.trim().length > 0 && brief.articleTitle.length <= 300
    && typeof brief.sceneDescription === 'string' && brief.sceneDescription.trim().length > 0 && brief.sceneDescription.length <= 1500
    && typeof params.image_generation_required === 'boolean'
    && (brief.styleYear === undefined || isArticleIllustrationStyleYear(brief.styleYear)),
    'ARTICLE_SCENE_BRIEF_MISMATCH', '原生审核缺少准确场景简报，请从当前文章图位重新准备。');
  const briefHash = articleIllustrationSceneBriefHash({ ...binding, storyId: brief.storyId, articleTitle: brief.articleTitle,
    sceneDescription: brief.sceneDescription, imageGeneration: params.image_generation_required, styleYear: brief.styleYear });
  require(params.design_brief_sha256 === briefHash, 'ARTICLE_SCENE_BRIEF_MISMATCH', '原生审核的场景简报与工单摘要不一致。');
  return briefHash;
}

export function articleSceneStatement({ binding, thread, review, events, outputPath, image, sourceSha, overlaySha = null }) {
  require(threadMatches(thread, binding) && thread.status === 'completed' && thread.plan_version === 1
    && thread.progress_done === 2 && thread.progress_total === 2, 'ARTICLE_SCENE_NOT_COMPLETE', '原生设计任务尚无完整的两步成品。');
  const gesture = review?.gesture_payload;
  const decision = gesture?.decision?.after;
  const modelApproved = gesture?.who?.type === 'system' && gesture.who.id === 'review-console' && review?.decided_by === 'review-console'
    && gesture.decision.action === 'approval.ai_decision' && decision?.authority === 'ai' && decision?.outcome === 'approve'
    && SHA.test(decision?.decisionHash ?? '') && SHA.test(decision?.evidenceHash ?? '')
    && decision.decisionHash === hashObject({ outcome: decision.outcome, evidenceHash: decision.evidenceHash,
      reason: decision.reason, checks: decision.checks, providerReceipt: decision.providerReceipt })
    && events.some(row => row.payload?.who?.type === 'system' && row.payload.who.id === 'review-console' &&
      row.payload.decision?.action === 'approval.ai_attempt_started' && row.payload.decision.after?.evidenceHash === decision.evidenceHash &&
      row.payload.decision.after?.approvalId === review.approval_id && gesture.links?.includes(row.event_id) &&
      BigInt(review.review_seq) < BigInt(row.seq) && BigInt(row.seq) < BigInt(review.gesture_seq));
  const legacyApproved = gesture?.who?.type === 'human' && gesture.who.id === review?.decided_by && review?.decided_by === SCOPE.memberNo
    && gesture.decision?.action === 'approval.gesture' && decision?.gesture === 'approve';
  require(review?.status === 'approved' && reviewEvent(review.review_payload)
    && (modelApproved || legacyApproved) && gesture.object?.type === 'review' && gesture.object.id === review.event_id
    && gesture.links?.includes(review.event_id) && decision.approvalId === review.approval_id,
    'ARTICLE_SCENE_REVIEW_UNVERIFIED', '没有与该配方绑定的原生批准。');
  const compositions = events.filter(row => realExecution(row, 'visualwrite.compose', 's1')
    && row.payload.decision.fingerprint === review.review_payload.decision.fingerprint);
  const verifications = events.filter(row => realExecution(row, 'visualread.verify', 's2'));
  require(compositions.length === 1 && verifications.length === 1, 'ARTICLE_SCENE_RECEIPTS_UNVERIFIED', '需要唯一的真实合成和校验回执。');
  const [compose] = compositions, [verify] = verifications;
  require(BigInt(review.review_seq) < BigInt(review.gesture_seq) && BigInt(review.gesture_seq) < BigInt(compose.seq)
    && BigInt(compose.seq) < BigInt(verify.seq), 'ARTICLE_SCENE_RECEIPTS_UNVERIFIED', '合成事件顺序与审批不一致。');
  const result = compose.payload.decision.after?.result;
  const output = Array.isArray(result?.outputs) && result.outputs.length === 1 ? result.outputs[0] : null;
  const checked = verify.payload.decision.after?.result;
  require(result?.ok === true && (output?.output ?? output?.path) === outputPath && output.sha256 === image.sha256
    && output.bytes === image.bytes && checked?.ok === true && checked.path === outputPath && checked.sha256 === image.sha256
    && checked.size_bytes === image.bytes && checked.image?.width === image.width && checked.image?.height === image.height,
    'ARTICLE_SCENE_BYTES_CHANGED', '成品字节与原生合成或校验事件不一致。');
  const params = review.review_payload.decision.params;
  if (params.design_brief?.styleYear !== undefined) {
    require(modelApproved && decision.checks?.contemporaryStyle === true,
      'ARTICLE_SCENE_STYLE_UNVERIFIED', '新版工作单需要 AI 对实际画幅通过当代风格检查。');
  }
  const sceneBriefHash = reviewedSceneBriefHash(binding, params);
  require(typeof sourceSha === 'string' && SHA.test(sourceSha) && params?.source_image_sha256 === sourceSha
    && typeof params.image_generation_required === 'boolean'
    && (params.overlay_asset_sha256 ?? null) === overlaySha
    && (!params.image_generation_required || params.declared_source_kind === 'imagegen'),
    'ARTICLE_SCENE_BYTES_CHANGED', '源图的实际字节与工单或已审配方不一致。');
  return { source: SOURCE, planId: binding.planId, slotId: binding.slotId, sourceHash: binding.sourceHash,
    sceneBriefHash,
    nativeThreadId: thread.id, approvedApprovalId: review.approval_id, gestureEventId: review.gesture_event_id,
    composeEventId: compose.event_id, verifyEventId: verify.event_id,
    sha256: image.sha256, bytes: image.bytes, width: image.width, height: image.height,
    ...(modelApproved ? { approvalAuthority: 'ai', approvalDecisionHash: decision.decisionHash } : {}),
    ...(params.image_generation_required ? { imageGenInputSha256: sourceSha } : {}) };
}

export function articleSceneProof(statement, privateKey) {
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const producerKeyId = `pk-${digest(publicKey).slice(0, 32)}`;
  if (!statement) return { producerKeyId, publicKey: publicKey.toString('base64url') };
  const sorted = Object.fromEntries(Object.keys(statement).sort().map(key => [key, statement[key]]));
  return { statement: sorted, signature: sign(null, Buffer.from(JSON.stringify(sorted)), privateKey).toString('base64url'), producerKeyId };
}

function scenePng(bytes) {
  require(bytes.length > 32 && bytes.length <= ARTICLE_SCENE_MAX_BYTES
    && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.readUInt32BE(16) >= 480 && bytes.readUInt32BE(20) >= 360
    && bytes.readUInt32BE(16) <= 4096 && bytes.readUInt32BE(20) <= 4096,
    'ARTICLE_SCENE_IMAGE_INVALID', '请选择宽 480–4096、高 360–4096 像素的完整 PNG。');
  const { width, height } = inspectMediaBytes(bytes, 'image/png');
  return { width, height, sha256: digest(bytes), bytes: bytes.length };
}

function scenePlan({ sourcePath, overlayPath, outputDir, outputPath, width, height, key, sha256, sourceKind,
  hasPortrait, hasThirdPartyAsset, imageGeneration, brief, briefHash, framing, overlaySha }) {
  const layers = [{ type: 'image', name: 'scene', source: sourcePath, ...framing.photo, opacity: 1 }];
  if (overlaySha) layers.push({ type: 'image', name: 'article-detail', source: overlayPath, x: 0, y: 0, width, height, opacity: 1 });
  const recipe = { recipe_version: 1, name: 'article-scene', canvas: { width, height, resolution: 72 }, layers,
    exports: [{ format: 'png', path: 'scene.png' }] };
  return [{ stepId: 's1', action: 'visualwrite.compose', objectType: 'design_recipe', tool: 'visualwrite.compose',
    objectId: `article-scene-${key}`, params: { recipe_status: 'pending_review', has_portrait: hasPortrait,
      has_third_party_asset: hasThirdPartyAsset, declared_source_kind: sourceKind, image_generation_required: imageGeneration,
      source_image_sha256: sha256, overlay_asset_sha256: overlaySha, design_brief: brief, design_brief_sha256: briefHash, scene_framing: framing,
      recipe, out_dir: outputDir }, label: '等待配方审核后合成场景图' },
  { stepId: 's2', action: 'visualread.verify', objectType: 'visual_asset', tool: 'visualread.verify',
    params: { path: outputPath, width, height, max_bytes: ARTICLE_SCENE_MAX_BYTES }, label: '核验真实成品字节和画幅' }];
}

function decodePng(value) {
  const bytes = Buffer.from(value, 'base64');
  require(bytes.toString('base64') === value, 'ARTICLE_SCENE_IMAGE_INVALID', 'PNG 字节编码无效。');
  return bytes;
}

async function reviewOverlay(bytes, source) {
  const overlay = scenePng(bytes);
  require(overlay.width === source.width && overlay.height === source.height,
    'ARTICLE_SCENE_OVERLAY_INVALID', '透明标注图层的画幅必须与源图一致。');
  const { default: sharp } = await import('sharp');
  const stats = await sharp(bytes, { limitInputPixels: 4096 * 4096 }).stats();
  require([4, 6].includes(bytes[25]) && !stats.isOpaque && stats.channels.at(-1)?.max > 0,
    'ARTICLE_SCENE_OVERLAY_INVALID', '标注图必须有实际透明区域和可见内容。');
  return overlay.sha256;
}

async function currentBytes(file, limit, { privateFile = false } = {}) {
  require(await realpath(file) === file, 'ARTICLE_SCENE_PATH_INVALID', '工位文件路径发生变化。');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    require(stat.isFile() && stat.size > 0 && stat.size <= limit && (own === undefined || own === stat.uid)
      && (!privateFile || !(stat.mode & 0o077)), 'ARTICLE_SCENE_PATH_INVALID', '工位文件权限、类型或大小不符合要求。');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const end = await handle.stat(), named = await lstat(file);
    require(offset === stat.size && end.size === stat.size && end.mtimeMs === stat.mtimeMs && named.isFile()
      && named.ino === stat.ino && named.dev === stat.dev && named.size === stat.size && named.mtimeMs === stat.mtimeMs,
      'ARTICLE_SCENE_BYTES_CHANGED', '读取期间工位文件发生变化，请重新核对。');
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

/** Only review pictures from the exact frozen native article recipe. No upload or caller path is accepted. */
export async function articleSceneAiEvidence(dataRoot, { threadId, event, snapshot }) {
  if (typeof threadId !== 'string' || !/^thr-pm-visual-[a-f0-9]{64}$/.test(threadId) || !reviewEvent(event)) return null;
  const key = threadId.slice('thr-pm-visual-'.length);
  const params = event.decision.params;
  const staging = path.join(dataRoot, 'article-scenes', key);
  const sourcePath = path.join(staging, 'source.png');
  const overlayPath = path.join(staging, 'overlay.png');
  require(params && snapshot.step_fingerprint === event.decision.fingerprint && hashObject(params) === hashObject(snapshot.params),
    'ARTICLE_SCENE_REVIEW_UNVERIFIED', '原生配方与审核快照不一致。');
  require(params.has_portrait === false && params.has_third_party_asset === false,
    'ARTICLE_SCENE_RIGHTS_EVIDENCE_REQUIRED', '需要可用于 AI 审核的完整肖像或第三方素材许可。');
  require(typeof params.design_brief?.sceneDescription === 'string' && SHA.test(params.design_brief_sha256 ?? '') &&
    ['authorized_asset', 'imagegen'].includes(params.declared_source_kind) &&
    (!params.image_generation_required || params.declared_source_kind === 'imagegen'),
    'ARTICLE_SCENE_BRIEF_MISMATCH', '原生场景缺少已冻结的简报或源图出处。');
  const source = await currentBytes(sourcePath, ARTICLE_SCENE_MAX_BYTES, { privateFile: true });
  const overlay = params.overlay_asset_sha256 ? await currentBytes(overlayPath, ARTICLE_SCENE_MAX_BYTES, { privateFile: true }) : null;
  const image = scenePng(source);
  const sourceSha256 = image.sha256, overlaySha256 = overlay ? await reviewOverlay(overlay, image) : null;
  require(sourceSha256 === params.source_image_sha256 && overlaySha256 === (params.overlay_asset_sha256 ?? null),
    'ARTICLE_SCENE_BYTES_CHANGED', '原图或标注图层与审核快照不一致。');
  const framing = articleSceneFraming(params.scene_framing ?? {}, image);
  const outputDir = path.join(dataRoot, 'tools', 'compositor', 'tenants', SCOPE.workspaceId, 'out', 'article-scenes', key);
  const [plan] = scenePlan({ sourcePath, overlayPath, outputDir, outputPath: path.join(outputDir, 'scene.png'), ...image,
    key, sourceKind: params.declared_source_kind, hasPortrait: false, hasThirdPartyAsset: false, imageGeneration: params.image_generation_required,
    brief: params.design_brief, briefHash: params.design_brief_sha256, framing, overlaySha: overlaySha256 });
  require(hashObject(framing) === hashObject(params.scene_framing) && hashObject(plan.params.recipe) === hashObject(params.recipe)
    && params.out_dir === outputDir && params.recipe_status === 'pending_review',
    'ARTICLE_SCENE_REVIEW_UNVERIFIED', '原生构图、真实图层、输出目录或配方状态与本工位不一致。');
  const { default: sharp } = await import('sharp');
  const { width, height, photo } = framing;
  const composedPhoto = await sharp(source, { limitInputPixels: 4096 * 4096 }).resize(photo.width, photo.height, { fit: 'fill' })
    .extract({ left: -photo.x, top: -photo.y, width, height }).png().toBuffer();
  const fullPreview = overlay ? await sharp(composedPhoto).composite([{ input: overlay }]).png().toBuffer() : composedPhoto;
  const preview = await sharp(fullPreview)
    .resize({ width: Math.min(width, 1200), height: Math.min(height, 1200), fit: 'inside' }).png().toBuffer();
  return { preview, evidence: { sourceSha256, overlaySha256, previewSha256: digest(preview),
    sceneBriefHash: params.design_brief_sha256, designBrief: params.design_brief, framing, sourceKind: params.declared_source_kind } };
}

async function writeOnce(file, bytes) {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await link(temp, file); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      require(bytes.equals(await currentBytes(file, bytes.length, { privateFile: true })),
        'ARTICLE_SCENE_INPUT_CHANGED', '此图位已冻结不同的输入，请沿用原任务。');
    }
  } finally { await unlink(temp); }
}

async function producerKey(directory, create) {
  const file = path.join(directory, 'producer-ed25519.pem');
  const load = async () => {
    const key = createPrivateKey(await currentBytes(file, 4096, { privateFile: true }));
    require(key.asymmetricKeyType === 'ed25519', 'ARTICLE_SCENE_KEY_INVALID', '本机凭据签名密钥类型无效。');
    return key;
  };
  try { return await load(); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) fail('ARTICLE_SCENE_KEY_MISSING', '请先取得并登记此工位的签名公钥。');
    const key = generateKeyPairSync('ed25519').privateKey;
    try { await writeOnce(file, Buffer.from(key.export({ type: 'pkcs8', format: 'pem' }))); }
    catch (race) { if (race.code !== 'ARTICLE_SCENE_INPUT_CHANGED') throw race; }
    return load();
  }
}

async function loadScene(pool, binding) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [SCOPE.tenantId, SCOPE.workspaceId]);
    const args = [SCOPE.tenantId, SCOPE.workspaceId, binding.threadId];
    const { rows: [thread] } = await client.query(`SELECT t.id,t.title,t.mode,t.status,t.progress_done,t.progress_total,t.plan_version,g.preset_key
      FROM threads t JOIN agents g ON g.id=t.agent_id AND g.workspace_id=t.workspace_id
      WHERE t.tenant_id=$1 AND t.workspace_id=$2 AND t.id=$3`, args);
    if (!thread) { await client.query('COMMIT'); return null; }
    require(threadMatches(thread, binding), 'ARTICLE_SCENE_BINDING_CONFLICT', '原生任务与插图计划绑定不一致。');
    const { rows: events } = await client.query(`SELECT event_id,seq,payload FROM biz_events
      WHERE tenant_id=$1 AND workspace_id=$2 AND session_id=$3 ORDER BY seq LIMIT 101`, args);
    const { rows: reviews } = await client.query(`SELECT a.approval_id,a.event_id,a.status,a.decided_by,
      e.seq AS review_seq,e.payload AS review_payload,h.event_id AS gesture_event_id,h.seq AS gesture_seq,h.payload AS gesture_payload
      FROM approvals a JOIN biz_events e ON e.tenant_id=a.tenant_id AND e.workspace_id=a.workspace_id AND e.event_id=a.event_id
      LEFT JOIN biz_events h ON h.tenant_id=a.tenant_id AND h.workspace_id=a.workspace_id
        AND h.payload->'decision'->>'action' IN ('approval.gesture','approval.ai_decision')
        AND h.payload->'decision'->'after'->>'approvalId'=a.approval_id
      WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND e.session_id=$3 AND a.channel='inapp'
        AND e.payload->'decision'->>'action'='visualwrite.compose' ORDER BY e.seq LIMIT 4`, args);
    require(events.length <= 100 && reviews.length <= 1, 'ARTICLE_SCENE_RECEIPTS_UNVERIFIED', '原生任务事件或审批记录出现歧义。');
    await client.query('COMMIT');
    return { thread, events, review: reviews[0] ?? null };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export function createArticleVisuals({ dataRoot, outRoot, active, assertCompositorReady, connect, runQuest, configureStage }) {
  const inflight = new Map();
  const privateRoot = () => {
    const root = path.join(dataRoot, 'article-scenes');
    require(privateDirectory(root) === root, 'ARTICLE_SCENE_PATH_INVALID', '场景工位目录发生变化。');
    return root;
  };
  function paths(binding, create = false) {
    const staging = path.join(privateRoot(), binding.key);
    if (create) require(privateDirectory(staging) === staging, 'ARTICLE_SCENE_PATH_INVALID', '场景任务目录发生变化。');
    const outputDir = path.join(outRoot, 'article-scenes', binding.key);
    require(inside(dataRoot, outputDir), 'ARTICLE_SCENE_PATH_INVALID', '视觉工位产物目录必须在本机受管范围内。');
    return { staging, sourcePath: path.join(staging, 'source.png'), overlayPath: path.join(staging, 'overlay.png'),
      outputDir, outputPath: path.join(outputDir, 'scene.png') };
  }
  async function query(method) {
    const pool = connect();
    try { return await method(pool); } finally { await pool.end(); }
  }
  const read = binding => query(pool=>loadScene(pool,binding));
  function status(binding, scene) {
    const review = scene?.review;
    const ai = scene?.events.findLast(row => row.payload?.who?.type === 'system' && row.payload.who.id === 'review-console' &&
      /^approval\.ai_/.test(row.payload.decision?.action ?? '') && row.payload.decision?.after?.approvalId === review?.approval_id)?.payload;
    return { nativeThreadId: binding.threadId, state: scene?.thread.status ?? 'missing',
      approval: reviewEvent(review?.review_payload) ? { id: review.approval_id, status: review.status,
        ...(ai ? { ai: { event: ai.decision.action, outcome: ai.decision.after.outcome ?? null,
          reason: ai.decision.after.reason ?? ai.decision.after.reasonCode ?? null, at: ai.context?.time ?? null,
          ...(ai.decision.after.retryAt ? { retryAt: ai.decision.after.retryAt } : {}) } } : {}) } : null };
  }
  return async (action, input) => {
    require(active(), 'ARTICLE_SCENE_RUNTIME_UNAVAILABLE', '本机视觉工位尚未就绪。');
    if (action === 'producer') return articleSceneProof(null, await producerKey(privateRoot(), true));
    if (action === 'workspace') return query(readArticleWorkspaceStage);
    if (action === 'configure-stage') {
      const { source, stage } = input;
      require(input.confirm === true && (source === 'journey' && stage === undefined || source === 'owner' && ['onboarding','stable'].includes(stage)),
        'ARTICLE_SCENE_STAGE_INVALID', '请确认实际工作区阶段。');
      return configureStage({source,stage});
    }
    const binding = articleSceneBinding(input);
    if (action === 'submit') {
      const order = articleSceneWorkOrder(input.workOrder);
      require(order.key === binding.key, 'ARTICLE_SCENE_WORK_ORDER_INVALID', '图位与导入工单不一致。');
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      require(title.length > 0 && title.length <= 27 && !/[\u0000-\u001f\u007f]/u.test(title)
        && !genericProductNamingFindings(title).length && !scanSensitiveText(title).length,
      'ARTICLE_SCENE_TITLE_INVALID', '请填写 1–27 字的通用场景标题。');
      const { sourceKind, hasPortrait, hasThirdPartyAsset } = input;
      require(input.confirm === true && input.rightsConfirmed === true && ['imagegen', 'authorized_asset'].includes(sourceKind)
        && (!order.imageGeneration || sourceKind === 'imagegen')
        && typeof hasPortrait === 'boolean' && typeof hasThirdPartyAsset === 'boolean'
        && typeof input.png === 'string' && (input.overlay === undefined || typeof input.overlay === 'string')
        && input.png.length + (input.overlay?.length ?? 0) <= Math.ceil(ARTICLE_SCENE_MAX_BYTES / 3) * 4 + 4,
        'ARTICLE_SCENE_IMAGE_INVALID', '请选择 PNG、声明来源并核对使用权与肖像情况。');
      const bytes = decodePng(input.png), overlay = input.overlay ? decodePng(input.overlay) : null;
      require(bytes.length + (overlay?.length ?? 0) <= ARTICLE_SCENE_MAX_BYTES,
        'ARTICLE_SCENE_IMAGE_INVALID', '源图与标注图层大小合计超出工位上限。');
      const image = scenePng(bytes);
      const framing = articleSceneFraming(input.framing ?? {}, image);
      const overlaySha = overlay ? await reviewOverlay(overlay, image) : null;
      require(!inflight.has(binding.key), 'ARTICLE_SCENE_PROCESSING', '任务正在提交，请回读同一图位。');
      const job = (async () => {
        const existing = await read(binding);
        if (!existing) {
          const { stage } = await query(readArticleWorkspaceStage);
          require(stage, 'ARTICLE_SCENE_STAGE_REQUIRED', '经营阶段尚未设置。请在本机工作区区块确认实际阶段后，沿用同一工单。');
          await assertCompositorReady();
        }
        const files = paths(binding, true);
        await writeOnce(files.sourcePath, bytes);
        const planFile = path.join(files.staging, 'plan.json');
        const goal = `${binding.marker} ${title}`;
        await writeOnce(planFile, Buffer.from(JSON.stringify(scenePlan({ ...files, ...image, key: binding.key,
          sourceKind, hasPortrait, hasThirdPartyAsset, imageGeneration: order.imageGeneration, brief: order.brief, briefHash: order.briefHash, framing, overlaySha }))));
        if (overlay) await writeOnce(files.overlayPath, overlay);
        if (existing) {
          require(existing.thread.title === `视觉工位任务：${goal}`, 'ARTICLE_SCENE_INPUT_CHANGED', '此图位已经冻结不同的标题。');
          return status(binding, existing);
        }
        await runQuest({ threadId: binding.threadId, goal, planFile });
        const scene = await read(binding);
        require(scene, 'ARTICLE_SCENE_RECEIPTS_UNVERIFIED', '原生设计任务结果尚未回读。');
        return status(binding, scene);
      })();
      inflight.set(binding.key, job);
      try { return await job; } finally { inflight.delete(binding.key); }
    }
    const scene = await read(binding);
    if (action === 'status') return status(binding, scene);
    require(scene, 'ARTICLE_SCENE_NOT_FOUND', '当前工位找不到这个原生设计任务。');
    const files = paths(binding);
    const source = await currentBytes(files.sourcePath, ARTICLE_SCENE_MAX_BYTES, { privateFile: true });
    const sourceSha = digest(source);
    const params = scene.review?.review_payload?.decision?.params;
    reviewedSceneBriefHash(binding, params);
    const overlay = params?.overlay_asset_sha256 ? await currentBytes(files.overlayPath, ARTICLE_SCENE_MAX_BYTES, { privateFile: true }) : null;
    const overlaySha = overlay ? digest(overlay) : null;
    require(sourceSha === params?.source_image_sha256 && overlaySha === (params.overlay_asset_sha256 ?? null),
      'ARTICLE_SCENE_BYTES_CHANGED', '源图或标注图层字节与当前审批中的配方不一致。');
    if (action === 'source') {
      return { ...status(binding, scene), sourceSha256: sourceSha, sourceKind: params.declared_source_kind,
        hasPortrait: params.has_portrait, hasThirdPartyAsset: params.has_third_party_asset, image: source.toString('base64'),
        designBrief: params.design_brief, framing: params.scene_framing, ...(overlay ? { overlay: overlay.toString('base64') } : {}),
        overlaySha256: overlaySha };
    }
    require(action === 'export', 'ARTICLE_SCENE_ACTION_INVALID', '未知的插图工位操作。');
    require(scene.thread.status === 'completed', 'ARTICLE_SCENE_NOT_COMPLETE', '原生设计任务尚未完成。');
    const bytes = await currentBytes(files.outputPath, ARTICLE_SCENE_MAX_BYTES);
    const statement = articleSceneStatement({ binding, ...scene, outputPath: files.outputPath, image: scenePng(bytes), sourceSha, overlaySha });
    return { proof: articleSceneProof(statement, await producerKey(privateRoot(), false)), image: bytes.toString('base64') };
  };
}
