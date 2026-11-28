import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBotCore } from "../src/bot/core.mjs";
import { digest, openIntentJournal, privateDirectory } from "../src/bot/files.mjs";
import { createMeter } from "../src/bot/meter.mjs";
import { quotaReservation, taskProviderQuota } from "../src/bot/provider-quota.mjs";
import { DeepSeekAdapter } from "../src/adapters/deepseek.mjs";

function setup(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "model-quota-"));
  const journal = openIntentJournal(privateDirectory(join(root, "journal")), { primaryDirectory: root, requireSeparateVolume: false });
  const core = createBotCore({ mode: "real", journal });
  t.after(() => { core.close(); rmSync(root, { recursive: true, force: true }); });
  const owner = { workspaceId: "quota", projectId: "article", actorId: "owner", role: "owner" };
  const worker = { ...owner, actorId: "worker", role: "worker" };
  function step(name) {
    const mandate = core.createMandate({ objective: "Review an authorized article", idempotencyKey: "sign-" + name,
      budget: { currency: "CNY", limitMinor: 10000 } }, owner);
    core.createTask({ mandateId: mandate.id, title: name, idempotencyKey: "create-" + name }, owner);
    return core.claim({ kinds: ["discover"] }, worker);
  }
  const first = step("original"), second = step("replacement");
  const endpoint = "https://model.example.test";
  const calls = [];
  function meter(config, handler) {
    return createMeter({ core, dataDir: root, mode: "real", endpoint, taskQuota: config,
      pricing: { currency: "CNY", reference: "test", inputPerMillion: 1, outputPerMillion: 2, cacheHitPerMillion: 1 },
      async fetchImpl(_url, options) {
        const id = "response-" + calls.length;
        const body = JSON.parse(options.body);
        calls.push(body);
        const usage = handler ? await handler() : undefined;
        return Response.json({ id, model: body.model, choices: [{ finish_reason: "stop", message: { content: "{}" } }],
          usage: usage ?? { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } });
      } });
  }
  function send(selected, lease, message, scene = "content.research.plan") {
    const model = new DeepSeekAdapter({ apiKey: "fixture-only", baseUrl: endpoint, fetchImpl: selected.fetch,
      maxRetries: 0, taskOutputCap: selected.maxOutputTokens });
    return selected.run(lease, worker, () => model.completeTask({
      scene, messages: [{ role: "user", content: message }],
    }));
  }
  const config = { taskIds: [first.taskId, second.taskId], maxCalls: 2, maxTotalTokens: 12000, maxOutputTokens: 8192 };
  return { first, second, core, owner, worker, endpoint, calls, meter, send, config };
}

test("signed quota totals both tasks including prior receipts, serializes competing calls and replays a settled request", async t => {
  const { first, second, core, owner, calls, meter, send, config } = setup(t);
  await send(meter(undefined), first, "Previously authorized research.");
  assert.ok(calls[0].max_tokens > config.maxOutputTokens);
  const entered = Promise.withResolvers(), leave = Promise.withResolvers();
  const scoped = meter(config, async () => { entered.resolve(); await leave.promise; });
  const writing = send(scoped, second, "One new editorial decision.");
  await entered.promise;
  try {
    await assert.rejects(send(scoped, second, "Another editorial decision."), { code: "BUDGET_EXCEEDED", unknown: false });
  } finally { leave.resolve(); }
  await writing;
  assert.equal(calls[1].max_tokens, 8192);
  assert.equal((await send(meter(config), second, "One new editorial decision.")).responseId, "response-1");
  await assert.rejects(send(meter(config), second, "The call ceiling is now exhausted."), { code: "BUDGET_EXCEEDED" });
  assert.equal(calls.length, 2);
  const costs = core.listCosts(owner);
  assert.equal(costs.length, 2);
  assert.equal(costs.filter(c => c.providerTokenHold?.outputTokens === 8192).length, 1);
});

