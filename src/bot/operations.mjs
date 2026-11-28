import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { aiApprovalWorkOrder } from '../services/ai-approval.mjs';
import { fail, hash, modeOf } from './core-store.mjs';
import { createIllustrationInbox, createNativeBotAdapter } from './operations-native.mjs';
import { compareGeoRounds, createGeoBotAdapter, normalizeGeoScope } from './operations-geo.mjs';
import { describeChannelExceptions, loadOperationsCatalog, planChannels } from './operations-policy.mjs';
import { identifySourceCandidate } from './sources.mjs';
import { hashObject } from '../domain/hash.mjs';

export { CHANNEL_IDS, loadOperationsCatalog, planChannels } from './operations-policy.mjs';
export { createDevConnector } from './operations-dev.mjs';
export { createNativeBotAdapter, createIllustrationInbox } from './operations-native.mjs';
export { createGeoBotAdapter } from './operations-geo.mjs';

const RETRY_DELAY = 30_000;
const REF = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const PENDING_REVIEW = new Set(['AI_APPROVAL_PENDING', 'AI_APPROVAL_WORKER_REQUIRED',
  'AI_APPROVAL_PROVIDER_BALANCE', 'AI_APPROVAL_PROVIDER_RATE_LIMIT']);
const BLOCKED_CODES = new Set([
  'BUDGET_EXCEEDED', 'BUDGET_CURRENCY_MISMATCH', 'MODEL_COST_AUTHORIZATION_REQUIRED',
  'DEV_AUTHORIZATION_EXPIRED', 'DEV_IDENTITY_MISMATCH', 'GEO_PROVIDER_UNCONFIGURED',
  'AI_APPROVAL_WORKER_REQUIRED', 'PUBLIC_CLAIM_REQUIRED', 'BOT_SOURCE_UNAVAILABLE',
  'NATIVE_DESTINATION_NOT_READY', 'NATIVE_ACCOUNT_NOT_READY', 'NATIVE_EDITION_CHANGED',
  'BOT_MODEL_UNCONFIGURED', 'WRITE_CAPABILITY_REQUIRED', 'PUBLISH_CAPABILITY_REQUIRED', 'GRANT_SCOPE_DENIED',
  'DEV_DUPLICATE_SCOPE_UNAVAILABLE', 'DEV_ARTICLE_ALREADY_PRESENT', 'NATIVE_DEV_VARIANT_CHANGED',
  'AI_APPROVAL_NEEDS_EVIDENCE', 'AI_APPROVAL_REJECTED',
]);

function stateCode(error, fallback) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : fallback;
}

function actor(ctx, role, actorId) {
  return { workspaceId: ctx.workspaceId, projectId: ctx.projectId, role, actorId };
}

function idList(values, limit = 24) {
  if (!Array.isArray(values) || values.length > limit || values.some(value => typeof value !== 'string' || !REF.test(value))) return [];
  return [...new Set(values)];
}

function stripSource(value, task) {
  const title = typeof value?.title === 'string' ? value.title.trim() : task.title;
  if (!title || title.length > 1600 || /[\u0000-\u001f\u007f]/u.test(title)) {
    fail(422, 'BOT_OPPORTUNITY_TITLE_INVALID', 'The approved source needs a one-line opportunity title.');
  }
  const max = Number.isSafeInteger(value?.availableMinor) && value.availableMinor >= 0 ? value.availableMinor : null;
  const estimate = Number.isSafeInteger(value?.estimatedMinor) && value.estimatedMinor >= 0 ? value.estimatedMinor : null;
  return {
    title, locale: value?.locale === 'en-US' ? 'en-US' : 'zh-CN',
    claimIds: idList(value?.claimIds, 50), forms: idList(value?.forms),
    // Sourced copy provides evidence only. Routing authority comes from
    // the current mandate, registered native records and the bounded assessment.
    ...(task.dataMode === 'fixture' && max !== null ? { availableMinor: max } : {}),
    ...(task.dataMode === 'fixture' && estimate !== null ? { estimatedMinor: estimate } : {}),
  };
}

