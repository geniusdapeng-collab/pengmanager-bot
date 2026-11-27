import { readArticleIllustrationProofs } from "./article-illustrations.js";
import { escapeHtml as html } from "./publication-view.js";

const SCHEMA = "pengmanager.editorial-batch-media/v1";
const KINDS = { architecture: "架构图", logic: "逻辑图", scene: "场景图" };
const MIME = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const HASH = /^[a-f0-9]{64}$/u;
const ASSET = /^MED-[a-f0-9]{32}$/u;
const MANIFEST_LIMIT = 64 * 1024;
const IMAGE_LIMIT = 8_000_000;
const READ_TIMEOUT = 30_000;
const REVIEW_TIMEOUT = 120_000;
const fields = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const bounded = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
const request = (timeout = READ_TIMEOUT) => ({ signal: AbortSignal.timeout(timeout) });
const recheck = () => ({ ...request(), cache: "no-store" });

function canonical(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

async function digest(buffer) {
  if (!globalThis.crypto?.subtle) throw new Error("请在 HTTPS 管理后台核对素材摘要。");
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buffer))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const hashValue = value => digest(new TextEncoder().encode(canonical(value)));

export function parseEditorialBatchMedia(text) {
  if (new TextEncoder().encode(text).byteLength > MANIFEST_LIMIT) throw new Error("单篇素材清单最多 64 KiB。");
  let manifest;
  try { manifest = JSON.parse(text.replace(/^\uFEFF/u, "")); }
  catch { throw new Error("请选择有效的单篇素材 JSON 清单。"); }
  if (!fields(manifest, ["schema", "storyId", "baseReleaseId", "planId", "sourceHash", "slots"]) ||
      manifest.schema !== SCHEMA || !matches(/^STY-\d{5,}$/u, manifest.storyId) ||
      !matches(/^REL-\d{5,}$/u, manifest.baseReleaseId) || !matches(/^ILP-\d{5,}$/u, manifest.planId) ||
      !matches(HASH, manifest.sourceHash) || !Array.isArray(manifest.slots) || manifest.slots.length !== 3) {
    throw new Error("清单须含准确的选题、原发布号、配图计划、原稿摘要和三个图位。");
  }
  for (const slot of manifest.slots) {
    const scene = slot?.kind === "scene";
    let keys = ["slotId", "kind", "sha256", "bytes", "width", "height", "rightsNote"];
    if (scene) keys = [...keys, "proofs"];
    else if (slot?.assetId !== undefined) keys = [...keys, "assetId"];
    if (!fields(slot, keys) || !Object.hasOwn(KINDS, slot.kind) || !matches(/^slot-\d{1,2}$/u, slot.slotId) ||
        !matches(HASH, slot.sha256) || !bounded(slot.bytes, IMAGE_LIMIT) || !bounded(slot.width, 65_535) ||
        !bounded(slot.height, 65_535) || typeof slot.rightsNote !== "string" || slot.rightsNote.trim() !== slot.rightsNote ||
        slot.rightsNote.length < 8 || slot.rightsNote.length > 2_000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(slot.rightsNote) ||
        (slot.assetId !== undefined && !matches(ASSET, slot.assetId)) ||
        (scene && (!fields(slot.proofs, ["designerCompositorSha256", "imageGenSha256"]) ||
          !matches(HASH, slot.proofs.designerCompositorSha256) || !matches(HASH, slot.proofs.imageGenSha256) ||
          slot.proofs.designerCompositorSha256 === slot.proofs.imageGenSha256))) {
      throw new Error("图位、素材摘要、尺寸、使用范围或场景原始回执摘要无效。");
    }
  }
  if (manifest.slots.map(slot => slot.kind).sort().join() !== "architecture,logic,scene" ||
      ["slotId", "sha256"].some(key => new Set(manifest.slots.map(slot => slot[key])).size !== 3)) {
    throw new Error("同一篇须提供不同图位的架构图、逻辑图和带双签章的场景图。");
  }
  return manifest;
}

