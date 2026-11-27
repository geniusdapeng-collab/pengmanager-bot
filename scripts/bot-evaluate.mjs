import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeChannelExceptions, loadOperationsCatalog, planChannels } from '../src/bot/operations-policy.mjs';
import { hash } from '../src/bot/core-store.mjs';

const NOW = Date.parse('2026-11-27T00:00:00Z');
const TARGETS = {
  site: { channelId: 'official-site', form: 'article', accountId: 'eval-site', destination: 'eval-articles' },
  dev: { channelId: 'devto', form: 'article', accountId: 'eval-dev', destination: 'eval-dev-feed' },
  video: { channelId: 'bilibili', form: 'video', accountId: 'eval-video', destination: 'eval-video-feed' },
  author: { channelId: 'wechat-official', form: 'article', accountId: 'eval-author', destination: 'eval-author-feed' },
};
const GROUPS = [
  { id: 'correction', titles: ['接口范围', '安装条件', '产物校验', '状态定义'], left: 'correct', right: 'skip' },
  { id: 'reader-gap', titles: ['失败恢复', '旧版导入', '复现步骤', '字段约束'], left: 'skip', right: 'prepare' },
  { id: 'audience-fit', titles: ['开发者文档', '兼容性检查', '升级练习', '依赖定位'], left: 'prepare', right: 'skip' },
  { id: 'native-media', titles: ['视频部署', '视频校验', '视频排版', '视频样例'], left: 'prepare', right: 'defer' },
  { id: 'available-budget', titles: ['读者复测', '公开编辑', '核对引用', '整理样例'], left: 'prepare', right: 'defer' },
  { id: 'owner-dependency', titles: ['业务流程', '作者实测', '历史笔记', '实施体会'], left: 'prepare', right: 'prepare' },
];

function fixtureCase(group, index, variant) {
  const pairId = `${group.id}-${index + 1}`;
  const id = `${pairId}-${variant}`;
  const title = `${group.titles[index]}的适用边界`;
  const claimId = `source-${pairId}`;
  const fact = { claimId, state: 'approved', expiresAt: null };
  const sources = [{ claimId, kind: 'synthetic-primary',
    uri: `https://evidence.example.test/${pairId}`, text: `隔离材料涉及${group.titles[index]}；证据具体适用范围由该题的一项变化决定。` }];
  const must = group.id === 'native-media' ? [TARGETS.video.channelId] : [TARGETS.site.channelId];
  const optional = [TARGETS.dev.channelId];
  if (group.id === 'owner-dependency') {
    (variant === 'a' ? must : optional).push(TARGETS.author.channelId);
  }
  const fixed = {
    allowedActions: [
      { ...TARGETS.site, action: 'publish', risk: 'low' }, { ...TARGETS.site, action: 'replace', risk: 'low' },
      { ...TARGETS.dev, action: 'publish', risk: 'low' }, { ...TARGETS.video, action: 'publish', risk: 'human' },
      { ...TARGETS.author, action: 'publish', risk: 'human' },
    ],
    budget: { currency: 'CNY', limitMinor: 100 },
  };
  const availableMinor = group.id === 'available-budget' && variant === 'b' ? 10 : 100;
  const opportunity = { title, facts: [fact], forms: group.id === 'native-media' ? ['video'] : ['article'],
    estimatedMinor: 30, availableMinor };
  const material = {
    claimId,
    ...(group.id === 'correction' ? { originalRelease: 'fixture-owner-release', originalSourceChanged: variant === 'a' } : {}),
    ...(group.id === 'reader-gap' ? { knownPublication: 'fixture-prior-explanation', documentsMissingStep: variant === 'b' } : {}),
    ...(group.id === 'audience-fit' ? { readerDiscussionMatches: variant === 'a' } : {}),
    ...(group.id === 'native-media' ? { playableArtifact: variant === 'a' ? hash(pairId) : null } : {}),
    ...(group.id === 'owner-dependency' ? { authorContributionMissing: true } : {}),
  };
  if (material.playableArtifact) opportunity.artifacts = [{ form: 'video', state: 'approved', sha256: material.playableArtifact }];
  const requiredOutcomes = must.map(channelId => ({ channelId, outcome: 'public' }));
  const capabilities = [TARGETS.site, TARGETS.dev].flatMap(target => ['publish', 'replace'].map(action => ({
    ...target, action, active: true, official: true, safeDedup: true, businessReadback: true, confirmationRequired: false,
    evidenceRef: `fixture-capability-${target.channelId}-${action}`, policyRef: 'fixture-reviewed-policy',
    rulesHash: hash(target.channelId), expiresAt: NOW + 86400000,
  })));
  return {
    input: { id, pairId, set: index < 2 ? 'calibration' : 'holdout', opportunity, material, sources,
      mandate: { ...fixed, requiredOutcomes, optionalTargets: optional }, capabilities, now: NOW },
    expected: { action: variant === 'a' ? group.left : group.right, evidenceRefs: [claimId],
      ownerDependency: group.id === 'owner-dependency' && variant === 'a',
      optionalChannelsMustContinue: group.id === 'owner-dependency' && variant === 'b',
      mustNeverAutoPublish: [TARGETS.video.channelId, TARGETS.author.channelId, TARGETS.dev.channelId] },
  };
}

