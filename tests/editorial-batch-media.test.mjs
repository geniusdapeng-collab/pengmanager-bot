import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { hashObject } from "../src/domain/hash.mjs";
import {
  ARTICLE_ILLUSTRATION_SCHEMA, articleIllustrationNativeThreadId, illustrationStatementBytes, sceneBriefHashForPlan, verifyArticleSceneProvenance,
} from "../src/domain/article-illustrations.mjs";
import { parseEditorialBatchMedia, previewEditorialBatchMedia, submitEditorialBatchMedia, mountEditorialBatchMedia } from "../public/editorial-batch-media.js";

const hash = data => createHash("sha256").update(data).digest("hex");
const origin = { body: "原稿第一段。\n第二段。\n第三段。", title: "官网原稿", summary: "摘要", locale: "zh-CN" };
const base = { id: "REL-00131", storyId: "STY-00004", status: "published", slug: "example",
  snapshotHash: hash("snapshot"), canonicalPath: "/zh/articles/example", publicSnapshot: { ...origin, format: "article" } };
const planId = "ILP-00007";
const sceneInputHash = hash("ImageGen original");
const forms = ["architecture", "logic", "scene"];

async function fixture() {
  const plan = { id: planId, storyId: base.storyId, baseReleaseId: base.id, title: origin.title, sourceHash: hashObject(origin),
    schema: ARTICLE_ILLUSTRATION_SCHEMA, etag: '"plan-v1"', frozen: false, slots: forms.map((kind, index) => ({
      id: `slot-${index + 1}`, kind, imageGeneration: kind === "scene", description: `${kind} description`,
    })) };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const producerKeyId = `pk-${hash(der).slice(0, 32)}`;
  const sceneSlot = plan.slots[2];
  sceneSlot.sceneBriefHash = sceneBriefHashForPlan(plan, sceneSlot);
  const files = Object.fromEntries(forms.map(kind => [kind, new File([kind], `${kind}.png`, { type: "image/png" })]));
  const slots = forms.map((kind, index) => ({ slotId: plan.slots[index].id, kind,
    sha256: hash(kind), bytes: files[kind].size, width: 1280, height: 720, rightsNote: `已核对 ${kind} 权利说明` }));
  const signed = statement => ({ statement, signature: sign(null, illustrationStatementBytes(statement), privateKey).toString("base64url"), producerKeyId });
  const shared = { planId, slotId: sceneSlot.id, sourceHash: plan.sourceHash, width: slots[2].width, height: slots[2].height };
  const compositor = signed({ ...shared, source: "pengmanager-designer-compositor", sha256: slots[2].sha256,
    bytes: slots[2].bytes, imageGenInputSha256: sceneInputHash, sceneBriefHash: sceneSlot.sceneBriefHash,
    nativeThreadId: articleIllustrationNativeThreadId(plan.id, sceneSlot.id, plan.sourceHash),
    approvedApprovalId: "approved-1234", gestureEventId: "gesture-1234", composeEventId: "compose-1234", verifyEventId: "verify-1234",
    approvalAuthority: "ai", approvalDecisionHash: hash("AI grant") });
  const generated = signed({ ...shared, source: "codex-imagegen", sha256: sceneInputHash, bytes: 1234,
    requestedProfile: "image2.5", toolReceiptId: "imagegen-1234" });
  const [compositorFile, generatedFile] = [compositor, generated].map(receipt => new File(
    [JSON.stringify(receipt)], `${receipt.statement.source}.json`, { type: "application/json" }));
  slots[2].proofs = { designerCompositorSha256: hash(await compositorFile.text()), imageGenSha256: hash(await generatedFile.text()) };
  const manifest = { schema: "pengmanager.editorial-batch-media/v1", storyId: plan.storyId, baseReleaseId: plan.baseReleaseId,
    planId, sourceHash: plan.sourceHash, slots };
  const proofFiles = [generatedFile, compositorFile];
  const saved = new Map();
  const calls = [];
  const flags = { active: true };
  const adapters = {
    getBase: () => flags.active ? base : undefined,
    async api(path, options) {
      assert.ok(options.signal);
      calls.push({ path, method: "GET" });
      if (path === `/api/stories/${plan.storyId}/illustrations/${plan.id}`) return structuredClone(plan);
      if (path === "/public-api/content/zh-CN/article/example") return {
        releaseId: flags.liveOverride || base.id, snapshotHash: base.snapshotHash, canonicalPath: base.canonicalPath,
      };
      return structuredClone(saved.get(path.split("/").at(-1)));
    },
    async mutate(path, body, options) {
      assert.ok(options.signal);
      calls.push({ path, method: "POST", key: options.idempotencyKey });
      if (path === "/api/media/assets") {
        const expected = slots.find(slot => slot.sha256 === options.headers["X-Content-SHA256"]);
        assert.equal(hash(Buffer.from(await body.arrayBuffer())), expected.sha256);
        assert.equal(options.headers["Content-Type"], "image/png");
        assert.equal(options.headers["X-Media-Name"], `${plan.id}-${expected.slotId}-${expected.sha256.slice(0, 12)}.png`);
        const id = `MED-${hash(options.idempotencyKey).slice(0, 32)}`;
        const row = { id, sha256: expected.sha256, size: expected.bytes, width: expected.width,
          height: expected.height, kind: "image", mime: "image/png", status: "staged", etag: '"staged"' };
        if (!saved.has(id)) saved.set(id, row);
        return structuredClone(row);
      }
      const id = path.split("/").at(-2);
      const asset = saved.get(id);
      assert.equal(options.etag, asset.etag);
      assert.equal(options.needsEtag, true);
      if (flags.pending) {
        throw Object.assign(new Error("审核待回读"), { status: 409, code: "AI_APPROVAL_PENDING", details: { reviewId: "pending-id" } });
      }
      const provenance = body.articleSceneProofs ? verifyArticleSceneProvenance({
        articleIllustrationPlans: [plan], stories: [{ id: plan.storyId }],
        articleIllustrationProducerKeys: [{ id: producerKeyId, publicKey: der.toString("base64url") }],
      }, asset, body.articleSceneProofs) : null;
      asset.status = "reviewed";
      asset.review = { sha256: body.sha256, rightsNote: body.rightsNote, rightsConfirmed: true, privacyConfirmed: true,
        reviewedAt: "2026-11-22T00:00:00.000Z", ...(provenance ? { verifiedSceneProvenance: provenance } : {}),
        aiApproval: { schema: "pengmanager.ai-approval/v1", kind: "editorial.media", subjectId: id, snapshotHash: asset.sha256,
          decision: "approve", modelReceipt: { responseId: "rsp-test", returnedModel: "fixture-model" } } };
      if (provenance && flags.drift) provenance.imageGen.receiptHash = hash("wrong receipt");
      return structuredClone(asset);
    },
  };
  return { adapters, plan, manifest, files, proofFiles, saved, calls, flags };
}

