import { DAY, WEEK, fail, hash, identifier, instant, integer, json, object, objects, string } from './core-store.mjs';

export const CHANNEL_IDS = Object.freeze([
  'official-site', 'wechat-official', 'xiaohongshu', 'bilibili', 'linkedin', 'x', 'youtube',
  'github', 'huggingface', 'modelscope', 'tiktok', 'instagram', 'facebook', 'douyin',
  'wechat-channels', 'zhihu', 'reddit', 'discord', 'jike', 'juejin', 'csdn', 'devto',
  'medium', 'hashnode', 'kaggle', 'baijiahao', 'toutiao', 'maimai',
]);
const ARCHIVED_CHANNELS = new Set(['baijiahao', 'toutiao', 'maimai']);

export function channelsOf(channels = CHANNEL_IDS.map(id => ({ id }))) {
  const rows = new Map();
  for (const item of objects(channels, 'channels', CHANNEL_IDS.length)) {
    object(item, 'channel');
    const id = identifier(item.platformId ?? item.channelId ?? item.id, 'channelId');
    if (!CHANNEL_IDS.includes(id) || rows.has(id)) fail(422, 'CATALOG_MISMATCH', 'The channel list must match the v4 catalog.');
    rows.set(id, { id, label: string(item.nameZh ?? item.name ?? item.label ?? id, 'channel label', 140),
      archived: item.archived === true || item.integrationStatus === 'archived' || ARCHIVED_CHANNELS.has(id) });
  }
  if (rows.size !== CHANNEL_IDS.length) fail(422, 'CATALOG_MISMATCH', 'All 28 catalog channels must be supplied together.');
  return rows;
}

export function capabilityBinding(input, channels) {
  object(input, 'target');
  const binding = {
    channelId: identifier(input.channelId ?? input.platformId, 'channelId'),
    accountId: identifier(input.accountId, 'accountId'),
    destination: string(input.destination ?? input.destinationId, 'destination', 240),
    form: identifier(input.form ?? input.nativeForm, 'form'),
    action: identifier(input.action ?? 'publish', 'action'),
    visibility: input.visibility ?? input.expectedVisibility ?? 'public',
  };
  if (!channels.has(binding.channelId)) fail(422, 'CHANNEL_NOT_FOUND', 'Target is outside the 28-channel catalog.');
  if (!['public', 'private', 'restricted', 'unlisted'].includes(binding.visibility)) {
    fail(422, 'INVALID_VISIBILITY', 'This visibility is outside the publication contract.');
  }
  return binding;
}

export const capabilityKey = binding => hash(binding);

function scheduleOf(input, now) {
  const schedule = object(input ?? {}, 'schedule');
  const interval = schedule.intervalMs ?? input?.everyMs ?? null;
  const startsAt = schedule.startsAt === undefined ? now : instant(schedule.startsAt, 'schedule.startsAt');
  return {
    startsAt,
    intervalMs: interval === null ? null : integer(interval, 'schedule.intervalMs', 1000, 366 * DAY),
    reportStartsAt: schedule.reportStartsAt === undefined ? now + WEEK : instant(schedule.reportStartsAt, 'schedule.reportStartsAt'),
    reportIntervalMs: integer(schedule.reportIntervalMs ?? WEEK, 'schedule.reportIntervalMs', DAY, 366 * DAY),
  };
}

function goal(input, channels) {
  if (typeof input === 'string') {
    const id = string(input, 'required outcome', 150);
    return { id, channelId: channels.has(id) ? id : null, outcome: 'public' };
  }
  object(input, 'required outcome');
  const channelId = input.channelId === undefined || input.channelId === null ? null : identifier(input.channelId, 'channelId');
  if (channelId !== null && !channels.has(channelId)) fail(422, 'CHANNEL_NOT_FOUND', 'A required channel is outside the catalog.');
  const outcome = input.outcome ?? input.type ?? 'public';
  if (!['public', 'prepared', 'restricted', 'observation', 'result'].includes(outcome)) {
    fail(422, 'INVALID_OUTCOME', 'Unsupported required outcome.');
  }
  if (input.day !== undefined && (outcome !== 'observation' || ![1,3,7].includes(input.day))) fail(422, 'INVALID_OUTCOME_DAY', 'Use day 1, 3 or 7 for a GEO outcome.');
  return { id: string(input.id ?? `${channelId ?? 'project'}:${outcome}`, 'outcomeId', 150), channelId, outcome, ...(input.day ? { day: input.day } : {}) };
}

