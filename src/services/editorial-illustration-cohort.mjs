import officialCohort from "../../data/editorial-illustration-cohort-20261121.json" with { type: "json" };
import { articleIllustrationBlockText, assertArticleIllustrations } from "../domain/article-illustrations.mjs";
import { PolicyError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";
import { genericProductNamingErrorCode, genericProductNamingFindings } from "../domain/product-naming.mjs";
import { hasVerifiedPublicReceipt } from "./editorial-article-review-evidence.mjs";

export const OFFICIAL_ILLUSTRATION_COHORT = Object.freeze(officialCohort.map(row => Object.freeze(row)));

function activeRoute(state, base) {
  return state.websiteRoutes.find(route => route.canonicalPath === base.canonicalPath
    && route.storyId === base.storyId && route.locale === base.locale && route.format === base.format);
}

function eligibleBase(state, scope, publicOrigin, { requireActive = true } = {}) {
  const base = state.websiteReleases.find(row => row.id === scope.releaseId);
  if (!base || base.storyId !== scope.storyId || base.canonicalPath !== scope.canonicalPath
      || base.snapshotHash !== scope.snapshotHash || base.format !== "article" || base.siteId !== "official-site"
      || !hasVerifiedPublicReceipt(base, publicOrigin)
      || requireActive && activeRoute(state, base)?.activeReleaseId !== base.id) return null;
  return base;
}

export function activeCohortBases(state, cohort, publicOrigin) {
  return cohort.filter(scope => eligibleBase(state, scope, publicOrigin))
    .map(({ storyId, releaseId }) => ({ storyId, releaseId }));
}

export function cohortBaseRelease(state, { cohort, publicOrigin, releaseId, storyId, locale, requireActive = true }) {
  const scope = cohort.find(row => row.releaseId === releaseId && row.storyId === storyId);
  const base = scope && eligibleBase(state, scope, publicOrigin, { requireActive });
  if (!base || base.locale !== locale) {
    throw new PolicyError("ILLUSTRATION_COPY_SCOPE_MISMATCH", "仅可为指定批次中仍在原正式地址公开的准确旧版保留全文配图。");
  }
  return base;
}

export function assertCohortText(base, article) {
  const previous = base.publicSnapshot;
  if (article.locale !== previous.locale || article.format !== undefined && article.format !== "article"
      || ["title", "summary", "body"].some(key => article[key] !== previous[key])) {
    throw new PolicyError("ILLUSTRATION_COPY_TEXT_CHANGED", "只加图时必须保留原公开版的标题、摘要和正文全部文字。");
  }
}

function assertCohortBoundary(blocks, baselineIndex, slotId) {
  const before = blocks[baselineIndex], after = blocks[baselineIndex + 1];
  if (before?.type === "paragraph" && /[：:]\s*$/u.test(before.text) && after?.type === "list") {
    throw new PolicyError("ILLUSTRATION_INSERTION_INTERRUPTS_LIST", "图片不能插在冒号引导段与紧接的原文列表之间。请为该图位选择完整论述之后的原文锚点。",
      [{ slotId, baselineBlockIndex: baselineIndex }]);
  }
}

export function assertCohortPlanPlacement(base, slots) {
  const blocks = base.publicSnapshot.blocks;
  for (const slot of slots) {
    const index = blocks.findIndex(block => articleIllustrationBlockText(block).replace(/\s+/gu, " ").trim().includes(slot.anchor));
    if (index < 0) throw new PolicyError("ILLUSTRATION_PLACEMENT_MISMATCH", "只加图的锚点须存在于获准公开稿的原始正文块。", [{ slotId: slot.id }]);
    assertCohortBoundary(blocks, index, slot.id);
  }
}

export function assertCohortAddition(state, base, plan, article) {
  assertCohortText(base, article);
  assertArticleIllustrations(state, plan, article, { exactSource: true });
  const previous = base.publicSnapshot;
  const planned = new Set(plan.slots.map(slot => slot.evidence.assetId));
  const additions = article.assetRefs.filter(ref => planned.has(ref.assetId));
  const originalRefs = article.assetRefs.filter(ref => !planned.has(ref.assetId));
  const originalBlocks = article.blocks.filter(block => block.type !== "image" || !planned.has(block.assetId));
  if (additions.length !== planned.size || additions.some(ref => ref.role !== "image")
      || previous.assetRefs.some(ref => planned.has(ref.assetId))
      || hashObject(originalRefs) !== hashObject(previous.assetRefs)
      || hashObject(originalBlocks) !== hashObject(previous.blocks)
      || hashObject(article.claimIds) !== hashObject(previous.claimIds)
      || hashObject(article.claimBindings) !== hashObject(previous.claimBindings)) {
    throw new PolicyError("ILLUSTRATION_COPY_SCOPE_CHANGED", "只加图时必须完整保留历史正文结构、原素材和来源，只可追加当前计划已核对的配图。");
  }
  const findings = genericProductNamingFindings({ assets: additions.map(({ alt, caption }) => ({ alt, caption })) }, { location: "article.illustrations" });
  if (findings.length) throw new PolicyError(genericProductNamingErrorCode(findings), "新增配图的图注与替代文字须符合当前通用名称规则。", { findings });
  let baselineIndex = -1;
  for (const block of article.blocks) {
    if (block.type !== "image" || !planned.has(block.assetId)) {
      baselineIndex += 1;
      continue;
    }
    const slot = plan.slots.find(slot => slot.evidence.assetId === block.assetId);
    assertCohortBoundary(previous.blocks, baselineIndex, slot.id);
  }
}
