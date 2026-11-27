import { readArticleIllustrationProofs } from "./article-illustrations.js";
import { parseEditorialBatchMedia } from "./editorial-batch-media.js";
import { escapeHtml as html } from "./publication-view.js";

const HASH = /^[a-f0-9]{64}$/u;
const ASSET = /^MED-[a-f0-9]{32}$/u;
const EDITION = /^ED-\d{5,}$/u;
const format = "article";
const names = { architecture: "架构图", logic: "逻辑图", scene: "场景图" };
const copyFields = ["locale", "format", "title", "summary", "body", "blocks", "claimIds", "claimBindings", "assetRefs"];
const timeout = () => ({ signal: AbortSignal.timeout(30_000), cache: "no-store" });
const pathId = encodeURIComponent;
const assetPath = id => `/api/media/assets/${pathId(id)}`;
const storyPath = id => `/api/stories/${pathId(id)}`;

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function pick(source, keys) {
  return Object.fromEntries(keys.map(key => [key, source[key]]));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const same = (left, right) => canonical(left) === canonical(right);

async function digest(bytes) {
  require(globalThis.crypto?.subtle, "请在 HTTPS 管理后台校验精确素材。");
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

const digestValue = value => digest(new TextEncoder().encode(canonical(value)));

async function readImage(asset, getBytes = fetch) {
  const response = await getBytes(`${assetPath(asset.id)}/bytes`, { ...timeout(), credentials: "same-origin", redirect: "error" });
  const length = response.headers.get("Content-Length");
  require(response.ok && response.body && response.headers.get("Content-Type")?.split(";")[0] === asset.mime &&
    (length === null || Number(length) === asset.size), "私有素材的字节响应、类型或长度已变化。");
  const reader = response.body.getReader();
  const actual = new Uint8Array(asset.size);
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.length > actual.length - offset) {
        await reader.cancel();
        throw new Error("私有素材响应超过已审核的长度。");
      }
      actual.set(chunk.value, offset);
      offset += chunk.value.length;
    }
  } finally {
    reader.releaseLock();
  }
  require(offset === actual.length && await digest(actual) === asset.sha256, "实际读取的私有素材与 AI 已审核字节不一致。");
}

function verifiedAiMedia(asset, expected, id) {
  const review = asset?.review;
  const ai = review?.aiApproval;
  require(asset?.id === id && asset.kind === "image" && asset.status === "reviewed" &&
    asset.sha256 === expected.sha256 && asset.size === expected.bytes && asset.width === expected.width &&
    asset.height === expected.height && ["image/png", "image/jpeg", "image/webp"].includes(asset.mime) &&
    (expected.assetId === undefined || expected.assetId === id) && review?.sha256 === asset.sha256 &&
    review.rightsConfirmed === true && review.privacyConfirmed === true && review.rightsNote === expected.rightsNote &&
    ai?.schema === "pengmanager.ai-approval/v1" && ai.kind === "editorial.media" && ai.actor === "ai-reviewer" &&
    ai.decision === "approve" && ai.subjectId === id && ai.snapshotHash === asset.sha256 &&
    HASH.test(ai.evidenceHash ?? "") && typeof ai.modelReceipt?.responseId === "string" &&
    ai.modelReceipt.responseId.length > 0 && typeof ai.modelReceipt.returnedModel === "string" && ai.modelReceipt.returnedModel.length > 0,
  `${names[expected.kind]}没有当前字节、用途和隐私对应的完整 AI 审核回执。`);
}

function proofForSlot(proof, source, plan, slot) {
  const statement = proof?.statement;
  require(statement?.source === source && statement.planId === plan.id && statement.slotId === slot.id &&
    statement.sourceHash === plan.sourceHash && HASH.test(statement.sha256 ?? "") &&
    /^pk-[a-f0-9]{32}$/u.test(proof.producerKeyId ?? "") && /^[A-Za-z0-9_-]{86}$/u.test(proof.signature ?? ""),
  "回执的生产来源、签章、计划或图位与本行不一致。");
  return statement;
}

