import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { ApiError } from "../src/domain/errors.mjs";
import { hashObject, hashText } from "../src/domain/hash.mjs";
import { createGeoOsServer } from "../src/http/server.mjs";
import { PersonalGeoEngine } from "../src/engines/geo-evidence.mjs";
import { createAdminAuth, hashAdminPassword, hashAgentToken } from "../src/security/admin-auth.mjs";
import { ROOT, clock, context, editorialFixture } from "./editorial-fixtures.mjs";

function decisionFixture() {
  const calls = [];
  let answered = false;
  return {
    calls,
    ready() { answered = true; },
    async review(input) {
      calls.push(input);
      assert.equal(input.snapshotHash, hashObject(input.evidence));
      if (!answered) throw new ApiError(409, "AI_APPROVAL_PENDING", "Isolated reviewer still working.");
      return { actor: "ai-reviewer", kind: input.kind, snapshotHash: input.snapshotHash, id: "isolated-fixture" };
    },
  };
}

async function httpFixture(t, fixture, aiApproval) {
  const password = "isolated-unit-test-password";
  const token = randomBytes(32).toString("base64url");
  const auth = createAdminAuth({ env: { ADMIN_PASSWORD_HASH: await hashAdminPassword(password), ADMIN_AGENT_TOKEN_HASH: hashAgentToken(token) } });
  const server = createGeoOsServer({ service: fixture.geoService, editorial: fixture.service, accountOperations: fixture.operations,
    geoEngine: fixture.geoEngine, publicDir: join(ROOT, "public"), auth, aiApproval });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(done => { server.close(done); server.closeIdleConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  return async (path, body, { method = "POST", access = "admin", etag, key } = {}) => {
    const response = await fetch(origin + path, { method, headers: {
      "content-type": "application/json", origin,
      ...(access === "admin" ? { cookie } : access === "agent" ? { authorization: `Bearer ${token}` } : {}),
      ...(etag ? { "if-match": etag } : {}), ...(key ? { "idempotency-key": key } : {}),
    }, body: JSON.stringify(body) });
    return { status: response.status, payload: await response.json() };
  };
}

test("AI claim and legacy approval require the real admin entry and persist the AI actor", async t => {
  const fixture = await editorialFixture(t); const reviewer = decisionFixture();
  const call = await httpFixture(t, fixture, reviewer);
  const claim = { publicLevel: "private", approvedBy: "caller-supplied actor", sourceExcerpt: "Fixture-only excerpt." };
  for (const [access, status] of [["anonymous", 401], ["agent", 403]]) {
    assert.equal((await call("/api/claims/C003/approve", claim, { access })).status, status);
  }
  assert.equal(reviewer.calls.length, 0);
  const revision = fixture.store.snapshot().revision;
  const pending = await call("/api/claims/C003/approve", claim);
  assert.equal(pending.payload.error.code, "AI_APPROVAL_PENDING");
  assert.equal(fixture.store.snapshot().revision, revision);
  reviewer.ready();
  const approved = await call("/api/claims/C003/approve", claim);
  assert.equal(approved.status, 200, JSON.stringify(approved.payload));
  assert.equal(approved.payload.approvedBy, "ai-reviewer");
  assert.equal(reviewer.calls[0].snapshotHash, reviewer.calls[1].snapshotHash);
  assert.equal(reviewer.calls[0].evidence.sourceExcerpt, claim.sourceExcerpt);
  assert.deepEqual(await call("/api/claims/C003/approve", claim), approved);
  assert.equal(reviewer.calls.length, 2);
  const content = await fixture.geoService.createContent({ title: "测试稿", body: "完整的观点稿。",
    contentType: "opinion", claimIds: [], platforms: ["GitHub"] });
  const route = `/api/content/${content.id}/transition`;
  assert.equal((await call(route, { target: "fact_check" })).status, 200);
  const final = await call(route, { target: "approved", actor: "spoofed", approvedBy: "spoofed" });
  assert.equal(final.status, 200, JSON.stringify(final.payload));
  assert.equal(final.payload.approval.approvedBy, "ai-reviewer");
  assert.equal(final.payload.approval.aiReview.kind, "legacy_content");
  assert.deepEqual(await call(route, { target: "approved" }), final);
  assert.equal(reviewer.calls.length, 3);
  assert.equal((await call(route, { target: "published" })).payload.error.code, "PUBLICATION_RECEIPT_REQUIRED");
});

test("a signed public source excerpt is retained for private editorial review and never exported", async t => {
  const fixture = await editorialFixture(t);
  const calls = [];
  const aiApproval = { async review(input) {
    calls.push(input);
    return { actor: "ai-reviewer", kind: input.kind, decision: "approve", snapshotHash: input.snapshotHash,
      evidenceHash: hashObject(input.evidence), reviewedAt: new Date().toISOString() };
  } };
  const call = await httpFixture(t, fixture, aiApproval);
  await fixture.geoService.approveClaim("C003", { approvedBy: "isolated unit reviewer", publicLevel: "approved_public" });
  const request = { publicLevel: "approved_public", sourceExcerpt: "Authorized exact source text from the isolated official document." };
  const path = "/api/claims/C003/approve";
  assert.equal((await call(path, request, { access: "agent" })).status, 403);
  const approved = await call(path, request);
  assert.equal(approved.status, 200, JSON.stringify(approved.payload));
  assert.deepEqual(await call(path, request), approved);
  assert.equal(calls.length, 1);
  const retained = fixture.store.snapshot().editorialClaimSourceExcerpts;
  assert.equal(retained.length, 1);
  assert.equal(retained[0].excerpt, request.sourceExcerpt);
  assert.equal(retained[0].sha256, hashText(request.sourceExcerpt));
  assert.equal(retained[0].reviewHash, approved.payload.aiReview.evidenceHash);
  assert.equal(JSON.stringify(approved.payload).includes(request.sourceExcerpt), false);
  const bootstrap = await call("/api/bootstrap", undefined, { access: "agent", method: "GET" });
  assert.equal(bootstrap.status, 200);
  assert.equal(JSON.stringify(bootstrap.payload).includes(request.sourceExcerpt), false);
  assert.equal(JSON.stringify(fixture.geoService.publicPreview()).includes(request.sourceExcerpt), false);
});

test("account and destination review use exact ETags and same-request replay avoids a new review", async t => {
  const fixture = await editorialFixture(t); const reviewer = decisionFixture();
  const call = await httpFixture(t, fixture, reviewer);
  const account = fixture.service.getAccount("github");
  const body = { profileUrl: "https://github.com/nodejs", identityConfirmed: true, policyStatus: "reviewed", policyCheckedAt: clock().toISOString(),
    reviewNote: "Isolated identity and policy evidence for the exact existing account." };
  const options = { method: "PATCH", etag: account.etag, key: "same-operations-account-review" };
  assert.equal((await call("/api/accounts/github", body, { ...options, etag: "old" })).status, 412);
  assert.equal(reviewer.calls.length, 0);
  assert.equal((await call("/api/accounts/github", body, options)).payload.error.code, "AI_APPROVAL_PENDING");
  reviewer.ready();
  const checked = await call("/api/accounts/github", body, options);
  assert.equal(checked.status, 200, JSON.stringify(checked.payload));
  assert.equal(checked.payload.policyReviewedBy, "ai-reviewer");
  assert.equal(checked.payload.identityReview.reviewedBy, "ai-reviewer");
  assert.deepEqual(await call("/api/accounts/github", body, options), checked);
  assert.equal(reviewer.calls.length, 2);
  const target = fixture.service.getDestination("official-site");
  const { profileUrl: _accountUrl, ...targetReview } = body;
  const destination = await call("/api/destinations/official-site", { ...targetReview, status: "active", visibility: "public" },
    { method: "PATCH", etag: target.etag, key: "isolated-destination-review" });
  assert.equal(destination.status, 200, JSON.stringify(destination.payload));
  assert.equal(destination.payload.policyAiReview.kind, "destination_identity_policy");
  assert.equal(reviewer.calls.at(-1).evidence.locator.origin, "https://workbench.example.net");
});

test("outbound review separates authenticated one-time permission from model decision and blocks disallowed replies", async t => {
  const fixture = await editorialFixture(t); const reviewer = decisionFixture();
  const account = fixture.service.getAccount("github");
  await fixture.service.updateAccount("github", { profileUrl: "https://github.com/nodejs", status: "active", identityConfirmed: true, policyStatus: "reviewed",
    policyCheckedAt: clock().toISOString(), reviewNote: "Isolated fixture owner observed account mapping." }, context(account));
  const reply = { accountId: "github", type: "reply", targetUrl: "https://github.com/nodejs/node/issues/1",
    replyText: "讨论中建议保留原始测试证据。", actor: "isolated operator" };
  const call = await httpFixture(t, fixture, reviewer);
  const classified = await call("/api/interactions/classify", { text: "证据应该如何核对？" });
  assert.equal(classified.payload.action, "draft_then_ai_review");
  assert.equal(classified.payload.requiresHuman, false);
  assert.equal(classified.payload.requiresAiReview, true);
  const riskyClassification = await call("/api/interactions/classify", { text: "这是法律纠纷和退款承诺。" });
  assert.equal(riskyClassification.payload.action, "human_only");
  const { payload: draft, status: created } = await call("/api/operations", reply);
  assert.equal(created, 201);
  assert.equal(draft.classification.action, "draft_then_ai_review");
  const route = `/api/operations/${draft.id}`;
  assert.equal((await call(route + "/start", {})).payload.error.code, "INVALID_OPERATION_TRANSITION");
  assert.equal((await call(route + "/approve", { authorizationNote: "确切一次操作。", approvedBy: "spoofed" })).payload.error.code, "AI_APPROVAL_PENDING");
  reviewer.ready();
  const approved = await call(route + "/approve", { authorizationNote: "确切一次操作。", approvedBy: "spoofed" });
  assert.equal(approved.status, 200, JSON.stringify(approved.payload));
  assert.equal(approved.payload.approval.approvedBy, "ai-reviewer");
  assert.equal(approved.payload.approval.authorizedBy, "PengManager");
  assert.equal(approved.payload.approval.aiReview.kind, "outbound_operation");
  assert.equal(approved.payload.execution, null);
  assert.equal(approved.payload.receipt, null);
  assert.deepEqual(await call(route + "/approve", { authorizationNote: "确切一次操作。" }), approved);
  const risky = await fixture.operations.create({ ...reply, replyText: "这是一条法律纠纷与退款回复。" });
  const response = await call(`/api/operations/${risky.id}/approve`, { authorizationNote: "真实范围说明。" });
  assert.equal(response.payload.error.code, "HUMAN_ONLY_INTERACTION");
  assert.equal(reviewer.calls.length, 2);
  assert.deepEqual(fixture.store.snapshot().publications, []);
});

test("a source change during AI review prevents stale claim approval without locking other writers", async t => {
  const fixture = await editorialFixture(t);
  let wake, accepted;
  const entered = new Promise(resolve => { wake = resolve; });
  const decision = new Promise(resolve => { accepted = resolve; });
  const aiApproval = { async review() { wake(); return decision; } };
  const pending = fixture.geoService.approveClaim("C003", { publicLevel: "private" }, { actor: "operator", aiApproval });
  await entered;
  await fixture.store.mutate({ type: "fixture.source_corrected", actor: "test", payload: {} }, state => {
    state.claims.find(row => row.id === "C003").text = "隔离测试变更后的证据。";
  });
  accepted({ actor: "ai-reviewer", id: "isolated-fixture" });
  await assert.rejects(pending, { code: "AI_APPROVAL_SNAPSHOT_CHANGED" });
  assert.equal(fixture.store.snapshot().events.at(-1).type, "fixture.source_corrected");
});

test("embedded GEO review binds actual SQLite draft bytes, keeps exact replay, and exposes no external publishing route", async t => {
  const fixture = await editorialFixture(t); const reviewer = decisionFixture();
  const engine = new PersonalGeoEngine({ rootDir: fixture.directory, aiApproval: reviewer });
  t.after(() => engine.close());
  const query = engine.listQueries({ limit: 1 })[0];
  const articleId = engine.store.createArticle({ topicId: "fixture-topic", title: "完整 GEO 草稿",
    slug: "isolated-article", markdown: "# 完整 GEO 草稿\n\n这份稿件只供隔离验证。", queryIds: [query.id], dataMode: "draft" });
  const runId = engine.store.createRun({ provider: "isolated-import", dataMode: "imported", platform: "isolated", requestedLimit: 1, plannedSamples: 1 });
  const sample = { runId, query, platform: "isolated", provider: "isolated-import", prompt: query.text,
    answer: "用于隔离验证样本读取路径的文本。", citations: [], status: "success" };
  const sampleId = engine.store.insertSample({ ...sample, dataMode: "imported" });
  const simulatedId = engine.store.insertSample({ ...sample, dataMode: "fixture" });
  fixture.geoEngine = engine;
  const call = await httpFixture(t, fixture, reviewer);
  const article = engine.store.getArticle(articleId);
  const path = `/api/geo/engine/articles/${articleId}/review`;
  assert.equal((await call(path, { contentHash: article.evidence_hash }, { access: "agent" })).status, 403);
  assert.equal((await call(path, { contentHash: "e".repeat(64) })).status, 412);
  assert.equal((await call(path, { contentHash: article.evidence_hash, sampleIds: ["unavailable"] })).payload.error.code, "GEO_ARTICLE_SAMPLE_INVALID");
  assert.equal((await call(path, { contentHash: article.evidence_hash, sampleIds: [simulatedId] })).payload.error.code, "GEO_ARTICLE_SAMPLE_INVALID");
  assert.equal(reviewer.calls.length, 0);
  const input = { contentHash: article.evidence_hash, sampleIds: [sampleId] };
  assert.equal((await call(path, input)).payload.error.code, "AI_APPROVAL_PENDING");
  assert.equal(engine.listArticles()[0].editorialReview, undefined);
  reviewer.ready();
  const accepted = await call(path, input);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.payload));
  assert.equal(accepted.payload.status, "reviewed_for_editorial");
  assert.equal(reviewer.calls.at(-1).evidence.article.body, article.markdown);
  assert.equal(reviewer.calls.at(-1).evidence.samples[0].answer, sample.answer);
  assert.deepEqual(await call(path, input), accepted);
  assert.equal(reviewer.calls.length, 2);
  assert.equal(engine.listArticles()[0].status, "draft");
  assert.deepEqual(engine.listArticles()[0].editorialReview, accepted.payload);
  engine.store.updateSampleAnalysis(sampleId, { analysis: { evidenceHash: "b".repeat(64) }, citations: [{ url: "https://example.com/changed" }] });
  assert.equal(engine.listArticles()[0].editorialReview, undefined);
  assert.equal((await call("/api/geo/engine/publish", { articleId })).status, 404);
  assert.deepEqual(engine.store.listPublications(), []);
});

