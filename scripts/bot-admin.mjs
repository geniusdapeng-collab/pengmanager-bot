#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashAdminPassword } from '../src/security/admin-auth.mjs';
import { loadSettings } from '../src/bot/settings.mjs';
import { configuredBrowserTargets, deriveNativeCapability, inspectNative, nativeContext, writeBrowserAssignment } from '../src/bot/admin.mjs';
import { configuredOrigin } from '../src/bot/http-auth.mjs';
import { DAY, fail, hash, identifier, object } from '../src/bot/core-store.mjs';
import { digest, privateDirectory, putRecord, readRecord } from '../src/bot/files.mjs';

const MAX_INPUT = 262_144;
const USAGE = `PengManager owner CLI
  node scripts/bot-admin.mjs hash-password < secret-input
  node scripts/bot-admin.mjs demo [--port 4320] [--data-dir PATH] [--once]
  node scripts/bot-admin.mjs serve
  node scripts/bot-admin.mjs api --origin ORIGIN --path /dashboard [--method POST --input FILE] < secret-input
  node scripts/bot-admin.mjs inspect
  node scripts/bot-admin.mjs native-account|native-destination --input FILE [--review-mandate ID]
  node scripts/bot-admin.mjs native-claim-approve --input FILE --review-mandate ID
  node scripts/bot-admin.mjs native-producer-key --input FILE
  node scripts/bot-admin.mjs native-illustrations --input FILE
  node scripts/bot-admin.mjs capability|assign-browser --input FILE
  node scripts/bot-admin.mjs recover|complete-recovery --writer-fenced
  node scripts/bot-admin.mjs reconcile-effect|apply-cost --input FILE --writer-fenced
Use --input - for JSON on stdin except for api. API reads its password from stdin and uses a separate JSON file.
Offline operations use BOT_CONFIG and require the BOT service to be stopped on this data directory.`;

const valueOptions = new Set(['--port', '--data-dir', '--input', '--origin', '--path', '--method', '--review-mandate']);
const flags = new Set(['--help', '--once', '--writer-fenced']);
const credentialNames = ['BOT_OWNER_PASSWORD_HASH', 'BOT_MODEL_KEY', 'BOT_DEV_API_KEY', 'BOT_BROWSER_KEY', 'BOT_NOTIFICATION_KEY'];

async function createBotHost(options) {
  return (await import('../src/bot/host.mjs')).createBotHost(options);
}

function parseArguments(argv) {
  const [command = 'help', ...args] = argv;
  const values = Object.create(null);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (Object.hasOwn(values, option) || !valueOptions.has(option) && !flags.has(option)) fail(422, 'CLI_ARGUMENT_INVALID', 'Unknown or repeated option.');
    if (flags.has(option)) values[option] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) fail(422, 'CLI_ARGUMENT_INVALID', 'An option value is missing.');
      values[option] = value;
    }
  }
  return { command, values };
}

async function textInput(limit) {
  if (process.stdin.isTTY) fail(422, 'CLI_STDIN_REQUIRED', 'Provide the input from standard input.');
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > limit) fail(413, 'CLI_INPUT_TOO_LARGE', 'Standard input exceeds its limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function jsonInput(argument, allowStdin = true) {
  if (!argument || argument === '-' && !allowStdin) fail(422, 'CLI_INPUT_REQUIRED', 'Provide a separate JSON request document.');
  let raw;
  if (argument === '-') raw = await textInput(MAX_INPUT);
  else {
    const value = readRecord(resolve(argument));
    if (!value) fail(404, 'CLI_INPUT_NOT_FOUND', 'The requested input document was not found.');
    return object(value, 'input');
  }
  try { return object(JSON.parse(raw), 'input'); }
  catch (error) {
    if (error.code) throw error;
    fail(400, 'INVALID_JSON', 'The input document is not valid JSON.');
  }
}

