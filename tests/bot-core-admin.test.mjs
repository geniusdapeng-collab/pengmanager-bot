import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { browserTaskAuthorizes, configuredBrowserTargets, deriveNativeCapability, writeBrowserAssignment } from '../src/bot/admin.mjs';

const owner = { workspaceId: 'w', projectId: 'p', actorId: 'owner', role: 'owner' };
const current = Date.parse('2026-11-27T00:00:00Z');
const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts', 'bot-admin.mjs');

function temporary(t) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'pengmanager-admin-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function portAvailable() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('native capability binds the exact approved owned origin and does not enable an unverified external connector', () => {
  const host = { ctx: owner, settings: { origin: 'https://owner.example.org' }, app: { editorial: {
    getDestination: id => ({ id, kind: 'owned_origin', accountId: null, platformId: 'official-site', visibility: 'public',
      identityReview: { status: 'verified' }, policyStatus: 'reviewed', status: 'active', revision: 2, identityVersion: 1,
      locator: { origin: 'https://owner.example.org' } }),
  } } };
  const input = { channelId: 'official-site', destination: 'DST-001', form: 'article', action: 'publish',
    evidenceRef: 'owner-control-proof', policyRef: 'official-ownership-rules', expiresAt: current + 1000, idempotencyKey: 'owner-capability' };
  const verified = deriveNativeCapability(host, input, current);
  assert.equal(verified.accountId, 'owned:owner');
  assert.equal(verified.official, true);
  assert.equal(verified.safeDedup, true);
  assert.throws(() => deriveNativeCapability(host, { ...input, form: 'video' }, current), { code: 'NATIVE_CONNECTOR_NOT_READY' });
  assert.throws(() => deriveNativeCapability(host, { ...input, accountId: 'other-owner' }, current), { code: 'OWNED_ACCOUNT_MISMATCH' });
  assert.throws(() => deriveNativeCapability({ ...host, settings: { origin: 'https://wrong.example.org' } }, input, current), { code: 'OWNED_DESTINATION_REQUIRED' });
});

test('browser assignment stays exact to owned current task, account and destination handoff', t => {
  const settings = { ctx: owner, dataDir: temporary(t), browserWorkers: [{ id: 'browser-one', label: 'Owner browser' }] };
  let mandate = { id: 'mandate', ownerId: owner.actorId, revision: 1, state: 'active', expiresAt: current + 8000 };
  let disposition = { channelId: 'zhihu', accountId: 'real-matching-account', disposition: 'reviewed', plannedDisposition: 'owner_confirmation' };
  const core = {
    getTask: () => ({ id: 'task', mandateId: mandate.id, mandateRevision: 1, state: 'partial', deadlineAt: current + 5000, channels: [disposition] }),
    getMandate: () => mandate,
  };
  const input = { targetId: 'browser-one', taskId: 'task', accountId: 'real-matching-account', channelId: 'zhihu', idempotencyKey: 'browser-assign-01' };
  assert.deepEqual(configuredBrowserTargets(settings), []);
  const saved = writeBrowserAssignment({ core, settings, ctx: owner }, input, current);
  assert.equal(saved.restartRequired, true);
  const [target] = configuredBrowserTargets(settings);
  assert.equal(target.taskId, 'task');
  assert.equal(browserTaskAuthorizes(core, owner, target, current).channel.channelId, 'zhihu');
  assert.equal(browserTaskAuthorizes(core, owner, target, current + 5000).channel, false);
  assert.throws(() => writeBrowserAssignment({ core, settings, ctx: owner }, input, current + 5000), { code: 'BROWSER_TASK_NOT_AUTHORIZED' });
  assert.throws(() => writeBrowserAssignment({ core, settings, ctx: owner }, { ...input, accountId: 'wrong' }, current), { code: 'BROWSER_TASK_NOT_AUTHORIZED' });
  disposition = { ...disposition, disposition: 'owner_reported', ownerSubmissionId: 'receipt' };
  assert.equal(browserTaskAuthorizes(core, owner, target, current).channel, undefined);
  mandate = { ...mandate, state: 'revoked' };
  assert.equal(browserTaskAuthorizes(core, owner, target, current).channel, false);
});