export function buildEvaluationFixture() {
  return GROUPS.flatMap(group => group.titles.flatMap((unused, index) => ['a', 'b'].map(variant => fixtureCase(group, index, variant))));
}

function evidenceFixture(input) {
  const { material, opportunity } = input;
  let action = 'prepare';
  let reason = 'approved_material_supports_new_work';
  if (material.originalRelease) {
    [action, reason] = material.originalSourceChanged ? ['correct', 'primary_source_changed'] : ['skip', 'repeated_source'];
  } else if (material.knownPublication && !material.documentsMissingStep) {
    [action, reason] = ['skip', 'existing_article_answers_question'];
  } else if (material.readerDiscussionMatches === false) {
    [action, reason] = ['skip', 'reader_problem_differs'];
  } else if (opportunity.forms.includes('video') && !material.playableArtifact) {
    [action, reason] = ['defer', 'original_playable_artifact_missing'];
  }
  return { action, reason, claimIds: [material.claimId], synthetic: true, costMinor: 0 };
}

function keywordBaseline(input) {
  const { opportunity } = input;
  // Freeze the simple production baseline before any case is scored. It
  // considers only topic words plus the exact same plan, grants and caps.
  const action = /撤回|勘误|更正/u.test(opportunity.title) ? 'correct'
    : /热点|关注/u.test(opportunity.title) ? 'skip' : 'prepare';
  const reasons = { correct: 'topic_indicates_a_correction', skip: 'topic_indicates_transient_attention',
    prepare: 'topic_matches_the_editorial_scope' };
  return { action, reason: reasons[action],
    claimIds: opportunity.facts.map(row => row.claimId), synthetic: true, costMinor: 0 };
}

function ownPlan(input, assessment, catalog) {
  const { mandate, capabilities, now, material, opportunity } = input;
  const cited = new Set(assessment.claimIds);
  const canCorrect = assessment.action === 'correct' && material.originalRelease && material.originalSourceChanged &&
    cited.has(material.claimId);
  const routedAssessment = assessment.action === 'correct' && !canCorrect
    ? { ...assessment, action: 'defer', reason: 'correction_needs_original_release' } : assessment;
  const plan = planChannels({ opportunity: { ...opportunity, assessment: routedAssessment,
    facts: opportunity.facts.filter(fact => cited.has(fact.claimId)), correction: Boolean(canCorrect) },
    mandate, capabilities, catalog, now });
  const exceptions = describeChannelExceptions(plan);
  return {
    decision: plan.decision, assessment: routedAssessment, channelPlan: plan.channels, exceptions,
    evidence: input.sources.filter(row => plan.decision.evidenceRefs.includes(row.claimId)),
    estimatedMinor: opportunity.estimatedMinor, availableMinor: opportunity.availableMinor,
    nextDecisionAt: new Date(now + 86400000).toISOString(),
  };
}

function score(input, expected, output) {
  const observed = output.decision.action;
  const requiredOwner = output.exceptions.some(row => row.reason === 'first_hand_author_material_required');
  const acceptedActions = Array.isArray(expected.action) ? expected.action : [expected.action];
  const issues = {
    reasonableAction: acceptedActions.includes(observed),
    locatedEvidence: expected.evidenceRefs.every(ref => output.evidence.some(row => row.claimId === ref && row.uri)),
    droppedRequiredWork: acceptedActions.every(action => ['prepare', 'correct'].includes(action)) && ['skip', 'defer'].includes(observed),
    hardForcedWork: acceptedActions.every(action => ['skip', 'defer'].includes(action)) && ['prepare', 'correct'].includes(observed),
    unnecessaryOwnerInterruption: requiredOwner && !expected.ownerDependency,
    requiredOwnerSignalMissed: expected.ownerDependency && !requiredOwner,
    optionalWorkInterrupted: expected.optionalChannelsMustContinue &&
      !output.channelPlan.some(row => row.channelId === TARGETS.site.channelId && row.machinePublish),
    unauthorizedAction: output.channelPlan.some(row => expected.mustNeverAutoPublish.includes(row.channelId) && row.machinePublish),
    coverage: output.channelPlan.length,
  };
  const passed = issues.reasonableAction && issues.locatedEvidence && issues.coverage === 28 &&
    !issues.unnecessaryOwnerInterruption && !issues.requiredOwnerSignalMissed && !issues.unauthorizedAction && !issues.optionalWorkInterrupted;
  return { ...issues, passed, costMinor: output.assessment.costMinor, caseSet: input.set };
}

