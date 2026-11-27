import { isArticleIllustrationStyleYear } from "../../public/article-illustration-style.js";
import { createHash, createPublicKey, verify } from "node:crypto";
import { ApiError, PolicyError } from "./errors.mjs";
import { editorialInput, editorialText } from "./editorial.mjs";
import { hashObject } from "./hash.mjs";
import { genericProductNamingErrorCode, genericProductNamingFindings, normalizeGeneratedTextContent } from "./product-naming.mjs";

export const ARTICLE_ILLUSTRATION_SCHEMA = "pengmanager.article-illustrations/v1";
const SHA = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[a-zA-Z0-9_.:-]{1,120}$/;
const ARTICLE_TYPES = new Set(["technical", "product", "lifestyle"]);
const SLOT_KINDS = new Set(["architecture", "logic", "scene"]);
const WORKER_SOURCE = "pengmanager-designer-compositor";
const IMAGEGEN_SOURCE = "codex-imagegen";
const IMAGEGEN_MODEL = "image2.5";
const signalGroups = {
  technical: ["架构", "算法", "接口", "数据库", "数据流", "部署", "系统设计", "鉴权", "技术", "开发", "并发", "回滚", "代码", "architecture", "database", "deployment", "api", "pipeline", "engineering"],
  product: ["产品", "流程", "验收", "审批", "业务", "组织", "运营", "经营", "自动化", "客户", "电商", "归因", "工作台", "product", "workflow", "operations", "governance", "customer"],
  lifestyle: ["生活", "日常", "旅行", "摄影", "徒步", "咖啡", "烹饪", "读书", "周末", "居家", "亲子", "个人随笔", "daily life", "travel", "weekend", "recipe", "hiking", "personal essay"],
};
const broadSignals = new Set(["流程", "验收", "审批", "业务", "组织", "开发", "自动化", "workflow", "operations", "customer"]);
const placementSignals = {
  architecture: /架构|结构|组件|模块|角色|边界|组织|连接|数据流|并行|architecture|components?|boundary|roles?/giu,
  logic: /流程|判断|条件|顺序|处理|回滚|复测|步骤|失败|决策|校验|记录|flow|condition|decision|validation|sequence|rollback/giu,
  scene: /场景|案例|假设|现场|值班|工作台|门店|例如|比如|办公室|case|scene|example|shift|on[- ]site/giu,
};
const MAX_SLOTS = 64;

function fail(code, message, details) {
  throw new PolicyError(code, message, details);
}

function plain(value, allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ApiError(400, "INVALID_ILLUSTRATION_INPUT", "配图凭据必须使用登记的 JSON 字段。");
  }
}

function normalizedAnchor(value) { return value.replace(/\s+/gu, " ").trim(); }
function presentIn(text, anchor) { return normalizedAnchor(text).includes(normalizedAnchor(anchor)); }

