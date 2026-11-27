import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { loadSeedState, migrateEditorialState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { EditorialService } from "../src/services/editorial-service.mjs";
import { MediaAssets } from "../src/services/media-assets.mjs";
import { createEditorialBackup } from "../src/services/editorial-backup.mjs";
import { createWebsiteReadback } from "../src/services/website-readback.mjs";
import { createGeoOsServer } from "../src/http/server.mjs";
import { createAdminAuth, hashAdminPassword, hashAgentToken } from "../src/security/admin-auth.mjs";
import { hashObject } from "../src/domain/hash.mjs";
import { editorialEditionSnapshot, editorialVariantSnapshot } from "../src/domain/editorial.mjs";
import { fixtureIllustrationProof, registerFixtureIllustrator, syntheticIllustrationPng, uploadFixtureIllustration } from "./fixtures/article-illustrations.mjs";
import { buildIllustrationCopyEdition } from "../public/editorial-workbench.js";
import { mountEditorialBatchEdition, previewEditorialBatchEdition, saveEditorialBatchEdition } from "../public/editorial-batch-edition.js";

const root = resolve(import.meta.dirname, "..");
const hash = data => createHash("sha256").update(data).digest("hex");

async function fixture(t, { aiApproval = null, illustrationCohort } = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pengmanager-editorial-http-"));
  const store = new JsonStore({ filePath: join(directory, "live", "state.json"), writerLock: true });
  await store.open(async () => {
    const seed = await loadSeedState(join(root, "tests/fixtures/legacy-plane/seed"));
    seed.claims = [{ id: "C-T1", type: "project", text: "Synthetic isolated HTTP acceptance fixture.",
      state: "approved", publicLevel: "approved_public", sensitivity: "low", evidenceLevel: "A", expiresAt: null,
      source: { visibility: "public", label: "Synthetic fixture", url: "https://nodejs.org/" } }];
    return seed;
  });
  const service = new GeoOsService({ store });
  const password = "synthetic-test-password-only";
  const agentToken = randomBytes(32).toString("base64url");
  const auth = createAdminAuth({ env: { ADMIN_PASSWORD_HASH: await hashAdminPassword(password), ADMIN_AGENT_TOKEN_HASH: hashAgentToken(agentToken) } });
  let editorial;
  const mediaAssets = new MediaAssets({ store, aiApproval, publicAssetAuthorizer: (id, sha) => editorial.isAssetPublic(id, sha) });
  await mediaAssets.initialize();
  const backup = createEditorialBackup({ store, mediaAssets });
  editorial = new EditorialService({ store, geoService: service, mediaAssets, beforeActivation: backup, aiApproval, illustrationCohort });
  const server = createGeoOsServer({ service, editorial, mediaAssets, auth, publicDir: join(root, "public"), publicWebsite: true });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  editorial.publicOrigin = origin;
  editorial.verifyReadback = createWebsiteReadback({ origin, allowLoopback: true });
  await migrateEditorialState(store, { publicOrigin: origin });
  t.after(async () => {
    await new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeIdleConnections(); });
    await store.close(); await rm(directory, { force: true, recursive: true });
  });
  const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  let counter = 0;
  async function call(path, { method = "GET", body, etag, key, anonymous = false, headers = {} } = {}) {
    const response = await fetch(`${origin}${path}`, { method, redirect: "manual", headers: {
      ...(anonymous ? {} : { Cookie: cookie }), ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(!["GET", "HEAD"].includes(method) ? { "Idempotency-Key": key || `http-fixture-${++counter}` } : {}),
      ...(etag ? { "If-Match": etag } : {}), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let payload;
    if (response.headers.get("content-type")?.includes("application/json") && text) payload = JSON.parse(text);
    return { response, payload, text };
  }
  async function ok(path, options, expected = 200) {
    const result = await call(path, options);
    assert.equal(result.response.status, expected, JSON.stringify(result.payload)); return result.payload;
  }
  return { directory, store, service, editorial, mediaAssets, backup, server, origin, cookie, agentToken, call, ok };
}

async function readyDestination(f) {
  const destination = await f.ok("/api/destinations/official-site");
  return f.ok("/api/destinations/official-site", { method: "PATCH", etag: destination.etag,
    body: { visibility: "public", status: "active", identityConfirmed: true, policyStatus: "reviewed",
      policyCheckedAt: new Date().toISOString(), reviewNote: "Synthetic local host reviewed for isolated acceptance." } });
}

const rightsNote = "The synthetic illustrative material may be used in this isolated test fixture.";
const original = {
  locale: "zh-CN", format: "article", title: "WorkLoom 保留的原稿", summary: "原摘要仅用于隔离保真校验。",
  body: "第一段阐述完整架构并保留其原有措辞。\n\n第二段收束一个完整的条件判断。\n\n第三段以一项简洁实例结束。",
  blocks: [
    { type: "paragraph", text: "第一段阐述完整架构并保留其原有措辞。" },
    { type: "paragraph", text: "第二段收束一个完整的条件判断。" },
    { type: "paragraph", text: "第三段以一项简洁实例结束。" },
  ],
  claimIds: ["C-T1"], assetRefs: [],
};
const slug = "preserved-batch-edition-fixture";
const canonicalPath = `/zh/articles/${slug}`;
const baseId = "REL-00990";
const publicJson = `/public-api/content/zh-CN/article/${slug}`;

async function batchFixture(t) {
  const aiApproval = { async review(data) {
    return { schema: "pengmanager.ai-approval/v1", actor: "ai-reviewer", kind: data.kind, subjectId: data.subjectId,
      snapshotHash: data.snapshotHash, evidenceHash: hashObject(data.evidence), decision: "approve",
      reviewedAt: new Date().toISOString(), modelReceipt: { responseId: "isolated-media-review", returnedModel: "isolated-model" } };
  } };
  const illustrationCohort = [];
  const f = await fixture(t, { aiApproval, illustrationCohort });
  f.editorial.aiApproval = null;
  await readyDestination(f);
  const story = await f.ok("/api/stories", { method: "POST", body: { workingTitle: "Exact isolated original article", claimIds: original.claimIds } }, 201);
  const storyUrl = `/api/stories/${story.id}`;
  const oldEdition = await f.ok(`${storyUrl}/editions`, { method: "POST", etag: story.etag, body: original }, 201);
  const oldVariant = await f.ok(`/api/editions/${oldEdition.id}/variants`, {
    method: "POST", etag: oldEdition.etag, body: { destinationId: "official-site" },
  }, 201);
  await f.store.mutate({ type: "fixture.historical_original", actor: "fixture" }, state => {
    const edition = state.editions.find(row => row.id === oldEdition.id);
    const variant = state.content.find(row => row.id === oldVariant.id);
    Object.assign(edition, original); delete edition.productNaming;
    edition.snapshotHash = hashObject(editorialEditionSnapshot(edition));
    Object.assign(variant, original, { editionHash: edition.snapshotHash, status: "scheduled" }); delete variant.productNaming;
    variant.snapshotHash = variant.snapshotHashV2 = hashObject(editorialVariantSnapshot(variant));
    const now = new Date().toISOString();
    variant.approval = { approvedBy: "fixture", approvedAt: now, snapshotHash: variant.snapshotHash, reviewed: true };
    const publicSnapshot = { ...original, claimBindings: edition.claimBindings, canonicalPath, canonicalUrl: f.origin + canonicalPath };
    const snapshotHash = hashObject(publicSnapshot);
    state.websiteReleases.push({ id: baseId, siteId: "official-site", storyId: story.id, editionId: edition.id, contentId: variant.id,
      locale: "zh-CN", format: "article", slug, canonicalPath, publicSnapshot, snapshotHash, contentSnapshotHash: variant.snapshotHash,
      previousReleaseId: null, status: "live_unverified", revision: 1, activationAt: now, receipt: null, withdrawal: null,
      publicApproval: { snapshotHash, reviewed: true, authorizationNote: "Synthetic historical publish.", approvedBy: "fixture", approvedAt: now },
      createdAt: now, updatedAt: now });
    state.websiteRoutes.push({ id: "RTE-00990", siteId: "official-site", storyId: story.id, locale: "zh-CN", format: "article",
      slug, canonicalPath, activeReleaseId: baseId, revision: 1, createdAt: now, updatedAt: now });
  });
  const base = await f.ok(`/api/website/releases/${baseId}/verify`, { method: "POST", etag: f.editorial.getRelease(baseId).etag, body: { confirm: true } });
  illustrationCohort.push({ storyId: story.id, releaseId: base.id, canonicalPath, snapshotHash: base.snapshotHash });
  const latestStory = await f.ok(storyUrl);
  const kinds = ["architecture", "logic", "scene"];
  const slots = kinds.map((kind, i) => ({ kind, anchor: original.blocks[i].text,
    description: `隔离图位说明 ${i + 1}`, alt: `隔离替代文字 ${i + 1}`, caption: `隔离图注 ${i + 1}`, imageGeneration: kind === "scene" }));
  const plan = await f.ok(`${storyUrl}/illustrations`, { method: "POST", etag: latestStory.etag,
    body: { baseReleaseId: base.id, locale: original.locale, title: original.title, summary: original.summary, body: original.body,
      articleType: "technical", slots } }, 201);
  const signedImg = await registerFixtureIllustrator(f.editorial);
  const signedNative = await registerFixtureIllustrator(f.editorial);
  const generated = await uploadFixtureIllustration(f.mediaAssets, await syntheticIllustrationPng(6), undefined, { review: false });
  const manifest = { schema: "pengmanager.editorial-batch-media/v1", storyId: story.id, baseReleaseId: base.id,
    planId: plan.id, sourceHash: plan.sourceHash, slots: [] };
  const input = { manifest, plan, assetIds: {}, proofs: null, proofFiles: [] };
  for (const [i, slot] of plan.slots.entries()) {
    const image = await uploadFixtureIllustration(f.mediaAssets, await syntheticIllustrationPng(i + 1), undefined, { review: false });
    const media = { slotId: slot.id, kind: slot.kind, sha256: image.sha256,
      bytes: image.size, width: image.width, height: image.height, rightsNote };
    if (slot.kind === "scene") {
      input.proofs = { designerCompositor: fixtureIllustrationProof("pengmanager-designer-compositor", plan, slot, image, signedNative,
        { imageGenInputSha256: generated.sha256, approvalAuthority: "ai", approvalDecisionHash: "b".repeat(64) }),
      imageGen: fixtureIllustrationProof("codex-imagegen", plan, slot, generated, signedImg) };
      const proofJson = Object.values(input.proofs).map(value => JSON.stringify(value, null, 2));
      input.proofFiles = proofJson.map((value, index) => new File([value], `fixture-proof-${index}.json`, { type: "application/json" }));
      media.proofs = { designerCompositorSha256: hash(proofJson[0]), imageGenSha256: hash(proofJson[1]) };
    }
    const approved = await f.ok(`/api/media/assets/${image.id}/approve`, { method: "POST", etag: image.etag,
      body: { sha256: image.sha256, rightsNote, ...(slot.kind === "scene" ? { articleSceneProofs: input.proofs } : {}) } });
    assert.equal(approved.status, "reviewed");
    input.assetIds[slot.kind] = image.id;
    manifest.slots.push(media);
  }
  f.editorial.aiApproval = aiApproval;
  const writes = [];
  const mutate = async (requestPath, body, settings) => {
    writes.push({ requestPath, ...settings, body });
    return f.ok(requestPath, { method: "POST", body, etag: settings.etag, key: settings.idempotencyKey }, requestPath.endsWith("/editions") ? 201 : 200);
  };
  const adapters = { api: requestPath => f.ok(requestPath), getBase: (storyId, releaseId) => storyId === story.id && releaseId === base.id ? base : null,
    getBytes: (requestPath, options) => fetch(f.origin + requestPath, { ...options, headers: { Cookie: f.cookie } }),
    buildEdition: buildIllustrationCopyEdition, mutate };
  return { f, input, adapters, writes, storyUrl, oldEdition, plan, base };
}

test("private preview writes nothing; binds three and saves one with newest exact readback despite lost replies", async t => {
  const { f, input, adapters, writes, plan, base, storyUrl } = await batchFixture(t);
  const initial = f.store.snapshot();
  const preview = await previewEditorialBatchEdition(input, adapters);
  assert.equal(preview.existing, null);
  assert.equal(preview.scope.plan.isComplete, false);
  assert.deepEqual(preview.payload.blocks.filter(block => block.type !== "image"), original.blocks);
  assert.equal(writes.length, 0);
  const originalMutate = adapters.mutate;
  adapters.mutate = async (path, body, ctx) => {
    const result = await originalMutate(path, body, ctx);
    if (path.endsWith("/editions") || body.slotId === "slot-1") throw new Error("Synthetic lost reply after actual localhost commit.");
    return result;
  };
  const edition = await saveEditorialBatchEdition(preview, adapters);
  assert.equal(writes.length, 4);
  assert.equal(new Set(writes.map(w => w.idempotencyKey)).size, 4);
  assert.deepEqual(writes.slice(0, 3).map(w => w.body.slotId), ["slot-1", "slot-2", "slot-3"]);
  assert.deepEqual(writes[2].body.designerCompositor, input.proofs.designerCompositor);
  assert.deepEqual(writes[2].body.imageGen, input.proofs.imageGen);
  assert.equal(edition.title, original.title);
  assert.equal(edition.illustrationPlanId, plan.id);
  assert.equal(edition.blocks.length, 6);
  assert.equal((await f.ok(storyUrl)).editions.length, 2);
  assert.equal((await f.ok(publicJson, { anonymous: true })).releaseId, base.id);
  assert.deepEqual(f.store.snapshot().websiteReleases, initial.websiteReleases);
  assert.deepEqual(f.store.snapshot().content, initial.content);
  const reload = { ...input, plan: undefined, proofs: undefined };
  const recovered = await previewEditorialBatchEdition(reload, adapters);
  assert.equal(recovered.existing.id, edition.id);
  assert.deepEqual(await saveEditorialBatchEdition(recovered, adapters), edition);
  assert.equal(writes.length, 4, "Repeating save must not write binding, edition, variant or release.");
  assert.equal(verifyEventChain(f.store.snapshot().events).valid, true);
});

test("partial bind resumes with fresh ETag and rejects drift before further writes", async t => {
  const { f, input, adapters, writes, base } = await batchFixture(t);
  const first = await previewEditorialBatchEdition(input, adapters);
  const actualMutate = adapters.mutate;
  let simulatedFailure = true;
  adapters.mutate = async (path, body, ctx) => {
    if (body.slotId === "slot-2" && simulatedFailure) {
      simulatedFailure = false;
      throw new Error("Synthetic request failure before a second write.");
    }
    return actualMutate(path, body, ctx);
  };
  await assert.rejects(() => saveEditorialBatchEdition(first, adapters), /Synthetic request failure/);
  assert.equal(writes.length, 1);
  assert.deepEqual(
    (await f.ok(`/api/stories/${input.manifest.storyId}/illustrations/${input.manifest.planId}`)).slots.map(slot => Boolean(slot.evidence)),
    [true, false, false]);
  const edition = await saveEditorialBatchEdition(first, adapters);
  assert.equal(edition.illustrationPlanId, input.manifest.planId);
  assert.deepEqual(writes.map(w => w.body.slotId ?? "edition"), ["slot-1", "slot-2", "slot-3", "edition"]);
  assert.equal((await f.ok(publicJson, { anonymous: true })).releaseId, base.id);
});

test("byte, source, signature and missing AI drift fail closed with no writes", async t => {
  const { input, adapters, writes } = await batchFixture(t);
  const broken = async (suffix, map) => ({ ...adapters, async api(path, opts) {
    const current = await adapters.api(path, opts);
    return path.endsWith(suffix) ? map(current) : current;
  } });
  await assert.rejects(() => previewEditorialBatchEdition(input, { ...adapters, async getBytes(path, opts) {
    const response = await adapters.getBytes(path, opts);
    const bytes = new Uint8Array(await response.arrayBuffer()); bytes[2] ^= 1;
    return new Response(bytes, { headers: { "Content-Type": response.headers.get("Content-Type") } });
  } }), /AI 已审核字节不一致/);
  const oldAudit = await broken(input.assetIds.architecture, asset => ({ ...asset, review: { ...asset.review, aiApproval: undefined } }));
  await assert.rejects(() => previewEditorialBatchEdition(input, oldAudit), /没有当前字节、用途和隐私对应的完整 AI 审核回执/);
  const oldRelease = await broken(slug, detail => ({ ...detail, releaseId: "REL-99999" }));
  await assert.rejects(() => previewEditorialBatchEdition(input, oldRelease), /原官网地址或公开正文已变化/);
  const alteredProof = { ...input, proofFiles: [new File([await input.proofFiles[0].text() + "\n"], "copied-proof.json"), input.proofFiles[1]] };
  await assert.rejects(() => previewEditorialBatchEdition(alteredProof, adapters), /原始签章文件的 SHA-256 与清单不一致/);
  assert.equal(writes.length, 0);
});

test("an edition created by another admin after preview requires new review", async t => {
  const { f, input, adapters, writes, storyUrl, oldEdition } = await batchFixture(t);
  const preview = await previewEditorialBatchEdition(input, adapters);
  const latestStory = await f.ok(storyUrl);
  await f.ok(`${storyUrl}/editions`, { method: "POST", etag: latestStory.etag,
    body: { ...original, title: "同时保留的另一个新修订", supersedesEditionId: oldEdition.id } }, 201);
  await assert.rejects(() => saveEditorialBatchEdition(preview, adapters), /当前最新母版已变化/);
  assert.equal(writes.length, 0);
});

test("only explicit private preview/save actions are exposed; the batch companion has no publish control", () => {
  const root = { querySelector() { return null; }, addEventListener() {} };
  const ui = mountEditorialBatchEdition(root, {});
  assert.equal(ui.markup(false), "");
  const markup = ui.markup(true);
  assert.match(markup, /绑定并保存私有母版/);
  assert.match(markup, /data-batch-edition-save disabled/);
  assert.doesNotMatch(markup, /发布到官网|publish-with-ai/);
});