async function sceneProofs(input, expected, plan, slot, asset) {
  let proofs = input.proofs;
  if (input.proofFiles.length) {
    require(input.proofFiles.length === 2, "请选择两份原始场景签章。");
    const files = input.proofFiles;
    proofs = await readArticleIllustrationProofs(files);
    const [first, second] = await Promise.all(files.map(async file => ({ source: JSON.parse(await file.text()).statement?.source,
      digest: await digest(await file.arrayBuffer()) })));
    const hashes = Object.fromEntries([first, second].map(file => [file.source, file.digest]));
    require(hashes["pengmanager-designer-compositor"] === expected.proofs.designerCompositorSha256 &&
      hashes["codex-imagegen"] === expected.proofs.imageGenSha256, "原始签章文件的 SHA-256 与清单不一致。");
  }
  const compositor = proofForSlot(proofs?.designerCompositor, "pengmanager-designer-compositor", plan, slot);
  const generated = proofForSlot(proofs?.imageGen, "codex-imagegen", plan, slot);
  const provenance = asset.review.verifiedSceneProvenance;
  require(generated.styleYear === plan.styleYear && provenance?.styleYear === plan.styleYear &&
    compositor.approvalAuthority === "ai" && compositor.sceneBriefHash === slot.sceneBriefHash &&
    compositor.imageGenInputSha256 === generated.sha256 && compositor.sha256 === asset.sha256 &&
    compositor.bytes === asset.size && compositor.width === asset.width && compositor.height === asset.height &&
    provenance?.schema === "pengmanager.article-scene-provenance/v1" && provenance.storyId === plan.storyId &&
    provenance.planId === plan.id && provenance.slotId === slot.id && provenance.sourceHash === plan.sourceHash &&
    provenance.sceneBriefHash === slot.sceneBriefHash && provenance.output?.assetId === asset.id &&
    provenance.output.sha256 === asset.sha256 && provenance.output.bytes === asset.size && provenance.output.mime === asset.mime &&
    provenance.output.width === asset.width && provenance.output.height === asset.height &&
    provenance.compositor?.approvalAuthority === "ai" &&
    provenance.compositor.producerKeyId === proofs.designerCompositor.producerKeyId &&
    provenance.imageGen?.producerKeyId === proofs.imageGen.producerKeyId && provenance.imageGen.inputSha256 === generated.sha256 &&
    provenance.compositor.receiptHash === await digestValue(proofs.designerCompositor) &&
    provenance.imageGen.receiptHash === await digestValue(proofs.imageGen),
  "已有场景媒体审核没有绑定这两份原始签章或准确成品。");
  return proofs;
}

function planShape(plan) {
  const fields = ["id", "kind", "anchor", "description", "alt", "caption", "imageGeneration"];
  return { ...pick(plan, ["schema", "id", "baseReleaseId", "storyId", "sourceHash", "locale", "title", "articleType"]),
    ...(plan.styleYear === undefined ? {} : { styleYear: plan.styleYear }),
    slots: plan.slots.map(slot => ({ ...pick(slot, fields), ...(slot.kind === "scene" ? { sceneBriefHash: slot.sceneBriefHash } : {}) })) };
}

function matchesBound(evidence, body) {
  return evidence?.assetId === body.assetId && evidence.sha256 === body.sha256 && HASH.test(evidence.visualFingerprint ?? "") &&
    same(evidence.designerCompositor, body.designerCompositor) && same(evidence.imageGen, body.imageGen);
}

function activePublicData(live, base) {
  const original = base.publicSnapshot;
  return live?.id === base.id && live.releaseId === base.id && live.snapshotHash === base.snapshotHash &&
    live.canonicalPath === base.canonicalPath && live.canonicalUrl === original.canonicalUrl &&
    same(pick(live, ["locale", "format", "title", "summary", "body", "blocks"]), pick(original, ["locale", "format", "title", "summary", "body", "blocks"])) &&
    same(live.sources?.map(source => source.id), original.claimIds) &&
    same(live.assets?.map(asset => pick(asset, ["assetId", "sha256", "role", "alt", "caption", "locale"])), original.assetRefs);
}

function planPath(manifest) {
  return `${storyPath(manifest.storyId)}/illustrations/${pathId(manifest.planId)}`;
}

