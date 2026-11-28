import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const DAY = 86_400_000;
export const WEEK = 7 * DAY;

export class BotError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'BotError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(status, code, message, details) {
  throw new BotError(status, code, message, details);
}

export function identifier(value, field = 'identifier') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/u.test(value)) {
    fail(422, 'INVALID_INPUT', `${field} must be a bounded identifier.`);
  }
  return value;
}

export function string(value, field, limit = 500, optional = false) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /\p{Cc}/u.test(value)) {
    fail(422, 'INVALID_INPUT', `${field} must be a bounded, nonempty string.`);
  }
  return value.trim();
}

export function integer(value, field, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(422, 'INVALID_INPUT', `${field} must be an integer in range.`);
  }
  return value;
}

export function instant(value, field) {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d\d:\d\d)$/u.test(value)
    ? Date.parse(value) : value;
  return integer(parsed, field, 0, 8_640_000_000_000_000);
}

export function objects(value, field, max = 50) {
  if (!Array.isArray(value) || value.length > max) {
    fail(422, 'INVALID_INPUT', `${field} must be an array with at most ${max} items.`);
  }
  return value;
}

export function object(value, field) {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(422, 'INVALID_INPUT', `${field} must be a plain object.`);
  }
  return value;
}

export function key(value) {
  const normalized = identifier(value, 'idempotencyKey');
  if (normalized.length < 8) fail(422, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency keys need at least eight characters.');
  return normalized;
}

export function sha(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(422, 'INVALID_HASH', `${field} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

export function modeOf(value) {
  if (!['fixture', 'real'].includes(value)) fail(422, 'INVALID_DATA_MODE', 'Data mode must be fixture or real.');
  return value;
}

export function json(value) {
  function normalized(item, depth) {
    if (depth > 12) fail(422, 'INVALID_INPUT', 'JSON input exceeds the depth limit.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(entry => normalized(entry, depth + 1));
    object(item, 'JSON value');
    const keys = Object.keys(item).filter(name => item[name] !== undefined).sort();
    return Object.fromEntries(keys.map(name => {
      if (/^(authorization|cookie|password|passwd|secret|token|apikey|privatekey|accesstoken|refreshtoken)$/iu.test(name.replace(/[^a-z]/giu, ''))) {
        fail(422, 'CREDENTIALS_NOT_ALLOWED', 'Store only authorized evidence references in the BOT ledger.');
      }
      return [name, normalized(item[name], depth + 1)];
    }));
  }
  const encoded = JSON.stringify(normalized(value, 0));
  if (Buffer.byteLength(encoded) > 262_144) fail(413, 'BODY_TOO_LARGE', 'Use evidence references for large inputs.');
  return encoded;
}

export const parse = value => JSON.parse(value);
export const hash = value => createHash('sha256').update(json(value)).digest('hex');
export const newId = prefix => `${prefix}-${randomUUID()}`;

export function identity(ctx, roles) {
  const input = object(ctx, 'authenticated context');
  const value = {
    workspaceId: identifier(input.workspaceId, 'workspaceId'),
    projectId: identifier(input.projectId, 'projectId'),
    actorId: identifier(input.actorId, 'actorId'),
    role: identifier(input.role, 'role'),
  };
  if (!roles.includes(value.role)) fail(403, 'ROLE_DENIED', 'This authenticated role cannot perform the requested operation.');
  value.scope = json([value.workspaceId, value.projectId]);
  return value;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS idempotency (
    scope TEXT NOT NULL, operation TEXT NOT NULL, request_key TEXT NOT NULL,
    digest TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY (scope, operation, request_key)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS mandates (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner_id TEXT NOT NULL, version INTEGER NOT NULL,
    revocation_epoch INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
    next_run_at INTEGER, next_report_at INTEGER NOT NULL, config TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS mandates_due ON mandates(scope, state, next_run_at);
  CREATE TABLE IF NOT EXISTS source_events (
    scope TEXT NOT NULL, source_id TEXT NOT NULL, event_key TEXT NOT NULL, digest TEXT NOT NULL,
    occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (scope, source_id, event_key)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS source_cursors (
    scope TEXT NOT NULL, source_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, cursor TEXT NOT NULL,
    PRIMARY KEY (scope, source_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, mandate_id TEXT NOT NULL REFERENCES mandates(id),
    trigger_key TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
    priority INTEGER NOT NULL, created_at INTEGER NOT NULL, deadline_at INTEGER,
    mandate_version INTEGER NOT NULL, input TEXT NOT NULL, commitments TEXT NOT NULL,
    UNIQUE (mandate_id, trigger_key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS tasks_scope ON tasks(scope, mandate_id, created_at);
  CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
    step_key TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, due_at INTEGER NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, holder TEXT, input TEXT NOT NULL,
    output TEXT, outcome_digest TEXT, UNIQUE (task_id, step_key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS steps_due ON steps(scope, state, kind, due_at);
  CREATE TABLE IF NOT EXISTS draft_continuations (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id), source_step_id TEXT NOT NULL REFERENCES steps(id),
    step_id TEXT NOT NULL UNIQUE REFERENCES steps(id), job_id TEXT NOT NULL, cost_id TEXT NOT NULL REFERENCES costs(id),
    source_sha256 TEXT NOT NULL, scope_step_id TEXT NOT NULL, quota_fingerprint TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY, scope TEXT NOT NULL, mandate_id TEXT, task_id TEXT, actor TEXT NOT NULL,
    at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS events_task ON events(scope, task_id, seq);
  CREATE TABLE IF NOT EXISTS channel_plans (
    task_id TEXT NOT NULL REFERENCES tasks(id), channel_id TEXT NOT NULL, version INTEGER NOT NULL,
    data TEXT NOT NULL, PRIMARY KEY (task_id, channel_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS capabilities (
    scope TEXT NOT NULL, capability_key TEXT NOT NULL, channel_id TEXT NOT NULL,
    version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (scope, capability_key)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS artifacts (
    task_id TEXT NOT NULL REFERENCES tasks(id), channel_id TEXT NOT NULL, package_hash TEXT NOT NULL,
    producer TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (task_id, channel_id, package_hash)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS reviews (
    task_id TEXT NOT NULL REFERENCES tasks(id), channel_id TEXT NOT NULL, package_hash TEXT NOT NULL,
    report_hash TEXT NOT NULL, reviewer TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
    data TEXT NOT NULL, PRIMARY KEY (task_id, channel_id, package_hash, report_hash)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS confirmations (
    task_id TEXT NOT NULL REFERENCES tasks(id), channel_id TEXT NOT NULL, ticket_id TEXT NOT NULL,
    content TEXT NOT NULL, PRIMARY KEY (task_id, channel_id, ticket_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS permits (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
    operation_key TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, binding TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS effects (
    operation_key TEXT PRIMARY KEY, scope TEXT NOT NULL, mandate_id TEXT NOT NULL REFERENCES mandates(id),
    task_id TEXT NOT NULL REFERENCES tasks(id), channel_id TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL,
    consumed_at INTEGER NOT NULL, settlement TEXT, binding TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS effect_mandate ON effects(scope, mandate_id, consumed_at);
  CREATE TABLE IF NOT EXISTS costs (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, mandate_id TEXT NOT NULL REFERENCES mandates(id),
    task_id TEXT NOT NULL REFERENCES tasks(id), step_id TEXT REFERENCES steps(id),
    state TEXT NOT NULL, reserved INTEGER NOT NULL, actual INTEGER, currency TEXT NOT NULL,
    window_start INTEGER NOT NULL, data TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS cost_mandate ON costs(scope, mandate_id, window_start);
  CREATE TABLE IF NOT EXISTS geo_commitments (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, mandate_id TEXT NOT NULL REFERENCES mandates(id),
    task_id TEXT NOT NULL REFERENCES tasks(id), operation_key TEXT NOT NULL,
    effect_attempt INTEGER NOT NULL, epoch_day INTEGER NOT NULL, due_at INTEGER NOT NULL,
    window_start INTEGER NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL,
    state TEXT NOT NULL, question_ref TEXT NOT NULL, created_at INTEGER NOT NULL, released_at INTEGER,
    UNIQUE (operation_key, effect_attempt, epoch_day)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS geo_commitments_window ON geo_commitments(scope, mandate_id, window_start, state);
  CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
    operation_key TEXT NOT NULL, epoch_day INTEGER NOT NULL, due_at INTEGER NOT NULL, state TEXT NOT NULL,
    data TEXT NOT NULL, UNIQUE (operation_key, epoch_day)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS weekly_reports (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, mandate_id TEXT NOT NULL REFERENCES mandates(id),
    period_end INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE (mandate_id, period_end)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, mandate_id TEXT NOT NULL REFERENCES mandates(id),
    group_key TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL,
    UNIQUE (scope, group_key)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS recovered_journal (
    scope TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (scope, key)
  ) STRICT;
`;

export function openStore(path, mode) {
  const db = new DatabaseSync(path, { timeout: 3000, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    db.exec(SCHEMA);
    const run = (sql, ...values) => db.prepare(sql).run(...values);
    const get = (sql, ...values) => db.prepare(sql).get(...values);
    const all = (sql, ...values) => db.prepare(sql).all(...values);
    run("INSERT OR IGNORE INTO metadata(key, value) VALUES ('mode', ?)", mode);
    if (get("SELECT value FROM metadata WHERE key = 'mode'").value !== mode) {
      fail(409, 'DATA_MODE_MISMATCH', 'Fixture and real ledgers require distinct database files.');
    }
    function transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); }
        catch (rollback) { throw new AggregateError([error, rollback], 'The SQLite write and rollback both failed.'); }
        throw error;
      }
    }
    return { run, get, all, transaction, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function assertRevision(row, input) {
  const raw = input.expectedRevision ?? input.version ?? input.ifMatch;
  const expected = typeof raw === 'string' && /^"?\d+"?$/u.test(raw) ? Number(raw.replaceAll('"', '')) : raw;
  if (expected === undefined) fail(428, 'PRECONDITION_REQUIRED', 'Supply the current revision for this change.');
  if (expected !== row.version) fail(412, 'PRECONDITION_FAILED', 'This object changed. Reload its current revision.', { revision: row.version });
}