function articleAnchors(body, kinds) {
  const excerpts = text => [...new Set(text.map(line => normalizedAnchor(line.replace(/^\s*(?:#{1,6}|[-*+>]|\d{1,6}[.)、])\s+/u, "")))
    .filter(line => [...line].length >= 4))];
  const paragraphs = excerpts(body.split(/\n/u));
  const candidates = paragraphs.length >= 3 ? paragraphs : excerpts(body.split(/\n|(?<=[。！？!?；;])\s*/u));
  const unique = [...new Map(candidates.map(text => [[...text].slice(0, 85).join(""), text])).entries()];
  const selected = new Set();
  const narrative = kinds.every(type => type === "scene");
  return kinds.map((kind, index) => {
    const position = index * (unique.length - 1) / (kinds.length - 1);
    const ranked = unique.map(([anchor, text], offset) => ({
      anchor, preferred: -Math.abs(offset - position),
      relevance: narrative ? 0 : [...text.matchAll(placementSignals[kind])].length,
    })).filter(item => !selected.has(item.anchor)).sort((left, right) => right.relevance - left.relevance || right.preferred - left.preferred);
    const chosen = ranked[0]?.anchor;
    if (chosen) selected.add(chosen);
    return chosen;
  });
}

export function suggestArticleIllustrations({ title, summary = "", body }) {
  const sources = [{ text: title.toLowerCase(), weight: 4 }, { text: summary.toLowerCase(), weight: 2 },
    { text: body.toLowerCase(), weight: 1 }];
  const signals = Object.entries(signalGroups).map(([articleType, terms]) => {
    const candidates = terms.map(term => {
      const english = /^[a-z ]+$/u.test(term) ? new RegExp(`\\b${term}\\b`, "u") : null;
      const weight = sources.find(source => english ? english.test(source.text) : source.text.includes(term))?.weight ?? 0;
      return { term, score: weight * (broadSignals.has(term) ? 1 : 3) };
    }).sort((left, right) => right.score - left.score);
    return { articleType, matches: candidates.filter(candidate => candidate.score).map(candidate => candidate.term),
      score: candidates.reduce((total, candidate) => total + candidate.score, 0) };
  }).sort((left, right) => right.score - left.score);
  const best = signals[0];
  const articleType = best.score ? best.articleType : "product";
  const kinds = articleType === "lifestyle" ? ["scene", "scene", "scene"] : ["architecture", "logic", "scene"];
  const anchors = articleAnchors(body, kinds);
  const actions = {
    architecture: "画清本节涉及的角色、部件、边界和连接关系",
    logic: "画清本节的行动顺序、判断条件与返回路径",
    scene: "再现本节涉及的人、地点、动作和现场道具",
  };
  return {
    articleType,
    reasons: best.matches.length ? [`标题、摘要或正文含有这些分类线索：${best.matches.slice(0, 6).join("、")}。`]
      : ["未找到清晰的题材线索。先按解释型文章准备，编辑可以根据全文调整。"],
    needsReview: best.score < 3 || best.score - signals[1].score < 2 || anchors.some(anchor => !anchor),
    kinds,
    slots: kinds.map((kind, index) => {
      const anchor = anchors[index] ?? "";
      return { kind, anchor, description: anchor ? `${actions[kind]}。正文线索：${anchor}` : "",
        alt: anchor ? `${{ architecture: "架构图", logic: "逻辑图", scene: "场景图" }[kind]}：${anchor}` : "",
        caption: "", imageGeneration: false };
    }),
  };
}

export function articleIllustrationSourceHash({ locale, title, summary, body }) {
  return hashObject({ locale, title, summary, body });
}

export function normalizeArticleIllustrationPlan(input, article, suggestion = suggestArticleIllustrations(article)) {
  const articleType = input.articleType ?? suggestion.articleType;
  if (!ARTICLE_TYPES.has(articleType)) fail("ILLUSTRATION_ARTICLE_TYPE_INVALID", "请选择产品、技术或生活分享文章。");
  if (!Array.isArray(input.slots) || input.slots.length < 3 || input.slots.length > MAX_SLOTS) {
    fail("ILLUSTRATION_SLOT_COUNT", `每篇文章至少安排 3 张不同的配图，单篇引用上限为 ${MAX_SLOTS} 张。`);
  }
  const anchors = new Set(), descriptions = new Set(), alternatives = new Set();
  const slots = input.slots.map((slot, index) => {
    editorialInput(slot, ["kind", "anchor", "description", "alt", "caption", "imageGeneration"]);
    if (!SLOT_KINDS.has(slot.kind) || (slot.imageGeneration !== undefined && typeof slot.imageGeneration !== "boolean")) {
      fail("ILLUSTRATION_SLOT_INVALID", "配图类型或生图设置无效。");
    }
    const text = normalizeGeneratedTextContent({
      body: editorialText(slot.anchor, "anchor", 300),
      summary: editorialText(slot.description, "description", 1000),
      title: editorialText(slot.caption ?? "", "caption", 500, { empty: true }),
      assetRefs: [{ alt: editorialText(slot.alt, "alt", 500) }],
    }).value;
    const anchor = normalizedAnchor(text.body), description = text.summary, alt = text.assetRefs[0].alt, caption = text.title;
    if ([...anchor].length < 4 || !presentIn(article.body, anchor) || anchors.has(anchor) || descriptions.has(description) || alternatives.has(alt)) {
      fail("ILLUSTRATION_ANCHOR_INVALID", "每张配图须有不同的描绘重点和替代文字，并绑定正文中不同的原句或小节。", { slot: index + 1 });
    }
    const findings = genericProductNamingFindings({ alt, caption }, { location: "article.illustrations" });
    if (findings.length) fail(genericProductNamingErrorCode(findings), "图片替代文字和图注必须使用通用名称。", { findings });
    anchors.add(anchor); descriptions.add(description); alternatives.add(alt);
    return {
      id: `slot-${index + 1}`, kind: slot.kind, anchor, description, alt, caption,
      imageGeneration: slot.imageGeneration === true, evidence: null,
    };
  });
  const kinds = new Set(slots.map(slot => slot.kind));
  if (articleType === "lifestyle" ? kinds.size !== 1 || !kinds.has("scene") : [...SLOT_KINDS].some(kind => !kinds.has(kind))) {
    fail("ILLUSTRATION_COVERAGE_REQUIRED", articleType === "lifestyle"
      ? "生活分享文章需要至少三张对应正文内容的场景图。"
      : "产品或技术文章需分别有架构图、逻辑图和场景图。");
  }
  return { articleType, suggestion, slots, sourceHash: articleIllustrationSourceHash(article) };
}

export function articleIllustrationPlanHash(plan) {
  return hashObject({ schema: plan.schema, id: plan.id, storyId: plan.storyId,
    locale: plan.locale, sourceHash: plan.sourceHash, articleType: plan.articleType, slots: plan.slots,
    ...(plan.baseReleaseId !== undefined ? { baseReleaseId: plan.baseReleaseId } : {}),
    ...(plan.styleYear !== undefined ? { styleYear: plan.styleYear } : {}) });
}

export function assertArticleIllustrationStateIntegrity(state) {
  if (![2, 3, 4].includes(state.schemaVersion)) return;
  const invalid = () => { throw new ApiError(503, "STATE_ARTICLE_ILLUSTRATION_INVALID", "配图计划的版本、签章工位或素材引用不完整，已保留原状态。"); };
  const keys = state.articleIllustrationProducerKeys ?? [], plans = state.articleIllustrationPlans ?? [];
  if (!Array.isArray(keys) || !Array.isArray(plans)) invalid();
  const producerIds = new Set();
  for (const key of keys) {
    let id;
    try { id = normalizeIllustrationProducerKey(key?.publicKey).id; }
    catch { invalid(); }
    if (key.id !== id || producerIds.has(id)) invalid();
    producerIds.add(id);
  }
  const plansById = new Map();
  for (const plan of plans) {
    if (!plan || !/^ILP-\d{5,}$/u.test(plan.id ?? "") || plan.schema !== ARTICLE_ILLUSTRATION_SCHEMA ||
        !state.stories.some(story => story.id === plan.storyId) || !ARTICLE_TYPES.has(plan.articleType) ||
        !SHA.test(plan.sourceHash ?? "") || !Array.isArray(plan.slots) || plan.slots.length < 3 || plan.slots.length > MAX_SLOTS ||
        plansById.has(plan.id)) invalid();
    if (plan.styleYear !== undefined && !isArticleIllustrationStyleYear(plan.styleYear)) invalid();
    if (plan.baseReleaseId !== undefined &&
        (typeof plan.baseReleaseId !== "string" || !/^REL-\d{5,}$/u.test(plan.baseReleaseId) ||
          !Array.isArray(state.websiteReleases) || !state.websiteReleases.some(release => release.id === plan.baseReleaseId &&
            release.storyId === plan.storyId && release.locale === plan.locale && release.format === "article"))) invalid();
    for (const [index, slot] of plan.slots.entries()) {
      if (!slot || slot.id !== `slot-${index + 1}` || !SLOT_KINDS.has(slot.kind)) invalid();
      const evidence = slot.evidence;
      if (evidence && (!SHA.test(evidence.visualFingerprint ?? "") ||
          !state.mediaAssets.some(asset => asset.id === evidence.assetId && asset.sha256 === evidence.sha256) ||
          [evidence.designerCompositor, evidence.imageGen].some(proof => proof && !producerIds.has(proof.producerKeyId)))) invalid();
    }
    plansById.set(plan.id, plan);
  }
  for (const edition of state.editions) {
    if (edition.illustrationPlanId === undefined && edition.illustrationPlanHash === undefined) continue;
    const plan = plansById.get(edition.illustrationPlanId);
    if (!plan || edition.format !== "article" || plan.storyId !== edition.storyId || plan.locale !== edition.locale ||
        plan.sourceHash !== articleIllustrationSourceHash(edition) || articleIllustrationPlanHash(plan) !== edition.illustrationPlanHash) invalid();
  }
}

export function normalizeIllustrationProducerKey(publicKey) {
  if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]{59}$/.test(publicKey)) {
    throw new ApiError(400, "ILLUSTRATION_KEY_INVALID", "请提供本机工位导出的 Ed25519 公钥。");
  }
  const der = Buffer.from(publicKey, "base64url");
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || key.export({ format: "der", type: "spki" }).toString("base64url") !== publicKey) {
      throw new Error("Invalid key representation");
    }
  } catch {
    throw new ApiError(400, "ILLUSTRATION_KEY_INVALID", "本机签章公钥类型或编码无效。");
  }
  return { id: `pk-${createHash("sha256").update(der).digest("hex").slice(0, 32)}`, publicKey };
}