async function checkedScope(input, { api, getBase, getBytes }, { readBytes = true } = {}) {
  const { manifest } = input;
  const registered = getBase(manifest.storyId, manifest.baseReleaseId);
  require(registered?.id === manifest.baseReleaseId && registered.storyId === manifest.storyId &&
    registered.status === "published" && HASH.test(registered.snapshotHash ?? ""), "原稿已离开当前可以补图的范围。");
  const [base, story, plan] = await Promise.all([
    api(`/api/website/releases/${pathId(manifest.baseReleaseId)}`, timeout()),
    api(storyPath(manifest.storyId), timeout()),
    api(planPath(manifest), timeout()),
  ]);
  const original = base?.publicSnapshot;
  const { receiptHash, ...receipt } = base?.receipt ?? {};
  require(base?.id === registered.id && base.storyId === manifest.storyId && base.status === "published" &&
    base.snapshotHash === registered.snapshotHash && base.publicApproval?.snapshotHash === base.snapshotHash &&
    registered.canonicalPath === base.canonicalPath &&
    original?.format === format && ["zh-CN", "en-US"].includes(original.locale) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(base.slug ?? "") &&
    receipt.releaseId === base.id && receipt.snapshotHash === base.snapshotHash && receipt.canonicalUrl === original.canonicalUrl &&
    receipt.verificationMethod === "server_readback" && receipt.dataMode === "real" &&
    receiptHash === await digestValue(receipt) && base.snapshotHash === await digestValue(original),
  "原发布记录没有匹配的服务器真实回读或正文快照。");
  const livePath = `/public-api/content/${pathId(original.locale)}/article/${pathId(base.slug)}`;
  require(activePublicData(await api(livePath, timeout()), base), "原官网地址或公开正文已变化，请核对当前发布。");
  require(story?.id === manifest.storyId && story.status !== "archived" && story.etag && Array.isArray(story.editions) &&
    story.editions.some(edition => edition.id === base.editionId), "未找到仍可写入的准确选题与原母版。");
  require(plan?.id === manifest.planId && plan.storyId === story.id && plan.baseReleaseId === base.id &&
    plan.schema === "pengmanager.article-illustrations/v1" && plan.sourceHash === manifest.sourceHash &&
    plan.locale === original.locale && plan.title === original.title && plan.etag &&
    [true, false].includes(plan.frozen) && Array.isArray(plan.slots) && plan.slots.length === 3 &&
    plan.sourceHash === await digestValue(pick(original, ["locale", "title", "summary", "body"])),
  "配图计划没有绑定当前准确原稿。");
  if (input.plan) require(same(planShape(plan), planShape(input.plan)), "核对后的计划图位或文字已变化。");
  const entries = [];
  for (const slot of plan.slots) {
    const expected = manifest.slots.find(item => item.slotId === slot.id);
    const id = expected && input.assetIds[expected.kind];
    require(expected?.kind === slot.kind && ASSET.test(id ?? "") && slot.imageGeneration === (slot.kind === "scene"),
      "素材清单没有匹配当前计划的三个准确图位。");
    const asset = await api(assetPath(id), timeout());
    verifiedAiMedia(asset, expected, id);
    require(slot.kind === "scene" || !asset.review.verifiedSceneProvenance, "静态图不能借用已审场景素材。");
    const proofs = slot.kind === "scene" ? await sceneProofs(input, expected, plan, slot, asset) : {};
    const body = { slotId: slot.id, assetId: id, sha256: asset.sha256, ...proofs };
    require(!slot.evidence || matchesBound(slot.evidence, body), "已有图位绑定与当前这份审核素材或签章不同，已保留原绑定。");
    if (readBytes) await readImage(asset, getBytes);
    entries.push({ asset, body });
  }
  require(new Set(entries.map(entry => entry.asset.id)).size === 3, "三个图位须分别使用三个审核素材。");
  const family = story.editions.filter(edition => edition.storyId === story.id && edition.locale === original.locale && edition.format === format)
    .sort((a, b) => b.editorialRevision - a.editorialRevision);
  const existing = family.filter(edition => edition.illustrationPlanId === plan.id);
  require(existing.length <= 1 && (!existing.length || existing[0].id === family[0]?.id) && plan.frozen === Boolean(existing.length),
    "该计划已冻结到其他修订或当前最新母版已变化。");
  return { base, story, plan, entries, latest: family[0], existing: existing[0] };
}

