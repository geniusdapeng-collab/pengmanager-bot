import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createBotCore } from '../src/bot/core.mjs';
import { createBotOperations, createDevConnector, createNativeBotAdapter, loadOperationsCatalog, planChannels, runBotStep } from '../src/bot/operations.mjs';
import { compareGeoRounds, createGeoBotAdapter } from '../src/bot/operations-geo.mjs';
import { hash } from '../src/bot/core-store.mjs';
import { ContentDirectorService } from '../src/services/content-director-service.mjs';
import { ContentOpsService } from '../src/services/content-ops-service.mjs';
import { contentOpsRef } from '../src/domain/content-ops.mjs';
import { JsonStore } from '../src/storage/json-store.mjs';
import { loadSeedState, migrateEditorialState } from '../src/services/bootstrap.mjs';
import { migrateContentOpsState } from '../src/services/content-ops-migration.mjs';
import { migrateContentDirectorState } from '../src/services/content-director-migration.mjs';
import { EditorialService } from '../src/services/editorial-service.mjs';
import { MediaAssets } from '../src/services/media-assets.mjs';
import { GeoOsService } from '../src/services/geo-os-service.mjs';
import { createEditorialBackup } from '../src/services/editorial-backup.mjs';
import { createWebsiteReadback } from '../src/services/website-readback.mjs';
import { createGeoOsServer } from '../src/http/server.mjs';
import { fixtureIllustrationProof, registerFixtureIllustrator, syntheticIllustrationPng } from './fixtures/article-illustrations.mjs';
import { evaluateFixture } from '../scripts/bot-evaluate.mjs';

const owner = { workspaceId: 'fixture', projectId: 'pengmanager', role: 'owner', actorId: 'fixture-owner' };
const worker = { ...owner, role: 'worker', actorId: 'fixture-worker' };
const reviewer = { ...owner, role: 'reviewer', actorId: 'fixture-reviewer' };
const connector = { ...owner, role: 'connector', actorId: 'fixture-connector' };
const site = { channelId: 'official-site', accountId: 'fixture-site-owner', destination: 'official-site', form: 'article', action: 'publish', visibility: 'public' };
const date = Date.parse('2026-11-27T01:02:00Z');
const sourceClaim = {
  id: 'SRC-001', text: 'A rejected local transaction does not change the active public revision.', type: 'project',
  state: 'approved', publicLevel: 'approved_public', sensitivity: 'low', evidenceLevel: 'A', expiresAt: null,
  source: { label: 'Isolated source document', url: 'https://www.sqlite.org/lang_transaction.html', visibility: 'public' },
};
const local = row => ({ method: 'local', actor: 'fixture-editorial-owner', idempotencyKey: randomUUID(), ...(row ? { ifMatch: row.etag } : {}) });

function modelResult(value, id) {
  return { value, receipt: { responseId: id, requestedModel: 'fixture', resolvedModel: 'fixture',
    requestHash: hash(`req:${id}`), responseHash: hash(`res:${id}`), usage: { total_tokens: 1 } } };
}

function articleModel(calls) {
  const chapters = {
    invariants: ['Editor and reader view', 'A reader opens a stable reference to find approved material while an editor needs room to assemble and revise a candidate. A single state can obscure the distinction between a review and the public result.',
      'Keep a separate route record and candidate reference so a browser remains tied to the earlier revision during preparation. Record each identifier in the change log, together with the exact package that was audited. Maintain the same distinction in the workspace labels so a proof of editorial review cannot be mistaken for evidence of a public result. Save each item as part of that original task.'],
    evidence: ['Checking the candidate', 'Before a candidate advances, confirm that each paragraph still carries the context and limitations of the evidence. Compare the stored source and the package the reader will see. Review the captions together with the illustrations.',
      'Read the media as bytes and retain a digest that can be compared later. Use the same expected version at each step so that accepting a late response cannot silently change the document.'],
    effects: ['Handling interruption', 'The job can lose its response while a change is already in progress. Keep the original request identifier available so a follow-up can read what happened before issuing a new operation. Keep unresolved work visible in the task state.',
      'A rejection before the transaction changes no active revision. If the route exists, it should still point to the earlier published version. This makes recovery independent of the timing of an operator page refresh.'],
    readback: ['Verifying what readers see', 'Open the published path as a reader would and compare the returned document with the approved snapshot. Retrieve the referenced media separately so a correct article body does not conceal a broken asset link.',
      'Write the verification time and the public route in the delivery record. If the test cannot read the page, keep the candidate and retry the original observation after access returns.'],
  };
  return {
    async generateOutline({ brief }) {
      calls.push('outline');
      return modelResult({ title: 'Reviewing a versioned article before changing its public route',
        summary: 'A practical workflow for reviewing an article candidate, surviving interruption and verifying the published version.',
        sections: Object.entries(chapters).map(([key, [title]]) => ({ key, title, purpose: title,
          targetCharacters: 480, claimIds: brief.claimIds })) }, 'outline');
    },
    async draftSection({ section }) {
      const [title, first, second] = chapters[section.key];
      return modelResult({ title, body: `${first}\n\n${second}`, paragraphs: [first, second], claimIds: section.claimIds }, section.key);
    },
    async auditArticle() {
      return modelResult({ assessment: 'The isolated article is structurally ready.', findings: [],
        coverage: Object.fromEntries(['facts', 'structure', 'expression', 'policy', 'technical', 'visual'].map(key => [key, 'checked'])) }, 'audit');
    },
  };
}

