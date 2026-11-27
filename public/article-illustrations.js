import { escapeHtml as html } from "./publication-view.js";
import { articleIllustrationImageGenPrompt, articleIllustrationWorkOrder } from "./article-illustration-work-order.js";

const TYPES = { technical: "技术文章", product: "产品文章", lifestyle: "生活分享" };
const KINDS = { architecture: "架构图", logic: "逻辑图", scene: "场景图" };
const PROOF_FIELDS = { "pengmanager-designer-compositor": "designerCompositor", "codex-imagegen": "imageGen" };
const draftKinds = type => type === "lifestyle" ? ["scene", "scene", "scene"] : ["architecture", "logic", "scene"];
const MAX_SLOTS = 64;
const field = (scope, name) => scope.querySelector(`[name="${name}"]`);
const value = (scope, name) => field(scope, name)?.value || "";
const options = (rows, selected) => rows.map(([id, label]) =>
  `<option value="${html(id)}"${id === selected ? " selected" : ""}>${html(label)}</option>`).join("");

function slotFields(slot = {}, index) {
  return `<fieldset class="editorial-grid editorial-illustration-slot" data-illustration-slot>
    <legend>第 ${index + 1} 张配图</legend>
    <label><span>图片类型</span><select name="ill-kind-${index}" data-illustration-entry="kind">${options(Object.entries(KINDS), slot.kind)}</select></label>
    <label class="wide"><span>配图位置（正文中的唯一短语）</span><input name="ill-anchor-${index}" data-illustration-entry="anchor" maxlength="300" value="${html(slot.anchor || "")}" /></label>
    <label class="wide"><span>画面内容及要说明的问题</span><textarea name="ill-description-${index}" data-illustration-entry="description" rows="2" maxlength="1000">${html(slot.description || "")}</textarea></label>
    <label><span>替代文字</span><input name="ill-alt-${index}" data-illustration-entry="alt" maxlength="500" value="${html(slot.alt || "")}" /></label>
    <label><span>图注（可选）</span><input name="ill-caption-${index}" data-illustration-entry="caption" maxlength="500" value="${html(slot.caption || "")}" /></label>
    <label class="check-label wide"><input type="checkbox" name="ill-image-generation-${index}" data-illustration-entry="imageGeneration"${slot.imageGeneration ? " checked" : ""} /><span>需要使用内置生图工具生成原始素材</span></label>
  </fieldset>`;
}

function readSlots(panel) {
  return [...panel.querySelectorAll("[data-illustration-slot]")].map(slot =>
    Object.fromEntries([...slot.querySelectorAll("[data-illustration-entry]")].map(control => [
      control.dataset.illustrationEntry,
      control.type === "checkbox" ? control.checked : control.value.trim(),
    ])));
}

function articleSource(form, copyBase) {
  const source = Object.fromEntries(["locale", "title", "summary", "body"].map(name => [
    name, copyBase ? copyBase.publicSnapshot[name] : value(form, name),
  ]));
  if (!source.title.trim() || !source.body.trim()) throw new Error("先填写完整标题和正文，再制定配图计划。");
  return source;
}

function planStatus(plan) {
  if (plan.frozen) return "已绑定版本";
  return plan.isComplete ? "配图回执齐全" : "待补素材与回执";
}

function planChoice(plan) {
  return `${plan.title || plan.id} · ${TYPES[plan.articleType] || plan.articleType} · ${planStatus(plan)} · ${plan.id}`;
}

function plainText(block) {
  const text = block?.type === "list" && Array.isArray(block.items) ? block.items.join(" ") : block?.text;
  return typeof text === "string" ? text.replace(/\s+/gu, " ").trim() : "";
}

export async function readArticleIllustrationProofs(files) {
  const result = {};
  if (files.length > 2) throw new Error("每个图位最多需要两份回执，分别来自 Compositor 和内置生图工具。");
  for (const file of files) {
    if (file.size > 65_536) throw new Error("配图回执文件超过 64 KiB。");
    let receipt;
    try { receipt = JSON.parse(await file.text()); }
    catch { throw new Error("配图回执不是有效的 JSON 文件。"); }
    const key = Object.hasOwn(PROOF_FIELDS, receipt?.statement?.source) ? PROOF_FIELDS[receipt.statement.source] : null;
    if (!key || result[key] || typeof receipt.signature !== "string" || typeof receipt.producerKeyId !== "string") {
      throw new Error("请选择不同工具签发的原始回执文件，每种工具保留一份。");
    }
    result[key] = receipt;
  }
  return result;
}

