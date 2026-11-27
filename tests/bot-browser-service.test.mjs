import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBotBrowserService } from "../src/bot/browser-service.mjs";

const target = { id: "browser-lane", label: "测试工位", workspaceId: "lab", ownerId: "owner", accountId: "test-profile" };
const actor = { workspaceId: "lab", ownerId: "owner", sessionId: "tab-a" };
const other = { ...actor, sessionId: "tab-b" };
const alien = { workspaceId: "other", ownerId: "owner", sessionId: "tab-x" };
const scope = { targetId: target.id, reason: "review" };
const isCode = (code) => (error) => error.code === code;

async function setup(t, extra = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "pm-browser-service-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let time = 1_900_000_000_000;
  const gatewaySecret = randomBytes(32).toString("base64url");
  const revokeCalls = [];
  const options = {
    dataDir, gatewaySecret, gatewayControlUrl: "http://127.0.0.1:18760", sessionTargets: [target],
    now: () => time,
    fetchImpl: async (url, request) => {
      revokeCalls.push({ path: url.pathname, leases: JSON.parse(request.body).leaseIds });
      return new Response(null, { status: 204 });
    },
    ...extra,
  };
  return {
    service: createBotBrowserService(options), options, gatewaySecret, dataDir, revokeCalls,
    advance: (duration) => { time += duration; },
  };
}

test("empty browser deployment reports unavailable and rejects activity", async (t) => {
  const { dataDir } = await setup(t);
  const service = createBotBrowserService({ dataDir });
  assert.deepEqual(service.status(actor), { configured: false, stopped: false, targets: [], leases: [], audit: [] });
  assert.throws(() => service.acquire(actor, scope), isCode("BROWSER_NOT_CONFIGURED"));
  assert.throws(() => service.status({ workspaceId: "lab", ownerId: "owner" }), isCode("BROWSER_OWNER_REQUIRED"));
  assert.throws(() => service.redeem("wrong", { ticket: "wrong" }), isCode("BROWSER_GATEWAY_FORBIDDEN"));
});

test("target and lease are isolated by owner, workspace, and authenticated device", async (t) => {
  const touches = [];
  const { service, gatewaySecret } = await setup(t, { onViewerConnected: detail => touches.push(detail) });
  assert.deepEqual(service.status(alien).targets, []);
  assert.throws(() => service.acquire(alien, scope), isCode("BROWSER_TARGET_NOT_FOUND"));
  assert.throws(() => service.acquire(actor, { ...scope, reason: "free text" }), isCode("BROWSER_REASON_INVALID"));
  const { lease } = service.acquire(actor, scope);
  assert.equal(service.acquire(actor, scope).lease.id, lease.id);
  assert.throws(() => service.acquire(other, scope), isCode("BROWSER_LEASE_BUSY"));
  assert.throws(() => service.connect(other, lease.id), isCode("BROWSER_LEASE_NOT_FOUND"));
  assert.equal(service.status(other).leases[0].currentDevice, false);
  const original = service.connect(actor, lease.id);
  const current = service.connect(actor, lease.id);
  assert.equal(current.viewerPath, "/bot-browser/connect");
  assert.throws(() => service.redeem(gatewaySecret, original), isCode("BROWSER_TICKET_INVALID"));
  const ticket = service.redeem(gatewaySecret, current);
  assert.equal(ticket.targetId, target.id);
  assert.throws(() => service.redeem(gatewaySecret, current), isCode("BROWSER_TICKET_INVALID"));
  assert.throws(() => service.connect(actor, lease.id), isCode("BROWSER_VIEWER_BUSY"));
  assert.equal(service.status(actor).leases[0].viewerPending, true);
  assert.equal(service.status(actor).leases[0].viewerConnected, false);
  assert.equal(service.check(gatewaySecret, { ...ticket, viewerId: "someone-else" }).allowed, false);
  assert.equal(service.check(gatewaySecret, { ...ticket, connected: true }).allowed, true);
  assert.equal(service.check(gatewaySecret, { ...ticket, connected: true }).allowed, true);
  assert.equal(touches.length, 1);
  assert.equal(touches[0].leaseId, lease.id);
  assert.equal(service.status(actor).leases[0].viewerConnected, true);
  assert.equal(service.disconnect(gatewaySecret, { ...ticket, reason: "viewer_closed" }).disconnected, true);
  assert.equal(service.status(actor).leases[0].viewerConnected, false);
  assert.deepEqual(service.status(actor).audit.map((row) => row.action),
    ["viewer_disconnected", "viewer_connected", "viewer_redeemed", "acquired"]);
});

