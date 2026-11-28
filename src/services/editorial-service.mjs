import { ApiError, PolicyError } from "../domain/errors.mjs";
import { articleIllustrationStyleYear } from "../../public/article-illustration-style.js";
import { articleIllustrationImageGenPrompt, articleIllustrationWorkOrder } from "../../public/article-illustration-work-order.js";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { hashObject } from "../domain/hash.mjs";
import { requirePublicUrl } from "../domain/public-url.mjs";
import { transitionContent } from "../domain/state-machine.mjs";
import { platformById, platformCatalog } from "../domain/platform-catalog.mjs";
import {
  EDITORIAL_SCHEMA, EDITORIAL_NATIVE_SCHEMA, EDITORIAL_NATIVE_EDITION_SCHEMA, isEditorialVariantSchema,
  EDITORIAL_LOCALES, EDITORIAL_FORMATS, accountEditorialIdentity,
  assertEditorialAssets, claimEditorialFingerprint, destinationEditorialIdentity,
  editorialEditionSnapshot, editorialEtag, editorialId, editorialInput, editorialNamingFindings, editorialSensitiveFindings, editorialText,
  editorialVariantSnapshot, normalizeEditorialAssetRefs, normalizeEditorialBlocks,
  publicEditorialClaim, validateEditorialVariant,
} from "../domain/editorial.mjs";
import { JsonStore } from "../storage/json-store.mjs";
import {
  ARTICLE_ILLUSTRATION_SCHEMA, articleIllustrationPlanHash, assertArticleIllustrations,
  normalizeArticleIllustrationPlan, normalizeIllustrationProducerKey, sceneBriefHashForPlan, suggestArticleIllustrations, validateIllustrationEvidence,
} from "../domain/article-illustrations.mjs";
import { validateCandidateForReview } from "../domain/content-ops-quality.mjs";
import { articleIllustrationStyleCriterion, articleReviewContext, currentOriginalReviewBasis, ORIGINAL_ILLUSTRATION_REVIEW, originalIllustrationCriteria, originalIllustrationDestination } from "./editorial-article-review-evidence.mjs";
import {
  OFFICIAL_ILLUSTRATION_COHORT, activeCohortBases, cohortBaseRelease, assertCohortText, assertCohortAddition, assertCohortPlanPlacement,
} from "./editorial-illustration-cohort.mjs";
import { assertOperationReviewCurrent, reviewOperationEvidence, separateReviewProof } from "./operations-review.mjs";
import {
  genericProductNamingErrorCode,
  genericProductNamingFindings,
  normalizeGeneratedTextContent,
  PRODUCT_NAMING_POLICY_VERSION,
} from "../domain/product-naming.mjs";

export { editorialEtag, editorialVariantSnapshot, validateEditorialVariant } from "../domain/editorial.mjs";

const ACCOUNT_STATUSES = new Set(["draft", "active", "paused", "archived"]);
const DESTINATION_KINDS = new Set(["owned_origin", "profile_feed", "page", "repository", "community", "community_channel", "artifact_repository"]);
const VISIBILITIES = new Set(["public", "restricted", "private", "unverified"]);
const POLICIES = new Set(["reviewed", "manual_review_required"]);
const SECTIONS = { article: "articles", image_text: "visuals", video: "videos" };
const PUBLICATION_SYSTEM_ACTOR = "editorial-publication-system";
const LANGUAGES = { "zh-CN": "zh", "en-US": "en" };
const ACCOUNT_PROFILE_FIELDS = ["id", "platform", "platformId", "handle", "profileUrl", "language", "displayName", "status", "identityVersion", "identityReview", "policyStatus", "policyCheckedAt", "policyReviewedBy"];
const ARTICLE_REVIEW_CRITERION = [
  "原始母稿和同一官网地址的历史公开稿用于比较文字是否延续，不能独立证明外部事实。",
  "可读事实来源只能支持其明确覆盖的主张；保留可验证事实的证据缺口，区分分析建议和明确的假设场景。",
  "实际图片按 media 中图片、封面和海报引用的顺序附上。按 assetId 对照 verifiedIllustrations 的图位，检查实际画面、说明和用途。",
  "服务器核验的签章说明制作来源，不替代使用权或隐私审查。",
].join(" ");

function record(rows, id, code) {
  editorialId(id);
  const row = rows?.find(item => item.id === id);
  if (!row) throw new ApiError(404, code, "找不到指定记录。");
  return row;
}

function nextId(prefix, rows) {
  const maximum = rows.reduce((result, row) => Math.max(result, Number(String(row.id).match(new RegExp(`^${prefix}-(\\d+)$`))?.[1] ?? 0)), 0);
  return `${prefix}-${String(maximum + 1).padStart(5, "0")}`;
}

function entity(row) { return { ...structuredClone(row), etag: editorialEtag(row) }; }
function timestamp(value, field, now) {
  const result = editorialText(value, field, 80);
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.getTime() > now.getTime() + 60_000) throw new ApiError(400, "INVALID_TIMESTAMP", `${field} 时间无效。`);
  return date.toISOString();
}
function assertMatch(row, supplied) {
  if (!supplied) throw new ApiError(428, "PRECONDITION_REQUIRED", "请先读取记录并提供 If-Match。");
  if (supplied !== editorialEtag(row)) throw new ApiError(412, "PRECONDITION_FAILED", "记录已变化，请刷新后重新核对。");
}
function stringArray(value, field, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) throw new ApiError(400, "INVALID_INPUT", `${field} 必须是有界数组。`);
  const values = value.map(item => editorialId(item, field));
  if (new Set(values).size !== values.length) throw new ApiError(400, "DUPLICATE_REFERENCE", `${field} 不允许重复值。`);
  return values;
}
function claimBindings(state, ids) {
  return ids.map(id => ({ claimId: id, hash: claimEditorialFingerprint(record(state.claims, id, "CLAIM_NOT_FOUND")) }));
}
function assertLocaleFormat(locale, format) {
  if (!EDITORIAL_LOCALES.includes(locale)) throw new ApiError(400, "INVALID_LOCALE", "仅支持当前登记的中文和英文版本。");
  if (!EDITORIAL_FORMATS.includes(format)) throw new ApiError(400, "INVALID_CONTENT_TYPE", "内容形式只能是 article、image_text 或 video。");
}
function profileAudit(account) {
  return Object.fromEntries(ACCOUNT_PROFILE_FIELDS.filter(key => account[key] !== undefined).map(key => [key, structuredClone(account[key])]));
}
function unresolvedAccountActions(state, id) {
  return (state.accountOperations ?? []).filter(row => row.accountId === id && row.status === "in_progress");
}
function ownOrigin(value, { production = process.env.NODE_ENV === "production" } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, "INVALID_PUBLIC_ORIGIN", "官网 origin 未配置或无效。"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !(url.protocol === "https:" || (!production && url.protocol === "http:" && loopback))) {
    throw new ApiError(400, "INVALID_PUBLIC_ORIGIN", "生产官网必须使用 HTTPS，开发 HTTP 仅限本机。");
  }
  return url.origin;
}
function destinationLocator(kind, value, origin) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_DESTINATION", "目的地必须提供结构化定位信息。");
  if (kind === "owned_origin") {
    editorialInput(value, ["origin"]);
    if (ownOrigin(value.origin) !== origin) throw new PolicyError("OWNED_ORIGIN_MISMATCH", "官网目的地必须与受保护配置的本站 origin 完全一致。");
    return { origin };
  }
  if (kind === "community_channel") {
    editorialInput(value, ["serverId", "channelId", "threadId"]);
    const locator = {};
    for (const key of ["serverId", "channelId"]) {
      if (typeof value[key] !== "string" || !/^\d{5,30}$/.test(value[key])) throw new ApiError(400, "INVALID_DESTINATION", "服务器或频道标识符无效。");
      locator[key] = value[key];
    }
    if (value.threadId !== undefined) {
      if (typeof value.threadId !== "string" || !/^\d{5,30}$/.test(value.threadId)) throw new ApiError(400, "INVALID_DESTINATION", "主题标识符无效。");
      locator.threadId = value.threadId;
    }
    return locator;
  }
  editorialInput(value, ["url", "artifactKind"]);
  const locator = { url: requirePublicUrl(value.url, "destination.locator.url") };
  if (kind === "artifact_repository") locator.artifactKind = editorialText(value.artifactKind, "artifactKind", 80);
  else if (value.artifactKind !== undefined) throw new ApiError(400, "INVALID_DESTINATION", "此目的地类型不接受作品类型。");
  return locator;
}

function releaseSnapshot(release) { return release.publicSnapshot; }
function releaseSnapshotValid(release) { return hashObject(releaseSnapshot(release)) === release.snapshotHash; }
function websiteSnapshot(content, canonicalPath, publicOrigin) {
  return { locale: content.locale, format: content.format, title: content.title, summary: content.summary,
    body: content.body, blocks: structuredClone(content.blocks), assetRefs: structuredClone(content.assetRefs),
    claimIds: [...content.claimIds], claimBindings: structuredClone(content.claimBindings), canonicalPath,
    canonicalUrl: `${publicOrigin}${canonicalPath}`,
    ...(content.snapshotSchema === EDITORIAL_NATIVE_SCHEMA ? { nativePackageHash: content.packageHash, reviewSnapshotHash: content.reviewSnapshotHash } : {}) };
}
function reviewedCopy(state, content, reviewOptions) {
  const articleReview = articleReviewContext(state, content, reviewOptions);
  const scoped = Boolean(articleReview?.originalDelta);
  if (scoped) assertArticleReviewSafe({ title: content.title, summary: content.summary, body: content.body, blocks: content.blocks, assetRefs: content.assetRefs });
  return {
    locale: content.locale, format: content.format, title: content.title, summary: content.summary,
    ...(!scoped ? { body: content.body, blocks: content.blocks } : {}),
    destination: content.destinationSnapshot,
    claims: content.claimIds.map(id => {
      const item = record(state.claims, id, "CLAIM_NOT_FOUND");
      return { id, text: item.text, sourceUrl: item.source?.url ?? null, publicLevel: item.publicLevel ?? null };
    }),
    media: content.assetRefs.map(ref => {
      const asset = record(state.mediaAssets, ref.assetId, "MEDIA_ASSET_NOT_FOUND");
      return { assetId: ref.assetId, sha256: ref.sha256, role: ref.role, alt: ref.alt, caption: ref.caption,
        ...(articleReview ? { review: { sha256: asset.review?.sha256 ?? null, hash: asset.review?.aiApproval?.evidenceHash ?? null } }
          : { reviewedSha256: asset.review?.sha256 ?? null, aiReview: asset.review?.aiApproval?.evidenceHash ?? null }) };
    }),
    ...(content.reviewSnapshotHash ? { packageHash: content.packageHash, independentReviewHash: content.reviewSnapshotHash } : {}),
    ...(articleReview ? { articleReview } : {}),
    ...(scoped && reviewOptions.websiteAuthorization ? { verifiedPublicationIntent: reviewOptions.websiteAuthorization } : {}),
  };
}
function reviewedReleaseCopy(state, content, release, { publicOrigin, note, actor, now, base, websiteAuthorization }) {
  const evidence = reviewedCopy(state, content, { publicOrigin, previousReleaseId: release.previousReleaseId, now, base, websiteAuthorization });
  const variantReviewHash = content.approval.aiApproval.evidenceHash;
  if (evidence.articleReview?.originalDelta) {
    const { canonicalPath, previousReleaseId, snapshotHash } = release;
    const authorization = { method: websiteAuthorization ? "exact_website_intent" : "exact_release_authorization",
      authorizedBy: actor, destinationId: content.destinationId, canonicalPath, previousReleaseId, snapshotHash,
      editionSnapshotHash: content.editionHash, note };
    return { ...evidence, verifiedPublicationAuthorization: authorization,
      variantReview: { hash: variantReviewHash, snapshotHash: content.snapshotHash, scope: ORIGINAL_ILLUSTRATION_REVIEW } };
  }
  return { ...evidence, canonicalPath: release.canonicalPath, previousReleaseId: release.previousReleaseId,
    publicationAuthorization: note, authorizedBy: actor,
    variantReview: evidence.articleReview ? { hash: variantReviewHash } : variantReviewHash };
}
function assertArticleReviewSafe(evidence) {
  if (editorialSensitiveFindings(evidence).length || /(?:file:\/\/|\/Users\/[^\s/]+\/|\/home\/[^\s/]+\/)/i.test(JSON.stringify(evidence))) {
    throw new PolicyError("AI_APPROVAL_SENSITIVE_INPUT", "文章审核输入含有须先处理的敏感资料或本机私有路径。");
  }
}
function assertArticleReviewCurrent(evidence, expectedHash) {
  if (hashObject(evidence) !== expectedHash) {
    throw new ApiError(409, "AI_APPROVAL_INPUT_CHANGED", "审核期间文章、来源或素材证据发生变化，请核对当前版本后重试。");
  }
}

function originalReviewBindingFromEvidence(evidence) {
  const delta = evidence.articleReview?.originalDelta;
  if (!delta) return null;
  return { destinationHash: hashObject(delta.destination), sourcesAndMediaHash: hashObject(delta.reviewBasis) };
}

function normalizeEditorialNaming(value, locale) {
  const naming = normalizeGeneratedTextContent({
    title: value.title,
    summary: value.summary,
    body: value.body,
    blocks: value.blocks,
    assetRefs: value.assetRefs,
  });
  const findings = editorialNamingFindings(naming.value, "editorial");
  if (findings.length) {
    throw new PolicyError(genericProductNamingErrorCode(findings),
      "公开文案中的具体产品或品牌名必须自动替换为行业通用名称，且不得使用 XX、XXXX、TBD 或“某产品”等占位符。", { findings });
  }
  const title = editorialText(naming.value.title, "title", 240);
  const summary = editorialText(naming.value.summary, "summary", 2000, { empty: true });
  const body = editorialText(naming.value.body, "body", 50_000, { preserve: true });
  const assetRefs = normalizeEditorialAssetRefs(naming.value.assetRefs, locale);
  return {
    title, summary, body, assetRefs,
    blocks: normalizeEditorialBlocks(naming.value.blocks, body, assetRefs),
    productNaming: naming.policy,
  };
}

async function illustrationFingerprint(mediaAssets, asset, state) {
  if (typeof mediaAssets?.openVerifiedAsset !== "function") {
    throw new ApiError(503, "MEDIA_VERIFICATION_UNAVAILABLE", "配图需要实际图片字节校验。");
  }
  const { handle } = await mediaAssets.openVerifiedAsset(asset.id, { sha256: asset.sha256, state, forceVerify: true });
  try {
    const bytes = await handle.readFile();
    if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
      throw new ApiError(409, "ILLUSTRATION_ASSET_CHANGED", "图片字节在校验期间变化，请重新核对原素材。");
    }
    const raster = await sharp(bytes, { limitInputPixels: 64_000_000, failOn: "error" }).autoOrient()
      .resize(32, 32, { fit: "fill" }).flatten({ background: "white" }).toColourspace("srgb").raw().toBuffer();
    return createHash("sha256").update(raster).digest("hex");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "ILLUSTRATION_DECODE_FAILED", "图片无法完整解码，不能计入文章配图。");
  } finally { await handle.close(); }
}

