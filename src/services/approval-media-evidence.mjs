import { createHash } from "node:crypto";
import { ApiError } from "../domain/errors.mjs";
import { scanSensitiveText } from "../domain/policy.mjs";

export const AI_APPROVAL_MAX_IMAGE_COUNT = 12;
export const AI_APPROVAL_MAX_IMAGE_BYTES = 8_000_000;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const TEXT_TYPES = /^(?:text\/[^;]+|application\/(?:json|x-ipynb\+json|x-subrip))$/;

// The formatter receives the frozen object and a read-only handle already
// opened by its own storage service. The provider sees a bounded, exact input.
export async function inspectApprovalMedia({ handle, asset }) {
  try {
    const image = IMAGE_TYPES.has(asset.mime);
    if (!image && !TEXT_TYPES.test(asset.mime)) {
      throw new ApiError(422, "AI_APPROVAL_MEDIA_INSPECTION_REQUIRED",
        "这类素材需要能完整审阅实际内容的已授权模型或工位。只核对文件摘要不足以完成语义或隐私审核。");
    }
    const bytes = Buffer.alloc(asset.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
      throw new ApiError(409, "AI_APPROVAL_INPUT_CHANGED", "素材复核时字节已变化，请重新读取同一素材。");
    }
    if (image) return { images: [{ mime: asset.mime, bytes }] };
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (scanSensitiveText(source).length) {
      throw new ApiError(422, "AI_APPROVAL_SENSITIVE_INPUT", "素材包含待处理的敏感文本，请先取得适用授权或提交安全版本。");
    }
    return { text: source };
  } finally {
    await handle.close();
  }
}
