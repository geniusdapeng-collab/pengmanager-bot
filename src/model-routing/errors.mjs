export class ModelDispatchError extends Error {
  constructor(code, message, {
    unknown = false,
    retryable = false,
    httpStatus,
    cause,
    metering,
    usageReceipt,
    providerRequestId,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ModelDispatchError";
    this.code = code;
    this.unknown = unknown;
    this.retryable = retryable;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (metering !== undefined) this.metering = metering;
    if (usageReceipt !== undefined) this.usageReceipt = usageReceipt;
    if (providerRequestId !== undefined) this.providerRequestId = providerRequestId;
  }
}

export function modelError(code, message, options) {
  return new ModelDispatchError(code, message, options);
}

// Only the local meter can attest that admission failed before a provider call.
// A transport may throw the same business code after a request was sent.
export class ModelAdmissionError extends ModelDispatchError {
  constructor(cause) {
    super(cause.code, cause.message, { cause });
    this.name = "ModelAdmissionError";
    this.status = cause.status;
    this.details = cause.details;
  }
}

export class ModelQuotaReceiptError extends ModelDispatchError {
  constructor({ providerRequestId, usageReceipt, unknown }) {
    super("MODEL_QUOTA_RECEIPT_RECONCILIATION_REQUIRED", "原始供应商用量与请求的配额预留不符，已停止交付并保留对账依据。",
      { providerRequestId, usageReceipt, unknown });
  }
}
