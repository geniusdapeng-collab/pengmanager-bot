import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const idPattern = /^[A-Za-z0-9_.:@-]{1,128}$/;
const secretPattern = /^[A-Za-z0-9_-]{43,128}$/;
const ticketLifetimeMs = 45_000;
const leaseLifetimeMs = 10 * 60_000;
const acquisitionReasons = new Set(["sign_in", "platform_verification", "review"]);
const disconnectReasons = new Set(["viewer_closed", "viewer_idle", "worker_unavailable", "gateway_closed", "not_connected"]);
const emptyLedger = () => ({ version: 1, leases: [], controls: {}, audit: [] });

export function browserError(statusCode, code, message) {
  return Object.assign(new Error(message), { status: statusCode, statusCode, code });
}

export function equalBrowserSecret(expected, received) {
  if (!secretPattern.test(expected || "") || !secretPattern.test(received || "")) return false;
  return timingSafeEqual(digest(expected), digest(received));
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function fingerprint(value) {
  return digest(value).toString("hex");
}

function requireBrowserActor(actor) {
  if (!idPattern.test(actor?.ownerId || "") || !idPattern.test(actor?.workspaceId || "") ||
      typeof actor?.sessionId !== "string" || !actor.sessionId || actor.sessionId.length > 256) {
    throw browserError(403, "BROWSER_OWNER_REQUIRED", "云浏览器接管需要有效的管理员会话。");
  }
  return { ownerId: actor.ownerId, workspaceId: actor.workspaceId, sessionHash: fingerprint(actor.sessionId) };
}

function gatewayEndpoint(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("Browser gateway control must be an HTTP(S) origin.");
  }
  return new URL("/internal/revoke", url);
}

function configuredTargets(input) {
  if (!Array.isArray(input)) throw new TypeError("Browser targets must be an array.");
  if (input.length > 1) throw new TypeError("This deployment accepts one dedicated browser target.");
  const targets = new Map();
  for (const target of input) {
    const { id, label, workspaceId, ownerId, accountId, taskId } = target ?? {};
    if (![id, workspaceId, ownerId, accountId ?? id, taskId ?? id].every((value) => idPattern.test(value || "")) ||
        typeof label !== "string" || !label.trim() || label.length > 100 || targets.has(id)) {
      throw new TypeError("Browser target identity is invalid or duplicated.");
    }
    targets.set(id, { id, label: label.trim(), workspaceId, ownerId, accountId, taskId });
  }
  return targets;
}

function readLedger(path) {
  try {
    const ledger = JSON.parse(readFileSync(path, "utf8"));
    if (ledger.version !== 1 || !Array.isArray(ledger.leases) || !Array.isArray(ledger.audit) ||
        !ledger.controls || typeof ledger.controls !== "object" || Array.isArray(ledger.controls)) {
      throw new TypeError("Browser audit ledger has an unsupported format.");
    }
    return ledger;
  } catch (error) {
    if (error.code === "ENOENT") return emptyLedger();
    throw error;
  }
}

