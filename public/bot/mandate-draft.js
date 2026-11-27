const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AMOUNT = "([0-9]{1,3}|[零〇一二两三四五六七八九十]{1,3})";
const UNIT = "(小时|天|日|周|星期)";
const countedCadence = String.raw`每(?:隔)?\s*${AMOUNT}\s*${UNIT}`;
const chineseDigits = "零一二三四五六七八九";
const explicitStop = /^(?:停发|停止发布|停止外发)[。.!！]?$/u;

function quantity(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  const normalized = value.replaceAll("两", "二").replaceAll("〇", "零");
  if (normalized.length === 1 && normalized !== "十") return chineseDigits.indexOf(normalized);
  const parts = normalized.split("十");
  if (parts.length !== 2 || parts.some(part => part.length > 1)) return NaN;
  return (parts[0] ? chineseDigits.indexOf(parts[0]) : 1) * 10 +
    (parts[1] ? chineseDigits.indexOf(parts[1]) : 0);
}

function interval(value, unit) {
  const duration = quantity(value) * (unit === "小时" ? HOUR : ["周", "星期"].includes(unit) ? 7 * DAY : DAY);
  return duration > 0 && duration <= 366 * DAY ? duration : undefined;
}

function picked(values, field, notices) {
  const unique = [...new Set(values)];
  if (unique.length <= 1 && !unique.includes(undefined)) return unique[0];
  notices.push(`${field}存在多种解释或超出可识别范围，请手动选择。`);
  return undefined;
}

function localDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  if (year < 2000 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  return date;
}

function dateInput(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function parseMandateDraft(raw, now = new Date()) {
  if (typeof raw !== "string") throw new Error("请填写经营目标。");
  const original = raw.trim().replace(/\s+/gu, " ");
  const objective = original.normalize("NFKC");
  if (!objective || objective.length > 1600) throw new Error("请填写 1 至 1600 字的经营目标。");
  if (explicitStop.test(original)) throw new Error("停发请使用旁边的撤销入口，并选中一条有效委托。");
  const notes = [];
  const cadence = [];
  if (/(?:每天|每日)/u.test(objective)) cadence.push(DAY);
  if (/(?:每周|每星期)/u.test(objective)) cadence.push(7 * DAY);
  if (/(?:按事件|事件触发|按需触发)/u.test(objective)) cadence.push(null);
  if (/(?:工作日|每月|每季度|(?:每天|每日)\s*(?:上午|中午|下午|晚上|早上|[\d一二两三四五六七八九十]{1,3}\s*点)|每周\s*[一二三四五六日天](?!\s*次)|(?:每天|每日|每周)\s*(?:最多|不超过|上限))/u.test(objective)) cadence.push(undefined);
  for (const match of objective.matchAll(new RegExp(String.raw`(?:每天|每日|每周|每星期)\s*${AMOUNT}\s*次`, "gu"))) {
    if (quantity(match[1]) !== 1) cadence.push(undefined);
  }
  for (const match of objective.matchAll(new RegExp(countedCadence, "gu"))) {
    cadence.push(interval(match[1], match[2]));
  }
  if (new RegExp(`(?:不要|不用|并非|不按)[^。;；，,]{0,5}(?:每天|每日|每周|每星期|事件触发|${countedCadence})`, "u").test(objective)) cadence.push(undefined);
  const delivery = [...objective.matchAll(new RegExp(String.raw`(?:(?:接单后|交付时限\s*(?:为|是|:)?|交付期限\s*(?:为|是|:)?)\s*${AMOUNT}\s*${UNIT}(?:内|前)?|${AMOUNT}\s*${UNIT}(?:之?内|之?前)\s*(?:交|提交|给我|给出|完成))`, "gu"))]
    .map(match => interval(match[1] ?? match[3], match[2] ?? match[4]));
  if (/(?:接单后半[天日]|半[天日]内\s*(?:交|提交|给我|给出|完成))/u.test(objective)) delivery.push(12 * HOUR);
  const expiry = [...objective.matchAll(/(?:委托到期(?:日)?|委托至|到期日|截止日期|有效至)\s*(?:为|是|到|:|至)?\s*(\d{4}-\d{1,2}-\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日?)/gu)]
    .map(match => localDate(match[1].replace(/[年月]/gu, "-").replace(/日$/u, "")));
  for (const match of objective.matchAll(new RegExp(String.raw`(?:委托期限|委托有效期|委托运行|运行|先试)\s*${AMOUNT}\s*(天|日|周|星期)`, "gu"))) {
    const duration = interval(match[1], match[2]);
    const date = new Date(now);
    if (duration) date.setDate(date.getDate() + duration / DAY);
    expiry.push(duration ? date : undefined);
  }
  const expiryDate = picked(expiry.map(date => date && dateInput(date) >= dateInput(now) ? dateInput(date) : undefined), "委托到期日", notes);
  const preference = [];
  const requestResearch = /(?:仅|只|先只)(?:做)?(?:研究|调查|调研)|不(?:用|做|要)?(?:出稿|起草|写稿)/u.test(objective);
  const requestDraft = /(?:仅|只|先只)(?:做|要|出)?(?:准备|起草|写稿|草稿)|(?:私下|私有|内部)(?:准备|起草|写稿|草稿)/u.test(objective);
  const refuseOutbound = /(?:不(?:要|用)?|别)(?:对外|自动)?(?:发布|外发)/u.test(objective);
  if (requestResearch) preference.push("research_only");
  if (requestDraft || (!requestResearch && refuseOutbound)) preference.push("draft_only");
  if (/(?:不要|不用|并非|不想)[^。;；，,]{0,4}(?:仅|只)(?:做|要|出)?(?:研究|调查|调研|准备|起草|写稿|草稿)/u.test(objective)) preference.push(undefined);
  const requestedExternal = /(?:发布|外发|上线|替换|撤回|代办|自动提交)/u.test(objective);
  const mentionsBudget = /(?:预算|上限|经费|额度|\d\s*(?:元|块钱)|[¥￥$]\s*\d)/u.test(objective);
  if (requestedExternal) notes.push("外发与代办范围由本人另行选择并签发。");
  if (mentionsBudget) notes.push("预算金额请在委托表中填写。");
  const intervalMs = picked(cadence, "启动频次", notes);
  const resultWindowMs = picked(delivery, "交付时限", notes);
  const workMode = picked(preference, "工作范围", notes);
  const ambiguous = notes.some(note => note.endsWith("请手动选择。"));
  return { objective: original, intervalMs, resultWindowMs, expiryDate, workMode, notes, ambiguous };
}

export function stopMandateSelection(command, selectedId, mandates, ownerId, now = Date.now()) {
  if (typeof command !== "string" || !explicitStop.test(command.trim())) {
    throw new Error("请输入准确命令“停发”。带多个目标或其他条件的表达请用委托列表分别办理。");
  }
  if (!selectedId) throw new Error("请明确选中一条需要停发的有效委托。");
  const candidates = mandates.filter(row => row.id === selectedId && row.ownerId === ownerId && row.state === "active" &&
    (row.expiresAt == null || Number(row.expiresAt) > now));
  const revision = candidates[0]?.revision;
  if (candidates.length !== 1 || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("无法定位当前设备选中的唯一有效委托版本，请刷新后重选。");
  }
  return { id: candidates[0].id, revision };
}
