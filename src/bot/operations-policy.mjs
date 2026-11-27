import { readFileSync } from 'node:fs';
import { fail, hash } from './core-store.mjs';

const GUIDES = Object.freeze({
  'official-site': { forms: ['article', 'image_text', 'video'], trigger: 'Verified primary evidence or a recoverable correction to an owned edition.', output: 'Canonical edition with exact media, references and a release receipt.', receipt: 'website_release' },
  'wechat-official': { forms: ['article', 'image_text'], trigger: 'The author has approved first-hand material for a substantive long-form subject.', output: 'Author-led long-form copy and ordered images.', receipt: 'wechat_article', author: true },
  xiaohongshu: { forms: ['image_text', 'video'], trigger: 'A demonstrated procedure can be explained with an accurate sequence of images.', output: 'Original cover, ordered image cards and platform-native note.', receipt: 'note' },
  bilibili: { forms: ['video'], trigger: 'A real test or demonstration is understandable as a playable film.', output: 'Final video, captions and cover.', receipt: 'bilibili_video' },
  linkedin: { forms: ['article', 'document', 'image_text'], trigger: 'Evidence supports a distinct lesson for a professional audience.', output: 'Professional case, link card or native document as actually authorized.', receipt: 'linkedin_post' },
  x: { forms: ['thread', 'image_text', 'video'], trigger: 'A time-sensitive first-party fact is suitable for distinct short segments.', output: 'Distinct thread segments and authorized media.', receipt: 'x_post', noTrends: true },
  youtube: { forms: ['video'], trigger: 'A tested workflow or original demonstration is ready to watch.', output: 'Playable video with captions, metadata and required disclosures.', receipt: 'youtube_video' },
  github: { forms: ['repository_change'], trigger: 'A real revision, tag or release artifact exists.', output: 'Repository change or release notes tied to actual bytes and version.', receipt: 'github_release', technical: true },
  huggingface: { forms: ['demo_bundle', 'model_card', 'dataset_card'], trigger: 'A licensed runnable Space, model or dataset is available.', output: 'A real versioned artifact, documentation and license.', receipt: 'hub_revision', technical: true },
  modelscope: { forms: ['demo_bundle', 'model_card', 'dataset_card'], trigger: 'A licensed technical artifact or runnable Chinese demo is available.', output: 'Native technical card and verified runnable or downloadable artifact.', receipt: 'modelscope_revision', technical: true },
  tiktok: { forms: ['video', 'image_text'], trigger: 'Original vertical footage or a sequence of licensed photographs is ready.', output: 'Native media package and required disclosures for owner submission.', receipt: 'tiktok_post' },
  instagram: { forms: ['image_text', 'video'], trigger: 'An evidenced sequence of images or a real Reel has standalone value.', output: 'Carousel or Reel, ordered media and disclosures.', receipt: 'instagram_media' },
  facebook: { forms: ['article', 'image_text', 'video', 'community_message'], trigger: 'A relevant Page or an explicitly appropriate Group audience exists.', output: 'Page-native post or a topic-specific community package.', receipt: 'facebook_post' },
  douyin: { forms: ['video'], trigger: 'Original vertical footage, narration or an authorized demonstration is ready.', output: 'Playable short video and verified cover, subtitle and disclosure.', receipt: 'douyin_video' },
  'wechat-channels': { forms: ['video'], trigger: 'A short original demonstration or voice-over fits the WeChat audience.', output: 'Playable vertical video and a reviewed description.', receipt: 'wechat_video' },
  zhihu: { forms: ['article'], trigger: 'A real question has an evidenced answer or an independent column article is suitable.', output: 'An answer bound to the question or a separate native column article.', receipt: 'zhihu_content' },
  reddit: { forms: ['community_message', 'article'], trigger: 'An approved subreddit has an actual relevant thread or an invitation.', output: 'Specific community contribution with relationship disclosure.', receipt: 'reddit_item', community: true },
  discord: { forms: ['community_message'], trigger: 'An approved channel explicitly benefits from a specific update or answer.', output: 'Native message tied to the exact channel or thread.', receipt: 'discord_message', community: true },
  jike: { forms: ['article', 'image_text'], trigger: 'An approved community would benefit from a verifiable project update.', output: 'Concise native note and evidence image or link.', receipt: 'jike_item' },
  juejin: { forms: ['article'], trigger: 'There is a reproducible technical example with meaningful new information.', output: 'Native technical article, code examples and provenance.', receipt: 'juejin_article' },
  csdn: { forms: ['article'], trigger: 'A real implementation or troubleshooting exercise can be reproduced.', output: 'Technical article with environment, code and verified instructions.', receipt: 'csdn_article' },
  devto: { forms: ['article'], trigger: 'A substantive original technical article has real evidence and matches a developer readership.', output: 'Reviewed Markdown, attribution, canonical link if eligible and disclosure.', receipt: 'forem_article' },
  medium: { forms: ['article'], trigger: 'The author supplies a firsthand narrative and substantiating evidence.', output: 'Author-led native story, provenance and disclosure.', receipt: 'medium_story', author: true },
  hashnode: { forms: ['article'], trigger: 'A tested implementation or series has a natural audience on the publication.', output: 'Native article with source, ownership and publication metadata.', receipt: 'hashnode_post' },
  kaggle: { forms: ['notebook', 'dataset_card', 'model_card'], trigger: 'A runnable notebook, legitimate dataset or model exists.', output: 'Real versioned work with source and license.', receipt: 'kaggle_artifact', technical: true },
  baijiahao: { forms: ['article'], trigger: 'An approved restoration and a concrete demand justify the article.', output: 'Original explanation for the verified account after restoration.', receipt: 'baijiahao_article' },
  toutiao: { forms: ['image_text', 'video'], trigger: 'An approved restoration and real evidence justify a native item.', output: 'Original media package with declared presentation type.', receipt: 'toutiao_item' },
  maimai: { forms: ['article'], trigger: 'An approved restoration and firsthand career experience are available.', output: 'Research and editing assistance of an authored original for owner submission.', receipt: 'maimai_item', author: true },
});

