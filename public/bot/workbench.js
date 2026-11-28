import { parseMandateDraft, stopMandateSelection } from "./mandate-draft.js";
import { isTaskInProgress, notificationTitle } from "./dashboard.js";

const apiRoot = "/api/bot/v1";
const content = document.querySelector("#content");
const connection = document.querySelector("#connection");
const message = document.querySelector("#global-message");
const refreshButton = document.querySelector("#refresh");
const views = new Set(["home", "mandates", "tasks", "browser"]);
const dataTypes = { fixture: "隔离演练", real: "真实运行" };
const states = {
  active: "有效", queued: "待执行", running: "执行中", paused: "已暂停", succeeded: "已完成",
  completed: "已完成", failed: "失败", canceled: "已取消", cancelled: "已取消", revoked: "已撤销",
  expired: "已到期", released: "已交还", verified: "已核验", prepared: "已备包",
  public_verified: "已核验公开", restricted_verified: "已核验受限", unknown: "待对账",
  needs_reconcile: "待对账", owner_confirmation: "待本人确认", needs_owner: "待本人",
  blocked: "受阻", archived: "已归档", not_selected: "未选用", awaiting: "等候",
  reserved: "已预留", settled: "已结算", platform_accepted: "平台已受理", waiting_input: "等待材料或接手",
  partial: "部分完成", accepted: "已受理", scheduled: "已安排", observed: "已观测",
  reviewed: "已独立核验", owner_reported: "本人已报告", handoff: "已确认交接", delivered: "已送达", read: "已阅读",
  pending: "待查看", dispatched: "已派发", sample_insufficient: "样本不足", unavailable: "未取得样本",
};
const auditNames = {
  acquired: "申请接管", viewer_redeemed: "兑换短期画面票据", viewer_connected: "接通操作画面",
  viewer_disconnected: "断开操作画面", revoked: "终止租约", released: "交还控制",
  expired: "租约到期", workspace_stopped: "停用云浏览器", workspace_resumed: "恢复接管入口",
};
const browserReasons = {
  review: "核对页面或预览", sign_in: "本人登录或验证", platform_verification: "平台原生确认",
  owner_returned: "本人交还", owner_stop: "本人停止", owner_resume: "本人恢复",
  owner_signed_out: "管理员会话已退出", permission_ended: "权限已失效或服务已重启",
  time_limit: "达到操作时限", viewer_closed: "关闭画面", viewer_idle: "长时间未操作",
  worker_unavailable: "远端工位不可用", gateway_closed: "网关已断开", not_connected: "票据未用于接通操作画面",
};
const platformActions = { publish: "发布", replace: "替换", update: "更新", withdraw: "撤回", submit: "提交" };
const scopesOfVisibility = { public: "公开", private: "私有", restricted: "定向可见", unlisted: "不公开列出" };
const errorMessages = {
  AUTH_REQUIRED: "管理员会话已失效，请重新登录。",
  BROWSER_NOT_CONFIGURED: "此部署尚未配置云浏览器工位。",
  BROWSER_TARGET_NOT_FOUND: "此项目没有获准的对应云浏览器工位。",
  BROWSER_LEASE_BUSY: "同一工位已有接管者。可以停止旧接管后再申请。",
  BROWSER_VIEWER_BUSY: "这份租约已接通一个画面。断开后再重新打开。",
  BROWSER_LEASE_ENDED: "这次接管已结束，请重新申请。",
  PRECONDITION_FAILED: "记录在其他设备发生变化。请刷新后再操作。",
  CSRF_REQUIRED: "会话已更新，请刷新工作台。",
  CONFIRMATION_STALE: "稿件或账号在其他设备更新了。请重新查看并核对这次交接。",
  OWNER_CONFIRMATION_REQUIRED: "请先确认这份准确交接，再记录本人提交回执。",
};
const model = { session: null, dashboard: null, browser: null, view: null, viewer: null, details: new Map() };
let refreshPromise;
let editedForm;
content.addEventListener("input", event => { editedForm = event.target.form; });

const list = (value) => Array.isArray(value) ? value : [];
const label = (value) => typeof value === "number" || typeof value === "string" ? String(value) : "";
const namedState = (value) => states[value] ?? (label(value) || "待核对");
const identifier = (row) => label(row?.id ?? row?.taskId ?? row?.mandateId);
const channelName = (row) => label(row?.nameZh ?? row?.name ?? row?.label ?? row?.channelId ?? row?.platformId ?? row?.id);
const date = (value) => {
  if (!value) return "";
  const instant = new Date(value);
  if (!Number.isFinite(instant.valueOf())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(instant);
};

function node(tag, options = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== null) element.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child instanceof Node) element.append(child);
    else if (typeof child === "string" || typeof child === "number") element.append(String(child));
  }
  return element;
}

function button(text, onClick, className = "quiet") {
  const control = node("button", { class: className, type: "button" }, text);
  control.addEventListener("click", () => run(control, onClick));
  return control;
}

function navigateLink(text, name, className = "text-link") {
  return node("a", { href: `#${name}`, class: className }, text);
}

function heading(title, text, actions) {
  return node("div", { class: "page-head" },
    node("div", {}, node("h1", {}, title), text && node("p", { class: "description" }, text)), actions);
}

function panel(title, body, action) {
  return node("section", { class: "panel" },
    node("div", { class: "section-head" }, node("h2", {}, title), action), body);
}

function empty(title, text) {
  return node("div", { class: "empty" }, node("h3", {}, title), text && node("p", {}, text));
}

function feed(entries, renderItem, whenEmpty) {
  return entries.length ? node("ul", { class: "list" }, entries.map(renderItem)) : whenEmpty;
}

function item(title, subtitle, state, extras, className = "") {
  return node("li", { class: "item" },
    node("div", {}, node("h3", {}, title), subtitle && node("p", {}, subtitle)),
    state && node("span", { class: `tag ${className}` }, state), extras);
}

function safeUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.username || url.password || (url.origin !== window.location.origin && url.protocol !== "https:")) return null;
    if (url.origin === window.location.origin && !value.startsWith("/") && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function publicLink(value, text = "打开结果") {
  const url = safeUrl(value);
  return url && node("a", { href: url.href, class: "text-link", target: "_blank", rel: "noopener noreferrer" }, text);
}

function showMessage(text, isError = false) {
  message.hidden = !text;
  message.textContent = text || "";
  message.classList.toggle("error", isError);
}

function showConnection(text, className) {
  connection.textContent = text;
  connection.className = `connection ${className || ""}`;
}

function loginLink() {
  return node("a", { href: "/login", class: "button" }, "登录管理后台");
}

function localError(text) {
  return new Error(text);
}

async function http(path, body, { idempotencyKey, version } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = model.session?.csrfToken || "";
    headers["Idempotency-Key"] = idempotencyKey || crypto.randomUUID();
    if (version !== undefined) headers["If-Match"] = String(version);
  }
  let response;
  try {
    response = await fetch(apiRoot + path, {
      credentials: "same-origin", method: body === undefined ? "GET" : "POST",
      headers, body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store", signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw localError("暂时连不上工作台。请先刷新核对状态，再决定是否重试。");
  }
  const json = await response.json().catch(() => null);
  if (!response.ok || !json || typeof json !== "object") {
    const problem = json?.error;
    const error = new Error(errorMessages[problem?.code] || problem?.message ||
      (response.status === 401 ? errorMessages.AUTH_REQUIRED : "服务未返回可读取的结果，请稍后刷新。"));
    error.status = response.status;
    if (response.status === 401) {
      model.session = null;
      model.dashboard = null;
      model.browser = null;
      model.details.clear();
      showConnection("等待登录", "error");
      closeLocalViewer();
      render();
    }
    throw error;
  }
  return json;
}

async function run(control, operation) {
  const text = control.textContent;
  control.disabled = true;
  control.textContent = "处理中…";
  showMessage("");
  try {
    await operation();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    control.disabled = false;
    control.textContent = text;
  }
}

function viewName() {
  const hash = location.hash.slice(1);
  return views.has(hash) ? hash : "home";
}

function refresh({ preserveEdits = false } = {}) {
  const canRender = () => !model.viewer && !(preserveEdits && editedForm?.isConnected);
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    refreshButton.disabled = true;
    if (!model.dashboard) content.setAttribute("aria-busy", "true");
    try {
      model.session = await http("/session");
      model.dashboard = await http("/dashboard");
      showConnection(dataTypes[model.dashboard.dataMode] || "已连接", "ready");
      if (viewName() === "browser") await loadBrowser();
      if (canRender()) render();
      if (model.viewer && !activeLease(model.viewer.leaseId)) {
        closeLocalViewer();
        render();
        showMessage("云浏览器接管已经结束。");
      }
    } catch (error) {
      showConnection(error.status === 401 ? "等待登录" : "连接异常", "error");
      showMessage(error.message, error.status !== 401);
      if (canRender()) render();
    } finally {
      content.setAttribute("aria-busy", "false");
      refreshButton.disabled = false;
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

function verified(outcome) {
  return outcome.state === "public_verified" || outcome.status === "public_verified" ||
    outcome.state === "verified" && outcome.visibility === "public";
}

function resultEntry(outcome) {
  const status = outcome.state ?? outcome.status;
  const key = outcome.receipt?.remoteId || outcome.remoteId;
  const task = list(model.dashboard?.tasks).find(row => row.id === outcome.taskId);
  const channelId = outcome.channelId ?? outcome.target?.channelId;
  const channel = list(model.dashboard?.channels).find(row => (row.channelId ?? row.id) === channelId);
  const title = label(outcome.title ?? outcome.name ?? task?.title ?? outcome.channelLabel) || "交付记录";
  const subtitle = [channel?.name ?? channel?.label ?? channelId, date(outcome.verifiedAt ?? outcome.completedAt ?? outcome.at),
    model.dashboard?.dataMode === "fixture" ? "演练回执" : label(key)].filter(Boolean).join(" · ");
  const url = outcome.receipt?.url ?? outcome.url ?? outcome.publicUrl;
  const extras = verified(outcome) && model.dashboard?.dataMode !== "fixture" &&
    outcome.dataMode !== "fixture" && publicLink(url, "打开已核验的公开结果");
  return item(title, subtitle, namedState(status), extras && node("div", { class: "actions" }, extras));
}

function showHome(data) {
  const outcomes = list(data.outcomes);
  const mandates = list(data.mandates);
  const activeTasks = list(data.tasks).filter(isTaskInProgress);
  const notifications = list(data.notifications);
  const active = mandates.filter((row) => (row.state ?? row.status) === "active");
  const liveOutcomes = data.dataMode === "fixture" ? [] : outcomes.filter((row) => row.dataMode !== "fixture" && verified(row));
  const pending = notifications.filter((row) => ["pending", "unread", "open", "ready"].includes(row.status ?? row.state) || (!row.status && !row.state));
  const next = [...active].filter((row) => row.nextRunAt ?? row.next_run_at).sort((a, b) =>
    new Date(a.nextRunAt ?? a.next_run_at) - new Date(b.nextRunAt ?? b.next_run_at))[0];
  const stats = [
    ["核验公开", liveOutcomes.length], ["有效委托", active.length],
    ["待处理任务", activeTasks.length],
    ["待查看提醒", pending.length],
  ];
  return [
    node("section", { class: "hero" },
      node("div", {}, node("h1", {}, "经营成果"),
        node("p", {}, next ? `下次已排运行 · ${date(next.nextRunAt ?? next.next_run_at)}` : "在这里查看已核验的交付、接下来要做的事，以及确需你处理的提醒。")),
      navigateLink("建立经营委托", "mandates", "button")),
    node("div", { class: "stats", "aria-label": "当前经营记录" }, stats.map(([name, value]) =>
      node("div", { class: "stat" }, node("span", {}, name), node("strong", {}, String(value))))),
    node("div", { class: "columns" },
      node("div", { class: "stack" },
        panel("最近交付", feed((data.dataMode === "fixture" ? outcomes : liveOutcomes).slice(0, 6), resultEntry,
          empty("暂无已核验的公开成果", "正式对象通过公开回读后会显示在这里。")), navigateLink("看任务", "tasks")),
        panel("正在推进", feed(activeTasks.slice(0, 5), (row) => item(
          label(row.title) || identifier(row), date(row.nextRunAt ?? row.createdAt), namedState(row.state ?? row.status)),
        empty("当前没有待处理任务", "可以在任务页查看过往记录。")))),
      node("div", { class: "stack" },
        panel("提醒", feed(pending.slice(0, 5), (row) => item(
          notificationTitle(row), label(row.message ?? row.summary), namedState(row.status ?? row.state), null, "caution"),
        empty("当前无需处理", "出现需要你决定的事项时，会在这里给出原因和下一步。"))),
        panel("阵地与费用", node("div", { class: "stack" },
          node("p", { class: "description" }, `已登记 ${list(data.channels).length} 个阵地 · ${list(data.costs).length} 条费用记录`),
          channelDetails(list(data.channels)),
          costDetails(list(data.costs)))))),
    weeklyReports(data),
    renderDetail("周报依据"),
  ].filter(Boolean);
}

function weeklyReports(data) {
  const rows = list(data.weeklyReports).slice(0, 4);
  if (!rows.length) return null;
  const mandates = new Map(list(data.mandates).map(m => [m.id, m.objective]));
  return panel("最近周报", feed(rows, row => {
    const score = row.due > 0 ? `按时自主交付 ${row.autonomous} / ${row.due} 项，到期未达 ${row.missed} 项` :
      row.due === 0 ? "本期没有到期承诺" : "这期没有记录自主交付分母";
    return item(mandates.get(row.mandateId) || "经营委托",
      `${date(row.periodStart)} — ${date(row.periodEnd)} · ${score} · 本人介入 ${row.ownerTouches} 次${row.humanMinutes == null ? "" : `，${row.recordedTimeEntries} 条有工时回执，共 ${row.humanMinutes} 分钟`}`,
      row.dataMode === "fixture" ? "演练周报" : "周报",
      button("查看依据", () => openDetail(`/mandates/${encodeURIComponent(row.mandateId)}/outcomes`, "周报依据", row.id)));
  }), null);
}

function channelDetails(channels) {
  if (!channels.length) return empty("暂无可读取的阵地目录");
  return node("details", { class: "details" }, node("summary", {}, "展开阵地目录"), node("ul", { class: "list" }, channels.map((row) =>
    item(channelName(row), label(row.reason ?? row.accountId), row.disposition || row.status || row.state ? namedState(row.disposition ?? row.status ?? row.state) : ""))));
}

function costDetails(costs) {
  if (!costs.length) return null;
  return node("details", { class: "details" }, node("summary", {}, "查看费用账本"), node("ul", { class: "list" }, costs.slice(0, 20).map((row) => {
    const currency = label(row.currency);
    const amount = Number.isFinite(row.actual) ? `${row.actual / 100} ${currency}` : "实际金额待核实";
    return item(label(row.title ?? row.taskId) || "费用记录", amount, namedState(row.state));
  })));
}

function field(title, element, hint) {
  return node("label", { class: "field" }, title, element, hint && node("small", {}, hint));
}

function selectBox(name, options) {
  return node("select", { name }, options.map(([value, text]) => node("option", { value }, text)));
}

function dataDetail(title, value) {
  return node("details", { class: "details" }, node("summary", {}, title),
    node("pre", { class: "detail-data", tabindex: 0 }, JSON.stringify(value, null, 2)));
}

function writeCapabilities(data) {
  const entries = list(data.capabilities).length ? data.capabilities :
    list(data.capabilities?.rows ?? data.capabilities?.targets ?? data.capabilities?.publication);
  return entries.filter((entry) => entry.active === true && entry.official === true &&
    entry.safeDedup === true && entry.businessReadback === true && entry.confirmationRequired !== true &&
    (!entry.expiresAt || new Date(entry.expiresAt) > new Date()) &&
    ["channelId", "accountId", "destination", "form", "action", "visibility"].every((key) => label(entry[key])));
}

function permissionPicker(data) {
  const capabilities = writeCapabilities(data);
  const entries = capabilities.map((capability, index) => {
    const channel = list(data.channels).find((row) => (row.id ?? row.channelId ?? row.platformId) === capability.channelId);
    const allowed = node("input", { type: "checkbox", name: "target", value: index });
    const required = node("input", { type: "checkbox", name: "required", value: index, disabled: "" });
    const maxDaily = node("input", {
      type: "number", name: `limit-${index}`, max: "1000", min: "1", value: "1", disabled: "", required: "",
    });
    const publish = ["publish", "submit"].includes(capability.action);
    const card = node("div", { class: "scope-card" },
      node("label", { class: "scope-toggle" }, allowed,
        node("span", {}, node("strong", {}, channelName(channel) || capability.channelId),
          node("small", {}, [capability.accountId, capability.destination, capability.form,
            platformActions[capability.action] || capability.action, scopesOfVisibility[capability.visibility]].filter(Boolean).join(" · ")))),
      node("div", { class: "scope-options", hidden: "" },
        field("每天最多执行次数", maxDaily),
        publish && node("label", { class: "scope-toggle" }, required, "列入必须交付成果")));
    allowed.addEventListener("change", () => {
      card.querySelector(".scope-options").hidden = !allowed.checked;
      maxDaily.disabled = !allowed.checked;
      required.disabled = !allowed.checked;
      if (!allowed.checked) required.checked = false;
    });
    return { capability, allowed, required, maxDaily, card };
  });
  const ui = entries.length ? node("fieldset", { class: "scope-fieldset" },
    node("legend", {}, data.dataMode === "fixture" ? "演练可代办的准确目标" : "允许代办的准确目标"),
    node("p", { class: "description" }, "只选择在本委托内可持续执行的账号、目的地、形式和动作。"),
    entries.map(({ card }) => card)) :
    empty("暂无可签发的自动写入目标", "目前可以建立研究与内容准备委托。可代办账号完成资格核验后会出现在这里。");
  return { entries, ui };
}

function sourcePicker(data) {
  const rows = list(data.sources ?? data.capabilities?.sources).filter((row) =>
    row.active !== false && label(row.id ?? row.sourceId));
  const controls = rows.map((row) => ({
    checkbox: node("input", { type: "checkbox", name: "source", value: label(row.id ?? row.sourceId) }),
    name: label(row.label ?? row.name ?? row.id ?? row.sourceId),
  }));
  const ui = controls.length ? node("fieldset", { class: "scope-fieldset" },
    node("legend", {}, "允许追踪的信源"),
    controls.map(({ checkbox, name }) => node("label", { class: "scope-toggle" }, checkbox, name))) :
    node("p", { class: "description" }, "当前没有登记自动信源。可以按时触发或在任务页登记真实来源。");
  return { controls, ui };
}

const workModes = { standard: "研究与内容准备，可另行授权代办", draft_only: "仅在工作台交付私有草稿", research_only: "仅研究，交付证据与缺口" };

function mandateInventory(data) {
  const onboarding = data.onboarding;
  const manual = list(data.sources).some(row => row.id === "manual" && row.active !== false);
  const automatic = list(data.sources).filter(row => row.id !== "manual" && row.active !== false && label(row.id));
  const exactTargets = writeCapabilities(data);
  const accounts = list(onboarding?.accounts);
  const content = onboarding?.content;
  const modeLabel = data.dataMode === "fixture" ? "演练盘点" : "已登记材料与缺口";
  const nameFor = (id) => channelName(list(data.channels).find(row => (row.channelId ?? row.id) === id)) || id;
  const expandable = (title, rows) => node("div", { class: "actions" },
    node("details", { class: "details" }, node("summary", {}, title), node("ul", {}, rows)));
  return panel(modeLabel, node("ul", { class: "list" },
    item("信源", [automatic.length ? `${automatic.length} 条已配置信源，勾选后加入草案。` : "尚无自动信源。",
      manual && "可登记本人提供的公开来源。"].filter(Boolean).join(" "), "",
    automatic.length > 0 && expandable("查看已配置信源", automatic.map(row => node("li", {}, label(row.label ?? row.id),
      row.error ? " · 最近读取失败" : row.lastSuccess ? " · 有读取回执" : " · 等待读取")))),
    item("账号与代办", exactTargets.length ? `${exactTargets.length} 个准确目标具有当前写入资格，由本人另行选择。` :
      "尚无带当前资格的自动写入目标。可以先研究或起草。", "",
    accounts.length > 0 && expandable("查看已登记账号", accounts.map(row => node("li", {},
      `${nameFor(row.platformId)} · ${row.id} · ${row.usable ? "身份与规则已核验" : "待核验身份或规则"}`)))),
    item("内容材料", content ? `${content.verifiedClaims} 条已核事实，${content.stories} 个已登记主题，${content.verifiedPublicReleases} 条已核验官网版本。${
      content.verifiedClaims === 0 ? " 缺少可用于起草的已核事实，可先登记来源。" : ""}` : "原生材料盘点暂不可用。", ""),
    item("制作用量", onboarding?.modelReady === true ? "制作服务就绪。每次用量仍按签署的预算执行。" :
      "制作模型或价目待配置。可先整理研究证据。", "")));
}

function setDuration(select, milliseconds, emptyValue) {
  if (milliseconds === undefined) return;
  const value = milliseconds === null ? emptyValue : String(milliseconds);
  if (milliseconds !== null && ![...select.options].some(option => option.value === value)) {
    const hours = milliseconds / 3_600_000;
    const label = hours % 24 === 0 ? `${hours / 24} 天` : `${hours} 小时`;
    select.append(node("option", { value }, label));
  }
  select.value = value;
}

function mandateForm(data) {
  const objective = node("textarea", {
    name: "objective", maxlength: "1600", required: "", placeholder: "例如，持续追踪读者真实问题，有新增证据时安排专题。",
  });
  const limit = node("input", { type: "number", min: "0", max: "10000000", step: ".01", name: "budget", value: "0", required: "" });
  const schedule = selectBox("schedule", [["", "按事件触发"], ["86400000", "每日"], ["604800000", "每周"]]);
  const resultWindow = selectBox("resultWindow", [["604800000", "接单后七天"], ["86400000", "接单后二十四小时"], ["1209600000", "接单后十四天"], ["", "随委托到期"]]);
  const expiry = node("input", { type: "date", name: "expiry" });
  const workMode = selectBox("workMode", Object.entries(workModes));
  const scope = permissionPicker(data);
  const sources = sourcePicker(data);
  const selectableFacts = list(data.onboarding?.facts).filter(row => label(row.id) && label(row.label));
  const facts = selectableFacts.map(row => ({ ...row, control: node("input", { type: "checkbox", name: "claim", value: row.id }) }));
  const factPicker = facts.length ? node("details", { class: "details" }, node("summary", {}, "选择允许使用的已核事实"),
    node("fieldset", { class: "scope-fieldset" }, node("legend", {}, "没有来料事实时使用这些已核事实"),
      data.onboarding?.content?.verifiedClaims > facts.length && node("p", { class: "description" }, `显示近期登记的 ${facts.length} 条可选事实。`),
      facts.map(({ control, id, label: title }) => node("label", { class: "scope-toggle" }, control, `${id} · ${title}`)))) : null;
  const evidence = node("div", { "aria-live": "polite" });
  const draftNotes = node("div", { "aria-live": "polite" });
  const approve = node("button", { type: "button", class: "button", disabled: "" }, "签发委托");
  const previewButton = node("button", { type: "submit", class: "quiet" }, "预览委托");
  let previewInput;
  let key;
  let revision = 0;
  function updateScope() {
    const privateOnly = workMode.value !== "standard";
    for (const { allowed } of scope.entries) {
      if (privateOnly && allowed.checked) {
        allowed.checked = false;
        allowed.dispatchEvent(new Event("change"));
      }
      allowed.disabled = privateOnly;
    }
  }
  function invalidatePreview() {
    revision += 1;
    previewInput = null;
    key = null;
    approve.disabled = true;
    evidence.replaceChildren();
  }
  const generate = button("从目标生成草案", () => {
    const draft = parseMandateDraft(objective.value);
    invalidatePreview();
    setDuration(schedule, draft.intervalMs, "");
    setDuration(resultWindow, draft.resultWindowMs, "");
    if (draft.expiryDate) expiry.value = draft.expiryDate;
    if (draft.workMode) workMode.value = draft.workMode;
    for (const { allowed } of scope.entries) {
      if (!allowed.checked) continue;
      allowed.checked = false;
      allowed.dispatchEvent(new Event("change"));
    }
    updateScope();
    const normalized = draft.objective.normalize("NFKC").toLowerCase();
    const referredSources = sources.controls.filter(({ name }) => name.length > 2 && normalized.includes(name.normalize("NFKC").toLowerCase()));
    const draftMessages = [...draft.notes, ...(referredSources.length ?
      [`目标中提到了已登记信源 ${referredSources.map(({ name }) => name).join("、")}。请核对后手动勾选。`] : [])];
    draftNotes.replaceChildren(node("p", { class: "message form-message", role: "status" }, draft.ambiguous
      ? "草案已填入可确定项。请核对待定项后预览。" : "草案已填入可确定项。请核对频次、时限、信源和工作范围。"));
    if (draftMessages.length) {
      draftNotes.append(node("ul", { class: "description" }, draftMessages.map(note => node("li", {}, note))));
    }
    if (!draft.ambiguous && !previewButton.disabled) form.requestSubmit(previewButton);
  });
  const form = node("form", { class: "form" },
    field("经营目标", objective, "可写“每天跟踪已登记的信源，七天内交付，仅研究”。"),
    node("div", { class: "actions" }, generate), draftNotes,
    node("div", { class: "two" }, field("每七天预算上限（元）", limit), field("启动频次", schedule)),
    field("每项任务的交付时限", resultWindow),
    field("委托到期日", expiry, "选用对外代办时必须填写。到期日按当前时区计算。"),
    field("工作范围", workMode), sources.ui, factPicker, scope.ui,
    node("div", { class: "actions" }, previewButton, approve), evidence);
  form.addEventListener("input", (event) => {
    invalidatePreview();
    if (event.target === objective) draftNotes.replaceChildren();
  });
  workMode.addEventListener("change", updateScope);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(event.submitter || previewButton, async () => {
      invalidatePreview();
      const selected = scope.entries.filter(({ allowed }) => allowed.checked);
      const allowedActions = selected.map(({ capability, maxDaily }) => ({
        channelId: capability.channelId, accountId: capability.accountId, destination: capability.destination,
        form: capability.form, action: capability.action, visibility: capability.visibility,
        maxDaily: Number(maxDaily.value), risk: "low",
      }));
      const requiredOutcomes = selected.flatMap(({ capability, required }, index) => required.checked ? [{
        id: `${capability.channelId}:${capability.action}:${index + 1}`,
        channelId: capability.channelId, outcome: capability.visibility === "public" ? "public" : "restricted",
      }] : []);
      const expiresAt = expiry.value ? new Date(`${expiry.value}T23:59:59`).toISOString() : null;
      const sourceIds = sources.controls.filter(({ checkbox }) => checkbox.checked).map(({ checkbox }) => checkbox.value);
      const selectedClaims = facts.filter(({ control }) => control.checked).map(({ id }) => id);
      if (selectedClaims.length > 50) throw localError("每条委托最多选择 50 条已核事实。");
      const input = {
        objective: objective.value.trim().replace(/\s+/gu, " "),
        ...(workMode.value === "standard" ? {} : { workMode: workMode.value }),
        ...(selectedClaims.length ? { trustScope: { claimIds: selectedClaims } } : {}),
        requiredOutcomes, allowedActions, sources: sourceIds, expiresAt, resultWindowMs: resultWindow.value ? Number(resultWindow.value) : null,
        optionalTargets: [...new Set(allowedActions.map(({ channelId }) => channelId))],
        budget: { currency: "CNY", limitMinor: Math.round(Number(limit.value) * 100) },
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        schedule: schedule.value ? { intervalMs: Number(schedule.value) } : {},
      };
      if (!input.objective) throw localError("请输入经营目标。");
      if (new Set(requiredOutcomes.map(({ channelId }) => channelId)).size !== requiredOutcomes.length) {
        throw localError("同一阵地请选择一项必须交付的目标。");
      }
      if (selected.length && !expiresAt) throw localError("已选择代办目标，请填写委托到期日。");
      if (expiresAt && new Date(expiresAt) <= new Date()) throw localError("到期日必须在当前时间之后。");
      const submittedRevision = revision;
      const result = await http("/mandates/preview", input);
      if (submittedRevision !== revision || !form.isConnected) return;
      const preview = result.preview ?? result;
      const checked = list(preview.targets);
      if (selected.length && (checked.length !== selected.length || checked.some(({ ready }) => ready !== true))) {
        previewInput = null;
        key = null;
        approve.disabled = true;
        evidence.replaceChildren(
          node("p", { class: "message error form-message", role: "status" }, "有代办目标未通过资格核验。刷新工作台或取消该目标后再预览。"),
          dataDetail("查看本次委托预览", preview));
        return;
      }
      previewInput = input;
      key = crypto.randomUUID();
      approve.disabled = false;
      evidence.replaceChildren(
        node("p", { class: "message form-message", role: "status" }, selected.length
          ? `预览已生成。已选 ${selected.length} 个准确代办动作，${expiry.value} 当地时间到期。请核对目标、范围和预算后签发。`
          : `预览已生成。${workMode.value === "standard" ? "没有选用对外代办。" : workModes[workMode.value] + "。"} 请核对目标、范围和预算后签发。`),
        dataDetail("查看本次委托预览", preview));
    });
  });
  approve.addEventListener("click", () => run(approve, async () => {
    if (!previewInput || !key) return;
    await http("/mandates", previewInput, { idempotencyKey: key });
    showMessage("经营委托已保存。");
    await refresh();
  }));
  return form;
}

function quickStopForm(mandates, now) {
  const owned = mandates.filter(row => row.ownerId === model.session?.ownerId && row.state === "active" &&
    (row.expiresAt == null || Number(row.expiresAt) > now));
  if (!owned.length) return empty("暂无可停发的委托");
  const selected = selectBox("stopMandate", [["", "请选择一条委托"], ...owned.map(row => [row.id,
    `${label(row.objective) || "经营委托"} · ${row.id}`])]);
  const command = node("input", { name: "stopCommand", maxlength: 20, required: "", autocomplete: "off", placeholder: "停发" });
  const submit = node("button", { type: "submit", class: "quiet danger" }, "撤销所选委托");
  let request;
  const form = node("form", { class: "form" }, field("停发哪条委托", selected),
    field("输入停发", command, "提交后立即撤销该版本的后续授权。在途动作按原回执核对。"),
    node("div", { class: "actions" }, submit));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(submit, async () => {
      const { id, revision } = stopMandateSelection(command.value, selected.value, mandates, model.session?.ownerId);
      if (request?.id !== id || request.revision !== revision) request = { id, revision, key: crypto.randomUUID() };
      await http(`/mandates/${encodeURIComponent(id)}/revoke`, { reason: "owner_revoked" }, { version: revision, idempotencyKey: request.key });
      await refresh();
      showMessage("已撤销所选委托，新动作停止放行。在途及已发布内容保留原记录。");
    });
  });
  return form;
}