function preparedPlan(plan, entries) {
  return { ...plan, isComplete: true,
    slots: plan.slots.map((slot, i) => ({ ...slot, evidence: slot.evidence ?? entries[i].body })) };
}

function editionInput(scope, buildEdition) {
  const previousEditions = scope.story.editions.filter(edition => edition.id !== scope.existing?.id);
  return buildEdition(scope.base, previousEditions, preparedPlan(scope.plan, scope.entries), scope.entries.map(row => row.asset));
}

async function readEdition(current, input, adapters) {
  const { existing, plan, base } = current;
  require(EDITION.test(existing?.id ?? "") && current.latest?.id === existing.id && plan.frozen && plan.isComplete &&
    plan.slots.every((slot, i) => matchesBound(slot.evidence, current.entries[i].body)),
  "没有读回冻结在当前三个图位上的最新私有母版。");
  const row = await adapters.api(`/api/editions/${pathId(existing.id)}`, timeout());
  const planSlots = plan.slots.map(({ sceneBriefHash, ...storedSlot }) => storedSlot);
  const planHash = await digestValue({ ...pick(plan, ["schema", "id", "storyId", "locale", "sourceHash", "articleType", "baseReleaseId"]),
    slots: planSlots, ...(plan.styleYear === undefined ? {} : { styleYear: plan.styleYear }) });
  const exact = { ...pick(input, ["locale", "format", "title", "summary", "body", "blocks", "claimIds"]),
    claimBindings: base.publicSnapshot.claimBindings, assetRefs: input.assetRefs.map(ref => ({ ...ref, locale: ref.locale ?? input.locale })) };
  const snapshot = { schema: "pengmanager.editorial-snapshot/v2",
    ...pick(row, ["id", "familyId", "storyId", "editorialRevision", "sourceEditionId", "supersedesEditionId",
      ...copyFields, "illustrationPlanId", "illustrationPlanHash"]) };
  const originalEdition = current.story.editions.find(edition => edition.id === base.editionId);
  require(row?.id === existing.id && row.snapshotHash === existing.snapshotHash && row.etag &&
    row.storyId === current.story.id && row.snapshotSchema === snapshot.schema && row.illustrationPlanId === plan.id &&
    row.illustrationPlanHash === planHash && row.sourceEditionId === (originalEdition.sourceEditionId ?? null) &&
    row.supersedesEditionId === (input.supersedesEditionId ?? null) &&
    same(pick(row, copyFields), exact) && row.snapshotHash === await digestValue(snapshot),
  "私有母版读回中的原正文、原事实、图位、来源或快照摘要与本次操作不同。");
  return row;
}

const approvalBasis = current => current.entries.map(({ asset, body }) => ({ body, review: asset.review }));

export async function previewEditorialBatchEdition(input, adapters) {
  const scope = await checkedScope(input, adapters);
  const payload = editionInput(scope, adapters.buildEdition);
  const existing = scope.existing ? await readEdition(scope, payload, adapters) : null;
  return { input, scope, payload, existing };
}

function equivalentScope(current, before) {
  return current.base.snapshotHash === before.base.snapshotHash && same(planShape(current.plan), planShape(before.plan)) &&
    same(approvalBasis(current), approvalBasis(before));
}

