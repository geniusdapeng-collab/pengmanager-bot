import test from "node:test";
import assert from "node:assert/strict";
import { articleIllustrationStyleYear } from "../public/article-illustration-style.js";
import { articleIllustrationSourceHash } from "../src/domain/article-illustrations.mjs";
import { parseArticleIllustrationBatch, saveArticleIllustrationBatchRow } from "../public/article-illustration-batch.js";
import { articleIllustrationImageGenPrompt, articleIllustrationWorkOrder } from "../public/article-illustration-work-order.js";

const original = { id: "REL-00131", status: "published", storyId: "STY-00004", snapshotHash: "a".repeat(64),
  canonicalPath: "/zh/articles/isolated-batch-article", publicSnapshot: { locale: "zh-CN", format: "article",
    title: "隔离验证文章", summary: "使用原稿。", body: "业务请求与执行边界。\n\n确认图位以后完成审签。\n\n由现场负责人踏实核对工作。" } };
const input = { storyId: original.storyId, baseReleaseId: original.id, canonicalPath: original.canonicalPath,
  snapshotHash: original.snapshotHash, sourceHash: articleIllustrationSourceHash(original.publicSnapshot), articleType: "product",
  slots: ["architecture", "logic", "scene"].map((kind, index) => ({ kind,
    anchor: original.publicSnapshot.body.split("\n\n")[index], description: `使用确切正文示意说明第 ${index + 1} 处。`,
    alt: `图位 ${index + 1} 的替代说明`, caption: "", imageGeneration: kind === "scene" })) };
const publicDetail = { releaseId: original.id, canonicalPath: original.canonicalPath, snapshotHash: original.snapshotHash };

function savedPlan() {
  const plan = { ...input, id: "ILP-00042", styleYear: articleIllustrationStyleYear(), title: original.publicSnapshot.title, locale: original.publicSnapshot.locale,
    slots: input.slots.map((slot, index) => ({ ...slot, id: `slot-${index + 1}`,
      ...(slot.kind === "scene" ? { sceneBriefHash: "b".repeat(64) } : {}), evidence: null })) };
  return { ...plan, workOrders: plan.slots.map(slot => ({ workOrder: articleIllustrationWorkOrder(plan, slot),
    ...(slot.imageGeneration ? { imageGenPrompt: articleIllustrationImageGenPrompt(plan, slot) } : {}) })) };
}

test("batch file parsing reports exact bad rows and excludes the two established plans", () => {
  assert.deepEqual(parseArticleIllustrationBatch(`\uFEFF\r\n${JSON.stringify(input)}\r\n`), [{ line: 2, input }]);
  assert.match(parseArticleIllustrationBatch("{")[0].error, /JSON/);
  assert.match(parseArticleIllustrationBatch(JSON.stringify({ ...input, file: "local.png" }))[0].error, /需提供/);
  assert.match(parseArticleIllustrationBatch(JSON.stringify({ ...input, baseReleaseId: "REL-00129" }))[0].error, /首两篇/);
  assert.match(parseArticleIllustrationBatch(JSON.stringify({ ...input, baseReleaseId: "REL-00130" }))[0].error, /首两篇/);
  assert.match(parseArticleIllustrationBatch(JSON.stringify({ ...input, articleType: ["product"] }))[0].error, /需提供/);
  assert.match(parseArticleIllustrationBatch(JSON.stringify({ ...input, slots: [{ ...input.slots[0], localPath: "file" }, ...input.slots.slice(1)] }))[0].error, /第 1 个/);
  assert.ok(parseArticleIllustrationBatch(`${JSON.stringify(input)}\n${JSON.stringify(input)}`).every(row => /重复/.test(row.error)));
  assert.throws(() => parseArticleIllustrationBatch("\n"), /1 至 6/);
  assert.throws(() => parseArticleIllustrationBatch("{}\n".repeat(7)), /1 至 6/);
  assert.throws(() => parseArticleIllustrationBatch("字".repeat(25_000)), /64 KiB/);
});

