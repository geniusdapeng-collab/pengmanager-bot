import { fail, hash, modeOf } from './core-store.mjs';

const FOREM_API = 'https://dev.to';
const ACCEPT = 'application/vnd.forem.api-v1+json';
const POST_ID = /^\d{1,20}$/u;
const HANDLE = /^[a-z0-9_-]{1,80}$/iu;
const AUTHOR_PAGE_LIMIT = 4;
const AUTHOR_PAGE_SIZE = 30;

function providerId(value) {
  const id = String(value ?? '');
  return POST_ID.test(id) ? id : null;
}

function canonical(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash) {
      return url.href;
    }
  } catch {
    fail(422, 'DEV_CANONICAL_INVALID', 'Provide a reviewed HTTPS canonical source.');
  }
  fail(422, 'DEV_CANONICAL_INVALID', 'Provide a reviewed HTTPS canonical source.');
}

function normalizeHeadline(text) {
  if (typeof text !== 'string' || !text.trim() || text !== text.trim() || text.length > 128 || /[\u0000-\u001f\u007f]/u.test(text)) {
    fail(422, 'DEV_TITLE_INVALID', 'Use an approved title on a single line.');
  }
  return text;
}

export function devArticleInput({ title, bodyMarkdown, canonicalUrl = null }) {
  if (typeof bodyMarkdown !== 'string' || !bodyMarkdown.trim() || bodyMarkdown.length > 50_000 ||
      /\u0000/u.test(bodyMarkdown) || /^---\s*\r?\n/u.test(bodyMarkdown)) {
    fail(422, 'DEV_BODY_INVALID', 'Use approved Markdown without conflicting YAML front matter.');
  }
  return {
    title: normalizeHeadline(title),
    body_markdown: bodyMarkdown,
    published: true,
    ...(canonicalUrl ? { canonical_url: canonical(canonicalUrl) } : {}),
  };
}

function articleAccount(response, profile) {
  return providerId(response?.user?.user_id ?? response?.user?.id) === profile.userId &&
    response?.user?.username?.toLowerCase() === profile.username.toLowerCase();
}

function matchesArticle(response, expected, profile) {
  return articleAccount(response, profile) && response.title === expected.title &&
    response.body_markdown === expected.body_markdown &&
    (!expected.canonical_url || response.canonical_url === expected.canonical_url);
}

function readPublicUrl(value, profile) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin === FOREM_API && !url.username && !url.password && !url.hash &&
        /^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/?$/u.test(url.pathname) && !url.search &&
        url.pathname.split('/')[1].toLowerCase() === profile.username.toLowerCase()) {
      return url.href;
    }
  } catch {
    return null;
  }
  return null;
}

