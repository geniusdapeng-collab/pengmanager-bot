import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, hash, identifier, instant, object, string } from './core-store.mjs';
import { privateDirectory, putRecord, readRecord } from './files.mjs';

export function nativeContext(owner, input, entity = null) {
  return { actor: owner.actorId, method: 'local', idempotencyKey: identifier(input.idempotencyKey, 'idempotencyKey'),
    ...(entity ? { ifMatch: input.ifMatch ?? entity.etag } : {}) };
}

export function inspectNative(app, now = Date.now()) {
  const usable = row => row.status === 'active' && row.identityReview?.status === 'verified' && row.policyStatus === 'reviewed';
  const accounts = app.editorial.listAccounts().items.map(row => ({ id: row.id, platformId: row.platformId,
    revision: row.revision, etag: row.etag, handle: row.handle, status: row.status,
    identity: row.identityReview?.status, policy: row.policyStatus, usable: usable(row) }));
  const destinations = app.editorial.listDestinations().items.map(row => ({ id: row.id, platformId: row.platformId,
    accountId: row.accountId, kind: row.kind, status: row.status, etag: row.etag, visibility: row.visibility,
    name: row.name, locator: row.locator, identity: row.identityReview?.status, policy: row.policyStatus, usable: usable(row) }));
  const publicClaims = app.store.snapshot(['claims']).claims.filter(row => row.state === 'approved' && row.publicLevel === 'approved_public' &&
    row.sensitivity === 'low' && row.source?.visibility === 'public' && row.source?.url &&
    (row.expiresAt === null || row.expiresAt === undefined || Date.parse(row.expiresAt) > now))
    .map(row => ({ id: row.id, sourceUrl: row.source.url, expiresAt: row.expiresAt ?? null, independentlyReviewed: Boolean(row.aiReview) }));
  return { accounts, destinations, publicClaims, illustrationProducers: app.editorial.listIllustrationProducerKeys().items.map(row => ({
    id: row.id, status: row.revokedAt ? 'revoked' : 'active', label: row.label,
  })) };
}

export async function readTaskIllustrations(app, task) {
  const step = task.steps.find(row => row.kind === 'prepare' && typeof row.output?.jobId === 'string');
  if (!step) return { taskId: task.id, available: false, reason: 'native_job_not_started', dataMode: task.dataMode };
  const job = await app.contentDirector.getJob(step.output.jobId);
  const { storyId, illustrationPlanId } = job.editorialRef ?? {};
  if (!storyId || !illustrationPlanId) return { taskId: task.id, jobId: job.id, available: false, reason: 'illustration_plan_pending', dataMode: task.dataMode };
  const plan = app.editorial.getArticleIllustrations(storyId, illustrationPlanId);
  return { taskId: task.id, jobId: job.id, storyId, planId: plan.id, available: true, sourceHash: plan.sourceHash, complete: plan.isComplete,
    workOrders: plan.workOrders, dataMode: task.dataMode };
}

export function deriveNativeCapability({ app, ctx, settings }, input, timestamp = Date.now()) {
  object(input, 'native capability');
  const channelId = identifier(input.channelId, 'channelId');
  const destination = app.editorial.getDestination(identifier(input.destination ?? input.destinationId, 'destinationId'));
  if (destination.platformId !== channelId || destination.visibility !== (input.visibility ?? 'public') ||
    destination.status !== 'active' || destination.identityReview?.status !== 'verified' || destination.policyStatus !== 'reviewed') {
    fail(409, 'NATIVE_DESTINATION_NOT_READY', 'Read back the verified native destination, exact channel and visibility first.');
  }
  const form = identifier(input.form, 'form');
  const action = input.action ?? 'publish';
  const configured = input.mode ?? (channelId === 'official-site' ? 'owned' : 'manual');
  const requestedWrite = ['owned', 'official', 'official_api', 'api'].includes(configured);
  const connectorReady = channelId === 'official-site' || channelId === 'devto' && settings.dev &&
    settings.dev.accountId === destination.accountId && form === 'article';
  if (requestedWrite && (!connectorReady || !['publish', 'replace'].includes(action) || form !== 'article' ||
    channelId === 'devto' && action !== 'publish')) {
    fail(422, 'NATIVE_CONNECTOR_NOT_READY', 'This build supports unattended writes only for a verified owned-site article or configured DEV article account.');
  }
  let accountId;
  let account = null;
  if (channelId === 'official-site') {
    if (destination.kind !== 'owned_origin' || destination.accountId !== null || destination.locator?.origin !== settings.origin) {
      fail(409, 'OWNED_DESTINATION_REQUIRED', 'The native owned destination must bind this exact public site origin.');
    }
    accountId = `owned:${ctx.actorId}`;
    if (input.accountId !== undefined && input.accountId !== accountId) {
      fail(409, 'OWNED_ACCOUNT_MISMATCH', 'Use the owner identity derived from the local configuration.');
    }
  } else {
    accountId = identifier(input.accountId ?? destination.accountId, 'accountId');
    account = app.editorial.getAccount(accountId);
    if (destination.accountId !== accountId || account.platformId !== channelId || account.status !== 'active' ||
      account.identityReview?.status !== 'verified' || account.policyStatus !== 'reviewed') {
      fail(409, 'NATIVE_ACCOUNT_NOT_READY', 'Read back the verified native account and its matching destination first.');
    }
  }
  const expiresAt = instant(input.expiresAt, 'expiresAt');
  if (expiresAt <= timestamp) fail(422, 'CAPABILITY_EXPIRED', 'Set an unexpired review window.');
  const evidenceRef = string(input.evidenceRef, 'evidenceRef', 500);
  const policyRef = string(input.policyRef, 'policyRef', 500);
  if (requestedWrite && channelId !== 'official-site' && !(input.official === true && input.safeDedup === true && input.businessReadback === true)) {
    fail(422, 'EXTERNAL_WRITE_PROOF_REQUIRED', 'Confirm documented official submission, original-object lookup and reliable deduplication for this account.');
  }
  const hostCheck = { destinationId: destination.id, destinationVersion: destination.revision,
    destinationIdentityVersion: destination.identityVersion, accountId, accountVersion: account?.revision ?? null };
  return { channelId, accountId, destination: destination.id, form, action, visibility: destination.visibility,
    active: input.active !== false, mode: configured,
    official: requestedWrite, safeDedup: requestedWrite, businessReadback: requestedWrite,
    confirmationRequired: configured === 'platform_confirmation', expiresAt, policyRef, evidenceRef, rulesHash: hash([hostCheck, policyRef]),
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    ...(input.restored === true ? { restored: true, restoreEvidenceRef: input.restoreEvidenceRef } : {}),
    idempotencyKey: input.idempotencyKey };
}