export function placeArticleIllustrations(blocks, references, plan, assets) {
  if (plan.isComplete !== true || !Array.isArray(plan.slots) || plan.slots.length < 3) {
    throw new Error("请先完成至少三张配图，上传审核后的文件并核对对应回执。");
  }
  const positions = new Map();
  const planned = new Set();
  const hashes = new Set();
  for (const slot of plan.slots) {
    const evidence = slot.evidence;
    const asset = assets.find(row => row.id === evidence?.assetId);
    if (!asset || asset.kind !== "image" || asset.status !== "reviewed" || asset.sha256 !== evidence.sha256
        || planned.has(asset.id) || hashes.has(asset.sha256)) {
      throw new Error("配图字节、审核状态或回执发生变化，请刷新素材并核对每张图。");
    }
    const matches = blocks.flatMap((block, position) => {
      const text = plainText(block);
      return slot.anchor && text.includes(slot.anchor) ? [position] : [];
    });
    if (matches.length !== 1) throw new Error(`配图位置“${slot.anchor || "未填写"}”须出现在一个明确的正文块中。`);
    const position = matches[0];
    const images = positions.get(position) || [];
    images.push({ type: "image", assetId: asset.id, alt: slot.alt, caption: slot.caption });
    positions.set(position, images);
    planned.add(asset.id);
    hashes.add(asset.sha256);
  }
  const placed = blocks.flatMap((block, position) => [
    ...((block.type === "image" && planned.has(block.assetId)) ? [] : [block]),
    ...(positions.get(position) || []),
  ]);
  const plannedRefs = placed.filter(block => block.type === "image" && planned.has(block.assetId)).map(block => ({
    assetId: block.assetId,
    sha256: assets.find(asset => asset.id === block.assetId).sha256,
    role: "image",
    alt: block.alt,
    caption: block.caption,
  }));
  return { blocks: placed, references: [...references.filter(ref => !planned.has(ref.assetId)), ...plannedRefs] };
}