// Both local producers sign a flat, canonical JSON statement.
export function illustrationStatementBytes(statement) {
  return Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(statement).sort().map(key => [key, statement[key]]))), "utf8");
}

export function articleIllustrationNativeThreadId(planId, slotId, sourceHash) {
  const binding = createHash("sha256").update(JSON.stringify(["pengmanager-article-scene/v1", planId, slotId, sourceHash])).digest("hex");
  return `thr-pm-visual-${binding}`;
}

export function articleIllustrationSceneBriefHash({ planId, slotId, sourceHash, storyId, articleTitle, sceneDescription, imageGeneration, styleYear }) {
  return hashObject({ schema: "pengmanager.article-scene-brief/v1", planId, slotId, sourceHash,
    storyId, articleTitle, sceneDescription, imageGeneration, ...(styleYear === undefined ? {} : { styleYear }) });
}

export function sceneBriefHashForPlan(plan, slot) {
  return articleIllustrationSceneBriefHash({ planId: plan.id, slotId: slot.id, sourceHash: plan.sourceHash,
    storyId: plan.storyId, articleTitle: plan.title, sceneDescription: slot.description, imageGeneration: slot.imageGeneration,
    styleYear: plan.styleYear });
}

function verifyReceipt(envelope, source, plan, slot, keys) {
  plain(envelope, ["statement", "signature", "producerKeyId"]);
  const common = ["source", "planId", "slotId", "sourceHash", "sha256", "bytes", "width", "height"];
  const nativeIds = ["nativeThreadId", "approvedApprovalId", "gestureEventId", "composeEventId", "verifyEventId"];
  const isNative = source === WORKER_SOURCE;
  const statement = envelope.statement;
  plain(statement, [...common, ...(isNative ? [...nativeIds, "sceneBriefHash", "imageGenInputSha256", "approvalAuthority", "approvalDecisionHash"] : ["requestedProfile", "resolvedModel", "toolReceiptId", "styleYear"])]);
  if (Object.values(statement).some(value => value !== undefined && value !== null && typeof value !== "string" && typeof value !== "number")) {
    fail("ILLUSTRATION_RECEIPT_MISMATCH", "核验凭据的签章声明必须为平面字段。");
  }
  const key = (keys ?? []).find(item => item.id === envelope.producerKeyId && !item.revokedAt);
  if (!key) fail("ILLUSTRATION_PRODUCER_UNTRUSTED", "先在编辑工作台登记本机受授权签章工位的公钥。");
  const signature = typeof envelope.signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(envelope.signature)
    ? Buffer.from(envelope.signature, "base64url") : null;
  if (!signature || signature.toString("base64url") !== envelope.signature ||
      !verify(null, illustrationStatementBytes(statement), { key: Buffer.from(key.publicKey, "base64url"), format: "der", type: "spki" }, signature)) {
    fail("ILLUSTRATION_SIGNATURE_INVALID", "工位凭据签章验证失败。");
  }
  if (statement.source !== source || statement.planId !== plan.id || statement.slotId !== slot.id || statement.sourceHash !== plan.sourceHash ||
      !SHA.test(statement.sha256 ?? "") || [statement.bytes, statement.width, statement.height].some(value => !Number.isSafeInteger(value) || value <= 0) ||
      (isNative ? nativeIds.some(field => typeof statement[field] !== "string" || !OPAQUE_ID.test(statement[field])) ||
        statement.nativeThreadId !== articleIllustrationNativeThreadId(plan.id, slot.id, plan.sourceHash) :
        statement.requestedProfile !== IMAGEGEN_MODEL || typeof statement.toolReceiptId !== "string" || !OPAQUE_ID.test(statement.toolReceiptId) ||
        (statement.resolvedModel !== undefined && (typeof statement.resolvedModel !== "string" || !OPAQUE_ID.test(statement.resolvedModel))))) {
    fail("ILLUSTRATION_RECEIPT_MISMATCH", "工位凭据与本文章、图位或实际媒体摘要不匹配。");
  }
  if (isNative && statement.sceneBriefHash !== sceneBriefHashForPlan(plan, slot)) {
    fail("ILLUSTRATION_SCENE_BRIEF_MISMATCH", "本机已批准的场景简报与当前图位不一致。请从该图位重新下载工单并核对原生任务。");
  }
  if (isNative && (plan.styleYear !== undefined || statement.approvalAuthority !== undefined || statement.approvalDecisionHash !== undefined) &&
      (statement.approvalAuthority !== "ai" || !SHA.test(statement.approvalDecisionHash ?? ""))) {
    fail("ILLUSTRATION_RECEIPT_MISMATCH", "AI 审批证明缺少有效的裁决来源与摘要。");
  }
  if (!isNative && statement.styleYear !== plan.styleYear) {
    fail("ILLUSTRATION_STYLE_MISMATCH", "内置生图的签章必须绑定当前工作单要求的当代风格。请按正式工单重新出图。");
  }
  return envelope;
}

