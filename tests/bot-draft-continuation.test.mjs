import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBotCore } from "../src/bot/core.mjs";
import { DRAFT_CONTINUATION_ACTION, truncatedNativeRevision } from "../src/bot/draft-continuation.mjs";
import { openIntentJournal, privateDirectory, readRecord } from "../src/bot/files.mjs";
import { createMeter } from "../src/bot/meter.mjs";
import { DeepSeekAdapter } from "../src/adapters/deepseek.mjs";

const owner = { workspaceId: "fixture", projectId: "continuation", actorId: "owner", role: "owner" };
const worker = { ...owner, role: "worker", actorId: "writer" };
const jobId = "CDJ-" + "a".repeat(20);
const sourceSha256 = "b".repeat(64);
const scopeStepId = "scope-receipt";
const errorCode = "MODEL_OUTPUT_TRUNCATED";
const endpoint = "https://model.example.test";

async function fixture(t, { ending = "length", reason = errorCode, nativeEligible = true } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "continued-draft-"));
  const clock = { now: Date.now() };
  const journal = openIntentJournal(privateDirectory(join(root, "journal")), { primaryDirectory: root, requireSeparateVolume: false });
  const readProviderReceipt = id => readRecord(join(root, "provider-receipts", id + ".json"));
  let meter;
  const core = createBotCore({ mode: "real", journal, clock: () => clock.now, readProviderReceipt,
    providerQuotaFingerprint: () => meter.quotaFingerprint, readTruncatedRevision: () => nativeEligible ? { sourceSha256, scopeStepId } : null });
  t.after(() => { core.close(); rmSync(root, { recursive: true, force: true }); });
  const m = core.createMandate({ objective: "Review a private article", sources: ["manual"], workMode: "draft_only",
    allowedActions: [], requiredOutcomes: [], budget: { currency: "CNY", limitMinor: 2000 },
    expiresAt: clock.now + 60_000, idempotencyKey: "sign-article" }, owner);
  const task = core.createTask({ mandateId: m.id, title: "Private article", idempotencyKey: "accept-article" }, owner);
  const discover = core.claim({ kinds: ["discover"] }, worker);
  core.report({ ...discover, status: "succeeded", followups: [{ kind: "prepare", key: "private-draft",
    input: { channelIds: [], opportunity: { facts: [{ claimId: "C1", state: "approved" }] } } }] }, worker);
  const original = core.claim({ kinds: ["prepare"] }, worker);
  let calls = 0;
  const quota = { taskIds: [task.id], maxCalls: 8, maxTotalTokens: 40000, maxOutputTokens: 8192 };
  function create(config) {
    return createMeter({ mode: "real", core, dataDir: root, endpoint, taskQuota: config,
      pricing: { currency: "CNY", reference: "fixture", inputPerMillion: 1, outputPerMillion: 2, cacheHitPerMillion: 1 },
      async fetchImpl(_url, wire) {
        const id = "synthetic-" + (++calls);
        return Response.json({ id, model: JSON.parse(wire.body).model, choices: [{ finish_reason: calls === 1 ? ending : "stop",
          message: { content: "{}" } }], usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } });
      } });
  }
  meter = create(quota);
  const send = (lease, message, selected = meter) => {
    const model = new DeepSeekAdapter({ apiKey: "fixture-only", baseUrl: endpoint, fetchImpl: selected.fetch,
      taskOutputCap: selected.maxOutputTokens, maxRetries: 0 });
    return selected.run(lease, worker, () => model.completeTask({ scene: "content.repair", messages: [{ role: "user", content: message }] }));
  };
  if (ending === "length") await assert.rejects(send(original, "First editorial request."), { code: errorCode });
  else await send(original, "First editorial request.");
  core.report({ ...original, status: "failed", output: { jobId, code: reason } }, worker);
  const read = () => core.getTask(task.id, owner);
  const initial = read();
  const input = { action: DRAFT_CONTINUATION_ACTION, idempotencyKey: "continue-same-draft", expectedRevision: initial.revision };
  const action = (ctx = owner, data = input) => core.controlTask(task.id, data, ctx);
  return { core, clock, initial, input, original, action, read, send, create, quota, calls: () => calls };
}