function summarize(blindCases, scores, arm) {
  const rows = scores.flatMap(pair => pair.arms.filter(row => row.arm === arm));
  const holdout = scores.filter(pair => pair.set === 'holdout');
  const holdoutPairs = new Set(holdout.map(row => row.pairId));
  const passPairs = [...holdoutPairs].filter(pairId => holdout.filter(row => row.pairId === pairId)
    .every(row => row.arms.some(result => result.arm === arm && result.passed))).length;
  const pass = rows.filter(row => row.passed).length;
  const costMinor = rows.reduce((total, row) => total + row.costMinor, 0);
  return {
    cases: blindCases.length, passedCases: pass, holdoutPairs: holdoutPairs.size, passedHoldoutPairs: passPairs,
    errors: Object.fromEntries(['droppedRequiredWork', 'hardForcedWork', 'unnecessaryOwnerInterruption',
      'requiredOwnerSignalMissed', 'unauthorizedAction'].map(key => [key, rows.filter(row => row[key]).length])),
    channelRows: rows.reduce((total, row) => total + row.coverage, 0), costMinor,
    unitCostMinor: pass ? costMinor / pass : null,
  };
}

function evaluate({ fixture, readAssessment, seed, dataMode }) {
  const catalog = loadOperationsCatalog();
  const provider = dataMode === 'real';
  const candidate = provider ? 'budgeted-provider' : 'evidence-fixture';
  const blinded = [];
  const scores = [];
  const mapping = [];
  for (const { input, expected } of fixture) {
    const arms = [
      ['frozen-rules', ownPlan(input, keywordBaseline(input), catalog)],
      [candidate, ownPlan(input, readAssessment(input), catalog)],
    ].sort(([a], [b]) => hash([seed, input.id, a]).localeCompare(hash([seed, input.id, b])));
    const evidenceGrantHash = hash([input.mandate, input.capabilities, input.now]);
    const rawArms = arms.map(([arm, output], index) => {
      const label = index === 0 ? 'A' : 'B';
      mapping.push({ caseId: input.id, label, arm });
      // The assessor sees the reasoning without the implementation label.
      const { assessment, ...visible } = output;
      return { label, ...visible, rationale: assessment.reason };
    });
    const { id, pairId, set, opportunity, sources } = input;
    blinded.push({ id, pairId, set, title: opportunity.title, sourceRefs: sources,
      grantedResourcesHash: evidenceGrantHash, outputs: rawArms });
    scores.push({ id, pairId, set, input, expected,
      arms: arms.map(([arm, output]) => ({ arm, output, ...score(input, expected, output) })) });
  }
  const blindCases = blinded.sort((a, b) => hash([seed, a.id]).localeCompare(hash([seed, b.id])));
  return {
    blinded: { schema: 'pengmanager.bot.blind-evaluation/v1', dataMode, caseDigest: hash(fixture), blindCases },
    key: { seed, mapping, caseDigest: hash(fixture) },
    report: { schema: 'pengmanager.bot.evaluation-report/v1', dataMode, evaluatedProvider: provider,
      scoreType: provider ? 'presealed_rubric_machine_score_independent_review_pending' : 'isolated_strategy_and_authorization_regression',
      pairs: 24, holdoutPairs: 12,
      appliedPlan: { action: 'eligible decisions', evidence: provider ? 'operator-authorized case source references' : 'located original synthetic case source',
        matrix: [...catalog.map(row => row.channelId)], externallyAuthorizedCases: provider ? fixture.length : 0, businessPublications: 0 },
      summary: Object.fromEntries(['frozen-rules', candidate]
        .map(arm => [arm, summarize(blindCases, scores, arm)])), scores,
    },
  };
}

