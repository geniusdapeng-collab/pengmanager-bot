import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { equalBrowserSecret } from "./browser-service.mjs";

const prefix = "/bot-browser";
const cookieName = "__Secure-pm_bot_viewer";
const opaque = /^[A-Za-z0-9_-]{43,128}$/;
const targetPattern = /^[A-Za-z0-9_.:@-]{1,128}$/;
const viewerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../deploy/bot-browser");
const labels = {
  "/viewer": ["viewer.html", "text/html; charset=utf-8"],
  "/viewer.js": ["viewer.js", "text/javascript; charset=utf-8"],
  "/viewer.css": ["viewer.css", "text/css; charset=utf-8"],
};

function browserHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseOrigin(value, { secure = false } = {}) {
  const parsed = new URL(value);
  const protocols = secure ? ["https:"] : ["http:", "https:"];
  if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("Expected an exact gateway HTTP(S) origin.");
  }
  return parsed.origin;
}

function requestFailure(status, message) {
  return Object.assign(new Error(message), { status });
}

async function body(request, contentType) {
  if (String(request.headers["content-type"] || "").split(";")[0].trim() !== contentType) {
    throw requestFailure(415, "提交格式无效。");
  }
  const length = Number(request.headers["content-length"] || 0);
  if (!Number.isFinite(length) || length < 0 || length > 2048) throw requestFailure(413, "提交内容过长。");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2048) throw requestFailure(413, "提交内容过长。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function cookieToken(request) {
  const values = String(request.headers.cookie || "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(cookieName + "="));
  const token = values.length === 1 ? values[0].slice(cookieName.length + 1) : "";
  return opaque.test(token) ? token : "";
}

export function createBotBrowserGateway({
  WebSocketServer,
  publicOrigin,
  authorityOrigin,
  gatewaySecret,
  targetId,
  vncSocketPath = "/run/pengmanager-browser/rfb.sock",
  novncRoot = "/usr/share/novnc",
  fetchImpl = fetch,
  connectUpstream = connect,
  now = Date.now,
  pollMs = 1500,
  idleMs = 5 * 60_000,
} = {}) {
  const origin = parseOrigin(publicOrigin, { secure: true });
  const authority = parseOrigin(authorityOrigin);
  if (!opaque.test(gatewaySecret) || !targetPattern.test(targetId) ||
      typeof vncSocketPath !== "string" || !vncSocketPath.startsWith("/") || vncSocketPath.length > 100 ||
      !Number.isInteger(pollMs) || pollMs < 30 || pollMs > 2000 ||
      !Number.isInteger(idleMs) || idleMs < 100) {
    throw new TypeError("Browser gateway requires a dedicated target, local VNC socket, and shared service key.");
  }
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 131072 });
  const viewers = new Map();
  const wssOrigin = origin.replace(/^https:/, "wss:");
  const secureHeaders = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${wssOrigin}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Permissions-Policy": "clipboard-read=(), clipboard-write=(), camera=(), microphone=(), geolocation=()",
  };

  function answer(response, status, content = "", type = "text/plain; charset=utf-8", extra = {}) {
    response.writeHead(status, { ...secureHeaders, ...extra, "Content-Type": type });
    response.end(content);
  }

  async function authorize(action, fields) {
    const response = await fetchImpl(new URL(`/api/bot/v1/browser/internal/${action}`, authority), {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "X-Bot-Browser-Key": gatewaySecret },
      body: JSON.stringify(fields),
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) throw requestFailure(response.status === 403 ? 403 : 503, "接管验证未通过。");
    return response.json();
  }

  function remove(view, reason) {
    if (!viewers.delete(view.key)) return;
    if (view.timer) clearTimeout(view.timer);
    if (view.socket?.readyState === 1) view.socket.close(1000, reason);
    view.upstream?.destroy();
    authorize("disconnect", { leaseId: view.leaseId, viewerId: view.viewerId, reason }).catch(() => {
      // If the authority is unreachable, the next successful policy check or lease expiry closes its ledger entry.
      return null;
    });
  }

  function entry(request) {
    const token = cookieToken(request);
    const view = token ? viewers.get(browserHash(token)) : undefined;
    if (view && view.expires > now()) return view;
    if (view) remove(view, "gateway_closed");
    return null;
  }

  function requireSameOrigin(request) {
    if (request.headers.origin !== origin) throw requestFailure(403, "需要从同源经营工作台打开。");
  }

  async function asset(response, suffix) {
    const known = labels[suffix];
    const match = suffix.match(/^\/lib\/((?:core|vendor)\/[A-Za-z0-9_/-]+(?:[.][A-Za-z0-9_-]+)*[.]js)$/);
    if (!known && !match) return false;
    const file = known ? resolve(viewerRoot, known[0]) : resolve(novncRoot, match[1]);
    try {
      const data = await readFile(file);
      answer(response, 200, data, known?.[1] || "text/javascript; charset=utf-8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      answer(response, 503, "观察端静态组件未安装。");
    }
    return true;
  }

  async function handle(request, response) {
    const method = request.method;
    const path = request.url;
    if (path === "/internal/revoke" && method === "POST") {
      if (!equalBrowserSecret(gatewaySecret, request.headers["x-bot-browser-key"])) throw requestFailure(403, "无权操作。");
      const leaseIds = JSON.parse(await body(request, "application/json"))?.leaseIds;
      if (!Array.isArray(leaseIds) || leaseIds.length > 50 || leaseIds.some((id) => !targetPattern.test(id))) {
        throw requestFailure(422, "租约无效。");
      }
      for (const view of viewers.values()) {
        if (leaseIds.includes(view.leaseId)) remove(view, "gateway_closed");
      }
      return answer(response, 204);
    }
    if (path === prefix + "/connect" && method === "POST") {
      requireSameOrigin(request);
      const fields = new URLSearchParams(await body(request, "application/x-www-form-urlencoded"));
      const tickets = fields.getAll("ticket");
      if (tickets.length !== 1 || !opaque.test(tickets[0])) throw requestFailure(403, "接管票据无效。");
      const grant = await authorize("redeem", { ticket: tickets[0] });
      if (grant.targetId !== targetId || !targetPattern.test(grant.leaseId) || !targetPattern.test(grant.viewerId) ||
          !(Date.parse(grant.expiresAt) > now())) {
        if (grant.leaseId && grant.viewerId) {
          await authorize("disconnect", { leaseId: grant.leaseId, viewerId: grant.viewerId, reason: "worker_unavailable" });
        }
        throw requestFailure(503, "未找到准确的远端工位。");
      }
      const token = randomBytes(32).toString("base64url");
      const key = browserHash(token);
      const view = { key, leaseId: grant.leaseId, viewerId: grant.viewerId, expires: Date.parse(grant.expiresAt),
        lastActivity: now(), pending: false };
      viewers.set(key, view);
      view.timer = setTimeout(() => remove(view, "not_connected"), Math.min(45_000, view.expires - now()));
      return answer(response, 303, "", "text/plain; charset=utf-8", {
        Location: prefix + "/viewer",
        "Set-Cookie": `${cookieName}=${token}; Path=${prefix}/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil((view.expires - now()) / 1000)}`,
      });
    }
    if (path === prefix + "/activity" && method === "POST") {
      requireSameOrigin(request);
      const view = entry(request);
      await body(request, "application/x-www-form-urlencoded");
      if (!view?.socket || !viewers.has(view.key)) throw requestFailure(409, "接管画面已结束。");
      view.lastActivity = now();
      return answer(response, 204);
    }
    if (!path.startsWith(prefix + "/") || method !== "GET") throw requestFailure(404, "未找到此入口。");
    const suffix = path.slice(prefix.length);
    if (suffix === "/viewer" && !entry(request)) throw requestFailure(403, "接管画面已经过期。请回工作台重新打开。");
    if (!await asset(response, suffix)) throw requestFailure(404, "未找到此入口。");
  }

  const server = createServer({ requestTimeout: 8_000, headersTimeout: 5_000, maxHeaderSize: 12_000 }, (request, response) => {
    handle(request, response).catch((error) => {
      const status = error.status ?? (error instanceof SyntaxError ? 400 : 503);
      if (!response.headersSent && !response.destroyed) answer(response, status, error.status ? error.message : "暂时无法连接工位。");
    });
  });

  function room(view, ws) {
    clearTimeout(view.timer);
    view.socket = ws;
    view.pending = false;
    const upstream = connectUpstream({ path: vncSocketPath });
    view.upstream = upstream;
    let grantedUntil = 0;
    let upstreamReady = false;
    let pendingBytes = 0;
    const queue = [];
    const terminate = (why) => remove(view, why);

    const enforce = async (first = false) => {
      if (!viewers.has(view.key)) return;
      if (view.expires <= now()) return terminate("gateway_closed");
      if (view.lastActivity + idleMs <= now()) return terminate("viewer_idle");
      try {
        const result = await authorize("check", { leaseId: view.leaseId, viewerId: view.viewerId, connected: first });
        if (!viewers.has(view.key)) return;
        if (result.allowed !== true || result.targetId !== targetId || Date.parse(result.expiresAt) <= now()) {
          return terminate("gateway_closed");
        }
        grantedUntil = Math.min(view.expires, now() + pollMs + 1000);
        if (first) {
          upstreamReady = true;
          for (const packet of queue) upstream.write(packet);
          queue.length = 0;
          upstream.resume();
        }
        view.timer = setTimeout(() => { enforce(); }, pollMs);
      } catch {
        terminate("gateway_closed");
      }
    };
    upstream.pause();
    upstream.setTimeout(5000, () => terminate("worker_unavailable"));
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      enforce(true);
    });
    upstream.on("data", (chunk) => {
      if (!viewers.has(view.key)) return;
      if (ws.readyState !== 1 || now() > grantedUntil || ws.bufferedAmount > 4 * 1024 * 1024) return terminate("gateway_closed");
      ws.send(chunk, { binary: true }, (error) => {
        if (error) terminate("gateway_closed");
      });
    });
    ws.on("message", (packet, binary) => {
      if (!viewers.has(view.key)) return;
      if (!binary || (upstreamReady && now() > grantedUntil) || upstream.writableLength > 1024 * 1024) return terminate("gateway_closed");
      if (upstreamReady) {
        upstream.write(packet);
        return;
      }
      pendingBytes += packet.length;
      if (pendingBytes > 131072) return terminate("gateway_closed");
      queue.push(packet);
    });
    upstream.on("error", () => terminate("worker_unavailable"));
    upstream.on("close", () => terminate("worker_unavailable"));
    ws.on("error", () => terminate("gateway_closed"));
    ws.on("close", () => terminate("viewer_closed"));
  }

  server.on("upgrade", (request, socket, head) => {
    const view = request.headers.origin === origin && request.url === prefix + "/socket" ? entry(request) : null;
    if (!view || view.pending || view.socket) return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    view.pending = true;
    socket.on("error", () => remove(view, "gateway_closed"));
    authorize("check", { leaseId: view.leaseId, viewerId: view.viewerId }).then((result) => {
      if (!viewers.has(view.key) || result.allowed !== true || result.targetId !== targetId ||
          !(Date.parse(result.expiresAt) > now())) {
        remove(view, "gateway_closed");
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => room(view, ws));
    }).catch(() => {
      remove(view, "gateway_closed");
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    });
  });

  server.on("close", () => {
    for (const view of viewers.values()) remove(view, "gateway_closed");
    wss.close();
  });

  return server;
}
