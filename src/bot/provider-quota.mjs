import { join } from "node:path";
import { planWindow } from "../model-routing/budget.mjs";
import { ModelAdmissionError } from "../model-routing/errors.mjs";
import { MODEL_POLICY } from "../model-routing/policy.mjs";
import { TEXT_PRIMARY_MODEL } from "../model-routing/registry.mjs";
import { BotError } from "./core-store.mjs";
import { digest, readRecord } from "./files.mjs";

function deny(message, details) {
  throw new ModelAdmissionError(new BotError(409, "BUDGET_EXCEEDED", message, details));
}

export function taskProviderQuota(config) {
  if (config === undefined) return null;
  if (!config || !Array.isArray(config.taskIds) || !config.taskIds.length || config.taskIds.length > 32 ||
      !config.taskIds.every(id => typeof id === "string" && /^task-[a-f0-9]{42}$/.test(id)) ||
      new Set(config.taskIds).size !== config.taskIds.length ||
      ![config.maxCalls, config.maxTotalTokens, config.maxOutputTokens].every(n => Number.isSafeInteger(n) && n > 0) ||
      config.maxOutputTokens > TEXT_PRIMARY_MODEL.maxOutputTokens || config.maxOutputTokens > config.maxTotalTokens) {
    throw new Error("Invalid taskProviderQuota in the owner configuration.");
  }
  const ceilings = config.sceneMaxOutputTokens;
  if (ceilings !== undefined && (!ceilings || typeof ceilings !== "object" || Array.isArray(ceilings) ||
      !Object.keys(ceilings).length || !Object.entries(ceilings).every(([scene, cap]) =>
        Object.hasOwn(MODEL_POLICY.scenes, scene) && Number.isSafeInteger(cap) && cap > 0 &&
        cap <= TEXT_PRIMARY_MODEL.maxOutputTokens && cap <= config.maxTotalTokens))) {
    throw new Error("Invalid sceneMaxOutputTokens in the owner taskProviderQuota.");
  }
  return Object.freeze({ taskIds: Object.freeze([...config.taskIds].sort()),
    maxCalls: config.maxCalls, maxTotalTokens: config.maxTotalTokens, maxOutputTokens: config.maxOutputTokens,
    ...(ceilings ? { sceneMaxOutputTokens: Object.freeze(Object.fromEntries(Object.keys(ceilings).sort().map(key => [key, ceilings[key]]))) } : {}) });
}

export function sceneOutputCap(quota, scene) {
  return quota.sceneMaxOutputTokens && Object.hasOwn(quota.sceneMaxOutputTokens, scene)
    ? quota.sceneMaxOutputTokens[scene] : quota.maxOutputTokens;
}

export async function quotaReservation(quota, { body, isSearch, scene, wireSha256 }) {
  if (isSearch || body.max_tokens > sceneOutputCap(quota, scene)) {
    deny("This request exceeds the task group's authorized text-model output or operation.");
  }
  let plan;
  try {
    plan = await planWindow({
      messages: body.messages, tools: body.tools, responseFormat: body.response_format,
      thinking: body.thinking, reasoningEffort: body.reasoning_effort,
      contextTokens: TEXT_PRIMARY_MODEL.contextTokens, maxOutputTokens: TEXT_PRIMARY_MODEL.maxOutputTokens,
      policyMaxOutputTokens: body.max_tokens,
    });
  } catch {
    deny("The final provider request has no verified token bound.");
  }
  if (plan.outputCeiling !== body.max_tokens) deny("The final provider output ceiling exceeds its verified window.");
  return { inputTokens: plan.inputTokens, outputTokens: body.max_tokens, ...(scene ? { scene, wireSha256 } : {}) };
}

// Called synchronously inside the currency ledger's write transaction. One in-flight
// request per group keeps unknown usage fenced through retries and process restarts.
export function admitProviderQuota(quota, hold, { id, taskId, rowsForTasks }, receipts) {
  if (!quota.taskIds.includes(taskId)) return undefined;
  if (!hold) deny("The lease has no matching preflight for its task quota.");
  const rows = rowsForTasks(quota.taskIds);
  let calls = 0;
  let tokens = 0;
  const refs = new Set();
  for (const row of rows) {
    if (row.id === id || (row.state === "released" && !row.dispatchedAt)) continue;
    if (row.state !== "settled") deny("Reconcile the original pending request before another dispatch.");
    let entry, usage;
    try {
      entry = readRecord(join(receipts, row.id + ".json"));
      if (entry) usage = JSON.parse(entry.body).usage;
    } catch {
      deny("The original provider receipt could not be verified.");
    }
    if (!entry || entry.costId !== row.id || entry.providerRef !== row.providerRef || !row.providerRef ||
        entry.requestKey !== row.requestKey || typeof entry.body !== "string" ||
        digest(entry.body) !== entry.responseHash || entry.responseHash !== row.evidenceRef || refs.has(row.providerRef)) {
      deny("The original provider receipt is missing, duplicated or does not match its ledger entry.");
    }
    if (!usage || ![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0) ||
        usage.prompt_tokens + usage.completion_tokens !== usage.total_tokens ||
        (row.providerTokenHold && (usage.prompt_tokens > row.providerTokenHold.inputTokens ||
          usage.completion_tokens > row.providerTokenHold.outputTokens))) {
      deny("The settled provider usage requires reconciliation against its original reservation.");
    }
    refs.add(row.providerRef);
    calls += 1;
    tokens += usage.total_tokens;
  }
  if (calls + 1 > quota.maxCalls || tokens + hold.inputTokens + hold.outputTokens > quota.maxTotalTokens) {
    deny("The task group cannot reserve this provider call and its complete token bound.",
      { calls, tokens, requested: hold, maxCalls: quota.maxCalls, maxTotalTokens: quota.maxTotalTokens });
  }
  return hold;
}