function normalizeSubstitutions(input, channels, requiredOutcomes, optionalTargets, allowedActions) {
  const usedChannels = new Set([...requiredOutcomes.map(row => row.channelId), ...optionalTargets]);
  const usedGoals = new Set();
  return objects(input, 'allowedSubstitutions', CHANNEL_IDS.length).map(entry => {
    object(entry, 'authorized substitute');
    const forOutcomeId = string(entry.forOutcomeId, 'forOutcomeId', 150);
    const original = requiredOutcomes.find(row => row.id === forOutcomeId);
    const outcome = entry.outcome;
    const target = capabilityBinding(entry, channels);
    if (!original?.channelId || usedGoals.has(forOutcomeId) || usedChannels.has(target.channelId) ||
      channels.get(target.channelId).archived || !['public', 'prepared', 'restricted'].includes(outcome) ||
      target.action !== 'publish' || outcome === 'public' && target.visibility !== 'public' ||
      outcome === 'restricted' && target.visibility === 'public') {
      fail(422, 'INVALID_SUBSTITUTION', 'Bind a separate active channel and distinct exact fallback outcome to one original required channel.');
    }
    const grant = allowedActions.find(({ risk, maxDaily, ...binding }) => capabilityKey(binding) === capabilityKey(target));
    if (!grant || grant.risk !== (outcome === 'prepared' ? 'human' : 'low')) {
      fail(422, 'SUBSTITUTION_NOT_AUTHORIZED', 'An alternate requires its own exact action grant. Preparation-only scope must require a human for submission.');
    }
    usedChannels.add(target.channelId);
    usedGoals.add(forOutcomeId);
    return { forOutcomeId, originalChannelId: original.channelId, outcome, ...target };
  });
}

export function normalizeMandate(input, now, channels) {
  object(input, 'mandate');
  const timeZone = string(input.timeZone ?? 'UTC', 'timeZone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone }); }
  catch { fail(422, 'INVALID_TIME_ZONE', 'Use an IANA time zone.'); }
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : instant(input.expiresAt, 'expiresAt');
  if (expiresAt !== null && expiresAt <= now) fail(422, 'DEADLINE_EXPIRED', 'Mandate expiry must be in the future.');
  const budget = object(input.budget ?? input.limits?.budget ?? {}, 'budget');
  const currency = budget.currency ?? 'CNY';
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/u.test(currency)) fail(422, 'INVALID_CURRENCY', 'Use a three-letter currency.');
  const scopes = objects(input.allowedActions ?? input.permittedActions ?? input.targets ?? [], 'allowedActions');
  const allowedActions = scopes.map(action => {
    const target = capabilityBinding(action, channels);
    if (!['publish', 'replace', 'withdraw', 'update', 'submit'].includes(target.action)) {
      fail(422, 'INVALID_ACTION', 'The requested publication action is unsupported.');
    }
    return {
      ...target,
      risk: action.risk ?? 'low',
      maxDaily: integer(action.maxDaily ?? 1, 'maxDaily', 1, 1000),
    };
  });
  if (allowedActions.some(action => !['low', 'human'].includes(action.risk))) {
    fail(422, 'INVALID_RISK', 'A publication grant must have a supported risk boundary.');
  }
  if (new Set(allowedActions.map(({ risk, maxDaily, ...binding }) => capabilityKey(binding))).size !== allowedActions.length) {
    fail(422, 'DUPLICATE_SCOPE', 'Each exact destination action needs one grant.');
  }
  const requiredOutcomes = objects(input.requiredOutcomes ?? [], 'requiredOutcomes').map(entry => goal(entry, channels));
  if (new Set(requiredOutcomes.map(entry => entry.id)).size !== requiredOutcomes.length) fail(422, 'DUPLICATE_OUTCOME', 'Required outcomes must be distinct.');
  const workMode = input.workMode ?? 'standard';
  if (!['standard', 'draft_only', 'research_only'].includes(workMode)) fail(422, 'INVALID_WORK_MODE', 'Unsupported mandate work mode.');
  if (workMode !== 'standard' && (allowedActions.length || requiredOutcomes.some(row => row.channelId !== null || row.outcome !== 'result'))) {
    fail(422, 'PRIVATE_WORK_SCOPE_CONFLICT', 'A research-only or private-draft mandate requires a private work scope.');
  }
  const optionalTargets = objects(input.optionalTargets ?? [], 'optionalTargets').map(entry => {
    const value = typeof entry === 'string' ? entry : entry?.channelId;
    if (!channels.has(value)) fail(422, 'CHANNEL_NOT_FOUND', 'An optional target is outside the catalog.');
    return value;
  });
  if (workMode !== 'standard' && optionalTargets.length) fail(422, 'PRIVATE_WORK_SCOPE_CONFLICT', 'A private work mode does not target external channels.');
  const trustScope = object(input.trustScope ?? {}, 'trustScope');
  const sources = objects(input.sources ?? trustScope.sources ?? trustScope.sourceIds ?? [], 'sources')
    .map(source => identifier(typeof source === 'string' ? source : source?.sourceId, 'sourceId'));
  const selectedClaims = objects(trustScope.claimIds ?? [], 'trustScope.claimIds', 50)
    .map(id => identifier(id, 'claimId'));
  const config = {
    objective: string(input.objective ?? input.goal, 'objective', 1600),
    ...(workMode !== 'standard' ? { workMode } : {}),
    requiredOutcomes,
    resultWindowMs: input.resultWindowMs == null ? null : integer(input.resultWindowMs, "resultWindowMs", 1000, 366 * DAY),
    optionalTargets: [...new Set(optionalTargets)],
    allowedSubstitutions: normalizeSubstitutions(input.allowedSubstitutions ?? [], channels, requiredOutcomes, optionalTargets, allowedActions),
    allowedActions,
    trustScope: { ...trustScope, sources: [...new Set(sources)],
      ...(trustScope.claimIds === undefined ? {} : { claimIds: [...new Set(selectedClaims)] }) },
    budget: { currency, limitMinor: integer(budget.limitMinor ?? budget.ceilingMinor ?? 0, 'budget.limitMinor', 0, 1_000_000_000),
      windowMs: integer(budget.windowMs ?? WEEK, 'budget.windowMs', 1000, 366 * DAY) },
    schedule: scheduleOf(input.schedule, now),
    expiresAt,
    timeZone,
    interruptPolicy: object(input.interruptPolicy ?? {}, 'interruptPolicy'),
  };
  json(config);
  return config;
}