async function readScope(manifest, { api, getBase }) {
  const base = getBase(manifest.storyId, manifest.baseReleaseId);
  const snapshot = base?.publicSnapshot;
  const original = { body: snapshot?.body, locale: snapshot?.locale, summary: snapshot?.summary, title: snapshot?.title };
  if (base?.id !== manifest.baseReleaseId || base.storyId !== manifest.storyId || base.status !== "published" ||
      snapshot?.format !== "article" || !matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, base.slug) ||
      Object.values(original).some(value => typeof value !== "string") || await hashValue(original) !== manifest.sourceHash) {
    throw new Error("清单与当前准许加图的原稿不一致。请刷新后重新核对。");
  }
  const [live, plan] = await Promise.all([
    api(`/public-api/content/${encodeURIComponent(snapshot.locale)}/article/${base.slug}`, recheck()),
    api(`/api/stories/${manifest.storyId}/illustrations/${manifest.planId}`, recheck()),
  ]);
  if (live?.releaseId !== base.id || live.snapshotHash !== base.snapshotHash || live.canonicalPath !== base.canonicalPath ||
      plan?.id !== manifest.planId || plan.storyId !== manifest.storyId ||
      plan.baseReleaseId !== manifest.baseReleaseId || plan.sourceHash !== manifest.sourceHash ||
      plan.schema !== "pengmanager.article-illustrations/v1" || !plan.etag || plan.frozen !== false ||
      !Array.isArray(plan.slots) || plan.slots.length !== 3) {
    throw new Error("当前公开原稿或未冻结配图计划已变化。请刷新后重新核对。");
  }
  for (const expected of manifest.slots) {
    const slot = plan.slots.find(item => item.id === expected.slotId);
    if (slot?.kind !== expected.kind || slot.imageGeneration !== (expected.kind === "scene") ||
        (slot.evidence && (slot.evidence.sha256 !== expected.sha256 || (expected.assetId && slot.evidence.assetId !== expected.assetId)))) {
      throw new Error(`${expected.slotId} 与该计划的图种、生产方式或已绑定素材不一致。`);
    }
  }
  return plan;
}

async function verifyFile(file, bytes, sha256, name) {
  if (!file?.size || file.size !== bytes || await digest(await file.arrayBuffer()) !== sha256) {
    throw new Error(`${name} 与清单的文件大小或 SHA-256 不一致。`);
  }
}

function verifyStatement(receipt, plan, slot) {
  const statement = receipt?.statement;
  return fields(receipt, ["statement", "signature", "producerKeyId"]) &&
    matches(/^[A-Za-z0-9_-]{86}$/u, receipt.signature) && matches(/^pk-[a-f0-9]{32}$/u, receipt.producerKeyId) &&
    statement?.planId === plan.id && statement.slotId === slot.id && statement.sourceHash === plan.sourceHash &&
    matches(HASH, statement.sha256) && bounded(statement.bytes, Number.MAX_SAFE_INTEGER) &&
    bounded(statement.width, 65_535) && bounded(statement.height, 65_535);
}

async function prepareScene(expected, slot, plan, proofFiles) {
  if (proofFiles.length !== 2) throw new Error("请选择准确的 Compositor 和 ImageGen 两份原始签章。");
  const proofs = await readArticleIllustrationProofs(proofFiles);
  const { designerCompositor, imageGen } = proofs;
  const hashes = await Promise.all(proofFiles.map(async file => digest(await file.arrayBuffer())));
  const designerIndex = JSON.parse(await proofFiles[0].text()).statement.source === "pengmanager-designer-compositor" ? 0 : 1;
  if (hashes[designerIndex] !== expected.proofs.designerCompositorSha256 ||
      hashes[1 - designerIndex] !== expected.proofs.imageGenSha256 ||
      !verifyStatement(designerCompositor, plan, slot) || !verifyStatement(imageGen, plan, slot)) {
    throw new Error("场景签章文件或其中的计划、图位和原稿摘要与清单不一致。");
  }
  const native = designerCompositor.statement;
  if (imageGen.statement.styleYear !== plan.styleYear || (plan.styleYear !== undefined && native.approvalAuthority !== "ai") ||
      native.sceneBriefHash !== slot.sceneBriefHash || !matches(HASH, slot.sceneBriefHash) ||
      native.sha256 !== expected.sha256 || native.width !== expected.width || native.height !== expected.height ||
      native.bytes !== expected.bytes || native.imageGenInputSha256 !== imageGen.statement.sha256) {
    throw new Error("场景签章中的成品、场景简报或生图底图与当前图位不一致。");
  }
  return { proofs, proofHashes: {
    designerCompositor: await hashValue(designerCompositor), imageGen: await hashValue(imageGen),
  } };
}