export const CHANNEL_IDS = Object.freeze(Object.keys(GUIDES));
const MEDIA = new Set(['video', 'image_text', 'document']);
const ARCHIVED = new Set(['baijiahao', 'toutiao', 'maimai']);
const HUMAN_ONLY = new Set(['xiaohongshu', 'tiktok', 'wechat-channels', 'jike', 'juejin', 'csdn', 'medium', 'maimai']);
const ADAPTERS = new Map([['official-site', 'article'], ['devto', 'article']]);
const DISPOSITIONS = new Set(['needs_reconcile', 'archived', 'blocked', 'skip', 'deferred', 'publish', 'owner_confirmation', 'manual', 'prepare']);
const MATERIAL = 'approved';

function parseResource(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
}

export function loadOperationsCatalog() {
  const { platforms, version } = parseResource('../../data/platform-catalog.json');
  const { profiles } = parseResource('../../data/content-operators.json');
  const profileByChannel = new Map(profiles.map(profile => [profile.platformId, profile]));
  if (platforms.length !== CHANNEL_IDS.length || profiles.length !== CHANNEL_IDS.length ||
      new Set(platforms.map(platform => platform.id)).size !== CHANNEL_IDS.length ||
      platforms.some(platform => !GUIDES[platform.id] || !profileByChannel.has(platform.id))) {
    fail(500, 'OPERATIONS_CATALOG_CHANGED', 'The native channel and role catalogs need a review against the BOT strategy.');
  }
  const channels = platforms.map(platform => {
    const profile = profileByChannel.get(platform.id);
    const guide = GUIDES[platform.id];
    const forms = guide.forms.filter(form => profile.supportedNativeForms.includes(form));
    if (!forms.length) fail(500, 'OPERATIONS_FORM_CHANGED', 'No supported native form remains for a planned channel.');
    return Object.freeze({
      ...guide, forms: Object.freeze(forms), channelId: platform.id,
      name: platform.name, roleId: profile.id, roleVersion: profile.version, catalogVersion: version,
      requiresAuthor: guide.author === true || profile.policy.requiresAuthorContribution === true,
      archived: ARCHIVED.has(platform.id),
    });
  });
  return Object.freeze(channels);
}

