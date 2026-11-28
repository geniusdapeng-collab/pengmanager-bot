import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { CHANNEL_IDS, BotError } from './core.mjs';
import { fail, identity, integer, object, key } from './core-store.mjs';
import { configuredOrigin, createOwnerSessions, validateSource } from './http-auth.mjs';

const WORKBENCH_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";
const ASSETS = {
  '/bot/': ['index.html', 'text/html; charset=utf-8'],
  '/bot/workbench.css': ['workbench.css', 'text/css; charset=utf-8'],
  '/bot/workbench.js': ['workbench.js', 'text/javascript; charset=utf-8'],
  '/bot/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
  '/bot/mandate-draft.js': ['mandate-draft.js', 'text/javascript; charset=utf-8'],
};
const BROWSER_EMPTY = Object.freeze({ configured: false, stopped: false, targets: [], leases: [], audit: [] });
const ID = '([A-Za-z0-9][A-Za-z0-9_.:@-]{0,159})';
const MANDATE_PATH = new RegExp(`^/mandates/${ID}(?:/(outcomes|revoke|renew))?$`, 'u');
const TASK_PATH = new RegExp(`^/tasks/${ID}(?:/(controls|events|decisions|owner-receipts|illustrations))?$`, 'u');
const BROWSER_LEASE = new RegExp(`^/browser/leases/${ID}/(connect|release)$`, 'u');
const NOTICE = new RegExp(`^/notifications/${ID}/ack$`, 'u');

function headers(extra = {}) {
  return {
    'Cache-Control': 'no-store', 'Content-Security-Policy': WORKBENCH_POLICY,
    'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()',
    ...extra,
  };
}

function answer(response, status, body, extra, head = false) {
  response.writeHead(status, headers(extra));
  response.end(head ? undefined : body);
}

function sendJson(response, status, value, extra = {}, head = false) {
  answer(response, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', ...extra }, head);
}

function method(request, ...allowed) {
  if (!allowed.includes(request.method)) fail(405, 'METHOD_NOT_ALLOWED', '此入口不支持该请求方式。', { allowed });
}

function selectedRoute(pathname) {
  if (pathname === '/bot' || pathname === '/bot/healthz' || pathname === '/login' || pathname === '/logout' ||
    Object.hasOwn(ASSETS, pathname) || pathname.startsWith('/bot/')) {
    if (pathname.startsWith('/bot/v1/')) return { pathname, api: pathname.slice('/bot/v1'.length) };
    return { pathname, api: null };
  }
  if (pathname === '/api/bot/v1' || pathname.startsWith('/api/bot/v1/')) {
    return { pathname, api: pathname.slice('/api/bot/v1'.length) || '/' };
  }
  return null;
}

async function readText(request, limit) {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    fail(413, 'BODY_TOO_LARGE', '请求过大，请提交证据引用。');
  }
  if (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity') {
    fail(415, 'UNSUPPORTED_CONTENT_TYPE', '此入口接收未压缩请求。');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    request.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new BotError(413, 'BODY_TOO_LARGE', '请求过大，请提交证据引用。'));
      } else chunks.push(chunk);
    });
    request.once('end', () => {
      if (done) return;
      try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { reject(new BotError(400, 'INVALID_ENCODING', '请求必须使用 UTF-8。')); }
    });
    request.once('aborted', () => reject(new BotError(400, 'REQUEST_ABORTED', '请求在接收前已中止。')));
    request.once('error', () => reject(new BotError(400, 'REQUEST_ABORTED', '无法读取请求。')));
  });
}

function requestMime(request) {
  const value = request.headers['content-type'];
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : null;
}

async function parseJson(request, limit = 262_144) {
  if (requestMime(request) !== 'application/json') fail(415, 'UNSUPPORTED_CONTENT_TYPE', '请提交 application/json。');
  const source = await readText(request, limit);
  let value;
  try { value = JSON.parse(source); }
  catch { fail(400, 'INVALID_JSON', '请求正文不是有效的 JSON。'); }
  return object(value, 'request body');
}

