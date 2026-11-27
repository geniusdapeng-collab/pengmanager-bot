import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGeoOsServer } from "../src/http/server.mjs";
import { TEXT_PRIMARY_MODEL } from "../src/model-routing/registry.mjs";
import {
  aiApprovalKeyId, aiApprovalWorkOrder, aiApprovalWorkerAuthorization, createAiApproval,
  judgeAiApproval, signAiApproval, verifyAiApprovalWorkOrder,
} from "../src/services/ai-approval.mjs";

const snapshotHash = "0".repeat(64);
const input = {
  kind: "editorial.public-release", subjectId: "REL-00001", snapshotHash,
  evidence: { title: "正式稿", reviewedAttachment: true },
  criteria: { accurate: "Verify it is an approved attachment." },
};

async function runtime(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pengmanager-ai-approval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, approval: createAiApproval({ directory, waitMs: 0, ...options }) };
}

function judge(status = "pass", received = []) {
  return {
    async completeTask(request) {
      received.push(request);
      const model = TEXT_PRIMARY_MODEL.officialModelId;
      return {
        value: {
          decision: { pass: "approve", unknown: "needs_evidence", fail: "reject" }[status],
          findings: [{ criterion: "accurate", status, reason: "独立核对附件事实" }],
          rationale: "判断已记录",
        },
        receipt: { schemaVersion: "workloom.model-receipt/v1", policy: { scene: "approval.decision" },
          requestedModel: model, returnedModel: model, finishReason: "stop", responseId: "real-contract-fixture",
          requestHash: snapshotHash, responseHash: snapshotHash, wireSha256: snapshotHash, policyHash: snapshotHash,
          usage: { inputTokens: 24, outputTokens: 13, totalTokens: 37 } },
      };
    },
  };
}

test("a local business application records one bounded AI result across concurrent identical calls and restart", async t => {
  const requests = [];
  const { directory, approval } = await runtime(t, { model: judge("pass", requests) });
  const [first, second] = await Promise.all([approval.review(input), approval.review(input)]);
  assert.deepEqual(first, second);
  assert.equal(first.actor, "ai-reviewer");
  assert.equal(first.snapshotHash, snapshotHash);
  assert.equal(first.modelReceipt.policy.scene, "approval.decision");
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[1].content, /正式稿/u);
  const restarted = createAiApproval({ directory });
  await assert.rejects(restarted.review(input), { code: "AI_APPROVAL_WORKER_REQUIRED" });
  const localRestart = createAiApproval({ directory, model: judge("pass", requests) });
  assert.deepEqual(await localRestart.review(input), first);
  assert.equal(requests.length, 1);
  await assert.rejects(approval.review({ ...input, proof: { approved: true } }), { code: "AI_APPROVAL_WORKER_REQUIRED" });
});

test("a rejection and unknown evidence are independently persisted and never pass the business guard", async t => {
  const fail = await runtime(t, { model: judge("fail") });
  await assert.rejects(fail.approval.review(input), error =>
    error.code === "AI_APPROVAL_REJECTED" && error.details.aiReview.decision === "reject");
  const unknown = await runtime(t, { model: judge("unknown") });
  await assert.rejects(unknown.approval.review(input), error =>
    error.code === "AI_APPROVAL_NEEDS_EVIDENCE" && error.details.aiReview.decision === "needs_evidence");
  await assert.rejects(unknown.approval.review({ ...input, snapshotHash: "old" }), { code: "AI_APPROVAL_SUBJECT_INVALID" });
});