async function nativeFixture(t, { onReview } = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'pengmanager-bot-operations-'));
  const store = new JsonStore({ filePath: join(directory, 'state.json') });
  await store.open(() => loadSeedState(resolve(import.meta.dirname, '../data/seed')));
  const approvals = [];
  const approval = { async review(input) {
    approvals.push(input.kind);
    await onReview?.(input);
    return { schema: 'pengmanager.ai-approval/v1', actor: 'ai-reviewer', kind: input.kind, subjectId: input.subjectId,
      snapshotHash: input.snapshotHash, evidenceHash: hash([input.kind, input.snapshotHash, input.evidence]),
      decision: 'approve', reviewedAt: new Date(date).toISOString(), modelReceipt: { responseId: `isolated-${input.kind}` } };
  } };
  let editorial;
  const mediaAssets = new MediaAssets({ store, aiApproval: approval,
    publicAssetAuthorizer: (id, sha) => editorial.isAssetPublic(id, sha) });
  await mediaAssets.initialize();
  const service = new GeoOsService({ store });
  // The native HTTP server captures its editorial dependency at construction.
  // Start a bounded local listener after native seed and route initialization.
  const probe = await import('node:net').then(({ createServer }) => createServer());
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolveClose => probe.close(resolveClose));
  const origin = `http://127.0.0.1:${port}`;
  await migrateEditorialState(store, { publicOrigin: origin });
  const backup = createEditorialBackup({ store, mediaAssets, clock: () => new Date(date) });
  await migrateContentOpsState(store, { beforeMigration: () => backup.captureCurrent() });
  await migrateContentDirectorState(store, { beforeMigration: () => backup.captureCurrent() });
  await store.mutate({ type: 'fixture.claim', actor: 'fixture', payload: {} }, state => {
    state.claims.push(sourceClaim);
  });
  editorial = new EditorialService({ store, geoService: service, mediaAssets, aiApproval: approval, publicOrigin: origin,
    clock: () => new Date(date), beforeActivation: backup,
    verifyReadback: createWebsiteReadback({ origin, allowLoopback: true, clock: () => new Date(date) }) });
  await editorial.updateDestination('official-site', {
    status: 'active', visibility: 'public', identityConfirmed: true, policyStatus: 'reviewed',
    policyCheckedAt: new Date(date).toISOString(), reviewNote: 'The isolated listener owns this test-only authority.',
  }, local(editorial.getDestination('official-site')));
  const nativeServer = createGeoOsServer({ service, publicDir: resolve(import.meta.dirname, '../public'), editorial,
    mediaAssets, publicWebsite: true });
  nativeServer.listen(port, '127.0.0.1');
  await once(nativeServer, 'listening');
  const calls = [];
  const contentDirector = new ContentDirectorService({ store, editorial, mediaAssets, model: articleModel(calls), aiApproval: approval,
    autoStart: true, clock: () => new Date(date), artifactRoot: join(directory, 'content-director') });
  const contentOps = new ContentOpsService({ store, aiApproval: approval, clock: () => new Date(date) });
  const app = { contentDirector, contentOps, editorial, store, mediaAssets };
  const illustrator = await registerFixtureIllustrator(editorial, local);
  const native = createNativeBotAdapter({ app, mode: 'fixture', now: () => date,
    async loadIllustration({ plan, slot }) {
      const bytes = await syntheticIllustrationPng(plan.slots.findIndex(row => row.id === slot.id) + 1);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const media = { sha256, width: 12, height: 10, size: bytes.length };
      return { bytes, sha256, rightsNote: 'Fixture-generated pixels, isolated publication permission.',
        ...(slot.kind === 'scene' ? { designerCompositor: fixtureIllustrationProof('pengmanager-designer-compositor', plan, slot, media, illustrator) } : {}) };
    } });
  t.after(async () => {
    nativeServer.closeAllConnections();
    await new Promise(resolveClose => nativeServer.close(resolveClose));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, calls, approvals, origin, native };
}

