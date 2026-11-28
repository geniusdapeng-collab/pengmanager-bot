import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { hashAdminPassword } from '../src/security/admin-auth.mjs';
import { createBotCore } from '../src/bot/core.mjs';
import { createBotHttp } from '../src/bot/http.mjs';

const owner = { workspaceId: 'workspace', projectId: 'project', actorId: 'owner', role: 'owner' };
const system = { ...owner, actorId: 'clock', role: 'system' };
const now = Date.parse('2026-11-27T00:00:00Z');
const password = 'isolated-password-fixture';
const ownerPasswordHash = await hashAdminPassword(password);
const gatewayKey = 'g'.repeat(43);

async function host(t, options = {}) {
  const core = createBotCore({ clock: () => now });
  let handler;
  const server = createServer(async (request, response) => {
    if (await handler(request, response)) return;
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('host fallback');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sources = {
    list: () => [{ id: 'manual', label: 'Test owner submission', active: true }],
    submit(input) {
      return core.ingestEvent({ mandateId: input.mandateId, sourceId: 'manual', eventKey: input.externalId,
        payloadRef: 'test-source-ref', title: input.title }, system);
    },
  };
  handler = createBotHttp({ core, ctx: owner, ownerPasswordHash, origin, sources, clock: () => now, ...options });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    core.close();
  });
  const request = (path, options) => fetch(origin + path, { redirect: 'manual', ...options });
  async function login() {
    const response = await request('/api/bot/v1/session', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    });
    assert.equal(response.status, 201);
    const rawCookie = response.headers.get('set-cookie');
    return { cookie: rawCookie.split(';', 1)[0], rawCookie, session: await response.json() };
  }
  return { core, handler, origin, request, login };
}

function writeHeaders(origin, auth, key = 'fixture-idempotency', add = {}) {
  return {
    Origin: origin, 'Content-Type': 'application/json', Cookie: auth.cookie,
    'X-CSRF-Token': auth.session.csrfToken, 'Idempotency-Key': key, ...add,
  };
}

test('workbench serves bounded assets, reports missing sessions and reuses the owner login flow', async t => {
  const { request, origin } = await host(t);
  const shell = await request('/bot/');
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /frame-src 'self'/u);
  assert.match(shell.headers.get('content-security-policy'), /form-action 'self'/u);
  assert.match(await shell.text(), /经营工作台/u);
  const javascript = await request('/bot/workbench.js', { method: 'HEAD' });
  assert.equal(javascript.status, 200);
  assert.match(javascript.headers.get('content-type'), /^text\/javascript/u);
  assert.equal(await javascript.text(), '');
  assert.equal((await request('/bot')).headers.get('location'), '/bot/');
  assert.equal((await request('/admin')).status, 404);
  assert.equal(await (await request('/admin')).text(), 'host fallback');
  assert.equal((await request('/api/bot/v1/dashboard')).status, 401);
  assert.match(await (await request('/login')).text(), /name="password"/u);
  const signed = await request('/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
  });
  assert.equal(signed.status, 303);
  assert.equal(signed.headers.get('location'), '/bot/');
  const cookieHeader = signed.headers.get('set-cookie');
  assert.match(cookieHeader, /; HttpOnly; SameSite=Strict/u);
  const cookie = cookieHeader.split(';', 1)[0];
  const result = await request('/api/bot/v1/session', { headers: { Cookie: cookie } });
  assert.equal(result.status, 200);
  const resultDetails = await result.json();
  assert.equal(resultDetails.ownerId, owner.actorId);
  assert.equal(resultDetails.workspaceId, owner.workspaceId);
  assert.match(resultDetails.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(Object.hasOwn(resultDetails, 'sessionId'), false);
});