function showMandates(data) {
  const mandates = list(data.mandates);
  return [
    heading("经营委托", "给主 BOT 一个目标、预算和可执行范围。预览后签发，之后可随时撤销。"),
    node("div", { class: "columns" },
      node("div", { class: "stack" }, panel("我的委托", feed(mandates, (row) => {
        const id = identifier(row);
        const status = row.state ?? row.status;
        const actions = node("div", { class: "actions" },
          id && button("查看结果", () => openDetail(`/mandates/${encodeURIComponent(id)}/outcomes`, "委托结果", id)),
          id && status === "active" && button("撤销委托", async () => {
            if (!window.confirm("撤销后会停止这项委托的后续动作。现在撤销吗？")) return;
            await http(`/mandates/${encodeURIComponent(id)}/revoke`, { reason: "owner_revoked" }, { version: row.revision ?? row.version });
            showMessage("经营委托已撤销。");
            await refresh();
          }, "quiet danger")
        );
        return item(label(row.objective ?? row.config?.objective ?? row.title) || id,
          date(row.nextRunAt ?? row.next_run_at), namedState(status), actions);
      }, empty("暂无经营委托", "保存后可在这里查看范围、下一次运行和结果。"))),
      panel("快速停发", quickStopForm(mandates, data.now ?? Date.now()))),
      node("div", { class: "stack" }, panel("建立委托", mandateForm(data)), mandateInventory(data))),
    renderDetail("委托结果"),
  ];
}