function candidateWorkers(settings) {
  const workers = new Map();
  for (const row of [...(settings.browserTargets ?? []), ...(settings.browserWorkers ?? [])]) {
    const targetId = identifier(row.id ?? row.targetId, 'targetId');
    workers.set(targetId, { id: targetId, label: string(row.label ?? targetId, 'label', 100) });
  }
  return workers;
}

function assignmentDirectory(settings) {
  return join(settings.dataDir, 'browser-assignments');
}

export function configuredBrowserTargets(settings) {
  const workers = candidateWorkers(settings);
  const targets = new Map((settings.browserTargets ?? []).filter(row => row.taskId && row.accountId).map(row => [row.id, row]));
  const directory = assignmentDirectory(settings);
  let files;
  try { files = readdirSync(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return [...targets.values()];
    throw error;
  }
  privateDirectory(directory);
  const records = files.filter(name => /^assignment-[a-f0-9]{64}\.json$/u.test(name)).map(name => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) {
      fail(503, 'BROWSER_ASSIGNMENT_INVALID', 'Browser assignment files must be private regular owner files.');
    }
    return readRecord(path);
  });
  records.sort((left, right) => left.assignedAt - right.assignedAt || left.id.localeCompare(right.id));
  for (const record of records) {
    if (record.workspaceId !== settings.ctx.workspaceId || record.ownerId !== settings.ctx.actorId || !workers.has(record.targetId)) continue;
    const entry = workers.get(record.targetId);
    if (record.state === 'revoked') {
      targets.delete(entry.id);
    } else {
      targets.set(entry.id, { id: entry.id, label: entry.label, ownerId: record.ownerId, workspaceId: record.workspaceId,
        taskId: record.taskId, accountId: record.accountId, channelId: record.channelId });
    }
  }
  return [...targets.values()];
}

export function browserTaskAuthorizes(core, ctx, target, now = Date.now()) {
  if (!target.taskId || !target.accountId || target.ownerId !== ctx.actorId || target.workspaceId !== ctx.workspaceId) return false;
  try {
    const task = core.getTask(target.taskId, ctx);
    const mandate = core.getMandate(task.mandateId, ctx);
    return {
      task,
      channel: mandate.ownerId === ctx.actorId && mandate.state === 'active' && mandate.revision === task.mandateRevision &&
        (!mandate.expiresAt || mandate.expiresAt > now) && !['cancelled', 'expired', 'paused'].includes(task.state) &&
        (task.deadlineAt == null || task.deadlineAt > now) &&
        task.channels.find(ch => ch.accountId === target.accountId && (!target.channelId || ch.channelId === target.channelId) &&
          !ch.ownerSubmissionId && (ch.disposition === 'owner_confirmation' || ch.disposition === 'handoff' ||
            ch.disposition === 'reviewed' && ch.plannedDisposition === 'owner_confirmation')),
    };
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

export function writeBrowserAssignment({ settings, core, ctx }, input, now = Date.now()) {
  object(input, 'browser assignment');
  const targetId = identifier(input.targetId, 'targetId');
  if (!candidateWorkers(settings).has(targetId)) fail(404, 'BROWSER_WORKER_NOT_FOUND', 'Declare this exact gateway worker before assigning it.');
  const descriptor = { targetId, ownerId: ctx.actorId, workspaceId: ctx.workspaceId,
    taskId: identifier(input.taskId, 'taskId'), accountId: identifier(input.accountId, 'accountId'),
    channelId: identifier(input.channelId, 'channelId'), state: input.active === false ? 'revoked' : 'active' };
  if (descriptor.state === 'active' && !browserTaskAuthorizes(core, ctx, descriptor, now)?.channel) {
    fail(403, 'BROWSER_TASK_NOT_AUTHORIZED', 'Only the current exact task and account awaiting platform confirmation can be assigned.');
  }
  const requestId = identifier(input.idempotencyKey, 'idempotencyKey');
  const id = `assignment-${hash([ctx.workspaceId, targetId, requestId])}`;
  const directory = privateDirectory(assignmentDirectory(settings));
  const saved = putRecord(directory, id, { ...descriptor, id, assignedAt: now });
  if (!saved || hash(descriptor) !== hash(Object.fromEntries(Object.entries(saved).filter(([key]) => !['id', 'assignedAt'].includes(key))))) {
    fail(409, 'BROWSER_ASSIGNMENT_CONFLICT', 'This assignment request key already represents different scope.');
  }
  return { ...saved, restartRequired: true };
}