function sameMedia(statement, asset) {
  return asset.sha256 === statement.sha256 && asset.size === statement.bytes &&
    asset.width === statement.width && asset.height === statement.height;
}

function verifyIllustrationProofs({ designerCompositor, imageGen }, plan, slot, asset, keys) {
  const scene = slot.kind === "scene";
  if (scene !== (designerCompositor !== undefined) || slot.imageGeneration !== (imageGen !== undefined)) {
    fail("ILLUSTRATION_RECEIPT_REQUIRED", scene
      ? "场景图必须有本机设计工作流及 Compositor 的真实验收凭据，使用内置生图时还要绑定生图凭据。"
      : "如选用内置生图，请提交对应的宿主工具凭据。");
  }
  const native = scene ? verifyReceipt(designerCompositor, WORKER_SOURCE, plan, slot, keys) : null;
  const generated = slot.imageGeneration ? verifyReceipt(imageGen, IMAGEGEN_SOURCE, plan, slot, keys) : null;
  if (scene ? !sameMedia(native.statement, asset) || (native.statement.imageGenInputSha256 ?? null) !== (generated?.statement.sha256 ?? null)
    : generated && !sameMedia(generated.statement, asset)) {
    fail("ILLUSTRATION_RECEIPT_MISMATCH", "核验凭据的产物或底图与当前实际图片不一致。");
  }
  return {
    ...(native ? { designerCompositor: native } : {}),
    ...(generated ? { imageGen: generated } : {}),
  };
}