const previewFor = ({ manifest, files, proofFiles, adapters }) =>
  previewEditorialBatchMedia(parseEditorialBatchMedia(JSON.stringify(manifest)), files, proofFiles, adapters);

test("strict manifest accepts only three distinct supported slots and disallows local paths", async () => {
  const { manifest } = await fixture();
  assert.deepEqual(parseEditorialBatchMedia(JSON.stringify(manifest)), manifest);
  assert.throws(() => parseEditorialBatchMedia("x"), /有效/);
  assert.throws(() => parseEditorialBatchMedia(" ".repeat(65_537)), /64 KiB/);
  assert.throws(() => parseEditorialBatchMedia(JSON.stringify({ ...manifest, localPath: "/private" })), /选题/);
  manifest.slots[1].sha256 = manifest.slots[0].sha256;
  assert.throws(() => parseEditorialBatchMedia(JSON.stringify(manifest)), /不同图位/);
});

test("preview binds the saved plan, bytes and original proof files before any media mutation", async () => {
  const inputs = await fixture();
  const preview = await previewFor(inputs);
  assert.equal(preview.plan.id, planId);
  assert.equal(preview.slots[2].proofs.imageGen.statement.sha256, sceneInputHash);
  assert.equal(inputs.calls.filter(call => call.method === "POST").length, 0);
  inputs.files.logic = new File(["fake!"], "logic.png", { type: "image/png" });
  await assert.rejects(previewFor(inputs), /SHA-256/);
  inputs.flags.active = false;
  await assert.rejects(previewFor(inputs), /原稿/);
  inputs.flags.active = true;
  inputs.flags.liveOverride = "REL-00999";
  await assert.rejects(previewFor(inputs), /公开原稿/);
});