test("one-use tickets, unattached viewers, and input leases expire independently", async (t) => {
  const { service, gatewaySecret, advance } = await setup(t);
  const { lease } = service.acquire(actor, scope);
  const first = service.connect(actor, lease.id);
  advance(45_001);
  assert.throws(() => service.redeem(gatewaySecret, first), isCode("BROWSER_TICKET_INVALID"));
  const viewer = service.redeem(gatewaySecret, service.connect(actor, lease.id));
  advance(45_001);
  assert.equal(service.check(gatewaySecret, viewer).allowed, false);
  assert.equal(service.status(actor).audit[0].reason, "not_connected");
  advance(600_000);
  assert.equal(service.status(actor).leases[0].state, "expired");
  assert.throws(() => service.connect(actor, lease.id), isCode("BROWSER_LEASE_ENDED"));
});

test("stop, exact handback, logout, and restart leave durable metadata without viewer secrets", async (t) => {
  const { service, options, gatewaySecret, dataDir, revokeCalls } = await setup(t);
  const created = service.acquire(actor, scope).lease;
  const minted = service.connect(actor, created.id);
  const grant = service.redeem(gatewaySecret, minted);
  service.check(gatewaySecret, { ...grant, connected: true });
  assert.equal((await service.stop(other)).gatewayCut, "confirmed");
  assert.equal(service.check(gatewaySecret, grant).allowed, false);
  assert.equal(service.status(actor).stopped, true);
  assert.throws(() => service.acquire(actor, scope), isCode("BROWSER_STOPPED"));
  assert.deepEqual(revokeCalls, [{ path: "/internal/revoke", leases: [created.id] }]);

  const restarted = createBotBrowserService(options);
  assert.equal(restarted.status(actor).stopped, true);
  restarted.resume(actor);
  const handedBack = restarted.acquire(actor, scope).lease;
  assert.equal((await restarted.release(actor, handedBack.id)).lease.state, "released");
  const signedOut = restarted.acquire(actor, scope).lease;
  assert.equal((await restarted.invalidateSession(actor)).gatewayCut, "confirmed");
  assert.equal(restarted.status(actor).leases.find((row) => row.id === signedOut.id).endReason, "owner_signed_out");
  const inFlight = restarted.acquire(actor, scope).lease;
  assert.equal(createBotBrowserService(options).status(actor).leases.find((row) => row.id === inFlight.id).state, "revoked");
  const ledger = await readFile(join(dataDir, "browser", "ledger.json"), "utf8");
  for (const secret of [minted.ticket, gatewaySecret, actor.sessionId, other.sessionId, grant.viewerId]) {
    assert.ok(!ledger.includes(secret), "browser audit should never include browser authorization material");
  }
});

test("live target and native login gates revoke access without relying on a client action", async (t) => {
  let targetActive = true;
  let sessionActive = true;
  const { service, gatewaySecret } = await setup(t, {
    canUseTarget: () => targetActive,
    isSessionActive: () => sessionActive,
  });
  const active = service.acquire(actor, scope).lease;
  const grant = service.redeem(gatewaySecret, service.connect(actor, active.id));
  targetActive = false;
  assert.equal(service.check(gatewaySecret, grant).allowed, false);
  assert.equal(service.status(actor).leases[0].endReason, "permission_ended");
  targetActive = true;
  const next = service.acquire(actor, scope).lease;
  assert.equal(service.status(actor).leases[0].id, next.id);
  sessionActive = false;
  assert.throws(() => service.connect(actor, next.id), isCode("BROWSER_LEASE_ENDED"));
});
