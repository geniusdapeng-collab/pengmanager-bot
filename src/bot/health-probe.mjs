import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest, privateDirectory } from './files.mjs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const TIMEOUT_MS = 5000;
const LEASE_MS = 60_000;
const FAILURE_THRESHOLD = 2;

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function validatedEndpoints(origin, receiverUrl, token, monitorId) {
  let target, receiver;
  try {
    target = new URL(origin);
    receiver = new URL(receiverUrl);
  } catch { throw failure('PROBE_INVALID_ENDPOINT'); }
  if (target.href !== target.origin + '/' || target.username || target.password ||
      target.protocol !== 'https:' && (target.protocol !== 'http:' || !LOOPBACK.has(target.hostname)) ||
      receiver.protocol !== 'https:' || receiver.username || receiver.password || receiver.search || receiver.hash) {
    throw failure('PROBE_INVALID_ENDPOINT');
  }
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]{1,512}={0,2}$/.test(token)) {
    throw failure('PROBE_INVALID_CREDENTIAL');
  }
  if (typeof monitorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(monitorId)) {
    throw failure('PROBE_INVALID_MONITOR');
  }
  return { target: new URL('/healthz', target), receiver };
}

async function readJson(response, limit) {
  if (!response.body) return null;
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await response.body.cancel();
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
}

async function observe(fetchImpl, target) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await fetchImpl(target, { cache: 'no-store', redirect: 'manual', signal,
      headers: { Accept: 'application/json' } });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { ready: false, reason: `http_${response.status}` };
    }
    const body = await readJson(response, 1024);
    if (body?.service === 'pengmanager-bot' && typeof body.ready === 'boolean') {
      return { ready: body.ready, reason: body.ready ? null : 'not_ready' };
    }
    return { ready: false, reason: 'invalid_health_receipt' };
  } catch { return { ready: false, reason: signal.aborted ? 'timeout' : 'unreachable' }; }
}

async function deliver(fetchImpl, receiver, token, event) {
  try {
    const response = await fetchImpl(receiver, { method: 'POST', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        'Idempotency-Key': event.id, Authorization: 'Bearer ' + token },
      body: JSON.stringify(event),
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await readJson(response, 8192);
    return body?.id === event.id && typeof body.receiptId === 'string' &&
      body.receiptId.length <= 500 && body.receiptId.trim() ? body.receiptId : null;
  } catch { return null; }
}

function openState(directory, identity, initialNow) {
  const db = new DatabaseSync(join(privateDirectory(directory), 'health-probe.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout = 2500;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS health_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        identity TEXT NOT NULL,
        failures INTEGER NOT NULL,
        first_failure_at INTEGER,
        incident_id TEXT,
        lease_token TEXT,
        lease_until INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        sequence INTEGER PRIMARY KEY,
        id TEXT UNIQUE NOT NULL,
        event TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        delivered_at INTEGER,
        receipt_id TEXT
      );`);
    db.prepare(`INSERT OR IGNORE INTO health_state
      (singleton, identity, failures, lease_until) VALUES (1, ?, 0, ?)`).run(identity, initialNow);
    if (db.prepare('SELECT identity FROM health_state WHERE singleton = 1').get().identity !== identity) {
      throw failure('PROBE_STATE_TARGET_CHANGED');
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function writeObservation(db, lease, monitorId, observation, observedAt) {
  transaction(db, () => {
    const state = db.prepare(`SELECT failures, first_failure_at, incident_id FROM health_state
      WHERE singleton = 1 AND lease_token = ?`).get(lease);
    if (!state) throw failure('PROBE_LEASE_LOST');
    const failures = observation.ready ? 0 : Math.min(state.failures + 1, FAILURE_THRESHOLD);
    const firstFailureAt = observation.ready ? null : state.first_failure_at ?? observedAt;
    let incidentId = state.incident_id;
    let event;
    if (observation.ready && incidentId) {
      event = { id: `${incidentId}-restored`, incidentId, type: 'bot_health_restored',
        firstFailureAt: state.first_failure_at, observedAt };
      incidentId = null;
    } else if (!observation.ready && failures === FAILURE_THRESHOLD && !incidentId) {
      incidentId = randomUUID();
      event = { id: `${incidentId}-lost`, incidentId, type: 'bot_health_lost',
        firstFailureAt, observedAt, reason: observation.reason };
    }
    db.prepare(`UPDATE health_state SET failures = ?, first_failure_at = ?, incident_id = ?
      WHERE singleton = 1 AND lease_token = ?`).run(failures, firstFailureAt, incidentId, lease);
    if (event) db.prepare('INSERT INTO outbox (id, event, next_attempt_at) VALUES (?, ?, ?)')
      .run(event.id, JSON.stringify({ ...event, service: 'pengmanager-bot', monitorId }), observedAt);
  });
}

export async function runHealthProbe({ origin, receiverUrl, token, monitorId, stateDirectory,
  clock = Date.now, fetchImpl = fetch }) {
  const { target, receiver } = validatedEndpoints(origin, receiverUrl, token, monitorId);
  if (typeof stateDirectory !== 'string' || !stateDirectory) throw failure('PROBE_INVALID_DIRECTORY');
  const now = clock();
  const db = openState(stateDirectory, digest(`${target.href}\n${monitorId}`), now);
  const lease = randomUUID();
  try {
    const acquired = db.prepare(`UPDATE health_state SET lease_token = ?, lease_until = ?
      WHERE singleton = 1 AND lease_until <= ?`).run(lease, now + LEASE_MS, now);
    if (!acquired.changes) return { health: 'busy', notification: 'idle' };
    const observation = await observe(fetchImpl, target);
    const observedAt = clock();
    writeObservation(db, lease, monitorId, observation, observedAt);

    const next = db.prepare(`SELECT id, event, attempts, next_attempt_at FROM outbox
      WHERE delivered_at IS NULL ORDER BY sequence LIMIT 1`).get();
    let notification = next ? 'retry_scheduled' : 'idle';
    if (next?.next_attempt_at <= observedAt) {
      const receiptId = await deliver(fetchImpl, receiver, token, JSON.parse(next.event));
      const completedAt = clock();
      const backoff = Math.min(3_600_000, 30_000 * 2 ** Math.min(next.attempts, 7));
      const result = db.prepare(`UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, delivered_at = ?, receipt_id = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM health_state WHERE singleton = 1 AND lease_token = ?)`)
        .run(completedAt + backoff, receiptId ? completedAt : null, receiptId, next.id, lease);
      if (!result.changes) throw failure('PROBE_LEASE_LOST');
      notification = receiptId ? 'delivered' : 'delivery_failed';
    }
    const { failures } = db.prepare('SELECT failures FROM health_state WHERE singleton = 1').get();
    const { pending } = db.prepare('SELECT COUNT(*) AS pending FROM outbox WHERE delivered_at IS NULL').get();
    return { health: observation.ready ? 'ready' : 'unavailable', reason: observation.reason,
      failures, notification, pending };
  } finally {
    try {
      db.prepare(`UPDATE health_state SET lease_token = NULL, lease_until = 0
        WHERE singleton = 1 AND lease_token = ?`).run(lease);
    } finally { db.close(); }
  }
}