test("named scene ceilings affect only the selected task group and settle against the full serialized request", async t => {
  const { first, second, core, owner, calls, meter, send, config } = setup(t);
  const old = meter(config);
  const options = { ...config, maxCalls: 4, maxTotalTokens: 65000, taskIds: [first.taskId],
    sceneMaxOutputTokens: { "content.audit.article": 32768, "approval.decision": 16384 } };
  const review = meter(options);
  assert.notEqual(review.quotaFingerprint, old.quotaFingerprint);
  assert.equal(review.quotaFingerprint, meter({ ...options, sceneMaxOutputTokens: { "approval.decision": 16384, "content.audit.article": 32768 } }).quotaFingerprint);
  await send(review, first, "Review this complete article.", "content.audit.article");
  await send(review, first, "Repair the authorized paragraph.", "content.repair");
  await send(review, first, "Review the complete final version.", "quality.final");
  await send(review, first, "Approve this exact package.", "approval.decision");
  await send(review, second, "Another mandate.", "content.audit.article");
  assert.deepEqual(calls.map(body => body.max_tokens).slice(0,4), [32768,8192,8192,16384]);
  assert.ok(calls[4].max_tokens > 32768);
  assert.ok(calls.every(body => body.thinking.type === "enabled" && body.reasoning_effort === "high" && !Object.hasOwn(body, "scene")));
  const holds = core.listCosts(owner).map(cost => cost.providerTokenHold).filter(Boolean);
  assert.deepEqual(holds.map(hold => [hold.scene, hold.outputTokens]).sort(),
    [["approval.decision",16384],["content.audit.article",32768],["content.repair",8192],["quality.final",8192]]);
  assert.ok(holds.every(hold => hold.inputTokens > 0 && /^[a-f0-9]{64}$/.test(hold.wireSha256)));
  assert.throws(() => meter({ ...config, sceneMaxOutputTokens: { "unknown.scene": 100 } }), /Invalid sceneMaxOutputTokens/);
  assert.throws(() => meter({ ...config, sceneMaxOutputTokens: { "quality.final": config.maxTotalTokens+1 } }), /Invalid sceneMaxOutputTokens/);
});

test("the final transport cannot use a higher quote after losing or changing its prepared request", async t => {
  const { first, worker, endpoint, calls, core, owner, meter, config } = setup(t);
  const scoped = meter({ ...config, maxTotalTokens: 65000, sceneMaxOutputTokens: { "content.audit.article": 32768 } });
  const body = JSON.stringify({ model: "deepseek-flash", max_tokens: 32768, messages: [{role:"user",content:"Full draft"}], stream: false });
  await scoped.run(first, worker, async () => {
    for (const metadata of [undefined, { scene: "content.repair.copyedit", wireSha256: digest(body) },
      { scene: "content.audit.article", wireSha256: digest(body + " ") }]) {
      await assert.rejects(scoped.fetch(endpoint + "/chat/completions", { method:"POST", body }, metadata), { code: "BUDGET_EXCEEDED" });
    }
  });
  assert.equal(calls.length, 0);
  assert.equal(core.listCosts(owner).length, 0);
});

test("total tokens reserve the actual request ceiling; unknown sends prevent later dispatch after reopening the meter", async t => {
  const { first, second, calls, meter, send, config } = setup(t);
  await send(meter(undefined), first, "Historical response.");
  const messages = [{ role: "user", content: "Count this exact input." }];
  const prior = calls[0];
  const hold = await quotaReservation(config, { body: { ...prior, messages, max_tokens: config.maxOutputTokens }, isSearch: false });
  const exact = 35 + hold.inputTokens + hold.outputTokens;
  await assert.rejects(send(meter({ ...config, maxTotalTokens: exact - 1 }), second, messages[0].content), { code: "BUDGET_EXCEEDED" });
  const unknown = meter({ ...config, maxTotalTokens: exact }, () => { throw new Error("Ambiguous provider failure"); });
  await assert.rejects(send(unknown, second, messages[0].content), { code: "MODEL_NETWORK_UNKNOWN" });
  await assert.rejects(send(meter(config), second, "New request while unknown."), { code: "BUDGET_EXCEEDED" });
  assert.equal(calls.length, 2);
  assert.throws(() => taskProviderQuota({ ...config, maxOutputTokens: 0 }), /Invalid taskProviderQuota/);
});

for (const [name, usage, state] of [
  ["mismatched total", { prompt_tokens: 30, completion_tokens: 5, total_tokens: 36 }, "unknown"],
  ["input exceeds the hold", { prompt_tokens: 4000, completion_tokens: 5, total_tokens: 4005 }, "settled"],
  ["output exceeds the wire cap", { prompt_tokens: 30, completion_tokens: 8193, total_tokens: 8223 }, "settled"],
]) {
  test("a final provider response with " + name + " cannot produce a business result", async t => {
    const { second, calls, core, owner, meter, send, config } = setup(t);
    const scoped = meter(config, () => usage);
    await assert.rejects(send(scoped, second, "A final independent decision."), {
      code: "MODEL_QUOTA_RECEIPT_RECONCILIATION_REQUIRED", unknown: state === "unknown",
    });
    assert.equal(core.listCosts(owner)[0].state, state);
    await assert.rejects(send(meter(config), second, "Another independent check."), { code: "BUDGET_EXCEEDED" });
    assert.equal(calls.length, 1);
  });
}