export async function saveEditorialBatchEdition(prepared, adapters) {
  const { api, mutate, buildEdition } = adapters;
  const { input, scope, payload } = prepared;
  let current = await checkedScope(input, adapters);
  require(equivalentScope(current, scope), "核对后的公开原稿、图位、权利凭据或素材审核已变化，请重新预览。");
  if (current.existing) return readEdition(current, payload, adapters);
  require(current.latest?.id === scope.latest?.id, "当前最新母版已变化，请重新预览后再保存。");
  const planUrl = planPath(input.manifest);
  let plan = current.plan;
  for (const { body } of current.entries) {
    const old = plan.slots.find(slot => slot.id === body.slotId);
    if (matchesBound(old.evidence, body)) continue;
    require(!old.evidence && plan.frozen === false, "计划或图位已经变化，已保留其原记录。");
    let failure;
    try {
      await mutate(`${planUrl}/evidence`, body, { etag: plan.etag, needsEtag: true,
        idempotencyKey: `edition-illustration-bind-${await digestValue([plan.id, body])}`, ...timeout() });
    } catch (error) {
      failure = error;
    }
    plan = await api(planUrl, timeout());
    require(plan?.etag && same(planShape(plan), planShape(scope.plan)), "绑定期间配图计划已变化。");
    if (!matchesBound(plan.slots.find(slot => slot.id === body.slotId)?.evidence, body)) {
      if (failure) throw failure;
      throw new Error("没有从服务器读回这个准确图位绑定。");
    }
  }
  current = await checkedScope(input, adapters, { readBytes: false });
  require(equivalentScope(current, scope), "绑定后原稿、计划或素材审核已变化，请重新预览。");
  if (current.existing) return readEdition(current, payload, adapters);
  const exactPayload = editionInput(current, buildEdition);
  require(current.plan.isComplete && current.latest?.id === scope.latest?.id && same(exactPayload, payload),
    "绑定后候选内容或最新母版已变化，请重新预览。");
  let saved, failure;
  try {
    saved = await mutate(`${storyPath(current.story.id)}/editions`, exactPayload, { etag: current.story.etag, needsEtag: true,
      idempotencyKey: `edition-illustration-save-${await digestValue([current.plan.id, exactPayload])}`, ...timeout() });
  } catch (error) {
    failure = error;
  }
  current = await checkedScope(input, adapters, { readBytes: false });
  require(equivalentScope(current, scope), "保存后原稿、计划或素材审核已变化，请重新核对。");
  if (!current.existing && failure) throw failure;
  require(!saved || saved.id === current.existing?.id, "写入回执与当前冻结的母版不一致。");
  return readEdition(current, payload, adapters);
}

function offeredInput(receipts, preview) {
  require(receipts?.length === 3 && receipts.every(item => item.state === "reviewed"), "须先取得三份已审核媒体回执。");
  const scene = preview.slots.find(slot => slot.expected.kind === "scene");
  return { manifest: structuredClone(preview.manifest), plan: structuredClone(preview.plan),
    assetIds: Object.fromEntries(receipts.map(item => [item.kind, item.assetId])),
    proofs: structuredClone(scene?.proofs), proofFiles: [...(preview.proofFiles ?? [])] };
}