async function openDetail(path, title, id) {
  const value = await http(path);
  if (title === "周报依据") {
    const selected = list(value.reports).find(row => row.id === id);
    if (!selected) throw localError("未找到所选周期的周报，请刷新后重试。");
    model.details.set(title, { value: selected, id });
  } else {
    model.details.set(title, { value, id });
  }
  render();
  document.querySelector("#active-detail")?.scrollIntoView({ block: "nearest" });
}

function handoffBinding(task, channel) {
  return {
    taskRevision: task.revision ?? task.version, channelId: channel.channelId, accountId: channel.accountId,
    destination: channel.destination, form: channel.form, packageHash: channel.packageHash,
    visibility: channel.visibility ?? channel.expectedVisibility ?? "public",
  };
}

function ownerReceiptForm(task, channel, path) {
  const receipt = node("input", { name: "receipt", required: "", maxlength: "600", autocomplete: "off" });
  const url = node("input", { name: "url", type: "url", maxlength: "1500", autocomplete: "off", placeholder: "https://…" });
  const remote = node("input", { name: "remote", maxlength: "240", autocomplete: "off" });
  const minutes = node("input", { name: "ownerMinutes", type: "number", min: "0", max: "10080", step: "1" });
  const submit = node("button", { class: "button", type: "submit" }, "登记本人提交回执");
  const form = node("form", { class: "form" },
    field("平台回执或证据编号", receipt), field("平台地址（可选）", url), field("原站对象编号（可选）", remote), field("本次平台操作实际用时（分钟，可选）", minutes),
    node("div", { class: "actions" }, submit));
  let submitted;
  let requestId;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(submit, async () => {
      const receiptRef = receipt.value.trim();
      const targetUrl = url.value.trim();
      const remoteId = remote.value.trim();
      if (!receiptRef) throw localError("请填写实际平台回执或证据编号。");
      if (targetUrl && safeUrl(targetUrl)?.protocol !== "https:") throw localError("请输入原平台的 HTTPS 地址。");
      const input = { ...handoffBinding(task, channel), action: "record_owner_submission",
        publicationAction: channel.action ?? "publish", receiptRef,
        ...(minutes.value === "" ? {} : { ownerMinutes: minutes.valueAsNumber }),
        ...(targetUrl ? { url: targetUrl } : {}), ...(remoteId ? { remoteId } : {}) };
      const signature = JSON.stringify(input);
      if (submitted !== signature) {
        submitted = signature;
        requestId = crypto.randomUUID();
      }
      await http(`${path}/decisions`, input, { version: channel.revision, idempotencyKey: requestId });
      await openDetail(path, "任务详情", task.id);
      await refresh();
      showMessage("本人回执已登记。公开状态仍待独立核验。");
    });
  });
  return form;
}