test('authenticated workbench enforces exact origin, CSRF, header idempotency, revision, and UTF-8 JSON', async t => {
  const { request, origin, login } = await host(t);
  const auth = await login();
  const input = { objective: 'Observe first-hand evidence', sources: ['manual'], requiredOutcomes: [] };
  const submit = async (route, value, add = {}) => request(`/api/bot/v1${route}`, {
    method: 'POST', headers: writeHeaders(origin, auth, add.key ?? 'mandate-create-001', add.headers),
    body: JSON.stringify(value),
  });
  assert.equal((await submit('/mandates', input, { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await submit('/mandates', input, { headers: { 'X-CSRF-Token': 'x'.repeat(43) } })).status, 403);
  assert.equal((await submit('/mandates', input, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await submit('/mandates', input, { headers: { 'Idempotency-Key': '' } })).status, 422);
  const confused = await request('/api/bot/v1/session', { headers: { Cookie: auth.cookie, Authorization: 'Bearer invalid' } });
  assert.equal(confused.status, 401);
  const preview = await submit('/mandates/preview', input);
  assert.equal((await preview.json()).draft, true);
  const created = await submit('/mandates', input);
  assert.equal(created.status, 201);
  const mandate = await created.json();
  const repeated = await (await submit('/mandates', input)).json();
  assert.equal(repeated.id, mandate.id);
  assert.equal((await submit('/mandates', { ...input, objective: 'Changed same key' })).status, 409);
  const untrustedTask = await submit('/tasks', {
    mandateId: mandate.id, title: 'Requested topic', kind: 'review', input: { adminOnly: true },
  }, { key: 'task-scope-probe' });
  assert.equal(untrustedTask.status, 422);
  assert.equal((await untrustedTask.json()).error.code, 'OWNER_TASK_INPUT_SCOPE');
  const discover = await submit('/tasks', { mandateId: mandate.id, title: 'Requested topic' }, { key: 'task-from-owner' });
  assert.equal(discover.status, 202);
  const requestTask = await discover.json();
  assert.equal(requestTask.steps[0].kind, 'discover');
  assert.equal(requestTask.input.provenance, 'owner_request');
  const sourced = await submit('/events', { mandateId: mandate.id, title: 'Test source', text: 'Fixture excerpt',
    externalId: 'first-source-key' }, { key: 'source-create-001' });
  assert.equal(sourced.status, 202);
  const accepted = (await sourced.json()).tasks[0];
  const deniedEdit = await submit(`/tasks/${accepted.id}/controls`, { action: 'pause' }, { key: 'task-pause-0001', headers: { 'If-Match': '0' } });
  assert.equal(deniedEdit.status, 412);
  const paused = await submit(`/tasks/${accepted.id}/controls`, { action: 'pause' }, {
    key: 'task-pause-0001', headers: { 'If-Match': String(accepted.revision) },
  });
  assert.equal((await paused.json()).state, 'paused');
  const dashboard = await (await request('/api/bot/v1/dashboard', { headers: { Cookie: auth.cookie } })).json();
  assert.equal(dashboard.channels.length, 28);
  assert.equal(dashboard.sources[0].id, 'manual');
  assert.equal(dashboard.mandates.length, 1);
  assert.equal(dashboard.tasks.find(row => row.id === accepted.id).state, 'paused');
  assert.equal(dashboard.dataMode, 'fixture');
  const alias = await request(`/bot/v1/mandates/${mandate.id}/outcomes`, { headers: { Cookie: auth.cookie } });
  assert.equal(alias.status, 200);
  assert.equal((await alias.json()).counts.publicVerified, 0);
});

test('retained events can reconnect with a monotonic SSE cursor under the owner session', async t => {
  const { core, request, login } = await host(t);
  const auth = await login();
  const mandate = core.createMandate({ objective: 'Test SSE no external calls', idempotencyKey: 'host-mandate' }, owner);
  const work = core.createTask({ mandateId: mandate.id, idempotencyKey: 'host-task' }, owner);
  const original = core.listEvents(work.id, {}, owner).at(-1).seq;
  core.controlTask(work.id, { action: 'pause', idempotencyKey: 'host-pause', expectedRevision: work.revision }, owner);
  const response = await request(`/api/bot/v1/tasks/${work.id}/events`, {
    headers: { Cookie: auth.cookie, Accept: 'text/event-stream', 'Last-Event-ID': String(original) },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/u);
  const reader = response.body.getReader();
  try {
    let received = '';
    for (let count = 0; count < 6 && !received.includes('task.paused'); count += 1) {
      const next = await reader.read();
      received += new TextDecoder().decode(next.value);
      if (next.done) break;
    }
    assert.match(received, /task.paused/u);
    assert.doesNotMatch(received, /task.accepted/u);
  } finally {
    await reader.cancel();
  }
});

test('browser control requires owner session binding, gateway requires its own key, and signout revokes session', async t => {
  let browserSession;
  const events = [];
  const browser = {
    status(actor) {
      browserSession = actor.sessionId;
      return { configured: true, stopped: false, targets: [] };
    },
    acquire(actor, input) {
      assert.equal(actor.sessionId, browserSession);
      return { lease: { id: 'lease-1', targetId: input.targetId } };
    },
    connect(actor, leaseId) {
      assert.equal(actor.sessionId, browserSession);
      assert.equal(leaseId, 'lease-1');
      return { viewerPath: '/bot-browser/connect', ticket: 'x'.repeat(43) };
    },
    check(secret, input) {
      if (secret !== gatewayKey) throw Object.assign(new Error('Gateway key denied.'), { status: 403, code: 'BROWSER_GATEWAY_DENIED' });
      return { allowed: input.viewerId === 'viewer-1' };
    },
    invalidateSession(actor) { events.push(actor.sessionId); },
  };
  const { request, origin, login, handler } = await host(t, { browser });
  assert.equal((await request('/api/bot/v1/browser')).status, 401);
  const auth = await login();
  assert.equal((await request('/api/bot/v1/browser', { headers: { Cookie: auth.cookie } })).status, 200);
  assert.equal(handler.isSessionActive(browserSession), true);
  const lease = await request('/api/bot/v1/browser/leases', {
    method: 'POST', headers: writeHeaders(origin, auth), body: JSON.stringify({ targetId: 'target-1', reason: 'review' }),
  });
  assert.equal(lease.status, 201);
  const connect = await request('/api/bot/v1/browser/leases/lease-1/connect', {
    method: 'POST', headers: writeHeaders(origin, auth), body: '{}',
  });
  assert.equal((await connect.json()).viewerPath, '/bot-browser/connect');
  const gateway = secret => request('/api/bot/v1/browser/internal/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Browser-Key': secret },
    body: JSON.stringify({ leaseId: 'lease-1', viewerId: 'viewer-1' }),
  });
  assert.equal((await gateway('bad')).status, 403);
  assert.equal((await (await gateway(gatewayKey)).json()).allowed, true);
  const logout = await request('/api/bot/v1/session', { method: 'DELETE', headers: writeHeaders(origin, auth) });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/u);
  assert.equal(handler.isSessionActive(browserSession), false);
  assert.deepEqual(events, [browserSession]);
  assert.equal((await request('/api/bot/v1/session', { headers: { Cookie: auth.cookie } })).status, 401);
});

test('the original owner reads a distinct unapproved revision from the task without charging or submitting', async t => {
  const digest = text => createHash('sha256').update(text).digest('hex');
  const jobId = 'CDJ-1234567890abcdef0123';
  const link = { jobId, sourceStepId: 'original', costId: 'cost-old', scopeStepId: 'scope', sourceSha256: digest('frozen') };
  const failure = { jobId, code: 'MODEL_OUTPUT_TRUNCATED' };
  const task = { id: 'task-1', mandateId: 'mandate', state: 'partial', steps: [
    { id: 'original', kind: 'prepare', key: 'private-draft', state: 'failed', output: failure },
    { id: 'continued', kind: 'prepare', key: 'bounded-draft-continuation', state: 'failed', output: failure, draftContinuation: link },
  ] };
  const wires = new Map();
  function bill(id, stepId, scene, finish) {
    const providerRef = 'model-' + id;
    const body = JSON.stringify({ id: providerRef, choices: [{ finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    const wire = { costId: id, requestKey: 'request-' + id, providerRef, body, responseHash: digest(body), actualMinor: 1, currency: 'CNY' };
    wires.set(id, wire);
    return { id, taskId: task.id, stepId, state: 'settled', providerRef, evidenceRef: wire.responseHash, actual: 1, currency: wire.currency,
      requestKey: wire.requestKey, providerTokenHold: { scene, inputTokens: 11, outputTokens: 5 } };
  }
  const paid = [bill('cost-old','original','content.repair','length'), bill('cost-first','continued','content.audit.article','stop'),
    bill('cost-last','continued','quality.final','length')];
  const mandate = { id: task.mandateId, ownerId: owner.actorId, workMode: 'draft_only' };
  const frozen = JSON.stringify({ task, paid });
  const core = { getTask: () => structuredClone(task), getMandate: () => mandate, listCosts: () => paid };
  const nativeCalls = [];
  const preview = { jobId, approved: false, stage: 'quality.final', code: failure.code, contentHash: digest('reviewed'),
    title: 'A reviewed revision', summary: 'Private summary', body: 'Private pending revision', characters: 22, editedBatches: 2,
    firstReview: { reportHash: digest('review'), minor: 1, major: 0, blocker: 0, suggestion: 0 }, reviewResponseId: 'model-cost-first' };
  const { request, login, origin } = await host(t, { core, readProviderReceipt: id => wires.get(id),
    async readReviewedRevision(id, source) { nativeCalls.push({ id, source }); return preview; } });
  const path = '/api/bot/v1/tasks/task-1/revision-preview';
  assert.equal((await request(path)).status, 401);
  const auth = await login();
  const headers = { Cookie: auth.cookie };
  assert.equal((await request(path+'?jobId=different', { headers })).status, 422);
  assert.equal((await request(path, { method: 'POST', headers: writeHeaders(origin, auth), body: '{}' })).status, 405);
  const metadata = await (await request(path.replace('/revision-preview',''), { headers })).json();
  assert.equal(metadata.canReadRevisionPreview, true);
  assert.equal(JSON.stringify(metadata).includes(preview.body), false);
  assert.equal(nativeCalls.length, 0);
  for (let i=0; i<2; i++) {
    const res = await request(path, { headers });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { taskId: task.id, ...preview });
  }
  assert.deepEqual(nativeCalls[0], { id: jobId, source: { sourceSha256: link.sourceSha256, scopeStepId: link.scopeStepId } });
  assert.equal(JSON.stringify({ task, paid }), frozen);
  mandate.ownerId = 'different-owner';
  assert.equal((await request(path, { headers })).status, 403);
  mandate.ownerId = owner.actorId;
  paid.at(-1).providerTokenHold.scene = 'content.repair';
  assert.equal((await request(path, { headers })).status, 409);
  paid.at(-1).providerTokenHold.scene = 'quality.final';
  const old = wires.get('cost-last');
  wires.set('cost-last', { ...old, body: old.body + ' ' });
  assert.equal((await request(path, { headers })).status, 409);
  wires.set('cost-last', old);
  const first = wires.get('cost-first');
  wires.set('cost-first', { ...first, requestKey: 'other-request' });
  assert.equal((await request(path, { headers })).status, 409);
  wires.set('cost-first', first);
  preview.approved = true;
  assert.equal((await request(path, { headers })).status, 409);
  preview.approved = false;
  task.steps[1].draftContinuation.sourceStepId = 'different-prepare';
  assert.equal((await request(path, { headers })).status, 409);
});
