import { isDeepStrictEqual } from "node:util";
import { ApiError } from "./errors.mjs";
import { composeArticleBody, validateSectionDraft } from "./content-director.mjs";
import { genericProductNamingFindings } from "./product-naming.mjs";
import { scanSensitiveText } from "./policy.mjs";
import { INLINE_HTTP_URL } from "./public-url.mjs";

function invalid(message) {
  throw new ApiError(422, "ARTICLE_REVISION_SCOPE_INVALID", message);
}

export function privateArticleRevisionScope(job) {
  const frozen = job.result;
  if (!job.managedExecution || job.createdBy !== "bot-native-preparation" || job.review || job.editorialRef ||
      job.artifactKind !== "article" || !job.resultRef?.sha256 || !Array.isArray(frozen?.findings) || frozen.contentHash !== job.resultHash || frozen?.complete !== false ||
      !frozen.article || frozen.article.visualSpecRefs?.length || frozen.visuals?.length || frozen.boundedRevision) return null;
  const open = frozen.findings.filter(f => ["major", "blocker"].includes(f.severity) && f.status === "open");
  if (!open.length) return null;
  let length = false;
  let summary = false;
  for (const finding of open) {
    const code = finding.code.toLowerCase().replaceAll("_", "-");
    if (["article-too-long", "target-length-exceeded"].includes(code) && ["article", "body", "document"].includes(finding.location)) length = true;
    else if (code === "vague-masked-product-name" && ["summary", "article.summary", "metadata.summary"].includes(finding.location)) summary = true;
    else return null;
  }
  return { length, summary, findings: open };
}

export function validateRevisionPlan(plan, article, requested) {
  if (!plan || !Array.isArray(plan.paragraphs) || typeof plan.reason !== "string" || !plan.reason.trim() ||
      plan.reason.length > 1600 || plan.summary !== requested.summary) invalid("独立审稿没有给出有效的返修范围。");
  const selected = new Set();
  for (const target of plan.paragraphs) {
    const section = article.sections.find(row => row.key === target?.sectionKey);
    const key = JSON.stringify([target?.sectionKey, target?.paragraph]);
    if (!requested.shorten || !section || !Number.isInteger(target.paragraph) || target.paragraph < 1 ||
        target.paragraph > section.paragraphs.length || selected.has(key)) invalid("返修段落没有绑定唯一有效的原稿位置。");
    selected.add(key);
  }
  const total = article.sections.reduce((count, section) => count + section.paragraphs.length, 0);
  if (requested.shorten && (!selected.size || selected.size >= total)) invalid("必须指出足以压缩的具体段落并保留范围以外的原文。");
  return { paragraphs: plan.paragraphs.map(({sectionKey, paragraph}) => ({sectionKey, paragraph})), summary: plan.summary, reason: plan.reason.trim() };
}

// Reserve separate work for the signed summary and keep each copy edit small.
// The original article remains the source for assembly and whole-article review.
export function revisionBatches(plan) {
  const size = Math.max(1, Math.ceil(plan.paragraphs.length / 8));
  if (size > 2) invalid("原独审范围超出一次有界续办可处理的段落数。");
  const batches = plan.summary ? [{ paragraphs: [], summary: true }] : [];
  for (let i = 0; i < plan.paragraphs.length; i += size) {
    batches.push({ paragraphs: plan.paragraphs.slice(i, i + size), summary: false });
  }
  return batches;
}

export function compactRevisionPatch(batch, value) {
  const count = batch.summary ? 1 : batch.paragraphs.length;
  if (!value || Object.keys(value).length !== 1 || !Array.isArray(value.texts) ||
      value.texts.length !== count || value.texts.some(text => typeof text !== "string" || !text.trim())) {
    invalid("每个获准位置必须返回且只返回一段替换文字。");
  }
  if (batch.summary) return { summary: value.texts[0], edits: [] };
  return { edits: batch.paragraphs.map((position, i) => ({ ...position, text: value.texts[i] })) };
}

