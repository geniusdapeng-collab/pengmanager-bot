import { createCadenceTrials } from "./learning.mjs";
import { requirePublicUrl } from "../domain/public-url.mjs";
import { join } from "node:path";
import { digest, privateDirectory, putRecord, readRecord } from "./files.mjs";
import { hash } from "./core-store.mjs";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,90}$/;
function publicLink(value, { syntheticNetwork = false } = {}) {
  try {
    const u = new URL(value);
    if (syntheticNetwork && u.hostname.endsWith(".example.test") && u.protocol === "https:" &&
        !u.username && !u.password && !u.port && !u.search && !u.hash) return u.href;
    return requirePublicUrl(u.href, "feed source");
  } catch { return null; }
}

async function boundedJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("FEED_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function identifySourceCandidate(candidate) {
  if (typeof candidate?.sourceUrl !== "string" || typeof candidate.text !== "string" ||
      typeof candidate.sourceExcerpt !== "string") return null;
  const sourceDigest = hash([candidate.sourceUrl, candidate.text, candidate.sourceExcerpt]);
  return { id: "C-" + sourceDigest.slice(0, 36), sourceDigest };
}

function evidenceText(title, excerpt) {
  const statements = excerpt.split(/\r?\n/u).map(line => line.trim().replace(/^(?:[-*+]\s+|\d+\.\s+)/u, ""))
    .filter(line => line.length >= 24 && !/^(?:[#>|\x60]|https?:\/\/)/u.test(line));
  return statements.length ? `${title} — ${statements.slice(0, 4).join(" ")}`.slice(0, 1200) : title;
}

export function createSources({ dataDir, core, ctx, sources = [], mode, clock = Date.now, fetchImpl = fetch }) {
  const inbox = privateDirectory(join(dataDir, "sources"));
  const trials = createCadenceTrials({ core, ctx, mode, dataDir, clock });
  const registered = new Map();
  const pollState = new Map();
  const syntheticNetwork = fetchImpl !== fetch;
  const liveMandates = () => core.listMandates(ctx).filter(m => m.state === "active" &&
    (m.expiresAt == null || m.expiresAt > clock()));
  const allowsSource = sourceId => liveMandates().some(m => m.trustScope?.sources?.includes(sourceId));
  for (const source of sources) {
    const link = publicLink(source.url, { syntheticNetwork });
    if (!ID.test(source.id) || ["manual","schedule"].includes(source.id) || registered.has(source.id) ||
        !["json-feed", "github-releases"].includes(source.format) || !link) {
      throw new Error("Invalid or duplicate BOT source configuration.");
    }
    if (source.priority !== undefined && (!Number.isInteger(source.priority) || source.priority < 0 || source.priority > 100)) throw new Error("Source priority must be an integer from 0 to 100.");
    const url = new URL(link);
    if (url.hash) throw new Error("A registered source cannot use a URL fragment.");
    if (source.format === "github-releases" && (url.hostname !== "api.github.com" || !/^\/repos\/[\w.-]+\/[\w.-]+\/releases$/.test(url.pathname))) {
      throw new Error("A releases source must use a public GitHub releases endpoint.");
    }
    if (source.itemOrigins !== undefined && (!Array.isArray(source.itemOrigins) || source.itemOrigins.length > 10 ||
        source.itemOrigins.some(value => !publicLink(value, { syntheticNetwork }) || value !== new URL(value).origin))) {
      throw new Error("Item origins must be exact public HTTPS origins.");
    }
    const itemOrigins = new Set([url.origin, ...(source.itemOrigins ?? [])]);
    const repositoryPath = url.pathname.replace(/^\/repos/u, "").replace(/\/releases$/u, "");
    registered.set(source.id, { ...source, url: url.href, itemOrigins, repositoryPath });
  }
  function record(sourceId, externalId, opportunity, { mandateId, occurredAt, factKey } = {}) {
    const version = digest(JSON.stringify(opportunity));
    const eventKey = digest(JSON.stringify([sourceId, externalId, version]));
    const payloadRef = "source-" + digest(sourceId + ":" + eventKey);
    putRecord(inbox, payloadRef, { eventKey, sourceId, payloadRef, opportunity });
    return core.ingestEvent({ sourceId, eventKey, payloadRef, title: opportunity.title, priority: registered.get(sourceId)?.priority ?? 0, factKey: factKey || eventKey, occurredAt, mandateId }, ctx);
  }
  function fromFeed(source, item) {
    const release = source.format === "github-releases";
    if (release && (item.draft || item.prerelease && !source.prereleases)) return;
    const url = publicLink(release ? item.html_url : item.url || item.external_url, { syntheticNetwork });
    const rawId = item.id;
    const title = String(release ? item.name || item.tag_name || "" : item.title || "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (!url || rawId == null || !title) return;
    const entry = new URL(url);
    const authoritative = release ? entry.origin === "https://github.com" &&
      entry.pathname.toLowerCase().startsWith(`${source.repositoryPath.toLowerCase()}/releases/tag/`) :
      source.itemOrigins.has(entry.origin);
    if (release && !authoritative) return;
    const excerpt = String(release ? item.body || "" : item.summary || item.content_text || "").trim().slice(0, 5000);
    const opportunity = {
      title, sourceUrl: url, excerpt, locale: source.locale || "zh-CN",
      claimIds: source.claimIds || [], forms: source.forms || ["article"],
      candidate: source.allowPublicFacts && authoritative && excerpt
        ? { text: evidenceText(title, excerpt), sourceUrl: url, sourceExcerpt: excerpt, sourceLabel: source.label || source.id } : null,
    };
    const time = Date.parse(release ? item.published_at : item.date_modified || item.date_published);
    return record(source.id, String(rawId), opportunity, {
      occurredAt: Number.isFinite(time) ? time : undefined, factKey: digest(JSON.stringify([url, title, excerpt])),
    });
  }
  async function poll() {
    if (mode !== "real") return;
    const mandates = liveMandates();
    trials.refresh(mandates, registered);
    for (const source of registered.values()) {
      const prior = pollState.get(source.id) || {};
      const interval = Math.max(60_000, Number(source.intervalMs) || 900_000) * trials.forSource(source.id).factor;
      if (prior.startedAt !== undefined && prior.startedAt + interval > clock() || !allowsSource(source.id)) continue;
      const state = { ...prior, startedAt: clock(), nextAt: clock() + interval };
      pollState.set(source.id, state);
      try {
        const headers = { Accept: "application/json", "User-Agent": "PengManager-BOT" };
        if (state.etag) headers["If-None-Match"] = state.etag;
        const response = await fetchImpl(source.url, { headers, redirect: "error", signal: AbortSignal.timeout(12_000) });
        if (response.status === 304) { state.error = null; continue; }
        if (!response.ok) throw new Error("FEED_HTTP_" + response.status);
        const doc = await boundedJson(response);
        const items = source.format === "github-releases" ? doc : doc.items;
        if (!Array.isArray(items)) throw new Error("INVALID_FEED");
        if (!allowsSource(source.id)) continue;
        for (const item of items.slice(0, 100).reverse()) if (item && typeof item === "object") fromFeed(source, item);
        state.etag = response.headers.get("etag");
        state.lastSuccess = clock();
        state.error = null;
      } catch (error) {
        state.error = ["FEED_TOO_LARGE","INVALID_FEED"].includes(error.message) || /^FEED_HTTP_\d{3}$/.test(error.message) ? error.message : "FEED_UNAVAILABLE";
      }
    }
  }
  return {
    inbox, poll, registered,
    list: () => [{ id: "manual", label: "本人提交的线索", active: true },
      ...[...registered.values()].map(s => ({ id: s.id, label: s.label || s.id, active: true, strategy: trials.forSource(s.id), ...pollState.get(s.id) }))],
    submit(input) {
      if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 500 ||
          typeof input.externalId !== "string" || input.externalId.length > 150 ||
          input.sourceUrl && !publicLink(input.sourceUrl, { syntheticNetwork })) throw Object.assign(new Error("Invalid source event."), { status: 422, code: "INVALID_SOURCE_EVENT" });
      return record("manual", input.externalId, { title: input.title, sourceUrl: input.sourceUrl || null,
        excerpt: String(input.text || "").slice(0, 5000), claimIds: Array.isArray(input.claimIds) ? input.claimIds : [],
        locale: input.locale || "zh-CN", forms: ["article"] }, { mandateId: input.mandateId });
    },
    candidate(task) {
      const ref = task.input?.payloadRef;
      if (!/^source-[a-f0-9]{64}$/.test(ref || "")) return null;
      const data = readRecord(join(inbox, ref + ".json"));
      const source = registered.get(task.input.sourceId);
      return source?.allowPublicFacts === true && data?.sourceId === source.id && data.eventKey === task.input.eventKey ?
        data.opportunity.candidate : null;
    },
  };
}
