import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { runHealthProbe } from '../src/bot/health-probe.mjs';

const runChild = promisify(execFile);
const app = join(import.meta.dirname, '..');
const fixtureToken = 'fixture-probe-receiver-only';

function directory(t) {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'bot-probe-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function readyResponse(ready = true) {
  return Response.json({ service: 'pengmanager-bot', ready });
}

function settings(t) {
  return { origin: 'https://bot.example.test', receiverUrl: 'https://owner.example.test/probe-inbox',
    monitorId: 'test-bot', token: fixtureToken, stateDirectory: directory(t) };
}

test('one failed health read is tolerated and a ready reply must identify PengManager', async t => {
  const options = settings(t);
  let response = () => Response.redirect('https://elsewhere.example.test/healthz');
  const run = () => runHealthProbe({ ...options, fetchImpl: async (url, request) => {
    assert.equal(url.href, options.origin + '/healthz');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.headers.Authorization, undefined);
    return response();
  } });
  assert.equal((await run()).reason, 'http_302');
  response = readyResponse;
  assert.equal((await run()).failures, 0);
  response = () => Response.json({ ready: true });
  assert.equal((await run()).reason, 'invalid_health_receipt');
  response = readyResponse;
  assert.deepEqual(await run(), { health: 'ready', reason: null, failures: 0, notification: 'idle', pending: 0 });
  await assert.rejects(runHealthProbe({ ...options, receiverUrl: 'http://receiver.example.test' }), { code: 'PROBE_INVALID_ENDPOINT' });
  await assert.rejects(runHealthProbe({ ...options, token: 'unsafe\nheader' }), { code: 'PROBE_INVALID_CREDENTIAL' });
  await assert.rejects(runHealthProbe({ ...options, monitorId: 'wrong-name' }), { code: 'PROBE_STATE_TARGET_CHANGED' });
});

test('lost and restored alerts survive process restarts and retry the identical event after unknown receipt', async t => {
  const options = settings(t);
  let now = 1000;
  let up = false;
  const calls = [];
  function fetchImpl(url, request) {
    if (url.pathname === '/healthz') return up ? readyResponse() : new Response(null, { status: 503 });
    const payload = JSON.parse(request.body);
    assert.equal(url.href, options.receiverUrl);
    assert.equal(request.redirect, 'error');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, 'Bearer ' + fixtureToken);
    assert.equal(request.headers['Idempotency-Key'], payload.id);
    assert.ok(!request.body.includes(fixtureToken) && !request.body.includes(new URL(options.origin).hostname));
    calls.push(payload);
    if (calls.length === 1) throw new Error('fixture: receiver consumed the event and disconnected');
    if (calls.length === 2) return Response.json({ id: 'wrong-id', receiptId: 'old-receipt' });
    return Response.json({ id: payload.id, receiptId: 'receipt-' + calls.length });
  }
  const run = async at => { now = at; return runHealthProbe({ ...options, clock: () => now, fetchImpl }); };
  assert.equal((await run(1000)).notification, 'idle');
  assert.equal((await run(2000)).notification, 'delivery_failed');
  assert.equal(calls[0].reason, 'http_503');
  assert.equal(calls[0].firstFailureAt, 1000);
  assert.equal((await run(10_000)).notification, 'retry_scheduled');
  up = true;
  assert.equal((await run(20_000)).pending, 2);
  assert.equal(calls.length, 1);
  assert.equal((await run(32_000)).notification, 'delivery_failed');
  assert.equal((await run(91_999)).notification, 'retry_scheduled');
  assert.equal((await run(92_000)).pending, 1);
  assert.deepEqual(calls.slice(1, 3), [calls[0], calls[0]]);
  assert.equal((await run(93_000)).pending, 0);
  assert.equal(calls[3].type, 'bot_health_restored');
  assert.equal(calls[3].incidentId, calls[0].incidentId);
  assert.equal(calls[3].observedAt, 20_000);
  assert.notEqual(calls[3].id, calls[0].id);
  assert.equal((await run(95_000)).notification, 'idle');
  assert.equal(calls.length, 4);
  const db = new DatabaseSync(join(options.stateDirectory, 'health-probe.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT receipt_id FROM outbox ORDER BY sequence').all().map(row => row.receipt_id),
      ['receipt-3', 'receipt-4']);
  } finally { db.close(); }
});

