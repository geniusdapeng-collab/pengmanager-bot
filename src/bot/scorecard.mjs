// Evaluate each frozen promise at its own deadline, including work accepted in previous weeks.
export function deliveryScorecard({ tasks, events, effects, observations, start, end, mode, ownerId }) {
  const perTask = new Map(), byEffect = new Map(effects.map(row => [row.operation_key, row]));
  const byObservation = new Map(observations.map(o => [o.id, o]));
  let ownerTouches = 0, recordedTimeEntries = 0, recordedMinutes = 0;
  const humanEventTypes = new Set(['channel.owner_reported', 'channel.owner_confirmed', 'channel.owner_takeover',
    'channel.owner_submission_recorded', 'channel.owner_submitted', 'task.paused', 'task.resumed', 'task.cancelled']);
  for (const row of events) {
    if (!row.task_id || row.at > end) continue;
    if (!perTask.has(row.task_id)) perTask.set(row.task_id, []);
    const value = JSON.parse(row.data);
    const ownerTouch = humanEventTypes.has(row.type) && (!ownerId || row.actor === ownerId);
    if (ownerTouch && row.at > start) {
      ownerTouches++;
      if (Number.isInteger(value.ownerMinutes)) {
        recordedTimeEntries++;
        recordedMinutes += value.ownerMinutes;
      }
    }
    perTask.get(row.task_id).push({ ...row, value, ownerTouch });
  }
  const items = [];
  let undated = 0;
  for (const task of tasks) {
    const commitments = JSON.parse(task.commitments);
    if (task.deadline_at == null) { undated += commitments.length; continue; }
    if (task.deadline_at <= start || task.deadline_at > end) continue;
    const delivered = new Map(), reviewed = new Map();
    const touches = [];
    for (const event of perTask.get(task.id) ?? []) {
      if (event.at > task.deadline_at) break;
      const v = event.value;
      if (event.ownerTouch) touches.push(event);
      if (event.type === 'artifact.frozen') reviewed.delete(v.channelId);
      if (event.type === 'review.recorded') {
        if (v.outcome === 'passed') reviewed.set(v.channelId, event);
        else reviewed.delete(v.channelId);
      }
      if (event.type === 'decision.recorded' || event.type === 'worker.reported' && v.state === 'succeeded' && v.outputDigest) {
        if (!delivered.has('result:')) delivered.set('result:', event);
      }
      if (event.type === 'effect.verified') {
        const effect = byEffect.get(v.operationKey);
        if (!effect?.settlement) continue;
        const receipt = JSON.parse(effect.settlement);
        if (receipt.verifiedAt > task.deadline_at) continue;
        const outcome = receipt.visibility === 'public' ? 'public' : 'restricted';
        delivered.set(outcome + ':' + effect.channel_id, event);
        if (!delivered.has(outcome + ':')) delivered.set(outcome + ':', event);
      }
      if (event.type === 'observation.recorded' && v.state === 'verified') {
        const obs = byObservation.get(v.observationId);
        const channel = obs && byEffect.get(obs.operation_key)?.channel_id;
        if (!channel) continue;
        for (const key of ['observation:', 'observation:' + channel, 'observation:' + channel + ':' + v.day, 'observation::' + v.day]) {
          if (!delivered.has(key)) delivered.set(key,event);
        }
      }
    }
    for (const [channel, event] of reviewed) {
      delivered.set('prepared:' + channel, event);
      if (!delivered.has('prepared:')) delivered.set('prepared:', event);
    }
    for (const goal of commitments) {
      const receipt = delivered.get(goal.outcome + ':' + (goal.channelId ?? '') + (goal.day ? ':' + goal.day : ''));
      const intervention = touches.filter(t => (!receipt || t.at < receipt.at || t.at === receipt.at && t.seq <= receipt.seq) && (!t.value.channelId || !goal.channelId || t.value.channelId === goal.channelId));
      items.push({ taskId:task.id, goalId:goal.id, channelId:goal.channelId, outcome:goal.outcome, dueAt:task.deadline_at,
        evidenceEventId:receipt?.seq ?? null, achievedAt:receipt?.at ?? null, ownerTouchIds:intervention.map(t=>t.seq),
        onTime:Boolean(receipt), autonomous:Boolean(receipt) && !intervention.length });
    }
  }
  const due=items.length, onTime=items.filter(i=>i.onTime).length, autonomous=items.filter(i=>i.autonomous).length;
  return { dataMode:mode, due, onTime, missed:due-onTime, autonomous, undated, items,
    rate:mode === 'real' && due ? autonomous/due : null, fixtureRate:mode === 'fixture' && due ? autonomous/due : null,
    ownerTouches, recordedTimeEntries, humanMinutes: recordedTimeEntries ? recordedMinutes : null };
}

// Reconcile the completed rounds by their original run and question; list previews are never input.
export function geoPeriodReport(rounds, effects, start, end, mode) {
  const objects = new Set();
  for (const effect of effects) {
    if (effect.dataMode !== mode || effect.state !== 'verified' || effect.visibility !== 'public' ||
        effect.verifiedAt < start || effect.verifiedAt > end || !effect.remoteId) continue;
    objects.add(JSON.stringify([effect.target?.channelId, effect.accountId, effect.remoteId]));
  }
  const panels = new Map();
  const seen = new Set();
  let duplicates = 0;
  for (const round of rounds) {
    if (round.dataMode !== mode || round.observedAt < start || round.observedAt > end || !round.runId) continue;
    const panelKey = JSON.stringify([round.surface, round.provider, round.profileHash ?? null, round.questionRevision]);
    if (!panels.has(panelKey)) panels.set(panelKey, {
      provider: round.provider, surface: round.surface, profileHash: round.profileHash ?? null, questionRevision: round.questionRevision,
      samples: 0, original: 0, verified_reprint: 0, name_only: 0, no_citation: 0, failed: 0, unclassified: 0,
    });
    const panel = panels.get(panelKey);
    for (const sample of round.observations ?? []) {
      const key = JSON.stringify([round.provider, round.runId, sample.queryId]);
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      const type = ['original','verified_reprint','name_only','no_citation','failed'].includes(sample.attribution)
        ? sample.attribution : sample.state === 'failed' ? 'failed' : 'unclassified';
      panel.samples++;
      panel[type]++;
    }
  }
  return { dataMode: mode, publicObjects: mode === 'real' ? objects.size : 0,
    fixturePublicObjects: mode === 'fixture' ? objects.size : 0, samples: seen.size, duplicates, panels: [...panels.values()] };
}
