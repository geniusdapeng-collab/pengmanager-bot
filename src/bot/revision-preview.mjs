import { fail, identity } from "./core-store.mjs";
import { DRAFT_CONTINUATION_KEY, isSettledProviderResponse } from "./draft-continuation.mjs";

const failedTruncation = step => step?.state === "failed" && step.output?.code === "MODEL_OUTPUT_TRUNCATED";

export function revisionPreviewSource(core, task, role) {
  const child = task.steps.find(step => step.key === DRAFT_CONTINUATION_KEY && step.kind === "prepare");
  if (!failedTruncation(child) || !child.draftContinuation) return null;
  const link = child.draftContinuation;
  const parent = task.steps.find(step => step.id === link.sourceStepId && step.key === "private-draft" && step.kind === "prepare");
  if (!failedTruncation(parent) || parent.output.jobId !== link.jobId || child.output?.jobId && child.output.jobId !== link.jobId) return null;
  const mandate = core.getMandate(task.mandateId, role);
  if (role.role !== "owner" || mandate.ownerId !== role.actorId || mandate.workMode !== "draft_only") return null;
  const costs = core.listCosts(role, mandate.id).filter(cost => cost.taskId === task.id);
  if (costs.some(cost => cost.state !== "settled" && (cost.state !== "released" || cost.dispatchedAt))) return null;
  const paid = costs.filter(cost => cost.state === "settled");
  const original = paid.find(cost => cost.id === link.costId && cost.stepId === parent.id);
  const edits = paid.filter(cost => cost.stepId === child.id);
  const last = edits.at(-1);
  const reviews = edits.filter(cost => cost.providerTokenHold?.scene === "content.audit.article");
  if (!original || !reviews.length || last?.providerTokenHold?.scene !== "quality.final") return null;
  return { link, original, last, reviews };
}

function verified(cost, read, finish) {
  try {
    return isSettledProviderResponse(cost, cost, read(cost.id), finish);
  } catch {
    return false;
  }
}

export async function readOwnerRevisionPreview({ core, role, taskId, readProviderReceipt, readReviewedRevision }) {
  identity(role, ["owner"]);
  const task = core.getTask(taskId, role);
  if (core.getMandate(task.mandateId, role).ownerId !== role.actorId) fail(403, "OWNER_REQUIRED", "仅委托本人可查看此私有修订稿。");
  if (!readProviderReceipt || !readReviewedRevision) fail(503, "REVISION_PREVIEW_UNAVAILABLE", "此部署尚未接通修订稿证据。");
  const source = revisionPreviewSource(core, task, role);
  const unavailable = () => fail(409, "REVISION_PREVIEW_UNAVAILABLE", "此任务尚无可核验的终审待完成修订稿。");
  if (!source || !verified(source.original, readProviderReceipt, "length") || !verified(source.last, readProviderReceipt, "length")) unavailable();
  const { jobId, sourceSha256, scopeStepId } = source.link;
  const preview = await readReviewedRevision(jobId, { sourceSha256, scopeStepId });
  const first = source.reviews.find(cost => cost.providerRef === preview?.reviewResponseId);
  if (preview?.jobId !== jobId || preview.stage !== "quality.final" || preview.code !== "MODEL_OUTPUT_TRUNCATED" || preview.approved !== false ||
      !first || !verified(first, readProviderReceipt, "stop")) unavailable();
  return { taskId, jobId, stage: preview.stage, code: preview.code, approved: false, contentHash: preview.contentHash,
    title: preview.title, summary: preview.summary, body: preview.body, characters: preview.characters, editedBatches: preview.editedBatches,
    firstReview: preview.firstReview, reviewResponseId: preview.reviewResponseId };
}