test("external result AI review keeps original consent, readback and durable reconciliation retry", async t => {
  const fixture = await editorialFixture(t); const reviewer = decisionFixture();
  const account = fixture.service.getAccount("github");
  await fixture.service.updateAccount("github", { profileUrl: "https://github.com/nodejs", status: "active",
    identityConfirmed: true, policyStatus: "reviewed", policyCheckedAt: clock().toISOString(),
    reviewNote: "Isolated fixture account." }, context(account));
  const row = await fixture.operations.create({ accountId: "github", type: "reply", replyText: "测试外部记录。",
    targetUrl: "https://github.com/nodejs/node/issues/1", actor: "fixture recorder" });
  await fixture.operations.approve(row.id, { approvedBy: "fixture approver", authorizationNote: "仅允许隔离测试动作。" });
  await fixture.operations.start(row.id, { actor: "fixture executor" });
  const { etag } = fixture.operations.list()[0];
  const call = await httpFixture(t, fixture, reviewer);
  const path = `/api/operations/${row.id}/reconcile`;
  const input = { approvedSnapshotHash: row.contentHash, accountConfirmed: true, contentConfirmed: true,
    reason: "隔离验证历史调和。", receipt: { url: "https://github.com/nodejs/node/issues/1#issuecomment-40",
      publishedAt: clock().toISOString(), verifiedAt: clock().toISOString(), dataMode: "imported",
      capturedBy: "fixture recorder", verifiedBy: "fixture verifier", verificationMethod: "browser_readback" } };
  const request = { etag, key: "isolated-reconciliation" };
  assert.equal((await call(path, { ...input, approvedSnapshotHash: "a".repeat(64) }, request)).payload.error.code, "RECONCILIATION_SNAPSHOT_MISMATCH");
  assert.equal(reviewer.calls.length, 0);
  assert.equal((await call(path, input, request)).payload.error.code, "AI_APPROVAL_PENDING");
  assert.equal(fixture.operations.list()[0].status, "in_progress");
  reviewer.ready();
  const completed = await call(path, input, request);
  assert.equal(completed.status, 200, JSON.stringify(completed.payload));
  assert.equal(completed.payload.approval.approvedBy, "fixture approver");
  assert.equal(completed.payload.receipt.verifiedBy, "fixture verifier");
  assert.equal(fixture.operations.list()[0].reconciliation.aiReview.kind, "external_result_reconciliation");
  assert.deepEqual(await call(path, input, request), completed);
  assert.equal(reviewer.calls.length, 2);
});