test('the 28 channels disclose exact supported forms, archive defaults, and account confirmation gates', () => {
  const catalog = loadOperationsCatalog();
  const matrix = planChannels({ catalog,
    opportunity: { facts: [{ claimId: sourceClaim.id, state: 'approved' }], forms: ['article', 'video'],
      artifacts: [{ form: 'video', state: 'approved', sha256: 'f'.repeat(64) }], questionRef: 'real-question' },
    mandate: { requiredOutcomes: ['official-site', 'devto', 'zhihu', 'bilibili', 'maimai'],
      allowedActions: [{ ...site, risk: 'low' }] }, capabilities: [{ ...site, active: true, evidenceRef: 'owned-site-verified', expiresAt: date + 1000,
        official: true, safeDedup: true, businessReadback: true, confirmationRequired: false }], now: date,
  });
  assert.equal(matrix.channels.length, 28);
  assert.equal(new Set(matrix.channels.map(row => row.roleId)).size, 28);
  const byChannel = id => matrix.channels.find(row => row.channelId === id);
  assert.equal(byChannel('official-site').disposition, 'publish');
  assert.equal(byChannel('devto').machinePublish, false);
  assert.equal(byChannel('zhihu').disposition, 'manual');
  assert.equal(byChannel('bilibili').disposition, 'prepare');
  assert.equal(byChannel('maimai').disposition, 'archived');
});