async function loginPassword(request, jsonMode) {
  if (jsonMode) return (await parseJson(request, 4096)).password;
  if (requestMime(request) !== 'application/x-www-form-urlencoded') {
    fail(415, 'UNSUPPORTED_CONTENT_TYPE', '请使用登录页面提交密码。');
  }
  const passwords = new URLSearchParams(await readText(request, 4096)).getAll('password');
  return passwords.length === 1 ? passwords[0] : null;
}

function loginDocument(issue = null, logout = false, csrf = '') {
  const action = logout ? '/logout' : '/login';
  const field = logout
    ? `<input type="hidden" name="csrf" value="${csrf}">`
    : '<label class="field">管理员密码<input name="password" type="password" autocomplete="current-password" required autofocus></label>';
  const title = logout ? '退出经营工作台' : '登录经营工作台';
  const button = logout ? '退出' : '登录';
  const alert = issue ? `<p class="message error" role="alert">${issue}</p>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>鹏经理 · ${title}</title>
    <link rel="stylesheet" href="/bot/workbench.css"></head><body><main id="workspace">
    <section class="panel"><h1>${title}</h1>${alert}<form action="${action}" class="form" method="post">${field}
    <button class="button" type="submit">${button}</button></form><p><a href="/bot/">回到经营工作台</a></p></section>
    </main></body></html>`;
}

function writeInput(request, input) {
  const idempotencyKey = key(request.headers['idempotency-key']);
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== idempotencyKey) {
    fail(409, 'IDEMPOTENCY_CONFLICT', '请求头与正文的幂等键不一致。');
  }
  const version = request.headers['if-match'];
  if (version !== undefined && input.expectedRevision !== undefined &&
    String(version).replaceAll('"', '') !== String(input.expectedRevision)) {
    fail(409, 'PRECONDITION_CONFLICT', '请求头与正文的版本不一致。');
  }
  return { ...input, idempotencyKey, ...(version === undefined ? {} : { ifMatch: version, expectedRevision: version }) };
}

function signedInResponse(ctx, session) {
  return { ownerId: ctx.actorId, workspaceId: ctx.workspaceId, projectId: ctx.projectId,
    csrfToken: session.csrfToken, expiresAt: session.expiresAt };
}

function channelRows(operations, reports) {
  const catalog = Array.isArray(operations?.catalog) ? operations.catalog : CHANNEL_IDS.map(id => ({ id }));
  const latest = reports.reduce((map, report) => {
    for (const row of report.channels ?? []) if (!map.has(row.channelId)) map.set(row.channelId, row);
    return map;
  }, new Map());
  return catalog.map(row => {
    const id = row.channelId ?? row.id;
    return { ...row, ...latest.get(id), channelId: id, id };
  });
}

function browserUnavailable() {
  fail(503, 'BROWSER_NOT_CONFIGURED', '此部署尚未配置云浏览器。');
}

