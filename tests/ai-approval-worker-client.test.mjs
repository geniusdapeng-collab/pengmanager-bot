import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { requestAiApprovalWorker } from "../src/services/ai-approval-worker-client.mjs";

async function fixture(t, handle) {
  const server = createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (action, options = {}) => requestAiApprovalWorker({
    origin, action, body: { claimId: "fixture-claim" }, authorization: "synthetic-authorization", ...options,
  });
}

test("a streamed image claim has a longer deadline without changing the report budget", async t => {
  const calls = [];
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    calls.push(milliseconds);
    return originalTimeout(milliseconds);
  });
  const image = Buffer.alloc(2_543_332, 31);
  const expectedHash = createHash("sha256").update(image).digest("hex");
  const claim = JSON.stringify({ reviewId: "same-review", leaseId: "same-lease",
    order: { images: [{ data: image.toString("base64") }] } });
  const routes = [];
  const request = await fixture(t, (req, res) => {
    routes.push({ url: req.url, credential: req.headers["x-pengmanager-ai-approval-worker"] });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.endsWith("/claim")) {
      res.write(claim.slice(0, 1024));
      setImmediate(() => res.end(claim.slice(1024)));
    } else {
      res.end('{"reviewId":"same-review","decision":"approve"}');
    }
  });

  const result = await request("claim");
  assert.equal(result.leaseId, "same-lease");
  assert.equal(createHash("sha256").update(Buffer.from(result.order.images[0].data, "base64")).digest("hex"), expectedHash);
  assert.equal((await request("complete")).decision, "approve");
  assert.equal(calls[0], 180_000);
  assert.ok(calls.includes(30_000));
  assert.deepEqual(routes.map(route => route.url), ["/api/ai-approval-worker/claim", "/api/ai-approval-worker/complete"]);
  assert.ok(routes.every(route => route.credential === "synthetic-authorization"));
});

test("a claim whose HTTP headers arrived can still time out while receiving its body", async t => {
  const timer = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", milliseconds =>
    milliseconds === 180_000 ? timer.signal : originalTimeout(milliseconds));
  const received = Promise.withResolvers();
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (...args) => {
    const response = await originalFetch(...args);
    received.resolve(response.status);
    return response;
  });
  const request = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"reviewId":');
  });

  const pending = request("claim");
  const rejection = assert.rejects(pending, { code: "AI_WORKER_RESPONSE_TIMEOUT" });
  assert.equal(await received.promise, 200);
  timer.abort(new DOMException("fixture deadline", "TimeoutError"));
  await rejection;
});

test("claim and report enforce byte limits on actual decoded data", async t => {
  const compressed = gzipSync(Buffer.from(JSON.stringify({ description: "a".repeat(65_536) })));
  const request = await fixture(t, (req, res) => {
    if (req.url.endsWith("/claim")) {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "12001025" });
      res.end("{}");
    } else {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": compressed.length });
      res.end(compressed);
    }
  });

  await assert.rejects(request("claim"), { code: "AI_WORKER_RESPONSE_TOO_LARGE" });
  await assert.rejects(request("failed"), { code: "AI_WORKER_RESPONSE_TOO_LARGE" });
});

test("worker transport preserves an explicit server error code and withholds invalid response bodies", async t => {
  const request = await fixture(t, (req, res) => {
    if (req.url.endsWith("/claim")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end('{"error":{"code":"AI_APPROVAL_WORKER_DENIED"}}');
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("fixture-invalid-json");
    }
  });

  await assert.rejects(request("claim"), { code: "AI_APPROVAL_WORKER_DENIED" });
  await assert.rejects(request("complete"), {
    code: "AI_WORKER_RESPONSE_INVALID", message: "审核工位未收到有效的 JSON 响应。",
  });
});