test('BOT-owned native job stays leased through real local website activation and byte readback', async t => {
  const f = await nativeFixture(t);
  const core = createBotCore({ clock: () => date });
  t.after(() => core.close());
  const mandate = core.createMandate({ objective: 'Explain article publication mechanics', idempotencyKey: 'fixture-mandate',
    allowedActions: [site], requiredOutcomes: [site.channelId] }, owner);
  core.recordCapability({ ...site, official: true, safeDedup: true, businessReadback: true,
    expiresAt: date + 86400000, policyRef: 'owner-scope', evidenceRef: 'native-fixture-site', idempotencyKey: 'site-capability' }, owner);
  const task = core.createTask({ title: 'Verified publishing workflow', mandateId: mandate.id, idempotencyKey: 'fixture-native-task',
    input: { opportunity: { title: 'Explain safe publication of a versioned article', locale: 'en-US', claimIds: [sourceClaim.id],
      primaryMarketing: true, duplicate: true, correction: true, websiteSlug: 'untrusted-path' } } }, owner);
  const ops = createBotOperations({ nativeApp: f.app, native: f.native, mode: 'fixture', clock: () => date,
    semanticPlanner: async input => {
      assert.equal(input.facts[0].sourceUrl, sourceClaim.source.url);
      return { value: { action: 'prepare', reason: 'Reader demand is supported by the approved primary source.', claimIds: [sourceClaim.id] } };
    } });
  async function drive(role, kind) {
    const step = core.claim({ kinds: [kind] }, role);
    assert.ok(step, `expected a ${kind} lease`);
    return runBotStep(core, ops, step, role);
  }
  assert.equal((await drive(worker, 'discover')).state, 'succeeded');
  const prepared = await drive(worker, 'prepare');
  assert.equal(prepared.state, 'succeeded', JSON.stringify({ output: prepared.output,
    findings: prepared.output.jobId ? (await f.app.contentDirector.getJob(prepared.output.jobId)).findings : [] }));
  const separate = await f.app.contentDirector.createJob({ intent: 'Isolated lease control', explicitKind: 'article',
    claimIds: [sourceClaim.id] }, local(), { managedExecution: true });
  await assert.rejects(f.app.contentDirector.processJob(separate.id), { code: 'MANAGED_JOB_LEASE_REQUIRED' });
  const channel = await drive(reviewer, 'review');
  assert.equal(channel.state, 'succeeded', JSON.stringify(channel.output));
  assert.notEqual(channel.output.packageRecord.slug, 'untrusted-path');
  const expectedPath = `/en/articles/${channel.output.packageRecord.slug}`;
  assert.equal((await fetch(f.origin + expectedPath)).status, 404);
  const published = await drive(connector, 'publish');
  assert.equal(published.state, 'succeeded', JSON.stringify(published.output));
  const body = await (await fetch(f.origin + expectedPath)).text();
  assert.match(body, /Reviewing a versioned article/);
  const result = core.getEffect(published.output.operationKey, connector);
  assert.equal(result.verificationMethod, 'server_readback');
  assert.equal(result.dataMode, 'fixture');
  const release = f.app.editorial.getRelease(result.remoteId);
  assert.equal(release.receipt.assetHashes.length, 3);
  assert.equal(release.activationBackup.stage, 'pre_activation');
  assert.equal(release.previousReleaseId, null);
  assert.deepEqual(f.approvals.filter(name => name === 'editorial.media').length, 3);
  const work = core.getTask(task.id, owner);
  assert.deepEqual(work.observations.map(row => (row.dueAt - result.publishedAt) / 86400000), [1, 3, 7]);

  const correctionClaim = { ...sourceClaim, id: 'SRC-002',
    text: 'A rejected transaction or a rejected preflight leaves the current public revision in place.' };
  await f.app.store.mutate({ type: 'fixture.corrected-source', actor: 'fixture', payload: {} }, state => state.claims.push(correctionClaim));
  const corrected = core.createMandate({ objective: 'Correct the versioned article when its original source changes',
    idempotencyKey: 'correction-mandate', sources: ['release-feed'], allowedActions: [{ ...site, action: 'replace', maxDaily: 4 }],
    requiredOutcomes: [site.channelId], trustScope: { autonomousCorrections: { sources: ['release-feed'] } } }, owner);
  core.recordCapability({ ...site, action: 'replace', official: true, safeDedup: true, businessReadback: true,
    expiresAt: date + 86400000, policyRef: 'owner-replace-scope', evidenceRef: 'native-fixture-replace', idempotencyKey: 'replace-capability' }, owner);
  const accepted = core.ingestEvent({ mandateId: corrected.id, sourceId: 'release-feed', eventKey: 'corrected-source-v2',
    payloadRef: 'exact-authorized-poll-event', title: 'Versioned source correction' }, { ...owner, role: 'system', actorId: 'fixture-source-scheduler' });
  assert.equal(accepted.tasks.length, 1);
  const nextOps = createBotOperations({ nativeApp: f.app, native: f.native, mode: 'fixture', clock: () => date,
    resolveOpportunity: async () => ({ title: 'Correct safe publication with new preflight evidence', locale: 'en-US',
      sourceUrl: correctionClaim.source.url, claimIds: [sourceClaim.id, correctionClaim.id],
      candidate: { text: correctionClaim.text, sourceUrl: correctionClaim.source.url } }),
    semanticPlanner: async input => {
      assert.equal(input.correction.releaseId, release.id);
      assert.equal(input.published[0].releaseId, release.id);
      return { value: { action: 'correct', reason: 'The exact original source added the preflight limitation.', claimIds: [correctionClaim.id] } };
    } });
  for (const [kind, role] of [['discover', worker], ['prepare', worker], ['review', reviewer], ['publish', connector]]) {
    const step = core.claim({ kinds: [kind] }, role);
    assert.ok(step, `expected the correction ${kind} lease`);
    const result = await runBotStep(core, nextOps, step, role);
    assert.equal(result.state, 'succeeded', JSON.stringify(result.output));
  }
  const canonical = f.app.editorial.publicDetail({ locale: 'en-US', format: 'article', slug: channel.output.packageRecord.slug });
  const replacement = f.app.editorial.getRelease(canonical.id);
  assert.notEqual(replacement.id, release.id);
  assert.equal(replacement.previousReleaseId, release.id);
  assert.equal(replacement.storyId, release.storyId);
  assert.deepEqual(replacement.publicSnapshot.claimIds, [correctionClaim.id]);
});