function taskHandoffs(task) {
  const path = `/tasks/${encodeURIComponent(task.id)}`;
  const mandate = list(model.dashboard?.mandates).find(row => row.id === task.mandateId);
  const stillActive = mandate?.ownerId === model.session?.ownerId && mandate?.state === "active" &&
    mandate.revision === task.mandateRevision && !["cancelled", "expired", "paused"].includes(task.state) &&
    (task.deadlineAt == null || Date.now() < Number(task.deadlineAt)) &&
    (mandate.expiresAt == null || Date.now() < Number(mandate.expiresAt));
  const channels = list(task.channels).filter(channel => !channel.machinePublish &&
    ["manual", "owner_confirmation", "handoff"].includes(channel.plannedDisposition ?? channel.disposition));
  if (!channels.length) return node("p", { class: "description" }, "当前没有需要本人操作的阵地。");
  return node("div", { class: "stack" }, channels.map(channel => {
    const signed = list(task.steps).find(step => step.kind === "review" && step.state === "succeeded" &&
      step.input?.channelId === channel.channelId && step.output?.packageHash === channel.packageHash);
    const exact = signed && channel.reviewState === "passed" && [channel.packageHash, channel.reportHash]
      .every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) &&
      [channel.accountId, channel.destination, channel.form].every(label);
    const currentState = channel.ownerSubmissionId ? "owner_reported" : channel.disposition;
    const handoff = signed?.output?.handoff;
    const named = list(model.dashboard?.channels).find(row => row.channelId === channel.channelId);
    const details = handoff && node("details", { class: "details" }, node("summary", {}, "查看这次提交的已核稿件"),
      label(handoff.title) && node("p", { class: "description" }, label(handoff.title)),
      node("pre", { class: "detail-data", tabindex: 0 }, label(handoff.body)));
    let action;
    if (channel.ownerSubmissionId) {
      action = node("p", { class: "description" }, "已登记平台回执。公开核验将单独入账。", label(channel.ownerSubmissionRef) && ` 回执 ${label(channel.ownerSubmissionRef)}`);
    } else if (!exact) {
      action = node("p", { class: "description" }, "等待这个账号的准确稿件完成独立终检。此时无需本人操作。");
    } else if (!stillActive) {
      action = node("p", { class: "description" }, "当前委托或任务已停止，无法办理新交接。");
    } else if ((channel.plannedDisposition ?? channel.disposition) === "owner_confirmation" && !channel.confirmationId) {
      const requestId = crypto.randomUUID();
      action = node("div", { class: "actions" }, button("确认这份交接", async () => {
        if (!window.confirm("请核对账号、目的地和稿件。接下来仍需你在平台完成本人的确认动作。")) return;
        await http(`${path}/decisions`, { ...handoffBinding(task, channel), action: channel.action ?? "publish" },
          { version: channel.revision, idempotencyKey: requestId });
        await openDetail(path, "任务详情", task.id);
        await refresh();
        showMessage("交接已确认，请在平台完成本人操作。");
      }, "button"), navigateLink("云浏览器", "browser"));
    } else {
      action = node("div", { class: "stack" },
        node("p", { class: "description" }, "在原平台完成本人提交后，把实际回执登记在这里。"),
        ownerReceiptForm(task, channel, path));
    }
    const card = panel(channelName(named) || channel.channelId, node("div", { class: "stack" },
      node("p", { class: "description" }, [channel.accountId, channel.destination, channel.form].filter(Boolean).join(" · ")),
      details, action), node("span", { class: "tag" }, namedState(currentState)));
    card.dataset.channelId = channel.channelId;
    return card;
  }));
}