export function createBotHttp({
  core, operations, browser, sources, ctx, ownerAuth, ownerPassword, ownerPasswordHash,
  origin, clock = Date.now, onError, validateCapability, readIllustrations, describeOnboarding,
} = {}) {
  const target = configuredOrigin(origin);
  const role = identity({ ...ctx, role: ctx?.role ?? 'owner' }, ['owner']);
  const sessions = createOwnerSessions({ target, ownerAuth, ownerPassword, ownerPasswordHash, clock, ctx: role });
  const streamCounts = new Map();
  const assets = new Map();

  function staticFile(pathname) {
    const current = assets.get(pathname);
    if (current) return current;
    const [file, mime] = ASSETS[pathname];
    const record = { body: readFileSync(new URL(`../../public/bot/${file}`, import.meta.url)), mime };
    assets.set(pathname, record);
    return record;
  }

  function dashboard() {
    const mandates = core.listMandates(role);
    const tasks = core.listTasks(role);
    const reports = mandates.map(mandate => core.outcomes(mandate.id, role));
    const outcomes = reports.flatMap(report => report.effects).sort((a, b) => (b.verifiedAt ?? b.consumedAt) - (a.verifiedAt ?? a.consumedAt));
    return {
      mandates, tasks, events: core.listProjectEvents?.(role) ?? [], channels: channelRows(operations, reports),
      notifications: core.listNotifications(role), costs: core.listCosts?.(role) ?? [],
      weeklyReports: reports.flatMap(report => report.reports.map(row => ({ id:row.id, mandateId:report.mandateId,
        periodStart:row.periodStart, periodEnd:row.periodEnd, dataMode:row.dataMode,
        due:row.autonomy?.due ?? null, autonomous:row.autonomy?.autonomous ?? null, missed:row.autonomy?.missed ?? null,
        humanMinutes:row.autonomy?.humanMinutes ?? null, recordedTimeEntries:row.autonomy?.recordedTimeEntries ?? 0,
        ownerTouches:row.counts.ownerTouches, publicVerified:row.counts.publicVerified }))).sort((a,b)=>b.periodEnd-a.periodEnd),
      outcomes, capabilities: core.listCapabilities(role), sources: sources?.list?.() ?? [],
      onboarding: describeOnboarding?.() ?? null,
      dataMode: core.health(role).dataMode, now: clock(),
    };
  }

  function streamEvents(request, response, taskId, session, query) {
    const at = query.get('after') ?? request.headers['last-event-id'] ?? '0';
    let cursor = integer(/^(0|[1-9]\d*)$/u.test(at) ? Number(at) : at, 'after');
    const initial = core.listEvents(taskId, { after: cursor, limit: 100 }, role);
    const count = streamCounts.get(session.sessionId) ?? 0;
    if (count >= 3) fail(429, 'EVENT_STREAM_LIMIT', '当前设备已经打开多个任务事件订阅。');
    streamCounts.set(session.sessionId, count + 1);
    response.writeHead(200, headers({ 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' }));
    response.write('retry: 2000\n\n');
    function writeRows(rows) {
      for (const row of rows) {
        cursor = row.seq;
        if (!response.write(`id: ${row.seq}\nevent: task\ndata: ${JSON.stringify(row)}\n\n`)) {
          response.end();
          return;
        }
      }
    }
    let pulses = 0;
    let closed = false;
    const timer = setInterval(() => {
      if (!sessions.isSessionActive(session.sessionId)) {
        response.end();
        return;
      }
      try {
        writeRows(core.listEvents(taskId, { after: cursor, limit: 100 }, role));
        pulses += 1;
        if (pulses % 15 === 0 && !response.write(': heartbeat\n\n')) response.end();
      } catch { response.end(); }
    }, 1000);
    timer.unref();
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      const open = streamCounts.get(session.sessionId) ?? 1;
      if (open > 1) streamCounts.set(session.sessionId, open - 1);
      else streamCounts.delete(session.sessionId);
    }
    response.once('close', close);
    response.once('finish', close);
    writeRows(initial);
  }

  async function invalidateBrowser(session) {
    if (!browser?.invalidateSession) return;
    try { await browser.invalidateSession(session.browserActor); }
    catch (error) { onError?.({ code: error?.code ?? 'BROWSER_DISCONNECT_FAILED', scope: 'browser-signout' }); }
  }

  async function browserInternal(request, response, action) {
    method(request, 'POST');
    if (!browser || !['redeem', 'check', 'disconnect'].includes(action)) browserUnavailable();
    const value = await parseJson(request, 4096);
    const result = await browser[action](request.headers['x-bot-browser-key'], value);
    sendJson(response, 200, result);
  }

  async function browserOwner(request, response, path, session) {
    const actor = session.browserActor;
    if (path === '/browser') {
      method(request, 'GET');
      sendJson(response, 200, browser ? await browser.status(actor) : BROWSER_EMPTY);
      return;
    }
    method(request, 'POST');
    if (!browser) browserUnavailable();
    sessions.requireCsrf(request, session);
    const input = writeInput(request, await parseJson(request, 8192));
    const lease = BROWSER_LEASE.exec(path);
    if (path === '/browser/leases') {
      sendJson(response, 201, await browser.acquire(actor, input));
      return;
    }
    if (lease) {
      sendJson(response, 200, await browser[lease[2]](actor, lease[1]));
      return;
    }
    const action = path === '/browser/stop' ? 'stop' : path === '/browser/resume' ? 'resume' : null;
    if (!action) fail(404, 'BOT_ROUTE_NOT_FOUND', '工作台入口不存在。');
    sendJson(response, 200, await browser[action](actor));
  }

  async function serveApi(request, response, path, query, session) {
    if (path === '/session') {
      method(request, 'GET', 'DELETE');
      if (request.method === 'GET') {
        sendJson(response, 200, signedInResponse(role, session));
      } else {
        sessions.requireCsrf(request, session);
        const cookie = await sessions.signOut(request, session);
        await invalidateBrowser(session);
        sendJson(response, 200, { authenticated: false }, { 'Set-Cookie': cookie });
      }
      return;
    }
    if (path === '/browser' || path.startsWith('/browser/')) {
      await browserOwner(request, response, path, session);
      return;
    }
    if (path === '/dashboard' || path === '/health') {
      method(request, 'GET');
      sendJson(response, 200, path === '/dashboard' ? dashboard() : core.health(role));
      return;
    }
    const mandate = MANDATE_PATH.exec(path);
    const task = TASK_PATH.exec(path);
    if (request.method === 'GET') {
      if (path === '/mandates') return sendJson(response, 200, { items: core.listMandates(role) });
      if (path === '/tasks') return sendJson(response, 200, { items: core.listTasks(role) });
      if (path === '/notifications') return sendJson(response, 200, { items: core.listNotifications(role) });
      if (path === '/capabilities') return sendJson(response, 200, { items: core.listCapabilities(role) });
      if (mandate && !mandate[2]) return sendJson(response, 200, core.getMandate(mandate[1], role));
      if (mandate?.[2] === 'outcomes') return sendJson(response, 200, core.outcomes(mandate[1], role));
      if (task && !task[2]) return sendJson(response, 200, core.getTask(task[1], role));
      if (task?.[2] === 'illustrations') {
        if (!readIllustrations) fail(503, 'ILLUSTRATION_INBOX_UNAVAILABLE', '此部署尚未接通配图工作单。');
        return sendJson(response, 200, await readIllustrations(core.getTask(task[1], role)));
      }
      if (task?.[2] === 'events') {
        if (request.headers.accept?.includes('text/event-stream')) {
          streamEvents(request, response, task[1], session, query);
          return;
        }
        const after = query.get('after');
        const limit = query.get('limit');
        return sendJson(response, 200, { items: core.listEvents(task[1],
          { after: after === null ? undefined : Number(after), limit: limit === null ? undefined : Number(limit) }, role) });
      }
      fail(404, 'BOT_ROUTE_NOT_FOUND', '工作台入口不存在。');
    }
    method(request, 'POST', 'PATCH', 'DELETE');
    sessions.requireCsrf(request, session);
    const input = writeInput(request, await parseJson(request));
    if (path === '/mandates/preview') {
      method(request, 'POST');
      return sendJson(response, 200, core.previewMandate(input, role));
    }
    if (path === '/mandates') {
      method(request, 'POST');
      return sendJson(response, 201, core.createMandate(input, role));
    }
    if (path === '/capabilities') {
      method(request, 'POST');
      if (core.health(role).dataMode === 'real' && !validateCapability) fail(503, 'NATIVE_CAPABILITY_UNAVAILABLE', '正式能力登记需要原生资格核验。');
      return sendJson(response, 201, core.recordCapability(validateCapability ? await validateCapability(input) : input, role));
    }
    if (path === '/tasks') {
      method(request, 'POST');
      const allowed = new Set(['idempotencyKey', 'mandateId', 'title', 'claimIds', 'deadlineAt']);
      if (Object.keys(input).some(field => !allowed.has(field))) fail(422, 'OWNER_TASK_INPUT_SCOPE', '从工作台新建任务只能提交主题和已审核事实引用。');
      const claims = input.claimIds ?? [];
      if (!Array.isArray(claims) || claims.length > 50 || claims.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/u.test(id))) {
        fail(422, 'OWNER_TASK_INPUT_SCOPE', '事实引用必须是已登记的准确编号。');
      }
      if (claims.length && (!operations?.native?.resolveClaims || (await operations.native.resolveClaims(claims)).length !== new Set(claims).size)) {
        fail(422, 'PUBLIC_CLAIM_REQUIRED', '请使用仍有效且已经审核的公开事实。');
      }
      return sendJson(response, 202, core.createTask({ mandateId: input.mandateId, title: input.title, deadlineAt: input.deadlineAt,
        kind: 'discover', idempotencyKey: input.idempotencyKey,
        input: { opportunity: { title: input.title, claimIds: [...new Set(claims)] }, provenance: 'owner_request' } }, role));
    }
    if (path === '/events') {
      method(request, 'POST');
      if (!sources?.submit) fail(503, 'SOURCE_INBOX_UNAVAILABLE', '此部署尚未接通信源收件箱。');
      const mandate = core.getMandate(input.mandateId, role);
      if (mandate.ownerId !== role.actorId) fail(403, 'OWNER_REQUIRED', '只有委托持有人可登记私有来源。');
      return sendJson(response, 202, await sources.submit(input, role));
    }
    if (mandate?.[2] === 'renew' || mandate && !mandate[2] && request.method === 'PATCH') {
      method(request, 'PATCH', 'POST');
      return sendJson(response, 200, core.renewMandate(mandate[1], input, role));
    }
    if (mandate?.[2] === 'revoke') {
      method(request, 'POST');
      return sendJson(response, 200, core.revokeMandate(mandate[1], input, role));
    }
    if (task?.[2] === 'controls') {
      method(request, 'POST');
      return sendJson(response, 200, core.controlTask(task[1], input, role));
    }
    if (task?.[2] === 'decisions') {
      method(request, 'POST');
      if (input.action === 'record_owner_submission') {
        const { action, ...receipt } = input;
        return sendJson(response, 201, core.recordOwnerSubmission({ ...receipt, action: input.publicationAction, taskId: task[1] }, role));
      }
      return sendJson(response, 200, core.confirmTarget({ ...input, taskId: task[1] }, role));
    }
    if (task?.[2] === 'owner-receipts') {
      method(request, 'POST');
      return sendJson(response, 201, core.recordOwnerSubmission({ ...input, taskId: task[1] }, role));
    }
    const notice = NOTICE.exec(path);
    if (notice) {
      method(request, 'POST');
      return sendJson(response, 200, core.ackNotification(notice[1], input, role));
    }
    fail(404, 'BOT_ROUTE_NOT_FOUND', '工作台入口不存在。');
  }

  async function servePage(request, response, path) {
    if (path === '/bot') {
      method(request, 'GET', 'HEAD');
      return answer(response, 308, '', { Location: '/bot/' }, request.method === 'HEAD');
    }
    if (path === '/bot/healthz') {
      method(request, 'GET', 'HEAD');
      return sendJson(response, 200, { ok: true, service: 'pengmanager-bot' }, {}, request.method === 'HEAD');
    }
    if (Object.hasOwn(ASSETS, path)) {
      method(request, 'GET', 'HEAD');
      const { body, mime } = staticFile(path);
      return answer(response, 200, body, { 'Content-Type': mime }, request.method === 'HEAD');
    }
    if (path === '/login') {
      method(request, 'GET', 'HEAD', 'POST');
      if (request.method !== 'POST') {
        return answer(response, 200, loginDocument(), { 'Content-Type': 'text/html; charset=utf-8' }, request.method === 'HEAD');
      }
      try {
        const session = await sessions.signIn(request, await loginPassword(request, false));
        return answer(response, 303, '', { Location: '/bot/', 'Set-Cookie': session.cookie });
      } catch (error) {
        const status = error?.status;
        if (![401, 429, 503].includes(status)) throw error;
        const message = status === 401 ? '密码不正确。' : status === 429 ? '登录尝试过多，请稍后再试。' : '登录服务暂不可用。';
        const retryAfter = error.details?.retryAfterSeconds;
        return answer(response, status, loginDocument(message), {
          'Content-Type': 'text/html; charset=utf-8', ...(Number.isSafeInteger(retryAfter) ? { 'Retry-After': String(retryAfter) } : {}),
        });
      }
    }
    if (path === '/logout') {
      method(request, 'GET', 'POST');
      const session = await sessions.check(request);
      if (request.method === 'GET') return answer(response, 200, loginDocument(null, true, session.csrfToken), { 'Content-Type': 'text/html; charset=utf-8' });
      if (requestMime(request) !== 'application/x-www-form-urlencoded') fail(415, 'UNSUPPORTED_CONTENT_TYPE', '请使用退出页面。');
      const submitted = new URLSearchParams(await readText(request, 4096)).getAll('csrf');
      const csrfRequest = { headers: { ...request.headers, 'x-csrf-token': submitted.length === 1 ? submitted[0] : '' } };
      sessions.requireCsrf(csrfRequest, session);
      const cookie = await sessions.signOut(request, session);
      await invalidateBrowser(session);
      return answer(response, 303, '', { Location: '/bot/', 'Set-Cookie': cookie });
    }
    fail(404, 'BOT_ROUTE_NOT_FOUND', '工作台资源不存在。');
  }

  async function handler(request, response) {
    if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//')) return false;
    let url;
    try { url = new URL(request.url, target); }
    catch { return false; }
    const route = selectedRoute(url.pathname);
    if (!route) return false;
    const internal = route.api?.startsWith('/browser/internal/');
    const mutating = !['GET', 'HEAD'].includes(request.method);
    try {
      validateSource(request, target, { mutation: mutating, privateApi: route.api !== null, gateway: internal });
      if (internal) {
        await browserInternal(request, response, route.api.slice('/browser/internal/'.length));
      } else if (route.api === '/session' && request.method === 'POST') {
        const session = await sessions.signIn(request, await loginPassword(request, true));
        sendJson(response, 201, signedInResponse(role, session), { 'Set-Cookie': session.cookie });
      } else if (route.api !== null) {
        const session = await sessions.check(request);
        await serveApi(request, response, route.api, url.searchParams, session);
      } else {
        await servePage(request, response, route.pathname);
      }
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return true;
      }
      const status = Number.isSafeInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      const recognized = /^[A-Z0-9_]{2,80}$/u.test(error?.code ?? '');
      const code = recognized && status !== 500 ? error.code : 'BOT_HTTP_FAILED';
      if (status >= 500) onError?.({ code, scope: internal ? 'browser-gateway' : 'bot-workbench' });
      const extra = {};
      if (status === 405 && Array.isArray(error.details?.allowed)) extra.Allow = error.details.allowed.join(', ');
      if (status === 429 && Number.isSafeInteger(error.details?.retryAfterSeconds)) extra['Retry-After'] = String(error.details.retryAfterSeconds);
      sendJson(response, status, { error: { code, message: status === 500 ? '工作台暂时无法处理请求。' : error.message,
        ...(status < 500 && error.details ? { details: error.details } : {}) } }, extra, request.method === 'HEAD');
    }
    return true;
  }

  handler.isSessionActive = sessions.isSessionActive;
  return handler;
}