test('revocation during independent release review leaves the exact candidate outside the public route', async t => {
  const core = createBotCore({ clock: () => date });
  t.after(() => core.close());
  const mandate = core.createMandate({ objective: 'Observe final activation when the owner stops', idempotencyKey: 'stop-gate-mandate',
    allowedActions: [site], requiredOutcomes: [site.channelId] }, owner);
  core.recordCapability({ ...site, official: true, safeDedup: true, businessReadback: true, expiresAt: date + 86400000,
    policyRef: 'owner-stop-scope', evidenceRef: 'native-fixture-stop', idempotencyKey: 'stop-gate-capability' }, owner);
  const f = await nativeFixture(t, { onReview(input) {
    if (input.kind === 'editorial.website_release') {
      core.revokeMandate(mandate.id, { expectedRevision: mandate.revision, idempotencyKey: 'stop-at-final-native-review' }, owner);
    }
  } });
  core.createTask({ title: 'Revocation test', mandateId: mandate.id, idempotencyKey: 'stop-gate-task',
    input: { opportunity: { title: 'Versioned publication', locale: 'en-US', claimIds: [sourceClaim.id] } } }, owner);
  const ops = createBotOperations({ nativeApp: f.app, native: f.native, mode: 'fixture', clock: () => date,
    semanticPlanner: async () => ({ value: { action: 'prepare', reason: 'A scoped lesson.', claimIds: [sourceClaim.id] } }) });
  const drive = (kind, role = worker) => runBotStep(core, ops, core.claim({ kinds: [kind] }, role), role);
  assert.equal((await drive('discover')).state, 'succeeded');
  assert.equal((await drive('prepare')).state, 'succeeded');
  const reviewed = await drive('review', reviewer);
  assert.equal(reviewed.state, 'succeeded');
  await assert.rejects(drive('publish', connector), { code: 'STALE_LEASE' });
  assert.equal((await fetch(f.origin + reviewed.output.packageRecord.canonicalPath)).status, 404);
  assert.equal(f.app.store.snapshot(['websiteRoutes']).websiteRoutes.length, 0);
  assert.equal(f.app.store.snapshot(['websiteReleases']).websiteReleases[0].status, 'approved');
});

test('Forem connector reads back original timed effects and never repeats a lost submit', async () => {
  const payload = { title: 'Fixture technical article', bodyMarkdown: 'A frozen fixture article without promotions.' };
  const user = { id: 7, user_id: 7, username: 'fixture-author' };
  let current = date;
  let post = 0;
  const data = { id: 21, published: true, published_at: new Date(date).toISOString(), user, title: payload.title,
    body_markdown: payload.bodyMarkdown, url: 'https://dev.to/fixture-author/fixture-article' };
  const calls = [];
  const dev = createDevConnector({ mode: 'fixture', apiKey: 'isolated-placeholder', accountId: 'dev-author',
    userId: user.id, username: user.username, now: () => current,
    fetchImpl: async (url, options) => {
      calls.push([url.pathname, options.method, Boolean(options.headers['api-key'])]);
      if (url.pathname === '/api/users/me') return Response.json(user);
      if (url.pathname === '/api/articles/me/all') return Response.json(post ? [data] : []);
      if (options.method === 'POST') {
        post++;
        throw new TypeError('connection lost after original POST');
      }
      return Response.json(data);
    } });
  const out = await dev.publish({ accountId: 'dev-author', payload, packageHash: hash(payload),
    beforeSubmit: () => ({ execute: true, operationKey: 'once-only' }), onSubmitted: () => assert.fail('Original POST result timed out.') });
  assert.equal(out.status, 'unknown');
  current += 2000;
  const receipt = await dev.reconcile({ accountId: 'dev-author', payload, packageHash: hash(payload), operationKey: 'once-only', submittedAfter: date });
  assert.equal(receipt.status, 'verified');
  assert.deepEqual(calls.at(-1), ['/api/articles/21', 'GET', false]);
  assert.equal((await dev.reconcile({ accountId: 'dev-author', payload, packageHash: hash(payload), operationKey: 'different', submittedAfter: current })).status, 'unknown');
  await assert.rejects(dev.publish({ accountId: 'dev-author', payload, packageHash: hash(payload),
    beforeSubmit: () => assert.fail('Duplicate article crossed the boundary.') }), { code: 'DEV_ARTICLE_ALREADY_PRESENT' });
  await assert.rejects(dev.identify('other-account'), { code: 'DEV_ACCOUNT_SCOPE_DENIED' });
  assert.equal(post, 1);
});