function validCapability(capability, current) {
  const expiry = typeof capability?.expiresAt === 'number' ? capability.expiresAt : Date.parse(capability?.expiresAt);
  return Boolean(capability?.accountId && capability.destination && capability.form &&
    capability.evidenceRef &&
    (capability.active === true || ['verified', 'approved', 'ready'].includes(capability.state ?? capability.status)) &&
    (capability.expiresAt === null || expiry > current));
}

function scopedCapability(capabilities, target, row, form, current, action) {
  const matches = capabilities.filter(capability => (capability.channelId ?? capability.platformId) === row.channelId &&
    capability.form === form && capability.action === action && (!capability.cooldownUntil || capability.cooldownUntil <= current) &&
    (!target?.accountId || capability.accountId === target.accountId) &&
    (!target?.destination || capability.destination === target.destination) && validCapability(capability, current));
  return matches.length === 1 ? matches[0] : null;
}

function choiceTargets(mandate, opportunity) {
  const include = (values, required) => (Array.isArray(values) ? values : []).flatMap(value => {
    if (typeof value === 'string') return CHANNEL_IDS.includes(value) ? [{ channelId: value, required }] : [];
    const channelId = value?.channelId ?? value?.platformId;
    return CHANNEL_IDS.includes(channelId) ? [{ ...value, channelId, required }] : [];
  });
  const authorized = Array.isArray(mandate.allowedActions) ? mandate.allowedActions : [];
  return [...include(mandate.optionalTargets, false), ...include(mandate.requiredOutcomes, true)].map(target => {
    const neededAction = opportunity.correction ? 'replace' : 'publish';
    const matches = authorized.filter(action => action.channelId === target.channelId && action.action === neededAction &&
      (!target.form || target.form === action.form) && (!target.accountId || target.accountId === action.accountId) &&
      (!target.destination || target.destination === action.destination));
    return matches.length === 1 ? { ...matches[0], ...target, authority: matches[0] } : target;
  });
}

function decideOpportunity(opportunity, now) {
  const facts = Array.isArray(opportunity.facts) ? opportunity.facts : [];
  const sources = facts.filter(fact => fact?.state === MATERIAL && typeof fact.claimId === 'string' &&
    (fact.expiresAt == null || Date.parse(fact.expiresAt) > now));
  const evidenceRefs = [...new Set(sources.map(fact => fact.claimId))];
  const effects = opportunity.previousEffects ?? [];
  if (effects.some(effect => ['unknown', 'needs_reconcile', 'accepted'].includes(effect.state))) {
    return { action: 'reconcile', reason: 'unknown_prior_effect', evidenceRefs };
  }
  if (opportunity.duplicate === true || opportunity.sameFactAsPublished === true && opportunity.correction !== true) {
    return { action: 'skip', reason: 'no_new_verified_fact', evidenceRefs };
  }
  if (opportunity.inScope === false || opportunity.relevance === 'irrelevant') {
    return { action: 'skip', reason: 'out_of_scope', evidenceRefs };
  }
  if (opportunity.availableMinor !== undefined && opportunity.estimatedMinor > opportunity.availableMinor) {
    return { action: 'defer', reason: 'budget_reserved_for_prior_commitments', evidenceRefs };
  }
  if (!evidenceRefs.length) return { action: 'defer', reason: 'approved_claims_required', evidenceRefs };
  if (['skip', 'defer'].includes(opportunity.assessment?.action)) {
    return { action: opportunity.assessment.action, reason: 'evidence_assessment_deferred', evidenceRefs };
  }
  return { action: opportunity.correction === true ? 'correct' : 'prepare', reason: opportunity.correction === true ?
    'verified_correction' : 'new_supported_reader_value', evidenceRefs };
}

