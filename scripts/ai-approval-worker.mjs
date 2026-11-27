import { constants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DeepSeekAdapter } from "../src/adapters/deepseek.mjs";
import { DEEPSEEK_OFFICIAL_BASE_URL } from "../src/model-routing/registry.mjs";
import { resolveDeepSeekApiKey } from "../src/adapters/auth.mjs";
import { aiApprovalKeyId, aiApprovalWorkerAuthorization, judgeAiApproval, signAiApproval } from "../src/services/ai-approval.mjs";
import { requestAiApprovalWorker } from "../src/services/ai-approval-worker-client.mjs";

const MODE = 0o600;
const args = process.argv.slice(2);
const command = args.shift();
const opts = new Map();
while (args.length) {
  const option = args.shift();
  if (!["--profile", "--origin"].includes(option) || opts.has(option) || !args[0] || args[0].startsWith("--")) {
    throw new Error("用法：ai-approval-worker.mjs public-key|doctor|run|once [--profile PATH] [--origin HTTPS_ORIGIN]");
  }
  opts.set(option, args.shift());
}
if (!["public-key", "doctor", "run", "once"].includes(command)) throw new Error("请选择 public-key、doctor、run 或 once。");
if (command !== "public-key" && !opts.has("--origin")) {
  throw new Error("请用 --origin 明确指定审核工位要访问的站点。");
}
const profile = resolve(opts.get("--profile") || join(homedir(), "Library", "Application Support", "PengManager", "ai-approval"));
await mkdir(profile, { mode: 0o700, recursive: true });
const stat = await lstat(profile);
if (!stat.isDirectory() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) {
  throw new Error("AI 审核工位目录必须为当前用户私有目录。");
}

async function privateFile(file) {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const item = await handle.stat();
      if (!item.isFile() || item.mode & 0o077 || item.size > 65_536 || (process.getuid && item.uid !== process.getuid())) {
        throw new Error("AI 审核工位文件不是当前用户的私有普通文件。");
      }
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

async function savePrivate(file, content, exclusive = false) {
  const output = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const handle = await open(output, "wx", MODE);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  if (!exclusive) await rename(output, file);
}

const keyFile = join(profile, "reviewer-private.pem");
let keyText = await privateFile(keyFile);
if (!keyText && command === "public-key") {
  const generated = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
  try { await savePrivate(keyFile, generated, true); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  keyText = await privateFile(keyFile);
}
if (!keyText) throw new Error("请先生成专用 AI 审核工位公钥。");
const key = createPrivateKey(keyText);
keyText = null;
const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url");
const keyId = aiApprovalKeyId(publicKey);
if (command === "public-key") {
  console.log(JSON.stringify({ publicKey }));
  process.exit(0);
}

const configured = opts.get("--origin");
const endpoint = new URL(configured);
const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname);
if ((endpoint.protocol !== "https:" && !(loopback && endpoint.protocol === "http:")) || endpoint.username || endpoint.password
    || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("审核工位需要确切 HTTPS origin 或本机回环测试地址。");
const origin = endpoint.origin;
const apiKey = resolveDeepSeekApiKey();
const baseUrl = process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || DEEPSEEK_OFFICIAL_BASE_URL;
const model = new DeepSeekAdapter({ apiKey, maxRetries: 0, baseUrl });

async function checkAccount() {
  if (new URL(baseUrl).origin !== DEEPSEEK_OFFICIAL_BASE_URL) return { checked: false, available: null };
  const response = await fetch(`${DEEPSEEK_OFFICIAL_BASE_URL}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(12_000), redirect: "error",
  });
  const balance = await response.json();
  if (!response.ok || typeof balance.is_available !== "boolean") throw new Error("AI 审核模型的余额状态未能核实。");
  return { checked: true, available: balance.is_available };
}

if (command === "doctor") {
  const account = await checkAccount();
  console.log(JSON.stringify({ ...account, reviewerKeyId: keyId, origin }));
  process.exit(account.available === false ? 1 : 0);
}
const stateFile = join(profile, "outbox.json");
const persist = (state) => savePrivate(stateFile, JSON.stringify(state));
const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => stop.abort());

function workerRequest(action, body) {
  const auth = aiApprovalWorkerAuthorization(key, keyId, origin, action, body);
  return requestAiApprovalWorker({ origin, action, body, authorization: auth, signal: stop.signal });
}

async function report(entry) {
  const reply = await workerRequest(entry.action, entry.body);
  if (reply.reviewId !== entry.body.reviewId) throw new Error("审核任务回复的编号不匹配。");
  await persist(null);
  console.log(JSON.stringify({ reviewId: reply.reviewId, decision: reply.decision ?? null,
    unresolved: reply.unresolved === true, retryAt: reply.retryAt ?? null }));
  return Boolean(reply.retryAt);
}

async function work() {
  let pending = JSON.parse(await privateFile(stateFile) ?? "null");
  if (pending?.origin !== undefined && pending.origin !== origin) throw new Error("待对账工作单属于不同站点。");
  if (pending?.phase === "report") return report(pending);
  if (pending?.phase === "model") {
    const entry = { origin, phase: "report", action: "failed", body: { ...pending.body, code: "AI_WORKER_OUTCOME_UNKNOWN" } };
    await persist(entry);
    return report(entry);
  }
  if (!pending) {
    pending = { origin, phase: "claim", claimId: randomUUID() };
    await persist(pending);
  }
  const job = await workerRequest("claim", { claimId: pending.claimId });
  if (job.reviewId === null) return persist(null);
  if (job.reviewId !== job.order?.evidenceHash || typeof job.leaseId !== "string") throw new Error("审核工单回复的编号无效。");
  const identity = { reviewId: job.reviewId, leaseId: job.leaseId };
  await persist({ origin, phase: "model", body: identity });
  let decision;
  try { decision = await judgeAiApproval(job.order, model); }
  catch (error) {
    const code = /^[A-Z0-9_]{1,80}$/u.test(error?.code ?? "") ? error.code : "AI_WORKER_REVIEW_FAILED";
    const entry = { origin, phase: "report", action: "failed", body: { ...identity, code } };
    await persist(entry);
    return report(entry);
  }
  const proof = signAiApproval(decision, key, publicKey);
  const entry = { origin, phase: "report", action: "complete", body: { ...identity, proof } };
  await persist(entry);
  return report(entry);
}

if (command === "once") {
  await work();
} else {
  while (!stop.signal.aborted) {
    let backoff = 3000;
    try { if (await work()) backoff = 60_000; }
    catch (error) {
      const code = /^[A-Z0-9_]{1,80}$/u.test(error?.code ?? "") ? error.code : "AI_WORKER_TEMPORARILY_UNAVAILABLE";
      console.error(JSON.stringify({ code }));
      backoff = 15_000;
    }
    if (!stop.signal.aborted) {
      try { await delay(backoff, undefined, { signal: stop.signal }); }
      catch (error) { if (error.name !== "AbortError") throw error; }
    }
  }
}
