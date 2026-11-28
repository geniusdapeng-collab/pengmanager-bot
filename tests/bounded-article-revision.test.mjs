import assert from "node:assert/strict";
import test from "node:test";
import { applyPrivateArticleRevision, privateArticleRevisionScope, validateRevisionPlan } from "../src/domain/bounded-article-revision.mjs";
import { composeArticleBody } from "../src/domain/content-director.mjs";

const paragraphs = ["首段保留来源限定和原有叙述。", "次段简要复述第一段已经说明的限定条件，提醒读者核验归档。"];
const sections = [{ key: "history", title: "项目沿革", paragraphs, body: paragraphs.join("\n\n"), claimIds: ["C1"] }];
const article = { title: "示例", summary: "原始摘要。", sections, body: composeArticleBody(sections), blocks: [
  { type: "heading", level: 2, text: "项目沿革" }, ...paragraphs.map(text => ({ type: "paragraph", text })),
] };
const plan = { paragraphs: [{ sectionKey: "history", paragraph: 2 }], summary: true, reason: "定点压缩" };
const patch = { edits: [{ sectionKey: "history", paragraph: 2, text: "请核验归档。" }], summary: "Paperbird 的历史说明。" };
const apply = (value, override = article, scope = plan) => applyPrivateArticleRevision(override, scope, value, new Set(["C1"]), ["Paperbird"]);
const invalid = { code: "ARTICLE_REVISION_SCOPE_INVALID" };

test("named summary and paragraph repairs preserve all unsigned locations and historical citations", () => {
  const result = apply(patch);
  assert.equal(result.sections[0].paragraphs[0], paragraphs[0]);
  assert.equal(result.sections[0].paragraphs[1], patch.edits[0].text);
  assert.equal(result.summary, patch.summary);
  for (const value of [
    { ...patch, title: "改标题" }, { ...patch, edits: [] },
    { ...patch, edits: [{ ...patch.edits[0], paragraph: 1 }] },
    { ...patch, edits: [{ ...patch.edits[0], sectionKey: "other" }] },
    { ...patch, edits: [patch.edits[0], patch.edits[0]] },
    { ...patch, edits: [{ ...patch.edits[0], text: paragraphs[1] }] },
    { ...patch, edits: [{ ...patch.edits[0], text: "甲\n\n乙" }] },
    { ...patch, edits: [{ ...patch.edits[0], text: "https://ex.am/z" }] },
    { ...patch, summary: "陈述某段历史。" }, { ...patch, summary: "MyPaperbird 的历史说明。" },
    { ...patch, summary: "Paperbird 与 XX 平台。" }, { ...patch, summary: "Paperbird https://example.org/x" },
    { ...patch, edits: [{ ...patch.edits[0], claimIds: [] }] },
  ]) assert.throws(() => apply(value), invalid);
  assert.throws(() => apply(patch, { ...article, blocks: [...article.blocks, { type: "figure", visualId: "old" }] }), invalid);
  assert.throws(() => apply(patch, { ...article, body: "untouched lead" + article.body }), invalid);
  assert.throws(() => apply(patch, article, { ...plan, summary: false }), invalid);
  assert.equal(apply({ edits: [], summary: patch.summary }, article, { ...plan, paragraphs: [] }).body, article.body);
});

test("a whole-article finding needs an independently bounded subset of valid original paragraphs", () => {
  const requested = { summary: true, shorten: true };
  assert.deepEqual(validateRevisionPlan(plan, article, requested), plan);
  for (const paragraphs of [[], [{ sectionKey: "missing", paragraph: 1 }], [{ sectionKey: "history", paragraph: 0 }],
    [{ sectionKey: "history", paragraph: 1 }, { sectionKey: "history", paragraph: 2 }], [...plan.paragraphs, ...plan.paragraphs]]) {
    assert.throws(() => validateRevisionPlan({ ...plan, paragraphs }, article, requested), invalid);
  }
  assert.throws(() => validateRevisionPlan(plan, article, { ...requested, summary: false }), invalid);
  assert.throws(() => validateRevisionPlan(plan, article, { ...requested, shorten: false }), invalid);
});

test("unrelated vetoes, published or visual packages, and a second frozen revision never enter bounded repair", () => {
  const findings = [{ severity: "major", code: "target-length-exceeded", location: "article", status: "open" }];
  const result = { article, complete: false, findings, contentHash: "content" };
  const job = { artifactKind: "article", managedExecution: true, createdBy: "bot-native-preparation", resultHash: "content",
    resultRef: { sha256: "artifact" }, result };
  assert.deepEqual(privateArticleRevisionScope(job), { length: true, summary: false, findings });
  for (const variant of [{ ...job, managedExecution: false }, { ...job, review: {} }, { ...job, editorialRef: {} },
    { ...job, artifactKind: "article_visual" }, { ...job, resultHash: "other" }, { ...job, result: { ...result, complete: true } },
    { ...job, result: { ...result, boundedRevision: {} } }, { ...job, result: { ...result, visuals: [{}] } },
    { ...job, result: { ...result, findings: [...findings, { ...findings[0], code: "unsupported-claim" }] } },
    { ...job, result: { ...result, findings: [{ ...findings[0], location: "section:history" }] } }]) {
    assert.equal(privateArticleRevisionScope(variant), null);
  }
});
