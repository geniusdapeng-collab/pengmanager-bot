import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as rfbServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createBotBrowserGateway } from "../src/bot/browser-gateway.mjs";
import { createBotBrowserService } from "../src/bot/browser-service.mjs";

const require = createRequire(new URL("../deploy/bot-browser/package.json", import.meta.url));
const { WebSocket, WebSocketServer } = require("ws");
const origin = "https://test.example";
const user = { ownerId: "owner", workspaceId: "workspace", sessionId: "test-session" };
const target = { id: "fixture-browser", label: "测试隔离工位", ownerId: user.ownerId, workspaceId: user.workspaceId };

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function environment(t, { push = true, idleMs = 10_000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pmbg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gatewaySecret = randomBytes(32).toString("base64url");
  const sockets = new Set();
  let latestInput = "";
  const vncSocketPath = join(root, "rfb");
  const remote = rfbServer((conn) => {
    sockets.add(conn);
    conn.once("close", () => sockets.delete(conn));
    conn.on("data", (bytes) => { latestInput += bytes.toString(); });
    conn.write("RFB 003.008\n");
  });
  remote.listen(vncSocketPath);
  await once(remote, "listening");
  let service;
  const broker = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const suffix = req.url.split("/").at(-1);
      if (!["redeem", "check", "disconnect"].includes(suffix)) return res.writeHead(404).end();
      const result = service[suffix](req.headers["x-bot-browser-key"], input);
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      return res.writeHead(error.statusCode || 500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.code }));
    }
  });
  const authorityOrigin = await listen(broker);
  const gateway = createBotBrowserGateway({
    WebSocketServer, publicOrigin: origin, authorityOrigin, gatewaySecret,
    targetId: target.id, vncSocketPath, pollMs: 75, idleMs,
  });
  const gatewayOrigin = await listen(gateway);
  service = createBotBrowserService({
    dataDir: root, gatewayControlUrl: gatewayOrigin, gatewaySecret, sessionTargets: [target],
    fetchImpl: push ? fetch : async () => { throw new Error("Gateway push unavailable."); },
  });
  t.after(() => {
    gateway.close();
    broker.close();
    for (const socket of sockets) socket.destroy();
    remote.close();
  });
  const fetchGateway = (path, options) => fetch(gatewayOrigin + path, options);
  const wsUrl = gatewayOrigin.replace(/^http:/, "ws:") + "/bot-browser/socket";
  const acquire = () => {
    const { lease } = service.acquire(user, { targetId: target.id, reason: "review" });
    return { lease, ...service.connect(user, lease.id) };
  };
  const redeem = ({ ticket }, from = origin) => fetchGateway("/bot-browser/connect", {
    method: "POST", headers: { Origin: from, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket }), redirect: "manual",
  });
  return { service, fetchGateway, wsUrl, acquire, redeem, latestInput: () => latestInput };
}

async function eventually(test, timeout = 1400) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    if (test()) return;
    await delay(10);
  }
  assert.ok(test(), "condition did not become true during bounded wait");
}

function takeCookie(response) {
  const set = response.headers.get("set-cookie");
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Strict/);
  return set.split(";")[0];
}

async function connectViewer(env, cookie, from = origin) {
  const ws = new WebSocket(env.wsUrl, { origin: from, headers: { Cookie: cookie } });
  const data = once(ws, "message");
  await once(ws, "open");
  const [message, binary] = await data;
  assert.equal(binary, true);
  assert.equal(message.toString(), "RFB 003.008\n");
  return ws;
}

test("actual WSS-proxy transport rejects spoofed origins and replay, and cuts input on stop", { timeout: 8000 }, async (t) => {
  const env = await environment(t);
  assert.equal((await env.fetchGateway("/bot-browser/viewer")).status, 403);
  const view = env.acquire();
  assert.equal((await env.redeem(view, "https://another.example")).status, 403);
  const response = await env.redeem(view);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/bot-browser/viewer");
  assert.ok(!response.headers.get("location").includes(view.ticket));
  const cookie = takeCookie(response);
  assert.equal((await env.redeem(view)).status, 403);
  assert.equal((await env.fetchGateway("/bot-browser/viewer", { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await env.fetchGateway("/bot-browser/viewer", { headers: { Cookie: `${cookie}; ${cookie}` } })).status, 403);
  const intruder = new WebSocket(env.wsUrl, { origin: "https://another.example", headers: { Cookie: cookie } });
  assert.match(String((await once(intruder, "error"))[0]), /403/);
  const ws = await connectViewer(env, cookie);
  t.after(() => ws.terminate());
  ws.send(Buffer.from("local-test-input"));
  await eventually(() => env.latestInput() === "local-test-input");
  assert.equal(env.service.status(user).leases[0].viewerConnected, true);
  const second = new WebSocket(env.wsUrl, { origin, headers: { Cookie: cookie } });
  assert.match(String((await once(second, "error"))[0]), /403/);
  const closed = once(ws, "close");
  assert.equal((await env.service.stop(user)).gatewayCut, "confirmed");
  await closed;
  assert.equal(env.service.status(user).leases[0].state, "revoked");
  assert.equal((await env.fetchGateway("/bot-browser/viewer", { headers: { Cookie: cookie } })).status, 403);
});

test("a failed active shutoff still closes WSS on authority recheck", { timeout: 8000 }, async (t) => {
  const env = await environment(t, { push: false });
  const view = env.acquire();
  const cookie = takeCookie(await env.redeem(view));
  const ws = await connectViewer(env, cookie);
  t.after(() => ws.terminate());
  const closed = once(ws, "close");
  assert.equal((await env.service.release(user, view.lease.id)).gatewayCut, "pending_gateway_check");
  await closed;
  assert.equal(env.service.status(user).leases[0].state, "released");
});

test("protocol traffic does not prolong human idle time", { timeout: 8000 }, async (t) => {
  const env = await environment(t, { idleMs: 280 });
  const view = env.acquire();
  const cookie = takeCookie(await env.redeem(view));
  const ws = await connectViewer(env, cookie);
  t.after(() => ws.terminate());
  const closed = once(ws, "close");
  const traffic = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from("not-a-human-activity-signal"));
  }, 20);
  t.after(() => clearInterval(traffic));
  await closed;
  await eventually(() => env.service.status(user).audit[0].reason === "viewer_idle");
  assert.equal(env.service.status(user).leases[0].state, "active");
  assert.equal(env.service.status(user).leases[0].viewerConnected, false);
});