test('the CLI takes password from stdin, launches the real fixture host and reads it by the owner API', { timeout: 15_000 }, async t => {
  const directory = temporary(t);
  const port = await portAvailable();
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, BOT_MODE: 'fixture', BOT_DATA_DIR: directory, BOT_ORIGIN: origin, PORT: String(port),
    BOT_CONFIG: '', BOT_OWNER_PASSWORD_HASH: '' };
  const hashed = spawnSync(process.execPath, [script, 'hash-password'], { input: 'test-password-fixture-only\n', encoding: 'utf8', cwd: root, env });
  assert.equal(hashed.status, 0, hashed.stderr);
  assert.match(hashed.stdout, /^scrypt-sha256\$/u);
  const child = spawn(process.execPath, [script, 'demo', '--port', String(port), '--data-dir', directory],
    { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  const stopped = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await stopped;
  });
  let healthy = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(origin + '/bot/healthz', { signal: AbortSignal.timeout(300), redirect: 'error' });
      if (response.ok) { healthy = true; break; }
    } catch (error) {
      if (!['TypeError', 'TimeoutError', 'AbortError'].includes(error.name)) throw error;
    }
    await delay(100);
  }
  assert.equal(healthy, true);
  const fixture = JSON.parse(readFileSync(join(directory, 'local-login.json'), 'utf8'));
  const dashboard = spawnSync(process.execPath, [script, 'api', '--origin', origin, '--path', '/dashboard'],
    { cwd: root, env, input: fixture.password, encoding: 'utf8' });
  assert.equal(dashboard.status, 0, dashboard.stderr);
  const data = JSON.parse(dashboard.stdout);
  assert.equal(data.dataMode, 'fixture');
  assert.equal(data.channels.length, 28);
  assert.equal(data.outcomes[0].dataMode, 'fixture');
  child.kill('SIGTERM');
  assert.deepEqual(await stopped, [0, null]);

  const draft = JSON.stringify({ idempotencyKey: 'owner-site-draft', body: {
    platformId: 'official-site', kind: 'owned_origin', name: 'Isolated native destination', locator: { origin }, visibility: 'public',
  } });
  const registration = spawnSync(process.execPath, [script, 'native-destination', '--input', '-'], { cwd: root, env, input: draft, encoding: 'utf8' });
  assert.equal(registration.status, 1, registration.stderr);
  assert.match(registration.stderr, /DUPLICATE_DESTINATION/u);
  const state = spawnSync(process.execPath, [script, 'inspect'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(state.status, 0, state.stderr);
  const native = JSON.parse(state.stdout).destinations.find(row => row.kind === 'owned_origin');
  assert.equal(native.locator.origin, origin);
  const renovation = JSON.stringify({ id: native.id, ifMatch: native.etag, idempotencyKey: 'owner-site-description',
    body: { name: 'Isolated native destination' } });
  const updated = spawnSync(process.execPath, [script, 'native-destination', '--input', '-'], {
    cwd: root, env, input: renovation, encoding: 'utf8',
  });
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(JSON.parse(updated.stdout).id, native.id);
  const unfenced = spawnSync(process.execPath, [script, 'recover'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(unfenced.status, 1);
  assert.match(unfenced.stderr, /WRITER_FENCE_REQUIRED/u);
  const restore = spawnSync(process.execPath, [script, 'recover', '--writer-fenced'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(JSON.parse(restore.stdout).readOnly, true);
  const complete = spawnSync(process.execPath, [script, 'complete-recovery', '--writer-fenced'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(JSON.parse(complete.stdout).readOnly, false);
});