export function applyPrivateArticleRevision(article, plan, patch, claimIds, sourceNames) {
  if (!patch || !Array.isArray(patch.edits) || Object.keys(patch).some(k => !["edits","summary"].includes(k))) {
    invalid("返修结果只能包含定点段落或已获准的摘要。");
  }
  const paragraphs = new Map(article.sections.map(s => [s.key, [...s.paragraphs]]));
  const allowed = new Set(plan.paragraphs.map(({sectionKey, paragraph}) => JSON.stringify([sectionKey, paragraph])));
  const seen = new Set();
  if (allowed.size && !patch.edits.length) invalid("返修结果缺少获准的段落修改。");
  for (const edit of patch.edits) {
    const key = JSON.stringify([edit?.sectionKey, edit?.paragraph]);
    if (!allowed.has(key) || seen.has(key) || typeof edit.text !== "string" ||
        Object.keys(edit).some(field => !["sectionKey", "paragraph", "text"].includes(field))) invalid("返修结果超出获准段落范围。");
    const rows = paragraphs.get(edit.sectionKey);
    const old = rows[edit.paragraph - 1], next = edit.text.trim();
    if (!next || /\n\s*\n|^#{1,6}\s/mu.test(next) || next.replace(/\s/gu, "").length >= old.replace(/\s/gu, "").length) {
      invalid("定点压缩必须保留原有段落结构并缩短相应原文。");
    }
    const oldUrls = new Set([...old.matchAll(INLINE_HTTP_URL)].map(([url]) => url));
    if ([...next.matchAll(INLINE_HTTP_URL)].some(([url]) => !oldUrls.has(url))) invalid("返修段落引入了新的出处。");
    seen.add(key);
    rows[edit.paragraph - 1] = next;
  }
  let summary = article.summary;
  if (plan.summary) {
    if (typeof patch.summary !== "string" || !patch.summary.trim() || patch.summary.length > 2000 ||
        patch.summary === summary || genericProductNamingFindings(patch.summary).length || scanSensitiveText(patch.summary).length) {
      invalid("摘要未按获准范围完成修订。");
    }
    summary = patch.summary.trim();
    const words = (summary.replace(INLINE_HTTP_URL, " ").match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/giu) ?? [])
      .map(word => word.toLowerCase());
    if (!sourceNames.some(name => words.includes(name.toLowerCase()))) invalid("摘要未点明获准引用的原始项目。");
    const priorUrls = new Set([...article.summary.matchAll(INLINE_HTTP_URL)].map(([url]) => url));
    if ([...summary.matchAll(INLINE_HTTP_URL)].some(([url]) => !priorUrls.has(url))) invalid("摘要引入了新的出处。");
  } else if (Object.hasOwn(patch,"summary")) invalid("该轮未授权修订摘要。");
  const sections = article.sections.map(section => {
    const rows = paragraphs.get(section.key);
    if (rows.every((value, index) => value === section.paragraphs[index])) return section;
    const checked = validateSectionDraft({ ...section, paragraphs: rows, body: rows.join("\n\n") }, section, claimIds);
    if (checked.paragraphs.some((value, index) => value !== rows[index])) invalid("定点修改含有未获准名称。");
    return { ...section, body: checked.body, paragraphs: checked.paragraphs };
  });
  const beforeBody = composeArticleBody(article.sections);
  if (!article.body.startsWith(beforeBody)) invalid("当前正文与冻结的小节不一致。");
  const suffix = article.body.slice(beforeBody.length);
  const blocksFor = rows => {
    const result = rows.flatMap(section => [{ type: "heading", level: 2, text: section.title },
      ...section.paragraphs.map(text => ({ type: "paragraph", text }))]);
    if (suffix) result.push({ type: "paragraph", text: suffix.trim() });
    return result;
  };
  if (!isDeepStrictEqual(blocksFor(article.sections), article.blocks)) invalid("原稿含未纳入段落修订范围的结构块。");
  const blocks = blocksFor(sections);
  const body = composeArticleBody(sections) + suffix;
  const newUrls = new Set([...body.matchAll(INLINE_HTTP_URL)].map(([url]) => url));
  if ([...article.body.matchAll(INLINE_HTTP_URL)].some(([url]) => !newUrls.has(url))) invalid("返修必须保留原稿中的来源地址。");
  return { ...article, sections, blocks, body, summary };
}