function output(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function environmentWithCredentials(env) {
  if (!env.CREDENTIALS_DIRECTORY) return env;
  const resolved = { ...env };
  for (const name of credentialNames) {
    try {
      const value = readFileSync(join(env.CREDENTIALS_DIRECTORY, name));
      if (value.length < 1 || value.length > 4096) fail(422, 'INVALID_SERVICE_CREDENTIAL', 'The service credential file has an invalid size.');
      resolved[name] = value.toString('utf8').replace(/\r?\n$/u, '');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}

async function apiCall(options) {
  const target = configuredOrigin(options['--origin'] ?? process.env.BOT_ORIGIN);
  const route = options['--path'] ?? '/dashboard';
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.:@-]+)*(?:\?[^#\r\n]*)?$/u.test(route) || route.includes('..')) {
    fail(422, 'API_ROUTE_INVALID', 'Use a concrete path inside the owner BOT API.');
  }
  const endpoint = `/api/bot/v1${route}`;
  if (/\/browser\/internal(?:\/|\?|$)|\/session(?:\?|$)/u.test(endpoint)) {
    fail(403, 'API_ROUTE_DENIED', 'Use the documented authenticated owner commands.');
  }
  const method = options['--method'] ?? 'GET';
  if (!['GET', 'POST', 'PATCH'].includes(method)) fail(422, 'API_METHOD_INVALID', 'Use GET, POST or PATCH.');
  const input = method === 'GET' ? null : await jsonInput(options['--input'], false);
  const password = (await textInput(1026)).replace(/\r?\n$/u, '');
  const origin = target.origin;
  const login = await fetch(new URL('/api/bot/v1/session', target), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
    headers: { Origin: origin, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ password }),
  });
  const loginBody = await login.json();
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  if (login.status !== 201 || !cookie || !loginBody.csrfToken) fail(login.status, loginBody.error?.code ?? 'AUTH_REQUIRED', 'Owner login was not accepted.');
  const csrf = { Cookie: cookie, Origin: origin, 'X-CSRF-Token': loginBody.csrfToken };
  try {
    const response = await fetch(new URL(endpoint, target), {
      method, redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { ...csrf, Accept: 'application/json', ...(input ? { 'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey ?? hash([endpoint, input]), ...(input.expectedRevision === undefined ? {}
          : { 'If-Match': String(input.expectedRevision) }) } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    const result = await response.json();
    if (!response.ok) fail(response.status, result.error?.code ?? 'HTTP_ERROR', 'The owner API declined the request.');
    return result;
  } finally {
    try {
      await fetch(new URL('/api/bot/v1/session', target), { method: 'DELETE', headers: csrf, redirect: 'error', signal: AbortSignal.timeout(3000) });
    } catch {
      process.stderr.write('The temporary API session could not be signed out and will expire on the host.\n');
    }
  }
}

async function withAdminReview(host, nativeKind, input, options, operation) {
  const mandateId = options['--review-mandate'];
  if (!mandateId) fail(403, 'ADMIN_REVIEW_NOT_AUTHORIZED', 'A configured admin review mandate is required to price a new signed review.');
  if (host.settings.mode !== 'real' || !host.meter?.ready || !host.approval) {
    fail(503, 'ADMIN_REVIEW_UNAVAILABLE', 'Start from a priced real configuration with the independent review provider enabled.');
  }
  const { core, ctx, meter } = host;
  const mandate = core.getMandate(mandateId, ctx);
  if (mandate.trustScope?.adminReviews !== true) fail(403, 'ADMIN_REVIEW_NOT_AUTHORIZED', 'The owner did not grant administrative review under this mandate.');
  const actionHash = hash([nativeKind, input]);
  const work = core.createTask({ mandateId, kind: 'review', title: `Native setup review · ${nativeKind}`, priority: 100,
    input: { adminOnly: true, nativeKind, actionHash }, idempotencyKey: `native-admin-${actionHash}` }, ctx);
  if (core.getTask(work.id, ctx).state === 'succeeded') return operation();
  const reviewer = { ...ctx, role: 'reviewer', actorId: 'native-owner-reviewer' };
  const lease = core.claim({ kinds: ['review'], taskId: work.id, adminOnly: true, leaseMs: 90_000 }, reviewer);
  if (!lease) fail(409, 'ADMIN_REVIEW_RECOVERY_REQUIRED', 'Read the original review task and settle any existing attempt before resuming.', { taskId: work.id });
  let failed;
  const renew = setInterval(() => {
    try { core.heartbeat({ id: lease.id, epoch: lease.epoch, leaseMs: 90_000 }, reviewer); }
    catch (error) { failed = error; clearInterval(renew); }
  }, 20_000);
  try {
    const result = await meter.run(lease, reviewer, operation);
    if (failed) throw failed;
    core.report({ id: lease.id, epoch: lease.epoch, status: 'succeeded', output: { nativeKind, objectId: result.id, alreadyReviewed: true } }, reviewer);
    return result;
  } catch (error) {
    if (!failed) core.report({ id: lease.id, epoch: lease.epoch, status: 'waiting_input',
      output: { nativeKind, errorCode: /^[A-Z0-9_]{2,100}$/u.test(error.code ?? '') ? error.code : 'ADMIN_REVIEW_BLOCKED' } }, reviewer);
    throw error;
  } finally {
    clearInterval(renew);
  }
}

async function nativeMutation(host, command, input, options) {
  const { app, ctx } = host;
  const isAccount = command === 'native-account';
  const entityName = isAccount ? 'Account' : 'Destination';
  if (input.id === undefined) return app.editorial[`create${entityName}`](object(input.body, 'body'), nativeContext(ctx, input));
  const row = app.editorial[`get${entityName}`](identifier(input.id, 'id'));
  if (!input.ifMatch) fail(428, 'PRECONDITION_REQUIRED', 'Read native-inspect and supply the exact current ifMatch.');
  const patch = object(input.body, 'body');
  const mutation = () => app.editorial[`update${entityName}`](row.id, patch, nativeContext(ctx, input, row));
  if (patch.reviewProof || !(patch.identityConfirmed === true || patch.policyStatus === 'reviewed')) return mutation();
  return withAdminReview(host, `update-${entityName.toLowerCase()}`, input, options, mutation);
}

async function offline(command, options, env) {
  const recovery = ['recover', 'complete-recovery', 'reconcile-effect', 'apply-cost'].includes(command);
  if (recovery && options['--writer-fenced'] !== true) {
    fail(409, 'WRITER_FENCE_REQUIRED', 'Explicitly fence the old writer and then repeat with --writer-fenced.');
  }
  const host = await createBotHost({ env: recovery ? { ...env, BOT_RECOVERY: '1' } : env });
  try {
    const { core, app, ctx, settings, sys } = host;
    if (command === 'inspect') return { mode: settings.mode, health: core.health(ctx), ...inspectNative(app),
      capabilities: core.listCapabilities(ctx), assignments: settings.mode === 'real' ? configuredBrowserTargets(settings) : [] };
    if (command === 'recover' || command === 'complete-recovery') {
      const method = command === 'recover' ? 'restoreJournal' : 'completeRecovery';
      return { dataMode: settings.mode, ...core[method]({ writerFenced: true }, sys) };
    }
    const input = await jsonInput(options['--input']);
    if (command === 'native-account' || command === 'native-destination') {
      const row = await nativeMutation(host, command, input, options);
      return { id: row.id, status: row.status, etag: row.etag, policy: row.policyStatus, identity: row.identityReview?.status, dataMode: settings.mode };
    }
    if (command === 'native-claim-approve') {
      const body = object(input.body, 'body');
      const id = identifier(input.id, 'claim id');
      const mutate = () => app.service.approveClaim(id, body, { actor: ctx.actorId, aiApproval: host.approval });
      if (!host.approval) fail(503, 'ADMIN_REVIEW_UNAVAILABLE', 'The independent review service is unavailable.');
      const row = body.reviewProof ? await mutate() : await withAdminReview(host, 'approve-claim', input, options, mutate);
      return { id: row.id, publicLevel: row.publicLevel, state: row.state, independentlyReviewed: Boolean(row.aiReview), dataMode: settings.mode };
    }
    if (command === 'native-producer-key') {
      const result = await app.editorial.registerIllustrationProducerKey(object(input.body, 'body'), nativeContext(ctx, input));
      return { id: result.id, status: result.revokedAt ? 'revoked' : 'active', dataMode: settings.mode };
    }
    if (command === 'native-illustrations') {
      const plan = app.editorial.getArticleIllustrations(identifier(input.storyId, 'storyId'), identifier(input.planId, 'planId'));
      return { planId: plan.id, sourceHash: plan.sourceHash, complete: plan.isComplete, workOrders: plan.workOrders, dataMode: settings.mode };
    }
    if (command === 'capability') return core.recordCapability(deriveNativeCapability(host, input), ctx);
    if (command === 'assign-browser') return writeBrowserAssignment(host, input);
    core.restoreJournal({ writerFenced: true }, sys);
    if (command === 'reconcile-effect') {
      const receipt = core.recordEffect(input, { ...sys, role: 'connector', actorId: 'owner-reconciliation' });
      return { operationKey: receipt.operationKey, attempt: receipt.attempt, state: receipt.state, receiptRef: receipt.receiptRef, dataMode: receipt.dataMode };
    }
    if (command === 'apply-cost') {
      const id = identifier(input.costId, 'costId');
      if (!/^cost-[a-f0-9]{42}$/u.test(id)) fail(422, 'COST_ID_INVALID', 'Use a known original cost ID.');
      const saved = input.fromSavedProviderReceipt === true ? readRecord(join(settings.dataDir, 'provider-receipts', `${id}.json`)) : null;
      if (input.fromSavedProviderReceipt === true && (!saved || saved.costId !== id || saved.responseHash !== digest(saved.body))) {
        fail(409, 'PROVIDER_RECEIPT_CHANGED', 'Original provider use was not verified by a saved response.');
      }
      return core.settleCost(saved ? { costId: id, status: 'settled', actualMinor: saved.actualMinor,
        providerRef: saved.providerRef, evidenceRef: saved.responseHash } : input, sys);
    }
    fail(422, 'CLI_COMMAND_INVALID', 'This admin command is unavailable.');
  } finally {
    await host.stop();
  }
}

function seedDemo(host) {
  const { core, ctx, settings } = host;
  const worker = { ...ctx, role: 'worker', actorId: 'simulation-worker' };
  const checker = { ...ctx, role: 'reviewer', actorId: 'simulation-reviewer' };
  const connector = { ...ctx, role: 'connector', actorId: 'simulation-connector' };
  const target = { channelId: 'official-site', accountId: 'fixture-owner', destination: 'fixture-site',
    form: 'article', action: 'publish', visibility: 'public' };
  core.recordCapability({ ...target, official: true, safeDedup: true, businessReadback: true,
    evidenceRef: 'fixture-only', mode: 'owned', idempotencyKey: 'demo-capability' }, ctx);
  const mandate = core.createMandate({ objective: '跟踪可验证的工作交接实践（隔离演练）', sources: ['manual'],
    allowedActions: [target], requiredOutcomes: [{ channelId: 'official-site', outcome: 'public' }],
    idempotencyKey: 'demo-mandate' }, ctx);
  const work = core.createTask({ mandateId: mandate.id, title: '轮值交接演练记录', kind: 'prepare', priority: 10,
    idempotencyKey: 'demo-task' }, ctx);
  if (core.outcomes(mandate.id, ctx).counts.fixturePublicVerified > 0) return { mandateId: mandate.id, taskId: work.id };
  const evidence = { text: '轮值交接附上已完成、待跟踪、负责人三项。本记录是合成演练，无正式发布。', dataMode: 'fixture' };
  const packageHash = hash(evidence);
  const shelf = privateDirectory(join(settings.dataDir, 'fixture-artifacts'));
  putRecord(shelf, 'handover-note', evidence);
  const preparation = core.claim({ kinds: ['prepare'], taskId: work.id }, worker);
  if (!preparation) fail(409, 'DEMO_TASK_OCCUPIED', 'Use a fresh demo directory for this replay.');
  core.recordArtifact({ ...target, taskId: work.id, id: preparation.id, epoch: preparation.epoch,
    packageHash, artifactRef: 'fixture-artifacts/handover-note.json' }, worker);
  core.report({ id: preparation.id, epoch: preparation.epoch, status: 'succeeded',
    followups: [{ kind: 'review', key: 'demo-review', input: { channelId: 'official-site' } }] }, worker);
  const review = core.claim({ kinds: ['review'], taskId: work.id }, checker);
  const stored = readRecord(join(shelf, 'handover-note.json'));
  if (hash(stored) !== packageHash) fail(409, 'DEMO_ARTIFACT_CHANGED', 'The isolated artifact failed its digest check.');
  core.recordReview({ taskId: work.id, channelId: target.channelId, id: review.id, epoch: review.epoch, packageHash,
    reportHash: hash([packageHash, 'isolated-artifact-checked']), verified: true, outcome: 'passed' }, checker);
  core.report({ id: review.id, epoch: review.epoch, status: 'succeeded',
    followups: [{ kind: 'publish', key: 'demo-publish', input: { channelId: 'official-site' } }] }, checker);
  const publish = core.claim({ kinds: ['publish'], taskId: work.id }, connector);
  const permit = core.issuePermit({ ...target, taskId: work.id, packageHash, expectedPreviousReleaseId: null,
    idempotencyKey: 'demo-permit' }, host.sys);
  const crossing = core.consumePermit({ permitId: permit.id, id: publish.id, epoch: publish.epoch }, connector);
  if (!crossing.execute) fail(409, 'DEMO_EFFECT_EXISTS', 'The fixture operation already exists.');
  const at = Date.now();
  core.recordEffect({ operationKey: crossing.operationKey, status: 'verified', packageHash, accountId: target.accountId,
    remoteId: 'fixture-handover-01', receiptRef: 'fixture-only-receipt', visibility: 'public',
    publishedAt: at, verifiedAt: at, url: 'https://pengmanager-fixture.test/handover', verificationMethod: 'fixture_readback' }, connector);
  core.report({ id: publish.id, epoch: publish.epoch, status: 'succeeded', output: { dataMode: 'fixture' } }, connector);
  return { mandateId: mandate.id, taskId: work.id };
}

async function runServer(host) {
  await host.start();
  const shutdown = () => {
    host.stop().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function demo(options) {
  const root = options['--data-dir'] ? resolve(options['--data-dir']) : mkdtempSync(join(realpathSync(tmpdir()), 'pengmanager-bot-demo-'));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dataDir = privateDirectory(root);
  const port = options['--port'] ?? '4320';
  const env = { BOT_MODE: 'fixture', BOT_DATA_DIR: dataDir, PORT: port, HOST: '127.0.0.1' };
  const host = await createBotHost({ env, settings: loadSettings(env), logger: options['--once'] ? { log() {}, error() {} } : console });
  let run = false;
  try {
    const seeded = seedDemo(host);
    if (options['--once'] === true) {
      await host.start();
      const response = await fetch(new URL('/bot/healthz', host.settings.origin), { redirect: 'error', signal: AbortSignal.timeout(3000) });
      const health = await response.json();
      if (!response.ok || health.service !== 'pengmanager-bot') fail(503, 'DEMO_HTTP_UNAVAILABLE', 'The fixture host did not return a loopback health receipt.');
      return { dataMode: 'fixture', externalWrites: 0, ...seeded, health, counts: host.core.outcomes(seeded.mandateId, host.ctx).counts,
        origin: host.settings.origin, dataDir };
    }
    await runServer(host);
    run = true;
    return { dataMode: 'fixture', externalWrites: 0, ...seeded, origin: host.settings.origin, dataDir };
  } finally {
    if (!run) await host.stop();
  }
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === 'help' || command === '--help' || values['--help']) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  if (command === 'hash-password') {
    const password = (await textInput(1026)).replace(/\r?\n$/u, '');
    process.stdout.write(await hashAdminPassword(password) + '\n');
    return;
  }
  if (command === 'demo') return output(await demo(values));
  if (command === 'api') return output(await apiCall(values));
  const env = environmentWithCredentials(process.env);
  if (command === 'serve') {
    const host = await createBotHost({ env });
    try { await runServer(host); }
    catch (error) { await host.stop(); throw error; }
    return;
  }
  const supported = ['inspect','native-account','native-destination','native-claim-approve','native-producer-key','native-illustrations',
    'capability','assign-browser','recover','complete-recovery','reconcile-effect','apply-cost'];
  if (!supported.includes(command)) fail(422, 'CLI_COMMAND_INVALID', 'Run help for the supported administration commands.');
  output(await offline(command, values, env));
}

try {
  await main();
} catch (error) {
  const known = /^[A-Z0-9_]{2,100}$/u.test(error.code ?? '');
  process.stderr.write(JSON.stringify({ error: { code: known ? error.code : 'BOT_ADMIN_FAILED',
    message: Number.isInteger(error.status) && error.status < 500 ? error.message : 'The BOT administration request did not finish.',
    ...(Number.isInteger(error.status) && error.status < 500 && error.details ? { details: error.details } : {}),
  } }) + '\n');
  process.exitCode = 1;
}