test("actual PNG bytes enter the vision request and tampering breaks the bound order", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64");
  const order = aiApprovalWorkOrder({ ...input, images: [{ mime: "image/png", bytes }] });
  const requests = [];
  await judgeAiApproval(order, judge("pass", requests), () => new Date("2026-11-21T10:48:27.000Z"));
  assert.match(requests[0].messages[0].content, /审核工位当前时间（UTC）：2026-11-21T10:48:27.000Z/u);
  assert.deepEqual(requests[0].messages[1].content[1], {
    type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}`, detail: "high" },
  });
  const corrupted = structuredClone(order);
  corrupted.images[0].sha256 = snapshotHash;
  assert.throws(() => verifyAiApprovalWorkOrder(corrupted), { code: "AI_APPROVAL_ORDER_INVALID" });
  assert.throws(() => aiApprovalWorkOrder({ ...input, evidence: { link: "https://public.example/evidence?access_token=document-read-token" } }),
    { code: "AI_APPROVAL_EVIDENCE_SENSITIVE" });
  assert.throws(() => aiApprovalWorkOrder({ ...input, images: [{ mime: "image/png", bytes: Buffer.alloc(40) }] }),
    { code: "AI_APPROVAL_IMAGES_INVALID" });
});

test("a signed worker reclaims a lost claim result and persists exactly one result over HTTP", async t => {
  const origin = "https://pengmanager.example";
  const { directory, approval } = await runtime(t, { origin });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const keyId = aiApprovalKeyId(key);
  const server = createGeoOsServer({ aiApproval: approval, service: { }, publicDir: directory });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (action, body, token, method = "POST") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai-approval-worker/${action}`, {
      method, headers: { "Content-Type": "application/json", "X-Pengmanager-Ai-Approval-Worker": token ?? "" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, result: await response.json() };
  };
  const auth = (action, body, timestamp) => aiApprovalWorkerAuthorization(privateKey, keyId, origin, action, body, timestamp);
  assert.equal((await request("claim", {}, "", "GET")).status, 405);
  assert.equal((await request("claim", {})).status, 403);
  await assert.rejects(approval.review(input), { code: "AI_APPROVAL_WORKER_REQUIRED" });
  await writeFile(join(directory, "reviewer-public-key.json"), JSON.stringify({ publicKey: key }), { mode: 0o600 });
  await assert.rejects(approval.review(input), { code: "AI_APPROVAL_PENDING" });
  const body = { claimId: randomUUID() };
  const token = auth("claim", body);
  assert.equal((await request("claim", body, auth("claim", body, Date.now() - 120_000))).status, 403);
  assert.equal((await request("claim", { claimId: randomUUID() }, token)).status, 403);
  const first = await request("claim", body, token);
  assert.equal(first.status, 200);
  assert.equal((await request("claim", body, token)).status, 403);
  const repeat = await request("claim", body, auth("claim", body));
  assert.deepEqual(repeat, first);
  const second = { claimId: randomUUID() };
  assert.deepEqual((await request("claim", second, auth("claim", second))).result, { reviewId: null });
  const { reviewId, leaseId, order } = first.result;
  const receipt = await judgeAiApproval(order, judge());
  const proof = signAiApproval(receipt, privateKey, key);
  const forged = structuredClone(proof);
  forged.statement.rationale = "已被请求篡改";
  await assert.rejects(approval.review({ ...input, proof: forged }), { code: "AI_APPROVAL_PROOF_INVALID" });
  await assert.rejects(approval.review({ ...input, evidence: { title: "新快照" }, proof }), { code: "AI_APPROVAL_PROOF_INVALID" });
  for (const [kind, subjectId] of [["editorial.variant", "CNT-00001"], ["editorial.website_release", "REL-00001"]]) {
    const before = { ...input, kind, subjectId };
    const oldProof = signAiApproval(await judgeAiApproval(aiApprovalWorkOrder(before), judge()), privateKey, key);
    assert.equal((await approval.review({ ...before, proof: oldProof })).evidenceHash, oldProof.statement.evidenceHash);
    for (const evidence of [
      { ...before.evidence, originalDelta: { schema: "pengmanager.original-illustration-review/v1" } },
      { ...before.evidence, verifiedPublicationAuthorization: { authorizedBy: "isolated admin", previousReleaseId: "REL-00002" } },
    ]) {
      await assert.rejects(approval.review({ ...before, evidence, proof: oldProof }), { code: "AI_APPROVAL_PROOF_INVALID" });
    }
  }
  const submission = { reviewId, leaseId, proof };
  assert.equal((await request("complete", submission, auth("complete", submission))).status, 200);
  assert.deepEqual((await request("complete", submission, auth("complete", submission))).result, { reviewId, decision: "approve" });
  assert.equal((await approval.review(input)).reviewerKeyId, keyId);
  assert.ok((await readdir(directory)).every(filename => !filename.endsWith(".order.json")));
});

test("an explicit balance refusal safely releases the original work order after cooldown", async t => {
  let now = Date.now();
  const origin = "https://pengmanager.example";
  const { directory, approval } = await runtime(t, { origin, clock: () => new Date(now) });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  await writeFile(join(directory, "reviewer-public-key.json"), JSON.stringify({ publicKey: key }), { mode: 0o600 });
  const call = (action, body) => approval.worker(action, body, aiApprovalWorkerAuthorization(privateKey, aiApprovalKeyId(key), origin, action, body));
  await assert.rejects(approval.review(input), { code: "AI_APPROVAL_PENDING" });
  const claim = { claimId: randomUUID() };
  const job = await call("claim", claim);
  const { reviewId, leaseId } = job;
  const refused = { reviewId, leaseId, code: "MODEL_HTTP_402" };
  const first = await call("failed", refused);
  assert.deepEqual(await call("failed", refused), first);
  await assert.rejects(approval.review(input), { code: "AI_APPROVAL_PROVIDER_BALANCE" });
  assert.deepEqual(await call("claim", { claimId: randomUUID() }), { reviewId: null });
  now += 61_000;
  assert.deepEqual(await call("claim", claim), { reviewId: null });
  const retried = await call("claim", { claimId: randomUUID() });
  assert.equal(retried.reviewId, reviewId);
  assert.notEqual(retried.leaseId, leaseId);
  const proof = signAiApproval(await judgeAiApproval(retried.order, judge()), privateKey, key);
  await assert.rejects(call("complete", { reviewId, leaseId, proof }), { code: "AI_APPROVAL_WORKER_LEASE_INVALID" });
  assert.equal((await call("complete", { reviewId, leaseId: retried.leaseId, proof })).decision, "approve");
  assert.equal((await approval.review(input)).evidenceHash, reviewId);
});