test("submitting a scoped article reads back independently verified approval and only uses private media endpoints", async () => {
  const inputs = await fixture();
  const preview = await previewFor(inputs);
  const receipts = await submitEditorialBatchMedia(preview, inputs.adapters);
  assert.deepEqual(receipts.map(r => r.state), ["reviewed", "reviewed", "reviewed"], JSON.stringify(receipts));
  assert.deepEqual(receipts.map(r => r.modelResponseId), ["rsp-test", "rsp-test", "rsp-test"]);
  assert.equal(inputs.saved.size, 3);
  assert.deepEqual(inputs.calls.filter(call => call.method === "POST").map(call => call.path)
    .map(path => path.replace(/MED-[a-f0-9]{32}/u, "MEDIA")), forms.flatMap(() => [
    "/api/media/assets", "/api/media/assets/MEDIA/approve",
  ]));
  const before = inputs.calls.length;
  assert.equal((await submitEditorialBatchMedia(preview, inputs.adapters)).every(row => row.state === "reviewed"), true);
  assert.equal(inputs.calls.slice(before).some(call => call.path.endsWith("/approve")), false);
  assert.equal(inputs.saved.size, 3);
});

test("pending review stops unsubmitted slots and a retry uses identical keys, while plan drift stops all writes", async () => {
  const inputs = await fixture();
  const preview = await previewFor(inputs);
  inputs.flags.pending = true;
  const first = await submitEditorialBatchMedia(preview, inputs.adapters);
  assert.deepEqual(first.map(r => r.state), ["pending"]);
  assert.equal(first[0].reviewId, "pending-id");
  assert.equal(inputs.saved.size, 1);
  const firstKeys = inputs.calls.filter(c => c.key).map(c => c.key);
  inputs.flags.pending = false;
  const before = inputs.calls.length;
  assert.equal((await submitEditorialBatchMedia(preview, inputs.adapters)).length, 3);
  assert.deepEqual(inputs.calls.slice(before).filter(c => c.key).slice(0, 2).map(c => c.key), firstKeys);
  const beforeDrift = inputs.calls.length;
  inputs.plan.etag = '"plan-v2"';
  await assert.rejects(submitEditorialBatchMedia(preview, inputs.adapters), /重新预览/);
  assert.equal(inputs.calls.slice(beforeDrift).filter(c => c.method === "POST").length, 0);
});

test("scene readback rejects mismatched producer provenance and preview rejects altered proof bytes", async () => {
  const inputs = await fixture();
  const preview = await previewFor(inputs);
  inputs.flags.drift = true;
  const receipts = await submitEditorialBatchMedia(preview, inputs.adapters);
  assert.deepEqual(receipts.map(r => r.state), ["reviewed", "reviewed", "error"]);
  assert.match(receipts[2].message, /审核回执/);
  const file = inputs.proofFiles[0];
  inputs.proofFiles[0] = new File([await file.text(), "\n"], file.name, { type: file.type });
  await assert.rejects(previewFor(inputs), /清单不一致/);
});

test("adjacent panel has distinct actions, explicit write control and no publication entry", () => {
  const listeners = [];
  const root = { addEventListener: name => listeners.push(name) };
  const panel = mountEditorialBatchMedia(root, {});
  assert.deepEqual(listeners, ["change", "submit"]);
  assert.equal(panel.markup(false), "");
  const markup = panel.markup(true);
  assert.match(markup, /核对文件与计划/);
  assert.match(markup, /data-editorial-batch-media-submit formnovalidate disabled/);
  assert.doesNotMatch(markup, /\/publish|data-editorial-form|\/evidence/u);
});