function routeTarget({ row, target, opportunity, decision, capabilities, current, unavailableConnectors }) {
  const eligibleForms = opportunity.forms?.length ? row.forms.filter(form => opportunity.forms.includes(form)) : row.forms;
  const form = target?.form ?? eligibleForms[0] ?? row.forms[0];
  const action = decision.action === 'correct' ? 'replace' : 'publish';
  const capability = scopedCapability(capabilities, target, row, form, current, action);
  const variants = opportunity.nativeVariants ?? {};
  const formVariant = row.channelId === 'zhihu' ? variants.zhihu ?? 'answer' : variants[row.channelId] ?? null;
  const selection = {
    channelId: row.channelId, roleId: row.roleId, roleVersion: row.roleVersion, catalogVersion: row.catalogVersion,
    form, formVariant, action, accountId: capability?.accountId ?? target?.accountId ?? null,
    destination: capability?.destination ?? target?.destination ?? null, required: target?.required === true,
    expectedReceipt: row.receipt, expectedVisibility: target?.visibility ?? capability?.visibility ?? 'public',
    capabilityVersion: capability?.version ?? null, capabilityEvidenceRef: capability?.evidenceRef ?? null,
    rulesHash: capability?.rulesHash ?? null, trigger: row.trigger, nativeOutput: row.output, machinePublish: false,
  };
  const result = (disposition, reason) => ({ ...selection, disposition, reason, machinePublish: disposition === 'publish' });
  if (row.archived && !opportunity.restoredChannels?.includes(row.channelId)) return result('archived', 'default_archive');
  if (!target) return result('skip', 'not_selected_by_mandate');
  if (action === 'replace' && row.channelId !== 'official-site') return result('skip', 'only_original_edition_can_be_corrected');
  if (!eligibleForms.includes(form)) return result('blocked', 'native_form_not_supported');
  if (decision.action === 'reconcile') return result('needs_reconcile', decision.reason);
  if (['skip', 'defer'].includes(decision.action)) return result(decision.action === 'defer' ? 'deferred' : 'skip', decision.reason);
  if (row.requiresAuthor && !opportunity.authorContributionRef) return result('blocked', 'first_hand_author_material_required');
  if (row.community && !opportunity.communityTargetRef) return result('blocked', 'verified_community_context_required');
  if ((row.technical || MEDIA.has(form)) && !opportunity.artifacts?.some(item => item.form === form && item.state === MATERIAL && item.sha256)) {
    return result('blocked', 'reviewed_native_artifact_required');
  }
  if (row.noTrends && opportunity.xTrending === true) return result('prepare', 'x_trend_automation_not_eligible');
  if (row.channelId === 'zhihu' && formVariant === 'answer') {
    if (!opportunity.questionRef) return result('blocked', 'actual_question_required');
    return capability?.confirmationRequired ? result('owner_confirmation', 'official_confirmation_required') :
      result('manual', 'native_answer_requires_owner_submission');
  }
  if (HUMAN_ONLY.has(row.channelId) || capability?.mode === 'manual') return result('manual', 'official_owner_workflow');
  if (capability?.confirmationRequired === true || capability?.mode === 'platform_confirmation' ||
      row.channelId === 'zhihu' && opportunity.zhihuSyncAvailable === true) {
    return result('owner_confirmation', 'official_confirmation_required');
  }
  if (!capability) return result('prepare', 'exact_account_capability_not_verified');
  if (ADAPTERS.get(row.channelId) !== form) return result('prepare', 'connector_not_implemented');
  if (unavailableConnectors.includes(row.channelId)) return result('prepare', 'verified_connector_unavailable');
  if (row.channelId === 'devto' && (!opportunity.authorContributionRef || !opportunity.originalTechnicalWork || opportunity.primaryMarketing === true)) {
    return result('prepare', 'dev_requires_original_technical_value');
  }
  if (target.authority?.risk !== 'low' || capability.official !== true || capability.safeDedup !== true ||
      capability.businessReadback !== true || capability.confirmationRequired !== false) {
    return result('prepare', 'official_automatic_scope_not_verified');
  }
  return result('publish', 'scope_verified_preparation_required');
}