export function basePlan(channels, commitments, nextCheck = null) {
  return [...channels.values()].map(channel => ({
    channelId: channel.id,
    disposition: channel.archived ? 'archived' : 'not_selected',
    reason: channel.archived ? 'catalog_archived' : 'no_match_assessed_yet',
    required: commitments.some(item => item.channelId === channel.id),
    form: null, accountId: null, destination: null, expectedReceipt: null, expectedVisibility: null,
    machinePublish: false, nextCheck,
  }));
}

const DISPOSITIONS = new Set([
  'archived', 'not_selected', 'unmatched', 'no_match', 'deferred', 'skip', 'skipped', 'observe', 'observe_only',
  'blocked', 'needs_input', 'needs_account', 'needs_owner', 'pending_rule', 'needs_evidence', 'owner_confirmation',
  'human_confirmation', 'handoff', 'manual', 'prepare', 'prepare_only', 'prepared', 'publish',
  'queue_publish', 'auto_publish', 'automatic', 'connector', 'verified', 'public_verified', 'restricted_verified',
  'selected', 'publish_ready', 'candidate', 'reviewed', 'needs_reconcile', 'accepted',
]);

export function normalizePlan(input, channels, commitments, defaultAt, allowDecision, restored, authorizedSubstitutions = []) {
  const baseline = new Map(basePlan(channels, commitments, defaultAt).map(row => [row.channelId, row]));
  const seen = new Set();
  for (const row of objects(input, 'channelPlan', CHANNEL_IDS.length)) {
    object(row, 'channel plan entry');
    const channelId = identifier(row.channelId ?? row.platformId ?? row.id, 'channelId');
    const base = baseline.get(channelId);
    if (!base || seen.has(channelId)) fail(422, 'INVALID_CHANNEL_PLAN', 'Channel plan contains a missing or duplicate catalog entry.');
    seen.add(channelId);
    if (base.disposition === 'archived' && !restored({ ...row, channelId })) continue;
    let disposition = identifier(row.disposition, 'disposition');
    if (!DISPOSITIONS.has(disposition)) fail(422, 'INVALID_DISPOSITION', 'Channel disposition is outside the planner contract.', { channelId, disposition });
    const signed = authorizedSubstitutions.find(item => item.channelId === channelId);
    let substitution = null;
    if (row.substitution != null || signed && ['publish', 'prepare', 'manual', 'owner_confirmation'].includes(disposition)) {
      if (!signed || signed.forOutcomeId !== row.substitution?.forOutcomeId || signed.outcome !== row.substitution?.outcome ||
        signed.accountId !== row.accountId || signed.destination !== row.destination || signed.form !== row.form ||
        signed.action !== (row.action ?? 'publish') || signed.visibility !== (row.expectedVisibility ?? row.visibility ?? 'public') ||
        !commitments.some(item => item.id === signed.forOutcomeId && item.channelId === signed.originalChannelId)) {
        fail(403, 'SUBSTITUTION_SCOPE_DENIED', 'The fallback does not match this task’s current signed alternative.');
      }
      substitution = signed;
    }
    const requestedMachine = row.machinePublish === true;
    const machinePublish = requestedMachine && substitution?.outcome !== 'prepared' && allowDecision({ ...row, channelId });
    if (requestedMachine && !machinePublish) disposition = 'prepare_only';
    const reason = requestedMachine && !machinePublish ? 'missing_current_explicit_write_capability' : string(row.reason, 'reason', 700);
    baseline.set(channelId, {
      ...base, disposition, reason, machinePublish,
      ...(substitution ? { substitution } : {}),
      form: row.form === null || row.form === undefined ? null : identifier(row.form, 'form'),
      accountId: row.accountId === null || row.accountId === undefined ? null : identifier(row.accountId, 'accountId'),
      destination: string(row.destination, 'destination', 240, true),
      expectedReceipt: string(row.expectedReceipt, 'expectedReceipt', 200, true),
      expectedVisibility: row.expectedVisibility ?? row.visibility ?? null,
      action: identifier(row.action ?? 'publish', 'action'),
      formVariant: string(row.formVariant, 'formVariant', 160, true),
      roleId: string(row.roleId, 'roleId', 160, true),
      roleVersion: string(row.roleVersion, 'roleVersion', 120, true),
      catalogVersion: string(row.catalogVersion, 'catalogVersion', 120, true),
      capabilityVersion: row.capabilityVersion === undefined || row.capabilityVersion === null ? null
        : integer(row.capabilityVersion, 'capabilityVersion', 1),
      capabilityEvidenceRef: string(row.capabilityEvidenceRef, 'capabilityEvidenceRef', 500, true),
      rulesHash: string(row.rulesHash, 'rulesHash', 160, true),
      nextCheck: row.nextCheck === undefined || row.nextCheck === null ? defaultAt : instant(row.nextCheck, 'nextCheck'),
    });
  }
  return [...baseline.values()];
}