function continueTruncatedDraft(task, detail = false) {
  return button("分批续修私稿", async () => {
    const path = `/tasks/${encodeURIComponent(task.id)}`;
    await http(path + "/controls", { action: "retry_truncated_draft" }, { version: task.revision });
    if (detail) await openDetail(path, "任务详情", task.id);
    await refresh();
    showMessage("已按原委托和预算分批续修，原失败记录已保留。");
  });
}

function reviewedRevision(task) {
  const article = node("div", { class: "stack", "aria-live": "polite" });
  const opener = button("打开私有修订稿", async () => {
    const value = await http(`/tasks/${encodeURIComponent(task.id)}/revision-preview`);
    if (!article.isConnected) return;
    const counts = value.firstReview;
    const results = [[counts.blocker, "项阻断"], [counts.major, "项严重"], [counts.minor, "项轻微"], [counts.suggestion, "项建议"]]
      .filter(([count]) => count > 0).map(([count, name]) => count + name).join("、") || "未记录问题";
    const close = button("收起修订稿", () => {
      article.replaceChildren();
      opener.hidden = false;
      opener.focus();
    });
    const title = node("h3", { tabindex: -1 }, value.title);
    article.replaceChildren(title, node("p", { class: "description" },
      `已完成 ${value.editedBatches} 批修订，共 ${value.characters} 字（不计空白）。初审记录：${results}。`),
      value.summary && node("p", {}, value.summary), node("pre", { class: "detail-data", tabindex: 0 }, value.body), close);
    opener.hidden = true;
    title.focus();
  });
  return panel("私有修订稿 · 终审未完成", node("div", { class: "stack" },
    node("p", { class: "description" }, "原稿编辑曾因输出截断而停止。分批修订后，终审输出再次截断，尚未取得最终批准。"),
    opener, article));
}

function partialTaskEvidence(task) {
  if (task.canReadRevisionPreview) return reviewedRevision(task);
  if (task.state !== "partial") return null;
  if (task.canRetryTruncatedDraft) return panel("私稿编辑中断", node("div", { class: "stack" },
    node("p", { class: "description" }, "上一轮编辑达到输出长度上限，原稿和已审核范围已保留。"),
    continueTruncatedDraft(task, true)));
  const failed = [...list(task.steps)].reverse().find(step => step.state === "failed" && step.output?.code);
  if (!failed) return null;
  const code = failed.output.code;
  const messages = { MODEL_OUTPUT_TRUNCATED: "模型输出达到了本次长度上限。",
    NATIVE_ARTICLE_NOT_APPROVED: "稿件尚未通过独立审核。", BUDGET_EXCEEDED: "剩余预算不足以预留下一次请求。" };
  return panel("未完成原因", node("p", { class: "description" }, messages[code] ?? errorMessages[code] ?? "本次执行已停止。", `（${code}）`));
}