test('DEV needs a real native author contribution before the reviewed exact package may cross its connector', async t => {
  const { app, native } = await nativeFixture(t);
  const current = createBotCore({ clock: () => date });
  t.after(() => current.close());
  const handle = 'isolated-dev-author';
  const registered = await app.editorial.createAccount({ platformId: 'devto', handle, profileUrl: `https://dev.to/${handle}` }, local());
  const ownerReview = { status: 'active', identityConfirmed: true, policyStatus: 'reviewed',
    policyCheckedAt: new Date(date).toISOString(), reviewNote: 'Isolated account and policy information for this test.' };
  const account = await app.editorial.updateAccount(registered.id, ownerReview, local(registered));
  const targetDraft = await app.editorial.createDestination({ platformId: 'devto', accountId: account.id, kind: 'profile_feed',
    name: 'Isolated DEV article feed', locator: { url: `https://dev.to/${handle}` }, visibility: 'public' }, local());
  const destination = await app.editorial.updateDestination(targetDraft.id, ownerReview, local(targetDraft));
  const story = await app.editorial.createStory({ workingTitle: 'Versioned local release', claimIds: [sourceClaim.id] }, local());
  const author = await app.contentOps.createAuthorContribution({ storyRef: contentOpsRef(story), locale: 'en-US',
    title: 'First-hand exercise on interrupted publication',
    body: 'During an isolated run, I interrupted the release submission just before activation. I measured the visible route before and after the interruption and observed that the prior revision remained active.',
    sourceNote: 'The isolated author supplied this original practical exercise for educational use.',
    authoredBy: 'isolated-author' }, local());
  const target = { channelId: 'devto', accountId: account.id, destination: destination.id, form: 'article', action: 'publish', visibility: 'public' };
  current.recordCapability({ ...target, official: true, safeDedup: true, businessReadback: true, expiresAt: date + 86400000,
    policyRef: 'isolated-reviewed-rules', evidenceRef: 'isolated-connector-proof', idempotencyKey: 'dev-live-shape-capability' }, owner);
  const scope = { purpose: 'community_technical_education', authorContributionId: author.id };
  const mandate = current.createMandate({ objective: 'Teach the rollback exercise to developers', idempotencyKey: 'native-dev-mandate',
    allowedActions: [target], requiredOutcomes: [target.channelId], trustScope: { devto: scope } }, owner);
  const task = current.createTask({ title: 'Native DEV article', mandateId: mandate.id, idempotencyKey: 'native-dev-task',
    input: { opportunity: { title: 'Safe publication and versioned rollback', locale: 'en-US', claimIds: [sourceClaim.id] } } }, owner);
  let sent = null;
  const identity = { id: 41, username: handle };
  const dev = createDevConnector({ mode: 'fixture', apiKey: 'only-isolated-transport', accountId: account.id, userId: identity.id, username: handle,
    now: () => date, async fetchImpl(url, options) {
      if (url.pathname === '/api/users/me') return Response.json(identity);
      if (url.pathname === '/api/articles/me/all') return Response.json([]);
      if (options.method === 'POST') {
        const { article } = JSON.parse(options.body);
        sent = { ...article, id: 94, user: { ...identity, user_id: identity.id }, published_at: new Date(date).toISOString(),
          url: `https://dev.to/${handle}/verified-fixture` };
        return Response.json(sent, { status: 201 });
      }
      return Response.json(sent);
    } });
  const ops = createBotOperations({ nativeApp: app, native, dev, mode: 'fixture', clock: () => date,
    semanticPlanner: async input => {
      assert.equal(input.technicalAuthorContribution, true);
      return { value: { action: 'prepare', reason: 'The first-hand educational exercise is in scope.', claimIds: [sourceClaim.id] } };
    } });
  for (const [kind, role] of [['discover', worker], ['prepare', worker], ['review', reviewer], ['publish', connector]]) {
    const step = current.claim({ kinds: [kind] }, role);
    assert.ok(step, `expected the DEV ${kind} lease`);
    const result = await runBotStep(current, ops, step, role);
    assert.equal(result.state, 'succeeded', JSON.stringify(result.output));
    if (kind === 'review') assert.equal(result.output.packageRecord.authorContributionHash, author.hash);
  }
  assert.equal(sent.published, true);
  assert.match(sent.body_markdown, /^> Production disclosure: This technical article was prepared with AI assistance/);
  const work = current.getTask(task.id, owner);
  assert.equal(work.channels.find(row => row.channelId === 'devto').disposition, 'public_verified');
});

