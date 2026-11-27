import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash, generateKeyPairSync } from "node:crypto";
import { request } from "node:http";
import { gunzipSync } from "node:zlib";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { loadSeedState, migrateEditorialState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { EditorialService } from "../src/services/editorial-service.mjs";
import { MediaAssets } from "../src/services/media-assets.mjs";
import { createEditorialBackup, verifyEditorialBackup, restoreEditorialBackupToIsolatedDirectory } from "../src/services/editorial-backup.mjs";
import { createWebsiteReadback } from "../src/services/website-readback.mjs";
import { createGeoOsServer } from "../src/http/server.mjs";
import { createAdminAuth, hashAdminPassword, hashAgentToken } from "../src/security/admin-auth.mjs";
import { ApiError } from "../src/domain/errors.mjs";
import { hashObject } from "../src/domain/hash.mjs";
import { aiApprovalWorkOrder, judgeAiApproval } from "../src/services/ai-approval.mjs";
import { ORIGINAL_ILLUSTRATION_REVIEW } from "../src/services/editorial-article-review-evidence.mjs";
import { TEXT_PRIMARY_MODEL } from "../src/model-routing/registry.mjs";
import { editorialEditionSnapshot, editorialInput, editorialVariantSnapshot } from "../src/domain/editorial.mjs";
import { placeArticleIllustrations } from "../src/domain/article-illustrations.mjs";
import { PNG, MP4 } from "./fixtures/synthetic-media.mjs";
import { bindFixtureIllustrations, fixtureIllustrationProof, fixtureIllustrationSlots, prepareFixtureIllustrations, registerFixtureIllustrator,
  syntheticIllustrationPng, uploadFixtureIllustration } from "./fixtures/article-illustrations.mjs";

const root = resolve(import.meta.dirname, "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("publication snapshot hashes are exempt from phone scanning only in the exact digest field", () => {
  const phoneLike = "13800138000";
  const editionSnapshotHash = "a".repeat(53) + phoneLike;
  assert.deepEqual(editorialInput({ editionSnapshotHash }, ["editionSnapshotHash"]), { editionSnapshotHash });
  assert.throws(() => editorialInput({ editionSnapshotHash: phoneLike }, ["editionSnapshotHash"]), { code: "EDITORIAL_SENSITIVE_INPUT" });
  assert.throws(() => editorialInput({ authorizationNote: editionSnapshotHash }, ["authorizationNote"]), { code: "EDITORIAL_SENSITIVE_INPUT" });
});

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

async function upload(f, bytes, mime, index) {
  const response = await fetch(`${f.origin}/api/media/assets`, { method: "POST", headers: { Cookie: f.cookie,
    "Content-Type": mime, "Idempotency-Key": `synthetic-upload-${index}`, "X-Content-Sha256": hash(bytes) }, body: bytes });
  const asset = await response.json(); assert.equal(response.status, 201, JSON.stringify(asset));
  return f.ok(`/api/media/assets/${asset.id}/approve`, { method: "POST", etag: asset.etag,
    body: { sha256: asset.sha256, rightsConfirmed: true, privacyConfirmed: true, rightsNote: "Synthetic owner-created acceptance fixture." } });
}

async function release(f, { locale = "zh-CN", format = "article", assetRefs = [], story: existingStory } = {}) {
  const story = existingStory ? await f.ok(`/api/stories/${existingStory.id}`) : await f.ok("/api/stories", {
    method: "POST", body: { workingTitle: "Synthetic acceptance only", claimIds: ["C-T1"] },
  }, 201);
  const title = locale === "en-US" ? "A complete synthetic edition" : "完整的隔离验收稿";
  const body = 'First complete paragraph <script>window.injected=1</script> & exact text.\n\n第二段，不得摘要替换。';
  const blocks = [{ type: "heading", level: 2, text: "00:00 A real section" }, { type: "paragraph", text: body },
    ...assetRefs.filter(row => row.role === "image").map(row => ({ type: "image", assetId: row.assetId, alt: row.alt }))];
  const illustrated = format === "article" ? await prepareFixtureIllustrations(f.editorial, f.mediaAssets, story, {
    locale, title, summary: "", body, blocks: blocks.slice(1),
  }) : null;
  const edition = await f.ok(`/api/stories/${story.id}/editions`, { method: "POST", etag: story.etag,
    body: { locale, format, title, body, blocks, claimIds: ["C-T1"], assetRefs,
      ...(illustrated ? { ...illustrated, blocks: [blocks[0], ...illustrated.blocks] } : {}) } }, 201);
  let variant = await f.ok(`/api/editions/${edition.id}/variants`, { method: "POST", etag: edition.etag, body: { destinationId: "official-site" } }, 201);
  for (const target of ["fact_check", "approved", "scheduled"]) variant = await f.ok(`/api/content/${variant.id}/transition`, {
    method: "POST", etag: variant.etag, body: { target, ...(target === "approved" ? { reviewed: true, snapshotHash: variant.snapshotHash } : {}) },
  });
  const candidate = await f.ok("/api/website/releases", { method: "POST", etag: variant.etag,
    body: { contentId: variant.id, slug: `${locale === "zh-CN" ? "zh" : "en"}-${format.replaceAll("_", "-")}` } }, 201);
  return { story, edition, variant, candidate, body, title };
}

test("new HTTP APIs preserve admin/Agent/CSRF boundaries, ETags, query checks and retry idempotency", async t => {
  const f = await fixture(t);
  for (const path of ["/api/editorial/bootstrap", "/api/editorial/illustrations/producer-keys", "/api/stories/STY-00001/illustrations",
    "/api/platforms", "/api/accounts", "/api/media/assets", "/api/stories", "/admin/preview/REL-00001"]) {
    assert.equal((await f.call(path, { anonymous: true })).response.status, 401);
    assert.equal((await f.call(path, { headers: { Authorization: `Bearer ${f.agentToken}` } })).response.status, 403);
  }
  assert.equal((await f.call("/api/stories", { method: "POST", body: { workingTitle: "Blocked cross site" }, headers: { Origin: "https://attacker.invalid" } })).response.status, 403);
  assert.equal((await f.call("/api/stories", { method: "POST", body: { workingTitle: "Missing key" }, headers: { "Idempotency-Key": "" } })).response.status, 400);
  const key = "same-create-story-key";
  const first = await f.ok("/api/stories", { method: "POST", key, body: { workingTitle: "Exact retry <>&" } }, 201);
  const revision = f.store.snapshot().revision;
  assert.deepEqual(await f.ok("/api/stories", { method: "POST", key, body: { workingTitle: "Exact retry <>&" } }, 201), first);
  assert.equal(f.store.snapshot().revision, revision);
  assert.equal((await f.call("/api/stories", { method: "POST", key, body: { workingTitle: "Changed retry" } })).response.status, 409);
  assert.equal((await f.call(`/api/stories/${first.id}`, { method: "PATCH", body: { workingTitle: "Missing precondition" } })).response.status, 428);
  assert.equal((await f.call(`/api/stories/${first.id}`, { method: "PATCH", etag: '"stale"', body: { workingTitle: "Stale" } })).response.status, 412);
  assert.equal((await f.call("/public-api/content?limit=0", { anonymous: true })).response.status, 400);
  assert.equal((await f.call("/public-api/content?locale=zh-CN&locale=en-US", { anonymous: true })).response.status, 400);
  assert.equal((await f.call("/public-api/content?private=true", { anonymous: true })).response.status, 400);
  assert.equal((await f.call("/public-api/content", { method: "POST", anonymous: true, body: {} })).response.status, 405);
  assert.equal(verifyEventChain(f.store.snapshot().events).valid, true);
});