test('concurrent probes cannot record stale observations after the durable lease changes', async t => {
  const options = settings(t);
  let now = 1000;
  const original = Promise.withResolvers();
  const run = fetchImpl => runHealthProbe({ ...options, clock: () => now, fetchImpl });
  const old = run(() => original.promise);
  assert.deepEqual(await run(() => assert.fail('second process must stay idle')), { health: 'busy', notification: 'idle' });
  now += 61_000;
  assert.equal((await run(() => readyResponse())).health, 'ready');
  original.resolve(readyResponse(false));
  await assert.rejects(old, { code: 'PROBE_LEASE_LOST' });
  assert.equal((await run(() => readyResponse())).failures, 0);
});

async function listener(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function halt(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit');
  child.kill('SIGTERM');
  await closed;
}

async function waitForBot(child, origin) {
  for (let i = 0; i < 80 && child.exitCode === null; i++) {
    const ready = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(200) })
      .then(response => response.ok && response.json()).catch(() => false);
    if (ready?.service === 'pengmanager-bot' && ready.ready === true) return;
    await wait(50);
  }
  assert.fail('fixture BOT did not become ready');
}

test('independent executable delivers an outage and recovery over TLS with the actual BOT stopped and restarted', { timeout: 30_000 }, async t => {
  const root = directory(t);
  const socket = createSocket();
  const port = await listener(socket);
  await close(socket);
  const origin = 'http://127.0.0.1:' + port;
  const certificates = join(root, 'localhost.cnf');
  const cert = join(root, 'localhost.pem');
  const key = join(root, 'localhost.key');
  writeFileSync(certificates, `[req]\ndistinguished_name=dn\n[dn]\n[local]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1',
    '-config', certificates, '-extensions', 'local', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const notified = [];
  const receiver = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const event = JSON.parse(body);
    notified.push({ event, credential: request.headers.authorization, key: request.headers['idempotency-key'] });
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      .end(JSON.stringify({ id: event.id, receiptId: 'isolated-receipt' }));
  });
  const receiverPort = await listener(receiver);
  const credentialDir = join(root, 'service-credentials');
  mkdirSync(credentialDir, { mode: 0o700 });
  const receiverUrl = 'https://127.0.0.1:' + receiverPort + '/fixture-hook';
  writeFileSync(join(credentialDir, 'BOT_HEALTH_WEBHOOK_URL'), receiverUrl, { mode: 0o600 });
  writeFileSync(join(credentialDir, 'BOT_HEALTH_WEBHOOK_TOKEN'), fixtureToken, { mode: 0o600 });
  const probeEnv = { BOT_HEALTH_ORIGIN: origin, BOT_HEALTH_MONITOR_ID: 'host-integration',
    STATE_DIRECTORY: join(root, 'probe'), CREDENTIALS_DIRECTORY: credentialDir, NODE_EXTRA_CA_CERTS: cert };
  async function run() {
    const { stdout, stderr } = await runChild(process.execPath, ['scripts/bot-health.mjs'], { cwd: app, env: probeEnv, timeout: 10_000 });
    assert.ok(!(stdout + stderr).includes(fixtureToken) && !(stdout + stderr).includes(receiverUrl));
    return JSON.parse(stdout);
  }
  const boot = () => spawn(process.execPath, ['src/bot/host.mjs'], { cwd: app, stdio: 'ignore',
    env: { BOT_MODE: 'fixture', BOT_DATA_DIR: join(root, 'bot'), BOT_ORIGIN: origin, PORT: String(port) } });
  let child = boot();
  try {
    await waitForBot(child, origin);
    assert.equal((await run()).health, 'ready');
    await halt(child);
    assert.equal((await run()).notification, 'idle');
    const outage = await run();
    assert.equal(outage.health, 'unavailable');
    assert.equal(outage.notification, 'delivered');
    await run();
    child = boot();
    await waitForBot(child, origin);
    assert.equal((await run()).notification, 'delivered');
    assert.equal((await run()).notification, 'idle');
    assert.deepEqual(notified.map(row => row.event.type), ['bot_health_lost', 'bot_health_restored']);
    for (const { event, credential, key } of notified) {
      assert.equal(credential, 'Bearer ' + fixtureToken);
      assert.equal(key, event.id);
    }
  } finally { await halt(child); await close(receiver); }
});