export async function previewEditorialBatchMedia(manifest, files, proofFiles, adapters) {
  const plan = await readScope(manifest, adapters);
  const slots = [];
  for (const expected of manifest.slots) {
    const file = files[expected.kind];
    const slot = plan.slots.find(item => item.id === expected.slotId);
    if (!Object.hasOwn(MIME, file?.type)) throw new Error(`请选择 ${KINDS[expected.kind]} 对应的 PNG、JPEG 或 WebP 文件。`);
    await verifyFile(file, expected.bytes, expected.sha256, KINDS[expected.kind]);
    slots.push({ expected, file,
      ...(expected.kind === "scene" ? await prepareScene(expected, slot, plan, proofFiles) : {}) });
  }
  return { manifest, plan, slots, proofFiles: [...proofFiles] };
}

function matchesMedia(asset, entry) {
  const { expected, file } = entry;
  return matches(ASSET, asset?.id) && asset.kind === "image" && asset.sha256 === expected.sha256 &&
    asset.size === expected.bytes && asset.mime === file.type && asset.width === expected.width && asset.height === expected.height;
}

function actualAiReview(asset) {
  const review = asset.review.aiApproval;
  return review?.schema === "pengmanager.ai-approval/v1" && review.kind === "editorial.media" &&
    review.decision === "approve" && review.subjectId === asset.id && review.snapshotHash === asset.sha256 &&
    typeof review.modelReceipt?.responseId === "string" && review.modelReceipt.responseId.length > 0 &&
    typeof review.modelReceipt.returnedModel === "string" && review.modelReceipt.returnedModel.length > 0;
}

function verifiedReview(asset, entry, plan) {
  if (!matchesMedia(asset, entry) || asset.status !== "reviewed" || asset.review?.sha256 !== asset.sha256 ||
      asset.review.rightsConfirmed !== true || asset.review.privacyConfirmed !== true ||
      asset.review.rightsNote !== entry.expected.rightsNote) return false;
  if (!entry.proofs) return !asset.review.verifiedSceneProvenance &&
    (entry.expected.assetId === asset.id || actualAiReview(asset));
  const provenance = asset.review.verifiedSceneProvenance;
  return actualAiReview(asset) &&
    provenance?.schema === "pengmanager.article-scene-provenance/v1" &&
    provenance.styleYear === plan.styleYear && provenance.planId === plan.id && provenance.slotId === entry.expected.slotId &&
    provenance.sourceHash === plan.sourceHash && provenance.storyId === plan.storyId &&
    provenance.output?.assetId === asset.id && provenance.output.sha256 === asset.sha256 &&
    provenance.output.bytes === asset.size && provenance.output.mime === asset.mime &&
    provenance.output.width === asset.width && provenance.output.height === asset.height &&
    provenance.compositor?.producerKeyId === entry.proofs.designerCompositor.producerKeyId &&
    provenance.imageGen?.producerKeyId === entry.proofs.imageGen.producerKeyId &&
    provenance.compositor?.receiptHash === entry.proofHashes.designerCompositor &&
    provenance.imageGen?.receiptHash === entry.proofHashes.imageGen &&
    provenance.imageGen.inputSha256 === entry.proofs.imageGen.statement.sha256;
}

const mediaPath = id => `/api/media/assets/${id}`;
const report = (entry, state, values = {}) => ({ slotId: entry.expected.slotId, kind: entry.expected.kind,
  sha256: entry.expected.sha256, state, ...values });