test("article illustration HTTP plan edits preserve auth, exact media hash and authenticated producer enrollment", async t => {
  const f = await fixture(t);
  const title = "系统架构与技术回滚";
  const body = "入口限制身份与提交参数。\n\n审批时记录返回路径和失败原因。\n\n现场值班人员复核当前任务。";
  const path = "/api/editorial/illustrations/suggest";
  const suggest = { method: "POST", body: { title, body } };
  assert.equal((await f.call(path, { ...suggest, anonymous: true })).response.status, 401);
  assert.equal((await f.call(path, { ...suggest, headers: { Authorization: `Bearer ${f.agentToken}` } })).response.status, 403);
  assert.equal((await f.call(path, { ...suggest, headers: { Origin: "https://bad.invalid" } })).response.status, 403);
  const suggestRevision = f.store.snapshot().revision;
  const recommendation = await f.ok(path, suggest);
  assert.deepEqual(recommendation.kinds, ["architecture", "logic", "scene"]);
  assert.equal(f.store.snapshot().revision, suggestRevision);
  const story = await f.ok("/api/stories", { method: "POST", body: { workingTitle: title } }, 201);
  const planPath = `/api/stories/${story.id}/illustrations`;
  const plan = await f.ok(planPath, { method: "POST", etag: story.etag,
    body: { locale: "zh-CN", title, body, slots: recommendation.slots.map(slot => ({ ...slot, imageGeneration: slot.kind === "scene" })) } }, 201);
  assert.equal(plan.isComplete, false);
  assert.equal((await f.ok(planPath)).items[0].id, plan.id);
  const recordedPath = `${planPath}/${plan.id}`;
  assert.equal((await f.call(recordedPath, { anonymous: true })).response.status, 401);
  assert.equal((await f.call(recordedPath, { headers: { Authorization: `Bearer ${f.agentToken}` } })).response.status, 403);
  const recorded = await f.ok(recordedPath);
  assert.equal(recorded.etag, plan.etag);
  assert.equal(recorded.workOrders.length, 3);
  const sceneOrder = recorded.workOrders.find(row => row.workOrder.slot.kind === "scene");
  assert.equal(sceneOrder.workOrder.planId, plan.id);
  assert.equal(sceneOrder.workOrder.sourceHash, plan.sourceHash);
  assert.equal(sceneOrder.workOrder.slot.sceneBriefHash, plan.slots.find(slot => slot.kind === "scene").sceneBriefHash);
  assert.match(sceneOrder.imageGenPrompt, new RegExp(`PM-ILLUSTRATION ${plan.id}/${sceneOrder.workOrder.slot.id} ${plan.sourceHash}$`));
  assert.equal(recorded.workOrders.filter(row => row.imageGenPrompt).length, 1);
  const asset = await upload(f, await syntheticIllustrationPng(1), "image/png", "future-article");
  const evidencePath = `${planPath}/${plan.id}/evidence`;
  const valid = { slotId: plan.slots[0].id, assetId: asset.id, sha256: asset.sha256 };
  assert.equal((await f.call(evidencePath, { method: "POST", etag: plan.etag, body: { ...valid, sha256: "a".repeat(64) } })).response.status, 409);
  assert.equal((await f.call(evidencePath, { method: "POST", body: valid })).response.status, 428);
  const bound = await f.ok(evidencePath, { method: "POST", etag: plan.etag, body: valid });
  assert.equal(bound.slots[0].evidence.sha256, asset.sha256);
  const keyPath = "/api/editorial/illustrations/producer-keys";
  const { publicKey } = generateKeyPairSync("ed25519");
  const key = await f.ok(keyPath, { method: "POST", body: { label: "Isolated public key",
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url") } }, 201);
  assert.match(key.id, /^pk-[a-f0-9]{32}$/);
  assert.equal((await f.ok(keyPath)).items[0].id, key.id);
  const revoked = await f.ok(`${keyPath}/${key.id}/revoke`, { method: "POST", etag: key.etag, body: { reason: "Isolated key rotation." } });
  assert.ok(revoked.revokedAt);
});

test("one authorized website revision reviews its original text and actual images, rejects drift, and preserves the live prior copy until readback", async t => {
  const reviewCalls = [], pendingKinds = new Set(["editorial.variant", "editorial.website_release"]);
  let changeWhileReviewing;
  const aiApproval = { async review(input) {
    const { kind, subjectId, snapshotHash, evidence, images } = input;
    reviewCalls.push({ kind, subjectId, snapshotHash, evidence, imageDigests: (images ?? []).map(image => hash(image.bytes)) });
    if (pendingKinds.delete(kind)) throw new ApiError(409, "AI_APPROVAL_PENDING", "Isolated signed approval is waiting.", { reviewId: hashObject({ kind, snapshotHash }) });
    if (kind === "editorial.website_release" && changeWhileReviewing) {
      const change = changeWhileReviewing;
      changeWhileReviewing = undefined;
      await change();
    }
    return { schema: "pengmanager.ai-approval/v1", kind, subjectId, snapshotHash, decision: "approve", actor: "ai-reviewer", reviewedAt: new Date().toISOString(),
      evidenceHash: hashObject({ kind, snapshotHash, evidence }), rationale: "Isolated reviewer fixture", modelReceipt: { responseId: `test-${kind}` } };
  } };
  const f = await fixture(t, { aiApproval });
  f.editorial.aiApproval = null;
  await readyDestination(f);
  const prior = await release(f);
  const priorReleasePath = `/api/website/releases/${prior.candidate.id}`;
  const approvedPrior = await f.ok(`${priorReleasePath}/approve`, { method: "POST", etag: prior.candidate.etag,
    body: { reviewed: true, snapshotHash: prior.candidate.snapshotHash, authorizationNote: "Keep this exact original isolated article live." } });
  const activePrior = await f.ok(`${priorReleasePath}/publish`, { method: "POST", etag: approvedPrior.etag,
    body: { confirm: true, expectedPreviousReleaseId: null } });
  const livePrior = await f.ok(`${priorReleasePath}/verify`, { method: "POST", etag: activePrior.etag, body: { confirm: true } });
  const publicDetailPath = `/public-api/content/zh-CN/article/${livePrior.slug}`;
  const originalPublicDetail = await f.ok(publicDetailPath, { anonymous: true });
  assert.equal(originalPublicDetail.releaseId, livePrior.id);
  f.editorial.aiApproval = aiApproval;
  reviewCalls.length = 0;

  const story = await f.ok(`/api/stories/${prior.story.id}`);
  const { title, summary, body } = prior.edition;
  const [heading, ...textBlocks] = prior.edition.blocks.filter(block => block.type !== "image");
  const illustrated = await prepareFixtureIllustrations(f.editorial, f.mediaAssets, story, { locale: "zh-CN", title, summary, body, blocks: textBlocks });
  const edition = await f.ok(`/api/stories/${story.id}/editions`, { method: "POST", etag: story.etag,
    body: { locale: "zh-CN", format: "article", title, summary, body, claimIds: ["C-T1"], supersedesEditionId: prior.edition.id,
      ...illustrated, blocks: [heading, ...illustrated.blocks] } }, 201);
  assert.equal((await f.ok("/api/editorial/bootstrap")).aiApprovalEnabled, true);
  const path = `/api/editions/${edition.id}/publish-with-ai`, key = "single-approved-website-intent";
  const requestBody = { destinationId: "official-site", slug: livePrior.slug, editionSnapshotHash: edition.snapshotHash,
    expectedPreviousReleaseId: livePrior.id, supersedesContentId: prior.variant.id,
    publicationAuthorized: true, authorizationNote: "Publish this exact isolated test fixture in the old route." };
  const options = { method: "POST", key, body: requestBody, etag: edition.etag };
  assert.equal((await f.call(path, { ...options, anonymous: true })).response.status, 401);
  assert.equal((await f.call(path, { ...options, etag: '"stale"' })).response.status, 412);
  assert.equal((await f.call(path, { ...options, body: { ...requestBody, publicationAuthorized: false, reviewed: true } })).response.status, 400);
  const first = await f.call(path, options);
  assert.equal(first.response.status, 409, JSON.stringify(first.payload));
  assert.match(JSON.stringify(first.payload), /AI_APPROVAL_PENDING/);
  assert.equal(f.store.snapshot().websiteReleases.length, 1);
  assert.deepEqual(await f.ok(publicDetailPath, { anonymous: true }), originalPublicDetail);
  assert.equal((await f.call(path, { ...options, body: { ...requestBody, authorizationNote: "Different requested authority" } })).response.status, 409);
  const second = await f.call(path, options);
  assert.equal(second.response.status, 409, JSON.stringify(second.payload));
  assert.match(JSON.stringify(second.payload), /AI_APPROVAL_PENDING/);
  const candidate = f.store.snapshot().websiteReleases.find(row => row.editionId === edition.id);
  assert.equal(candidate.status, "draft");
  assert.deepEqual(await f.ok(publicDetailPath, { anonymous: true }), originalPublicDetail);

  changeWhileReviewing = async () => f.store.mutate({ type: "fixture.review_updated", actor: "fixture" }, state => {
    const asset = state.mediaAssets.find(row => row.id === edition.assetRefs[0].assetId);
    asset.review.aiApproval.evidenceHash = "a".repeat(64);
  });
  const drift = await f.call(path, options);
  assert.equal(drift.response.status, 409, JSON.stringify(drift.payload));
  assert.equal(drift.payload.error.code, "AI_APPROVAL_INPUT_CHANGED");
  assert.equal(f.editorial.getRelease(candidate.id).status, "draft");
  assert.deepEqual(await f.ok(publicDetailPath, { anonymous: true }), originalPublicDetail);

  const completed = await f.ok(path, options, 201);
  assert.equal(completed.status, "published");
  assert.ok(completed.receipt);
  assert.deepEqual(await f.ok(path, options, 201), completed);
  const snapshot = f.store.snapshot(), publishedRelease = snapshot.websiteReleases.find(row => row.id === completed.releaseId);
  assert.equal(publishedRelease.publicApproval.approvedBy, "ai-reviewer");
  assert.equal(snapshot.content.find(row => row.id === completed.contentId).approval.approvedBy, "ai-reviewer");
  assert.equal(completed.receipt.verifiedBy, "editorial-publication-system");
  assert.equal(snapshot.websiteReleases.find(row => row.id === completed.releaseId).activatedBy, "editorial-publication-system");
  assert.equal(snapshot.websiteReleases.length, 2);
  assert.equal(snapshot.content.filter(row => row.editionId === edition.id).length, 1);
  assert.equal(publishedRelease.previousReleaseId, livePrior.id);
  assert.equal(completed.releaseId, candidate.id);
  assert.deepEqual(f.editorial.getRelease(livePrior.id), livePrior);
  const html = await f.call(livePrior.canonicalPath, { anonymous: true });
  assert.equal(html.response.status, 200);
  assert.match(html.text, /第二段，不得摘要替换。/);
  const publicDetail = await f.ok(publicDetailPath, { anonymous: true });
  assert.equal(publicDetail.releaseId, completed.releaseId);
  assert.equal(publicDetail.body, originalPublicDetail.body);
  assert.equal(publishedRelease.receipt.assetHashes.length, 3);
  const mediaReviewDigests = reviewCalls.filter(call => call.kind === "editorial.media").flatMap(call => call.imageDigests).sort();
  assert.deepEqual(mediaReviewDigests, edition.assetRefs.map(ref => ref.sha256).sort());
  assert.equal(reviewCalls.filter(call => call.kind === "editorial.variant").length, 2);
  assert.equal(reviewCalls.filter(call => call.kind === "editorial.website_release").length, 3);
  for (const call of reviewCalls.filter(row => ["editorial.variant", "editorial.website_release"].includes(row.kind))) {
    assert.deepEqual(call.imageDigests, edition.assetRefs.map(ref => ref.sha256));
    const evidence = call.evidence.articleReview;
    assert.deepEqual(evidence.originalEdition, { id: edition.id, snapshotHash: edition.snapshotHash, title, summary, body });
    assert.equal(evidence.priorPublicCopy.releaseId, livePrior.id);
    assert.equal(evidence.priorPublicCopy.snapshotHash, livePrior.snapshotHash);
    assert.equal(evidence.priorPublicCopy.body, originalPublicDetail.body);
    assert.equal(evidence.priorPublicCopy.titleSummaryBodyUnchanged, true);
    assert.equal(evidence.priorPublicCopy.nonImageBlocksUnchanged, true);
    assert.deepEqual(evidence.verifiedIllustrations.map(item => item.sha256), edition.assetRefs.map(ref => ref.sha256));
  }
  assert.equal(verifyEventChain(snapshot.events).valid, true);
});

test("the allowlisted original-copy route preserves literal legacy text, structure and proof while adding only verified images", async t => {
  const reviewedKinds = [];
  let pauseRelease = true, changeDestination = false;
  const aiApproval = { async review(input) {
    const { kind, snapshotHash } = input;
    return judgeAiApproval(aiApprovalWorkOrder(input), { async completeTask({ messages }) {
      const payload = messages[1].content;
      const parts = typeof payload === "string" ? [{ text: payload }] : payload;
      const facts = JSON.parse(parts[0].text);
      reviewedKinds.push({ kind, evidence: facts.evidence, criteria: facts.criteria,
        imageHashes: parts.slice(1).map(part => hash(Buffer.from(part.image_url.url.split(",")[1], "base64"))) });
      if (kind === "editorial.website_release" && pauseRelease) {
        pauseRelease = false;
        throw new ApiError(409, "AI_APPROVAL_PENDING", "Isolated pending worker fixture.");
      }
      if (kind === "editorial.website_release" && changeDestination) {
        changeDestination = false;
        await f.store.mutate({ type: "fixture.destination_changed", actor: "fixture" }, state => {
          state.destinations.find(row => row.id === "official-site").policyCheckedAt = "2026-11-16T00:00:00.000Z";
        });
      }
      const officialModelId = TEXT_PRIMARY_MODEL.officialModelId;
      return { value: { decision: "approve", rationale: "Synthetic model fixture only.",
        findings: Object.keys(facts.criteria).map(criterion => ({ criterion, status: "pass", reason: "Synthetic contract assertion only." })) },
      receipt: { schemaVersion: "workloom.model-receipt/v1", policy: { scene: "approval.decision" }, requestedModel: officialModelId,
        returnedModel: officialModelId, finishReason: "stop", responseId: "isolated-editorial-review-fixture",
        requestHash: snapshotHash, responseHash: snapshotHash, wireSha256: snapshotHash, policyHash: snapshotHash,
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } } };
    } });
  } };
  const illustrationCohort = [];
  const f = await fixture(t, { aiApproval, illustrationCohort });
  f.editorial.aiApproval = null;
  await readyDestination(f);
  const originalExcerpt = "Synthetic excerpt from the registered public test source.";
  const renewedExcerpt = "A revised independently reviewed excerpt from the same public test source.";
  const reviewSource = sourceExcerpt => f.service.approveClaim("C-T1", { publicLevel: "approved_public", sourceExcerpt },
    { actor: "fixture", aiApproval });
  await reviewSource(originalExcerpt);
  const story = await f.ok("/api/stories", { method: "POST", body: { workingTitle: "Original-copy authorization fixture", claimIds: ["C-T1"] } }, 201);
  const paragraph = "用 WorkLoom 作早期设计示例，核对任务边界并保留作者用词。原稿在 2026-11-16 记录观察，署名说明属于原稿。";
  const lead = "一条健康的价值链至少需要四个锚点：";
  const original = {
    locale: "zh-CN", format: "article", title: "WorkLoom 原公开标题", summary: "WorkLoom 的原摘要。",
    body: `## 原稿结构\n\n${paragraph}\n\n${lead}\n\n1. WorkLoom 原列表项。`,
    blocks: [{ type: "heading", level: 2, text: "原稿结构" }, { type: "paragraph", text: paragraph }, { type: "paragraph", text: lead },
      { type: "list", ordered: true, items: ["WorkLoom 原列表项。"] }],
    claimIds: ["C-T1"], assetRefs: [],
  };
  const ordinary = await f.ok(`/api/stories/${story.id}/editions`, { method: "POST", etag: story.etag, body: original }, 201);
  assert.doesNotMatch(ordinary.title, /WorkLoom/u);
  assert.ok(ordinary.productNaming);
  const historicalVariant = await f.ok(`/api/editions/${ordinary.id}/variants`, {
    method: "POST", etag: ordinary.etag, body: { destinationId: "official-site" },
  }, 201);
  const slug = "original-copy-authorization", canonicalPath = `/zh/articles/${slug}`, baseId = "REL-00990";
  // Reconstruct a pre-naming-policy activation without text or image changes, then do the real local readback below.
  await f.store.mutate({ type: "fixture.historical_release_loaded", actor: "fixture" }, state => {
    const edition = state.editions.find(row => row.id === ordinary.id);
    const variant = state.content.find(row => row.id === historicalVariant.id);
    Object.assign(edition, original);
    delete edition.productNaming;
    edition.snapshotHash = hashObject(editorialEditionSnapshot(edition));
    Object.assign(variant, original, { editionHash: edition.snapshotHash, status: "scheduled" });
    delete variant.productNaming;
    variant.snapshotHash = variant.snapshotHashV2 = hashObject(editorialVariantSnapshot(variant));
    const now = new Date().toISOString();
    variant.approval = { approvedBy: "fixture", approvedAt: now, snapshotHash: variant.snapshotHash, reviewed: true };
    const publicSnapshot = { ...original, claimBindings: edition.claimBindings, canonicalPath, canonicalUrl: `${f.origin}${canonicalPath}` };
    const snapshotHash = hashObject(publicSnapshot);
    state.websiteReleases.push({ id: baseId, siteId: "official-site", storyId: story.id, editionId: edition.id, contentId: variant.id,
      locale: original.locale, format: original.format, slug, canonicalPath, publicSnapshot, snapshotHash,
      contentSnapshotHash: variant.snapshotHash, previousReleaseId: null, status: "live_unverified", revision: 1,
      publicApproval: { approvedBy: "fixture", approvedAt: now, authorizationNote: "Synthetic pre-policy history only.", snapshotHash, reviewed: true },
      activationAt: now, receipt: null, withdrawal: null, createdAt: now, updatedAt: now });
    state.websiteRoutes.push({ id: "RTE-00990", siteId: "official-site", storyId: story.id, locale: original.locale,
      format: original.format, slug, canonicalPath, activeReleaseId: baseId, revision: 1, createdAt: now, updatedAt: now });
  });
  const activated = f.editorial.getRelease(baseId);
  const prior = await f.ok(`/api/website/releases/${baseId}/verify`, { method: "POST", etag: activated.etag, body: { confirm: true } });
  assert.equal(prior.receipt.verificationMethod, "server_readback");
  const baseRequest = { locale: original.locale, title: original.title, summary: original.summary, body: original.body,
    articleType: "technical", slots: fixtureIllustrationSlots(original.blocks), baseReleaseId: baseId };
  const freshStory = await f.ok(`/api/stories/${story.id}`);
  const planPath = `/api/stories/${story.id}/illustrations`;
  const planOptions = { method: "POST", etag: freshStory.etag, body: baseRequest };
  assert.equal((await f.call(planPath, planOptions)).payload.error.code, "ILLUSTRATION_COPY_SCOPE_MISMATCH");
  illustrationCohort.push({ storyId: story.id, releaseId: baseId, canonicalPath, snapshotHash: prior.snapshotHash });
  assert.deepEqual((await f.ok("/api/editorial/bootstrap")).illustrationCopyBases, [{ storyId: story.id, releaseId: baseId }]);
  const changed = await f.call(planPath, { ...planOptions, body: { ...baseRequest, summary: "不同摘要" } });
  assert.equal(changed.payload.error.code, "ILLUSTRATION_COPY_TEXT_CHANGED");
  const splitList = await f.call(planPath, { ...planOptions, body: { ...baseRequest,
    slots: baseRequest.slots.map((slot, index) => index === 0 ? { ...slot, anchor: lead } : slot) } });
  assert.equal(splitList.payload.error.code, "ILLUSTRATION_INSERTION_INTERRUPTS_LIST");
  assert.equal(splitList.payload.error.details.findings[0].baselineBlockIndex, 2);
  const plan = await f.ok(planPath, planOptions, 201);
  assert.equal(plan.title, original.title);
  assert.equal(plan.baseReleaseId, prior.id);
  const bound = await bindFixtureIllustrations(f.editorial, f.mediaAssets, plan);
  const augmented = placeArticleIllustrations(bound, original);
  const editionPath = `/api/stories/${story.id}/editions`;
  const body = { ...original, ...augmented, supersedesEditionId: ordinary.id, illustrationPlanId: plan.id };
  const editionOptions = { method: "POST", etag: freshStory.etag, body };
  const alteredBlocks = body.blocks.map((block, index) => index === 0 ? { ...block, text: "改变标题层次" } : block);
  for (const invalid of [
    { ...body, body: `${original.body}\n` }, { ...body, blocks: alteredBlocks },
    { ...body, claimIds: [] }, { ...body, sourceEditionId: ordinary.id },
  ]) {
    const result = await f.call(editionPath, { ...editionOptions, body: invalid });
    assert.equal(result.response.status, 409, JSON.stringify(result.payload));
    assert.match(result.payload.error.code, /^ILLUSTRATION_COPY_(?:TEXT|SCOPE)_CHANGED$/);
  }
  const edition = await f.ok(editionPath, editionOptions, 201);
  assert.equal(edition.title, original.title);
  assert.equal(edition.summary, original.summary);
  assert.equal(edition.body, original.body);
  assert.equal(edition.productNaming, undefined);
  assert.deepEqual(edition.blocks.filter(block => block.type !== "image"), original.blocks);
  const overrides = await f.call(`/api/editions/${edition.id}/variants`, { method: "POST", etag: edition.etag,
    body: { destinationId: "official-site", title: edition.title } });
  assert.equal(overrides.payload.error.code, "ARTICLE_AUGMENTATION_OVERRIDES_FORBIDDEN");
  const external = await f.ok("/api/destinations", { method: "POST", body: { platformId: "github", accountId: "github",
    kind: "repository", name: "Synthetic independent destination", locator: { url: "https://github.com/isolated-fixture/independent-destination" } } }, 201);
  const wrongDestination = await f.call(`/api/editions/${edition.id}/variants`, { method: "POST", etag: edition.etag,
    body: { destinationId: external.id } });
  assert.equal(wrongDestination.payload.error.code, "OWNED_PUBLIC_DESTINATION_REQUIRED");
  f.editorial.aiApproval = aiApproval;
  const publicationPath = `/api/editions/${edition.id}/publish-with-ai`;
  const publication = { method: "POST", etag: edition.etag, key: "isolated-preserve-old-authorization",
    body: { destinationId: "official-site", editionSnapshotHash: edition.snapshotHash, slug,
      expectedPreviousReleaseId: baseId, supersedesContentId: historicalVariant.id, publicationAuthorized: true,
      authorizationNote: "Only add reviewed images to the exact authorized isolated original." } };
  const conflict = await f.call(publicationPath, { ...publication, body: { ...publication.body, expectedPreviousReleaseId: null } });
  assert.equal(conflict.payload.error.code, "RELEASE_ROUTE_CONFLICT");
  const waiting = await f.call(publicationPath, publication);
  assert.equal(waiting.payload.error.code, "AI_APPROVAL_PENDING");
  const { contentId, releaseId, workflowId, authorizedBy } = waiting.payload.error.details.workflow;
  // Reconstruct approvals committed with the pre-upgrade rubric and replay keys.
  await f.store.mutate({ type: "fixture.prior_review_rubric", actor: "fixture" }, state => {
    const variant = state.content.find(row => row.id === contentId);
    delete variant.approval.articleReviewScope;
    const variantScope = `variant_transitioned:${contentId}`;
    const previous = state.editorialRequests.find(row => row.scope === variantScope && row.result.approval?.articleReviewScope);
    previous.keyHash = hashObject({ actor: authorizedBy, scope: variantScope, key: hashObject([workflowId, "review-variant"]) });
    delete previous.result.approval.articleReviewScope;
    const candidate = state.websiteReleases.find(row => row.id === releaseId);
    candidate.status = "approved";
    const note = publication.body.authorizationNote;
    candidate.publicApproval = { approvedBy: "ai-reviewer", approvedAt: new Date().toISOString(), authorizationNote: note,
      snapshotHash: candidate.snapshotHash, reviewed: true, authorizedBy,
      aiApproval: { actor: "ai-reviewer", decision: "approve", snapshotHash: candidate.snapshotHash, evidenceHash: hashObject("legacy rubric") } };
    const scope = `release_approved:${releaseId}`;
    state.editorialRequests.push({ actor: authorizedBy, scope, keyHash: hashObject({ actor: authorizedBy, scope,
      key: hashObject([workflowId, "review-release"]) }),
    requestHash: hashObject({ snapshotHash: candidate.snapshotHash, authorizationNote: note }), result: structuredClone(candidate),
    at: new Date().toISOString() });
  });
  assert.equal(f.editorial.getVariant(contentId).originalIllustrationReviewPending, true);
  const candidate = f.editorial.getRelease(releaseId);
  assert.equal(candidate.originalIllustrationReviewPending, true);
  const directActivation = await f.call(`/api/website/releases/${releaseId}/publish`, { method: "POST", etag: candidate.etag,
    body: { confirm: true, expectedPreviousReleaseId: baseId } });
  assert.equal(directActivation.payload.error.code, "AI_ORIGINAL_ILLUSTRATION_REVIEW_REQUIRED");
  assert.equal(f.store.snapshot().websiteRoutes.find(row => row.canonicalPath === canonicalPath).activeReleaseId, baseId);
  changeDestination = true;
  const drift = await f.call(publicationPath, publication);
  assert.equal(drift.payload.error.code, "AI_APPROVAL_INPUT_CHANGED");
  assert.equal(f.store.snapshot().websiteRoutes.find(row => row.canonicalPath === canonicalPath).activeReleaseId, baseId);
  const activate = f.editorial.publishRelease.bind(f.editorial);
  let activationAttempt = 0;
  f.editorial.publishRelease = async (...args) => {
    activationAttempt += 1;
    if (activationAttempt === 1) {
      await f.store.mutate({ type: "fixture.destination_review_renewed", actor: "fixture" }, state => {
        state.destinations.find(row => row.id === "official-site").policyCheckedAt = "2026-11-18T00:00:00.000Z";
      });
    } else if (activationAttempt === 2) {
      await f.store.mutate({ type: "fixture.channel_review_renewed", actor: "fixture" }, state => {
        const variant = state.content.find(row => row.id === contentId);
        variant.approval.aiApproval.evidenceHash = hashObject("distinct approved channel evidence fixture");
        variant.version += 1;
      });
    } else if (activationAttempt === 3) {
      await reviewSource(renewedExcerpt);
    } else if (activationAttempt === 4) {
      const asset = f.mediaAssets.getAsset(edition.assetRefs[0].assetId);
      await f.ok(`/api/media/assets/${asset.id}/approve`, { method: "POST", etag: asset.etag,
        body: { sha256: asset.sha256, rightsConfirmed: true, privacyConfirmed: true,
          rightsNote: "A new independently reviewed use note for this same isolated test image." } });
    }
    return activate(...args);
  };
  const staleDestination = await f.call(publicationPath, publication);
  assert.equal(staleDestination.payload.error.code, "AI_ORIGINAL_ILLUSTRATION_REVIEW_REQUIRED");
  assert.equal(f.editorial.getVariant(contentId).originalIllustrationReviewPending, true);
  assert.equal(f.editorial.getRelease(releaseId).originalIllustrationReviewPending, true);
  assert.equal(f.store.snapshot().websiteRoutes.find(row => row.canonicalPath === canonicalPath).activeReleaseId, baseId);
  const staleChannelReview = await f.call(publicationPath, publication);
  assert.equal(staleChannelReview.payload.error.code, "AI_ORIGINAL_ILLUSTRATION_REVIEW_REQUIRED");
  assert.equal(f.editorial.getVariant(contentId).originalIllustrationReviewPending, undefined);
  assert.equal(f.editorial.getRelease(releaseId).originalIllustrationReviewPending, true);
  assert.equal(f.store.snapshot().websiteRoutes.find(row => row.canonicalPath === canonicalPath).activeReleaseId, baseId);
  for (const changedBasis of ["claimSources", "media"]) {
    const stale = await f.call(publicationPath, publication);
    assert.equal(stale.payload.error.code, "AI_ORIGINAL_ILLUSTRATION_REVIEW_REQUIRED");
    const staleVariant = f.editorial.getVariant(contentId);
    const staleRelease = f.editorial.getRelease(releaseId);
    assert.equal(staleVariant.originalIllustrationReviewPending, true, changedBasis);
    assert.equal(staleRelease.originalIllustrationReviewPending, true, changedBasis);
    assert.equal(staleRelease.status, "approved");
    assert.equal(f.store.snapshot().websiteRoutes.find(row => row.canonicalPath === canonicalPath).activeReleaseId, baseId);
  }
  const published = await f.ok(publicationPath, publication, 201);
  assert.equal(published.status, "published");
  assert.equal(published.receipt.assetHashes.length, 3);
  assert.equal(published.releaseId, releaseId);
  assert.equal(published.contentId, contentId);
  const releaseApproval = f.editorial.getRelease(releaseId).publicApproval;
  const variantApproval = f.editorial.getVariant(contentId).approval;
  assert.equal(releaseApproval.articleReviewScope, ORIGINAL_ILLUSTRATION_REVIEW);
  assert.equal(variantApproval.articleReviewScope, ORIGINAL_ILLUSTRATION_REVIEW);
  assert.equal(releaseApproval.articleReviewBinding.destinationHash, variantApproval.articleReviewBinding.destinationHash);
  assert.equal(releaseApproval.articleReviewBinding.sourcesAndMediaHash, variantApproval.articleReviewBinding.sourcesAndMediaHash);
  assert.equal(releaseApproval.articleReviewBinding.variantReviewHash, variantApproval.aiApproval.evidenceHash);
  assert.deepEqual(await f.ok(publicationPath, publication, 201), published);
  const actual = await f.ok(`/public-api/content/zh-CN/article/${slug}`, { anonymous: true });
  assert.equal(actual.releaseId, published.releaseId);
  assert.equal(actual.title, original.title);
  assert.equal(actual.summary, original.summary);
  assert.equal(actual.body, original.body);
  assert.deepEqual(actual.blocks.filter(block => block.type !== "image"), original.blocks);
  assert.deepEqual(f.editorial.getRelease(baseId), prior);
  assert.deepEqual((await f.ok("/api/editorial/bootstrap")).illustrationCopyBases, []);
  const currentStory = await f.ok(`/api/stories/${story.id}`);
  assert.equal((await f.call(planPath, { ...planOptions, etag: currentStory.etag })).payload.error.code, "ILLUSTRATION_COPY_SCOPE_MISMATCH");
  const reviewedPublication = reviewedKinds.filter(row => ["editorial.variant", "editorial.website_release"].includes(row.kind));
  const channelReviews = reviewedPublication.filter(row => row.kind === "editorial.variant");
  assert.equal(channelReviews.length, 6);
  assert.equal(reviewedPublication.filter(row => row.kind === "editorial.website_release").length, 7);
  const [beforeSourceChange, afterSourceChange, afterMediaChange] = channelReviews.slice(-3).map(row => row.evidence.articleReview);
  assert.equal(beforeSourceChange.readableClaimSources[0].excerpt, originalExcerpt);
  assert.equal(afterSourceChange.readableClaimSources[0].excerpt, renewedExcerpt);
  assert.deepEqual(afterSourceChange.originalDelta.reviewBasis.media, beforeSourceChange.originalDelta.reviewBasis.media);
  assert.deepEqual(afterMediaChange.originalDelta.reviewBasis.claimSources, afterSourceChange.originalDelta.reviewBasis.claimSources);
  assert.notEqual(afterMediaChange.originalDelta.reviewBasis.media[0].review.hash, afterSourceChange.originalDelta.reviewBasis.media[0].review.hash);
  assert.equal(afterMediaChange.originalDelta.reviewBasis.media[0].sha256, afterSourceChange.originalDelta.reviewBasis.media[0].sha256);
  assert.equal(variantApproval.articleReviewBinding.sourcesAndMediaHash, hashObject(afterMediaChange.originalDelta.reviewBasis));
  for (const item of reviewedPublication) {
    const { articleReview, verifiedPublicationIntent, verifiedPublicationAuthorization } = item.evidence;
    const delta = articleReview.originalDelta;
    assert.equal(delta.schema, ORIGINAL_ILLUSTRATION_REVIEW);
    assert.equal(delta.baseline.releaseId, prior.id);
    assert.equal(delta.baseline.readback.hash, prior.receipt.receiptHash);
    assert.equal(delta.baseline.readback.method, "server_readback");
    assert.equal(delta.destination.id, "official-site");
    assert.equal(delta.destination.identityReview, "verified");
    for (const preserved of Object.values(delta.preserved)) assert.equal(preserved.before.hash, preserved.after.hash);
    assert.equal(delta.insertions.length, 3);
    for (const insertion of delta.insertions) {
      assert.deepEqual(insertion.after.filter(row => row.type !== "image"), insertion.before);
      assert.ok(insertion.after.some(row => row.type === "image" && row.assetId === insertion.assetId));
      assert.match(JSON.stringify(insertion.before), /2026-11-16/u);
    }
    assert.equal(Object.hasOwn(item.evidence, "body"), false);
    assert.equal(Object.hasOwn(articleReview, "priorPublicCopy"), false);
    assert.equal(verifiedPublicationIntent.previousReleaseId, prior.id);
    assert.equal(verifiedPublicationIntent.authorizedBy, authorizedBy);
    assert.equal(verifiedPublicationIntent.editionSnapshotHash, edition.snapshotHash);
    if (item.kind === "editorial.website_release") {
      assert.equal(verifiedPublicationAuthorization.snapshotHash, candidate.snapshotHash);
      assert.equal(verifiedPublicationAuthorization.canonicalPath, canonicalPath);
      assert.equal(verifiedPublicationAuthorization.note, publication.body.authorizationNote);
    }
    assert.match(item.criteria.preserved_original, /原文既有编排、编号、术语、历史日期、署名/u);
    assert.match(item.criteria.placement, /新增视觉分隔/u);
    assert.match(item.criteria.new_claims, /新增或扩大主张/u);
    assert.deepEqual(item.imageHashes, edition.assetRefs.map(ref => ref.sha256));
  }
  assert.equal(verifyEventChain(f.store.snapshot().events).valid, true);
});

test("a new MP4 remains private when the available AI worker cannot review its actual complete media", async t => {
  let modelCalls = 0;
  const f = await fixture(t, { aiApproval: { async review() { modelCalls += 1; throw new Error("A binary must not become a text-only review."); } } });
  const response = await fetch(`${f.origin}/api/media/assets`, { method: "POST", headers: { Cookie: f.cookie,
    "Content-Type": "video/mp4", "Idempotency-Key": "ai-unsupported-mp4-upload", "X-Content-Sha256": hash(MP4) }, body: MP4 });
  const asset = await response.json();
  assert.equal(response.status, 201, JSON.stringify(asset));
  const refused = await f.call(`/api/media/assets/${asset.id}/approve`, { method: "POST", etag: asset.etag,
    body: { sha256: asset.sha256, rightsConfirmed: true, privacyConfirmed: true, rightsNote: "Isolated valid origin with no actual model inspection coverage." } });
  assert.equal(refused.response.status, 422);
  assert.equal(refused.payload.error.code, "AI_APPROVAL_MEDIA_INSPECTION_REQUIRED");
  assert.equal(modelCalls, 0);
  const current = f.mediaAssets.getAsset(asset.id);
  assert.equal(current.status, "staged");
  assert.equal(current.review, undefined);
  assert.equal((await f.call(`/public-media/${asset.id}/${asset.sha256}`, { anonymous: true })).response.status, 404);
});

test("a scene's signed production chain reaches AI while the same bytes are still staged", async t => {
  const calls = [];
  let onReview;
  const aiApproval = { async review(input) {
    calls.push(input);
    if (!input.evidence.verifiedSceneProvenance) throw new ApiError(409, "AI_APPROVAL_NEEDS_EVIDENCE", "Isolated missing proof");
    await onReview?.();
    return { schema: "pengmanager.ai-approval/v1", actor: "ai-reviewer", kind: input.kind, subjectId: input.subjectId,
      snapshotHash: input.snapshotHash, evidenceHash: hashObject(input.evidence), decision: "approve",
      reviewedAt: new Date().toISOString(), modelReceipt: { responseId: "isolated-scene-review" } };
  } };
  const f = await fixture(t, { aiApproval });
  const story = await f.ok("/api/stories", { method: "POST", body: { workingTitle: "Authentic illustration chain fixture" } }, 201);
  const title = story.workingTitle, body = "The diagram, the logic, and the scene explain how an isolated fixture can be verified.";
  const slots = fixtureIllustrationSlots([{ type: "paragraph", text: body }]);
  slots[2].imageGeneration = true;
  const illustrationPath = `/api/stories/${story.id}/illustrations`;
  const plan = await f.ok(illustrationPath, { method: "POST", etag: story.etag,
    body: { title, summary: "Isolated HTTP provenance test", body, locale: "zh-CN", articleType: "product", slots } }, 201);
  const slot = plan.slots[2], compositor = await registerFixtureIllustrator(f.editorial), imageGen = await registerFixtureIllustrator(f.editorial);
  const actualBytes = await syntheticIllustrationPng(9), originalBytes = await syntheticIllustrationPng(2);
  const asset = await uploadFixtureIllustration(f.mediaAssets, actualBytes, undefined, { review: false });
  const original = await uploadFixtureIllustration(f.mediaAssets, originalBytes, undefined, { review: false });
  const proof = fixtureIllustrationProof("pengmanager-designer-compositor", plan, slot, asset, compositor, {
    imageGenInputSha256: original.sha256, approvalAuthority: "ai", approvalDecisionHash: "1".repeat(64),
  });
  const inputProof = fixtureIllustrationProof("codex-imagegen", plan, slot, original, imageGen);
  const signed = { designerCompositor: proof, imageGen: inputProof };
  const reviewPath = `/api/media/assets/${asset.id}/approve`, bindingPath = `${illustrationPath}/${plan.id}/evidence`;
  const request = { sha256: asset.sha256, rightsNote: "Original synthetic image and original composition authorized for this isolated article only." };
  const bind = { assetId: asset.id, sha256: asset.sha256, slotId: slot.id, ...signed };
  const rejectedBind = await f.call(bindingPath, { method: "POST", etag: plan.etag, body: bind });
  assert.equal(rejectedBind.payload.error.code, "ILLUSTRATION_ASSET_NOT_REVIEWED");
  const without = await f.call(reviewPath, { method: "POST", etag: asset.etag, body: request });
  assert.equal(without.payload.error.code, "AI_APPROVAL_NEEDS_EVIDENCE");
  assert.equal(calls.length, 1);
  for (const [candidate, code] of [
    [{ designerCompositor: { ...proof, statement: { ...proof.statement, composeEventId: "forged-event" } }, imageGen: inputProof }, "ILLUSTRATION_SIGNATURE_INVALID"],
    [{ designerCompositor: proof }, "ILLUSTRATION_RECEIPT_REQUIRED"],
    [{ designerCompositor: proof, imageGen: fixtureIllustrationProof("codex-imagegen", plan, slot, asset, imageGen) }, "ILLUSTRATION_RECEIPT_MISMATCH"],
  ]) {
    const invalid = await f.call(reviewPath, { method: "POST", etag: asset.etag, body: { ...request, articleSceneProofs: candidate } });
    assert.equal(invalid.payload.error.code, code);
  }
  const wrongBytes = await f.call(`/api/media/assets/${original.id}/approve`, { method: "POST", etag: original.etag,
    body: { ...request, sha256: original.sha256, articleSceneProofs: signed } });
  assert.equal(wrongBytes.payload.error.code, "ILLUSTRATION_RECEIPT_MISMATCH");
  assert.equal(calls.length, 1, "Unverified evidence never reaches the model");
  assert.equal(f.mediaAssets.getAsset(asset.id).status, "staged");

  const options = { method: "POST", etag: asset.etag, key: "signed-scene-media-exact-replay", body: { ...request, articleSceneProofs: signed } };
  const reviewed = await f.ok(reviewPath, options);
  const reviewedEvidence = calls[1].evidence, verified = reviewedEvidence.verifiedSceneProvenance;
  assert.equal(verified.planId, plan.id);
  assert.equal(verified.slotId, slot.id);
  assert.equal(verified.sceneBriefHash, slot.sceneBriefHash);
  assert.equal(verified.compositor.approvalAuthority, "ai");
  assert.equal(verified.compositor.receiptHash, hashObject(proof));
  assert.equal(verified.imageGen.inputSha256, original.sha256);
  assert.equal(verified.output.sha256, hash(actualBytes));
  assert.equal(reviewedEvidence.authorizedBy, "PengManager");
  assert.equal(reviewedEvidence.rightsEvidence, request.rightsNote);
  assert.doesNotMatch(JSON.stringify(reviewedEvidence), /"signature"/u);
  assert.deepEqual(calls[1].images[0].bytes, actualBytes);
  assert.deepEqual(await f.ok(reviewPath, options), reviewed);
  assert.equal(calls.length, 2);
  assert.equal(reviewed.review.reviewedBy, "ai-reviewer");
  assert.equal(reviewed.review.authorizedBy, "PengManager");
  assert.equal((await f.ok(bindingPath, { method: "POST", etag: plan.etag, body: bind })).slots[2].evidence.assetId, asset.id);

  const other = await uploadFixtureIllustration(f.mediaAssets, await syntheticIllustrationPng(17), undefined, { review: false });
  const otherProof = fixtureIllustrationProof("pengmanager-designer-compositor", plan, slot, other, compositor, { imageGenInputSha256: original.sha256 });
  onReview = () => f.editorial.revokeIllustrationProducerKey(compositor.producer.id, { reason: "Revoked by isolated race test." },
    { actor: "Isolated administrator", method: "local", idempotencyKey: "isolated-revoke-producer", ifMatch: compositor.producer.etag });
  const raced = await f.call(`/api/media/assets/${other.id}/approve`, { method: "POST", etag: other.etag,
    body: { ...request, sha256: other.sha256, articleSceneProofs: { designerCompositor: otherProof, imageGen: inputProof } } });
  assert.equal(raced.payload.error.code, "ILLUSTRATION_PRODUCER_UNTRUSTED");
  assert.equal(f.mediaAssets.getAsset(other.id).status, "staged");
});

test("the authenticated editorial bootstrap negotiates gzip without changing a JSON byte", async t => {
  const f = await fixture(t);
  const story = await f.ok("/api/stories", { method: "POST", body: { workingTitle: "Synthetic transfer fixture" } }, 201);
  await f.ok(`/api/stories/${story.id}/editions`, { method: "POST", etag: story.etag,
    body: { locale: "zh-CN", format: "article", title: "完整测试正文", body: "编辑传输校验。\n".repeat(1200) } }, 201);
  const read = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = request(f.origin + path, { headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ response, bytes: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
  const path = "/api/editorial/bootstrap", auth = { Cookie: f.cookie };
  const plain = await read(path, auth);
  const compressed = await read(path, { ...auth, "Accept-Encoding": "gzip, br" });
  for (const result of [plain, compressed]) {
    assert.equal(result.response.statusCode, 200);
    assert.equal(Number(result.response.headers["content-length"]), result.bytes.length);
    assert.equal(result.response.headers.vary, "Accept-Encoding");
    assert.match(result.response.headers["cache-control"], /no-store/);
    assert.equal(result.response.headers["set-cookie"], undefined);
  }
  assert.equal(compressed.response.headers["content-encoding"], "gzip");
  assert.equal(plain.response.headers["content-encoding"], undefined);
  assert.deepEqual(gunzipSync(compressed.bytes), plain.bytes);
  assert.ok(compressed.bytes.length < plain.bytes.length);
  for (const preference of ["gzip;q=0, *;q=1", "gzip;q=0.3, identity;q=0.9", "gzip;q=invalid", "br"]) {
    const declined = await read(path, { ...auth, "Accept-Encoding": preference });
    assert.equal(declined.response.headers["content-encoding"], undefined, preference);
    assert.deepEqual(declined.bytes, plain.bytes);
  }
  for (const [url, headers, status] of [
    [path, {}, 401], [path, { Authorization: `Bearer ${f.agentToken}` }, 403], [path + "?reflect=blocked", auth, 400],
    ["/api/media/assets", auth, 200],
  ]) {
    const result = await read(url, { ...headers, "Accept-Encoding": "gzip" });
    assert.equal(result.response.statusCode, status);
    assert.equal(result.response.headers["content-encoding"], undefined);
  }
});

test("complete bilingual article/visual/video releases use actual SSR, bytes/readback, full backup and isolated restore", async t => {
  const f = await fixture(t); await readyDestination(f);
  const image = await upload(f, PNG, "image/png", "image");
  const video = await upload(f, MP4, "video/mp4", "video");
  const refs = asset => ({ assetId: asset.id, sha256: asset.sha256, role: asset.kind === "video" ? "video" : "image", alt: "Synthetic blue fixture", caption: "Acceptance fixture" });
  assert.equal((await fetch(`${f.origin}/public-media/${image.id}/${image.sha256}`)).status, 404);
  let articleStory;
  const created = [];
  for (const spec of [{ format: "article" }, { format: "article", locale: "en-US" },
    { format: "image_text", assetRefs: [refs(image)] }, { format: "video", assetRefs: [refs(video)] }]) {
    const row = await release(f, { ...spec, ...(spec.locale === "en-US" ? { story: articleStory } : {}) });
    if (!articleStory) articleStory = row.story;
    const preview = await f.call(`/admin/preview/${row.candidate.id}`);
    assert.equal(preview.response.status, 200); assert.equal(preview.response.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.match(preview.text, /"preview":true/); assert.ok(preview.text.includes(row.title));
    assert.equal((await f.call(row.candidate.canonicalPath, { anonymous: true })).response.status, 404);
    const approved = await f.ok(`/api/website/releases/${row.candidate.id}/approve`, { method: "POST", etag: row.candidate.etag,
      body: { reviewed: true, snapshotHash: row.candidate.snapshotHash, authorizationNote: "Isolated synthetic acceptance publication only." } });
    const committedBytes = await readFile(f.store.filePath);
    const activated = await f.ok(`/api/website/releases/${approved.id}/publish`, { method: "POST", etag: approved.etag,
      body: { confirm: true, expectedPreviousReleaseId: null } });
    assert.equal(activated.status, "live_unverified");
    const backupOptions = { store: f.store, backupId: activated.activationBackup.backupId,
      expectedManifestSha256: activated.activationBackup.manifestSha256 };
    const backupStatePath = join(f.directory, "live", "backups", "editorial", backupOptions.backupId, "state.json");
    assert.deepEqual(await readFile(backupStatePath), committedBytes);
    assert.equal((await lstat(backupStatePath)).mode & 0o777, 0o400);
    assert.equal((await verifyEditorialBackup(backupOptions)).stateSha256, hash(committedBytes));
    const verified = await f.ok(`/api/website/releases/${activated.id}/verify`, { method: "POST", etag: activated.etag, body: { confirm: true } });
    assert.equal(verified.status, "published"); assert.equal(verified.receipt.verificationMethod, "server_readback");
    const page = await f.call(verified.canonicalPath, { anonymous: true });
    assert.equal(page.response.status, 200); assert.match(page.text, /&lt;script&gt;window.injected=1&lt;\/script&gt;/);
    assert.doesNotMatch(page.text, /<script>window.injected=1<\/script>/);
    assert.equal((page.text.match(/data-public-release=/g) || []).length, 1);
    assert.ok(page.text.includes(`<link rel="canonical" href="${f.origin}${verified.canonicalPath}"`));
    if (spec.format === "video") assert.match(page.text, /<video controls playsinline preload="metadata"/);
    if (spec.format === "image_text") assert.match(page.text, /data-enlarge-image/);
    created.push(verified);
  }
  const detail = await f.ok("/public-api/content/zh-CN/article/zh-article", { anonymous: true });
  assert.equal(detail.alternates["en-US"], `${f.origin}/en/articles/en-article`);
  assert.equal(detail.assets.length, 3);
  assert.equal(detail.blocks.filter(block => block.type === "image").length, 3);
  assert.equal(detail.body, 'First complete paragraph <script>window.injected=1</script> & exact text.\n\n第二段，不得摘要替换。');
  assert.doesNotMatch(JSON.stringify(detail), /claimBindings|accountSnapshot|identityReview|rightsNote|filePath|fixture-admin|producerKeyId|illustrationPlanHash/);
  const range = await fetch(`${f.origin}/public-media/${video.id}/${video.sha256}`, { headers: { Range: "bytes=0-31" } });
  assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), MP4.subarray(0, 32));
  const current = await f.backup.captureCurrent();
  const verifiedBackup = await verifyEditorialBackup({ store: f.store, backupId: current.backupId, expectedManifestSha256: current.manifestSha256 });
  assert.ok(verifiedBackup);
  const target = join(f.directory, "isolated-restore");
  await restoreEditorialBackupToIsolatedDirectory({ store: f.store, backupId: current.backupId, expectedManifestSha256: current.manifestSha256, targetDirectory: target });
  const restored = JSON.parse(await readFile(join(target, "state.json"), "utf8"));
  assert.deepEqual(restored, f.store.snapshot()); assert.equal(verifyEventChain(restored.events).valid, true);
  assert.deepEqual(await readFile(join(target, "media-assets/objects", `${video.id}.bin`)), MP4);
  const row = created.at(-1);
  await f.ok(`/api/website/releases/${row.id}/withdraw`, { method: "POST", etag: row.etag, body: { reason: "Isolated acceptance withdrawal." } });
  assert.equal((await f.call(row.canonicalPath, { anonymous: true })).response.status, 410);
  assert.equal((await fetch(`${f.origin}/public-media/${video.id}/${video.sha256}`, { headers: { "If-None-Match": `"${video.sha256}"` } })).status, 404);
  assert.equal((await f.ok("/public-api/content?locale=zh-CN&format=video", { anonymous: true })).total, 0);
});

test("activation fails closed on a same-size change to the committed state file and permits an exact retry", async t => {
  const f = await fixture(t); await readyDestination(f);
  const { candidate } = await release(f);
  const approved = await f.ok(`/api/website/releases/${candidate.id}/approve`, { method: "POST", etag: candidate.etag,
    body: { reviewed: true, snapshotHash: candidate.snapshotHash, authorizationNote: "Synthetic integrity test." } });
  assert.throws(() => f.store.committedStateFile(f.store.snapshot()), { code: "STATE_REVISION_CHANGED" });
  const committedBytes = await readFile(f.store.filePath);
  const changedBytes = Buffer.from(committedBytes.toString("utf8").replace("Synthetic acceptance only", "Synthetic acceptance onlx"));
  assert.equal(changedBytes.length, committedBytes.length);
  assert.notDeepEqual(changedBytes, committedBytes);
  await writeFile(f.store.filePath, changedBytes);
  const path = `/api/website/releases/${approved.id}/publish`;
  const request = { method: "POST", etag: approved.etag, key: "same-activation-after-byte-check",
    body: { confirm: true, expectedPreviousReleaseId: null } };
  const failed = await f.call(path, request);
  assert.equal(failed.response.status, 503);
  assert.equal(failed.payload.error.code, "EDITORIAL_BACKUP_HASH_MISMATCH");
  assert.equal(f.editorial.getRelease(approved.id).status, "approved");
  assert.equal((await f.call(approved.canonicalPath, { anonymous: true })).response.status, 404);
  assert.deepEqual(await readdir(join(f.directory, "live", "backups", "editorial")), []);
  assert.deepEqual(await readFile(f.store.filePath), changedBytes);
  await writeFile(f.store.filePath, committedBytes);
  const activated = await f.ok(path, request);
  assert.equal(activated.status, "live_unverified");
  assert.equal(activated.activationBackup.stateSha256, hash(committedBytes));
});

test("real network readback rejects modified DTO, SSR and actual asset bytes while preserving unverified status", async t => {
  const f = await fixture(t); await readyDestination(f);
  const image = await upload(f, PNG, "image/png", "negative-image");
  const row = await release(f, { format: "image_text", assetRefs: [{ assetId: image.id, sha256: image.sha256, role: "image", alt: "Synthetic", caption: "" }] });
  let candidate = await f.ok(`/api/website/releases/${row.candidate.id}/approve`, { method: "POST", etag: row.candidate.etag,
    body: { reviewed: true, snapshotHash: row.candidate.snapshotHash, authorizationNote: "Isolated negative acceptance." } });
  candidate = await f.ok(`/api/website/releases/${candidate.id}/publish`, { method: "POST", etag: candidate.etag, body: { confirm: true, expectedPreviousReleaseId: null } });
  const expected = f.editorial.publicDetail({ locale: "zh-CN", format: "image_text", slug: "zh-image-text" });
  for (const mode of ["json", "html", "comment", "template", "hidden", "seed", "asset", "redirect", "private-url"]) {
    const fetchImpl = async (url, options) => {
      assert.equal(options.redirect, "error"); assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers.Authorization, undefined);
      const result = await fetch(url, options);
      if (mode === "json" && url.includes("/public-api/")) return new Response(JSON.stringify({ ...expected, body: "Changed after approval" }), { headers: { "Content-Type": "application/json" } });
      if (mode === "html" && url.includes("/zh/")) return new Response("<html>200 without approved content</html>", { headers: { "Content-Type": "text/html" } });
      if (["comment", "template", "hidden"].includes(mode) && url.includes("/zh/")) {
        const html = await result.text();
        const changed = mode === "comment" ? `<!--${html}--><p>Unavailable</p>` : mode === "template" ? `<template>${html}</template>` : html.replace('<main id="site-main"', '<main hidden id="site-main"');
        return new Response(changed, { headers: { "Content-Type": "text/html" } });
      }
      if (mode === "seed" && url.includes("/zh/")) {
        const html = await result.text();
        return new Response(html.replace(/<script id="site-data" type="application\/json">([\s\S]*?)<\/script>/, (_all, json) => {
          const seed = JSON.parse(json); seed.preview = true; seed.detail.body = "Changed hydrated content";
          return `<script id="site-data" type="application/json">${JSON.stringify(seed)}</script>`;
        }), { headers: { "Content-Type": "text/html" } });
      }
      if (mode === "asset" && url.includes("/public-media/")) return new Response(Buffer.alloc(PNG.length), { headers: { "Content-Type": "image/png" } });
      if (mode === "redirect") return new Response("", { status: 302, headers: { Location: "/admin" } });
      return result;
    };
    const verify = createWebsiteReadback({ origin: f.origin, allowLoopback: true, fetchImpl });
    await assert.rejects(verify(mode === "private-url" ? { ...expected, canonicalUrl: "http://127.0.0.1/private" } : expected), error => error.status === 502);
  }
  f.editorial.verifyReadback = async () => { throw new Error("synthetic verification outage"); };
  assert.equal((await f.call(`/api/website/releases/${candidate.id}/verify`, { method: "POST", etag: candidate.etag, body: { confirm: true } })).response.status, 500);
  assert.equal(f.editorial.getRelease(candidate.id).status, "live_unverified");
  assert.equal((await f.call(`/api/website/releases/${candidate.id}/verify`, { method: "POST", etag: candidate.etag,
    body: { confirm: true, proof: { method: "server_readback" } } })).response.status, 400);
});