function writeLedger(directory, path, ledger) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `.browser-${randomUUID()}.tmp`);
  try {
    const file = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(file, JSON.stringify(ledger));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function publicLease({ id, targetId, reason, state, createdAt, expiresAt, endedAt, endReason, viewerId, viewerStartBy }) {
  return {
    id, targetId, reason, state, createdAt, expiresAt, endedAt, endReason,
    viewerConnected: Boolean(viewerId && !viewerStartBy && state === "active"),
    viewerPending: Boolean(viewerId && viewerStartBy && state === "active"),
  };
}

export function createBotBrowserService({
  dataDir,
  gatewaySecret = "",
  gatewayControlUrl = "",
  viewerPath = "/bot-browser/connect",
  sessionTargets = [],
  isSessionActive,
  canUseTarget,
  onViewerConnected,
  now = Date.now,
  fetchImpl = fetch,
} = {}) {
  const directory = resolve(dataDir, "browser");
  const path = resolve(directory, "ledger.json");
  const gateway = gatewayEndpoint(gatewayControlUrl);
  const targets = configuredTargets(sessionTargets);
  if (viewerPath !== "/bot-browser/connect") throw new TypeError("Browser viewer requires the same-origin takeover route.");
  const enabled = Boolean(gateway && secretPattern.test(gatewaySecret) && targets.size);
  const tickets = new Map();
  const liveSessions = new Map();
  let ledger = readLedger(path);

  function persist(next) {
    writeLedger(directory, path, next);
    ledger = next;
  }

  function event(next, context, action, info = {}) {
    next.audit.push({
      sequence: next.audit.length + 1, timestamp: new Date(now()).toISOString(),
      workspaceId: context.workspaceId, ownerId: context.ownerId, action, ...info,
    });
  }

  function close(next, lease, state, reason) {
    lease.state = state;
    lease.endedAt = new Date(now()).toISOString();
    lease.endReason = reason;
    event(next, lease, state, { leaseId: lease.id, targetId: lease.targetId, reason });
    lease.viewerId = null;
    lease.viewerStartBy = null;
  }

  function controlKey(workspaceId) {
    return fingerprint(workspaceId);
  }

  function usable(lease) {
    const target = targets.get(lease.targetId);
    return enabled && target?.workspaceId === lease.workspaceId && target.ownerId === lease.ownerId &&
      lease.state === "active" && Date.parse(lease.expiresAt) > now() &&
      !ledger.controls[controlKey(lease.workspaceId)]?.stopped &&
      liveSessions.has(lease.sessionHash) &&
      (!isSessionActive || isSessionActive(liveSessions.get(lease.sessionHash)) === true) &&
      (!canUseTarget || canUseTarget(target, lease.reason) === true);
  }

  function sweep() {
    const next = structuredClone(ledger);
    let changed = false;
    for (const lease of next.leases.filter((item) => item.state === "active")) {
      if (!usable(lease)) {
        const expired = Date.parse(lease.expiresAt) <= now();
        close(next, lease, expired ? "expired" : "revoked", expired ? "time_limit" : "permission_ended");
        changed = true;
      } else if (lease.viewerStartBy && lease.viewerStartBy <= now()) {
        event(next, lease, "viewer_disconnected", { leaseId: lease.id, targetId: lease.targetId, reason: "not_connected" });
        lease.viewerId = null;
        lease.viewerStartBy = null;
        changed = true;
      }
    }
    if (changed) persist(next);
    for (const [hash, ticket] of tickets) {
      if (ticket.expiresAt <= now() || !ledger.leases.some((lease) => lease.id === ticket.leaseId && lease.state === "active")) {
        tickets.delete(hash);
      }
    }
    for (const hash of liveSessions.keys()) {
      if (!ledger.leases.some((lease) => lease.sessionHash === hash && lease.state === "active")) liveSessions.delete(hash);
    }
  }

  function requireGateway(secret) {
    if (!enabled || !equalBrowserSecret(gatewaySecret, secret)) {
      throw browserError(403, "BROWSER_GATEWAY_FORBIDDEN", "云浏览器网关身份无效。");
    }
  }

  function ownerLease(actor, leaseId, { active = true } = {}) {
    const lease = ledger.leases.find((item) => item.id === leaseId && item.workspaceId === actor.workspaceId &&
      item.ownerId === actor.ownerId && item.sessionHash === actor.sessionHash);
    if (!lease) throw browserError(404, "BROWSER_LEASE_NOT_FOUND", "找不到当前设备的接管租约。");
    if (active && lease.state !== "active") {
      throw browserError(409, "BROWSER_LEASE_ENDED", "这次接管已结束，请重新申请。");
    }
    return lease;
  }

  async function cutGateway(leaseIds) {
    if (!enabled || !leaseIds.length) return "unnecessary";
    try {
      const response = await fetchImpl(gateway, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", "X-Bot-Browser-Key": gatewaySecret },
        body: JSON.stringify({ leaseIds }),
        signal: AbortSignal.timeout(1_500),
      });
      return response.ok ? "confirmed" : "pending_gateway_check";
    } catch {
      return "pending_gateway_check";
    }
  }

  function status(actor) {
    const context = requireBrowserActor(actor);
    sweep();
    const visibleTargets = [...targets.values()].filter((target) => target.ownerId === context.ownerId &&
      target.workspaceId === context.workspaceId).map(({ id, label, accountId, taskId }) => ({ id, label, accountId, taskId }));
    const belongs = (entry) => entry.workspaceId === context.workspaceId && entry.ownerId === context.ownerId;
    return {
      configured: enabled && visibleTargets.length > 0,
      stopped: Boolean(ledger.controls[controlKey(context.workspaceId)]?.stopped),
      targets: enabled ? visibleTargets : [],
      leases: ledger.leases.filter(belongs).slice(-20).reverse().map((lease) => ({
        ...publicLease(lease), currentDevice: lease.sessionHash === context.sessionHash,
      })),
      audit: ledger.audit.filter(belongs).slice(-30).reverse(),
    };
  }

  function acquire(actor, input) {
    const context = requireBrowserActor(actor);
    sweep();
    if (!enabled) throw browserError(503, "BROWSER_NOT_CONFIGURED", "此部署尚未配置云浏览器工位。");
    if (ledger.controls[controlKey(context.workspaceId)]?.stopped) {
      throw browserError(409, "BROWSER_STOPPED", "云浏览器接管已停用。");
    }
    const target = targets.get(input?.targetId);
    if (!target || target.ownerId !== context.ownerId || target.workspaceId !== context.workspaceId) {
      throw browserError(404, "BROWSER_TARGET_NOT_FOUND", "没有获准的对应云浏览器工位。");
    }
    const reason = input?.reason;
    if (!acquisitionReasons.has(reason)) {
      throw browserError(422, "BROWSER_REASON_INVALID", "请选择本次接管的用途。");
    }
    if ((isSessionActive && isSessionActive(actor.sessionId) !== true) ||
        (canUseTarget && canUseTarget(target, reason) !== true)) {
      throw browserError(403, "BROWSER_PERMISSION_ENDED", "当前身份或工位许可已失效。");
    }
    const existing = ledger.leases.find((item) => item.targetId === target.id && item.state === "active");
    if (existing) {
      if (existing.sessionHash === context.sessionHash && existing.reason === reason) return { lease: publicLease(existing) };
      throw browserError(409, "BROWSER_LEASE_BUSY", "这个工位已有接管者，请先交还或停止旧接管。");
    }
    const at = now();
    const lease = {
      ...context, id: randomUUID(), targetId: target.id, accountId: target.accountId, taskId: target.taskId,
      state: "active", reason, createdAt: new Date(at).toISOString(), expiresAt: new Date(at + leaseLifetimeMs).toISOString(),
    };
    const next = structuredClone(ledger);
    next.leases.push(lease);
    event(next, lease, "acquired", { leaseId: lease.id, targetId: lease.targetId, reason });
    persist(next);
    liveSessions.set(context.sessionHash, actor.sessionId);
    return { lease: publicLease(lease) };
  }

  function connect(actor, leaseId) {
    const context = requireBrowserActor(actor);
    sweep();
    const lease = ownerLease(context, leaseId);
    if (lease.viewerId) throw browserError(409, "BROWSER_VIEWER_BUSY", "这次接管已有画面连接。");
    const ticket = randomBytes(32).toString("base64url");
    for (const [hash, existing] of tickets) {
      if (existing.leaseId === lease.id) tickets.delete(hash);
    }
    tickets.set(fingerprint(ticket), {
      leaseId: lease.id, expiresAt: Math.min(now() + ticketLifetimeMs, Date.parse(lease.expiresAt)),
    });
    return { viewerPath, ticket };
  }

  function redeem(secret, input) {
    requireGateway(secret);
    sweep();
    if (!secretPattern.test(input?.ticket || "")) {
      throw browserError(403, "BROWSER_TICKET_INVALID", "接管票据无效或已使用。");
    }
    const hash = fingerprint(input.ticket);
    const record = tickets.get(hash);
    const next = structuredClone(ledger);
    const lease = record && next.leases.find((item) => item.id === record.leaseId && item.state === "active" && !item.viewerId);
    if (!lease) throw browserError(403, "BROWSER_TICKET_INVALID", "接管票据无效或已使用。");
    lease.viewerId = randomUUID();
    lease.viewerStartBy = now() + ticketLifetimeMs;
    event(next, lease, "viewer_redeemed", { leaseId: lease.id, targetId: lease.targetId });
    persist(next);
    tickets.delete(hash);
    return { leaseId: lease.id, viewerId: lease.viewerId, targetId: lease.targetId, expiresAt: lease.expiresAt };
  }

  function check(secret, input) {
    requireGateway(secret);
    sweep();
    const lease = ledger.leases.find((item) => item.id === input?.leaseId && item.viewerId &&
      item.viewerId === input?.viewerId && item.state === "active");
    if (!lease) return { allowed: false };
    if (input.connected === true && lease.viewerStartBy) {
      const next = structuredClone(ledger);
      const current = next.leases.find((item) => item.id === lease.id);
      onViewerConnected?.({ targetId: current.targetId, taskId: current.taskId, leaseId: current.id });
      current.viewerStartBy = null;
      event(next, current, "viewer_connected", { leaseId: lease.id, targetId: lease.targetId });
      persist(next);
    }
    return { allowed: true, expiresAt: lease.expiresAt, targetId: lease.targetId };
  }

  function disconnect(secret, input) {
    requireGateway(secret);
    sweep();
    const next = structuredClone(ledger);
    const lease = next.leases.find((item) => item.id === input?.leaseId && item.viewerId && item.viewerId === input?.viewerId);
    if (!lease) return { disconnected: false };
    const reason = disconnectReasons.has(input.reason) ? input.reason : "gateway_closed";
    lease.viewerStartBy = null;
    lease.viewerId = null;
    event(next, lease, "viewer_disconnected", { leaseId: lease.id, targetId: lease.targetId, reason });
    persist(next);
    return { disconnected: true };
  }

  async function release(actor, leaseId) {
    const context = requireBrowserActor(actor);
    sweep();
    const previous = ownerLease(context, leaseId, { active: false });
    if (previous.state !== "active") return { lease: publicLease(previous), gatewayCut: "unnecessary" };
    const next = structuredClone(ledger);
    const lease = next.leases.find((item) => item.id === leaseId);
    close(next, lease, "released", "owner_returned");
    persist(next);
    sweep();
    return { lease: publicLease(lease), gatewayCut: await cutGateway([leaseId]) };
  }

  async function stop(actor) {
    const context = requireBrowserActor(actor);
    sweep();
    const key = controlKey(context.workspaceId);
    const next = structuredClone(ledger);
    const closedIds = [];
    if (!next.controls[key]?.stopped) {
      next.controls[key] = { stopped: true };
      event(next, context, "workspace_stopped", { reason: "owner_stop" });
    }
    for (const lease of next.leases.filter((item) => item.workspaceId === context.workspaceId && item.state === "active")) {
      close(next, lease, "revoked", "owner_stop");
      closedIds.push(lease.id);
    }
    if (next.audit.length !== ledger.audit.length) persist(next);
    sweep();
    const gatewayCut = await cutGateway(closedIds);
    return { ...status(actor), gatewayCut };
  }

  function resume(actor) {
    const context = requireBrowserActor(actor);
    const next = structuredClone(ledger);
    const key = controlKey(context.workspaceId);
    if (next.controls[key]?.stopped) {
      next.controls[key] = { stopped: false };
      event(next, context, "workspace_resumed", { reason: "owner_resume" });
      persist(next);
    }
    return status(actor);
  }

  async function invalidateSession(actor) {
    const context = requireBrowserActor(actor);
    sweep();
    const next = structuredClone(ledger);
    const leases = next.leases.filter((item) => item.workspaceId === context.workspaceId &&
      item.ownerId === context.ownerId && item.sessionHash === context.sessionHash && item.state === "active");
    for (const lease of leases) close(next, lease, "revoked", "owner_signed_out");
    if (leases.length) persist(next);
    sweep();
    return { gatewayCut: await cutGateway(leases.map((lease) => lease.id)) };
  }

  sweep();
  return { status, acquire, connect, release, stop, resume, redeem, check, disconnect, invalidateSession };
}
