import { escapeHtml as html, safePublicUrl } from "./publication-view.js";
import { downloadIllustrationJson } from "./article-illustrations.js";
import { articleIllustrationStyleYear } from "./article-illustration-style.js";
import { articleIllustrationImageGenPrompt, articleIllustrationWorkOrder } from "./article-illustration-work-order.js";

const MAX_ROWS = 6;
const MAX_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;
const PREVIOUSLY_PREPARED_RELEASES = new Set(["REL-00129", "REL-00130"]);
const TYPES = { technical: "技术文章", product: "产品文章", lifestyle: "生活分享" };
const KINDS = { architecture: "架构图", logic: "逻辑图", scene: "场景图" };
const ROW_FIELDS = ["storyId", "baseReleaseId", "canonicalPath", "snapshotHash", "sourceHash", "articleType", "slots"];
const SLOT_FIELDS = ["kind", "anchor", "description", "alt", "caption", "imageGeneration"];
const SHA256 = /^[a-f0-9]{64}$/;
const exactKeys = (object, fields) => object && Object.getPrototypeOf(object) === Object.prototype &&
  Object.keys(object).length === fields.length && fields.every(name => Object.hasOwn(object, name));
const textWithin = (input, maximum, allowEmpty = false) => typeof input === "string" && input.trim() === input &&
  input.length <= maximum && (allowEmpty || input.length > 0);
const withoutSlotMetadata = slot => Object.fromEntries(SLOT_FIELDS.map(key => [key, slot[key]]));

async function digest(text) {
  if (!globalThis.crypto?.subtle) throw new Error("请在 HTTPS 管理后台核对原稿及计划摘要。");
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function parseRow(input) {
  if (!exactKeys(input, ROW_FIELDS) || typeof input.storyId !== "string" || !/^STY-\d{5,}$/.test(input.storyId) ||
      typeof input.baseReleaseId !== "string" || !/^REL-\d{5,}$/.test(input.baseReleaseId) ||
      !textWithin(input.canonicalPath, 120) || !/^\/(zh|en)\/articles\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.canonicalPath) ||
      typeof input.snapshotHash !== "string" || !SHA256.test(input.snapshotHash) ||
      typeof input.sourceHash !== "string" || !SHA256.test(input.sourceHash) ||
      typeof input.articleType !== "string" || !Object.hasOwn(TYPES, input.articleType) ||
      !Array.isArray(input.slots) || input.slots.length !== 3) {
    throw new Error("需提供选题、原发布号、原地址、双摘要、文章类型和三个图位。");
  }
  if (PREVIOUSLY_PREPARED_RELEASES.has(input.baseReleaseId)) throw new Error("首两篇从已建立的原文配图计划继续。");
  const slots = input.slots.map((slot, index) => {
    if (!exactKeys(slot, SLOT_FIELDS) || typeof slot.kind !== "string" || !Object.hasOwn(KINDS, slot.kind) || !textWithin(slot.anchor, 300) ||
        !textWithin(slot.description, 1000) || !textWithin(slot.alt, 500) || !textWithin(slot.caption, 500, true) ||
        typeof slot.imageGeneration !== "boolean") throw new Error(`第 ${index + 1} 个图位字段不齐全或超出长度。`);
    return withoutSlotMetadata(slot);
  });
  const expected = input.articleType === "lifestyle" ? ["scene", "scene", "scene"] : ["architecture", "logic", "scene"];
  if (slots.map(slot => slot.kind).sort().join() !== expected.join() ||
      ["anchor", "description", "alt"].some(field => new Set(slots.map(slot => slot[field])).size !== slots.length)) {
    throw new Error("三个图位须符合文章类型，位置、描述和替代文字各不相同。");
  }
  return { ...Object.fromEntries(ROW_FIELDS.map(key => [key, input[key]])), slots };
}

export function parseArticleIllustrationBatch(text) {
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error("每批配图计划文件最多 64 KiB。");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/u)
    .map((content, index) => ({ content, line: index + 1 })).filter(entry => entry.content.trim());
  if (!lines.length || lines.length > MAX_ROWS) throw new Error(`每批应包含 1 至 ${MAX_ROWS} 篇配图计划。`);
  const rows = lines.map(({ content, line }) => {
    try { return { line, input: parseRow(JSON.parse(content)) }; }
    catch (error) { return { line, error: error instanceof SyntaxError ? "此行无法解析为 JSON。" : error.message }; }
  });
  for (const entry of rows) {
    if (entry.input && rows.some(other => other !== entry && other.input?.storyId === entry.input.storyId)) {
      entry.error = "同一选题在文件中重复出现。请保留一份准确计划。";
    }
  }
  return rows;
}