export function createOpportunityInbox(directory) {
  const configured = resolve(directory);
  return async function readAuthorizedEvent(task) {
    const { payloadRef, sourceId, eventKey } = task.input;
    if (!REF.test(payloadRef ?? '')) return null;
    let handle;
    try {
      if (await realpath(configured) !== configured) fail(422, 'SOURCE_INBOX_INVALID', 'The source directory must be canonical.');
      handle = await open(join(configured, `${payloadRef}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > 65_536 || (stat.mode & 0o022) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())) {
        fail(422, 'SOURCE_SIGNAL_INVALID', 'The source directory accepts bounded files owned by the configured service user.');
      }
      const record = JSON.parse((await handle.readFile()).toString('utf8'));
      if (record.sourceId !== sourceId || record.eventKey !== eventKey || record.payloadRef !== payloadRef ||
          !record.opportunity || typeof record.opportunity !== 'object' || Array.isArray(record.opportunity)) {
        fail(409, 'SOURCE_SIGNAL_BINDING_MISMATCH', 'The supplied opportunity must bind the accepted source event.');
      }
      return record.opportunity;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) fail(422, 'SOURCE_SIGNAL_INVALID', 'The source payload is malformed.');
      throw error;
    } finally {
      await handle?.close();
    }
  };
}

/**
 * modelReady is a preflight result for the native content service.
 * costPolicy receives { phase, step } and returns an authorized maximum in
 * minor units plus a measure(result) that matches the provider's actual usage.
 * A missing price/limit or an unknown charge never becomes a zero-cost call.
 * dev is a separately authorized createDevConnector instance.
 */
export function createBotOperations({
  nativeApp, mode = 'real', catalog, dev = null, native, geo,
  clock = Date.now, modelReady = false, geoConfigured = false, geoDeploymentProfile,
  sourceInbox, illustrationInbox, resolveOpportunity, costPolicy, semanticPlanner, registerCandidate, perRequestMetering = false,
} = {}) {
  modeOf(mode);
  const resolvedNative = native ?? createNativeBotAdapter({
    app: nativeApp, mode, now: clock,
    ...(illustrationInbox ? { loadIllustration: createIllustrationInbox(illustrationInbox) } : {}),
  });
  const observation = geo ?? createGeoBotAdapter({ engine: nativeApp?.geoEngine, mode, deploymentProfile: geoDeploymentProfile, configured: geoConfigured || mode === 'fixture' });
  if ([resolvedNative, observation, dev].some(adapter => adapter && adapter.mode !== mode)) {
    fail(422, 'OPERATIONS_DATA_MODE_MISMATCH', 'The work ledger and every adapter must use the same isolated or real data mode.');
  }
  const readOpportunity = resolveOpportunity ?? (sourceInbox ? createOpportunityInbox(sourceInbox) : null);
  return Object.freeze({
    mode, clock, catalog: catalog ?? loadOperationsCatalog(), native: resolvedNative, dev, geo: observation,
    modelReady: modelReady || mode === 'fixture', readOpportunity, costPolicy, perRequestMetering,
    semanticPlanner: semanticPlanner ?? resolvedNative.assessOpportunity, registerCandidate,
    readApproval: nativeApp?.contentDirector?.aiApproval?.readExisting?.bind(nativeApp.contentDirector.aiApproval),
    pollApproval: nativeApp?.contentDirector?.aiApproval?.pollExisting?.bind(nativeApp.contentDirector.aiApproval),
  });
}

async function paidAction(core, operations, step, auth, phase, run, { orderKey, requestIdentity = orderKey, readSettled, resumePending } = {}) {
  if (operations.mode === 'fixture' || operations.perRequestMetering) return run();
  const terms = operations.costPolicy?.({ phase, step });
  if (!terms || !Number.isSafeInteger(terms.reservedMinor) || terms.reservedMinor <= 0 ||
      !/^[A-Z]{3}$/u.test(terms.currency) || typeof terms.measure !== 'function') {
    fail(409, 'MODEL_COST_AUTHORIZATION_REQUIRED', 'Authorize an exact price ceiling and receipt for this external work.');
  }
  const { id: costId } = await core.reserveCost({
    id: step.id, epoch: step.epoch, requestKey: hash([step.id, phase, requestIdentity ?? null]), currency: terms.currency,
    reservedMinor: terms.reservedMinor, ...(orderKey ? { provider: 'native_signed_order', requestHash: orderKey }
      : terms.provider ? { provider: terms.provider } : {}),
  }, auth);
  const dispatch = await core.markCostDispatched({ costId, id: step.id, epoch: step.epoch }, auth);
  if (dispatch.execute !== true) {
    if (dispatch.state === 'settled' && readSettled) {
      const receipt = await readSettled();
      if (receipt) return receipt;
    }
    if (!(resumePending && dispatch.state === 'dispatched')) {
      fail(409, 'ORIGINAL_COST_RECONCILIATION_REQUIRED', 'Read back the original external attempt before retrying.');
    }
    await core.checkpoint({ id: step.id, epoch: step.epoch, output: {} }, auth);
  }

  let measurement;
  let result, rejection;
  try {
    result = dispatch.execute ? await run() : await resumePending();
  } catch (error) {
    if (orderKey && PENDING_REVIEW.has(error.code)) {
      error.botPendingCostId = costId;
      throw error;
    }
    if (error.details?.aiReview) {
      result = error.details.aiReview;
      rejection = error;
    } else {
      await core.settleCost({ costId, status: 'unknown' }, auth);
      throw error;
    }
  }
  if (orderKey && result?.state === 'retry') return { ...result, pendingCostId: costId };
  try {
    measurement = await terms.measure(result);
  } catch {
    await core.settleCost({ costId, status: 'unknown' }, auth);
    fail(409, 'ACTUAL_COST_EVIDENCE_REQUIRED', 'The original provider usage must be reconciled.');
  }
  if (!measurement || !Number.isSafeInteger(measurement.actualMinor) || measurement.actualMinor < 0 ||
      typeof measurement.evidenceRef !== 'string' || !measurement.evidenceRef ||
      typeof measurement.providerRef !== 'string' || !measurement.providerRef) {
    await core.settleCost({ costId, status: 'unknown' }, auth);
    fail(409, 'ACTUAL_COST_EVIDENCE_REQUIRED', 'The charge remains reserved until its original receipt is available.');
  }
  await core.settleCost({
    costId, status: 'settled', actualMinor: measurement.actualMinor, evidenceRef: measurement.evidenceRef,
    providerRef: measurement.providerRef,
  }, auth);
  if (rejection) throw rejection;
  return result;
}

function chargeReview(core, operations, step, auth) {
  return (input, run) => {
    if (operations.mode === 'fixture') return run(input);
    const exactOrder = aiApprovalWorkOrder(input);
    return paidAction(core, operations, step, auth, 'native_review', () => run(input), {
      orderKey: exactOrder.evidenceHash,
      ...(operations.readApproval ? { readSettled: () => operations.readApproval(input) } : {}),
      ...(operations.pollApproval ? { resumePending: () => operations.pollApproval(input) } : {}),
    });
  };
}

export function validateStrategy(result, facts) {
  const value = result?.value ?? result;
  const citations = idList(value?.claimIds, 40);
  const allowed = new Set(facts.map(row => row.claimId));
  if (!value || !['prepare', 'skip', 'defer', 'correct'].includes(value.action) ||
      typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500 ||
      value.priority !== undefined && (!Number.isInteger(value.priority) || value.priority < 0 || value.priority > 100) ||
      !Array.isArray(value.claimIds) || citations.length !== value.claimIds.length ||
      citations.some(id => !allowed.has(id)) || ['prepare', 'correct'].includes(value.action) && !citations.length) {
    fail(422, 'STRATEGY_ASSESSMENT_INVALID', 'A decision must bind its choice to the approved claim IDs.');
  }
  return { action: value.action, reason: value.reason, claimIds: citations, priority: value.priority ?? 0 };
}

function report(core, step, auth, status, output, extra = {}) {
  return core.report({ id: step.id, epoch: step.epoch, status, output, ...extra }, auth);
}

function hold(core, step, auth, operations, result, required = true) {
  const status = result.state === 'retry' ? 'retry' : result.state === 'needs_reconcile' ? 'needs_reconcile' :
    required ? 'waiting_input' : 'succeeded';
  return report(core, step, auth, status, { ...step.output, ...result, dataMode: operations.mode }, {
    ...(status === 'retry' ? { retryAt: operations.clock() + RETRY_DELAY } : {}),
    ...(status === 'retry' && result.pendingCostId ? { pendingCostIds: [result.pendingCostId] } : {}),
  });
}

async function discovery(core, operations, step, auth, task, mandate) {
  let material;
  if (task.input.sourceId) material = await operations.readOpportunity?.(task);
  else material = task.input.opportunity ?? task.input;
  if (!material) return hold(core, step, auth, operations, { state: 'retry', code: 'BOT_SOURCE_UNAVAILABLE' });
  const opportunity = stripSource(material, task);
  if (!opportunity.claimIds.length) opportunity.claimIds = idList(mandate.trustScope?.claimIds, 50);
  opportunity.facts = await operations.native.resolveClaims(opportunity.claimIds);
  if (mandate.workMode === 'research_only') {
    const sourceClaims = opportunity.facts.map(({ claimId, state, expiresAt, sourceUrl }) => ({ claimId, state, expiresAt, sourceUrl }));
    const privateWork = { kind: 'research', title: opportunity.title,
      state: sourceClaims.length ? 'registered_evidence' : 'evidence_gap', claims: sourceClaims };
    return report(core, step, auth, 'succeeded', { privateWork, dataMode: operations.mode });
  }
  const candidateIdentity = identifySourceCandidate(material.candidate);
  let candidateClaim = candidateIdentity?.id;
  const hasCurrentSourceFact = opportunity.facts.some(fact => fact.claimId === candidateClaim);
  if (!hasCurrentSourceFact && operations.registerCandidate && task.input.sourceId &&
      mandate.trustScope.sources.includes(task.input.sourceId) && material.candidate) {
    const registered = await operations.registerCandidate({ task, step, mandate, material,
      runReview: (input, run) => chargeReview(core, operations, step, auth)(input, run),
    });
    if (registered?.state === 'retry') return hold(core, step, auth, operations, registered);
    if (REF.test(registered?.claimId ?? '') && SHA.test(registered?.sourceDigest ?? '') &&
        registered.sourceDigest === candidateIdentity?.sourceDigest) {
      candidateClaim = registered.claimId;
      const approved = (await operations.native.resolveClaims([registered.claimId]))
        .filter(fact => fact.sourceUrl === material.candidate.sourceUrl);
      opportunity.facts = [...new Map([...opportunity.facts, ...approved].map(fact => [fact.claimId, fact])).values()];
    }
  }
  const scope = mandate.trustScope;
  opportunity.artifacts = await operations.native.resolveArtifacts?.(scope.artifacts) ?? [];
  const contributionScope = scope.devto;
  if (contributionScope?.purpose === 'community_technical_education' && REF.test(contributionScope.authorContributionId ?? '')) {
    const contributor = operations.native.resolveAuthorContribution?.(contributionScope.authorContributionId,
      opportunity.facts.map(fact => fact.claimId), opportunity.locale);
    if (contributor) opportunity.authorContributionRef = contributor.id;
  }
  const canReplace = mandate.allowedActions.some(target => target.channelId === 'official-site' && target.form === 'article' &&
    target.action === 'replace' && target.risk === 'low');
  const correction = canReplace ? operations.native.resolveCorrection?.(scope.websiteCorrection, opportunity.facts, opportunity.locale) ??
    operations.native.discoverCorrection?.({ scope: scope.autonomousCorrections, sourceId: task.input.sourceId,
      sourceUrl: material.sourceUrl, sourceText: material.candidate?.text,
      candidateClaimId: operations.mode === 'real' ? candidateClaim : undefined,
      facts: opportunity.facts, locale: opportunity.locale }) ?? null : null;
  if (typeof scope.audience === 'string') opportunity.audience = scope.audience.slice(0, 1000);
  if (REF.test(scope.communityTargetRef ?? '')) opportunity.communityTargetRef = scope.communityTargetRef;
  const zhihu = operations.native.normalizeZhihuScope?.(scope.zhihu);
  if (zhihu) {
    opportunity.zhihu = zhihu;
    if (zhihu.form === 'answer') opportunity.questionRef = zhihu.questionId;
    else opportunity.nativeVariants = { zhihu: 'article' };
  }
  let assessment = null;
  if (opportunity.facts.length) {
    if (!operations.modelReady || typeof operations.semanticPlanner !== 'function') {
      opportunity.assessment = { action: 'defer', reason: 'strategy_not_configured' };
    } else {
      const input = {
        objective: mandate.objective,
        ...(mandate.workMode === 'draft_only' ? { workMode: 'draft_only', audience: opportunity.audience ?? null } : {}),
        opportunity: { title: opportunity.title, locale: opportunity.locale,
          sourceUrl: typeof material.sourceUrl === 'string' ? material.sourceUrl.slice(0, 1300) : null,
          sourceExcerpt: typeof material.excerpt === 'string' && task.input.sourceId !== 'manual' &&
            opportunity.facts.some(fact => fact.sourceUrl === material.sourceUrl) ? material.excerpt.slice(0, 3000) : null },
        facts: opportunity.facts.slice(0, 40),
        published: operations.native.publishedContext?.(opportunity) ?? [],
        correction,
        technicalAuthorContribution: Boolean(opportunity.authorContributionRef),
      };
      const assessmentInputHash = hashObject(input);
      const prior = step.output?.assessment;
      const priorHash = step.output?.assessmentInputHash;
      const ownerDraft = mandate.workMode === 'draft_only' && task.input.provenance === 'owner_request';
      const privateOwnerEvidence = ownerDraft && input.facts.some(fact => fact.reviewedSource);
      const legacyDefer = prior?.action === 'defer' || step.output?.code === 'BOT_PRIVATE_DRAFT_DEFERRED';
      if (ownerDraft && !prior && legacyDefer && !privateOwnerEvidence) {
        return hold(core, step, auth, operations, step.output);
      }
      const reuse = prior && (priorHash === assessmentInputHash || (!priorHash && !(privateOwnerEvidence && legacyDefer)));
      if (!reuse && (prior || legacyDefer) && core.listCosts(auth, mandate.id).some(cost =>
        cost.stepId === step.id && ['reserved', 'dispatched', 'unknown'].includes(cost.state))) {
        fail(409, 'ORIGINAL_COST_RECONCILIATION_REQUIRED', 'Resolve the original decision cost before assessing changed evidence.');
      }
      assessment = validateStrategy(reuse ? prior : await paidAction(core, operations, step, auth,
        'strategy_model', () => operations.semanticPlanner(input), { requestIdentity: privateOwnerEvidence ? assessmentInputHash : undefined }), input.facts);
      if (priorHash !== assessmentInputHash || !prior) {
        const output = { ...step.output, assessment, assessmentInputHash };
        await core.checkpoint({ id: step.id, epoch: step.epoch, output }, auth);
        step.output = output;
      }
      opportunity.assessment = assessment;
      if (assessment.action === 'correct' && (!correction || !assessment.claimIds.includes(correction.claimId))) {
        opportunity.assessment = { action: 'defer', reason: 'original_edition_binding_required' };
      }
      if (opportunity.assessment.action === 'correct' && correction) {
        opportunity.correction = true;
        opportunity.correctionBinding = correction;
        opportunity.websiteSlug = correction.slug;
        opportunity.expectedPreviousReleaseId = correction.releaseId;
        opportunity.supersedesContentId = correction.contentId;
        delete opportunity.authorContributionRef;
      }
      if (['prepare', 'correct'].includes(assessment.action)) {
        opportunity.facts = opportunity.facts.filter(fact => assessment.claimIds.includes(fact.claimId));
      }
      if (opportunity.correctionBinding) {
        const retained = await operations.native.resolveClaims(opportunity.correctionBinding.retainedClaimIds);
        opportunity.facts = [...new Map([...opportunity.facts, ...retained].map(fact => [fact.claimId, fact])).values()];
      }
      opportunity.originalTechnicalWork = Boolean(opportunity.authorContributionRef);
    }
  }
  // The prepare job needs exact claim identifiers. Public excerpts are
  // reloaded on demand and need not appear in the workbench's task receipts.
  opportunity.facts = opportunity.facts.map(({ claimId, state, expiresAt }) => ({ claimId, state, expiresAt }));
  if (mandate.workMode === 'draft_only') {
    const shouldDraft = opportunity.facts.length && opportunity.assessment?.action === 'prepare';
    if (!shouldDraft) return hold(core, step, auth, operations, {
      code: opportunity.facts.length ? 'BOT_PRIVATE_DRAFT_DEFERRED' : 'PUBLIC_CLAIM_REQUIRED',
      privateWork: { kind: 'draft', title: opportunity.title, state: 'evidence_or_strategy_pending' },
    });
    return report(core, step, auth, 'succeeded', { decision: 'prepare', dataMode: operations.mode }, {
      followups: [{ kind: 'prepare', key: 'private-draft', input: { opportunity, channelIds: [] } }],
    });
  }
  const currentCapabilities = await core.listCapabilities(auth);
  const capabilities = Array.isArray(currentCapabilities) ? currentCapabilities : currentCapabilities.items;
  const plan = planChannels({ opportunity, mandate: { ...mandate, requiredOutcomes: task.requiredOutcomes },
    capabilities, catalog: operations.catalog, now: operations.clock(), unavailableConnectors: operations.dev?.configured ? [] : ['devto'] });
  const work = plan.work.filter(row => row.destination);
  const followups = [];
  if (work.length) {
    const queryScope = normalizeGeoScope(mandate, operations.mode);
    if (queryScope && operations.geo.ready) {
      followups.push({ kind: 'observe', key: 'geo-baseline', input: { day: 0, queryScope } });
    }
    followups.push({ kind: 'prepare', key: 'native-article', input: {
      opportunity,
      channelIds: work.map(row => row.channelId),
      channelPreferences: Object.fromEntries(work.map(row => [row.channelId, { formVariant: row.formVariant }])),
    } });
  }
  return report(core, step, auth, 'succeeded', {
    decision: plan.decision.action, preparedChannels: 0, dataMode: operations.mode,
    ...(assessment ? { assessment } : {}),
    queue: { verifiedClaims: Math.min(plan.decision.evidenceRefs.length, 40), modelPriority: assessment?.priority ?? 0 },
    ...(plan.substitutions?.length ? { authorizedSubstitutions: plan.substitutions } : {}),
    exceptions: describeChannelExceptions(plan),
  }, { channelPlan: plan.channels, decision: plan.decision, followups });
}

async function prepare(core, operations, step, auth, task, mandate) {
  if (!operations.modelReady) return hold(core, step, auth, operations, { code: 'BOT_MODEL_UNCONFIGURED' });
  const { opportunity, channelIds } = step.input;
  if (!opportunity || !Array.isArray(channelIds)) fail(422, 'NATIVE_PREPARATION_SCOPE_REQUIRED', 'The planned source and channels are required.');
  const result = await operations.native.prepareArticle({
    taskId: task.id, opportunity, claimIds: opportunity.facts.map(fact => fact.claimId),
    ...(mandate.workMode === 'draft_only' ? { privateDraft: true } : {}),
    jobId: step.output?.jobId,
    onJob: async jobId => {
      await core.checkpoint({ id: step.id, epoch: step.epoch, output: { jobId } }, auth);
      step.output = { ...step.output, jobId };
    },
    runModel: run => paidAction(core, operations, step, auth, 'article_model', run),
    reviewCall: chargeReview(core, operations, step, auth),
  });
  if (result.state !== 'succeeded') return hold(core, step, auth, operations, result);
  if (mandate.workMode === 'draft_only') {
    const { title, body } = result.privateDraft ?? {};
    if (typeof title !== 'string' || !title.trim() || title.length > 500 ||
        typeof body !== 'string' || !body.trim() || body.length > 100_000) {
      return hold(core, step, auth, operations, { code: 'BOT_PRIVATE_DRAFT_UNAVAILABLE', jobId: result.jobId });
    }
    return report(core, step, auth, 'succeeded', { jobId: result.jobId, contentHash: result.contentHash, dataMode: operations.mode,
      privateWork: { kind: 'draft', state: 'prepared', title, body } });
  }
  const activeChannels = task.channels.filter(row => channelIds.includes(row.channelId));
  return report(core, step, auth, 'succeeded', { jobId: result.jobId, contentHash: result.contentHash, dataMode: operations.mode }, {
    followups: activeChannels.map(channel => ({
      kind: 'review', key: `native-review:${channel.channelId}`, input: {
        opportunity, jobId: result.jobId, channelId: channel.channelId,
      },
    })),
  });
}

async function review(core, operations, step, auth, task) {
  const channel = task.channels.find(row => row.channelId === step.input.channelId);
  if (!channel?.destination) fail(422, 'CHANNEL_PLAN_REQUIRED', 'The current channel must be part of the frozen work scope.');
  const { opportunity, jobId } = step.input;
  let adaptation = step.output?.adaptation;
  const result = await operations.native.reviewChannel({ taskId: task.id, channel, opportunity, jobId,
    reviewCall: chargeReview(core, operations, step, auth),
    adaptation,
    runAdaptation: run => paidAction(core, operations, step, auth, 'channel_adaptation', run),
    checkpointAdaptation: async draft => {
      await core.checkpoint({ id: step.id, epoch: step.epoch, output: { adaptation: draft } }, auth);
      adaptation = draft;
    },
  });
  if (result.state !== 'succeeded') {
    if (result.code === 'SIGNED_ILLUSTRATIONS_REQUIRED' && operations.native.illustrationConfigured) {
      return hold(core, step, auth, operations, { ...result, state: 'retry' }, channel.required);
    }
    return hold(core, step, auth, operations, { ...result, ...(adaptation ? { adaptation } : {}) }, channel.required);
  }
  if (!result.packageRecord) {
    return report(core, step, auth, 'succeeded', { ...result, state: 'native_plan_prepared', dataMode: operations.mode });
  }
  const scope = { taskId: task.id, channelId: channel.channelId, stepId: step.id, epoch: step.epoch, packageHash: result.packageHash,
    dataMode: operations.mode };
  await core.recordArtifact({ ...scope, artifactRef: result.artifactRef, producer: 'bot-native-preparation',
    visibility: channel.expectedVisibility }, auth);
  await core.recordReview({ ...scope, reportHash: result.reportHash, evidenceRef: `native-review-${result.reportHash}`,
    outcome: 'passed', verified: true }, auth);
  return report(core, step, auth, 'succeeded', { ...result, dataMode: operations.mode }, {
    followups: channel.machinePublish ? [{
      kind: 'publish', key: `publish:${channel.channelId}:${result.packageHash}`,
      input: { channelId: channel.channelId, reviewStepId: step.id, packageHash: result.packageHash },
    }] : [],
  });
}

function exactReview(task, publishInput) {
  const row = task.steps.find(candidate => candidate.id === publishInput.reviewStepId && candidate.kind === 'review' && candidate.state === 'succeeded');
  const result = row?.output;
  if (!result?.packageRecord || row.input.channelId !== publishInput.channelId || result.packageHash !== publishInput.packageHash ||
      hash(result.packageRecord) !== result.packageHash || result.packageRecord.channelId !== publishInput.channelId) {
    fail(409, 'EXACT_REVIEW_REQUIRED', 'Only an exact reviewed package from this task can be submitted.');
  }
  return result;
}

async function settlePublication(core, operations, step, auth, result, packageHash, operationKey) {
  const status = result.status ?? 'unknown';
  await core.recordEffect({
    operationKey, status, packageHash, dataMode: operations.mode, ...(result.authoritative ? { authoritative: true } : {}),
    ...Object.fromEntries(['remoteId', 'receiptRef', 'accountId', 'visibility', 'publishedAt', 'verifiedAt', 'url', 'verificationMethod', 'code']
      .filter(key => result[key] !== undefined && result[key] !== null).map(key => [key, result[key]])),
  }, auth);
  return report(core, step, auth, status === 'verified' ? 'succeeded' :
    status === 'not_executed' ? 'waiting_input' : 'needs_reconcile',
  { status, operationKey, remoteId: result.remoteId ?? null, dataMode: operations.mode });
}

async function publish(core, operations, step, auth, task) {
  const target = task.channels.find(row => row.channelId === step.input.channelId);
  if (!target?.machinePublish) fail(403, 'PUBLISH_CAPABILITY_REQUIRED', 'The exact channel is not enabled for automatic submission.');
  const { packageRecord, packageHash } = exactReview(task, step.input);
  let operationKey;
  async function crossBoundary(release = null) {
    if (release && (release.previousReleaseId !== packageRecord.expectedPreviousReleaseId ||
        release.editionSnapshotHash !== packageRecord.editionHash || release.canonicalPath !== packageRecord.canonicalPath)) {
      fail(409, 'WEBSITE_RELEASE_SCOPE_CHANGED', 'The final activation must match the authorized edition and prior revision.');
    }
    const permit = await core.issuePermit({
      taskId: task.id, channelId: target.channelId, accountId: target.accountId, destination: target.destination,
      form: target.form, action: target.action ?? 'publish', packageHash, visibility: target.expectedVisibility,
      expectedPreviousReleaseId: packageRecord.expectedPreviousReleaseId,
      idempotencyKey: hash([step.id, step.epoch, packageHash, 'permit']),
    }, actor(auth, 'system', 'policy_delegate'));
    const permitId = permit.id ?? permit.permitId;
    const effect = await core.consumePermit({
      permitId, id: step.id, epoch: step.epoch, expectedPreviousReleaseId: packageRecord.expectedPreviousReleaseId,
    }, auth);
    operationKey = effect.operationKey;
    return { ...effect, permitId };
  }
  let result;
  if (target.channelId === 'official-site') {
    result = await operations.native.publishWebsite({
      packageRecord, packageHash, beforeActivate: crossBoundary, reviewCall: chargeReview(core, operations, step, auth),
      checkpoint: output => core.checkpoint({ id: step.id, epoch: step.epoch, output }, auth),
    });
  } else if (target.channelId === 'devto' && operations.dev?.configured) {
    const payload = operations.native.readDevPackage(packageRecord, packageHash, { beforeSubmit: true });
    result = await operations.dev.publish({
      accountId: target.accountId, payload, packageHash,
      beforeSubmit: () => {
        operations.native.readDevPackage(packageRecord, packageHash, { beforeSubmit: true });
        return crossBoundary();
      },
      onSubmitted: output => core.checkpoint({ id: step.id, epoch: step.epoch, output }, auth),
    });
  } else {
    fail(503, 'PUBLISH_CONNECTOR_UNAVAILABLE', 'The enabled official connector is unavailable.');
  }
  if (result.state === 'retry' && !operationKey) return hold(core, step, auth, operations, result, target.required);
  if (!operationKey) return hold(core, step, auth, operations, { state: 'needs_reconcile', code: 'PUBLICATION_ORIGINAL_EFFECT_REQUIRED' });
  return settlePublication(core, operations, step, auth, result, packageHash, operationKey);
}

async function reconcile(core, operations, step, auth, task) {
  const effect = await core.getEffect(step.input.operationKey, auth);
  if (effect.state === 'verified' || effect.state === 'not_executed') {
    return report(core, step, auth, 'succeeded', { operationKey: effect.operationKey, status: effect.state, dataMode: operations.mode });
  }
  const original = task.steps.find(row => row.id === effect.stepId && row.kind === 'publish');
  if (!original) return hold(core, step, auth, operations, { state: 'needs_reconcile', code: 'ORIGINAL_PUBLICATION_EVIDENCE_REQUIRED' });
  const { packageRecord, packageHash } = exactReview(task, original.input);
  if (effect.packageHash !== packageHash) fail(409, 'RECONCILIATION_SCOPE_CHANGED', 'The original effect does not bind this exact package.');
  const remoteId = effect.remoteId ?? original.output?.remoteId ?? null;
  const result = packageRecord.channelId === 'official-site' ? await operations.native.reconcileWebsite({
    packageRecord, packageHash, operationKey: effect.operationKey, remoteId,
  }) : operations.dev?.configured ? await operations.dev.reconcile({
    accountId: packageRecord.accountId, payload: operations.native.readDevPackage(packageRecord, packageHash),
    operationKey: effect.operationKey, packageHash, remoteId,
    submittedAfter: effect.consumedAt ?? effect.createdAt ?? null,
  }) : { status: 'unknown' };
  if (result.status !== 'verified') return hold(core, step, auth, operations, { state: 'retry', code: 'ORIGINAL_OUTCOME_UNRESOLVED' });
  return settlePublication(core, operations, step, auth, result, packageHash, effect.operationKey);
}

async function observe(core, operations, step, auth, task, mandate) {
  const scope = normalizeGeoScope(mandate, operations.mode);
  const { observationId, targetUrl } = step.input;
  if (!scope || !operations.geo.ready) {
    if (observationId) {
      await core.recordObservation({ observationId, stepId: step.id, epoch: step.epoch,
        evidenceRef: `geo-unavailable-${hash(observationId)}`, questionSetRef: scope?.questionRevision ?? 'unconfigured',
        observedAt: operations.clock(), denominator: scope?.queryIds.length ?? 0, paired: 0, citations: 0,
        status: 'unavailable', dataMode: operations.mode }, auth);
    }
    return hold(core, step, auth, operations, { code: 'GEO_PROVIDER_UNCONFIGURED' }, false);
  }
  if (step.input.queryScope && hash(step.input.queryScope) !== hash(scope)) {
    fail(409, 'GEO_QUESTION_SCOPE_CHANGED', 'The original observation scope has changed.');
  }
  const geo = await paidAction(core, operations, step, auth, 'geo_observation', () =>
    operations.geo.collect(scope, { expectedUrls: targetUrl ? [targetUrl] : [] }));
  const observedAt = operations.clock();
  let comparison = null;
  if (observationId) {
    const original = task.observations.find(row => row.id === observationId);
    const earliest = task.steps.find(row => row.key === 'geo-baseline' && row.state === 'succeeded')?.output;
    comparison = compareGeoRounds(earliest && earliest.observedAt <= original?.basePublicationAt ? earliest : null, geo, targetUrl);
    await core.recordObservation({
      observationId, stepId: step.id, epoch: step.epoch,
      evidenceRef: `geo-paired-${hash([earliest?.evidenceRef ?? null, geo.evidenceRef, comparison])}`,
      questionSetRef: scope.questionRevision, observedAt,
      denominator: geo.planned, paired: comparison.paired, citations: comparison.citations, status: comparison.status,
      dataMode: operations.mode,
    }, auth);
  }
  return report(core, step, auth, 'succeeded', { ...geo, day: step.input.day, observedAt,
    ...(comparison ? { comparison } : {}), dataMode: operations.mode });
}

/**
 * auth is constructed by the in-process daemon for the exact leased role.
 * Never pass an HTTP payload through as a service identity.
 */
export async function runBotStep(core, operations, step, auth) {
  if (step.dataMode !== operations.mode || step.actorId !== auth.actorId) {
    fail(403, 'OPERATIONS_LEASE_SCOPE_DENIED', 'This service identity does not hold the operation lease.');
  }
  try {
    const task = await core.getTask(step.taskId, auth);
    const mandate = await core.getMandate(step.mandateId, auth);
    if (mandate.workMode === 'research_only' && !['discover', 'research'].includes(step.kind) ||
        mandate.workMode === 'draft_only' && !['discover', 'research', 'prepare'].includes(step.kind)) {
      return hold(core, step, auth, operations, { code: 'PRIVATE_WORK_SCOPE_CONFLICT' });
    }
    switch (step.kind) {
      case 'discover':
      case 'research': return await discovery(core, operations, step, auth, task, mandate);
      case 'prepare': return await prepare(core, operations, step, auth, task, mandate);
      case 'review': return await review(core, operations, step, auth, task);
      case 'publish': return await publish(core, operations, step, auth, task);
      case 'reconcile': return await reconcile(core, operations, step, auth, task);
      case 'observe': return await observe(core, operations, step, auth, task, mandate);
      default: fail(422, 'BOT_OPERATION_KIND_INVALID', 'This worker has no execution contract for the leased operation.');
    }
  } catch (error) {
    const code = stateCode(error, 'BOT_NATIVE_OPERATION_FAILED');
    if (PENDING_REVIEW.has(code)) return hold(core, step, auth, operations, {
      state: 'retry', code, ...(error.botPendingCostId ? { pendingCostId: error.botPendingCostId } : {}),
    });
    if (['STALE_LEASE', 'OPERATIONS_LEASE_SCOPE_DENIED'].includes(code)) throw error;
    if (['ORIGINAL_COST_RECONCILIATION_REQUIRED', 'ACTUAL_COST_EVIDENCE_REQUIRED'].includes(code)) {
      return hold(core, step, auth, operations, { state: 'needs_reconcile', code });
    }
    if (BLOCKED_CODES.has(code) || error.status === 403 || error.status === 422) {
      return hold(core, step, auth, operations, { code });
    }
    return report(core, step, auth, 'failed', { ...step.output, code, dataMode: operations.mode });
  }
}
