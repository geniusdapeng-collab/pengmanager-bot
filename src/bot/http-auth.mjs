import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createAdminAuth, hashAdminPassword } from '../security/admin-auth.mjs';
import { fail } from './core-store.mjs';

const SESSION_VALUE = /^[A-Za-z0-9_-]{43}$/u;
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1']);

export function configuredOrigin(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new TypeError('A concrete BOT origin is required.'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new TypeError('The BOT origin must be HTTPS or trusted loopback HTTP.');
  }
  return url;
}

export function validateSource(request, target, { mutation = false, privateApi = false, gateway = false } = {}) {
  const host = request.headers.host;
  const loopbackGateway = gateway && LOOPBACK.has(request.socket?.remoteAddress);
  if (typeof host !== 'string' || !host || /[\s\\/@?#,]/u.test(host)) fail(400, 'HOST_INVALID', '请求主机无效。');
  if (host.toLowerCase() !== target.host.toLowerCase() && !loopbackGateway) fail(403, 'HOST_NOT_ALLOWED', '请求主机未获得许可。');
  if (gateway) return;
  const site = request.headers['sec-fetch-site'];
  const origin = request.headers.origin;
  if ((privateApi || mutation) && site === 'cross-site' || origin !== undefined && origin !== target.origin) {
    fail(403, 'CROSS_ORIGIN_REQUEST_BLOCKED', '从工作台所在站点发起操作。');
  }
  if (!mutation || origin === target.origin) return;
  const referer = request.headers.referer;
  let refererOrigin = null;
  try { refererOrigin = referer && new URL(referer).origin; }
  catch { fail(403, 'CROSS_ORIGIN_REQUEST_BLOCKED', '请求来源无效。'); }
  if (refererOrigin !== target.origin) fail(403, 'CROSS_ORIGIN_REQUEST_BLOCKED', '需要能够核对的同源请求。');
}

function readCookie(headers, name) {
  const parts = typeof headers.cookie === 'string' && headers.cookie.length <= 8192 ? headers.cookie.split(';') : [];
  const matches = parts.map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(name.length + 1);
  return SESSION_VALUE.test(token) ? token : null;
}

function compare(left, right) {
  return typeof left === 'string' && typeof right === 'string' && SESSION_VALUE.test(left) &&
    SESSION_VALUE.test(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function createOwnerSessions({ target, ownerAuth = null, ownerPassword, ownerPasswordHash, clock, ctx }) {
  const secure = target.protocol === 'https:';
  const cookieName = ownerAuth?.cookieName ?? (secure ? '__Host-pengmanager_bot_session' : 'pengmanager_bot_session');
  const secret = randomBytes(32);
  const active = new Map();
  let suppliedPassword = ownerPassword;
  let initialized;

  function derive(token, purpose) {
    return createHmac('sha256', secret).update(purpose).update(':').update(token).digest('base64url');
  }

  function configuredAuth(encoded) {
    return createAdminAuth({
      host: target.hostname,
      allowedHosts: [target.hostname],
      env: { ADMIN_PASSWORD_HASH: encoded, ...(secure ? { PUBLIC_ORIGIN: target.origin } : {}) },
      clock,
    });
  }

  async function getAuth() {
    if (ownerAuth) return ownerAuth;
    if (!initialized) {
      const plaintext = suppliedPassword;
      suppliedPassword = undefined;
      initialized = (async () => {
        if (ownerPasswordHash) return configuredAuth(ownerPasswordHash);
        if (typeof plaintext === 'string' && plaintext.length) return configuredAuth(await hashAdminPassword(plaintext));
        return null;
      })();
    }
    try { return await initialized; }
    catch { fail(503, 'AUTH_UNAVAILABLE', '工作台登录配置不可用。'); }
  }

  function adaptRequest(request, auth, token) {
    const headers = { ...request.headers };
    delete headers.authorization;
    delete headers.cookie;
    if (token) headers.cookie = `${auth.cookieName}=${token}`;
    return { headers, method: request.method, socket: request.socket, url: request.url };
  }

  function translateCookie(value, auth) {
    if (!value.startsWith(`${auth.cookieName}=`)) fail(503, 'AUTH_UNAVAILABLE', '会话未能签发。');
    return `${cookieName}${value.slice(auth.cookieName.length)}`;
  }

  function snapshot(auth, token) {
    return {
      url: '/api/bot/v1/session', method: 'GET', socket: { encrypted: secure },
      headers: { host: target.host, cookie: `${auth.cookieName}=${token}` },
    };
  }

  function isSessionActive(sessionId) {
    const row = typeof sessionId === 'string' && active.get(sessionId);
    if (!row) return false;
    if (row.expiresAt <= clock()) {
      active.delete(sessionId);
      return false;
    }
    try {
      const state = row.auth.status(row.request);
      if (state.authenticated === true && state.method === 'session') return true;
    } catch {
      active.delete(sessionId);
      return false;
    }
    active.delete(sessionId);
    return false;
  }

  async function check(request) {
    if (request.headers.authorization !== undefined) fail(401, 'AUTH_REQUIRED', '请先登录管理员会话。');
    const token = readCookie(request.headers, cookieName);
    const auth = await getAuth();
    if (!auth?.enabled || !token) fail(401, 'AUTH_REQUIRED', '请先登录管理员会话。');
    const adapted = adaptRequest(request, auth, token);
    const principal = auth.requireAccess(adapted, '/api/bot/v1/session');
    if (principal.method !== 'session') fail(401, 'AUTH_REQUIRED', '请先登录管理员会话。');
    const sessionId = derive(token, 'browser-session');
    const expiresAt = Date.parse(principal.expiresAt);
    for (const [id, value] of active) if (value.expiresAt <= clock()) active.delete(id);
    if (active.size >= 1000 && !active.has(sessionId)) active.delete(active.keys().next().value);
    active.set(sessionId, { expiresAt, auth, request: snapshot(auth, token) });
    return { sessionId, csrfToken: derive(token, 'csrf'), expiresAt, browserActor: { ownerId: ctx.actorId, workspaceId: ctx.workspaceId, sessionId } };
  }

  async function signIn(request, password) {
    const auth = await getAuth();
    if (!auth?.enabled) fail(503, 'AUTH_UNAVAILABLE', '工作台管理员登录尚未配置。');
    if (request.headers.authorization !== undefined) fail(401, 'AUTH_REQUIRED', '请使用管理员密码登录。');
    const oldToken = readCookie(request.headers, cookieName);
    const result = await auth.login(adaptRequest(request, auth, oldToken), password);
    const token = readCookie({ cookie: result.cookie }, auth.cookieName);
    if (!token) fail(503, 'AUTH_UNAVAILABLE', '会话未能签发。');
    if (oldToken) active.delete(derive(oldToken, 'browser-session'));
    return { cookie: translateCookie(result.cookie, auth), csrfToken: derive(token, 'csrf'), expiresAt: result.expiresAt };
  }

  async function signOut(request, session) {
    const auth = await getAuth();
    const token = readCookie(request.headers, cookieName);
    active.delete(session.sessionId);
    return translateCookie(auth.logout(adaptRequest(request, auth, token)), auth);
  }

  function requireCsrf(request, session) {
    const received = request.headers['x-csrf-token'] ?? request.headers['x-bot-csrf'];
    if (!compare(received, session.csrfToken)) fail(403, 'CSRF_REQUIRED', '刷新工作台并使用当前会话重新操作。');
  }

  return { check, signIn, signOut, requireCsrf, isSessionActive };
}
