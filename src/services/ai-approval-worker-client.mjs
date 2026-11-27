import { boundedResponseBytes } from "../content-ops-worker/protocol.mjs";

const CLAIM_DEADLINE_MS = 180_000;
const REPORT_DEADLINE_MS = 30_000;
// The persisted order is limited to 12 MB. Allow room for its claim envelope.
const CLAIM_RESPONSE_BYTES = 12_001_024;
const REPORT_RESPONSE_BYTES = 65_536;

function workerError(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function requestAiApprovalWorker({ origin, action, body, authorization, signal }) {
  const claim = action === "claim";
  const budget = claim ? CLAIM_DEADLINE_MS : REPORT_DEADLINE_MS;
  const expiresAt = performance.now() + budget;
  const deadline = AbortSignal.timeout(budget);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

  let response, result;
  try {
    response = await fetch(`${origin}/api/ai-approval-worker/${action}`, {
      method: "POST", redirect: "error", signal: requestSignal, body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-Pengmanager-Ai-Approval-Worker": authorization },
    });
    const bytes = await boundedResponseBytes(response, claim && response.ok ? CLAIM_RESPONSE_BYTES : REPORT_RESPONSE_BYTES);
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    requestSignal.throwIfAborted();
  } catch (error) {
    if (deadline.aborted || performance.now() >= expiresAt) {
      throw workerError("AI_WORKER_RESPONSE_TIMEOUT", "审核工位未在期限内完整收到并解析响应。");
    }
    if (signal?.aborted) throw workerError("AI_WORKER_STOPPED", "审核工位已停止请求，保留原工作单。");
    if (error?.code === "RESPONSE_TOO_LARGE") {
      // An oversized declared length can be rejected before the body reader is opened.
      if (response?.body) await response.body.cancel().catch(() => undefined);
      throw workerError("AI_WORKER_RESPONSE_TOO_LARGE", "审核工位响应超过允许的字节数。");
    }
    if (error instanceof SyntaxError || error?.code === "ERR_ENCODING_INVALID_ENCODED_DATA") {
      throw workerError("AI_WORKER_RESPONSE_INVALID", "审核工位未收到有效的 JSON 响应。");
    }
    throw workerError("AI_WORKER_TRANSPORT_FAILED", "审核工位未收到完整回应，保留原请求编号。");
  }

  if (performance.now() >= expiresAt) {
    throw workerError("AI_WORKER_RESPONSE_TIMEOUT", "审核工位未在期限内完整收到并解析响应。");
  }
  if (!response.ok) {
    const code = result?.error?.code;
    throw workerError(typeof code === "string" && /^[A-Z0-9_]{1,80}$/u.test(code) ? code : "AI_WORKER_HTTP_FAILED",
      `审核工位暂不能完成请求（${response.status}）。`);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw workerError("AI_WORKER_RESPONSE_INVALID", "审核工位未收到有效的 JSON 响应。");
  }
  return result;
}