test('the exact Zhihu question creates a reviewed native owner handoff, with distinct confirmation and receipt', async t => {
  const { app } = await nativeFixture(t);
  const core = createBotCore({ clock: () => date });
  t.after(() => core.close());
  const questionId = '123456789';
  const questionUrl = `https://www.zhihu.com/question/${questionId}`;
  const ownerReview = { status: 'active', identityConfirmed: true, policyStatus: 'reviewed',
    policyCheckedAt: new Date(date).toISOString(), reviewNote: 'Approved isolated test source and account use only.' };
  const createdAccount = await app.editorial.createAccount({ platformId: 'zhihu', handle: 'isolated-author',
    profileUrl: 'https://www.zhihu.com/people/isolated-author' }, local());
  const account = await app.editorial.updateAccount(createdAccount.id, ownerReview, local(createdAccount));
  const createdDestination = await app.editorial.createDestination({ platformId: 'zhihu', accountId: account.id, kind: 'community',
    name: 'Isolated test question', locator: { url: questionUrl }, visibility: 'public' }, local());
  const destination = await app.editorial.updateDestination(createdDestination.id, ownerReview, local(createdDestination));
  const rule = await app.contentOps.createRuleSnapshot({ platformId: 'zhihu', destinationId: destination.id,
    policy: { creationMode: 'ai_assisted_draft', deliveryMode: 'manual_only', allowedAiActions: ['draft'],
      requiresAuthorContribution: false, requiredConditions: ['explicit_ai_disclosure'] },
    sources: [{ url: 'https://www.zhihu.com/knowledge-plan/manual', title: '创作者手册',
      scope: '问题回答与专栏的创作入口。', excerpt: '隔离测试记录，只用于验证规则、内容和目的地的摘要绑定。' }],
    checkedAt: new Date(date).toISOString(), expiresAt: new Date(date + 86400000).toISOString(),
    note: 'Isolated test conditions bound to the platform and destination.' }, local());
  const target = { channelId: 'zhihu', accountId: account.id, destination: destination.id, form: 'article', visibility: 'public', action: 'publish' };
  core.recordCapability({ ...target, confirmationRequired: true, mode: 'platform_confirmation',
    policyRef: rule.id, evidenceRef: 'isolated-owner-confirmation', idempotencyKey: 'fixture-zhihu-capability' }, owner);
  const mandate = core.createMandate({ objective: 'Prepare an answer for an already-existing question', idempotencyKey: 'fixture-zhihu-mandate',
    allowedActions: [{ ...target, risk: 'human' }], requiredOutcomes: [target.channelId],
    trustScope: { zhihu: { form: 'answer', questionId, questionTitle: '如何安全发布一篇有版本的文章？', url: questionUrl, ruleId: rule.id } } }, owner);
  const task = core.createTask({ title: 'Prepare a verified Zhihu answer', mandateId: mandate.id, idempotencyKey: 'fixture-zhihu-task',
    input: { opportunity: { title: '安全发布已有版本的文章', claimIds: [sourceClaim.id] } } }, owner);
  const native = createNativeBotAdapter({ app, mode: 'fixture', now: () => date,
    async adaptText({ target: exact }) {
      assert.equal(exact.questionId, questionId);
      return modelResult({ title: '如何安全发布有版本的文章', body: '先将已审核版本和公开入口分开保存。审核通过后核对媒体摘要和内容版本，再用同一事务变更公开入口。未成功时保留原版，切勿把尚未落地的候选稿当成公开结果。\n\n如果发布请求超时，先在原入口核对实际文章与图片。只有当结果已经确定，才能考虑新的请求。记录原任务、正文摘要和页面回读时间，可供编辑和作者复核。' }, 'zhihu-native-fixture');
    } });
  const ops = createBotOperations({ nativeApp: app, native, mode: 'fixture', clock: () => date,
    semanticPlanner: async () => ({ value: { action: 'prepare', reason: 'Approved first-party material can answer the exact question.', claimIds: [sourceClaim.id] } }) });
  const drive = (kind, role = worker) => runBotStep(core, ops, core.claim({ kinds: [kind] }, role), role);
  assert.equal((await drive('discover')).state, 'succeeded');
  let channel = core.getTask(task.id, owner).channels.find(row => row.channelId === 'zhihu');
  assert.equal(channel.disposition, 'owner_confirmation');
  assert.equal((await drive('prepare')).state, 'succeeded');
  const reviewed = await drive('review', reviewer);
  assert.equal(reviewed.state, 'succeeded', JSON.stringify(reviewed.output));
  assert.equal(reviewed.output.handoff.originalDestination, questionUrl);
  assert.match(reviewed.output.handoff.body, /^本文使用 AI 辅助整理/u);
  assert.equal(core.claim({ kinds: ['publish'] }, connector), null);
  let taskNow = core.getTask(task.id, owner);
  assert.equal(taskNow.state, 'waiting_input');
  assert.equal(taskNow.canResume, false);
  channel = taskNow.channels.find(row => row.channelId === 'zhihu');
  const confirmation = core.confirmTarget({ ...target, taskId: task.id, packageHash: reviewed.output.packageHash,
    expectedRevision: channel.revision, idempotencyKey: 'fixture-owner-confirm' }, owner);
  assert.equal(confirmation.state, 'owner_confirmed');
  taskNow = core.getTask(task.id, owner);
  assert.equal(taskNow.state, 'waiting_input');
  channel = taskNow.channels.find(row => row.channelId === 'zhihu');
  const receipt = core.recordOwnerSubmission({ ...target, taskId: task.id, taskRevision: taskNow.revision,
    packageHash: reviewed.output.packageHash, expectedRevision: channel.revision, receiptRef: 'manual-isolated-receipt',
    idempotencyKey: 'fixture-owner-receipt' }, owner);
  assert.equal(receipt.state, 'owner_reported');
  assert.equal(core.getTask(task.id, owner).state, 'partial');
});