export function createDevConnector({ mode = 'real', apiKey, accountId, userId, username, fetchImpl, now = Date.now } = {}) {
  modeOf(mode);
  if (mode === 'fixture' && typeof fetchImpl !== 'function') {
    fail(422, 'FIXTURE_TRANSPORT_REQUIRED', 'Fixture connectors require an isolated transport.');
  }
  const request = fetchImpl ?? fetch;
  const profile = { accountId, userId: providerId(userId), username };
  const configured = typeof accountId === 'string' && Boolean(profile.userId) && typeof username === 'string' &&
    HANDLE.test(username) && typeof apiKey === 'string' && Boolean(apiKey) && !/\s/u.test(apiKey);

  async function call(path, { body, privateRequest = false } = {}) {
    const headers = { Accept: ACCEPT };
    if (privateRequest) headers['api-key'] = apiKey;
    if (body) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await request(new URL(path, FOREM_API), {
        method: body ? 'POST' : 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      return { status: null, data: null };
    }
    if (!response.ok) return { status: response.status, data: null };
    try {
      const parts = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4_000_000) return { status: response.status, data: null };
        parts.push(chunk);
      }
      return { status: response.status, data: JSON.parse(Buffer.concat(parts).toString('utf8')) };
    } catch {
      return { status: response.status, data: null };
    }
  }

  function assertAccount(expectedAccountId) {
    if (!configured) fail(503, 'DEV_CONNECTOR_UNCONFIGURED', 'The verified DEV connector account is unavailable.');
    if (expectedAccountId !== profile.accountId) fail(403, 'DEV_ACCOUNT_SCOPE_DENIED', 'The connector is bound to a different account.');
  }

  async function identify(expectedAccountId) {
    assertAccount(expectedAccountId);
    const { status, data } = await call('/api/users/me', { privateRequest: true });
    if (status === 401 || status === 403) fail(403, 'DEV_AUTHORIZATION_EXPIRED', 'The configured DEV credential needs reauthorization.');
    if (!data) fail(503, 'DEV_IDENTITY_UNAVAILABLE', 'The DEV account could not be verified.');
    if (providerId(data.id) !== profile.userId || data.username?.toLowerCase() !== profile.username.toLowerCase()) {
      fail(403, 'DEV_IDENTITY_MISMATCH', 'The authorized DEV identity differs from the frozen target.');
    }
    return profile.userId;
  }

  function inSubmissionWindow(row, submittedAfter) {
    const at = Date.parse(row?.published_at);
    return Number.isFinite(at) && Number.isSafeInteger(submittedAfter) &&
      at >= Math.floor(submittedAfter / 1000) * 1000 && at <= now();
  }

  async function readback(id, expected, operationKey, packageHash, submittedAfter) {
    const result = await call(`/api/articles/${id}`);
    const url = readPublicUrl(result.data?.url, profile);
    const publishedAt = Date.parse(result.data?.published_at);
    const verifiedAt = now();
    if (providerId(result.data?.id) !== id || !matchesArticle(result.data, expected, profile) || !url ||
        !inSubmissionWindow(result.data, submittedAfter)) {
      return { status: 'accepted', remoteId: id };
    }
    const material = { operationKey, packageHash, id, url, accountId: profile.accountId, publishedAt, verifiedAt, mode };
    return {
      status: 'verified', remoteId: id, url, accountId: profile.accountId, visibility: 'public',
      publishedAt, verifiedAt, verificationMethod: 'official_api_readback', receiptRef: `dev-${hash(material)}`, mode,
    };
  }

  async function searchAuthorArticles(expected) {
    const matches = new Map();
    for (let page = 1; page <= AUTHOR_PAGE_LIMIT; page++) {
      const { data } = await call(`/api/articles/me/all?page=${page}&per_page=${AUTHOR_PAGE_SIZE}`, { privateRequest: true });
      if (!Array.isArray(data)) return null;
      for (const article of data) {
        const id = providerId(article.id);
        if (id && article.published === true && matchesArticle(article, expected, profile)) matches.set(id, article);
      }
      if (data.length < AUTHOR_PAGE_SIZE) return matches;
    }
    return null;
  }

  async function reconcile({ accountId: expectedAccountId, payload, operationKey, packageHash, remoteId = null, submittedAfter }) {
    await identify(expectedAccountId);
    const expected = devArticleInput(payload);
    let id = providerId(remoteId);
    if (!id) {
      const matches = await searchAuthorArticles(expected);
      if (matches?.size === 1) {
        const [candidateId, candidate] = matches.entries().next().value;
        if (inSubmissionWindow(candidate, submittedAfter)) id = candidateId;
      }
    }
    return id ? readback(id, expected, operationKey, packageHash, submittedAfter) : { status: 'unknown' };
  }

  return Object.freeze({
    mode,
    configured,
    identify,
    reconcile,
    async publish({ accountId: expectedAccountId, payload, packageHash, beforeSubmit, onSubmitted }) {
      await identify(expectedAccountId);
      const expected = devArticleInput(payload);
      const existing = await searchAuthorArticles(expected);
      if (!existing) fail(409, 'DEV_DUPLICATE_SCOPE_UNAVAILABLE', 'The authorized account could not confirm that the article is new.');
      if (existing.size) fail(409, 'DEV_ARTICLE_ALREADY_PRESENT', 'An exact article already exists on this account.');
      const { execute, operationKey } = await beforeSubmit();
      if (!execute) return { status: 'unknown', operationKey };
      const submittedAfter = now();
      const { status, data } = await call('/api/articles', { privateRequest: true, body: { article: expected } });
      if ([400, 401, 403, 422, 429].includes(status)) {
        return { status: 'not_executed', operationKey, code: `DEV_HTTP_${status}`, authoritative: true,
          receiptRef: `dev-rejection-${hash({ operationKey, status, packageHash })}` };
      }
      const id = providerId(data?.id);
      if (!id || status < 200 || status >= 300) return { status: 'unknown', operationKey };
      await onSubmitted({ operationKey, remoteId: id });
      return { ...await readback(id, expected, operationKey, packageHash, submittedAfter), operationKey };
    },
  });
}