function taskEvidence(task) {
  const costs = list(model.dashboard?.costs).filter(item => item.taskId === task.id);
  const observations = list(task.observations);
  const privateWork = [...list(task.steps)].reverse().find(row => row.output?.privateWork)?.output.privateWork;
  const privateResult = privateWork?.kind === "draft" && task.state === "succeeded" && privateWork.state === "prepared" && privateWork.body ? panel("私有草稿", node("div", { class: "stack" },
    node("h3", {}, privateWork.title), node("pre", { class: "detail-data", tabindex: 0 }, privateWork.body))) :
    privateWork?.kind === "research" ? panel("研究结果", feed(list(privateWork.claims), claim => item(
      claim.claimId, "已核事实", "", publicLink(claim.sourceUrl, "读取来源")), empty("暂无可用已核事实", "登记明确来源后再补充证据。"))) : null;
  return node("div", { class: "stack" },
    privateResult, partialTaskEvidence(task), taskHandoffs(task), costDetails(costs),
    observations.length > 0 && node("details", { class: "details" }, node("summary", {}, "复测回执与进度"),
      node("ul", { class: "list" }, observations.map(row => item(
        `T+${row.day}`, [date(row.dueAt), row.paired != null && `${row.paired} 条可配对样本`, label(row.evidenceRef)].filter(Boolean).join(" · "),
        namedState(row.state))))));
}

function renderDetail(title) {
  const record = model.details.get(title);
  if (!record) return null;
  const result = panel(title, node("div", { class: "stack" },
    node("p", { class: "description" }, record.id),
    title === "任务详情" && taskEvidence(record.value), dataDetail("展开完整账本", record.value)),
  button("关闭", () => {
    model.details.delete(title);
    render();
  }));
  result.id = "active-detail";
  result.style.marginTop = "1rem";
  return result;
}

function eventForm(mandates) {
  if (!mandates.length) return empty("还没有可接收信源的委托");
  const mandate = selectBox("mandate", mandates.map((row) => [identifier(row), label(row.objective ?? row.config?.objective) || identifier(row)]));
  const title = node("input", { name: "title", required: "", maxlength: "200" });
  const text = node("textarea", { name: "text", required: "", maxlength: "1600" });
  const source = node("input", { name: "source", type: "url", autocomplete: "off", placeholder: "https://…" });
  const submit = node("button", { class: "button", type: "submit" }, "登记信源");
  const form = node("form", { class: "form" }, field("经营委托", mandate),
    field("主题", title), field("发生了什么", text), field("公开来源链接", source), node("div", { class: "actions" }, submit));
  let signature;
  let externalId;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(submit, async () => {
      const input = {
        mandateId: mandate.value, title: title.value.trim().replace(/\s+/gu, " "),
        text: text.value.trim().replace(/\s+/gu, " "),
        ...(source.value.trim() ? { sourceUrl: source.value.trim() } : {}),
      };
      if (!input.title || !input.text) throw localError("请补齐主题和事实内容。");
      if (input.sourceUrl) {
        const url = safeUrl(input.sourceUrl);
        if (!url || url.protocol !== "https:") throw localError("来源需填写公开 HTTPS 链接。");
      }
      if (signature !== JSON.stringify(input)) {
        signature = JSON.stringify(input);
        externalId = crypto.randomUUID();
      }
      await http("/events", { ...input, externalId }, { idempotencyKey: externalId });
      showMessage("信源已登记。请查看任务接收后的实际状态。");
      await refresh();
    });
  });
  return form;
}

function taskControls(id, row) {
  const state = row.state ?? row.status;
  const action = async (name, text) => {
    if (name === "cancel" && !window.confirm("取消后，这项任务不会再领取新的工作。现在取消吗？")) return;
    await http(`/tasks/${encodeURIComponent(id)}/controls`, { action: name }, { version: row.revision ?? row.version });
    showMessage(text);
    await refresh();
  };
  const actions = [button("看详情", () => openDetail(`/tasks/${encodeURIComponent(id)}`, "任务详情", id))];
  if (state === "partial" && row.canRetryTruncatedDraft === true) {
    actions.push(continueTruncatedDraft(row));
  }
  if (state === "paused" || state === "waiting_input" && row.canResume !== false) {
    actions.push(button("继续", () => action("resume", "任务已恢复。")));
  }
  if (["running", "queued", "waiting_input", "needs_reconcile", "active", "ready"].includes(state)) actions.push(button("暂停", () => action("pause", "任务已暂停领取新工作。")));
  if (["running", "queued", "active", "paused", "waiting_input", "needs_reconcile", "ready"].includes(state)) {
    actions.push(button("取消", () => action("cancel", "任务已取消。"), "quiet danger"));
  }
  return node("div", { class: "actions" }, actions);
}

function showTasks(data) {
  const tasks = list(data.tasks);
  const unread = list(data.notifications).filter(row => ["pending", "delivered", "failed"].includes(row.state)).slice(0, 8);
  const reminders = unread.length ? panel("待查阅提醒", feed(unread, row => item(
    notificationTitle(row), label(row.summary), namedState(row.state),
    button("标记为已读", async () => {
      await http(`/notifications/${encodeURIComponent(row.id)}/ack`, {});
      await refresh();
      showMessage("提醒已标记为已读。");
    })))) : null;
  return [
    heading("任务", "查看实际状态、当前阻塞、回执和已发出的工作。"),
    node("div", { class: "columns" },
      panel("任务列表", feed(tasks, (row) => item(label(row.title) || identifier(row),
        [identifier(row), date(row.createdAt ?? row.updatedAt)].filter(Boolean).join(" · "),
        namedState(row.state ?? row.status), identifier(row) && taskControls(identifier(row), row)),
      empty("暂无任务", "信源或计划触发后会显示对应任务。"))),
      node("div", { class: "stack" }, panel("登记一个真实信源", eventForm(list(data.mandates).filter((row) => (row.state ?? row.status) === "active"))), reminders)),
    renderDetail("任务详情"),
  ];
}

async function loadBrowser() {
  model.browser = await http("/browser");
}

function activeLease(id) {
  return list(model.browser?.leases).find((row) => row.id === id && row.state === "active");
}

function closeLocalViewer() {
  if (!model.viewer) return;
  model.viewer.frame.src = "about:blank";
  model.viewer = null;
}

async function openViewer(leaseId) {
  const result = await http(`/browser/leases/${encodeURIComponent(leaseId)}/connect`, {});
  if (result.viewerPath !== "/bot-browser/connect" ||
      typeof result.ticket !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(result.ticket)) {
    throw localError("网关没有返回当前工作台的接管票据。");
  }
  if (viewName() !== "browser") return;
  const frameName = `bot-viewer-${crypto.randomUUID()}`;
  const frame = node("iframe", {
    name: frameName, class: "viewer", title: "云浏览器接管画面", referrerpolicy: "no-referrer",
    sandbox: "allow-scripts allow-same-origin",
  });
  closeLocalViewer();
  model.viewer = { frame, leaseId };
  render();
  const form = node("form", {
    action: result.viewerPath, method: "POST", target: frameName, autocomplete: "off", hidden: "",
  }, node("input", { name: "ticket", type: "hidden", value: result.ticket }));
  document.body.append(form);
  form.submit();
  form.remove();
}