export class EditorialService {
  constructor({ store, geoService = null, mediaAssets = null, productionArtifacts = null, publicOrigin = "https://example.invalid",
    clock = () => new Date(), verifyReadback = null, beforeActivation = null, aiApproval = null,
    illustrationCohort = OFFICIAL_ILLUSTRATION_COHORT } = {}) {
    this.store = store;
    this.geoService = geoService;
    this.mediaAssets = mediaAssets;
    this.productionArtifacts = productionArtifacts;
    this.publicOrigin = ownOrigin(publicOrigin);
    this.clock = clock;
    this.verifyReadback = verifyReadback;
    this.beforeActivation = beforeActivation;
    this.aiApproval = aiApproval;
    this.illustrationCohort = illustrationCohort;
  }

  #state(state = this.store.snapshot()) {
    if (![2, 3, 4].includes(state.schemaVersion) || ["stories", "editions", "destinations", "websiteReleases", "websiteRoutes", "editorialRequests"].some(key => !Array.isArray(state[key]))) {
      throw new ApiError(503, "EDITORIAL_MIGRATION_REQUIRED", "编辑服务需要先完成版本化迁移。");
    }
    return state;
  }

  #writeIdentity(scope, input, ctx) {
    if (!ctx || typeof ctx !== "object" || !["local", "session"].includes(ctx.method)) throw new ApiError(403, "AGENT_SCOPE_DENIED", "编辑与公开发布操作仅允许管理员。");
    const actor = editorialText(ctx.actor, "actor", 120);
    if (typeof ctx.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(ctx.idempotencyKey)) {
      throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "新编辑操作必须提供 8 到 128 位 Idempotency-Key。");
    }
    const keyHash = hashObject({ actor, scope, key: ctx.idempotencyKey });
    const requestHash = hashObject(input);
    return { actor, keyHash, requestHash };
  }

  async #write(scope, input, ctx, handler, prepare = null) {
    const { actor, keyHash, requestHash } = this.#writeIdentity(scope, input, ctx);
    let review = null;
    if (prepare) {
      const state = this.#state();
      const previous = this.#priorRequest(state, scope, input, ctx);
      if (previous) return structuredClone(previous.result);
      review = await prepare(state, { actor, ifMatch: ctx.ifMatch, now: this.clock() });
    }
    const payload = { scope, requestHash, ...(review ? { requestedBy: actor } : {}),
      ...(review?.aiReview ? { aiReview: { actor: review.aiReview.actor, evidenceHash: review.aiReview.evidenceHash } } : {}) };
    const { result } = await this.store.mutate({ type: `editorial.${scope.split(":")[0]}`,
      actor: review?.aiReview?.actor ?? review?.effectActor ?? actor, payload, includeState: false }, async state => {
      this.#state(state);
      const previous = state.editorialRequests.find(row => row.keyHash === keyHash);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "此幂等键已用于不同请求。");
        return JsonStore.noChange(previous.result);
      }
      const result = await handler(state, { actor, ifMatch: ctx.ifMatch, payload, now: this.clock(), review });
      state.editorialRequests.push({ keyHash, actor, scope, requestHash, result: structuredClone(result), at: this.clock().toISOString() });
      return result;
    });
    return result;
  }

  #priorRequest(state, scope, input, ctx) {
    const { keyHash, requestHash } = this.#writeIdentity(scope, input, ctx);
    const prior = state.editorialRequests.find(row => row.keyHash === keyHash);
    if (prior && prior.requestHash !== requestHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "此幂等键已用于不同请求。");
    return prior;
  }

  catalog() { return this.#catalog(this.#state()); }

  #catalog(state) {
    const bundled = platformCatalog();
    return { version: bundled.version, note: bundled.note, platforms: bundled.platforms.map(platform => ({ ...platform,
      configuredAccountCount: state.accounts.filter(account => account.platformId === platform.id).length,
      activeAccountCount: state.accounts.filter(account => account.platformId === platform.id && account.status === "active").length,
      identityVerifiedCount: state.accounts.filter(account => account.platformId === platform.id && account.identityReview?.status === "verified").length,
      destinationCount: state.destinations.filter(destination => destination.platformId === platform.id).length,
    })) };
  }

  bootstrap() {
    const state = this.#state();
    return { schemaVersion: state.schemaVersion, revision: state.revision, catalog: this.#catalog(state),
      ...(this.aiApproval ? { aiApprovalEnabled: true } : {}),
      illustrationCopyBases: activeCohortBases(state, this.illustrationCohort, this.publicOrigin),
      accounts: state.accounts.map(entity), destinations: state.destinations.map(entity),
      stories: state.stories.map(entity), editions: state.editions.map(row => this.#editionEntity(state, row)),
      variants: state.content.filter(row => isEditorialVariantSchema(row.snapshotSchema)).map(row => this.#originalReviewEntity(state, row)),
      releases: state.websiteReleases.map(row => this.#originalReviewEntity(state, row)), routes: state.websiteRoutes.map(entity), claims: state.claims };
  }

  listAccounts() { return { items: this.#state().accounts.map(entity) }; }
  getAccount(id) { return entity(record(this.#state().accounts, id, "ACCOUNT_NOT_FOUND")); }
  listDestinations() { return { items: this.#state().destinations.map(entity) }; }
  getDestination(id) { return entity(record(this.#state().destinations, id, "DESTINATION_NOT_FOUND")); }
  listStories() { return { items: this.#state().stories.map(entity) }; }
  listReleases() {
    const state = this.#state();
    return { items: state.websiteReleases.map(row => this.#originalReviewEntity(state, row)) };
  }
  getRelease(id) {
    const state = this.#state(), row = record(state.websiteReleases, id, "RELEASE_NOT_FOUND");
    return this.#originalReviewEntity(state, row);
  }
  ownsVariant(id) { return this.store.snapshot().content.some(row => row.id === id && row.snapshotSchema !== undefined); }
  getVariant(id) {
    const state = this.#state(), row = record(state.content, id, "CONTENT_NOT_FOUND");
    if (!isEditorialVariantSchema(row.snapshotSchema)) throw new ApiError(409, "EDITORIAL_SCHEMA_UNSUPPORTED", "内容不是受支持的编辑快照版本。");
    return this.#originalReviewEntity(state, row);
  }

  getStory(id) {
    const state = this.#state();
    return { ...entity(record(state.stories, id, "STORY_NOT_FOUND")),
      editions: state.editions.filter(row => row.storyId === id).map(row => this.#editionEntity(state, row)),
      variants: state.content.filter(row => row.storyId === id && isEditorialVariantSchema(row.snapshotSchema))
        .map(row => this.#originalReviewEntity(state, row)),
      releases: state.websiteReleases.filter(row => row.storyId === id).map(row => this.#originalReviewEntity(state, row)) };
  }

  #editionEntity(state, edition) {
    let translationStatus = "original";
    if (edition.sourceEditionId) {
      const source = state.editions.find(row => row.id === edition.sourceEditionId);
      translationStatus = !source || state.editions.some(row => row.familyId === source.familyId && row.editorialRevision > source.editorialRevision)
        ? "needs_review" : "source_revision_linked";
    }
    return { ...entity(edition), translationStatus };
  }
  getEdition(id) { const state = this.#state(); return this.#editionEntity(state, record(state.editions, id, "EDITION_NOT_FOUND")); }

  suggestIllustrations(input) {
    editorialInput(input, ["title", "summary", "body"]);
    const { title, summary, body } = normalizeEditorialNaming({ ...input, summary: input.summary ?? "", assetRefs: [] }, "zh-CN");
    return suggestArticleIllustrations({ title, summary, body });
  }

  #illustrationEntity(state, plan) {
    const frozen = state.editions.some(edition => edition.illustrationPlanId === plan.id);
    const assets = state.mediaAssets, keys = state.articleIllustrationProducerKeys ?? [];
    const isComplete = plan.slots.every(slot => {
      const evidence = slot.evidence;
      return evidence && assets.some(asset => asset.id === evidence.assetId && asset.status === "reviewed" && asset.sha256 === evidence.sha256) &&
        (slot.kind !== "scene" || evidence.designerCompositor?.statement?.sceneBriefHash === sceneBriefHashForPlan(plan, slot)) &&
        [evidence.designerCompositor, evidence.imageGen].every(proof =>
          !proof || keys.some(key => key.id === proof.producerKeyId && !key.revokedAt));
    });
    const result = entity(plan);
    for (const slot of result.slots) {
      if (slot.kind === "scene") slot.sceneBriefHash = sceneBriefHashForPlan(plan, slot);
    }
    return { ...result, frozen, isComplete };
  }

  listArticleIllustrations(storyId) {
    const state = this.#state();
    record(state.stories, storyId, "STORY_NOT_FOUND");
    return { items: (state.articleIllustrationPlans ?? []).filter(plan => plan.storyId === storyId)
      .map(plan => this.#illustrationEntity(state, plan)) };
  }

  getArticleIllustrations(storyId, planId) {
    const state = this.#state();
    const plan = this.#illustrationEntity(state,
      record((state.articleIllustrationPlans ?? []).filter(plan => plan.storyId === storyId), planId, "ILLUSTRATION_PLAN_NOT_FOUND"));
    return { ...plan, workOrders: plan.slots.map(slot => ({ workOrder: articleIllustrationWorkOrder(plan, slot),
      ...(slot.imageGeneration ? { imageGenPrompt: articleIllustrationImageGenPrompt(plan, slot) } : {}) })) };
  }

  #cohortBase(state, releaseId, { storyId, locale }) {
    return cohortBaseRelease(state, { cohort: this.illustrationCohort, publicOrigin: this.publicOrigin, releaseId, storyId, locale });
  }

  #editionPlan(state, edition) {
    return edition?.illustrationPlanId ? state.articleIllustrationPlans?.find(plan => plan.id === edition.illustrationPlanId) : undefined;
  }

  #requiresOriginalReview(state, editionId) {
    return this.#editionPlan(state, state.editions.find(row => row.id === editionId))?.baseReleaseId !== undefined;
  }

  #originalVariantReviewCurrent(state, content, now = this.clock()) {
    const approval = content?.approval;
    if (approval?.articleReviewScope !== ORIGINAL_ILLUSTRATION_REVIEW || !approval.aiApproval?.evidenceHash ||
        approval.aiApproval.snapshotHash !== content.snapshotHash || !approval.articleReviewBinding?.sourcesAndMediaHash) return false;
    const destination = state.destinations.find(row => row.id === content.destinationId);
    return approval.articleReviewBinding.destinationHash === hashObject(originalIllustrationDestination(destination)) &&
      approval.articleReviewBinding.sourcesAndMediaHash === hashObject(currentOriginalReviewBasis(state, content, { publicOrigin: this.publicOrigin, now }));
  }

  #originalReleaseReviewCurrent(state, release, content = state.content.find(row => row.id === release.contentId), now = this.clock()) {
    const approval = release.publicApproval;
    if (approval?.articleReviewScope !== ORIGINAL_ILLUSTRATION_REVIEW || !approval.aiApproval?.evidenceHash ||
        approval.aiApproval.snapshotHash !== release.snapshotHash || !this.#originalVariantReviewCurrent(state, content, now)) return false;
    const binding = content.approval.articleReviewBinding;
    return approval.articleReviewBinding?.destinationHash === binding.destinationHash &&
      approval.articleReviewBinding?.sourcesAndMediaHash === binding.sourcesAndMediaHash &&
      approval.articleReviewBinding?.variantReviewHash === content.approval.aiApproval.evidenceHash;
  }

  #assertOriginalReleaseReviewCurrent(state, release, content, now) {
    if (!this.aiApproval || !this.#originalReleaseReviewCurrent(state, release, content, now)) {
      throw new PolicyError("AI_ORIGINAL_ILLUSTRATION_REVIEW_REQUIRED", "激活前须对当前只加图差异取得两道新的 AI 审核。");
    }
  }

  #originalReviewEntity(state, row) {
    const result = entity(row);
    if (this.aiApproval && ["approved", "scheduled"].includes(row.status) && this.#requiresOriginalReview(state, row.editionId)) {
      const current = row.publicSnapshot ? this.#originalReleaseReviewCurrent(state, row) : this.#originalVariantReviewCurrent(state, row);
      if (!current) result.originalIllustrationReviewPending = true;
    }
    return result;
  }

  #checkCohortAddition(state, candidate, plan) {
    const edition = state.editions.find(row => row.id === candidate.editionId) ?? candidate;
    plan ??= this.#editionPlan(state, edition);
    if (plan?.baseReleaseId === undefined) return null;
    const base = this.#cohortBase(state, plan.baseReleaseId, candidate);
    if (edition.illustrationPlanId && articleIllustrationPlanHash(plan) !== edition.illustrationPlanHash) {
      throw new PolicyError("ARTICLE_ILLUSTRATION_PLAN_CHANGED", "原文加图证据与已冻结母稿配图计划不一致。");
    }
    const originalEdition = record(state.editions, base.editionId, "EDITION_NOT_FOUND");
    if ((edition.sourceEditionId ?? null) !== (originalEdition.sourceEditionId ?? null)) {
      throw new PolicyError("ILLUSTRATION_COPY_SCOPE_CHANGED", "原文加图不能改变原公开稿的译文来源。");
    }
    if (candidate.destinationId !== undefined) {
      const destination = record(state.destinations, candidate.destinationId, "DESTINATION_NOT_FOUND");
      if (destination.kind !== "owned_origin" || destination.platformId !== "official-site" || destination.visibility !== "public" ||
          destination.locator?.origin !== this.publicOrigin || destination.accountId) {
        throw new PolicyError("OWNED_PUBLIC_DESTINATION_REQUIRED", "原文加图修订只适用于同一正式官网地址。");
      }
    }
    assertCohortAddition(state, base, plan, candidate);
    const now = this.clock();
    for (const id of candidate.claimIds) {
      if (!publicEditorialClaim(state.claims.find(claim => claim.id === id), { now })) {
        throw new PolicyError("PUBLIC_CLAIM_REQUIRED", "原文加图须保留当前仍获准公开的原事实来源。");
      }
    }
    return base;
  }

  async createArticleIllustrations(storyId, input, ctx) {
    editorialInput(input, ["locale", "articleType", "title", "summary", "body", "slots", "baseReleaseId"]);
    assertLocaleFormat(input.locale, "article");
    return this.#write(`illustration_plan_created:${storyId}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const story = record(state.stories, storyId, "STORY_NOT_FOUND"); assertMatch(story, ifMatch);
      if (story.status === "archived") throw new PolicyError("STORY_ARCHIVED", "不能在已归档选题上新增配图计划。");
      let text;
      let base;
      if (input.baseReleaseId !== undefined) {
        base = this.#cohortBase(state, input.baseReleaseId, { storyId, locale: input.locale });
        assertCohortText(base, { ...input, format: "article", summary: input.summary ?? "" });
        text = base.publicSnapshot;
      } else {
        text = normalizeEditorialNaming({ ...input, summary: input.summary ?? "", assetRefs: [] }, input.locale);
      }
      const article = { locale: input.locale, title: text.title, summary: text.summary, body: text.body };
      const normalized = normalizeArticleIllustrationPlan(input, article);
      if (base) assertCohortPlanPlacement(base, normalized.slots);
      state.articleIllustrationPlans ??= [];
      const plan = { id: nextId("ILP", state.articleIllustrationPlans), schema: ARTICLE_ILLUSTRATION_SCHEMA,
        storyId, locale: article.locale, title: article.title, ...normalized, styleYear: articleIllustrationStyleYear(now),
        ...(base ? { baseReleaseId: base.id } : {}), revision: 1, createdBy: actor, createdAt: now.toISOString() };
      state.articleIllustrationPlans.push(plan);
      Object.assign(payload, { storyId, planId: plan.id, sourceHash: plan.sourceHash });
      return this.#illustrationEntity(state, plan);
    });
  }

  async bindArticleIllustration(storyId, planId, input, ctx) {
    const slotId = editorialId(input?.slotId, "slotId");
    const assetId = editorialId(input?.assetId, "assetId");
    return this.#write(`illustration_bound:${planId}:${slotId}`, input, ctx, async (state, { actor, ifMatch, now, payload }) => {
      const plan = record((state.articleIllustrationPlans ?? []).filter(plan => plan.storyId === storyId), planId, "ILLUSTRATION_PLAN_NOT_FOUND");
      assertMatch(plan, ifMatch);
      if (plan.baseReleaseId !== undefined) this.#cohortBase(state, plan.baseReleaseId, plan);
      if (state.editions.some(edition => edition.illustrationPlanId === plan.id)) {
        throw new PolicyError("ILLUSTRATION_PLAN_FROZEN", "该配图计划已绑定不可变母稿，调整请另开计划。");
      }
      const slot = record(plan.slots, slotId, "ILLUSTRATION_SLOT_NOT_FOUND");
      const asset = record(state.mediaAssets, assetId, "MEDIA_ASSET_NOT_FOUND");
      const evidence = validateIllustrationEvidence(input, plan, slot, asset, state.articleIllustrationProducerKeys);
      const otherSlots = plan.slots.filter(item => item !== slot && item.evidence);
      const reuse = otherSlots.some(item => item.evidence.assetId === asset.id || item.evidence.sha256 === asset.sha256);
      if (reuse) throw new PolicyError("ILLUSTRATION_ASSET_DUPLICATE", "不同图位必须使用不同的实际图片。");
      const visualFingerprint = await illustrationFingerprint(this.mediaAssets, asset, state);
      if (otherSlots.some(item => item.evidence.visualFingerprint === visualFingerprint)) {
        throw new PolicyError("ILLUSTRATION_ASSET_DUPLICATE", "编码变化不能使同一个画面计为两张图片。");
      }
      Object.assign(payload, { storyId, planId, slotId, assetId, sha256: asset.sha256, previousSha256: slot.evidence?.sha256 ?? null });
      slot.evidence = { ...evidence, visualFingerprint, boundBy: actor, boundAt: now.toISOString() };
      plan.revision++;
      return this.#illustrationEntity(state, plan);
    });
  }

  listIllustrationProducerKeys() {
    return { items: (this.#state().articleIllustrationProducerKeys ?? []).map(entity) };
  }

  async registerIllustrationProducerKey(input, ctx) {
    editorialInput({ label: input?.label ?? null }, ["label"]);
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !["label", "publicKey"].includes(key))) {
      throw new ApiError(400, "INVALID_INPUT", "请只提交已授权工位的名称与公开密钥。");
    }
    const label = editorialText(input.label, "label", 120);
    const identity = normalizeIllustrationProducerKey(input.publicKey);
    return this.#write("illustration_producer_registered", input, ctx, (state, { actor, now, payload }) => {
      state.articleIllustrationProducerKeys ??= [];
      const previous = state.articleIllustrationProducerKeys.find(key => key.id === identity.id);
      if (previous) throw new ApiError(409, "ILLUSTRATION_PRODUCER_ALREADY_REGISTERED", "此工位公钥已登记。如已撤销，请使用新的工位公钥。");
      const row = { ...identity, label, createdBy: actor, createdAt: now.toISOString(), revokedAt: null };
      state.articleIllustrationProducerKeys.push(row); payload.producerKeyId = row.id;
      return entity(row);
    });
  }

  async revokeIllustrationProducerKey(id, input, ctx) {
    editorialInput(input, ["reason"]);
    const reason = editorialText(input.reason, "reason", 500);
    return this.#write(`illustration_producer_revoked:${id}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const row = record(state.articleIllustrationProducerKeys, id, "ILLUSTRATION_PRODUCER_NOT_FOUND"); assertMatch(row, ifMatch);
      if (row.revokedAt) throw new ApiError(409, "ILLUSTRATION_PRODUCER_REVOKED", "该工位公钥已撤销。");
      Object.assign(row, { revokedAt: now.toISOString(), revokedBy: actor, revocationReason: reason });
      payload.producerKeyId = row.id;
      return entity(row);
    });
  }

  accountHistory(id) {
    const state = this.#state(); record(state.accounts, id, "ACCOUNT_NOT_FOUND");
    const items = [];
    for (const event of state.events) {
      const baseline = event.type === "editorial.schema_migrated" && event.payload?.accountBaselines?.find(row => row.id === id);
      if (baseline) items.push({ sequence: event.sequence, at: event.at, actor: event.actor, origin: "migration_baseline", after: baseline });
      if (event.payload?.accountId === id) items.push({ sequence: event.sequence, at: event.at, actor: event.actor,
        origin: event.payload.before || event.payload.after ? "user_change" : "legacy_event_without_field_history",
        type: event.type, before: event.payload.before ?? null, after: event.payload.after ?? null, reason: event.payload.reason ?? null });
    }
    return { accountId: id, items };
  }

  async createAccount(input, ctx) {
    editorialInput(input, ["platformId", "handle", "profileUrl", "language", "displayName"]);
    const platform = platformById(input.platformId);
    if (platform.kind === "owned_site") throw new ApiError(400, "OWNED_DESTINATION_REQUIRED", "官网使用受核实的自有目的地，不创建社媒账号。");
    const handle = editorialText(input.handle, "handle", 160);
    const profileUrl = requirePublicUrl(input.profileUrl, "profileUrl");
    const language = input.language ?? (platform.localeHint.includes("en") && !platform.localeHint.startsWith("zh") ? "en-US" : "zh-CN");
    if (!EDITORIAL_LOCALES.includes(language)) throw new ApiError(400, "INVALID_LOCALE", "账号语言无效。");
    const displayName = editorialText(input.displayName ?? handle, "displayName", 240);
    return this.#write("account_created", input, ctx, (state, { actor, now, payload }) => {
      if (state.accounts.some(row => row.platformId === platform.id && (row.handle.toLowerCase() === handle.toLowerCase() || row.profileUrl === profileUrl))) {
        throw new ApiError(409, "DUPLICATE_ACCOUNT", "此平台账号身份已登记，请使用现有记录。");
      }
      const id = nextId("ACC", state.accounts);
      const account = { id, platformId: platform.id, platform: platform.name, handle, profileUrl, language, displayName,
        status: "draft", policyStatus: "manual_review_required", policyCheckedAt: null,
        identityVersion: 1, identityReview: { status: "unverified" }, revision: 1,
        publishMode: "manual", createdAt: now.toISOString(), updatedAt: now.toISOString() };
      state.accounts.push(account); Object.assign(payload, { accountId: id, after: profileAudit(account) });
      return entity(account);
    });
  }

  async updateAccount(id, supplied, ctx) {
    const { input, proof } = separateReviewProof(supplied);
    editorialInput(input, ["handle", "profileUrl", "language", "displayName", "status", "identityConfirmed", "policyStatus", "policyCheckedAt", "reviewNote", "sourceExcerpt", "reason"]);
    if (input.status !== undefined && !ACCOUNT_STATUSES.has(input.status)) throw new ApiError(400, "INVALID_ACCOUNT_STATUS", "账号状态无效。");
    if (input.policyStatus !== undefined && !POLICIES.has(input.policyStatus)) throw new ApiError(400, "INVALID_POLICY_STATUS", "规则审阅状态无效。");
    if (input.identityConfirmed !== undefined && typeof input.identityConfirmed !== "boolean") throw new ApiError(400, "INVALID_INPUT", "身份确认必须是布尔值。");
    const reviewer = this.aiApproval ?? ctx?.aiApproval;
    const needsReview = reviewer && (input.identityConfirmed === true || input.policyStatus === "reviewed");
    const evidence = (account, now) => ({
      accountId: account.id, platformId: account.platformId ?? null, revision: account.revision ?? 0,
      identityVersion: account.identityVersion ?? 0, previousHandle: account.handle, previousProfileUrl: account.profileUrl ?? "",
      handle: input.handle === undefined ? account.handle : editorialText(input.handle, "handle", 160),
      profileUrl: input.profileUrl === undefined ? account.profileUrl ?? "" : input.profileUrl === "" ? "" : requirePublicUrl(input.profileUrl, "profileUrl"),
      status: input.status ?? account.status, identityObservedByOperator: input.identityConfirmed === true,
      policyStatus: input.policyStatus ?? account.policyStatus, policyCheckedAt: input.policyCheckedAt === undefined
        ? account.policyCheckedAt ?? null : timestamp(input.policyCheckedAt, "policyCheckedAt", now),
      reviewNote: editorialText(input.reviewNote, "reviewNote", 2000),
      sourceExcerpt: input.sourceExcerpt === undefined ? null : editorialText(input.sourceExcerpt, "sourceExcerpt", 8000),
    });
    const prepare = needsReview ? async (state, { ifMatch, now }) => {
      const account = record(state.accounts, id, "ACCOUNT_NOT_FOUND");
      assertMatch(account, ifMatch);
      const source = evidence(account, now);
      if (input.identityConfirmed === true && (!account.platformId || !source.profileUrl)) {
        throw new PolicyError("ACCOUNT_IDENTITY_INCOMPLETE", "核对身份前必须配置真实平台和公开主页。");
      }
      if (input.policyStatus === "reviewed" && !source.policyCheckedAt) {
        throw new ApiError(400, "POLICY_REVIEW_TIME_REQUIRED", "规则审核必须提供真实依据时间。");
      }
      return reviewOperationEvidence(reviewer, { kind: "account_identity_policy", subjectId: id,
        evidence: source, proof, criteria: [
          "核对公开主页和账号身份证据与拟登记账号的一致性。仅有勾选或缺真实来源时返回缺项。",
          "核对实际平台规则及其日期，说明对该账号适用的范围。确认资料与审核规则不产生任何登录凭据或外发权限。",
        ] });
    } : null;
    return this.#write(`account_updated:${id}`, input, ctx, (state, { actor, ifMatch, now, payload, review }) => {
      const account = record(state.accounts, id, "ACCOUNT_NOT_FOUND"); assertMatch(account, ifMatch);
      if (review) assertOperationReviewCurrent(review, evidence(account, now));
      const before = profileAudit(account);
      const handle = input.handle === undefined ? account.handle : editorialText(input.handle, "handle", 160);
      const profileUrl = input.profileUrl === undefined ? (account.profileUrl ?? "") : input.profileUrl === "" ? "" : requirePublicUrl(input.profileUrl, "profileUrl");
      const changed = handle !== account.handle || profileUrl !== (account.profileUrl ?? "");
      if (changed) {
        if (unresolvedAccountActions(state, id).length) throw new ApiError(409, "ACCOUNT_RECONCILIATION_REQUIRED", "账号尚有结果未确定的动作，先完成原账号回读。");
        account.identityVersion = (account.identityVersion ?? 1) + 1;
        account.identityReview = { status: "unverified" };
        account.policyStatus = "manual_review_required";
        delete account.policyAiReview;
      }
      account.handle = handle; account.profileUrl = profileUrl;
      if (input.language !== undefined) {
        if (!EDITORIAL_LOCALES.includes(input.language)) throw new ApiError(400, "INVALID_LOCALE", "账号语言无效。");
        account.language = input.language;
      }
      if (input.displayName !== undefined) account.displayName = editorialText(input.displayName, "displayName", 240);
      if (input.identityConfirmed === true || input.policyStatus === "reviewed") {
        const note = editorialText(input.reviewNote, "reviewNote", 2000);
        if (input.identityConfirmed === true) {
          if (!account.platformId || !account.profileUrl) throw new PolicyError("ACCOUNT_IDENTITY_INCOMPLETE", "确认身份前必须配置真实平台和公开主页。");
          account.identityReview = { status: "verified", reviewedBy: review?.aiReview.actor ?? actor, reviewedAt: now.toISOString(), note,
            ...(review ? { aiReview: review.aiReview } : {}) };
        }
        if (input.policyStatus === "reviewed") account.policyReviewNote = note;
      }
      if (input.identityConfirmed === false) account.identityReview = { status: "unverified" };
      if (input.policyStatus !== undefined) account.policyStatus = input.policyStatus;
      if (input.policyCheckedAt !== undefined) account.policyCheckedAt = timestamp(input.policyCheckedAt, "policyCheckedAt", now);
      if (input.policyStatus === "reviewed") {
        if (!account.policyCheckedAt) throw new ApiError(400, "POLICY_REVIEW_TIME_REQUIRED", "规则审阅必须记录真实时间。");
        account.policyReviewedBy = review?.aiReview.actor ?? actor;
        if (review) account.policyAiReview = review.aiReview;
      }
      if (input.policyStatus === "manual_review_required") delete account.policyAiReview;
      if (input.status !== undefined) {
        if (["paused", "archived"].includes(input.status)) {
          const reason = editorialText(input.reason, "reason", 2000);
          if (unresolvedAccountActions(state, id).length) throw new ApiError(409, "ACCOUNT_RECONCILIATION_REQUIRED", "结果未确定时不能暂停或归档账号，先回读并登记原结果。");
          payload.reason = reason;
          if (input.status === "archived") Object.assign(account, { archivedAt: now.toISOString(), archivedBy: actor, archiveReason: reason });
        }
        account.status = input.status;
      }
      if (account.status === "active" && (account.identityReview?.status !== "verified" || account.policyStatus !== "reviewed" || !account.policyCheckedAt)) {
        throw new PolicyError("ACCOUNT_NOT_READY", "启用账号前必须核实身份与平台规则。");
      }
      account.revision = (account.revision ?? 0) + 1; account.updatedAt = now.toISOString();
      Object.assign(payload, { accountId: id, before, after: profileAudit(account) });
      return entity(account);
    }, prepare);
  }

  async createDestination(input, ctx) {
    editorialInput(input, ["platformId", "accountId", "kind", "name", "locator", "visibility"]);
    const platform = platformById(input.platformId);
    if (!DESTINATION_KINDS.has(input.kind)) throw new ApiError(400, "INVALID_DESTINATION", "目的地类型无效。");
    if (!VISIBILITIES.has(input.visibility ?? "unverified")) throw new ApiError(400, "INVALID_DESTINATION", "目的地可见性无效。");
    if ((input.kind === "owned_origin") !== (platform.kind === "owned_site")) throw new PolicyError("DESTINATION_KIND_MISMATCH", "官网与外部账号目的地类型不一致。");
    if (platform.id === "discord" && input.kind !== "community_channel") throw new PolicyError("DESTINATION_KIND_MISMATCH", "Discord 必须明确服务器和频道。");
    if (platform.id === "reddit" && input.kind !== "community") throw new PolicyError("DESTINATION_KIND_MISMATCH", "Reddit 必须明确目标社区。");
    if (platform.kind === "technical_artifact" && !["repository", "artifact_repository"].includes(input.kind)) throw new PolicyError("DESTINATION_KIND_MISMATCH", "技术作品平台必须明确仓库或作品目的地。");
    const locator = destinationLocator(input.kind, input.locator, this.publicOrigin);
    const name = editorialText(input.name, "name", 240);
    return this.#write("destination_created", input, ctx, (state, { now, payload }) => {
      const account = input.accountId ? record(state.accounts, input.accountId, "ACCOUNT_NOT_FOUND") : null;
      if (platform.kind !== "owned_site" && (!account || account.platformId !== platform.id)) throw new PolicyError("DESTINATION_ACCOUNT_MISMATCH", "目的地必须绑定该平台的真实账号。");
      if (platform.kind === "owned_site" && account) throw new PolicyError("DESTINATION_ACCOUNT_MISMATCH", "自有官网不绑定社媒账号。");
      if (state.destinations.some(row => row.platformId === platform.id && row.accountId === (account?.id ?? null) && hashObject(row.locator) === hashObject(locator))) {
        throw new ApiError(409, "DUPLICATE_DESTINATION", "此目的地已经登记。");
      }
      const row = { id: nextId("DST", state.destinations), platformId: platform.id, accountId: account?.id ?? null,
        kind: input.kind, name, locator, visibility: input.visibility ?? "unverified", status: "draft", identityVersion: 1,
        identityReview: { status: "unverified" }, policyStatus: "manual_review_required", policyCheckedAt: null,
        revision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      state.destinations.push(row); payload.destinationId = row.id; return entity(row);
    });
  }

  async updateDestination(id, supplied, ctx) {
    const { input, proof } = separateReviewProof(supplied);
    editorialInput(input, ["name", "locator", "status", "visibility", "identityConfirmed", "policyStatus", "policyCheckedAt", "reviewNote", "sourceExcerpt", "reason"]);
    if (input.status !== undefined && !ACCOUNT_STATUSES.has(input.status)) throw new ApiError(400, "INVALID_DESTINATION_STATUS", "目的地状态无效。");
    if (input.visibility !== undefined && !VISIBILITIES.has(input.visibility)) throw new ApiError(400, "INVALID_DESTINATION", "目的地可见性无效。");
    if (input.policyStatus !== undefined && !POLICIES.has(input.policyStatus)) throw new ApiError(400, "INVALID_POLICY_STATUS", "规则审阅状态无效。");
    if (input.identityConfirmed !== undefined && typeof input.identityConfirmed !== "boolean") throw new ApiError(400, "INVALID_INPUT", "身份确认必须是布尔值。");
    const reviewer = this.aiApproval ?? ctx?.aiApproval;
    const needsReview = reviewer && (input.identityConfirmed === true || input.policyStatus === "reviewed");
    const evidence = (state, row, now) => {
      const account = row.accountId ? record(state.accounts, row.accountId, "ACCOUNT_NOT_FOUND") : null;
      return {
        destinationId: row.id, platformId: row.platformId, kind: row.kind, revision: row.revision,
        identityVersion: row.identityVersion, previousLocator: row.locator, previousVisibility: row.visibility,
        account: account ? accountEditorialIdentity(account) : null,
        locator: input.locator === undefined ? row.locator : destinationLocator(row.kind, input.locator, this.publicOrigin),
        name: input.name ?? row.name, status: input.status ?? row.status, visibility: input.visibility ?? row.visibility,
        identityObservedByOperator: input.identityConfirmed === true, policyStatus: input.policyStatus ?? row.policyStatus,
        policyCheckedAt: input.policyCheckedAt === undefined ? row.policyCheckedAt ?? null : timestamp(input.policyCheckedAt, "policyCheckedAt", now),
        reviewNote: editorialText(input.reviewNote, "reviewNote", 2000),
        sourceExcerpt: input.sourceExcerpt === undefined ? null : editorialText(input.sourceExcerpt, "sourceExcerpt", 8000),
      };
    };
    const prepare = needsReview ? async (state, { ifMatch, now }) => {
      const row = record(state.destinations, id, "DESTINATION_NOT_FOUND");
      assertMatch(row, ifMatch);
      const source = evidence(state, row, now);
      if (input.policyStatus === "reviewed" && !source.policyCheckedAt) {
        throw new ApiError(400, "POLICY_REVIEW_TIME_REQUIRED", "目的地规则审核必须提供真实依据时间。");
      }
      return reviewOperationEvidence(reviewer, { kind: "destination_identity_policy", subjectId: id,
        evidence: source, proof, criteria: [
          "根据实际证据核对唯一目的地、所属账号或官网 origin、规则及可见范围。缺少真实来源时返回缺项。",
          "判断当前已提供证据支持的范围。不得代替目标平台协议、私域权限或外发授权。",
        ] });
    } : null;
    return this.#write(`destination_updated:${id}`, input, ctx, (state, { actor, ifMatch, now, payload, review }) => {
      const row = record(state.destinations, id, "DESTINATION_NOT_FOUND"); assertMatch(row, ifMatch);
      if (review) assertOperationReviewCurrent(review, evidence(state, row, now));
      const locator = input.locator === undefined ? row.locator : destinationLocator(row.kind, input.locator, this.publicOrigin);
      const visibility = input.visibility ?? row.visibility;
      if ((hashObject(locator) !== hashObject(row.locator) || visibility !== row.visibility || ["paused", "archived"].includes(input.status)) &&
          (state.accountOperations ?? []).some(operation => operation.destinationId === id && operation.status === "in_progress")) {
        throw new ApiError(409, "DESTINATION_RECONCILIATION_REQUIRED", "目的地尚有结果未确定的动作，先按原快照回读并登记结果。");
      }
      if (hashObject(locator) !== hashObject(row.locator) || visibility !== row.visibility) {
        row.identityVersion += 1; row.identityReview = { status: "unverified" }; row.policyStatus = "manual_review_required";
        delete row.policyAiReview;
      }
      row.locator = locator; row.visibility = visibility;
      if (input.name !== undefined) row.name = editorialText(input.name, "name", 240);
      if (input.identityConfirmed === true || input.policyStatus === "reviewed") {
        const note = editorialText(input.reviewNote, "reviewNote", 2000);
        if (input.identityConfirmed === true) {
          destinationLocator(row.kind, row.locator, this.publicOrigin);
          row.identityReview = { status: "verified", reviewedBy: review?.aiReview.actor ?? actor, reviewedAt: now.toISOString(), note,
            ...(review ? { aiReview: review.aiReview } : {}) };
        }
        if (input.policyStatus === "reviewed") row.policyReviewNote = note;
      }
      if (input.identityConfirmed === false) row.identityReview = { status: "unverified" };
      if (input.policyStatus !== undefined) row.policyStatus = input.policyStatus;
      if (input.policyCheckedAt !== undefined) row.policyCheckedAt = timestamp(input.policyCheckedAt, "policyCheckedAt", now);
      if (input.policyStatus === "reviewed") {
        if (!row.policyCheckedAt) throw new ApiError(400, "POLICY_REVIEW_TIME_REQUIRED", "目的地规则审阅必须记录时间。");
        row.policyReviewedBy = review?.aiReview.actor ?? actor;
        if (review) row.policyAiReview = review.aiReview;
      }
      if (input.policyStatus === "manual_review_required") delete row.policyAiReview;
      if (["paused", "archived"].includes(input.status)) payload.reason = editorialText(input.reason, "reason", 2000);
      if (input.status !== undefined) row.status = input.status;
      if (row.status === "active" && (row.identityReview?.status !== "verified" || row.policyStatus !== "reviewed" || !row.policyCheckedAt)) {
        throw new PolicyError("DESTINATION_NOT_READY", "启用目的地前必须完成身份和规则审阅。");
      }
      if (row.kind === "owned_origin" && row.status === "active" && row.visibility !== "public") throw new PolicyError("PUBLIC_DESTINATION_REQUIRED", "官网发布目的地必须明确为公开。");
      row.revision += 1; row.updatedAt = now.toISOString(); payload.destinationId = id; return entity(row);
    }, prepare);
  }

  async createStory(input, ctx) {
    editorialInput(input, ["workingTitle", "claimIds", "topicIds"]);
    const workingTitle = editorialText(input.workingTitle, "workingTitle", 240);
    const ids = stringArray(input.claimIds ?? [], "claimIds");
    const topics = stringArray(input.topicIds ?? [], "topicIds");
    return this.#write("story_created", input, ctx, (state, { actor, now, payload }) => {
      claimBindings(state, ids);
      const row = { id: nextId("STY", state.stories), workingTitle, claimIds: ids, topicIds: topics,
        owner: actor, status: "draft", revision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      state.stories.push(row); payload.storyId = row.id; return entity(row);
    });
  }

  async updateStory(id, input, ctx) {
    editorialInput(input, ["workingTitle", "status", "reason"]);
    if (input.status !== undefined && !["draft", "active", "archived"].includes(input.status)) throw new ApiError(400, "INVALID_STORY_STATUS", "选题状态无效。");
    return this.#write(`story_updated:${id}`, input, ctx, (state, { ifMatch, now, payload }) => {
      const row = record(state.stories, id, "STORY_NOT_FOUND"); assertMatch(row, ifMatch);
      if (input.workingTitle !== undefined) row.workingTitle = editorialText(input.workingTitle, "workingTitle", 240);
      if (input.status === "archived") payload.reason = editorialText(input.reason, "reason", 2000);
      if (input.status !== undefined) row.status = input.status;
      row.revision += 1; row.updatedAt = now.toISOString(); payload.storyId = id; return entity(row);
    });
  }

  async createEdition(storyId, input, ctx) {
    editorialInput(input, ["locale", "format", "title", "summary", "body", "blocks", "claimIds", "assetRefs", "sourceEditionId", "supersedesEditionId", "illustrationPlanId"]);
    assertLocaleFormat(input.locale, input.format);
    if (input.illustrationPlanId !== undefined && input.format !== "article") {
      throw new ApiError(400, "ARTICLE_ILLUSTRATION_NOT_APPLICABLE", "配图计划适用于文章形式。");
    }
    const ids = stringArray(input.claimIds ?? [], "claimIds");
    return this.#write(`edition_created:${storyId}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const story = record(state.stories, storyId, "STORY_NOT_FOUND"); assertMatch(story, ifMatch);
      if (story.status === "archived") throw new PolicyError("STORY_ARCHIVED", "归档选题不能继续创建修订。");
      const plan = input.illustrationPlanId === undefined ? null : record(state.articleIllustrationPlans, input.illustrationPlanId, "ILLUSTRATION_PLAN_NOT_FOUND");
      const preserving = plan?.baseReleaseId !== undefined;
      let title = editorialText(input.title, "title", 240, { preserve: preserving });
      let summary = editorialText(input.summary ?? "", "summary", 2000, { empty: true, preserve: preserving });
      let body = editorialText(input.body, "body", 50_000, { preserve: true });
      let refs = normalizeEditorialAssetRefs(input.assetRefs ?? [], input.locale);
      let blocks = normalizeEditorialBlocks(input.blocks, body, refs);
      let productNaming;
      if (!preserving) {
        ({ title, summary, body, blocks, assetRefs: refs, productNaming } =
          normalizeEditorialNaming({ title, summary, body, blocks, assetRefs: refs }, input.locale));
      }
      const familyId = `${storyId}-${input.locale}-${input.format}`;
      const previous = state.editions.filter(row => row.familyId === familyId).sort((a, b) => b.editorialRevision - a.editorialRevision)[0];
      if (previous && input.supersedesEditionId !== previous.id) throw new ApiError(409, "EDITION_REVISION_REQUIRED", "同语言与形式已有版本，请明确基于最新修订建立新版本。");
      if (!previous && input.supersedesEditionId) throw new ApiError(409, "EDITION_REVISION_MISMATCH", "不存在可替代的来源修订。");
      let sourceEditionId = null;
      if (preserving) {
        const base = this.#cohortBase(state, plan.baseReleaseId, { storyId, locale: input.locale });
        const originalEdition = record(state.editions, base.editionId, "EDITION_NOT_FOUND");
        sourceEditionId = originalEdition.sourceEditionId ?? null;
        if (input.sourceEditionId !== undefined && input.sourceEditionId !== sourceEditionId) {
          throw new PolicyError("ILLUSTRATION_COPY_SCOPE_CHANGED", "原文加图不能改变原公开稿的译文来源。");
        }
      } else if (input.sourceEditionId) {
        const source = record(state.editions, input.sourceEditionId, "EDITION_NOT_FOUND");
        if (source.storyId !== storyId || source.format !== input.format || source.locale === input.locale) throw new PolicyError("TRANSLATION_SOURCE_MISMATCH", "翻译来源必须是同选题同形式的另一语言修订。");
        sourceEditionId = source.id;
      }
      assertEditorialAssets(state, refs);
      const row = { id: nextId("ED", state.editions), familyId, storyId, locale: input.locale, format: input.format,
        editorialRevision: (previous?.editorialRevision ?? 0) + 1, supersedesEditionId: previous?.id ?? null,
        sourceEditionId, title, summary, body, blocks, claimIds: ids, claimBindings: claimBindings(state, ids), assetRefs: refs,
        snapshotSchema: EDITORIAL_SCHEMA, ...(productNaming ? { productNaming } : {}), createdBy: actor, createdAt: now.toISOString() };
      if (plan) {
        if (!this.#checkCohortAddition(state, row, plan)) assertArticleIllustrations(state, plan, row, { exactSource: true });
        row.illustrationPlanId = plan.id;
        row.illustrationPlanHash = articleIllustrationPlanHash(plan);
      }
      row.snapshotHash = hashObject(editorialEditionSnapshot(row)); state.editions.push(row);
      story.revision += 1; story.updatedAt = now.toISOString(); payload.storyId = storyId; payload.editionId = row.id;
      return this.#editionEntity(state, row);
    });
  }

  async createVariant(editionId, input, ctx) {
    editorialInput(input, ["destinationId", "title", "summary", "body", "blocks", "assetRefs", "adaptationNote", "supersedesContentId"]);
    return this.#write(`variant_created:${editionId}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const edition = record(state.editions, editionId, "EDITION_NOT_FOUND"); assertMatch(edition, ifMatch);
      if (edition.snapshotSchema === EDITORIAL_NATIVE_EDITION_SCHEMA) throw new PolicyError("NATIVE_CANDIDATE_REQUIRED", "自动派生的中立形式稿须通过完整原生候选与独立终检形成渠道稿。");
      if (hashObject(editorialEditionSnapshot(edition)) !== edition.snapshotHash) throw new PolicyError("EDITORIAL_EDITION_CHANGED", "来源修订摘要不一致。");
      const story = record(state.stories, edition.storyId, "STORY_NOT_FOUND");
      if (story.status === "archived") throw new PolicyError("STORY_ARCHIVED", "归档选题不能继续创建渠道稿。");
      const destination = record(state.destinations, input.destinationId, "DESTINATION_NOT_FOUND");
      if (destination.status === "archived") throw new PolicyError("DESTINATION_ARCHIVED", "目的地已归档。");
      const account = destination.accountId ? record(state.accounts, destination.accountId, "ACCOUNT_NOT_FOUND") : null;
      const plan = this.#editionPlan(state, edition);
      const preserving = plan?.baseReleaseId !== undefined;
      if (preserving && ["title", "summary", "body", "blocks", "assetRefs"].some(field => Object.hasOwn(input, field))) {
        throw new PolicyError("ARTICLE_AUGMENTATION_OVERRIDES_FORBIDDEN", "原文加图的官网渠道稿必须从已冻结母稿直接复制。");
      }
      let refs = input.assetRefs === undefined ? structuredClone(edition.assetRefs) : normalizeEditorialAssetRefs(input.assetRefs, edition.locale);
      let title = input.title === undefined ? edition.title : editorialText(input.title, "title", 240);
      let summary = input.summary === undefined ? edition.summary : editorialText(input.summary, "summary", 2000, { empty: true });
      let body = input.body === undefined ? edition.body : editorialText(input.body, "body", 50_000, { preserve: true });
      let blocks = input.blocks === undefined && input.body === undefined && input.assetRefs === undefined
        ? structuredClone(edition.blocks) : normalizeEditorialBlocks(input.blocks, body, refs);
      let productNaming;
      if (!preserving) {
        ({ title, summary, body, blocks, assetRefs: refs, productNaming } =
          normalizeEditorialNaming({ title, summary, body, blocks, assetRefs: refs }, edition.locale));
      }
      assertEditorialAssets(state, refs);
      if (input.supersedesContentId) {
        const previous = record(state.content, input.supersedesContentId, "CONTENT_NOT_FOUND");
        if (previous.storyId !== edition.storyId || previous.destinationId !== destination.id || previous.locale !== edition.locale || previous.format !== edition.format) {
          throw new PolicyError("VARIANT_REVISION_MISMATCH", "替代稿必须属于相同选题、语言、形式和目的地。");
        }
      }
      const row = { id: nextId("CNT", state.content), title,
        summary,
        body, blocks, contentType: edition.format, claimIds: [...edition.claimIds], claimBindings: structuredClone(edition.claimBindings),
        platforms: [account?.platform ?? "个人官网"], owner: actor, opinion: false, visibility: "private",
        status: "draft", version: 1, approval: null, storyId: edition.storyId, editionId,
        editionHash: edition.snapshotHash, locale: edition.locale, format: edition.format, destinationId: destination.id,
        destinationSnapshot: destinationEditorialIdentity(destination), accountSnapshot: account ? accountEditorialIdentity(account) : null,
        assetRefs: refs, snapshotSchema: EDITORIAL_SCHEMA, ...(productNaming ? { productNaming } : {}), supersedesContentId: input.supersedesContentId ?? null,
        adaptationNote: editorialText(input.adaptationNote ?? "", "adaptationNote", 2000, { empty: true }),
        createdAt: now.toISOString(), updatedAt: now.toISOString() };
      editorialInput({ title: row.title, body: row.body, summary: row.summary, blocks: row.blocks }, ["title", "body", "summary", "blocks"]);
      this.#checkCohortAddition(state, row, plan);
      row.snapshotHash = hashObject(editorialVariantSnapshot(row)); row.snapshotHashV2 = row.snapshotHash;
      state.content.push(row); payload.contentId = row.id; payload.editionId = editionId; return entity(row);
    });
  }

  async materializeCandidate(candidateId, input, ctx) {
    editorialInput(input, ["packageHash", "qualityReportHashes", "reviewSnapshotHash"]);
    if (!["local", "session"].includes(ctx?.method)) throw new ApiError(403, "AGENT_SCOPE_DENIED", "原生包建稿仅允许管理员。");
    const initial = this.#state(), initialCandidate = record(initial.nativeCandidatePackages, candidateId, "CANDIDATE_NOT_FOUND");
    const keyHash = hashObject({ actor: ctx.actor, scope: `native_materialized:${candidateId}`, key: ctx.idempotencyKey });
    if (!initial.editorialRequests.some(request => request.keyHash === keyHash) && initialCandidate.package.artifactRefs.length) {
      if (typeof this.productionArtifacts?.verifyReferences !== "function") throw new ApiError(503, "NATIVE_ARTIFACT_VERIFICATION_UNAVAILABLE", "原生包建稿前必须核对真实附件字节。");
      await this.productionArtifacts.verifyReferences(initialCandidate.package.artifactRefs);
    }
    return this.#write(`native_materialized:${candidateId}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const candidate = record(state.nativeCandidatePackages, candidateId, "CANDIDATE_NOT_FOUND"); assertMatch(candidate, ifMatch);
      const review = validateCandidateForReview(state, candidateId, { ...input, now });
      const pkg = review.package, story = record(state.stories, pkg.storyId, "STORY_NOT_FOUND");
      if (story.status === "archived") throw new PolicyError("STORY_ARCHIVED", "归档选题不能创建新渠道稿。");
      const effectKey = hashObject({ candidateId, packageHash: pkg.packageHash, reviewSnapshotHash: review.reviewSnapshotHash });
      const previous = state.draftMaterializations.find(row => row.effectKey === effectKey);
      if (previous) return entity(record(state.content, previous.contentId, "CONTENT_NOT_FOUND"));
      const destination = record(state.destinations, pkg.destinationIdentitySnapshot?.id, "DESTINATION_NOT_FOUND");
      const account = destination.accountId ? record(state.accounts, destination.accountId, "ACCOUNT_NOT_FOUND") : null;
      assertLocaleFormat(pkg.locale, pkg.editorialFormat);
      const title = editorialText(pkg.title, "title", 240), body = editorialText(pkg.body, "body", 50_000, { preserve: true });
      const summary = editorialText(pkg.summary, "summary", 2000, { empty: true });
      const refs = normalizeEditorialAssetRefs(pkg.orderedMediaRefs, pkg.locale), blocks = normalizeEditorialBlocks(pkg.orderedBlocks, body, refs);
      if (hashObject(refs) !== hashObject(pkg.orderedMediaRefs) || hashObject(blocks) !== hashObject(pkg.orderedBlocks)) throw new PolicyError("NATIVE_PACKAGE_INVALID", "原生包正文块或媒体引用尚未符合编辑合同。");
      const productNaming = pkg.productNaming;
      if (pkg.editorialFormat === "article") {
        const findings = genericProductNamingFindings({
          title,
          summary,
          body,
          blocks,
        }, { location: `nativePackage.${candidateId}` });
        if (productNaming?.version !== PRODUCT_NAMING_POLICY_VERSION || findings.length) {
          throw new PolicyError(genericProductNamingErrorCode(findings),
            "原生公开包必须使用当前产品通用名称策略，且不得包含具体产品/品牌名或 XX 占位符。", { findings });
        }
      }
      assertEditorialAssets(state, refs, { reviewed: true });
      const sourceEditions = pkg.sourceEditionRefs.map(ref => {
        const source = record(state.editions, ref.id, "EDITION_NOT_FOUND");
        if (source.storyId !== story.id || source.snapshotHash !== ref.sha256 || source.editorialRevision !== ref.revision) throw new PolicyError("SOURCE_OUTDATED", "中立母版来源与冻结版本不一致。");
        return source;
      });
      if (sourceEditions.some(source => this.#editionPlan(state, source)?.baseReleaseId !== undefined)) {
        throw new PolicyError("ARTICLE_AUGMENTATION_OVERRIDES_FORBIDDEN", "原文加图修订仅限原官网地址，不能用于派生原生渠道稿。");
      }
      let edition;
      const compatible = sourceEditions.filter(source => source.locale === pkg.locale && source.format === pkg.editorialFormat);
      if (compatible.length > 1) throw new PolicyError("AMBIGUOUS_MOTHER_EDITION", "同一语言与形式有多个母版修订，请明确唯一来源后重建计划。");
      if (compatible.length === 1) edition = compatible[0];
      else {
        const transform = candidate.neutralTransformRef;
        if (!transform || !/^[a-f0-9]{64}$/.test(transform.formatTransformKey ?? "") || !/^[a-f0-9]{64}$/.test(transform.transformSpecHash ?? "") || !Object.hasOwn(transform, "expectedFamilyHeadId")) throw new PolicyError("FORMAT_TRANSFORM_REQUIRED", "跨语言或跨形式须有已完成的中立转换任务与族版本快照。");
        const task = state.productionTaskBlueprints.find(task => task.taskId === transform.taskId && task.kind === "format.transform" && task.jobId === candidate.jobId);
        const attempt = state.productionTaskAttempts.find(attempt => attempt.taskId === task?.taskId && attempt.status === "succeeded");
        const neutral = attempt?.resultManifest?.data;
        if (!task || !neutral || neutral.locale !== pkg.locale || neutral.format !== pkg.editorialFormat) throw new PolicyError("FORMAT_TRANSFORM_REQUIRED", "中立转换没有准确语言、形式与真实成功回执。");
        const familyId = `${story.id}-${pkg.locale}-${pkg.editorialFormat}`;
        const head = state.editions.filter(row => row.familyId === familyId).sort((a, b) => b.editorialRevision - a.editorialRevision)[0];
        const lineage = { schema: "pengmanager.format-lineage/v1", derivedFromEditionRefs: structuredClone(pkg.sourceEditionRefs),
          transformKind: transform.transformKind, transformSpecHash: transform.transformSpecHash };
        if (!["cross_format", "cross_language", "cross_format_and_language"].includes(lineage.transformKind)) throw new PolicyError("FORMAT_TRANSFORM_REQUIRED", "中立转换类型不完整。");
        lineage.lineageHash = hashObject(lineage);
        if (pkg.lineageHash !== lineage.lineageHash) throw new PolicyError("NATIVE_PACKAGE_CHANGED", "最终包与中立派生谱系不一致。");
        if (head?.formatTransformKey === transform.formatTransformKey && head.formatLineage?.lineageHash === lineage.lineageHash) edition = head;
        else {
          if ((head?.id ?? null) !== transform.expectedFamilyHeadId) throw new ApiError(409, "EDITION_FAMILY_CHANGED", "该形式的最新中立修订已变化；保留人工版本并重新核对计划。");
          const neutralTitle = editorialText(neutral.title, "neutral.title", 240), neutralBody = editorialText(neutral.body, "neutral.body", 50_000, { preserve: true });
          const neutralBlocks = normalizeEditorialBlocks(neutral.blocks, neutralBody, []);
          edition = { id: nextId("ED", state.editions), familyId, storyId: story.id, locale: pkg.locale, format: pkg.editorialFormat,
            editorialRevision: (head?.editorialRevision ?? 0) + 1, supersedesEditionId: head?.id ?? null,
            sourceEditionId: lineage.transformKind === "cross_language" && sourceEditions.length === 1 ? sourceEditions[0].id : null,
            title: neutralTitle, summary: editorialText(neutral.summary ?? "", "neutral.summary", 2000, { empty: true }), body: neutralBody,
            blocks: neutralBlocks, claimIds: pkg.sourceClaimBindings.map(binding => binding.claimId),
            claimBindings: pkg.sourceClaimBindings.map(binding => ({ claimId: binding.claimId, hash: binding.fingerprint ?? binding.hash })), assetRefs: [],
            snapshotSchema: EDITORIAL_NATIVE_EDITION_SCHEMA, formatLineage: lineage, formatTransformKey: transform.formatTransformKey,
            ...(productNaming ? { productNaming: structuredClone(productNaming) } : {}), createdBy: actor, createdAt: now.toISOString() };
          edition.snapshotHash = hashObject(editorialEditionSnapshot(edition)); state.editions.push(edition);
          state.formatLineage.push({ id: `LIN-${hashObject({ editionId: edition.id, lineage }).slice(0, 24)}`, formatEditionId: edition.id, ...lineage });
        }
      }
      const row = { id: nextId("CNT", state.content), title, summary, body, blocks, contentType: pkg.editorialFormat,
        claimIds: pkg.sourceClaimBindings.map(binding => binding.claimId),
        claimBindings: pkg.sourceClaimBindings.map(binding => ({ claimId: binding.claimId, hash: binding.fingerprint ?? binding.hash })),
        platforms: [account?.platform ?? "个人官网"], owner: actor, opinion: false, visibility: "private", status: "draft", version: 1,
        approval: null, storyId: story.id, editionId: edition.id, editionHash: edition.snapshotHash, locale: pkg.locale, format: pkg.editorialFormat,
        destinationId: destination.id, destinationSnapshot: structuredClone(pkg.destinationIdentitySnapshot), accountSnapshot: structuredClone(pkg.accountIdentitySnapshot),
        assetRefs: refs, snapshotSchema: EDITORIAL_NATIVE_SCHEMA, ...(productNaming ? { productNaming: structuredClone(productNaming) } : {}), supersedesContentId: null, adaptationNote: "来自受控平台准备工单；独立终检完成，等待完整审核。",
        candidateId, publicationPackage: structuredClone(pkg), packageHash: pkg.packageHash, qualityReportHashes: [...review.envelope.qualityReportHashes],
        reviewEnvelope: structuredClone(review.envelope), reviewSnapshotHash: review.reviewSnapshotHash, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      row.snapshotHash = hashObject(editorialVariantSnapshot(row));
      validateEditorialVariant(state, row, account, { now, requireReady: true });
      state.content.push(row);
      state.draftMaterializations.push({ id: `MAT-${effectKey.slice(0, 24)}`, effectKey, candidateId, packageHash: pkg.packageHash,
        reviewSnapshotHash: review.reviewSnapshotHash, editionId: edition.id, contentId: row.id, createdBy: actor, createdAt: now.toISOString() });
      Object.assign(payload, { candidateId, packageHash: pkg.packageHash, reviewSnapshotHash: review.reviewSnapshotHash, contentId: row.id, editionId: edition.id });
      return entity(row);
    });
  }

  async #readArticleReviewImages(refs, state, evidence) {
    assertArticleReviewSafe(evidence);
    if (typeof this.mediaAssets?.readReviewedImagesForApproval !== "function") {
      throw new ApiError(503, "MEDIA_VERIFICATION_UNAVAILABLE", "文章审核需要核对实际图片字节。");
    }
    return this.mediaAssets.readReviewedImagesForApproval(refs, state);
  }

  async transitionVariant(id, input, ctx, { previousReleaseId, websiteAuthorization, reviewCall, platformReview } = {}) {
    editorialInput(input, ["target", "note", "reviewed", "snapshotHash", "reviewSnapshotHash", "reviewProof"]);
    if (!["local", "session"].includes(ctx?.method)) throw new ApiError(403, "AGENT_SCOPE_DENIED", "编辑审核与排期仅允许管理员。");
    const scope = `variant_transitioned:${id}`;
    const { reviewProof, ...writeInput } = input;
    const reviewOptions = { publicOrigin: this.publicOrigin, previousReleaseId, websiteAuthorization };
    let aiReview, articleEvidenceHash, originalReviewBinding;
    if (["approved", "scheduled"].includes(input.target)) {
      const state = this.#state(), row = record(state.content, id, "CONTENT_NOT_FOUND");
      const previous = this.#priorRequest(state, scope, writeInput, ctx);
      if (row.snapshotSchema === EDITORIAL_NATIVE_SCHEMA && !previous) {
        if (typeof this.productionArtifacts?.verifyReferences !== "function") throw new ApiError(503, "NATIVE_ARTIFACT_VERIFICATION_UNAVAILABLE", "原生稿批准前必须核对真实附件字节。");
        await this.productionArtifacts.verifyReferences(row.publicationPackage.artifactRefs);
        if (row.assetRefs.length) {
          if (typeof this.mediaAssets?.verifyForRelease !== "function") throw new ApiError(503, "MEDIA_VERIFICATION_UNAVAILABLE", "原生稿批准前必须核对真实媒体。");
          await this.mediaAssets.verifyForRelease(row.assetRefs);
        }
      }
      if (this.aiApproval && input.target === "approved" && !previous) {
        assertMatch(row, ctx.ifMatch);
        const base = this.#checkCohortAddition(state, row);
        validateEditorialVariant(state, row, null, { now: this.clock(), requireReady: true, allowHistoricalNaming: Boolean(base) });
        if (input.snapshotHash !== row.snapshotHash || row.snapshotSchema === EDITORIAL_NATIVE_SCHEMA && input.reviewSnapshotHash !== row.reviewSnapshotHash) {
          throw new PolicyError("EXACT_EDITORIAL_REVIEW_REQUIRED", "AI 审核必须绑定准确渠道快照与终检。");
        }
        const renewOriginal = base && !this.#originalVariantReviewCurrent(state, row);
        if (!["approved", "scheduled"].includes(row.status) || row.approval?.aiApproval && !renewOriginal) {
          transitionContent(row, "approved", { approvedBy: ctx.actor }, { now: this.clock() });
        }
        const nativeEvidence = reviewedCopy(state, row, { ...reviewOptions, base, now: this.clock() });
        const evidence = platformReview ? { ...nativeEvidence, platformReview: platformReview.evidence } : nativeEvidence;
        originalReviewBinding = originalReviewBindingFromEvidence(evidence);
        let images;
        if (evidence.articleReview) {
          images = await this.#readArticleReviewImages(row.assetRefs, state, evidence);
          articleEvidenceHash = hashObject(evidence);
        } else if (row.assetRefs.length && row.snapshotSchema !== EDITORIAL_NATIVE_SCHEMA) {
          if (!this.mediaAssets) throw new ApiError(503, "MEDIA_VERIFICATION_UNAVAILABLE", "批准前需要核对真实媒体。");
          await this.mediaAssets.verifyForRelease(row.assetRefs, state);
        }
        if (!evidence.articleReview && editorialSensitiveFindings(evidence).length) throw new PolicyError("AI_APPROVAL_SENSITIVE_INPUT", "渠道审核输入含有须先处理的敏感资料。");
        const reviewInput = {
          kind: "editorial.variant", subjectId: id, snapshotHash: row.snapshotHash, proof: reviewProof, evidence,
          criteria: originalReviewBinding ? originalIllustrationCriteria("variant", evidence.articleReview?.styleYear) : ["用绑定来源核对完整稿件中的事实、数量、日期、出处和适用范围，分辨事实和意见。",
            "核对渠道、版本、正文结构、图片上下文、替代文字和图注；保留已有素材实际审核边界。",
            "外发由独立授权与发布步骤负责。本次不能创造权限、改写原文或批准缺乏依据的结论。",
            ...(evidence.articleReview ? [ARTICLE_REVIEW_CRITERION] : []),
            ...(evidence.articleReview?.styleYear === undefined ? [] : [articleIllustrationStyleCriterion(evidence.articleReview.styleYear)]),
            ...(platformReview?.criteria ?? [])],
          ...(images ? { images } : {}),
        };
        aiReview = reviewCall ? await reviewCall(reviewInput, work => this.aiApproval.review(work)) : await this.aiApproval.review(reviewInput);
      }
    }
    const result = await this.#write(scope, writeInput, ctx, (state, { actor, ifMatch, now, payload }) => {
      const row = record(state.content, id, "CONTENT_NOT_FOUND"); assertMatch(row, ifMatch);
      if (!isEditorialVariantSchema(row.snapshotSchema)) throw new ApiError(409, "EDITORIAL_SCHEMA_UNSUPPORTED", "内容不是受支持的编辑版本。");
      const requireReady = ["approved", "scheduled"].includes(input.target);
      const base = this.#checkCohortAddition(state, row);
      if (requireReady && base && !this.aiApproval) {
        throw new ApiError(503, "AI_APPROVAL_UNAVAILABLE", "原文加图仅可由已配置的正式 AI 审核工位确认。");
      }
      validateEditorialVariant(state, row, null, { now, requireReady, requireApproval: input.target === "scheduled", allowHistoricalNaming: Boolean(base) });
      if (articleEvidenceHash) {
        const nativeEvidence = reviewedCopy(state, row, { ...reviewOptions, base, now });
        assertArticleReviewCurrent(platformReview ? { ...nativeEvidence, platformReview: platformReview.evidence } : nativeEvidence, articleEvidenceHash);
      }
      if (input.target === "approved" && ((this.aiApproval ? !aiReview : input.reviewed !== true) || input.snapshotHash !== row.snapshotHash ||
          row.snapshotSchema === EDITORIAL_NATIVE_SCHEMA && input.reviewSnapshotHash !== row.reviewSnapshotHash)) {
        throw new PolicyError("EXACT_EDITORIAL_REVIEW_REQUIRED", "批准前必须完整核对并确认这一正文与媒体快照。");
      }
      if (this.aiApproval && input.target === "scheduled" && row.approval?.aiApproval?.snapshotHash !== row.snapshotHash) {
        throw new PolicyError("AI_APPROVAL_REQUIRED", "排期前先取得当前准确渠道稿的 AI 审核回执。");
      }
      if (this.aiApproval && input.target === "scheduled" && base && !this.#originalVariantReviewCurrent(state, row, now)) {
        throw new PolicyError("AI_ORIGINAL_ILLUSTRATION_REVIEW_REQUIRED", "排期前先对当前只加图差异取得新的 AI 审核。");
      }
      if (["draft", "blocked", "archived"].includes(input.target) && state.websiteRoutes.some(route => state.websiteReleases.find(release => release.id === route.activeReleaseId)?.contentId === id)) {
        throw new PolicyError("ACTIVE_RELEASE_WITHDRAWAL_REQUIRED", "先撤回正在公开的版本，不能直接改变其正文状态。");
      }
      const renewed = this.aiApproval && input.target === "approved"
        && ["approved", "scheduled"].includes(row.status) && (!row.approval?.aiApproval ||
          originalReviewBinding && !this.#originalVariantReviewCurrent(state, row, now));
      const approvedBy = aiReview?.actor ?? actor;
      const next = renewed
        ? { ...row, version: row.version + 1, updatedAt: now.toISOString(), approval: { ...row.approval, approvedBy, approvedAt: now.toISOString() } }
        : transitionContent(row, input.target, { approvedBy, note: input.note }, { now });
      if (input.target === "approved") next.approval = { ...next.approval, snapshotSchema: row.snapshotSchema, snapshotHash: row.snapshotHash, reviewed: true,
        ...(aiReview ? { aiApproval: aiReview, authorizedBy: actor } : {}),
        ...(originalReviewBinding ? { articleReviewScope: ORIGINAL_ILLUSTRATION_REVIEW, articleReviewBinding: originalReviewBinding } : {}),
        ...(row.snapshotSchema === EDITORIAL_NATIVE_SCHEMA ? { packageHash: row.packageHash, reviewSnapshotHash: row.reviewSnapshotHash } : {}) };
      else if (["draft", "blocked", "archived"].includes(input.target)) next.approval = null;
      state.content[state.content.findIndex(item => item.id === id)] = next; payload.contentId = id; payload.target = input.target;
      if (aiReview) payload.aiReview = { actor: approvedBy, evidenceHash: aiReview.evidenceHash };
      return entity(next);
    }, aiReview ? async () => ({ aiReview }) : null);
    const finalBackup = await this.geoService?.backupFinalContent(result);
    return finalBackup ? { ...result, finalBackup } : result;
  }

  #validatePublicCandidate(state, release, { now = this.clock(), checkLive = false } = {}) {
    if (!releaseSnapshotValid(release)) throw new PolicyError("PUBLIC_SNAPSHOT_CHANGED", "公开快照与审核版本不一致。");
    const content = record(state.content, release.contentId, "CONTENT_NOT_FOUND");
    const destination = record(state.destinations, content.destinationId, "DESTINATION_NOT_FOUND");
    const base = checkLive ? null : this.#checkCohortAddition(state, content);
    validateEditorialVariant(state, content, null, { now, requireReady: true, requireApproval: true, allowHistoricalNaming: checkLive || Boolean(base) });
    if (!checkLive) {
      if (base) {
        if (release.canonicalPath !== base.canonicalPath || release.previousReleaseId !== base.id) {
          throw new ApiError(409, "RELEASE_ROUTE_CONFLICT", "原文加图修订只能替换已授权的原地址版本。");
        }
        if (hashObject(websiteSnapshot(content, base.canonicalPath, this.publicOrigin)) !== release.snapshotHash) {
          throw new PolicyError("PUBLIC_SNAPSHOT_CHANGED", "原文加图的公开快照与已冻结渠道稿不一致。");
        }
      } else {
        const findings = editorialNamingFindings(release.publicSnapshot, `release.${release.id}`);
        if (findings.length) throw new PolicyError(genericProductNamingErrorCode(findings), "公开快照仍包含具体产品名称或占位符。", { findings });
      }
      if (content.format === "article") {
        const edition = record(state.editions, content.editionId, "EDITION_NOT_FOUND");
        const plan = this.#editionPlan(state, edition);
        if (!base) assertArticleIllustrations(state, plan, content);
        if (articleIllustrationPlanHash(plan) !== edition.illustrationPlanHash || release.illustrationPlanHash !== edition.illustrationPlanHash) {
          throw new PolicyError("ARTICLE_ILLUSTRATION_PLAN_CHANGED", "配图审核证据已变化，请按准确母稿建立新修订。");
        }
      }
    }
    if (!["approved", "scheduled", "published"].includes(content.status)) throw new PolicyError("CONTENT_NOT_APPROVED", "公开稿尚未批准。");
    if (destination.kind !== "owned_origin" || destination.platformId !== "official-site" || destination.visibility !== "public" || destination.locator.origin !== this.publicOrigin) {
      throw new PolicyError("OWNED_PUBLIC_DESTINATION_REQUIRED", "发布必须使用已核实的本站公开目的地。");
    }
    if (release.publicSnapshot.canonicalUrl !== `${this.publicOrigin}${release.canonicalPath}`) throw new PolicyError("OWNED_ORIGIN_MISMATCH", "官网 origin 与审批快照不一致。");
    if (release.contentSnapshotHash !== content.snapshotHash) throw new PolicyError("PUBLIC_SNAPSHOT_CHANGED", "渠道稿与公开快照不一致。");
    for (const id of content.claimIds) {
      if (!publicEditorialClaim(state.claims.find(claim => claim.id === id), { now })) throw new PolicyError("PUBLIC_CLAIM_REQUIRED", "公开内容只能引用获准公开、未过期、低敏感且有安全公开来源的事实。");
    }
    const sensitive = editorialSensitiveFindings(release.publicSnapshot);
    if (sensitive.length || /(?:file:\/\/|\/Users\/[^\s/]+\/|\/home\/[^\s/]+\/)/i.test(JSON.stringify(release.publicSnapshot))) {
      throw new PolicyError("PUBLIC_CONTENT_SENSITIVE", "公开快照包含敏感资料或本机私有路径。", sensitive);
    }
    if (checkLive && (!release.publicApproval || release.publicApproval.snapshotHash !== release.snapshotHash || !["live_unverified", "published"].includes(release.status))) {
      throw new PolicyError("RELEASE_NOT_PUBLIC", "此修订尚未获准公开或已经撤回。");
    }
    return { content, base };
  }

  async createRelease(input, ctx) {
    editorialInput(input, ["contentId", "slug"]);
    const slug = editorialText(input.slug, "slug", 100);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ApiError(400, "INVALID_SLUG", "slug 只能使用小写英文字母、数字和单个连字符。");
    return this.#write("release_created", input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const content = record(state.content, input.contentId, "CONTENT_NOT_FOUND"); assertMatch(content, ifMatch);
      if (state.websiteReleases.some(row => row.contentId === content.id)) throw new ApiError(409, "RELEASE_EXISTS", "此渠道稿已有官网修订，请复用现有记录。");
      if (!isEditorialVariantSchema(content.snapshotSchema)) throw new PolicyError("EDITORIAL_VARIANT_REQUIRED", "官网只发布独立审核的编辑渠道稿。");
      if (!this.#checkCohortAddition(state, content)) {
        const findings = editorialNamingFindings(content, `variant.${content.id}`);
        if (content.productNaming?.version !== PRODUCT_NAMING_POLICY_VERSION || findings.length) {
          throw new PolicyError(genericProductNamingErrorCode(findings),
            "新发布公开文案必须使用当前产品通用名称策略，且不得包含具体产品/品牌名或 XX 占位符。", { findings });
        }
      }
      if (content.snapshotSchema === EDITORIAL_NATIVE_SCHEMA && content.publicationPackage.nativeForm !== content.format) throw new PolicyError("WEBSITE_NATIVE_FORM_UNSUPPORTED", "官网页面只承载 article、image_text 和 video 原生包；其他形式请按准确目的地单独交付。");
      const canonicalPath = `/${LANGUAGES[content.locale]}/${SECTIONS[content.format]}/${slug}`;
      const existingFamily = state.websiteReleases.find(row => row.storyId === content.storyId && row.locale === content.locale && row.format === content.format);
      if (existingFamily && existingFamily.canonicalPath !== canonicalPath) throw new ApiError(409, "CANONICAL_ROUTE_MISMATCH", "同一语言形式的修订应沿用原正式 URL。");
      const existingRoute = state.websiteRoutes.find(row => row.canonicalPath === canonicalPath);
      if (existingRoute && existingRoute.storyId !== content.storyId) throw new ApiError(409, "CANONICAL_ROUTE_CONFLICT", "此正式 URL 已属于另一选题。");
      const publicSnapshot = websiteSnapshot(content, canonicalPath, this.publicOrigin);
      const edition = record(state.editions, content.editionId, "EDITION_NOT_FOUND");
      const row = { id: nextId("REL", state.websiteReleases), siteId: "official-site", storyId: content.storyId,
        editionId: content.editionId, contentId: content.id, locale: content.locale, format: content.format, slug, canonicalPath,
        contentSnapshotHash: content.snapshotHash, publicSnapshot, snapshotHash: hashObject(publicSnapshot),
        status: "draft", revision: 1, publicApproval: null, receipt: null, activationAt: null,
        previousReleaseId: existingRoute?.activeReleaseId ?? null, withdrawal: null, createdBy: actor,
        ...(edition.illustrationPlanHash ? { illustrationPlanHash: edition.illustrationPlanHash } : {}),
        createdAt: now.toISOString(), updatedAt: now.toISOString() };
      this.#validatePublicCandidate(state, row, { now }); state.websiteReleases.push(row); payload.releaseId = row.id; return entity(row);
    });
  }

  async publishEditionWithAi(editionId, input, ctx, { beforeActivate, reviewCall } = {}) {
    editorialInput(input, ["destinationId", "slug", "editionSnapshotHash", "expectedPreviousReleaseId",
      "supersedesContentId", "publicationAuthorized", "authorizationNote", "reviewProofs"]);
    if (!this.aiApproval) throw new ApiError(503, "AI_APPROVAL_UNAVAILABLE", "官网 AI 审核服务尚未配置。");
    const initial = this.#state(), edition = record(initial.editions, editionId, "EDITION_NOT_FOUND");
    const destination = record(initial.destinations, input.destinationId, "DESTINATION_NOT_FOUND");
    const slug = editorialText(input.slug, "slug", 100), note = editorialText(input.authorizationNote, "authorizationNote", 2000);
    if (input.publicationAuthorized !== true || input.editionSnapshotHash !== edition.snapshotHash ||
        !Object.hasOwn(input, "expectedPreviousReleaseId") ||
        !(input.expectedPreviousReleaseId === null || typeof input.expectedPreviousReleaseId === "string")) {
      throw new ApiError(400, "AI_PUBLICATION_AUTHORIZATION_REQUIRED", "须明确授权准确文章快照和本次官网替换范围。");
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ApiError(400, "INVALID_SLUG", "官网固定地址无效。");
    if (destination.kind !== "owned_origin" || destination.platformId !== "official-site" || destination.status !== "active" ||
        destination.identityReview?.status !== "verified" || destination.policyStatus !== "reviewed" ||
        destination.visibility !== "public" || destination.locator.origin !== this.publicOrigin) {
      throw new PolicyError("OWNED_PUBLIC_DESTINATION_REQUIRED", "自动发布只接受已获准的本站公开目的地。");
    }
    const proofs = input.reviewProofs ?? {};
    if (Object.getPrototypeOf(proofs) !== Object.prototype || Object.keys(proofs).length > 2 ||
        Object.keys(proofs).some(key => !/^editorial\.(?:variant|website_release):[A-Za-z0-9_-]{1,100}:[a-f0-9]{64}$/.test(key))) {
      throw new ApiError(400, "AI_APPROVAL_PROOF_INVALID", "工作流签章须绑定准确评审类型、对象与快照。");
    }
    const canonicalPath = `/${LANGUAGES[edition.locale]}/${SECTIONS[edition.format]}/${slug}`;
    const family = initial.websiteReleases.find(row => row.storyId === edition.storyId && row.locale === edition.locale && row.format === edition.format);
    if (family && family.canonicalPath !== canonicalPath) throw new ApiError(409, "CANONICAL_ROUTE_MISMATCH", "修订应沿用原正式 URL。");
    const identity = { editionId, editionSnapshotHash: edition.snapshotHash, destinationId: destination.id, slug,
      expectedPreviousReleaseId: input.expectedPreviousReleaseId, supersedesContentId: input.supersedesContentId ?? null, authorizationNote: note };
    const workflowId = hashObject({ authorizedBy: ctx?.actor ?? null, ...identity });
    const originalReviewRequired = this.#requiresOriginalReview(initial, editionId);
    const stageContext = (stage, entity) => ({ ...ctx, ifMatch: entity?.etag,
      idempotencyKey: hashObject(originalReviewRequired && ["review-variant", "review-release"].includes(stage)
        ? [workflowId, stage, ORIGINAL_ILLUSTRATION_REVIEW, entity.etag] : [workflowId, stage]) });
    const initialScope = `website_ai_authorized:${editionId}`;
    const approvedIntent = await this.#write(initialScope, identity, ctx, (state, { actor, now, payload }) => {
      const current = record(state.editions, editionId, "EDITION_NOT_FOUND");
      assertMatch(current, ctx.ifMatch);
      const route = state.websiteRoutes.find(item => item.canonicalPath === canonicalPath);
      if ((route?.activeReleaseId ?? null) !== identity.expectedPreviousReleaseId || route && route.storyId !== edition.storyId) {
        throw new ApiError(409, "RELEASE_ROUTE_CONFLICT", "授权时正式 URL 的活动修订已变化。");
      }
      if (edition.format === "article" && !edition.illustrationPlanId) {
        throw new PolicyError("ARTICLE_ILLUSTRATION_PLAN_REQUIRED", "官网文章必须先完成准确母稿的配图计划。");
      }
      const base = this.#checkCohortAddition(state, current);
      if (base && (base.id !== identity.expectedPreviousReleaseId || base.canonicalPath !== canonicalPath)) {
        throw new ApiError(409, "RELEASE_ROUTE_CONFLICT", "原文加图修订只能替换已授权的原地址版本。");
      }
      Object.assign(payload, { workflowId, editionId, canonicalPath, previousReleaseId: identity.expectedPreviousReleaseId });
      return { workflowId, authorizedBy: actor, authorizedAt: now.toISOString() };
    });
    const websiteAuthorization = originalReviewRequired ? { method: "exact_website_intent", hash: approvedIntent.workflowId,
      authorizedBy: approvedIntent.authorizedBy, editionId, editionSnapshotHash: identity.editionSnapshotHash,
      destinationId: destination.id, canonicalPath, previousReleaseId: identity.expectedPreviousReleaseId, note } : undefined;
    const activeAtStart = this.#state().websiteRoutes.find(item => item.canonicalPath === canonicalPath)?.activeReleaseId ?? null;
    const copyInput = { destinationId: destination.id, ...(identity.supersedesContentId ? { supersedesContentId: identity.supersedesContentId } : {}) };
    const currentEdition = this.getEdition(editionId);
    const variantRequest = this.#priorRequest(this.#state(), `variant_created:${editionId}`, copyInput, stageContext("variant", currentEdition));
    if (!variantRequest && activeAtStart !== identity.expectedPreviousReleaseId) {
      throw new ApiError(409, "RELEASE_ROUTE_CONFLICT", "创建渠道稿前，正式 URL 的活动修订已变化。");
    }
    let variant = variantRequest?.result ?? await this.createVariant(editionId, copyInput, stageContext("variant", currentEdition));
    variant = this.getVariant(variant.id);
    let release;
    let proofKey;
    try {
      if (variant.status === "draft") {
        variant = await this.transitionVariant(variant.id, { target: "fact_check" }, stageContext("fact-check", variant));
      }
      if (variant.status === "fact_check" || variant.originalIllustrationReviewPending) {
        proofKey = `editorial.variant:${variant.id}:${variant.snapshotHash}`;
        variant = await this.transitionVariant(variant.id, { target: "approved", snapshotHash: variant.snapshotHash,
          ...(proofs[proofKey] ? { reviewProof: proofs[proofKey] } : {}) }, stageContext("review-variant", variant),
        { previousReleaseId: identity.expectedPreviousReleaseId, websiteAuthorization, reviewCall });
      }
      if (variant.status === "approved") {
        variant = await this.transitionVariant(variant.id, { target: "scheduled" }, stageContext("schedule", variant));
      }
      if (!["scheduled", "published"].includes(variant.status)) {
        throw new PolicyError("AI_PUBLICATION_VARIANT_BLOCKED", "原官网渠道稿需要解决阻断后才能继续。");
      }
      const releaseInput = { contentId: variant.id, slug };
      const releaseRequest = this.#priorRequest(this.#state(), "release_created", releaseInput, stageContext("create-release", variant));
      if (!releaseRequest && activeAtStart !== identity.expectedPreviousReleaseId) {
        throw new ApiError(409, "RELEASE_ROUTE_CONFLICT", "创建候选前，正式 URL 的活动修订已变化。");
      }
      release = releaseRequest?.result ?? await this.createRelease(releaseInput, stageContext("create-release", variant));
      release = this.getRelease(release.id);
      if (release.status === "draft" || release.originalIllustrationReviewPending) {
        proofKey = `editorial.website_release:${release.id}:${release.snapshotHash}`;
        release = await this.approveRelease(release.id, { snapshotHash: release.snapshotHash,
          authorizationNote: note, ...(proofs[proofKey] ? { reviewProof: proofs[proofKey] } : {}) }, stageContext("review-release", release),
        { websiteAuthorization, reviewCall });
      }
      if (release.status === "approved") {
        release = await this.publishRelease(release.id, { confirm: true, expectedPreviousReleaseId: identity.expectedPreviousReleaseId },
          stageContext("activate", release), { beforeActivate });
      }
      if (release.status === "live_unverified") {
        release = await this.verifyRelease(release.id, { confirm: true }, stageContext("readback", release));
      }
      if (release.status !== "published" || !release.receipt) {
        throw new PolicyError("AI_PUBLICATION_READBACK_REQUIRED", "本次原官网候选尚无实际公开回执。");
      }
      return { ...approvedIntent, editionId, contentId: variant.id, releaseId: release.id, status: release.status, receipt: release.receipt };
    } catch (error) {
      if (error instanceof ApiError) {
        error.details = { ...error.details, workflow: { ...approvedIntent, editionId, contentId: variant.id,
          ...(release ? { releaseId: release.id } : {}),
          ...(["AI_APPROVAL_PENDING", "AI_APPROVAL_WORKER_REQUIRED"].includes(error.code) ? { proofKey } : {}) } };
      }
      throw error;
    }
  }

  async approveRelease(id, input, ctx, { websiteAuthorization, reviewCall } = {}) {
    editorialInput(input, ["reviewed", "snapshotHash", "authorizationNote", "reviewProof"]);
    const note = editorialText(input.authorizationNote, "authorizationNote", 2000);
    const scope = `release_approved:${id}`, { reviewProof, ...writeInput } = input;
    let aiReview, articleEvidenceHash, originalReviewBinding;
    if (this.aiApproval) {
      const state = this.#state();
      if (!this.#priorRequest(state, scope, writeInput, ctx)) {
        const row = record(state.websiteReleases, id, "RELEASE_NOT_FOUND"); assertMatch(row, ctx.ifMatch);
        const renewOriginal = this.#requiresOriginalReview(state, row.editionId) && !this.#originalReleaseReviewCurrent(state, row);
        if (row.status !== "draft" && !(row.status === "approved" && (!row.publicApproval?.aiApproval || renewOriginal))) {
          throw new ApiError(409, "INVALID_RELEASE_TRANSITION", "当前修订不处于待审核状态。");
        }
        if (input.snapshotHash !== row.snapshotHash) throw new PolicyError("EXACT_PUBLIC_REVIEW_REQUIRED", "AI 审核必须绑定准确公开快照。");
        const { content, base } = this.#validatePublicCandidate(state, row);
        if (content.approval?.aiApproval?.snapshotHash !== content.snapshotHash) {
          throw new PolicyError("AI_APPROVAL_REQUIRED", "官网候选先完成当前渠道稿的 AI 审核。");
        }
        if (base && !this.#originalVariantReviewCurrent(state, content)) {
          throw new PolicyError("AI_ORIGINAL_ILLUSTRATION_REVIEW_REQUIRED", "公开快照审核前，渠道稿须先完成只加图差异 AI 审核。");
        }
        const route = state.websiteRoutes.find(item => item.canonicalPath === row.canonicalPath);
        if ((route?.activeReleaseId ?? null) !== row.previousReleaseId) {
          throw new ApiError(409, "RELEASE_ROUTE_CONFLICT", "正式 URL 的当前修订已变化，请重新核对。");
        }
        const evidence = reviewedReleaseCopy(state, content, row, { publicOrigin: this.publicOrigin, note, actor: ctx.actor,
          base, websiteAuthorization, now: this.clock() });
        originalReviewBinding = originalReviewBindingFromEvidence(evidence);
        if (originalReviewBinding) originalReviewBinding.variantReviewHash = evidence.variantReview.hash;
        let images;
        if (evidence.articleReview) {
          images = await this.#readArticleReviewImages(row.publicSnapshot.assetRefs, state, evidence);
          articleEvidenceHash = hashObject(evidence);
        } else if (row.publicSnapshot.assetRefs.length) {
          if (!this.mediaAssets) throw new ApiError(503, "MEDIA_VERIFICATION_UNAVAILABLE", "批准前需要核对真实媒体。");
          await this.mediaAssets.verifyForRelease(row.publicSnapshot.assetRefs, state);
        }
        const reviewInput = {
          kind: "editorial.website_release", subjectId: id, snapshotHash: row.snapshotHash, proof: reviewProof,
          evidence,
          criteria: originalReviewBinding ? originalIllustrationCriteria("release", evidence.articleReview?.styleYear) : ["核对固定官网地址、当前替换范围、明确用户发布授权及公开事实来源。",
            "完整检查正文、图位、替代文字和图注，已登记媒体的授权证据必须与准确快照一致。",
            "指出敏感信息、夸大、错误或缺失证据；批准决定本身不等同激活或公开回读。",
            ...(evidence.articleReview ? [ARTICLE_REVIEW_CRITERION] : []),
            ...(evidence.articleReview?.styleYear === undefined ? [] : [articleIllustrationStyleCriterion(evidence.articleReview.styleYear)])],
          ...(images ? { images } : {}),
        };
        aiReview = reviewCall ? await reviewCall(reviewInput, work => this.aiApproval.review(work)) : await this.aiApproval.review(reviewInput);
      }
    }
    return this.#write(scope, writeInput, ctx, (state, { actor, ifMatch, now, payload }) => {
      const row = record(state.websiteReleases, id, "RELEASE_NOT_FOUND"); assertMatch(row, ifMatch);
      const renewOriginal = originalReviewBinding && !this.#originalReleaseReviewCurrent(state, row, undefined, now);
      if (row.status !== "draft" && !(this.aiApproval && row.status === "approved" && (!row.publicApproval?.aiApproval || renewOriginal))) {
        throw new ApiError(409, "INVALID_RELEASE_TRANSITION", "只有待审核修订可以批准。");
      }
      if ((this.aiApproval ? !aiReview : input.reviewed !== true) || input.snapshotHash !== row.snapshotHash) throw new PolicyError("EXACT_PUBLIC_REVIEW_REQUIRED", "必须核对这一语言的完整公开正文、事实来源与媒体快照。");
      const { content, base } = this.#validatePublicCandidate(state, row, { now });
      if (base && !this.aiApproval) {
        throw new ApiError(503, "AI_APPROVAL_UNAVAILABLE", "原文加图仅可由已配置的正式 AI 审核工位确认。");
      }
      if (aiReview) {
        const route = state.websiteRoutes.find(item => item.canonicalPath === row.canonicalPath);
        if ((route?.activeReleaseId ?? null) !== row.previousReleaseId || content.approval?.aiApproval?.snapshotHash !== content.snapshotHash) {
          throw new ApiError(409, "RELEASE_ROUTE_CONFLICT", "公开范围或原渠道审核已经变化。");
        }
        if (articleEvidenceHash) {
          assertArticleReviewCurrent(reviewedReleaseCopy(state, content, row, { publicOrigin: this.publicOrigin, note, actor: ctx.actor,
            base, websiteAuthorization, now }), articleEvidenceHash);
        }
        if (base && !this.#originalVariantReviewCurrent(state, content, now)) {
          throw new PolicyError("AI_ORIGINAL_ILLUSTRATION_REVIEW_REQUIRED", "公开快照审核前，渠道稿须先完成只加图差异 AI 审核。");
        }
        payload.aiReview = { actor: aiReview.actor, evidenceHash: aiReview.evidenceHash };
      }
      row.publicApproval = { approvedBy: aiReview?.actor ?? actor, approvedAt: now.toISOString(), authorizationNote: note,
        snapshotHash: row.snapshotHash, reviewed: true, ...(aiReview ? { aiApproval: aiReview, authorizedBy: actor } : {}),
        ...(originalReviewBinding ? { articleReviewScope: ORIGINAL_ILLUSTRATION_REVIEW, articleReviewBinding: originalReviewBinding } : {}) };
      row.status = "approved"; row.revision += 1; row.updatedAt = now.toISOString(); payload.releaseId = id; return entity(row);
    }, aiReview ? async () => ({ aiReview }) : null);
  }

  async publishRelease(id, input, ctx, { beforeActivate } = {}) {
    editorialInput(input, ["confirm", "expectedPreviousReleaseId"]);
    if (input.confirm !== true || !Object.hasOwn(input, "expectedPreviousReleaseId") || !(input.expectedPreviousReleaseId === null || typeof input.expectedPreviousReleaseId === "string")) {
      throw new ApiError(400, "RELEASE_CONFIRMATION_REQUIRED", "公开激活必须明确 confirm 与预期前一修订。");
    }
    return this.#write(`release_activated:${id}`, input, ctx, async (state, { actor, ifMatch, now, payload }) => {
      const row = record(state.websiteReleases, id, "RELEASE_NOT_FOUND"); assertMatch(row, ifMatch);
      if (row.status !== "approved" || row.publicApproval?.snapshotHash !== row.snapshotHash) throw new ApiError(409, "INVALID_RELEASE_TRANSITION", "公开激活只接受已精确批准的修订。");
      if (this.aiApproval && (row.publicApproval?.aiApproval?.snapshotHash !== row.snapshotHash || row.previousReleaseId !== input.expectedPreviousReleaseId)) {
        throw new PolicyError("AI_APPROVAL_REQUIRED", "激活前须有当前公开快照及替换范围的 AI 审核回执。");
      }
      const { content, base } = this.#validatePublicCandidate(state, row, { now });
      if (base) this.#assertOriginalReleaseReviewCurrent(state, row, content, now);
      if (content.status !== "scheduled") throw new PolicyError("CONTENT_NOT_SCHEDULED", "官网激活前须将渠道稿排入待发布。");
      let route = state.websiteRoutes.find(item => item.canonicalPath === row.canonicalPath);
      if ((route?.activeReleaseId ?? null) !== input.expectedPreviousReleaseId) throw new ApiError(409, "RELEASE_ROUTE_CONFLICT", "正式 URL 的当前修订已变化，请重新核对。");
      if (route && route.storyId !== row.storyId) throw new ApiError(409, "CANONICAL_ROUTE_CONFLICT", "正式 URL 属于其他选题。");
      if (row.publicSnapshot.assetRefs.length) {
        if (typeof this.mediaAssets?.verifyForRelease !== "function") throw new ApiError(503, "MEDIA_VERIFICATION_UNAVAILABLE", "媒体字节验证服务尚未配置。");
        await this.mediaAssets.verifyForRelease(row.publicSnapshot.assetRefs, state);
      }
      if (typeof this.beforeActivation !== "function") throw new ApiError(503, "EDITORIAL_BACKUP_UNAVAILABLE", "公开激活前必须配置真实完整备份服务。");
      let activationNow;
      {
        const backup = typeof this.beforeActivation.captureCommitted === "function"
          ? await this.beforeActivation.captureCommitted(row, state)
          : await this.beforeActivation(structuredClone(row), structuredClone(state));
        activationNow = this.clock();
        this.#validatePublicCandidate(state, row, { now: activationNow });
        if (base) this.#assertOriginalReleaseReviewCurrent(state, row, content, activationNow);
        if (!backup || !/^EDB-[a-f0-9]{32}$/.test(backup.backupId) || backup.stage !== "pre_activation" || backup.releaseId !== row.id ||
            !/^[a-f0-9]{64}$/.test(backup.manifestSha256) || !/^[a-f0-9]{64}$/.test(backup.stateSha256) ||
            !Number.isSafeInteger(backup.assetCount) || backup.assetCount < 0 ||
            !Number.isSafeInteger(backup.totalBytes) || backup.totalBytes < 0) {
          throw new ApiError(503, "EDITORIAL_BACKUP_INVALID_RECEIPT", "发布前完整备份没有返回有效的校验回执。");
        }
        row.activationBackup = { backupId: backup.backupId, manifestSha256: backup.manifestSha256,
          stateSha256: backup.stateSha256, assetCount: backup.assetCount, totalBytes: backup.totalBytes,
          createdAt: timestamp(backup.createdAt, "backup.createdAt", activationNow), stage: "pre_activation" };
      }
      if (beforeActivate) {
        const edition = record(state.editions, row.editionId, "EDITION_NOT_FOUND");
        await beforeActivate(Object.freeze({ releaseId: row.id, previousReleaseId: route?.activeReleaseId ?? null,
          editionSnapshotHash: edition.snapshotHash, canonicalPath: row.canonicalPath }));
        activationNow = this.clock();
      }
      if (!route) {
        route = { id: nextId("RTE", state.websiteRoutes), siteId: "official-site", storyId: row.storyId,
          locale: row.locale, format: row.format, slug: row.slug, canonicalPath: row.canonicalPath,
          activeReleaseId: null, revision: 0, createdAt: activationNow.toISOString() }; state.websiteRoutes.push(route);
      }
      row.previousReleaseId = route.activeReleaseId; route.activeReleaseId = id; route.revision += 1;
      route.updatedAt = activationNow.toISOString(); route.withdrawnAt = null;
      row.status = "live_unverified"; row.activationAt = activationNow.toISOString(); row.activatedBy = this.aiApproval ? PUBLICATION_SYSTEM_ACTOR : actor;
      row.revision += 1; row.updatedAt = activationNow.toISOString(); payload.releaseId = id; payload.snapshotHash = row.snapshotHash;
      return entity(row);
    }, this.aiApproval ? async () => ({ effectActor: PUBLICATION_SYSTEM_ACTOR }) : null);
  }

  async verifyRelease(id, input, ctx) {
    editorialInput(input, ["confirm"]);
    if (input.confirm !== true) throw new ApiError(400, "READBACK_CONFIRMATION_REQUIRED", "必须明确请求真实官网回读。");
    const currentRelease = (state, ifMatch, now) => {
      const row = record(state.websiteReleases, id, "RELEASE_NOT_FOUND"); assertMatch(row, ifMatch);
      if (row.status !== "live_unverified") throw new ApiError(409, "INVALID_RELEASE_TRANSITION", "只有已激活且未验证的修订可入账。");
      const route = state.websiteRoutes.find(item => item.activeReleaseId === id);
      if (!route) throw new PolicyError("RELEASE_NOT_CURRENT", "修订已不是该正式 URL 的当前版本。");
      this.#validatePublicCandidate(state, row, { now, checkLive: true });
      return row;
    };
    const result = await this.#write(`release_verified:${id}`, input, ctx, (state, { actor, ifMatch, now, payload, review }) => {
      const row = currentRelease(state, ifMatch, now);
      const { expected, proof } = review;
      if (this.#publicDto(state, row).etag !== expected.etag) {
        throw new PolicyError("WEBSITE_READBACK_MISMATCH", "官网页面、正文快照或媒体字节没有通过真实回读。");
      }
      const assets = [...new Map(expected.assets.map(asset => [`${asset.assetId}:${asset.sha256}`, { assetId: asset.assetId, sha256: asset.sha256 }])).values()]
        .sort((a, b) => a.assetId.localeCompare(b.assetId));
      if (!proof || proof.releaseId !== id || proof.snapshotHash !== row.snapshotHash || proof.canonicalUrl !== expected.canonicalUrl ||
          proof.method !== "server_readback" || !Array.isArray(proof.assetHashes) ||
          hashObject([...proof.assetHashes].sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)))) !== hashObject(assets)) {
        throw new PolicyError("WEBSITE_READBACK_MISMATCH", "官网页面、正文快照或媒体字节没有通过真实回读。");
      }
      const verifiedAt = timestamp(proof.verifiedAt, "verifiedAt", now);
      if (new Date(verifiedAt).getTime() < new Date(row.activationAt).getTime()) throw new ApiError(400, "READBACK_BEFORE_ACTIVATION", "回读时间不能早于公开激活。");
      row.receipt = { releaseId: id, canonicalUrl: expected.canonicalUrl, snapshotHash: row.snapshotHash,
        dataMode: "real", verificationMethod: "server_readback", publishedAt: row.activationAt,
        verifiedAt, verifiedBy: this.aiApproval ? PUBLICATION_SYSTEM_ACTOR : actor, assetHashes: assets };
      row.receipt.receiptHash = hashObject(row.receipt); row.status = "published"; row.revision += 1; row.updatedAt = now.toISOString();
      const content = record(state.content, row.contentId, "CONTENT_NOT_FOUND");
      content.status = "published"; content.version += 1; content.websiteReleaseId = id; content.updatedAt = now.toISOString();
      payload.releaseId = id; payload.receiptHash = row.receipt.receiptHash; return entity(row);
    }, async (state, { ifMatch, now }) => {
      const row = currentRelease(state, ifMatch, now);
      if (typeof this.verifyReadback !== "function") throw new ApiError(503, "WEBSITE_READBACK_UNAVAILABLE", "真实官网回读校验器尚未配置。");
      const expected = this.#publicDto(state, row);
      const proof = await this.verifyReadback(structuredClone(expected));
      return { expected, proof, effectActor: this.aiApproval ? PUBLICATION_SYSTEM_ACTOR : undefined };
    });
    const finalBackup = await this.geoService?.backupFinalContent(this.getVariant(result.contentId));
    return finalBackup ? { ...result, finalBackup } : result;
  }

  async withdrawRelease(id, input, ctx) {
    editorialInput(input, ["reason"]); const reason = editorialText(input.reason, "reason", 2000);
    return this.#write(`release_withdrawn:${id}`, input, ctx, (state, { actor, ifMatch, now, payload }) => {
      const row = record(state.websiteReleases, id, "RELEASE_NOT_FOUND"); assertMatch(row, ifMatch);
      if (!["draft", "approved", "live_unverified", "published"].includes(row.status)) throw new ApiError(409, "INVALID_RELEASE_TRANSITION", "此修订不能再次撤回。");
      const route = state.websiteRoutes.find(item => item.activeReleaseId === id);
      if (route) { route.activeReleaseId = null; route.withdrawnAt = now.toISOString(); route.updatedAt = now.toISOString(); route.revision += 1; }
      row.status = "withdrawn"; row.withdrawal = { by: actor, at: now.toISOString(), reason };
      row.revision += 1; row.updatedAt = now.toISOString(); payload.releaseId = id; return entity(row);
    });
  }

  #eligible(state, release) {
    try { this.#validatePublicCandidate(state, release, { checkLive: true }); return true; }
    catch (error) { if (error instanceof ApiError) return false; throw error; }
  }

  #publicDto(state, release, { privatePreview = false, alternates = true } = {}) {
    const snapshot = release.publicSnapshot;
    const assets = snapshot.assetRefs.map(ref => {
      const asset = record(state.mediaAssets, ref.assetId, "MEDIA_ASSET_NOT_FOUND");
      return { id: asset.id, assetId: asset.id, sha256: ref.sha256,
        url: privatePreview ? `/api/media/assets/${asset.id}/bytes` : `/public-media/${asset.id}/${ref.sha256}`,
        mime: asset.mime, kind: asset.kind, size: asset.size, role: ref.role, alt: ref.alt, caption: ref.caption, locale: ref.locale,
        ...(Number.isSafeInteger(asset.width) ? { width: asset.width } : {}),
        ...(Number.isSafeInteger(asset.height) ? { height: asset.height } : {}),
        ...(Number.isFinite(asset.durationMs) ? { durationMs: asset.durationMs } : {}) };
    });
    const peers = {};
    const edition = state.editions.find(row => row.id === release.editionId);
    const sourceEdition = state.editions.find(row => row.id === edition?.sourceEditionId);
    let translationStatus = edition?.sourceEditionId ? "source_revision_linked" : "original";
    if (alternates) {
      for (const route of state.websiteRoutes) {
        const peer = state.websiteReleases.find(row => row.id === route.activeReleaseId);
        if (peer && peer.storyId === release.storyId && peer.format === release.format && this.#eligible(state, peer)) {
          peers[peer.locale] = peer.publicSnapshot.canonicalUrl;
          const peerEdition = state.editions.find(row => row.id === peer.editionId);
          if (sourceEdition && peerEdition?.familyId === sourceEdition.familyId && peerEdition.editorialRevision > sourceEdition.editorialRevision) translationStatus = "needs_review";
        }
      }
    }
    const sources = snapshot.claimIds.map(id => publicEditorialClaim(state.claims.find(claim => claim.id === id), { now: this.clock() })).filter(Boolean);
    const dto = { id: release.id, releaseId: release.id, locale: release.locale, format: release.format,
      title: snapshot.title, summary: snapshot.summary, body: snapshot.body, blocks: structuredClone(snapshot.blocks), assets,
      canonicalPath: release.canonicalPath, canonicalUrl: snapshot.canonicalUrl, snapshotHash: release.snapshotHash,
      publishedAt: release.activationAt, updatedAt: release.updatedAt, alternates: peers, sources, translationStatus,
      ...(sourceEdition && peers[sourceEdition.locale] ? { sourceLocale: sourceEdition.locale, sourceCanonicalUrl: peers[sourceEdition.locale] } : {}) };
    return { ...dto, etag: `"${hashObject(dto)}"` };
  }

  previewRelease(id) {
    const state = this.#state(), release = record(state.websiteReleases, id, "RELEASE_NOT_FOUND");
    return { ...this.#publicDto(state, release, { privatePreview: true }), preview: true, releaseStatus: release.status };
  }

  publicDetail({ locale, format, slug } = {}) {
    assertLocaleFormat(locale, format);
    if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 100) throw new ApiError(404, "PUBLIC_CONTENT_NOT_FOUND", "内容不存在。");
    const state = this.#state();
    const route = state.websiteRoutes.find(row => row.locale === locale && row.format === format && row.slug === slug);
    if (!route) throw new ApiError(404, "PUBLIC_CONTENT_NOT_FOUND", "内容不存在。");
    const release = state.websiteReleases.find(row => row.id === route.activeReleaseId);
    if (!release || !this.#eligible(state, release)) throw new ApiError(410, "PUBLIC_CONTENT_UNAVAILABLE", "此内容暂不可公开，请稍后查看。");
    return this.#publicDto(state, release);
  }

  publicList({ locale = "zh-CN", format, limit = 20, cursor, q = "" } = {}) {
    if (!EDITORIAL_LOCALES.includes(locale)) throw new ApiError(400, "INVALID_LOCALE", "语言无效。");
    if (format !== undefined && !EDITORIAL_FORMATS.includes(format)) throw new ApiError(400, "INVALID_CONTENT_TYPE", "内容形式无效。");
    const take = Number(limit);
    if (!Number.isInteger(take) || take < 1 || take > 100) throw new ApiError(400, "INVALID_LIMIT", "limit 必须为 1 到 100。");
    const query = editorialText(q, "q", 120, { empty: true });
    const filterHash = hashObject({ locale, format: format ?? null, q: query });
    let after = null;
    if (cursor) {
      try {
        if (typeof cursor !== "string" || cursor.length > 500 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid");
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (parsed.filterHash !== filterHash || typeof parsed.after !== "string" || parsed.after.length > 150 || Object.keys(parsed).length !== 2) throw new Error("invalid");
        after = parsed.after;
      } catch { throw new ApiError(400, "INVALID_CURSOR", "分页游标无效，请重新读取列表。"); }
    }
    const state = this.#state();
    const rows = state.websiteRoutes.map(route => state.websiteReleases.find(row => row.id === route.activeReleaseId))
      .filter(row => row && row.locale === locale && (!format || row.format === format) && this.#eligible(state, row) &&
        (!query || `${row.publicSnapshot.title}\n${row.publicSnapshot.summary}\n${row.publicSnapshot.body}`.toLowerCase().includes(query.toLowerCase())))
      .map(row => ({ row, key: `${row.activationAt}\u0000${row.id}` })).sort((a, b) => b.key.localeCompare(a.key));
    const candidates = after ? rows.filter(row => row.key < after) : rows;
    const page = candidates.slice(0, take);
    return { items: page.map(({ row }) => { const { body: _body, blocks: _blocks, ...card } = this.#publicDto(state, row); return card; }),
      total: rows.length, nextCursor: candidates.length > take ? Buffer.from(JSON.stringify({ filterHash, after: page.at(-1).key })).toString("base64url") : null };
  }

  isAssetPublic(assetId, sha256) {
    const state = this.#state();
    return state.websiteRoutes.some(route => {
      const release = state.websiteReleases.find(row => row.id === route.activeReleaseId);
      return release && release.publicSnapshot.assetRefs.some(ref => ref.assetId === assetId && ref.sha256 === sha256) && this.#eligible(state, release);
    });
  }
}