export function createArticleIllustrationControls(root, { api, mutate, getAssets, getCopyBase = () => null }) {
  const records = new Map();
  const selections = new Map();
  const slotCounts = new Map();
  const pathFor = form => `/api/stories/${encodeURIComponent(form.dataset.entityId)}/illustrations`;
  const recordFor = form => records.get(form.dataset.entityId) || [];
  const baseFor = form => form.dataset.illustrationBaseReleaseId || "";
  const selectionKey = (storyId, baseReleaseId) => `${storyId}:${baseReleaseId}`;
  const keyFor = form => selectionKey(form.dataset.entityId, baseFor(form));
  const plansFor = (storyId, baseReleaseId) => (records.get(storyId) || [])
    .filter(plan => (plan.baseReleaseId || "") === baseReleaseId);
  const selectedPlan = form => plansFor(form.dataset.entityId, baseFor(form))
    .find(plan => plan.id === value(form, "illustrationPlanId"));

  function markup(storyId, baseReleaseId = "") {
    const key = selectionKey(storyId, baseReleaseId);
    const plans = plansFor(storyId, baseReleaseId);
    const selected = selections.get(key) || "";
    const kinds = draftKinds("technical");
    const count = slotCounts.get(key) || kinds.length;
    return `<details class="editorial-disclosure" data-article-illustrations>
      <summary>制定文章配图计划与核对出处</summary>
      <div class="editorial-illustration-body">
      <p class="operation-note">技术、产品文章需要架构图、逻辑图和场景图。生活分享使用能对应正文的至少三张场景图。</p>
      <div class="editorial-inline-links">
        <button type="button" class="ghost-button" data-illustration-action="suggest">按正文识别类型并建议图位</button>
        <button type="button" class="ghost-button" data-illustration-action="load">读取此选题已有计划</button>
      </div>
      <p class="operation-field-hint" data-illustration-reasons></p>
      <label><span>文章类型，可按正文修正</span><select name="illustrationArticleType">${options(Object.entries(TYPES), "technical")}</select></label>
      <div data-illustration-slots>${Array.from({ length: count }, (_, index) => slotFields({ kind: kinds[index] || "scene" }, index)).join("")}</div>
      <div class="editorial-inline-links">
        <button type="button" class="ghost-button" data-illustration-action="add">增加一张配图</button>
        <button type="button" class="ghost-button" data-illustration-action="save">保存准确正文的配图计划</button>
      </div>
      <label><span>绑定这篇正文的配图计划</span><select name="illustrationPlanId">
        <option value="">${baseReleaseId ? "请选择与原公开版本匹配的配图计划" : "暂不绑定，继续准备草稿"}</option>
        ${options(plans.map(plan => [plan.id, planChoice(plan)]), selected)}
      </select></label>
      <div data-illustration-evidence></div>
      <details class="editorial-disclosure" data-illustration-issuer>
        <summary>登记本机配图回执公钥</summary>
        <div class="editorial-illustration-body">
        <label><span>签发工作站名称</span><input name="illustrationProducerLabel" maxlength="120" /></label>
        <label><span>由本机配图工具导出的公开密钥</span><textarea name="illustrationProducerKey" rows="3" maxlength="1024" spellcheck="false"></textarea></label>
        <button type="button" class="ghost-button" data-illustration-action="register">登记本机回执公钥</button>
        </div>
      </details>
      <p class="form-error" role="alert" data-illustration-error hidden></p>
      <p class="form-status" role="status" data-illustration-status></p>
      </div>
    </details>`;
  }

  function refreshEvidence(form) {
    const output = form.querySelector("[data-illustration-evidence]");
    const plan = selectedPlan(form);
    if (!output) return;
    if (!plan) {
      output.innerHTML = "";
      return;
    }
    const completed = plan.slots.filter(slot => slot.evidence).length;
    const reviewed = getAssets().filter(asset => asset.status === "reviewed" && asset.kind === "image");
    output.innerHTML = `<h4>配图回执 ${completed}/${plan.slots.length}</h4>
      ${plan.styleYear === undefined ? "" : `<p>本计划必须采用 ${html(plan.styleYear)} 年起的当代风格。各类图片的要求随工单提供。</p>`}
      <ol class="editorial-reference-list">${plan.slots.map(slot => `<li>
        <strong>${html(KINDS[slot.kind])} · ${html(slot.anchor)}</strong>
        <p>${html(slot.description)}${slot.kind === "scene" ? "<br />由鹏经理设计师与本机 Compositor 完成。" : ""}${slot.imageGeneration ? "<br />原始素材由内置生图工具生成。" : ""}</p>
        ${slot.evidence ? `<p>已核对 ${html(slot.evidence.assetId)} · <code>${html(slot.evidence.sha256)}</code></p>` : ""}
        ${!plan.frozen ? `<button type="button" class="ghost-button" data-illustration-action="download" data-slot-id="${html(slot.id)}">下载配图工作单</button>` : ""}
        ${!plan.frozen && slot.imageGeneration ? `<button type="button" class="ghost-button" data-illustration-action="prompt" data-slot-id="${html(slot.id)}">复制内置生图提示</button>` : ""}
      </li>`).join("")}</ol>
      ${plan.frozen ? "" : `<fieldset class="editorial-grid" data-illustration-attachment>
        <legend>核对一张已经完成的图</legend>
        <label><span>待核对图位</span><select name="illustrationEvidenceSlot">${options([...plan.slots.filter(slot => !slot.evidence), ...plan.slots.filter(slot => slot.evidence)].map(slot => [slot.id, `${KINDS[slot.kind]} · ${slot.anchor}${slot.evidence ? "（已绑定）" : ""}`]))}</select></label>
        <label><span>已上传并审核的实际图片</span><select name="illustrationEvidenceAsset">
          <option value="">${reviewed.length ? "选择实际图片" : "请先在媒体素材中上传及审核图片"}</option>
          ${options(reviewed.map(asset => [asset.id, `${asset.name || asset.id} · ${asset.id}`]))}
        </select></label>
        <label class="wide"><span>工具签发的 JSON 回执（组合制作时导入两份）</span><input type="file" name="illustrationEvidenceFile" accept=".json,application/json" multiple /></label>
        <button type="button" class="ghost-button" data-illustration-action="evidence"${reviewed.length ? "" : " disabled"}>核对并绑定这张图</button>
      </fieldset>`}`;
  }

  function syncEdition(form) {
    const panel = form.querySelector("[data-article-illustrations]");
    if (!panel) return;
    panel.hidden = value(form, "format") !== "article";
    const select = field(form, "illustrationPlanId");
    if (!select) return;
    const baseReleaseId = baseFor(form);
    const selected = select.value || selections.get(keyFor(form)) || "";
    const entries = plansFor(form.dataset.entityId, baseReleaseId).map(plan => [plan.id, planChoice(plan)]);
    select.innerHTML = `<option value="">${baseReleaseId ? "请选择与原公开版本匹配的配图计划" : "暂不绑定，继续准备草稿"}</option>${options(entries, selected)}`;
    refreshEvidence(form);
  }

  function updatePlans(form, plans, selected) {
    records.set(form.dataset.entityId, plans);
    if (selected !== undefined) selections.set(keyFor(form), selected);
    if (form.isConnected) {
      if (selected !== undefined) field(form, "illustrationPlanId").value = "";
      syncEdition(form);
    }
  }

  function status(panel, message, error = false) {
    const alert = panel.querySelector("[data-illustration-error]");
    alert.hidden = !error;
    alert.textContent = error ? message : "";
    panel.querySelector("[data-illustration-status]").textContent = error ? "" : message;
  }

  async function run(button, panel, form) {
    const action = button.dataset.illustrationAction;
    const endpoint = pathFor(form);
    const showSlots = slots => {
      slotCounts.set(keyFor(form), slots.length);
      panel.querySelector("[data-illustration-slots]").innerHTML = slots.map(slotFields).join("");
    };
    if (action === "suggest") {
      const { title, summary, body } = articleSource(form, getCopyBase(form));
      const suggestion = await api("/api/editorial/illustrations/suggest", { method: "POST", body: JSON.stringify({ title, summary, body }) });
      field(panel, "illustrationArticleType").value = suggestion.articleType;
      showSlots(suggestion.slots);
      panel.querySelector("[data-illustration-reasons]").textContent = (suggestion.reasons || []).join("。");
      return "已给出文章类型和图位建议。请核对正文位置、画面与图注。";
    }
    if (action === "add") {
      const slots = readSlots(panel);
      if (slots.length >= MAX_SLOTS) throw new Error(`当前计划最多支持 ${MAX_SLOTS} 个图位。`);
      showSlots([...slots, { kind: "scene" }]);
      return "已增加一个待填写的场景图位。";
    }
    if (action === "load") {
      const result = await api(endpoint);
      updatePlans(form, result.items);
      return plansFor(form.dataset.entityId, baseFor(form)).length ? "已读取此版本适用的配图计划。" : "此版本尚无可用配图计划。";
    }
    if (action === "save") {
      const slots = readSlots(panel);
      if (slots.some(slot => !slot.anchor || !slot.description || !slot.alt)) {
        throw new Error("每个图位都需要准确的正文位置、画面内容和替代文字。");
      }
      const copyBase = getCopyBase(form);
      const plan = await mutate(endpoint, { ...articleSource(form, copyBase), articleType: value(panel, "illustrationArticleType"), slots,
        ...(copyBase ? { baseReleaseId: copyBase.id } : {}) },
        { etag: form.dataset.etag, needsEtag: true });
      if ((plan.baseReleaseId || "") !== baseFor(form)) {
        throw new Error("返回的配图计划与当前公开原稿不匹配，请刷新后重新读取计划。");
      }
      updatePlans(form, [...recordFor(form).filter(row => row.id !== plan.id), plan], plan.id);
      return "配图计划已保存。请按图位制作、上传和核对图片。";
    }
    if (action === "register") {
      const label = value(panel, "illustrationProducerLabel").trim();
      const publicKey = value(panel, "illustrationProducerKey").trim();
      if (!label || !publicKey) throw new Error("填写工作站名称和它实际导出的公开密钥。");
      const result = await mutate("/api/editorial/illustrations/producer-keys", { label, publicKey });
      field(panel, "illustrationProducerKey").value = "";
      return `工作站公钥已登记，编号 ${result.id}。`;
    }
    const plan = selectedPlan(form);
    if (!plan) throw new Error("请先选择此选题的配图计划。");
    if (action === "download" || action === "prompt") {
      const slot = plan.slots.find(row => row.id === button.dataset.slotId);
      if (!slot) throw new Error("图位已变化，请重新读取配图计划。");
      if (action === "prompt") {
        await navigator.clipboard.writeText(articleIllustrationImageGenPrompt(plan, slot));
        return "已复制生图提示和图位追踪标记。请将原始成图与工具回执一同保留。";
      }
      downloadIllustrationJson(`${plan.id}-${slot.id}.json`, articleIllustrationWorkOrder(plan, slot));
      return "已下载对应正文和图位的工作单。按工作单指定的工具制作并保存真实回执。";
    }
    if (action === "evidence") {
      const slotId = value(panel, "illustrationEvidenceSlot");
      const slot = plan.slots.find(row => row.id === slotId);
      const asset = getAssets().find(row => row.id === value(panel, "illustrationEvidenceAsset"));
      if (!slot || asset?.status !== "reviewed" || asset.kind !== "image") throw new Error("请选择实际图位和已审核的图片。");
      const evidence = await readArticleIllustrationProofs(field(panel, "illustrationEvidenceFile").files);
      if ((slot.kind === "scene" && !evidence.designerCompositor) || (slot.imageGeneration && !evidence.imageGen)) {
        throw new Error("还缺少此图位指定工具签发的执行回执。");
      }
      const updated = await mutate(`${endpoint}/${encodeURIComponent(plan.id)}/evidence`,
        { slotId, assetId: asset.id, sha256: asset.sha256, designerCompositor: evidence.designerCompositor, imageGen: evidence.imageGen },
        { etag: plan.etag, needsEtag: true });
      updatePlans(form, recordFor(form).map(row => row.id === updated.id ? updated : row), updated.id);
      return updated.isComplete ? "图片和回执已齐全。可将计划绑定到准确正文并保存修订。" : "该图片已核对并绑定到图位。";
    }
    throw new Error("无法识别配图操作。");
  }

  root.addEventListener("click", event => {
    const button = event.target.closest("[data-illustration-action]");
    if (!button?.dataset.illustrationAction || button.disabled) return;
    const panel = button.closest("[data-article-illustrations]");
    const form = button.closest("form");
    if (!panel || !form) return;
    button.disabled = true;
    status(panel, "正在处理配图计划…");
    void run(button, panel, form).then(message => status(panel, message)).catch(error => status(panel, error.message || "配图操作未完成。", true))
      .finally(() => { button.disabled = false; });
  });
  root.addEventListener("change", event => {
    const control = event.target;
    if (!["illustrationPlanId", "illustrationArticleType"].includes(control.name)) return;
    const form = control.closest("form");
    const panel = control.closest("[data-article-illustrations]");
    if (!form || !panel) return;
    if (control.name === "illustrationPlanId") {
      if (!selectedPlan(form)) control.value = "";
      selections.set(keyFor(form), control.value);
      refreshEvidence(form);
    } else {
      const slots = readSlots(panel);
      const kinds = draftKinds(control.value);
      panel.querySelector("[data-illustration-slots]").innerHTML =
        slots.map((slot, index) => slotFields({ ...slot, kind: kinds[index] || slot.kind }, index)).join("");
    }
  });
  return { markup, syncEdition, selectedPlan, selectBatchPlan(plan) {
    const previous = records.get(plan.storyId) || [];
    records.set(plan.storyId, [...previous.filter(item => item.id !== plan.id), plan]);
    selections.set(selectionKey(plan.storyId, plan.baseReleaseId), plan.id);
  } };
}

export function downloadIllustrationJson(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