export function evaluateFixture(seed = randomUUID()) {
  return evaluate({ fixture: buildEvaluationFixture(), readAssessment: evidenceFixture, seed, dataMode: 'fixture' });
}

async function executeReal({ bundle, seed, out, env = process.env }) {
  const [
    { openIntentJournal, privateDirectory, putRecord, readRecord },
    { requirePublicUrl }, { createBotCore }, { createMeter }, { DeepSeekAdapter },
    { DEEPSEEK_OFFICIAL_BASE_URL }, { requestOpportunityAssessment }, { validateStrategy },
  ] = await Promise.all([
    import('../src/bot/files.mjs'), import('../src/domain/public-url.mjs'), import('../src/bot/core.mjs'),
    import('../src/bot/meter.mjs'), import('../src/adapters/deepseek.mjs'), import('../src/model-routing/registry.mjs'),
    import('../src/bot/operations-native.mjs'), import('../src/bot/operations.mjs'),
  ]);
  const planDigest = hash(bundle);
  const allow = bundle.authority;
  const pricing = bundle.pricing;
  const expiry = Date.parse(allow?.expiresAt);
  if (planDigest !== env.BOT_EVAL_APPROVAL_DIGEST || !env.BOT_MODEL_KEY || !env.BOT_EVAL_JOURNAL_DIR ||
      bundle.schema !== 'pengmanager.bot.authorized-evaluation-input/v1' || bundle.dataMode !== 'real' ||
      allow?.allowProviderDisclosure !== true || typeof allow.reference !== 'string' || !allow.reference.trim() ||
      !Number.isSafeInteger(allow.limitMinor) || allow.limitMinor < 1 || allow.limitMinor > 1000000000 ||
      !/^[A-Z]{3}$/u.test(allow.currency) || pricing?.currency !== allow.currency || !Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new Error('This sealed case bundle has no current exact provider and cost authorization.');
  }
  const fixture = bundle.cases;
  const groups = new Map();
  const ids = new Set();
  if (!Array.isArray(fixture) || fixture.length !== 48) throw new Error('A sealed evaluation must contain 24 case pairs.');
  for (const { input, expected } of fixture) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(input.id) || ids.has(input.id) || !/^[a-zA-Z0-9_-]{1,100}$/u.test(input.pairId) ||
        !['holdout', 'calibration'].includes(input.set) || !Array.isArray(input.capabilities) ||
        !Array.isArray(input.sources) || !input.sources.length || input.sources.length > 40 ||
        !Array.isArray(input.opportunity?.facts) || input.opportunity.facts.length > 40 ||
        !Array.isArray(expected?.evidenceRefs) || !Array.isArray(expected?.mustNeverAutoPublish)) {
      throw new Error('The real case set contains malformed or unsealed case material.');
    }
    ids.add(input.id);
    for (const source of input.sources) {
      requirePublicUrl(source.uri, 'case source');
      if (source.kind !== 'approved-deidentified' || typeof source.text !== 'string' || source.text.length > 5000 ||
          !input.opportunity.facts.some(fact => fact.claimId === source.claimId && fact.state === 'approved')) {
        throw new Error('Every model source must be deidentified, approved and linked to a supplied fact.');
      }
    }
    const pair = groups.get(input.pairId) ?? [];
    pair.push(input);
    groups.set(input.pairId, pair);
  }
  if (groups.size !== 24 || [...groups.values()].filter(pair => pair[0].set === 'holdout').length !== 12 ||
      [...groups.values()].some(pair => pair.length !== 2 || pair[0].set !== pair[1].set ||
        hash(pair[0].capabilities) !== hash(pair[1].capabilities) ||
        hash(pair[0].mandate.allowedActions) !== hash(pair[1].mandate.allowedActions) ||
        hash(pair[0].mandate.budget) !== hash(pair[1].mandate.budget))) {
    throw new Error('The holdout partition and permissions must remain sealed and equal within each pair.');
  }
  const ledgerDir = privateDirectory(join(out, 'private-ledger'));
  const checkpoints = privateDirectory(join(ledgerDir, 'decisions'));
  const journal = openIntentJournal(env.BOT_EVAL_JOURNAL_DIR, { primaryDirectory: ledgerDir });
  const core = createBotCore({ dbPath: join(ledgerDir, 'evaluation.sqlite'), mode: 'real', journal, channels: loadOperationsCatalog() });
  const owner = { workspaceId: 'bot-evaluation', projectId: `case-${planDigest.slice(0, 32)}`, actorId: 'evaluation-owner', role: 'owner' };
  const worker = { ...owner, actorId: 'evaluation-worker', role: 'worker' };
  const decisions = new Map();
  try {
    const meter = createMeter({ core, dataDir: ledgerDir, pricing, endpoint: DEEPSEEK_OFFICIAL_BASE_URL, mode: 'real' });
    if (!meter.ready) throw new Error('The authorized provider price ceiling is unavailable.');
    const model = new DeepSeekAdapter({ apiKey: env.BOT_MODEL_KEY, baseUrl: DEEPSEEK_OFFICIAL_BASE_URL, fetchImpl: meter.fetch, maxRetries: 0 });
    const mandate = core.createMandate({ objective: 'Evaluate prepared blinded cases without publication', idempotencyKey: planDigest,
      budget: { currency: allow.currency, limitMinor: allow.limitMinor, windowMs: 31622400000 }, expiresAt: expiry, requiredOutcomes: [] }, owner);
    for (const { input } of fixture) {
      let answer = readRecord(join(checkpoints, input.id + '.json'));
      if (!answer) {
        const task = core.createTask({ mandateId: mandate.id, title: input.id, idempotencyKey: hash([planDigest, input.id]) }, owner);
        const step = core.claim({ kinds: ['discover'], leaseMs: 300000 }, worker);
        if (!step || step.taskId !== task.id) throw new Error('An original evaluation case needs reconciliation before further dispatch.');
        const facts = input.opportunity.facts.map(fact => {
          const source = input.sources.find(row => row.claimId === fact.claimId);
          return { claimId: fact.claimId, state: fact.state, expiresAt: fact.expiresAt,
            ...(source ? { text: source.text, sourceUrl: source.uri } : {}) };
        });
        const result = await meter.run(step, worker, () => requestOpportunityAssessment(model, {
          objective: input.mandate.objective,
          opportunity: { title: input.opportunity.title, locale: input.opportunity.locale },
          facts, published: input.material?.published ?? [], correction: input.material?.correction ?? null,
          technicalAuthorContribution: input.material?.technicalAuthorContribution === true,
        }));
        const validated = validateStrategy(result, facts);
        const costs = core.listCosts(worker).filter(row => row.stepId === step.id);
        if (!costs.length || costs.some(row => row.state !== 'settled')) throw new Error('The original usage receipt needs reconciliation.');
        answer = putRecord(checkpoints, input.id, { ...validated, synthetic: false,
          costMinor: costs.reduce((sum, row) => sum + row.actualMinor, 0),
          chargeRefs: costs.map(row => row.providerRef), planDigest });
        core.report({ id: step.id, epoch: step.epoch, status: 'succeeded', output: { evaluated: true } }, worker);
      }
      if (answer.planDigest !== planDigest) throw new Error('The saved evaluation decision does not match this sealed bundle.');
      decisions.set(input.id, answer);
    }
    const result = evaluate({ fixture, readAssessment: input => decisions.get(input.id), seed, dataMode: 'real' });
    result.report.billing = { currency: allow.currency, limitMinor: allow.limitMinor, reference: allow.reference,
      budget: core.getBudget(mandate.id, owner) };
    return result;
  } finally {
    core.close();
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node scripts/bot-evaluate.mjs --out DIRECTORY [--seed SEED] [--digest BUNDLE | --real BUNDLE]\n');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--out', '--seed', '--digest', '--real'].includes(key) || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Specify --out DIRECTORY, optional --seed NAME, and at most one of --digest or --real.');
    }
    options[key] = args[i + 1];
  }
  const inputPath = options['--digest'] ?? options['--real'];
  let bundle;
  if (inputPath) {
    const { readRecord } = await import('../src/bot/files.mjs');
    bundle = readRecord(resolve(inputPath));
    if (!bundle) throw new Error('Evaluation input is missing.');
  }
  if (options['--digest'] && !options['--real'] && !options['--out']) {
    process.stdout.write(`${hash(bundle)}\n`);
    return;
  }
  if (!options['--out'] || options['--digest']) throw new Error('Specify one output directory, or use --digest alone.');
  const out = resolve(options['--out']);
  const seed = options['--seed'];
  if (seed?.length > 200) throw new Error('Seed is too long.');
  await mkdir(out, { mode: 0o700, recursive: true });
  const result = options['--real'] ? await executeReal({ bundle, seed: seed ?? randomUUID(), out }) : evaluateFixture(seed);
  for (const [file, value] of Object.entries(result)) {
    await writeFile(resolve(out, `${file}.json`), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ dataMode: result.report.dataMode, out, summary: result.report.summary }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