test("a batch row binds the exact live base, current ETag, durable request key and server work orders", async () => {
  const plan = savedPlan();
  let selectedPlan = { ...plan, id: "ILP-00041", styleYear: undefined };
  let writes = 0;
  const api = async (path, options) => {
    if (path.startsWith("/public-api/")) {
      assert.equal(options.cache, "no-store");
      return publicDetail;
    }
    if (path.endsWith(`/illustrations/${plan.id}`)) return plan;
    if (path.endsWith("/illustrations")) return { items: selectedPlan ? [selectedPlan] : [] };
    return { id: input.storyId, etag: '"latest-story"' };
  };
  const mutate = async (endpoint, payload, options) => {
    writes += 1;
    assert.equal(endpoint, `/api/stories/${original.storyId}/illustrations`);
    assert.equal(options.etag, '"latest-story"');
    assert.equal(options.needsEtag, true);
    assert.match(options.idempotencyKey, /^illustration-batch-[a-f0-9]{64}$/);
    assert.deepEqual(payload, { body: original.publicSnapshot.body, title: original.publicSnapshot.title, locale: "zh-CN",
      summary: original.publicSnapshot.summary, baseReleaseId: original.id, articleType: "product", slots: input.slots });
    selectedPlan = plan;
    return plan;
  };
  await assert.rejects(saveArticleIllustrationBatchRow(input, { ...original, canonicalPath: "/zh/articles/different" }, { api, mutate }), /官网原稿不一致/);
  await assert.rejects(saveArticleIllustrationBatchRow({ ...input, sourceHash: "c".repeat(64) }, original, { api, mutate }), /正文摘要/);
  await assert.rejects(saveArticleIllustrationBatchRow(input, original, { api: async () => ({ ...publicDetail, releaseId: "REL-99999" }), mutate }), /官网原稿已经切换/);
  assert.equal(writes, 0);
  assert.deepEqual(await saveArticleIllustrationBatchRow(input, original, { api, mutate }), { plan, reused: false });
  assert.deepEqual(await saveArticleIllustrationBatchRow(input, original, { api, mutate }), { plan, reused: true });
  assert.equal(writes, 1);
  const readBackFailure = async (path, options) => path.endsWith(`/illustrations/${plan.id}`) ? Promise.reject(new Error("bounded fixture timeout")) : api(path, options);
  await assert.rejects(saveArticleIllustrationBatchRow(input, original, { api: readBackFailure, mutate }), { knownPlanId: plan.id });
  assert.deepEqual(await saveArticleIllustrationBatchRow(input, original, { api, mutate, knownPlanId: plan.id }), { plan, reused: true });
  assert.equal(writes, 1);
  plan.workOrders[2].imageGenPrompt += "altered";
  await assert.rejects(saveArticleIllustrationBatchRow(input, original, { api, mutate, knownPlanId: plan.id }), /服务端工单或生图提示/);
});

test("an unresolved write can retry with the same request key and a newly read story ETag", async () => {
  const plan = savedPlan();
  let reads = 0;
  const attempts = [];
  const api = async path => {
    if (path.startsWith("/public-api/")) return publicDetail;
    if (path.endsWith(`/illustrations/${plan.id}`)) return plan;
    if (path.endsWith("/illustrations")) return { items: [] };
    return { id: input.storyId, etag: `"story-${++reads}"` };
  };
  const mutate = async (_endpoint, _payload, { idempotencyKey, etag }) => {
    attempts.push({ idempotencyKey, etag });
    if (attempts.length === 1) throw new Error("isolated missing HTTP response");
    return plan;
  };
  await assert.rejects(saveArticleIllustrationBatchRow(input, original, { api, mutate }), /missing HTTP response/);
  assert.equal((await saveArticleIllustrationBatchRow(input, original, { api, mutate })).plan.id, plan.id);
  assert.equal(attempts[0].idempotencyKey, attempts[1].idempotencyKey);
  assert.deepEqual(attempts.map(attempt => attempt.etag), ['"story-1"', '"story-2"']);
});