export async function submitEditorialBatchMedia(preview, adapters, onProgress = () => {}) {
  const { api, mutate } = adapters;
  const { manifest, slots } = preview;
  const plan = await readScope(manifest, adapters);
  if (plan.etag !== preview.plan.etag || plan.styleYear !== preview.plan.styleYear) throw new Error("配图计划已变化，请重新预览后提交。");
  const receipts = [];
  for (const entry of slots) {
    const { expected, file, proofs } = entry;
    const boundId = plan.slots.find(slot => slot.id === expected.slotId).evidence?.assetId;
    let assetId = boundId || expected.assetId;
    let result;
    try {
      onProgress(report(entry, "working", { assetId }));
      await verifyFile(file, expected.bytes, expected.sha256, KINDS[expected.kind]);
      if (!assetId) {
        const name = `${plan.id}-${expected.slotId}-${expected.sha256.slice(0, 12)}.${MIME[file.type]}`;
        const uploaded = await mutate("/api/media/assets", file, { bytes: true,
          headers: { "Content-Type": file.type, "X-Media-Name": encodeURIComponent(name), "X-Content-SHA256": expected.sha256 },
          idempotencyKey: `editorial-media-upload-${await hashValue([plan.id, expected.slotId, expected.sha256, file.type])}`, ...request() });
        if (!matchesMedia(uploaded, entry)) throw new Error("上传回执与所选准确字节、类型或尺寸不一致。");
        assetId = uploaded.id;
      }
      let asset = await api(mediaPath(assetId), recheck());
      if (asset?.id !== assetId || !matchesMedia(asset, entry)) throw new Error("后台素材回读与所选媒体不一致。");
      if (!verifiedReview(asset, entry, plan)) {
        if (boundId || expected.assetId || asset.status !== "staged") {
          throw new Error("已有素材的使用范围、审核或场景凭据与本清单不一致，请先核对素材详情。");
        }
        const body = { sha256: expected.sha256, rightsNote: expected.rightsNote, ...(proofs ? { articleSceneProofs: proofs } : {}) };
        await mutate(`${mediaPath(assetId)}/approve`, body, { etag: asset.etag, needsEtag: true,
          idempotencyKey: `editorial-media-review-${await hashValue([assetId, body])}`, ...request(REVIEW_TIMEOUT) });
        asset = await api(mediaPath(assetId), recheck());
        if (asset?.id !== assetId || !verifiedReview(asset, entry, plan)) throw new Error("后台复读未取得准确审核回执。");
      }
      const review = asset.review.aiApproval;
      result = report(entry, "reviewed", { assetId, modelResponseId: review?.modelReceipt?.responseId,
        model: review?.modelReceipt?.returnedModel, reviewedAt: asset.review.reviewedAt });
    } catch (error) {
      const pending = error.name === "TimeoutError" || ["AI_APPROVAL_PENDING", "AI_APPROVAL_PROVIDER_BALANCE",
        "AI_APPROVAL_PROVIDER_RATE_LIMIT", "AI_APPROVAL_REVIEW_UNRESOLVED"].includes(error.code);
      const findings = error.details?.aiReview?.findings;
      const issues = Array.isArray(findings) ? findings.filter(item => item?.status !== "pass").map(item => item?.reason).filter(Boolean) : [];
      result = report(entry, pending ? "pending" : "error", {
        assetId, message: [error.message, ...issues].filter(Boolean).join(" "), reviewId: error.details?.reviewId,
      });
    }
    receipts.push(result);
    onProgress(result);
    // Leave remaining material unsubmitted while this operation requires reconciliation.
    if (result.state !== "reviewed") break;
  }
  return receipts;
}