export function decideOpportunity(input) {
  object(input, 'opportunity');
  const evidenceRefs = objects(input.evidenceRefs ?? [], 'evidenceRefs', 40).map(ref => string(ref, 'evidenceRef', 400));
  const novelty = integer(input.novelty ?? 0, 'novelty', 0, 100);
  const value = integer(input.value ?? input.readerValue ?? 0, 'readerValue', 0, 100);
  const urgency = integer(input.urgency ?? 0, 'urgency', 0, 100);
  const estimatedCostMinor = integer(input.estimatedCostMinor ?? 0, 'estimatedCostMinor', 0, 1_000_000_000);
  const availableMinor = integer(input.availableMinor ?? 0, 'availableMinor', 0, 1_000_000_000);
  const assessment = { evidenceRefs, novelty, value, urgency, estimatedCostMinor, availableMinor };
  let action;
  let reason;
  if (input.duplicate === true || novelty === 0) [action, reason] = ['ignore', 'no_new_value'];
  else if (evidenceRefs.length === 0) [action, reason] = ['research', 'evidence_gap'];
  else if (estimatedCostMinor > availableMinor) [action, reason] = ['defer', 'budget'];
  else if (value < 30 && urgency < 60) [action, reason] = ['observe', 'present_value_below_threshold'];
  else if (input.existingTopicId) [action, reason] = ['update', 'update_existing_topic'];
  else [action, reason] = ['create', 'evidence_and_reader_value'];
  return { action, reason, alternatives: ['ignore', 'research', 'defer', 'observe', 'update', 'create'].filter(entry => entry !== action),
    assessment, inputHash: hash(input) };
}

export function dayBoundary(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}
