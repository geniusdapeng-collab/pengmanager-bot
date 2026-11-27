import { ApiError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";
import { editorialSensitiveFindings } from "../domain/editorial.mjs";

export function separateReviewProof(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { input };
  const { reviewProof, ...request } = input;
  return { input: request, proof: reviewProof };
}

export async function reviewOperationEvidence(aiApproval, { kind, subjectId, evidence, criteria, proof }) {
  if (editorialSensitiveFindings(evidence).length) {
    throw new ApiError(422, "AI_REVIEW_EVIDENCE_SENSITIVE", "审核材料包含敏感信息，须提供已授权的脱敏证据。");
  }
  const exactEvidence = JSON.parse(JSON.stringify(evidence));
  const snapshotHash = hashObject(exactEvidence);
  const aiReview = await aiApproval.review({ kind, subjectId, snapshotHash, evidence: exactEvidence, criteria, proof });
  if (aiReview?.actor !== "ai-reviewer") {
    throw new ApiError(503, "AI_APPROVAL_RECEIPT_INVALID", "审批服务未返回受信任的 AI 审核凭据。");
  }
  return { snapshotHash, aiReview };
}

export function assertOperationReviewCurrent(review, evidence) {
  if (review && review.snapshotHash !== hashObject(JSON.parse(JSON.stringify(evidence)))) {
    throw new ApiError(409, "AI_APPROVAL_SNAPSHOT_CHANGED", "审核材料在判断期间变化。请核对当前版本并重新发起审核。");
  }
}