async function releaseViewer(leaseId) {
  const result = await http(`/browser/leases/${encodeURIComponent(leaseId)}/release`, { reason: "owner_returned" });
  if (model.viewer?.leaseId === leaseId) closeLocalViewer();
  showMessage(result.gatewayCut === "pending_gateway_check" ? "接管权限已收回，网关正在重新核对连接。" : "已交还云浏览器。");
  await loadBrowser();
  render();
}

function browserForm(targets) {
  const choose = selectBox("target", targets.map(({ id, label: title, accountId, taskId }) =>
    [id, [title, accountId, taskId].filter(Boolean).join(" · ")]));
  const reason = selectBox("reason", Object.entries(browserReasons).slice(0, 3));
  const submit = node("button", { type: "submit", class: "button" }, "申请 10 分钟接管");
  const form = node("form", { class: "form" },
    field("获准工位", choose), field("本次用途", reason), node("div", { class: "actions" }, submit));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(submit, async () => {
      await http("/browser/leases", { targetId: choose.value, reason: reason.value });
      await loadBrowser();
      render();
      showMessage("接管租约已签发。点“打开操作画面”进入工位。");
    });
  });
  return form;
}

function showBrowser() {
  const result = model.browser;
  const resultTargets = list(result?.targets);
  const leases = list(result?.leases);
  const control = result?.configured && button(result.stopped ? "恢复接管入口" : "停止全部接管", async () => {
    if (!result.stopped && !window.confirm("停止后会收回本工作区的接管租约。现在停止吗？")) return;
    const reply = await http(result.stopped ? "/browser/resume" : "/browser/stop", { reason: "owner_stop" });
    if (!result.stopped) closeLocalViewer();
    model.browser = reply;
    showMessage(result.stopped ? "接管入口已恢复，请按需申请新租约。" :
      reply.gatewayCut === "pending_gateway_check" ? "接管权限已停止，网关正在重新核对连接。" : "云浏览器接管已停止。");
    render();
  }, result.stopped ? "quiet" : "quiet danger");
  const headline = heading("云浏览器", "用管理员会话接管已登记的专属工位。登录验证和平台确认由本人完成。", control);
  if (!result) return [headline, empty("正在读取云浏览器状态")];
  const current = model.viewer;
  const reconnect = current && button("重新打开画面", async () => {
    const previous = current.leaseId;
    closeLocalViewer();
    await loadBrowser();
    render();
    if (!activeLease(previous)) throw localError("接管租约已经结束，请重新申请。");
    await openViewer(previous);
  });
  if (reconnect) {
    reconnect.id = "viewer-reconnect";
    reconnect.hidden = !current.ended;
  }
  const viewer = current && panel("当前操作画面", current.frame, node("div", { class: "actions" },
    reconnect, button("交还控制", () => releaseViewer(current.leaseId))));
  if (viewer) viewer.classList.add("viewer-panel");
  const apply = result.stopped ? empty("接管入口已停止", "恢复后可重新申请，新租约不会恢复旧连接。") :
    leases.some((row) => row.state === "active") ? empty("工位已有接管租约", "交还或到期后可重新申请。") :
    result.configured ? browserForm(resultTargets) :
      empty("尚未配置云浏览器", "当前没有已连接的专属工位。工作台中的委托和任务仍然可用。");
  const audit = list(result.audit);
  return [headline, viewer, node("div", { class: "columns" }, node("div", { class: "stack" },
    panel("申请接管", apply),
    panel("接管租约", feed(leases, (row) => {
      const title = resultTargets.find((target) => target.id === row.targetId)?.label || row.targetId;
      const actions = row.state === "active" && row.currentDevice && !current && node("div", { class: "actions" },
        !row.viewerConnected && !row.viewerPending && button("打开操作画面", () => openViewer(row.id), "button"),
        row.viewerConnected && node("span", { class: "evidence" }, "该租约已有操作连接。"),
        row.viewerPending && node("span", { class: "evidence" }, "正在连接操作画面。"),
        button("交还控制", () => releaseViewer(row.id)));
      const subtitle = [browserReasons[row.reason], row.state === "active" && date(row.expiresAt) && `${date(row.expiresAt)} 到期`,
        browserReasons[row.endReason], row.state === "active" && !row.currentDevice && "由另一设备持有"].filter(Boolean).join(" · ");
      return item(title, subtitle, namedState(row.state), actions);
    }, empty("暂无接管租约", "接管记录只包含工位、用途、时限及连接状态。")))),
  panel("接管审计", feed(audit, (row) => item(auditNames[row.action] || "接管事件",
    [date(row.timestamp), browserReasons[row.reason], row.targetId].filter(Boolean).join(" · "), ""),
  empty("暂无接管审计事件"))))];
}

function render() {
  const view = viewName();
  model.view = view;
  document.querySelector("#logout").hidden = !model.session;
  for (const anchor of document.querySelectorAll(".primary-nav a")) {
    if (anchor.hash === `#${view}`) anchor.setAttribute("aria-current", "page");
    else anchor.removeAttribute("aria-current");
  }
  if (!model.session) {
    const body = model.dashboard ? empty("正在恢复会话") : empty("请登录后使用", "工作台使用鹏经理管理员会话。");
    content.replaceChildren(heading("经营工作台", "", loginLink()), body);
    return;
  }
  if (!model.dashboard) {
    content.replaceChildren(heading("经营工作台"), empty("暂无可读取的工作台数据", "刷新以重试读取。"));
    return;
  }
  const data = model.dashboard;
  const viewsByName = { home: showHome, mandates: showMandates, tasks: showTasks, browser: showBrowser };
  content.replaceChildren(...viewsByName[view](data).filter(Boolean));
}

window.addEventListener("hashchange", async () => {
  if (viewName() !== "browser") closeLocalViewer();
  showMessage("");
  render();
  if (viewName() === "browser" && model.session) {
    try {
      await loadBrowser();
      if (!model.viewer) render();
    } catch (error) {
      showMessage(error.message, true);
    }
  }
});
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== model.viewer?.frame.contentWindow ||
      event.data?.type !== "pengmanager-browser-ended") return;
  const viewer = model.viewer;
  const reason = event.data.reason === "worker_unavailable" ? "无法连接远端工位。请核对工位状态后重试。" : "操作画面已断开。";
  showMessage(reason, true);
  if (viewer) {
    viewer.ended = true;
    viewer.frame.setAttribute("title", "云浏览器画面已断开");
    const reconnect = document.querySelector("#viewer-reconnect");
    if (reconnect) reconnect.hidden = false;
  }
});
refreshButton.addEventListener("click", () => {
  if (editedForm?.isConnected && !window.confirm("刷新会清除当前未提交的表单内容。继续刷新吗？")) return;
  showMessage("");
  refresh();
});
window.addEventListener("focus", () => {
  if (!model.viewer && document.activeElement === document.body) refresh({ preserveEdits: true });
});
window.setInterval(() => {
  if (model.viewer && viewName() === "browser") refresh();
}, 15_000);
await refresh();
