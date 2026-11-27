import { DAY, fail, hash, modeOf } from './core-store.mjs';

const GEO_ID = /^[A-Za-z0-9_-]{1,120}$/u;
const SHA = /^[a-f0-9]{64}$/u;

function normalizeUrls(values, mode = 'real') {
  return Array.isArray(values) ? [...new Set(values.flatMap(value => {
    try {
      const url = new URL(typeof value === 'string' ? value : value.url);
      const localFixture = mode === 'fixture' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:';
      if (!localFixture && (url.protocol !== 'https:' || url.port) || url.username || url.password) return [];
      url.hash = '';
      return [url.href];
    } catch {
      return [];
    }
  }))].sort() : [];
}

function observationProfile(value) {
  if (value == null) return null;
  const result = {};
  for (const key of ['language', 'region', 'access', 'evidenceRef']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 180) {
      fail(422, 'INVALID_GEO_PROFILE', 'Provide language, region, access conditions and a verified deployment reference.');
    }
    result[key] = value[key].trim();
  }
  return result;
}

export function normalizeGeoScope(mandate, mode) {
  const scope = mandate?.trustScope?.geo;
  if (!scope) return null;
  const queryIds = Array.isArray(scope.queryIds) ? [...new Set(scope.queryIds)] : [];
  if (!queryIds.length || queryIds.length > 50 || queryIds.some(id => typeof id !== 'string' || !GEO_ID.test(id))) {
    fail(422, 'GEO_QUESTION_SCOPE_INVALID', 'Authorize a fixed unique set of at most fifty original GEO questions.');
  }
  const provider = scope.provider ?? (mode === 'fixture' ? 'fixture' : 'deepseek-search');
  if (!(mode === 'fixture' ? provider === 'fixture' : ['deepseek', 'deepseek-search'].includes(provider))) {
    fail(422, 'GEO_PROVIDER_SCOPE_INVALID', 'The approved observation surface cannot mix fixture and real providers.');
  }
  const surface = scope.surface ?? provider;
  if (typeof surface !== 'string' || !surface.trim() || surface.length > 100 ||
      !['string', 'undefined'].includes(typeof scope.questionRevision)) {
    fail(422, 'GEO_SURFACE_SCOPE_INVALID', 'Store the approved observation surface and question revision.');
  }
  const observedUrls = normalizeUrls(scope.observedUrls, mode);
  const profile = observationProfile(scope.profile);
  const names = scope.subjectNames ?? [];
  const copies = scope.verifiedReprints ?? [];
  if (!Array.isArray(names) || names.length > 12 || names.some(n => typeof n !== 'string' || !n.trim() || n.length > 100) ||
      !Array.isArray(copies) || copies.length > 50) fail(422, 'GEO_SUBJECT_INVALID', 'Check the subject names and attributed reprints.');
  const verifiedReprints = copies.map(entry => {
    const [originalUrl] = normalizeUrls([entry?.originalUrl], mode);
    const [url] = normalizeUrls([entry?.url], mode);
    if (!url || !originalUrl || originalUrl === url || typeof entry.evidenceRef !== 'string' ||
        !entry.evidenceRef.trim() || entry.evidenceRef.length > 500) fail(422, 'GEO_REPRINT_UNVERIFIED', 'Reprints need both URLs and an attribution receipt.');
    return { originalUrl, url, evidenceRef: entry.evidenceRef.trim() };
  });
  return {
    provider, surface, queryIds, observedUrls,
    ...(profile ? { profile } : {}),
    ...(names.length ? { subjectNames: [...new Set(names.map(n => n.trim()))] } : {}),
    ...(copies.length ? { verifiedReprints } : {}),
    questionRevision: scope.questionRevision ?? hash(queryIds),
  };
}

export function geoRoundPlan({ operationKey, publishedAt, queryScope }) {
  if (!queryScope || !Number.isSafeInteger(publishedAt)) return [];
  return [1, 3, 7].map(day => ({
    key: `observation:${operationKey}:${day}`, kind: 'observe',
    dueAt: publishedAt + day * DAY,
    input: { day, operationKey, queryScope },
  }));
}