test('GEO compares exact question and model pairs and excludes retrieved but uncited links', async () => {
  const target = 'https://site.example.test/en/articles/example';
  const query = { id: 'fixed-question', text: 'Which public source explains the process?' };
  let call = 0;
  let changed = false;
  const adapter = createGeoBotAdapter({ mode: 'fixture', engine: {
    listQueries: () => [query],
    async runVisibility() {
      call++;
      return { runId: `run-${call}`, dataMode: 'fixture', responseHash: hash(call), samples: [
        { id: `sample-${call}`, query_id: query.id, query_text: query.text, model: changed ? 'changed' : 'same',
          status: 'success', dataMode: 'fixture', evidenceHash: hash(['sample', call]),
          answer: call === 1 ? 'Use the public documentation for the workflow.' : 'The article explains the workflow [1].',
          citations: [{ url: target, kind: 'provider-search' }], raw: { searchResults: [{ url: target }] } },
      ] };
    },
  } });
  const scope = { provider: 'fixture', surface: 'isolated', questionRevision: 'fixed', queryIds: [query.id], observedUrls: [] };
  const first = await adapter.collect(scope, { expectedUrls: [target] });
  assert.equal(first.cited, 0);
  const second = await adapter.collect(scope, { expectedUrls: [target] });
  assert.equal(second.cited, 1);
  assert.deepEqual(compareGeoRounds(first, second, target), { paired: 1, citations: 1, baselineCitations: 0, status: 'verified' });
  changed = true;
  const third = await adapter.collect(scope, { expectedUrls: [target] });
  assert.equal(compareGeoRounds(first, third, target).status, 'sample_insufficient');
});

test('blind evaluation holds candidate labels and expected outcomes out of the 24 independent case pairs', () => {
  const run = evaluateFixture('fixed-test-seed');
  assert.equal(run.blinded.dataMode, 'fixture');
  assert.equal(run.blinded.blindCases.length, 48);
  assert.equal(new Set(run.blinded.blindCases.map(row => row.pairId)).size, 24);
  for (const row of run.blinded.blindCases) {
    assert.equal(Object.hasOwn(row, 'expected'), false);
    assert.equal(row.outputs.length, 2);
    assert.ok(row.outputs.every(output => !Object.hasOwn(output, 'assessment') &&
      !Object.hasOwn(output, 'arm') && output.channelPlan.length === 28 && output.rationale));
  }
  assert.equal(run.key.mapping.length, 96);
  assert.equal(run.report.evaluatedProvider, false);
  assert.equal(run.report.appliedPlan.businessPublications, 0);
  assert.equal(run.report.summary['evidence-fixture'].passedHoldoutPairs, 12);
  assert.equal(run.report.summary['frozen-rules'].passedHoldoutPairs, 4);
});