export function planChannels({ opportunity = {}, mandate = {}, capabilities = [], catalog = loadOperationsCatalog(), now = Date.now(),
  unavailableConnectors = [] } = {}) {
  const current = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(current) || !Array.isArray(capabilities) || catalog.length !== CHANNEL_IDS.length) {
    fail(422, 'OPERATIONS_PLAN_INVALID', 'The channel plan requires a time, capability list and the native catalog.');
  }
  const decision = decideOpportunity(opportunity, current);
  const targets = new Map(choiceTargets(mandate, opportunity).map(target => [target.channelId, target]));
  const channels = catalog.map(row => routeTarget({
    row, target: targets.get(row.channelId), opportunity, decision, capabilities, current, unavailableConnectors,
  }));
  const substitutions = [];
  if (decision.action === 'prepare') {
    for (const alternate of mandate.allowedSubstitutions ?? []) {
      const original = mandate.requiredOutcomes.find(item => item.id === alternate.forOutcomeId && item.channelId === alternate.originalChannelId);
      const originalPlan = channels.find(row => row.channelId === original?.channelId);
      const native = catalog.find(row => row.channelId === alternate.channelId);
      const granted = mandate.allowedActions.find(action => ['channelId', 'accountId', 'destination', 'form', 'action', 'visibility']
        .every(key => action[key] === alternate[key]));
      if (!original || !originalPlan || original.channelId === alternate.channelId || !native || !granted ||
        originalPlan.machinePublish || (original.outcome === 'prepared' && ['prepare','manual','owner_confirmation'].includes(originalPlan.disposition) &&
          [ADAPTERS.get(original.channelId), original.channelId === 'zhihu' ? 'article' : null].includes(originalPlan.form) && originalPlan.destination)) continue;
      const routed = routeTarget({ row: native, target: { ...alternate, authority: granted },
        opportunity: { ...opportunity, forms: [alternate.form] }, decision, capabilities, current, unavailableConnectors });
      const hasPackageAdapter = ADAPTERS.get(native.channelId) === routed.form || native.channelId === 'zhihu' && routed.form === 'article';
      if (!hasPackageAdapter || !routed.destination || !['publish', 'prepare', 'manual', 'owner_confirmation'].includes(routed.disposition) ||
        alternate.outcome !== 'prepared' && !routed.machinePublish) continue;
      Object.assign(channels.find(row => row.channelId === native.channelId), routed, {
        reason: 'signed_alternate_for_unavailable_original', substitution: alternate,
        ...(alternate.outcome === 'prepared' ? { machinePublish: false, disposition: 'prepare' } : {}),
      });
      substitutions.push(alternate);
    }
  }
  if (channels.some(channel => !DISPOSITIONS.has(channel.disposition))) fail(500, 'OPERATIONS_ROUTE_INVALID', 'An unrecognized channel disposition was produced.');
  const work = channels.filter(row => ['publish', 'prepare', 'manual', 'owner_confirmation'].includes(row.disposition));
  return {
    decision: { ...decision, evidenceHash: hash(decision.evidenceRefs),
      alternatives: decision.action === 'prepare' ? ['update_existing_edition', 'defer_if_no_original_value'] : ['preserve_original_scope'] },
    channels, substitutions,
    work,
  };
}

export function describeChannelExceptions(plan) {
  const grouped = new Map();
  for (const channel of plan.channels) {
    if (!channel.required || !['blocked', 'owner_confirmation', 'manual'].includes(channel.disposition)) continue;
    const existing = grouped.get(channel.reason) ?? {
      reason: channel.reason, action: channel.disposition, channelIds: [],
    };
    existing.channelIds.push(channel.channelId);
    grouped.set(channel.reason, existing);
  }
  return [...grouped.values()];
}