function groundedCitations(sample, mode) {
  const answer = String(sample.answer ?? '');
  const explicitUrls = [...answer.matchAll(/https?:\/\/[^\s<>"'\[\]）】]+/giu)]
    .map(match => match[0].replace(/[).,。;，；：]+$/u, ''));
  const cited = new Set(normalizeUrls(explicitUrls, mode));
  const searchRows = sample.raw?.searchResults;
  if (Array.isArray(searchRows)) {
    for (const match of answer.matchAll(/(?:\[(\d{1,2})\]|【(\d{1,2})】)(?!\s*\()/gu)) {
      const result = searchRows[Number(match[1] ?? match[2]) - 1];
      if (result) for (const url of normalizeUrls([result], mode)) cited.add(url);
    }
  }
  return [...cited].sort();
}

function geoEvidence(sample, expectedMode, targetUrls, question, queryScope) {
  const valid = sample?.status === 'success' && sample.dataMode === expectedMode && SHA.test(sample.evidenceHash ?? '') &&
    typeof sample.id === 'string' && typeof sample.model === 'string' && sample.model &&
    (sample.query_text ?? question) === question;
  if (!valid) return { state: 'failed', attribution: 'failed', reason: sample ? 'original_sample_not_verified' : 'original_sample_missing' };
  const citations = groundedCitations(sample, expectedMode);
  const citedOriginals = citations.filter(url => targetUrls.has(url));
  const citedReprints = (queryScope.verifiedReprints ?? []).filter(entry => targetUrls.has(entry.originalUrl) && citations.includes(entry.url));
  const plainAnswer = String(sample.answer ?? '').normalize('NFKC').toLocaleLowerCase();
  const nameFound = (queryScope.subjectNames ?? []).some(name => plainAnswer.includes(name.normalize('NFKC').toLocaleLowerCase()));
  const attribution = citedOriginals.length ? 'original' : citedReprints.length ? 'verified_reprint' : nameFound ? 'name_only' : 'no_citation';
  return {
    state: 'sampled', attribution, citedReprints, sampleId: sample.id, evidenceHash: sample.evidenceHash,
    citedTargets: citedOriginals,
    citationHashes: citations.slice(0, 100).map(url => hash(url)),
    model: sample.model,
  };
}

export function createGeoBotAdapter({ engine, mode = 'real', configured = true, deploymentProfile } = {}) {
  modeOf(mode);
  const actualProfile = observationProfile(deploymentProfile);
  const ready = configured && Boolean(engine?.listQueries) && Boolean(engine?.runVisibility);
  return Object.freeze({
    ready,
    mode,
    async collect(queryScope, { expectedUrls = [] } = {}) {
      if (!ready) fail(503, 'GEO_PROVIDER_UNCONFIGURED', 'The authorized native GEO observation provider is unavailable.');
      if (!queryScope || (mode === 'fixture' ? queryScope.provider !== 'fixture' :
        !['deepseek', 'deepseek-search'].includes(queryScope.provider))) {
        fail(422, 'GEO_PROVIDER_SCOPE_INVALID', 'The approved observation surface does not match runtime data mode.');
      }
      if (queryScope.profile && hash(queryScope.profile) !== hash(actualProfile)) {
        fail(409, 'GEO_PROFILE_CHANGED', 'The configured monitoring environment does not match the authorized panel.');
      }
      const registered = new Map(engine.listQueries({ limit: 2000 }).map(row => [row.id, row.text]));
      if (!queryScope.queryIds.every(id => typeof registered.get(id) === 'string' && registered.get(id).trim())) {
        fail(409, 'GEO_QUESTION_CHANGED', 'At least one authorized question is no longer available.');
      }
      const run = await engine.runVisibility({
        provider: queryScope.provider, queryIds: queryScope.queryIds,
        limit: queryScope.queryIds.length, platform: queryScope.surface,
      });
      const expectedMode = mode === 'fixture' ? 'fixture' : 'real';
      if (run.dataMode !== expectedMode || !GEO_ID.test(run.runId ?? '') || !Array.isArray(run.samples) ||
          !SHA.test(run.responseHash ?? '')) {
        fail(409, 'GEO_EVIDENCE_MODE_MISMATCH', 'Only an original run of the authorized data mode can satisfy a GEO round.');
      }
      const unique = new Map();
      for (const sample of run.samples) {
        if (!queryScope.queryIds.includes(sample.query_id) || unique.has(sample.query_id)) {
          fail(409, 'GEO_RUN_SCOPE_MISMATCH', 'The native run returned observations outside an exact single sample per authorized question.');
        }
        unique.set(sample.query_id, sample);
      }
      const targetUrls = new Set(normalizeUrls(expectedUrls.length ? expectedUrls : queryScope.observedUrls, mode));
      const observations = queryScope.queryIds.map(queryId => ({
        queryId, queryHash: hash(registered.get(queryId)),
        ...geoEvidence(unique.get(queryId), expectedMode, targetUrls, registered.get(queryId), queryScope),
      }));
      const completed = observations.filter(observation => observation.state === 'sampled').length;
      const cited = observations.filter(observation => observation.citedTargets?.length).length;
      return {
        mode, profileHash: actualProfile ? hash(actualProfile) : null, profile: actualProfile, runId: run.runId, responseHash: run.responseHash, questionRevision: queryScope.questionRevision,
        surface: queryScope.surface, provider: queryScope.provider, planned: observations.length, completed,
        failed: observations.length - completed, cited, observations,
        evidenceRef: `geo-${hash([run.runId, run.responseHash, queryScope.questionRevision])}`,
      };
    },
  });
}

export function compareGeoRounds(baseline, current, targetUrl) {
  const [target] = normalizeUrls([targetUrl], current.mode);
  if (!baseline || !target || ['mode', 'surface', 'provider', 'questionRevision', 'profileHash']
    .some(key => baseline[key] !== current[key])) {
    return { paired: 0, citations: 0, baselineCitations: 0, status: current.completed ? 'sample_insufficient' : 'unavailable' };
  }
  const prior = new Map(baseline.observations.map(row => [row.queryId, row]));
  const targetHash = hash(target);
  let paired = 0, citations = 0, baselineCitations = 0;
  for (const present of current.observations) {
    const original = prior.get(present.queryId);
    if (present.state !== 'sampled' || original?.state !== 'sampled' ||
        original.queryHash !== present.queryHash || original.model !== present.model) continue;
    paired++;
    if (present.citedTargets?.includes(target) || present.citationHashes.includes(targetHash)) citations++;
    if (original.citedTargets?.includes(target) || original.citationHashes.includes(targetHash)) baselineCitations++;
  }
  return { paired, citations, baselineCitations,
    status: !current.completed ? 'unavailable' : paired !== current.planned ? 'sample_insufficient' : 'verified' };
}