function exactOriginal(input, base) {
  const source = base?.publicSnapshot;
  if (base?.id !== input.baseReleaseId || base.storyId !== input.storyId || base.snapshotHash !== input.snapshotHash ||
      base.canonicalPath !== input.canonicalPath || base.status !== "published" || source?.format !== "article") {
    throw new Error("本行与当前获准加图的官网原稿不一致。请刷新并核对发布号、地址和摘要。");
  }
  return { body: source.body, locale: source.locale, summary: source.summary, title: source.title };
}

async function verifyOriginal(input, base) {
  const source = exactOriginal(input, base);
  if (await digest(JSON.stringify(source)) !== input.sourceHash) throw new Error("本行的正文摘要与官网原稿不一致。");
  return source;
}

function matchesPlan(plan, input, styleYear) {
  return Number.isInteger(plan?.styleYear) && plan.styleYear >= styleYear && plan.storyId === input.storyId && plan.baseReleaseId === input.baseReleaseId && plan.sourceHash === input.sourceHash &&
    plan.articleType === input.articleType && Array.isArray(plan.slots) && plan.slots.length === input.slots.length &&
    plan.slots.every((slot, index) => SLOT_FIELDS.every(key => slot[key] === input.slots[index][key]));
}

export async function saveArticleIllustrationBatchRow(input, base, { api, mutate, knownPlanId }) {
  const styleYear = articleIllustrationStyleYear();
  const source = await verifyOriginal(input, base);
  const storyPath = `/api/stories/${encodeURIComponent(input.storyId)}`;
  const planPath = `${storyPath}/illustrations`;
  const publicPath = `/public-api/content/${encodeURIComponent(source.locale)}/article/${input.canonicalPath.split("/").at(-1)}`;
  const request = { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  const live = await api(publicPath, { ...request, cache: "no-store" });
  if (live?.releaseId !== input.baseReleaseId || live.snapshotHash !== input.snapshotHash || live.canonicalPath !== input.canonicalPath) {
    throw new Error("当前官网原稿已经切换，请刷新后重新核对。");
  }
  let planId = knownPlanId;
  let reused = true;
  if (!planId) {
    const [story, existing] = await Promise.all([api(storyPath, request), api(planPath, request)]);
    if (story.id !== input.storyId || !story.etag || !Array.isArray(existing.items)) throw new Error("无法确认选题或既有计划，请重新读取。");
    if (story.status === "archived") throw new Error("原选题已归档，请在选题中核对状态。");
    const matches = existing.items.filter(plan => matchesPlan(plan, input, styleYear));
    if (matches.length > 1) throw new Error("有多个完全匹配的既有计划，请进入选题选择应继续的那一份。");
    planId = matches[0]?.id;
    if (!planId) {
      const idempotencyKey = `illustration-batch-${await digest(JSON.stringify({ input, styleYear }))}`;
      const created = await mutate(planPath, { ...source, baseReleaseId: input.baseReleaseId, articleType: input.articleType, slots: input.slots },
        { etag: story.etag, needsEtag: true, idempotencyKey, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      planId = created.id;
      reused = false;
    }
  }
  if (!/^ILP-\d{5,}$/.test(planId ?? "")) throw new Error("没有收到准确计划编号，请重新读取既有计划后重试。");
  try {
    const plan = await api(`${planPath}/${encodeURIComponent(planId)}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (plan.id !== planId || !matchesPlan(plan, input, styleYear) || !Array.isArray(plan.workOrders) || plan.workOrders.length !== plan.slots.length) {
      throw new Error("保存回读与本行精确图位不一致，请进入选题核对这份计划。");
    }
    for (const [index, slot] of plan.slots.entries()) {
      const result = plan.workOrders[index];
      if (JSON.stringify(result.workOrder) !== JSON.stringify(articleIllustrationWorkOrder(plan, slot)) ||
          result.imageGenPrompt !== (slot.imageGeneration ? articleIllustrationImageGenPrompt(plan, slot) : undefined)) {
        throw new Error("服务端工单或生图提示与当前图位不一致，请刷新计划后重试。");
      }
    }
    return { plan, reused };
  } catch (error) {
    error.knownPlanId = planId;
    throw error;
  }
}

export function mountArticleIllustrationBatch(root, { api, mutate, getBase, onContinue }) {
  let entries = [], selected = new Set(), fileName = "", status = "", failure = "", busy = false;
  const available = row => row.base && !row.plan;
  const finished = row => row.plan?.workOrders?.some(order => order.workOrder.slot.kind === "scene");

  function workOrders(row) {
    return row.plan.workOrders.filter(order => order.workOrder.slot.kind === "scene");
  }

  function rowMarkup(row, index) {
    if (!row.base) return `<li><p class="form-error">第 ${row.line} 行 · ${html(row.error)}</p></li>`;
    const { input, plan, base } = row;
    const officialUrl = safePublicUrl(base.publicSnapshot.canonicalUrl);
    return `<li><div class="editorial-illustration-batch-row">
      ${available(row) ? `<label class="check-label"><input type="checkbox" data-illustration-batch-select="${index}"${selected.has(index) ? " checked" : ""}${busy ? " disabled" : ""} /><span><strong>${html(base.publicSnapshot.title)}</strong></span></label>` : `<strong>${html(base.publicSnapshot.title)}</strong>`}
      <p>${html(input.storyId)} · ${html(input.baseReleaseId)} · ${html(TYPES[input.articleType])}${plan ? ` · ${row.reused ? "已读取" : "已保存"} ${html(plan.id)} · ${html(plan.styleYear)} 年起的当代风格` : ""}</p>
      ${officialUrl ? `<p><a class="text-link" href="${html(officialUrl)}" target="_blank" rel="noopener noreferrer">${html(input.canonicalPath)}</a></p>` : `<p>${html(input.canonicalPath)}</p>`}
      ${row.error ? `<p class="form-error" role="alert">${html(row.error)}</p>` : ""}
      <details><summary>核对三个图位与原稿摘要</summary><code>${html(input.snapshotHash)}</code>
        <ol class="editorial-reference-list">${input.slots.map(slot => `<li><strong>${html(KINDS[slot.kind])} · ${html(slot.anchor)}</strong><p>${html(slot.description)}</p><p>替代文字　${html(slot.alt)}</p>${slot.caption ? `<p>图注　${html(slot.caption)}</p>` : ""}</li>`).join("")}</ol></details>
      ${plan ? `<div class="editorial-inline-links"><button class="ghost-button" type="button" data-illustration-batch-action="continue" data-index="${index}">在选题中继续</button>${workOrders(row).map(({ workOrder, imageGenPrompt }) => `<button class="ghost-button" type="button" data-illustration-batch-action="download" data-index="${index}" data-slot-id="${html(workOrder.slot.id)}">下载 ${html(workOrder.slot.id)} 场景工单</button>${imageGenPrompt ? `<button class="ghost-button" type="button" data-illustration-batch-action="prompt" data-index="${index}" data-slot-id="${html(workOrder.slot.id)}">复制 ${html(workOrder.slot.id)} 生图提示</button>` : ""}`).join("")}</div>` : ""}
    </div></li>`;
  }

  function content() {
    return `<div class="editorial-illustration-body editorial-form" aria-busy="${busy}">
      <label><span>选择预先核对的计划 JSONL，每批最多六篇</span><input type="file" data-illustration-batch-file accept=".jsonl,application/x-ndjson"${busy ? " disabled" : ""} /></label>
      ${fileName ? `<p class="operation-field-hint">${html(fileName)}</p>` : ""}
      <p class="form-error" role="alert"${failure ? "" : " hidden"}>${html(failure)}</p>
      <p class="form-status" role="status" aria-live="polite">${html(status)}</p>
      ${entries.length ? `<ul class="editorial-reference-list editorial-illustration-batch-list">${entries.map(rowMarkup).join("")}</ul>
      <div class="editorial-inline-links">
        <button class="ghost-button" type="button" data-illustration-batch-action="select"${busy || !entries.some(available) ? " disabled" : ""}>选择本批可保存的计划</button>
        <button class="primary-button" type="button" data-illustration-batch-action="save"${busy || !selected.size ? " disabled" : ""}>仅保存选中的配图计划</button>
        <button class="ghost-button" type="button" data-illustration-batch-action="export"${busy || !entries.some(finished) ? " disabled" : ""}>下载已确认的场景工单与提示</button>
      </div>` : ""}
    </div>`;
  }

  const panel = () => root.querySelector("[data-illustration-batch]");
  function refresh() {
    const output = panel()?.querySelector("[data-illustration-batch-content]");
    if (output) output.innerHTML = content();
  }

  async function importFile(file) {
    fileName = file.name; entries = []; selected = new Set(); failure = ""; status = "正在对照本批官网原稿…";
    busy = true; refresh();
    try {
      if (file.size > MAX_BYTES) throw new Error("每批配图计划文件最多 64 KiB。");
      entries = await Promise.all(parseArticleIllustrationBatch(await file.text()).map(async row => {
        if (row.error) return row;
        try {
          const base = getBase(row.input.storyId, row.input.baseReleaseId);
          await verifyOriginal(row.input, base);
          return { ...row, base };
        } catch (error) { return { ...row, error: error.message }; }
      }));
      status = `${entries.filter(available).length}/${entries.length} 篇与官网原稿匹配。请核对图位后勾选。`;
    } catch (error) { status = ""; failure = error.message || "无法读取配图计划文件。"; }
    finally { busy = false; refresh(); }
  }

  async function saveSelected() {
    const indexes = [...selected].filter(index => available(entries[index]));
    if (!indexes.length) return;
    failure = ""; busy = true;
    for (const [position, index] of indexes.entries()) {
      const row = entries[index];
      status = `正在核对并保存 ${position + 1}/${indexes.length} 篇 · ${row.input.baseReleaseId}…`;
      refresh();
      try {
        const base = getBase(row.input.storyId, row.input.baseReleaseId);
        Object.assign(row, await saveArticleIllustrationBatchRow(row.input, base, { api, mutate, knownPlanId: row.knownPlanId }), { error: "" });
        selected.delete(index);
      } catch (error) {
        row.knownPlanId = error.knownPlanId || row.knownPlanId;
        const pending = error.status === 412 ? "请刷新选题后再保存。" : "再次保存会先读取已有计划并沿用同一请求标识。";
        row.error = `${row.knownPlanId ? `${row.knownPlanId} 已返回，仍待准确回读。` : "未确认已保存。"}${error.message || "请求未完成。"} ${pending}`;
      }
    }
    busy = false;
    status = `${indexes.length - selected.size} 篇已回读确认。${selected.size ? ` ${selected.size} 篇待核对，可重试。` : " 可下载当前批次场景工单。"}`;
    refresh();
  }

  async function act(button) {
    const { illustrationBatchAction: action, index, slotId } = button.dataset;
    if (action === "select") {
      selected = new Set(entries.flatMap((row, index) => available(row) ? [index] : []));
      refresh(); panel()?.querySelector('[data-illustration-batch-action="save"]')?.focus(); return;
    }
    if (action === "save") return saveSelected();
    if (action === "export") {
      const items = entries.filter(finished).flatMap(row => workOrders(row).map(order => ({
        baseReleaseId: row.input.baseReleaseId, canonicalPath: row.input.canonicalPath, snapshotHash: row.input.snapshotHash, ...order,
      })));
      if (items.length) downloadIllustrationJson("官网场景配图工单与生图提示.json", { schema: "pengmanager.article-illustration-batch-work-orders/v1", items });
      return;
    }
    const plan = entries[Number(index)]?.plan;
    if (!plan) return;
    if (action === "continue") return onContinue(plan);
    const order = plan.workOrders.find(row => row.workOrder.slot.id === slotId);
    if (action === "download" && order) downloadIllustrationJson(`${plan.id}-${slotId}.json`, order.workOrder);
    if (action === "prompt" && order?.imageGenPrompt) {
      await navigator.clipboard.writeText(order.imageGenPrompt);
      status = `已复制 ${plan.id}/${slotId} 的服务端生图提示。`;
      refresh();
    }
  }

  root.addEventListener("change", event => {
    const control = event.target;
    if (busy || !control.closest("[data-illustration-batch]")) return;
    if (control.hasAttribute("data-illustration-batch-file") && control.files?.length) {
      void importFile(control.files[0]);
    } else if (control.hasAttribute("data-illustration-batch-select")) {
      const index = Number(control.dataset.illustrationBatchSelect);
      if (control.checked) selected.add(index); else selected.delete(index);
      const save = panel()?.querySelector('[data-illustration-batch-action="save"]');
      if (save) save.disabled = !selected.size;
    }
  });
  root.addEventListener("click", event => {
    const button = event.target.closest("[data-illustration-batch-action]");
    if (busy || !button || button.disabled) return;
    void act(button).catch(error => { failure = error.message || "配图批次操作未完成。"; refresh(); });
  });
  return { markup: (enabled) => enabled || entries.length ? `<details class="editorial-disclosure" data-illustration-batch${entries.length ? " open" : ""}>
    <summary>批量准备原文配图计划</summary><div data-illustration-batch-content>${content()}</div></details>` : "" };
}
