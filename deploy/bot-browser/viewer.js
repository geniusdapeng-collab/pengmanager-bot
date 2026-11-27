const status = document.querySelector("#status");
const screen = document.querySelector("#screen");
const actions = document.querySelector("#actions");
const keyboard = document.querySelector("#keyboard");
const input = document.querySelector("#enter-text");
const toggle = document.querySelector("#keyboard-toggle");
let lastActivity = 0;
let rfb;
let ended = false;

function finish(text, reason) {
  if (ended) return;
  ended = true;
  input.value = "";
  keyboard.hidden = true;
  actions.hidden = true;
  status.textContent = text;
  window.parent.postMessage({ type: "pengmanager-browser-ended", reason }, window.location.origin);
}

function activity(event) {
  if (!event?.isTrusted || ended || Date.now() - lastActivity < 12_000) return;
  lastActivity = Date.now();
  fetch("/bot-browser/activity", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "",
  }).catch(() => {
    // The gateway fails closed independently of page activity when it cannot confirm control.
    lastActivity = 0;
  });
}

function sendText(event) {
  if (ended || !rfb || !input.value) return;
  activity(event);
  for (const character of input.value) {
    const code = character.codePointAt(0);
    const keysym = code <= 0xff ? code : 0x01000000 | code;
    rfb.sendKey(keysym);
  }
  input.value = "";
}

function sendKey(event, keysym, key) {
  if (ended || !rfb) return;
  activity(event);
  rfb.sendKey(keysym, key);
}

try {
  const { default: RFB } = await import("/bot-browser/lib/core/rfb.js");
  const uri = new URL("/bot-browser/socket", location.origin);
  uri.protocol = "wss:";
  rfb = new RFB(screen, uri.href, { shared: false });
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.resizeSession = false;
  rfb.background = "#202b21";
  rfb.showDotCursor = true;
  rfb.addEventListener("connect", () => {
    status.textContent = "工位已连接 · 仅当前操作者可输入";
    actions.hidden = false;
  });
  rfb.addEventListener("disconnect", ({ detail }) => {
    finish(detail.clean ? "操作画面已结束。返回工作台可交还租约。" : "工位连接中断。请返回工作台核对状态。",
      detail.clean ? "viewer_closed" : "worker_unavailable");
  });
  rfb.addEventListener("credentialsrequired", () => {
    finish("工位的内网画面配置不符，连接已关闭。", "worker_unavailable");
    rfb.disconnect();
  });
} catch {
  finish("远端画面组件不可用。请核对工位状态。", "worker_unavailable");
}

for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
  document.addEventListener(type, activity, { passive: true, capture: true });
}
toggle.addEventListener("click", () => {
  keyboard.hidden = !keyboard.hidden;
  toggle.setAttribute("aria-expanded", String(!keyboard.hidden));
  if (!keyboard.hidden) {
    rfb.blur();
    input.focus();
  } else {
    input.value = "";
    rfb.focus();
  }
});
document.querySelector("#disconnect").addEventListener("click", () => {
  finish("操作画面已断开。返回工作台可交还租约。", "viewer_closed");
  rfb.disconnect();
});
document.querySelector("#type").addEventListener("click", sendText);
document.querySelector("#mask").addEventListener("click", (event) => {
  const masked = input.type !== "password";
  input.type = masked ? "password" : "text";
  event.currentTarget.setAttribute("aria-pressed", String(masked));
  event.currentTarget.textContent = masked ? "显示文字" : "隐藏文字";
  input.focus();
});
document.querySelector("#backspace").addEventListener("click", (event) => sendKey(event, 0xff08, "Backspace"));
document.querySelector("#enter").addEventListener("click", (event) => sendKey(event, 0xff0d, "Enter"));
input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  sendText(event);
});
input.addEventListener("paste", (event) => event.preventDefault());
window.addEventListener("pagehide", () => {
  input.value = "";
  if (rfb && !ended) rfb.disconnect();
});
