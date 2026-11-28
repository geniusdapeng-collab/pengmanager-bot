import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { digest, privateDirectory, putRecord, readRecord } from "./files.mjs";
import { BotError, fail, hash } from "./core-store.mjs";
import { ModelAdmissionError, ModelQuotaReceiptError } from "../model-routing/errors.mjs";
import { TEXT_PRIMARY_MODEL } from "../model-routing/registry.mjs";
import { admitProviderQuota, quotaReservation, taskProviderQuota } from "./provider-quota.mjs";

const MAX_PROVIDER_BYTES = 3_000_000;

async function boundedBody(response) {
  if (!response.body) throw new Error("Provider response body missing.");
  let size = 0;
  const parts = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_PROVIDER_BYTES) fail(502, "PROVIDER_RESPONSE_LIMIT", "The original provider response exceeded its bound.");
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

// Rates are the operator's contract in minor currency units per million tokens.
// The pre-dispatch bound uses the registered provider context window, even if the prompt is short.
export function createMeter({ core, dataDir, pricing, endpoint, mode, fetchImpl = fetch, taskQuota }) {
  const active = new AsyncLocalStorage();
  const quota = taskProviderQuota(taskQuota);
  const scoped = () => quota?.taskIds.includes(active.getStore()?.step.taskId);
  const receipts = privateDirectory(join(dataDir, "provider-receipts"));
  const base = new URL(endpoint);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("A credential-free HTTPS model endpoint is required.");
  }
  const tokenCost = (count, rate) => BigInt(count) * BigInt(rate);
  const minor = value => Number((value + 999999n) / 1000000n);
  const priceReady = pricing && /^[A-Z]{3}$/.test(pricing.currency) && typeof pricing.reference === "string" && pricing.reference.trim() &&
    ["inputPerMillion", "outputPerMillion", "cacheHitPerMillion"].every(field => Number.isSafeInteger(pricing[field]) && pricing[field] >= 0 && pricing[field] <= 10000000) &&
    pricing.cacheHitPerMillion <= pricing.inputPerMillion && pricing.outputPerMillion + pricing.inputPerMillion > 0;
  const prefix = base.pathname.replace(/\/+$/u, "");
  const chatPaths = new Set([`${prefix}/chat/completions`, ...(!prefix.endsWith("/v1") ? [`${prefix}/v1/chat/completions`] : [])]);
  const searchPath = `${prefix.endsWith("/v1") ? prefix : prefix + "/v1"}/tools/search`;
  const tariffHash = priceReady ? hash([base.href, pricing.reference, pricing.currency,
    pricing.inputPerMillion, pricing.cacheHitPerMillion, pricing.outputPerMillion, pricing.searchPerRequest ?? null]) : null;
  function measured(output, body, isSearch, maximum, reserve) {
    if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Invalid provider response.");
    if (isSearch) return reserve;
    const u = output.usage;
    const hit = u?.prompt_cache_hit_tokens ?? (pricing.cacheHitPerMillion === pricing.inputPerMillion ? 0 : undefined);
    if (output.model !== body.model || ![hit, u?.prompt_tokens, u?.completion_tokens].every(v => Number.isSafeInteger(v) && v >= 0) ||
        hit > u.prompt_tokens || u.prompt_tokens > TEXT_PRIMARY_MODEL.contextTokens || u.completion_tokens > maximum) {
      throw new Error("Provider usage mismatch.");
    }
    return minor(tokenCost(u.prompt_tokens - hit, pricing.inputPerMillion) + tokenCost(hit, pricing.cacheHitPerMillion) +
      tokenCost(u.completion_tokens, pricing.outputPerMillion));
  }
  return {
    ready: Boolean(priceReady) && mode === "real",
    quotaFingerprint: quota ? digest(JSON.stringify({ taskIds: [...quota.taskIds].sort(),
      maxCalls: quota.maxCalls, maxTotalTokens: quota.maxTotalTokens, maxOutputTokens: quota.maxOutputTokens })) : undefined,
    maxOutputTokens: () => scoped() ? quota.maxOutputTokens : undefined,
    run: (step, auth, work) => active.run({ step, auth }, work),
    async fetch(url, options = {}) {
      const ctx = active.getStore();
      if (mode !== "real" || !ctx || !priceReady) fail(409, "MODEL_COST_AUTHORIZATION_REQUIRED", "Set a priced provider profile and lease an authorized BOT task.");
      const dest = new URL(url);
      const isSearch = dest.pathname === searchPath;
      if (dest.origin !== base.origin || dest.username || dest.password || dest.search || dest.hash || options.method !== "POST" ||
          !isSearch && !chatPaths.has(dest.pathname)) fail(403, "PROVIDER_SCOPE_DENIED", "The request is outside the priced model endpoint.");
      if (typeof options.body !== "string" || Buffer.byteLength(options.body) > MAX_PROVIDER_BYTES) {
        fail(422, "PROVIDER_REQUEST_LIMIT", "The priced provider needs a bounded JSON body.");
      }
      const body = JSON.parse(options.body);
      if (!body || typeof body !== "object" || Array.isArray(body) || body.stream === true) {
        fail(422, "PROVIDER_REQUEST_INVALID", "Only complete, nonstreaming provider receipts can be metered.");
      }
      const maximum = body.max_tokens;
      if (isSearch ? !Number.isSafeInteger(pricing.searchPerRequest) || pricing.searchPerRequest <= 0 :
          body.model !== TEXT_PRIMARY_MODEL.officialModelId || !Number.isSafeInteger(maximum) || maximum < 1 ||
          maximum > TEXT_PRIMARY_MODEL.maxOutputTokens) fail(422, "PROVIDER_PRICE_SCOPE_INVALID", "No price covers this provider request.");
      const reserve = isSearch ? pricing.searchPerRequest : Math.max(1, minor(
        tokenCost(TEXT_PRIMARY_MODEL.contextTokens, pricing.inputPerMillion) + tokenCost(maximum, pricing.outputPerMillion)));
      const { step, auth } = ctx;
      const hold = scoped() ? await quotaReservation(quota, { body, isSearch }) : undefined;
      const usageCheckMaximum = hold ? TEXT_PRIMARY_MODEL.maxOutputTokens : maximum;
      // A tariff change conflicts with an existing request reservation. It
      // cannot mint a new dispatch key for the same provider operation.
      const requestKey = hash([step.id, dest.href, digest(options.body)]);
      let cost;
      try {
        cost = core.reserveCost({ id: step.id, epoch: step.epoch, requestKey, currency: pricing.currency,
          reservedMinor: reserve, provider: dest.origin, requestHash: tariffHash }, auth,
        quota ? row => admitProviderQuota(quota, hold, row, receipts) : undefined);
      } catch (error) {
        if (error instanceof BotError && error.code === "BUDGET_EXCEEDED") throw new ModelAdmissionError(error);
        throw error;
      }
      const saved = readRecord(join(receipts, cost.id + ".json"));
      const restore = row => {
        const output = JSON.parse(row.body);
        if (row.costId !== cost.id || row.requestKey !== requestKey || row.responseHash !== digest(row.body) ||
            row.rateReference !== pricing.reference || row.currency !== pricing.currency || row.tariffHash !== tariffHash ||
            row.actualMinor !== measured(output, body, isSearch, usageCheckMaximum, reserve)) {
          fail(409, "PROVIDER_RECEIPT_CHANGED", "The saved provider response failed its integrity check.");
        }
        const reserved = cost.providerTokenHold ?? hold;
        const usage = output.usage;
        if (reserved && (!Number.isSafeInteger(usage?.total_tokens) || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens)) {
          if (cost.state !== "settled") core.settleCost({ costId: cost.id, status: "unknown" }, auth);
          throw new ModelQuotaReceiptError({ providerRequestId: row.providerRef, unknown: true });
        }
        core.settleCost({ costId: cost.id, status: "settled", actualMinor: row.actualMinor,
          evidenceRef: row.responseHash, providerRef: row.providerRef }, auth);
        if (reserved && (usage.prompt_tokens > reserved.inputTokens || usage.completion_tokens > reserved.outputTokens)) {
          throw new ModelQuotaReceiptError({ providerRequestId: row.providerRef, unknown: false,
            usageReceipt: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } });
        }
        return new Response(row.body, { status: 200, headers: { "Content-Type": "application/json" } });
      };
      if (saved) return restore(saved);
      const permit = core.markCostDispatched({ costId: cost.id, id: step.id, epoch: step.epoch }, auth);
      if (!permit.execute) fail(409, "ORIGINAL_COST_RECONCILIATION_REQUIRED", "An earlier request needs its original provider receipt.");
      try {
        const response = await fetchImpl(url, { ...options, redirect: "error" });
        if (!response.ok) {
          core.settleCost({ costId: cost.id, status: "unknown" }, auth);
          await response.body?.cancel();
          return new Response(null, { status: response.status || 502, headers: response.headers });
        }
        const raw = await boundedBody(response);
        const output = JSON.parse(raw);
        const providerRef = output.id || response.headers.get("x-request-id") || response.headers.get("x-ds-trace-id");
        if (typeof providerRef !== "string" || !providerRef) throw new Error("Provider receipt ID missing.");
        const amount = measured(output, body, isSearch, usageCheckMaximum, reserve);
        const entry = putRecord(receipts, cost.id, { costId: cost.id, requestKey, responseHash: digest(raw), body: raw,
          providerRef, actualMinor: amount, rateReference: pricing.reference, currency: pricing.currency, tariffHash });
        return restore(entry);
      } catch (error) {
        if (!(error instanceof ModelQuotaReceiptError)) core.settleCost({ costId: cost.id, status: "unknown" }, auth);
        throw error;
      }
    },
  };
}