test("an owner continues the exact settled truncated private prepare on its original task and ledger", async t => {
  const f = await fixture(t);
  assert.equal(f.initial.state, "partial");
  assert.equal(f.initial.canRetryTruncatedDraft, true);
  assert.throws(() => f.action({ ...owner, actorId: "other" }), { code: "OWNER_REQUIRED" });
  assert.throws(() => f.action(owner, { ...f.input, expectedRevision: 0 }), { code: "PRECONDITION_FAILED" });
  const scheduled = f.action();
  assert.deepEqual(f.action(), scheduled);
  assert.equal(scheduled.id, f.initial.id);
  assert.equal(scheduled.state, "queued");
  assert.equal(scheduled.steps.length, 3);
  const originalFailure = f.initial.steps.find(s => s.id === f.original.id);
  assert.deepEqual(scheduled.steps.find(s => s.id === f.original.id), originalFailure);
  const again = f.core.claim({ kinds: ["prepare"] }, worker);
  assert.deepEqual(again.input, originalFailure.input);
  assert.deepEqual(again.draftContinuation, { sourceStepId: f.original.id, jobId, costId: f.core.listCosts(owner)[0].id,
    sourceSha256, scopeStepId, quotaFingerprint: again.draftContinuation.quotaFingerprint });
  assert.match(again.draftContinuation.quotaFingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(f.send(again, "First editorial request."), { code: "DRAFT_CONTINUATION_INPUT_REPEATED" });
  await assert.rejects(f.send(again, "New batch.", f.create(undefined)), { code: "DRAFT_CONTINUATION_QUOTA_CHANGED" });
  assert.equal(f.calls(), 1);
  assert.equal(f.core.listCosts(owner).length, 1);
  await f.send(again, "New batch.");
  assert.equal(f.calls(), 2);
  const output = { jobId, contentHash: "d".repeat(64), privateWork: { kind: "draft", state: "prepared", title: "Article", body: "Approved text" } };
  assert.throws(() => f.core.report({ ...again, status: "succeeded", output: { ...output, jobId: "other" } }, worker),
    { code: "DRAFT_CONTINUATION_RESULT_INVALID" });
  f.core.report({ ...again, status: "succeeded", output }, worker);
  assert.equal(f.read().state, "succeeded");
  assert.deepEqual(f.read().steps.find(s => s.id === f.original.id), originalFailure);
  assert.equal(f.core.listCosts(owner).filter(c => c.state === "settled").length, 2);
  assert.equal(f.core.listEvents(f.initial.id, {}, owner).filter(e => e.type === "task.truncated_draft_continued").length, 1);
});

test("another veto, absent native scope, a completed response or an expired mandate cannot restart a partial task", async t => {
  for (const opt of [{ reason: "UNSUPPORTED_FACT" }, { nativeEligible: false }, { ending: "stop" }]) {
    const f = await fixture(t, opt);
    assert.equal(f.initial.canRetryTruncatedDraft, false);
    assert.throws(() => f.action(), { code: "DRAFT_CONTINUATION_UNAVAILABLE" });
    assert.equal(f.read().steps.length, 2);
  }
  const f = await fixture(t);
  f.clock.now += 60_001;
  assert.equal(f.read().canRetryTruncatedDraft, false);
  assert.throws(() => f.action(), { code: "MANDATE_INACTIVE" });
});

test("a second continuation cannot hide a failed child or rewrite its predecessor", async t => {
  const f = await fixture(t);
  f.action();
  const lease = f.core.claim({ kinds: ["prepare"] }, worker);
  f.core.report({ ...lease, status: "failed", output: { jobId, code: errorCode } }, worker);
  assert.equal(f.read().state, "partial");
  assert.equal(f.read().canRetryTruncatedDraft, false);
  assert.throws(() => f.action(owner, { ...f.input, expectedRevision: f.read().revision, idempotencyKey: "try-fresh-key" }),
    { code: "DRAFT_CONTINUATION_UNAVAILABLE" });
  assert.equal(f.read().steps.filter(s => s.state === "failed").length, 2);
});

test("native eligibility is bound to a successful frozen scope and only its failed edit", () => {
  const key = "bounded:" + sourceSha256 + ":plan";
  const job = { id: jobId, managedExecution: true, createdBy: "bot-native-preparation", status: "failed",
    currentStep: "article.repair", resultRef: { sha256: sourceSha256 }, boundedRevisionSource: sourceSha256, error: { code: errorCode } };
  const steps = [{ id: scopeStepId, kind: "repair.scope", status: "succeeded", jobId, key, output: { paragraphs: [{}] }, receipt: { responseId: "saved" } },
    { kind: "article.repair", status: "failed", jobId, key: key + ":edit:old", error: { code: errorCode } }];
  const eligible = (change, contentDirectorSteps = steps) =>
    truncatedNativeRevision({ contentDirectorJobs: [{ ...job, ...change }], contentDirectorSteps }, jobId);
  assert.deepEqual(eligible({}), { sourceSha256, scopeStepId });
  for (const change of [{ pauseRequested: true }, { managedExecution: false }, { currentStep: "quality.final" },
    { error: { code: errorCode, unknown: true } }, { boundedRevisionSource: "another" }]) assert.equal(eligible(change), null);
  assert.equal(eligible({}, [steps[1]]), null);
});
