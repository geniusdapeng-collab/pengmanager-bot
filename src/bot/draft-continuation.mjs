import { digest } from "./files.mjs";

export const DRAFT_CONTINUATION_KEY = "bounded-draft-continuation";
export const DRAFT_CONTINUATION_ACTION = "retry_truncated_draft";

export function isSettledTruncatedResponse(row, wire) {
  return isSettledProviderResponse(row, JSON.parse(row.data), wire, "length");
}

export function isSettledProviderResponse(row, record, wire, finishReason) {
  if (!wire || wire.costId !== row.id || wire.requestKey !== record.requestKey || !record.providerRef ||
      wire.providerRef !== record.providerRef || wire.actualMinor !== row.actual || wire.currency !== row.currency ||
      typeof wire.body !== "string" || digest(wire.body) !== wire.responseHash || wire.responseHash !== record.evidenceRef) return false;
  const envelope = JSON.parse(wire.body);
  const usage = envelope.usage;
  return envelope.id === wire.providerRef && envelope.choices?.length === 1 && envelope.choices[0]?.finish_reason === finishReason &&
    [usage?.prompt_tokens, usage?.completion_tokens, usage?.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0) &&
    usage.prompt_tokens + usage.completion_tokens === usage.total_tokens &&
    (!record.providerTokenHold || (usage.prompt_tokens <= record.providerTokenHold.inputTokens &&
      usage.completion_tokens <= record.providerTokenHold.outputTokens));
}

export function truncatedNativeRevision(state, jobId) {
  const job = state?.contentDirectorJobs?.find(row => row.id === jobId);
  const source = job?.boundedRevisionSource;
  if (!job?.managedExecution || job.createdBy !== "bot-native-preparation" || job.status !== "failed" ||
      job.error?.code !== "MODEL_OUTPUT_TRUNCATED" || job.error?.unknown || job.pauseRequested ||
      job.currentStep !== "article.repair" || !/^[a-f0-9]{64}$/.test(source ?? "") || source !== job.resultRef?.sha256) return null;
  const steps = state.contentDirectorSteps.filter(s => s.jobId === jobId && s.key.startsWith("bounded:" + source + ":"));
  const scope = steps.find(s => s.kind === "repair.scope" && s.status === "succeeded" && s.receipt?.responseId && s.output?.paragraphs?.length);
  if (!scope || !steps.some(s => s.kind === "article.repair" && s.status === "failed" &&
      s.error?.code === "MODEL_OUTPUT_TRUNCATED" && s.key.startsWith(scope.key + ":edit:"))) return null;
  return { sourceSha256: source, scopeStepId: scope.id };
}
