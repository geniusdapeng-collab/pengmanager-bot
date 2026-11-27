import { DAY, fail, hash, integer, parse, string } from './core-store.mjs';

const OBSERVATION_DAYS = [1, 3, 7];

export function budgetWindow(mandate, time) {
  const { budget } = parse(mandate.config);
  const start = mandate.created_at + Math.floor(Math.max(0, time - mandate.created_at) / budget.windowMs) * budget.windowMs;
  return { ...budget, start, end: start + budget.windowMs };
}

export function createGeoFunding({ store, mode, now, preflight }) {
  const { run, get, all } = store;

  function costsAgainst(id) {
    return all("SELECT * FROM costs WHERE json_extract(data, '$.geoCommitmentId') = ? AND state != 'released'", id);
  }

  function commitmentRemaining(row, at = now()) {
    const costs = costsAgainst(row.id).filter(cost => (parse(cost.data).reservedAt ?? 0) <= at);
    const used = costs.reduce((total, cost) => {
      const settledByThen = cost.state === 'settled' && (parse(cost.data).settledAt ?? 0) <= at;
      return total + (settledByThen ? cost.actual : cost.reserved);
    }, 0);
    return Math.max(0, row.amount - used);
  }

  function forWindow(mandate, start, end, at = now()) {
    const holds = all(`SELECT * FROM geo_commitments WHERE mandate_id = ? AND window_start >= ?
      AND window_start < ? AND created_at <= ? AND (released_at IS NULL OR released_at > ?)`,
    mandate.id, start, end, at, at);
    return holds.map(row => ({ ...row, remaining: commitmentRemaining(row, at) }));
  }

  function assessment({ mandate, task, target, operationKey, attempt, at, budgetView }) {
    const config = parse(mandate.config);
    const geo = config.trustScope.geo;
    const required = parse(task.commitments).some(goal => goal.outcome === 'observation' && (!goal.channelId || goal.channelId === target.channelId));
    if (target.visibility !== 'public') {
      if (mode === 'real' && required) fail(422, 'GEO_PUBLIC_TARGET_REQUIRED', 'A committed public observation requires a public target.');
      return [];
    }
    const reserve = geo?.reserveMinorPerRound;
    if (reserve === undefined || reserve === null || reserve === 0) {
      if (mode === 'real' && required) fail(409, 'GEO_RESERVATION_REQUIRED', 'Authorize the cost of all three GEO observation rounds before publication.');
      return [];
    }
    const amount = integer(reserve, 'geo.reserveMinorPerRound', 1, 1_000_000_000);
    const queryIds = geo.queryIds;
    if (!Array.isArray(queryIds) || queryIds.length === 0 || queryIds.length > 50 ||
      queryIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/u.test(id))) {
      fail(422, 'GEO_QUESTION_SCOPE_INVALID', 'A configured reserve requires its fixed approved question set.');
    }
    const provider = geo.provider ?? (mode === 'fixture' ? 'fixture' : 'deepseek-search');
    if (mode === 'fixture' ? provider !== 'fixture' : !['deepseek', 'deepseek-search'].includes(provider)) {
      fail(422, 'GEO_PROVIDER_SCOPE_INVALID', 'The scoped provider must match the actual operating mode.');
    }
    const questionRef = string(geo.questionRevision ?? hash([...new Set(queryIds)]), 'geo.questionRevision', 500);
    if (mandate.expires_at !== null && mandate.expires_at <= at + 7 * DAY) {
      fail(409, 'GEO_COVERAGE_WINDOW_REQUIRED', 'The mandate must cover the last committed observation after publication.');
    }
    if (mode === 'real' && required) {
      const checked = preflight?.({ provider, queryIds: [...new Set(queryIds)], questionRef,
        currency: config.budget.currency, requiredThrough: at + 7 * DAY });
      if (checked?.ready !== true || !Number.isSafeInteger(checked.minimumMinor) || checked.minimumMinor < 1) {
        fail(409, 'GEO_RUNTIME_NOT_READY', 'The configured actual GEO provider, registered queries and pricing must pass preflight.');
      }
      if (checked.minimumMinor > amount) {
        fail(409, 'GEO_ROUND_BUDGET_EXCEEDED', 'The approved round reserve is below the provider’s full question-set bound.',
          { reservedMinor: amount, requiredMinor: checked.minimumMinor, currency: config.budget.currency });
      }
    }
    const groups = new Map();
    const entries = OBSERVATION_DAYS.map(day => {
      const time = at + day * DAY;
      const window = budgetWindow(mandate, time);
      const current = groups.get(window.start) ?? { dueAt: time, amount: 0 };
      current.amount += amount;
      groups.set(window.start, current);
      return {
        id: `geo-hold-${hash([operationKey, attempt, day]).slice(0, 36)}`,
        scope: mandate.scope, mandateId: mandate.id, taskId: task.id, operationKey, attempt,
        day, dueAt: time, windowStart: window.start, amount, currency: config.budget.currency, questionRef, createdAt: at,
      };
    });
    for (const [windowStart, group] of groups) {
      const budget = budgetView(mandate, group.dueAt, at);
      if (budget.currencyConflict || budget.availableMinor < group.amount) {
        fail(409, 'GEO_FUTURE_BUDGET_EXCEEDED', 'A future budget window cannot cover its required GEO observations.',
          { windowStart, currency: budget.currency, requiredMinor: group.amount, availableMinor: budget.availableMinor });
      }
    }
    return entries;
  }

  function insert(entries) {
    for (const entry of entries) {
      run(`INSERT OR IGNORE INTO geo_commitments(id,scope,mandate_id,task_id,operation_key,effect_attempt,
        epoch_day,due_at,window_start,amount,currency,state,question_ref,created_at,released_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?,NULL)`,
      entry.id, entry.scope, entry.mandateId, entry.taskId, entry.operationKey, entry.attempt,
      entry.day, entry.dueAt, entry.windowStart, entry.amount, entry.currency, entry.questionRef, entry.createdAt);
    }
  }

  function releaseForOperation(operationKey, attempt, at = now()) {
    run("UPDATE geo_commitments SET state = 'released', released_at = ? WHERE operation_key = ? AND effect_attempt = ? AND state = 'reserved'",
      at, operationKey, attempt);
  }

  function releaseForTask(taskId, at = now()) {
    run("UPDATE geo_commitments SET state = 'released', released_at = ? WHERE task_id = ? AND state = 'reserved'", at, taskId);
  }

  function releaseForMandate(mandateId, at = now()) {
    run("UPDATE geo_commitments SET state = 'released', released_at = ? WHERE mandate_id = ? AND state = 'reserved'", at, mandateId);
  }

  function align(operationKey, attempt, day, actualDue, mandate, at = now()) {
    const row = get('SELECT * FROM geo_commitments WHERE operation_key = ? AND effect_attempt = ? AND epoch_day = ?', operationKey, attempt, day);
    if (!row || row.state === 'released') return row;
    if (mandate.state === 'revoked' || mandate.state === 'expired' || mandate.expires_at !== null && mandate.expires_at <= actualDue) {
      run("UPDATE geo_commitments SET due_at = ?, state = 'released', released_at = ? WHERE id = ?", actualDue, at, row.id);
    } else {
      run('UPDATE geo_commitments SET due_at = ?, window_start = ? WHERE id = ?', actualDue, budgetWindow(mandate, actualDue).start, row.id);
    }
    return get('SELECT * FROM geo_commitments WHERE id = ?', row.id);
  }

  function reservedForStep(mandate, step, amount, budget, at, move = true) {
    if (step.kind !== 'observe') return null;
    const observationId = parse(step.input).observationId;
    if (observationId === undefined) return null;
    const observed = get('SELECT * FROM observations WHERE id = ? AND task_id = ?', observationId, step.task_id);
    if (!observed) return null;
    const holdId = parse(observed.data).geoCommitmentId;
    if (holdId === null || holdId === undefined) return null;
    const row = get('SELECT * FROM geo_commitments WHERE id = ? AND mandate_id = ?', holdId, mandate.id);
    if (!row || row.state !== 'reserved') fail(409, 'GEO_COMMITMENT_ENDED', 'This observation no longer has its authorized cost reserve.');
    const remaining = commitmentRemaining(row, at);
    if (remaining < amount) fail(409, 'GEO_ROUND_BUDGET_EXCEEDED', 'This observation requires more than its preauthorized reserve.',
      { reservedMinor: row.amount, remainingMinor: remaining });
    if (row.window_start !== budget.windowStart && move) {
      if (budget.availableMinor < remaining) fail(409, 'GEO_FUTURE_BUDGET_EXCEEDED', 'The delayed observation cannot move its reserve to the current budget window.');
      run('UPDATE geo_commitments SET window_start = ? WHERE id = ?', budget.windowStart, row.id);
    }
    return row.id;
  }

  function releaseRound(id, at = now()) {
    if (id !== null && id !== undefined) run("UPDATE geo_commitments SET state = 'released', released_at = ? WHERE id = ? AND state = 'reserved'", at, id);
  }

  return { forWindow, assessment, insert, align, reservedForStep, releaseRound, releaseForOperation, releaseForTask, releaseForMandate };
}