export function mountEditorialBatchMedia(root, { api, mutate, getBase, onReady }) {
  const adapters = { api, mutate, getBase };
  let preview = null, status = "", error = "", busy = false, receipts = [];
  const panel = () => root.querySelector("[data-editorial-batch-media]");
  const states = { working: "正在提交审核", reviewed: "已回读审核通过", pending: "待审核回读", error: "需要处理" };

  function results() {
    const progress = receipts.map(item => `<li>${html(KINDS[item.kind])} · ${html(states[item.state])}
      ${item.assetId ? `<code>${html(item.assetId)}</code>` : ""}
      ${item.model ? ` · ${html(item.model)}` : ""}${item.modelResponseId ? ` · ${html(item.modelResponseId)}` : ""}
      ${item.reviewId ? ` · 审核单 <code>${html(item.reviewId)}</code>` : ""}${item.message ? `<p>${html(item.message)}</p>` : ""}</li>`).join("");
    return `<p class="form-status" role="status" aria-live="polite">${html(status)}</p>
      <p class="form-error" role="alert"${error ? "" : " hidden"}>${html(error)}</p>
      ${preview ? `<p><strong>${html(preview.plan.title)}</strong> · ${html(preview.plan.id)} · ${html(preview.plan.baseReleaseId)}</p>
      <ol class="editorial-reference-list">${preview.slots.map(({ expected, file }) =>
        `<li><strong>${html(KINDS[expected.kind])} · ${html(expected.slotId)}</strong> · ${html(file.name)} · ${expected.width} × ${expected.height}
        <p><code>${html(expected.sha256)}</code></p><p>${html(expected.rightsNote)}</p>
        ${expected.proofs ? "<p>两份场景签章文件与清单一致，提交时由服务验证签名。</p>" : ""}</li>`).join("")}</ol>` : ""}
      ${progress ? `<ul class="editorial-reference-list">${progress}</ul>` : ""}`;
  }

  function refresh() {
    const current = panel();
    if (!current) return;
    current.setAttribute("aria-busy", String(busy));
    current.querySelector("[data-editorial-batch-media-result]").innerHTML = results();
    for (const input of current.querySelectorAll("input, button")) input.disabled = busy;
    current.querySelector("[data-editorial-batch-media-submit]").disabled = busy || !preview || receipts.length === 3 &&
      receipts.every(item => item.state === "reviewed");
  }

  root.addEventListener("change", event => {
    if (busy || !event.target.closest("[data-editorial-batch-media]")) return;
    preview = null; status = ""; error = ""; receipts = [];
    refresh();
  });

  root.addEventListener("submit", async event => {
    const form = event.target;
    if (!form.matches("[data-editorial-batch-media]")) return;
    event.preventDefault();
    if (busy) return;
    const submitting = event.submitter?.hasAttribute("data-editorial-batch-media-submit");
    if (submitting && !preview) return;
    busy = true; error = "";
    status = submitting ? "正在核对后台记录并提交当前文章的私有素材…" : "正在校验清单、三张图片及两份签章…";
    refresh();
    try {
      if (submitting) {
        const result = await submitEditorialBatchMedia(preview, adapters, row => {
          receipts = [...receipts.filter(item => item.slotId !== row.slotId), row];
          refresh();
        });
        receipts = result;
        status = result.every(row => row.state === "reviewed") ?
          "三个图位的素材已审核。可使用这些素材编号与原始回执，在该选题继续登记图位。" :
          "已保留可回读的素材。核对当前图位后，可提交同一批素材继续审核。";
        if (result.length === 3 && result.every(row => row.state === "reviewed") && onReady && await onReady(result, preview) === false) {
          error = "编辑工作台素材列表暂未刷新，可使用页面刷新按钮重新读取。";
        }
      } else {
        const file = form.elements.manifest.files[0];
        if (!file?.size || file.size > MANIFEST_LIMIT) throw new Error("请选择不超过 64 KiB 的素材清单。");
        const files = Object.fromEntries(Object.keys(KINDS).map(kind => [kind, form.elements[kind].files[0]]));
        preview = await previewEditorialBatchMedia(parseEditorialBatchMedia(await file.text()), files, [...form.elements.proofs.files], adapters);
        receipts = [];
        status = "请核对准确素材、使用范围和图位，再提交私有素材审核。";
      }
    } catch (failure) {
      error = failure.message || "素材操作未完成。";
      status = "";
    } finally {
      busy = false;
      refresh();
    }
  });

  return {
    markup(enabled) {
      if (!enabled) return "";
      const done = receipts.length === 3 && receipts.every(item => item.state === "reviewed");
      return `<details class="editorial-disclosure editorial-illustration-panel"${preview || busy ? " open" : ""}>
        <summary>准备单篇配图素材</summary>
        <form class="editorial-form editorial-illustration-body" data-editorial-batch-media aria-busy="${busy}">
          <label><span>单篇配图素材清单</span><input name="manifest" type="file" accept=".json,application/json" required${busy ? " disabled" : ""} /></label>
          <div class="editorial-grid">${Object.entries(KINDS).map(([kind, label]) =>
            `<label><span>${label}</span><input name="${kind}" type="file" accept="image/png,image/jpeg,image/webp" required${busy ? " disabled" : ""} /></label>`).join("")}</div>
          <label><span>Compositor 成品和 ImageGen 原图的两份 JSON 签章</span>
            <input name="proofs" type="file" accept=".json,application/json" multiple required${busy ? " disabled" : ""} /></label>
          <div data-editorial-batch-media-result>${results()}</div>
          <div class="editorial-inline-links"><button class="ghost-button" type="submit"${busy ? " disabled" : ""}>核对文件与计划</button>
          <button class="primary-button" type="submit" data-editorial-batch-media-submit formnovalidate${busy || !preview || done ? " disabled" : ""}>提交私有素材并审核</button></div>
        </form>
      </details>`;
    },
  };
}