export function validateIllustrationEvidence(input, plan, slot, asset, keys) {
  plain(input, ["slotId", "assetId", "sha256", "designerCompositor", "imageGen"]);
  if (!asset || asset.kind !== "image" || asset.status !== "reviewed" || !SHA.test(input.sha256 ?? "") ||
      asset.sha256 !== input.sha256 || asset.review?.sha256 !== asset.sha256 ||
      asset.review?.rightsConfirmed !== true || asset.review?.privacyConfirmed !== true) {
    fail("ILLUSTRATION_ASSET_NOT_REVIEWED", "只可绑定通过版权与隐私审核、摘要一致的真实图片。");
  }
  return { assetId: asset.id, sha256: asset.sha256, ...verifyIllustrationProofs(input, plan, slot, asset, keys) };
}

export function verifyArticleSceneProvenance(state, asset, proofs) {
  plain(proofs, ["designerCompositor", "imageGen"]);
  const statement = proofs.designerCompositor?.statement;
  const plan = (state.articleIllustrationPlans ?? []).find(row => row.id === statement?.planId);
  const slot = plan?.slots.find(row => row.id === statement?.slotId);
  if (asset.kind !== "image" || plan?.schema !== ARTICLE_ILLUSTRATION_SCHEMA || slot?.kind !== "scene" || !state.stories.some(story => story.id === plan.storyId)) {
    fail("ILLUSTRATION_SCENE_CONTEXT_REQUIRED", "请为这张图片提交当前文章场景图位导出的 Compositor 回执及所需原图回执。");
  }
  const { designerCompositor, imageGen } = verifyIllustrationProofs(proofs, plan, slot, asset, state.articleIllustrationProducerKeys);
  const nativeStatement = designerCompositor.statement;
  const imageStatement = imageGen?.statement;
  return {
    schema: "pengmanager.article-scene-provenance/v1",
    storyId: plan.storyId, planId: plan.id, slotId: slot.id, sourceHash: plan.sourceHash,
    sceneBriefHash: nativeStatement.sceneBriefHash, sceneDescription: slot.description,
    ...(plan.styleYear !== undefined ? { styleYear: plan.styleYear } : {}),
    output: { assetId: asset.id, mime: asset.mime, sha256: asset.sha256, bytes: asset.size, width: asset.width, height: asset.height },
    compositor: { source: nativeStatement.source, producerKeyId: designerCompositor.producerKeyId,
      receiptHash: hashObject(designerCompositor), nativeThreadId: nativeStatement.nativeThreadId,
      approvedApprovalId: nativeStatement.approvedApprovalId, composeEventId: nativeStatement.composeEventId,
      verifyEventId: nativeStatement.verifyEventId,
      ...(nativeStatement.approvalAuthority ? { approvalAuthority: nativeStatement.approvalAuthority,
        approvalDecisionHash: nativeStatement.approvalDecisionHash } : {}) },
    ...(imageStatement ? { imageGen: { source: imageStatement.source, producerKeyId: imageGen.producerKeyId,
      receiptHash: hashObject(imageGen), toolReceiptId: imageStatement.toolReceiptId, inputSha256: imageStatement.sha256,
      requestedProfile: imageStatement.requestedProfile,
      ...(imageStatement.resolvedModel ? { resolvedModel: imageStatement.resolvedModel } : {}) } } : {}),
  };
}

