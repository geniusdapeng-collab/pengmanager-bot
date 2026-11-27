import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { chmod, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { contentOpsFixture, createOpsJob, finishTextOpsJob, isolatedTaskData, pairOpsWorker, claimOpsTask, leaseIdentity, uploadOpsSource, FIXTURE_PRICING, opsContext, OPS_NOW, OPS_EXPIRY } from "./content-ops-fixtures.mjs";
import { context, scheduleVariant } from "./editorial-fixtures.mjs";
import { fixtureIllustrationProof, fixtureIllustrationSlots, registerFixtureIllustrator, syntheticIllustrationPng } from "./fixtures/article-illustrations.mjs";
import { AccountOperationsService } from "../src/services/account-operations.mjs";
import { EditorialService } from "../src/services/editorial-service.mjs";
import { placeArticleIllustrations } from "../src/domain/article-illustrations.mjs";
import { EDITORIAL_NATIVE_SCHEMA, EDITORIAL_NATIVE_EDITION_SCHEMA, editorialInput } from "../src/domain/editorial.mjs";
import { qualityTextKeys } from "../src/domain/content-ops-quality.mjs";
import { createEditorialBackup, verifyEditorialBackup, restoreEditorialBackupToIsolatedDirectory } from "../src/services/editorial-backup.mjs";
import { hashObject } from "../src/domain/hash.mjs";
import { ApiError } from "../src/domain/errors.mjs";
import { JsonStore } from "../src/storage/json-store.mjs";

// Actual file storage, state transitions and snapshots; model/platform results
// are explicit isolated fixtures. These tests make no supplier or social call.
test("validated native report hash arrays cannot randomly become phone findings while malformed digests and prose stay protected", () => {
  const digest = `a13800138000a${"b".repeat(51)}`;
  for (const key of ["qualityReportHashes", "rightsReviewHashes", "privacyReviewHashes", "artifactHashes"]) {
    assert.doesNotThrow(() => editorialInput({ [key]: [digest] }, [key]));
    assert.throws(() => editorialInput({ [key]: ["13800138000"] }, [key]), { code: "EDITORIAL_SENSITIVE_INPUT" });
  }
  assert.throws(() => editorialInput({ body: "Contact 13800138000" }, ["body"]), { code: "EDITORIAL_SENSITIVE_INPUT" });
});
async function fixture(t) {
  const f = await contentOpsFixture(t);
  f.service.productionArtifacts = f.artifacts;
  f.operations = new AccountOperationsService({ service: f.geoService, clock: f.clock, productionArtifacts: f.artifacts });
  return f;
}
async function linkedin(f) {
  let account = f.service.getAccount("linkedin");
  account = await f.service.updateAccount(account.id, { profileUrl: "https://www.linkedin.com/in/isolated-unit-test",
    status: "active", identityConfirmed: true, policyStatus: "reviewed", policyCheckedAt: OPS_NOW.toISOString(),
    reviewNote: "Fictional isolated account, never a live identity verification." }, context(account));
  let destination = await f.service.createDestination({ platformId: "linkedin", accountId: account.id, kind: "profile_feed", name: "Isolated LinkedIn profile",
    locator: { url: account.profileUrl }, visibility: "public" }, context());
  destination = await f.service.updateDestination(destination.id, { status: "active", identityConfirmed: true, policyStatus: "reviewed",
    policyCheckedAt: OPS_NOW.toISOString(), reviewNote: "Isolated test destination." }, context(destination));
  const profile = f.ops.profiles().profiles.find(row => row.platformId === "linkedin");
  await f.ops.createRuleSnapshot({ platformId: "linkedin", destinationId: destination.id, policy: profile.policy,
    sources: [{ url: "https://workbench-fixture.github.io/isolated-policy", title: "Isolated rules fixture", scope: "No live permission asserted." }],
    checkedAt: OPS_NOW.toISOString(), expiresAt: OPS_EXPIRY, reviewed: true, note: "Fictional isolated policy." }, opsContext());
  return { account, destination };
}
function candidate(f, jobId) {
  const row = f.ops.getJob(jobId, opsContext()).candidates[0];
  assert.ok(row, "a real frozen candidate should exist"); return f.ops.getCandidate(row.id, opsContext());
}
function reviewInput(row) { return { packageHash: row.packageHash, qualityReportHashes: row.qualityReportHashes, reviewSnapshotHash: row.reviewSnapshotHash }; }

function fixtureAiDecision({ kind, subjectId, snapshotHash, evidence }) {
  return { schema: "pengmanager.ai-approval/v1", kind, subjectId, snapshotHash, evidenceHash: hashObject(evidence),
    actor: "ai-reviewer", decision: "approve", reviewedAt: OPS_NOW.toISOString(), rationale: "Independent isolated review fixture.",
    modelReceipt: { responseId: "isolated-review-response" } };
}
async function materialize(f, row, ctx = context(row)) { return f.service.materializeCandidate(row.id, reviewInput(row), ctx); }
async function schedule(f, variant) {
  let current = await f.service.transitionVariant(variant.id, { target: "fact_check" }, context(variant));
  await assert.rejects(f.service.transitionVariant(current.id, { target: "approved", reviewed: true, snapshotHash: current.snapshotHash }, context(current)), { code: "EXACT_EDITORIAL_REVIEW_REQUIRED" });
  current = await f.service.transitionVariant(current.id, { target: "approved", reviewed: true, snapshotHash: current.snapshotHash,
    reviewSnapshotHash: current.reviewSnapshotHash }, context(current));
  return f.service.transitionVariant(current.id, { target: "scheduled" }, context(current));
}
function isolatedReceipt(operation, patch = {}) {
  return { url: "https://www.linkedin.com/posts/isolated-unit-test_987654321", publishedAt: OPS_NOW.toISOString(), capturedBy: "isolated operator",
    dataMode: "imported", verificationMethod: "manual_readback", verifiedAt: OPS_NOW.toISOString(), verifiedBy: "isolated reviewer",
    editorialSnapshotHash: operation.editorialSnapshotHash, assetHashes: [], packageHash: operation.packageHash,
    reviewSnapshotHash: operation.reviewSnapshotHash, artifactHashes: operation.editorialSnapshot.publicationPackage.artifactRefs.map(row => ({ artifactId: row.id, sha256: row.sha256 })), ...patch };
}

test("a checked native package materializes once as a draft and preserves every original v2 snapshot", async t => {
  const f = await fixture(t), original = structuredClone(f.store.snapshot().content);
  const { job } = await createOpsJob(f); const finished = await finishTextOpsJob(f, job.id);
  assert.equal(finished.job.status, "ready_for_review"); const row = candidate(f, job.id), ctx = context(row, "materialize-exact-001");
  await assert.rejects(materialize(f, row, { ...ctx, method: "worker" }), { code: "AGENT_SCOPE_DENIED" });
  const created = await materialize(f, row, ctx), after = f.store.snapshot();
  assert.equal(created.snapshotSchema, EDITORIAL_NATIVE_SCHEMA); assert.equal(created.status, "draft"); assert.equal(created.approval, null);
  assert.equal(created.packageHash, row.packageHash); assert.equal(created.reviewSnapshotHash, row.reviewSnapshotHash);
  assert.deepEqual(created.publicationPackage, row.package); assert.deepEqual(after.content.slice(0, original.length), original);
  assert.deepEqual(await materialize(f, row, ctx), created);
  assert.equal((await materialize(f, row, context(f.ops.getCandidate(row.id, opsContext())))).id, created.id);
  assert.equal(f.store.snapshot().draftMaterializations.length, 1);
  const scheduled = await schedule(f, created);
  assert.equal(scheduled.approval.reviewSnapshotHash, row.reviewSnapshotHash);
  await assert.rejects(f.service.createRelease({ contentId: scheduled.id, slug: "isolated-native-text" }, context(scheduled)),
    { code: "ARTICLE_ILLUSTRATION_PLAN_REQUIRED" });
  assert.deepEqual(f.store.snapshot().websiteReleases, []);
});

test("external native operation requires package and report bindings in exact once-only receipt recovery", async t => {
  const f = await fixture(t), { account, destination } = await linkedin(f);
  const { job } = await createOpsJob(f, { targets: [{ destinationId: destination.id, locale: "zh-CN", nativeForm: "article" }] });
  await finishTextOpsJob(f, job.id); const row = candidate(f, job.id), variant = await schedule(f, await materialize(f, row));
  let operation = await f.operations.create({ accountId: account.id, contentId: variant.id, type: "publish", executionMode: "browser", actor: "isolated operator" });
  operation = await f.operations.approve(operation.id, { approvedBy: "isolated owner", authorizationNote: "Authorize only this complete isolated package once." });
  operation = await f.operations.start(operation.id, { actor: "isolated operator" });
  assert.equal(operation.approval.packageHash, row.packageHash); assert.equal(operation.approval.reviewSnapshotHash, row.reviewSnapshotHash);
  const before = f.store.snapshot();
  for (const patch of [{ packageHash: undefined }, { reviewSnapshotHash: undefined }, { packageHash: "0".repeat(64) }, { artifactHashes: undefined }]) {
    await assert.rejects(f.operations.complete(operation.id, { actor: "isolated operator", receipt: isolatedReceipt(operation, patch) }));
    assert.deepEqual(f.store.snapshot(), before);
  }
  const receipt = isolatedReceipt(operation), done = await f.operations.complete(operation.id, { actor: "isolated operator", receipt });
  assert.equal(done.status, "completed"); assert.equal(f.service.getVariant(variant.id).status, "published");
  const finished = f.store.snapshot();
  assert.deepEqual(await f.operations.complete(operation.id, { actor: "isolated operator", receipt }), done);
  assert.deepEqual(f.store.snapshot(), finished); assert.equal(finished.publications.length, 1);
});

test("two language targets share one neutral edition without invalidating the sibling candidate or changing the original mother", async t => {
  const f = await fixture(t), { destination } = await linkedin(f), before = structuredClone(f.store.snapshot().editions);
  const { job } = await createOpsJob(f, { targets: [{ destinationId: "official-site", locale: "en-US", nativeForm: "article" },
    { destinationId: destination.id, locale: "en-US", nativeForm: "article" }] });
  await finishTextOpsJob(f, job.id); const current = f.ops.getJob(job.id, opsContext());
  assert.equal(current.tasks.filter(row => row.kind === "format.transform").length, 1); assert.equal(current.candidates.length, 2);
  const story = structuredClone(f.store.snapshot().stories.find(row => row.id === f.storyId)), variants = [];
  for (const row of current.candidates) variants.push(await materialize(f, f.ops.getCandidate(row.id, opsContext())));
  assert.equal(variants[0].editionId, variants[1].editionId);
  assert.deepEqual(f.store.snapshot().editions.slice(0, before.length), before);
  assert.deepEqual(f.store.snapshot().stories.find(row => row.id === f.storyId), story);
  const neutral = f.store.snapshot().editions.find(row => row.id === variants[0].editionId);
  assert.equal(neutral.snapshotSchema, EDITORIAL_NATIVE_EDITION_SCHEMA); assert.equal(neutral.formatLineage.transformKind, "cross_language");
  await assert.rejects(f.service.createVariant(neutral.id, { destinationId: "official-site" }, context(f.service.getEdition(neutral.id))), { code: "NATIVE_CANDIDATE_REQUIRED" });
});

test("a human-created newer edition is preserved when a previously checked cross-language candidate becomes stale", async t => {
  const f = await fixture(t), { job } = await createOpsJob(f, { targets: [{ destinationId: "official-site", locale: "en-US", nativeForm: "article" }] });
  await finishTextOpsJob(f, job.id); const row = candidate(f, job.id);
  const human = await f.service.createEdition(f.storyId, { locale: "en-US", format: "article", title: "A complete human replacement",
    summary: "Isolated author version.", body: "A complete human version created after the automatic plan was checked.", claimIds: ["C003"], assetRefs: [] }, context(f.service.getStory(f.storyId)));
  await assert.rejects(materialize(f, row), error => ["SOURCE_OUTDATED", "EDITION_FAMILY_CHANGED"].includes(error.code));
  assert.equal(f.service.getEdition(human.id).body, human.body); assert.equal(f.store.snapshot().draftMaterializations.length, 0);
});

test("native source attachments require actual independent coverage and exact bytes again before materialization", async t => {
  const f = await fixture(t), bytes = Buffer.from("# Isolated source\nComplete evidence file, never executed.\n"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const source = await f.artifacts.uploadSource(Readable.from([bytes]), { storyId: f.storyId, role: "transcript", mime: "text/markdown", name: "source.md", size: bytes.length, sha256 }, context(f.service.getStory(f.storyId)));
  const reviewed = await f.artifacts.review(source.id, { sha256, rightsConfirmed: true, privacyConfirmed: true, licenseConfirmed: true,
    note: "Isolated original source file." }, context(source));
  const { job } = await createOpsJob(f, { sourceArtifactIds: [reviewed.id] }); await finishTextOpsJob(f, job.id);
  let row = candidate(f, job.id);
  if (row.status !== "ready_for_review") {
    await f.ops.submitQualityReport(row.id, { checkedPackageHash: row.packageHash, checkContextHash: row.checkContextHash, reviewed: true,
      coverage: { textKeys: qualityTextKeys(row.package), artifactHashes: [sha256], semantic: "checked", artistic: "checked" },
      mediaEvidence: [{ artifactId: source.id, sha256, method: "human_full_read", coverage: "full", note: "Actual isolated fixture bytes were read in full." }],
      assessment: "Independent full text and source review in an isolated test." }, opsContext(row, "independent isolated human"));
    row = f.ops.getCandidate(row.id, opsContext());
  }
  assert.ok(row.package.artifactRefs.some(ref => ref.id === source.id && ref.sha256 === sha256));
  const path = join(f.artifacts.objects, `${source.id}.bin`); await chmod(path, 0o600); await writeFile(path, Buffer.alloc(bytes.length, 65));
  await assert.rejects(materialize(f, row), { code: "ARTIFACT_BYTES_UNAVAILABLE" });
  assert.equal(f.store.snapshot().draftMaterializations.length, 0);
});

test("AI final check binds the actual full attachment and exact source, and a supplied human assertion cannot pass", async t => {
  const f = await fixture(t), bytes = Buffer.from("# Source\nFirst and last actual evidence rows stay present.\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const source = await f.artifacts.uploadSource(Readable.from([bytes]), { storyId: f.storyId, role: "transcript", mime: "text/markdown",
    name: "independent-ai-source.md", size: bytes.length, sha256 }, context(f.service.getStory(f.storyId)));
  await f.artifacts.review(source.id, { sha256, rightsConfirmed: true, privacyConfirmed: true, licenseConfirmed: true,
    note: "Isolated owner-authored attachment rights fixture." }, context(source));
  const { job } = await createOpsJob(f, { sourceArtifactIds: [source.id] });
  await finishTextOpsJob(f, job.id);
  const row = candidate(f, job.id), calls = [];
  f.ops.aiApproval = { async review(request) {
    calls.push(request);
    if (calls.length === 1) throw new ApiError(409, "AI_APPROVAL_PENDING", "Isolated proof pending");
    return fixtureAiDecision(request);
  } };
  const request = { checkedPackageHash: row.packageHash, checkContextHash: row.checkContextHash }, ctx = opsContext(row);
  await assert.rejects(f.ops.submitQualityReport(row.id, { ...request, reviewed: true }, ctx));
  await assert.rejects(f.ops.submitQualityReport(row.id, request, { ...ctx, ifMatch: '"stale"' }), { code: "PRECONDITION_FAILED" });
  assert.equal(calls.length, 0);
  await assert.rejects(f.ops.submitQualityReport(row.id, request, ctx), { code: "AI_APPROVAL_PENDING" });
  const report = await f.ops.submitQualityReport(row.id, request, ctx);
  assert.deepEqual(await f.ops.submitQualityReport(row.id, request, ctx), report);
  assert.equal(report.status, "passed");
  assert.equal(report.execution.subject, "ai-reviewer");
  assert.equal(report.mediaEvidence.find(item => item.artifactId === source.id).method, "ai_full_text");
  assert.equal(calls[1].evidence.inputFiles.find(item => item.id === source.id).fullText, bytes.toString());
  assert.equal(calls[1].evidence.sourceEditions[0].id, f.editionId);
  assert.equal((await materialize(f, candidate(f, job.id))).status, "draft");
});

test("AI validates official pricing evidence before preserving the operator's exact budget authorization", async t => {
  const f = await fixture(t), calls = [];
  f.ops.aiApproval = { async review(request) { calls.push(request); return fixtureAiDecision(request); } };
  const keys = ["maxCalls", "maxInputTokens", "maxOutputTokens", "maxPerCallInputTokens", "maxPerCallOutputTokens", "maxInFlight",
    "maxCostMicros", "maxRenderSeconds", "maxTempBytes", "maxNativeProcesses", "currency", "deadlineAt"];
  const input = { ...Object.fromEntries(keys.map(key => [key, f.budget[key]])), name: "Isolated official pricing candidate", pricingSnapshot: FIXTURE_PRICING };
  const ctx = opsContext(null, "exact budget owner");
  await assert.rejects(f.ops.createBudget(input, ctx));
  assert.equal(calls.length, 0);
  const { reviewed, ...pricingSnapshot } = { ...FIXTURE_PRICING, sourceExcerpt: "Isolated price fixture for $1 per million input or output tokens, reasoning included in output and no per-request charge." };
  const request = { ...input, pricingSnapshot };
  const budget = await f.ops.createBudget(request, ctx), state = f.store.snapshot();
  assert.deepEqual(await f.ops.createBudget(request, ctx), budget);
  assert.equal(budget.authorizedBy, ctx.actor);
  assert.equal(budget.maxCostMicros, input.maxCostMicros);
  const stored = state.modelPricingSnapshots.find(row => row.hash === budget.pricingSnapshotHash);
  assert.equal(stored.reviewedBy, "ai-reviewer");
  assert.equal(stored.aiApproval.snapshotHash, hashObject(pricingSnapshot));
  assert.equal(calls.length, 1);
});

test("a newer legitimate rule snapshot invalidates a checked native draft before approval", async t => {
  const f = await fixture(t), { job } = await createOpsJob(f); await finishTextOpsJob(f, job.id);
  const row = candidate(f, job.id), variant = await materialize(f, row);
  const current = await f.service.transitionVariant(variant.id, { target: "fact_check" }, context(variant));
  const rule = f.store.snapshot().ruleSnapshots.find(value => value.destinationId === "official-site");
  await f.ops.createRuleSnapshot({ platformId: rule.platformId, destinationId: rule.destinationId, policy: rule.policy, sources: rule.sources,
    checkedAt: rule.checkedAt, expiresAt: rule.expiresAt, reviewed: true, note: "A new isolated administrator rule review." }, opsContext());
  await assert.rejects(f.service.transitionVariant(current.id, { target: "approved", reviewed: true, snapshotHash: current.snapshotHash,
    reviewSnapshotHash: current.reviewSnapshotHash }, context(current)), { code: "RULES_CHANGED" });
  assert.equal(f.service.getVariant(variant.id).status, "fact_check");
});

test("native historical-result reconciliation retains original approval, package and reports despite present account drift", async t => {
  const f = await fixture(t), { account, destination } = await linkedin(f);
  const { job } = await createOpsJob(f, { targets: [{ destinationId: destination.id, locale: "zh-CN", nativeForm: "article" }] });
  await finishTextOpsJob(f, job.id); const row = candidate(f, job.id), variant = await schedule(f, await materialize(f, row));
  let operation = await f.operations.create({ accountId: account.id, contentId: variant.id, type: "publish", executionMode: "browser", actor: "isolated operator" });
  operation = await f.operations.approve(operation.id, { approvedBy: "isolated owner", authorizationNote: "Isolated exact original authorization." });
  operation = await f.operations.start(operation.id, { actor: "isolated operator" });
  await f.store.mutate({ type: "fixture.legacy_account_drift" }, state => { state.accounts.find(value => value.id === account.id).policyStatus = "manual_review_required"; });
  await assert.rejects(f.operations.complete(operation.id, { actor: "isolated operator", receipt: isolatedReceipt(operation) }));
  const ctx = context(f.operations.list().find(value => value.id === operation.id), "native-reconcile-001");
  const input = { approvedSnapshotHash: operation.editorialSnapshotHash, accountConfirmed: true, contentConfirmed: true,
    receipt: isolatedReceipt(operation), reason: "Recover the existing isolated result without repeating an external action." };
  const done = await f.operations.reconcile(operation.id, input, ctx), after = f.store.snapshot();
  assert.equal(done.status, "completed"); assert.deepEqual(done.editorialSnapshot, operation.editorialSnapshot); assert.deepEqual(done.approval, operation.approval);
  assert.equal(after.publications[0].packageHash, row.packageHash); assert.equal(after.publications[0].reviewSnapshotHash, row.reviewSnapshotHash);
  assert.deepEqual(await f.operations.reconcile(operation.id, input, ctx), done); assert.deepEqual(f.store.snapshot(), after);
});

async function illustratedNativeMother(f, { baseReleaseId } = {}) {
  const mother = f.service.getEdition(f.editionId);
  const article = { locale: mother.locale, format: mother.format, title: mother.title, summary: mother.summary, body: mother.body, blocks: mother.blocks, claimIds: mother.claimIds };
  let story = f.service.getStory(f.storyId);
  let plan = await f.service.createArticleIllustrations(story.id, {
    locale: article.locale, title: article.title, summary: article.summary, body: article.body,
    articleType: "technical", slots: fixtureIllustrationSlots(article.blocks), ...(baseReleaseId ? { baseReleaseId } : {}),
  }, context(story));
  const signed = await registerFixtureIllustrator(f.service, context), sourceArtifactIds = [];
  for (const [index, slot] of plan.slots.entries()) {
    const bytes = await syntheticIllustrationPng(index + 1);
    const source = await uploadOpsSource(f, { role: "source_image", mime: "image/png", bytes, name: `isolated-source-${index}.png` });
    sourceArtifactIds.push(source.id);
    const imported = await f.artifacts.importMedia(source.id, { sha256: source.sha256 }, context(source), f.mediaAssets);
    const asset = await f.mediaAssets.review(imported.id, { sha256: imported.sha256, rightsConfirmed: true, privacyConfirmed: true,
      rightsNote: "Actual isolated fixture bytes have been reviewed for test purposes." }, context(imported));
    const proof = slot.kind === "scene" ? fixtureIllustrationProof("pengmanager-designer-compositor", plan, slot, asset, signed) : undefined;
    plan = await f.service.bindArticleIllustration(story.id, plan.id, { slotId: slot.id, assetId: asset.id, sha256: asset.sha256,
      ...(proof ? { designerCompositor: proof } : {}) }, context(plan));
  }
  story = f.service.getStory(story.id);
  const edition = await f.service.createEdition(story.id, { ...article, ...placeArticleIllustrations(plan, article),
    illustrationPlanId: plan.id, supersedesEditionId: mother.id }, context(story));
  f.editionId = edition.id;
  const taskData = lease => lease.task.kind === "text.polish"
    ? { ...isolatedTaskData(lease), title: article.title, summary: article.summary, body: article.body, blocks: article.blocks }
    : isolatedTaskData(lease);
  return { edition, plan, sourceArtifactIds, taskData };
}

test("an illustrated mother needs every linked image explicitly in the native work order", async t => {
  const f = await fixture(t), prepared = await illustratedNativeMother(f);
  const { job } = await createOpsJob(f, { sourceArtifactIds: prepared.sourceArtifactIds.slice(0, -1) });
  const finished = await finishTextOpsJob(f, job.id, { taskData: prepared.taskData });
  assert.equal(finished.job.status, "needs_input");
  assert.equal(finished.job.candidates.length, 0);
  assert.ok(finished.job.targets[0].gaps.some(gap => gap.code === "ARTIFACT_MISSING"));
});

test("a fully checked native candidate cannot materialize from an original-copy edition restricted to the official route", async t => {
  const f = await fixture(t), { origin } = new URL(f.service.publicOrigin);
  const existing = f.store.snapshot().content.find(row => row.editionId === f.editionId);
  const variant = await scheduleVariant(f, f.service.getVariant(existing.id));
  const { locale, format, title, summary, body, blocks, assetRefs, claimIds, claimBindings } = variant;
  const releaseId = "REL-00990", slug = "isolated-original-copy", canonicalPath = `/zh/articles/${slug}`;
  const publicSnapshot = { locale, format, title, summary, body, blocks, assetRefs, claimIds, claimBindings,
    canonicalPath, canonicalUrl: `${origin}${canonicalPath}` };
  const snapshotHash = hashObject(publicSnapshot), at = f.clock().toISOString();
  await f.store.mutate({ type: "fixture.pre_illustrations_release", actor: "fixture" }, state => {
    state.websiteReleases.push({ id: releaseId, siteId: "official-site", storyId: f.storyId, editionId: f.editionId,
      contentId: variant.id, locale, format, slug, canonicalPath, publicSnapshot, snapshotHash,
      contentSnapshotHash: variant.snapshotHash, status: "live_unverified", revision: 1, previousReleaseId: null,
      publicApproval: { snapshotHash, approvedAt: at, approvedBy: "fixture", reviewed: true },
      activationAt: at, receipt: null, withdrawal: null, createdAt: at, updatedAt: at });
    state.websiteRoutes.push({ id: "RTE-00990", siteId: "official-site", storyId: f.storyId, locale, format,
      slug, canonicalPath, activeReleaseId: releaseId, revision: 1, createdAt: at, updatedAt: at });
  });
  const base = await f.service.verifyRelease(releaseId, { confirm: true }, context(f.service.getRelease(releaseId)));
  assert.equal(base.status, "published");
  f.service = new EditorialService({ ...f.service, illustrationCohort: [{ storyId: f.storyId, releaseId, canonicalPath, snapshotHash }] });
  const source = await illustratedNativeMother(f, { baseReleaseId: releaseId });
  const { job } = await createOpsJob(f, { sourceArtifactIds: source.sourceArtifactIds });
  await finishTextOpsJob(f, job.id, { taskData: source.taskData });
  let row = candidate(f, job.id);
  const quality = { checkedPackageHash: row.packageHash, checkContextHash: row.checkContextHash, reviewed: true,
    coverage: { textKeys: qualityTextKeys(row.package), artifactHashes: row.requiredCoverage.artifactHashes, semantic: "checked", artistic: "checked" },
    mediaEvidence: row.package.artifactRefs.map(artifact => ({ artifactId: artifact.id, sha256: artifact.sha256,
      method: "human_full_read", coverage: "full", note: "Actual synthetic image evidence inspected in the isolated fixture." })),
    assessment: "Independent isolated verification of the complete checked package." };
  await f.ops.submitQualityReport(row.id, quality, opsContext(row, "independent isolated human"));
  row = candidate(f, job.id);
  assert.equal(row.status, "ready_for_review");
  assert.equal(row.package.sourceEditionRefs[0].id, source.edition.id);
  const before = f.store.snapshot();
  await assert.rejects(materialize(f, row), { code: "ARTICLE_AUGMENTATION_OVERRIDES_FORBIDDEN" });
  assert.deepEqual(f.store.snapshot(), before);
});

test("illustrated native website publication covers actual source media before separate public approval and a full v3 backup", async t => {
  const f = await fixture(t), prepared = await illustratedNativeMother(f);
  const { job } = await createOpsJob(f, { sourceArtifactIds: prepared.sourceArtifactIds });
  await finishTextOpsJob(f, job.id, { taskData: prepared.taskData });
  let row = candidate(f, job.id);
  assert.equal(row.status, "needs_input", "a text checker cannot confirm image coverage");
  assert.deepEqual(row.package.orderedMediaRefs, prepared.edition.assetRefs);
  assert.deepEqual(row.package.orderedBlocks, prepared.edition.blocks);
  assert.equal(row.requiredCoverage.artifactHashes.length, 3);
  const quality = { checkedPackageHash: row.packageHash, checkContextHash: row.checkContextHash, reviewed: true,
    coverage: { textKeys: qualityTextKeys(row.package), artifactHashes: row.requiredCoverage.artifactHashes, semantic: "checked", artistic: "checked" },
    mediaEvidence: row.package.artifactRefs.map(artifact => ({ artifactId: artifact.id, sha256: artifact.sha256,
      method: "human_full_read", coverage: "full", note: "Actual synthetic image evidence was inspected in the isolated fixture." })),
    assessment: "Independent isolated test of exact text and the three actual reviewed image artifacts." };
  await assert.rejects(f.ops.submitQualityReport(row.id, { ...quality, mediaEvidence: [] }, opsContext(row, "independent isolated human")),
    { code: "QUALITY_RECHECK_REQUIRED" });
  await f.ops.submitQualityReport(row.id, quality, opsContext(row, "independent isolated human"));
  row = candidate(f, job.id);
  assert.equal(row.status, "ready_for_review");
  const variant = await schedule(f, await materialize(f, row));
  assert.equal(variant.editionId, prepared.edition.id);
  f.service.mediaAssets = f.mediaAssets;
  f.service.beforeActivation = createEditorialBackup({ store: f.store, mediaAssets: f.mediaAssets, productionArtifacts: f.artifacts, clock: f.clock });
  let release = await f.service.createRelease({ contentId: variant.id, slug: "isolated-native-publication" }, context(variant));
  assert.equal(release.status, "draft"); assert.equal(release.publicApproval, null);
  assert.equal(release.illustrationPlanHash, prepared.edition.illustrationPlanHash);
  assert.equal(release.publicSnapshot.assetRefs.length, 3);
  assert.equal(release.publicSnapshot.nativePackageHash, row.packageHash); assert.equal(release.publicSnapshot.reviewSnapshotHash, row.reviewSnapshotHash);
  await assert.rejects(f.service.publishRelease(release.id, { confirm: true, expectedPreviousReleaseId: null }, context(release)), { code: "INVALID_RELEASE_TRANSITION" });
  release = await f.service.approveRelease(release.id, { reviewed: true, snapshotHash: release.snapshotHash,
    authorizationNote: "Separate exact public snapshot approval in an isolated test." }, context(release));
  const activated = await f.service.publishRelease(release.id, { confirm: true, expectedPreviousReleaseId: null }, context(release));
  assert.equal(activated.status, "live_unverified"); assert.equal(f.store.snapshot().websiteRoutes.length, 1);
  const published = await f.service.verifyRelease(activated.id, { confirm: true }, context(activated));
  assert.equal(published.status, "published");
  assert.equal(published.activationBackup.createdAt, f.clock().toISOString());
  const backup = await verifyEditorialBackup({ store: f.store, backupId: published.activationBackup.backupId,
    expectedManifestSha256: published.activationBackup.manifestSha256 });
  assert.equal(backup.schema, "pengmanager.editorial-backup/v2");
  assert.equal(backup.assetCount, 3);
  assert.equal(backup.artifactCount, 3);
  const manifest = JSON.parse(await readFile(join(f.directory, "backups", "editorial", backup.backupId, "manifest.json"), "utf8"));
  assert.equal(manifest.sourceSchemaVersion, 3);
});

test("full v3 isolated restore preserves completed candidate history, exact source bytes and an actual unresolved dispatch", async t => {
  const f = await fixture(t), first = await createOpsJob(f);
  await finishTextOpsJob(f, first.job.id);
  const ready = candidate(f, first.job.id), variant = await materialize(f, ready);
  const sourceBytes = Buffer.from("# Whole restore fixture\n\nThese complete private source bytes must survive recovery.\n");
  const source = await uploadOpsSource(f, { role: "transcript", mime: "text/markdown", bytes: sourceBytes, name: "restore-source.md" });
  const second = await createOpsJob(f, { sourceArtifactIds: [source.id] });
  const writer = await pairOpsWorker(f, [second.job.id]), lease = await claimOpsTask(f, writer);
  assert.equal(lease.task.kind, "strategy.plan");
  const permit = await f.ops.dispatchTask(lease.task.taskId, { ...leaseIdentity(lease), callKey: "restore-unresolved.1",
    requestHash: hashObject({ purpose: "isolated unresolved dispatch backup" }), provider: FIXTURE_PRICING.provider,
    model: FIXTURE_PRICING.model, pricingSnapshotHash: f.budget.pricingSnapshotHash,
    upperBound: { inputTokens: 100, outputTokens: 100, renderSeconds: 0, tempBytes: 0, nativeProcesses: 0 } }, writer.ctx());
  await f.ops.unknownCall(permit.reservationId, { attemptId: lease.attemptId,
    reason: "Isolated fixture has no provider response; preserve the original reservation.", providerRequestId: null }, writer.ctx());
  const before = f.store.snapshot();
  assert.equal(before.nativeCandidatePackages.find(row => row.id === ready.id).packageHash, ready.packageHash);
  assert.equal(before.content.find(row => row.id === variant.id).status, "draft");
  assert.ok(before.productionTaskAttempts.some(row => row.status === "succeeded"));
  assert.ok(before.contentQualityReports.length > 0); assert.equal(before.operatorProfiles.length, 28);
  const unknown = before.modelBudgetReservations.find(row => row.id === permit.reservationId);
  assert.equal(unknown.status, "unknown_usage"); assert.equal(unknown.actual.costMicros, null);
  assert.ok(unknown.reserved.costMicros > 0);
  const backup = await f.backup.captureCurrent(), target = `${f.directory}-complete-v3-restore`;
  t.after(() => rm(target, { recursive: true, force: true }));
  const restored = await restoreEditorialBackupToIsolatedDirectory({ store: f.store, backupId: backup.backupId,
    expectedManifestSha256: backup.manifestSha256, targetDirectory: target });
  assert.equal(restored.restored, true); assert.equal(restored.artifactCount, 1);
  assert.deepEqual(JSON.parse(await readFile(join(target, "state.json"), "utf8")), before);
  assert.deepEqual(await readFile(join(target, "worker-artifacts", "objects", `${source.id}.bin`)), sourceBytes);
  const reopened = new JsonStore({ filePath: join(target, "state.json") });
  await reopened.open(() => { throw new Error("Restored state must exist; seeding would conceal a failed restore."); });
  try { assert.deepEqual(reopened.snapshot(), before); }
  finally { await reopened.close(); }
  assert.deepEqual(f.store.snapshot(), before);
});