export function mountEditorialBatchEdition(root, { api, mutate, getBase, buildEdition, onSaved }) {
  const adapters = { api, mutate, getBase, buildEdition };
  let offered = null, preview = null, busy = false, status = "", error = "";
  const panel = () => root.querySelector("[data-editorial-batch-edition]");
  const done = () => Boolean(preview?.existing);

  function result() {
    return `<p class="form-status" role="status" aria-live="polite">${html(status)}</p><p class="form-error" role="alert"${error ? "" : " hidden"}>${html(error)}</p>
      ${offered && !preview ? `<p>${html(offered.manifest.storyId)} · ${html(offered.manifest.planId)} · ${html(offered.manifest.baseReleaseId)}</p>` : ""}
      ${preview ? `<p><strong>${html(preview.scope.base.publicSnapshot.title)}</strong> · ${html(preview.scope.plan.id)} · ${html(preview.scope.base.id)}</p>
      <ol class="editorial-reference-list">${preview.scope.plan.slots.map((slot, i) => {
        const { asset } = preview.scope.entries[i];
        return `<li>${html(names[slot.kind])} · <code>${html(asset.id)}</code><p>${html(slot.anchor)}</p><code>${html(asset.sha256)}</code></li>`;
      }).join("")}</ol>${preview.existing ? `<p>已读回私有母版 <code>${html(preview.existing.id)}</code> · <code>${html(preview.existing.snapshotHash)}</code></p>` : ""}` : ""}`;
  }

  function refresh() {
    const form = panel();
    if (!form) return;
    form.setAttribute("aria-busy", String(busy));
    form.querySelector("[data-batch-edition-result]").innerHTML = result();
    for (const input of form.querySelectorAll("input, button")) input.disabled = busy;
    form.elements.confirm.disabled = busy || !preview || done();
    form.querySelector("[data-batch-edition-save]").disabled = busy || !preview || done() || !form.elements.confirm.checked;
  }

  root.addEventListener("change", event => {
    const form = event.target.closest("[data-editorial-batch-edition]");
    if (busy || !form) return;
    if (event.target.name !== "confirm") {
      offered = null; preview = null; status = ""; error = ""; form.elements.confirm.checked = false;
    }
    refresh();
  });

  root.addEventListener("submit", async event => {
    const form = event.target;
    if (!form.matches("[data-editorial-batch-edition]")) return;
    event.preventDefault();
    if (busy) return;
    const saving = event.submitter?.hasAttribute("data-batch-edition-save");
    if (saving && (!preview || done() || !form.elements.confirm.checked)) return;
    busy = true; error = "";
    status = saving ? "正在重新核对图位并保存私有母版…" : "正在读取当前原稿、已审素材和精确图位…";
    refresh();
    try {
      if (saving) {
        const edition = await saveEditorialBatchEdition(preview, adapters);
        preview = { ...preview, existing: edition };
        status = "已核对最新私有母版。";
        if (onSaved && await onSaved(edition, preview.scope) === false) status += "选题列表暂未刷新。";
      } else {
        const selected = form.elements.manifest.files[0];
        require(offered || selected?.size && selected.size <= 65_536, "请选择有效的原单篇素材清单。");
        const input = offered ?? { manifest: parseEditorialBatchMedia(await selected.text()),
          assetIds: Object.fromEntries(Object.keys(names).map(kind => [kind, form.elements[kind].value.trim()])),
          proofFiles: [...form.elements.proofs.files] };
        preview = await previewEditorialBatchEdition(input, adapters);
        status = preview.existing ? "已读回同一份私有母版。" : "请核对三个图位及对应素材后确认保存。";
        if (preview.existing && onSaved && await onSaved(preview.existing, preview.scope) === false) status += "选题列表暂未刷新。";
      }
    } catch (failure) {
      error = failure.message || "未能读回已绑定的私有母版。";
      status = "";
    } finally {
      busy = false;
      if (panel()) panel().elements.confirm.checked = false;
      refresh();
    }
  });

  return {
    offer(receipts, mediaPreview) {
      if (busy) return;
      offered = offeredInput(receipts, mediaPreview);
      preview = null; error = ""; status = "三份媒体回执已带入，可核对本篇私有母版。";
      if (panel()) panel().closest("details").open = true;
      refresh();
    },
    markup(enabled) {
      if (!enabled) return "";
      return `<details class="editorial-disclosure editorial-illustration-panel"${offered || preview || busy ? " open" : ""}>
        <summary>绑定三张已审图并保存私有母版</summary>
        <form class="editorial-form editorial-illustration-body" data-editorial-batch-edition aria-busy="${busy}">
          <details class="editorial-disclosure"><summary>按清单及素材编号恢复</summary>
            <label><span>原单篇素材清单</span><input name="manifest" type="file" accept=".json,application/json" /></label>
            <div class="editorial-grid">${Object.entries(names).map(([kind, name]) =>
              `<label><span>${html(name)}审核素材编号</span><input name="${kind}" maxlength="36" spellcheck="false" autocomplete="off" /></label>`).join("")}</div>
            <label><span>两份原始场景签章</span><input name="proofs" type="file" accept=".json,application/json" multiple /></label>
          </details>
          <div data-batch-edition-result>${result()}</div>
          <label class="check-label"><input name="confirm" type="checkbox"${busy || !preview || done() ? " disabled" : ""} />
            <span>核对三个准确图位并授权保存本篇私有母版。</span></label>
          <div class="editorial-inline-links"><button class="ghost-button" type="submit"${busy ? " disabled" : ""}>核对私有母版</button>
            <button class="primary-button" type="submit" data-batch-edition-save disabled>绑定并保存私有母版</button></div>
        </form>
      </details>`;
    },
  };
}