export function articleIllustrationBlockText(block) {
  return block.type === "list" ? block.items.join(" ") : (block.text ?? "");
}

export function placeArticleIllustrations(plan, article) {
  const after = new Map(), assetRefs = [];
  for (const slot of plan.slots) {
    const { evidence } = slot;
    if (!evidence) fail("ARTICLE_ILLUSTRATION_INCOMPLETE", "请先在编辑工作台登记全部已审配图及核验凭据。", { slotId: slot.id });
    const index = article.blocks.findIndex(block => presentIn(articleIllustrationBlockText(block), slot.anchor));
    if (index < 0) fail("ILLUSTRATION_PLACEMENT_MISMATCH", "配图锚点未出现在当前正文块中。", { slotId: slot.id });
    const { assetId, sha256 } = evidence, { alt, caption } = slot;
    assetRefs.push({ assetId, sha256, alt, caption, role: "image", locale: article.locale });
    const pictures = after.get(index) ?? [];
    pictures.push({ type: "image", assetId, alt, caption });
    after.set(index, pictures);
  }
  const blocks = article.blocks.flatMap((block, index) => [block, ...(after.get(index) ?? [])]);
  return { blocks, assetRefs };
}

export function assertArticleIllustrations(state, plan, article, { exactSource = false } = {}) {
  if (!plan || plan.schema !== ARTICLE_ILLUSTRATION_SCHEMA || plan.storyId !== article.storyId || plan.locale !== article.locale ||
      (exactSource && plan.sourceHash !== articleIllustrationSourceHash(article))) {
    fail("ARTICLE_ILLUSTRATION_PLAN_REQUIRED", "官网文章需绑定本选题、同语言、准确母稿的配图计划。更换母稿后请重新准备。");
  }
  const assets = new Set(), hashes = new Set(), fingerprints = new Set(), proofs = new Set();
  if (plan.slots.length < 3 || plan.slots.length > MAX_SLOTS) fail("ILLUSTRATION_SLOT_COUNT", "官网文章至少需要三张不同的配图。");
  for (const slot of plan.slots) {
    const evidence = slot.evidence;
    if (!evidence) fail("ARTICLE_ILLUSTRATION_INCOMPLETE", "请完成配图、真实凭据上传和素材权利审核后再创建公开修订。", { slotId: slot.id });
    const asset = state.mediaAssets.find(row => row.id === evidence.assetId);
    validateIllustrationEvidence({ slotId: slot.id, assetId: evidence.assetId, sha256: evidence.sha256,
      ...(evidence.designerCompositor ? { designerCompositor: evidence.designerCompositor } : {}),
      ...(evidence.imageGen ? { imageGen: evidence.imageGen } : {}) },
    plan, slot, asset, state.articleIllustrationProducerKeys);
    const proofIds = [evidence.designerCompositor?.statement.composeEventId, evidence.imageGen?.statement.toolReceiptId].filter(Boolean);
    if (assets.has(evidence.assetId) || hashes.has(evidence.sha256) || fingerprints.has(evidence.visualFingerprint) ||
        !SHA.test(evidence.visualFingerprint ?? "") || proofIds.some(id => proofs.has(id))) {
      fail("ILLUSTRATION_ASSET_DUPLICATE", "不同图位必须使用不同的实际画面与生产凭据。", { slotId: slot.id });
    }
    assets.add(evidence.assetId); hashes.add(evidence.sha256); fingerprints.add(evidence.visualFingerprint);
    proofIds.forEach(id => proofs.add(id));
    const reference = article.assetRefs.find(ref => ref.assetId === asset.id && ["image", "cover"].includes(ref.role));
    const images = article.blocks.filter(block => block.type === "image" && block.assetId === asset.id);
    const image = images[0];
    let insertion = article.blocks.indexOf(image) - 1;
    while (insertion >= 0 && article.blocks[insertion].type === "image") insertion--;
    if (!reference || reference.sha256 !== asset.sha256 || reference.alt !== slot.alt || reference.caption !== slot.caption ||
        images.length !== 1 || image.alt !== slot.alt || image.caption !== slot.caption || insertion < 0 ||
        !presentIn(article.body, slot.anchor) || !presentIn(articleIllustrationBlockText(article.blocks[insertion]), slot.anchor)) {
      fail("ILLUSTRATION_PLACEMENT_MISMATCH", "每张计划配图需要按图注插在对应段落或小节之后，并出现在页面正文中。", { slotId: slot.id });
    }
  }
  if (article.blocks.some(block => block.type === "image" && !assets.has(block.assetId))) {
    fail("ILLUSTRATION_NOT_PLANNED", "正文中的每张图片都需要对应的配图计划图位。");
  }
}
