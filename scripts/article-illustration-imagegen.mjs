import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { articleIllustrationStyleMarker, articleIllustrationStyleRule, isArticleIllustrationStyleYear } from "../public/article-illustration-style.js";
import { illustrationStatementBytes } from "../src/domain/article-illustrations.mjs";

const id = /^[A-Za-z0-9_.:-]{1,120}$/;
const digest = /^[a-f0-9]{64}$/;
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const execId = new RegExp(`^exec-${uuid}$`);
const threadId = new RegExp(`^${uuid}$`);
const maxImage = 50 * 1024 * 1024;

function requireFact(condition, message) {
  if (!condition) throw new Error(message);
}

function inside(root, file) {
  const location = relative(root, file);
  return Boolean(location) && !isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`);
}

async function regularFile(path, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    requireFact(info.isFile() && info.uid === process.getuid() && (info.mode & 0o022) === 0
      && info.size > 0 && info.size <= maximum, "输入必须是当前工作站所有者的有效普通文件。");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readBounded(path, maximum) {
  const file = await regularFile(path, maximum);
  try { return await file.readFile(); }
  finally { await file.close(); }
}

function parseWorkOrder(fields) {
  requireFact(fields?.schema === "pengmanager.article-illustration-work-order/v1"
    && typeof fields.planId === "string" && id.test(fields.planId)
    && typeof fields.slot?.id === "string" && id.test(fields.slot.id)
    && typeof fields.sourceHash === "string" && digest.test(fields.sourceHash)
    && fields.slot?.imageGeneration === true && Array.isArray(fields.production) && fields.production.includes("builtin-imagegen"),
  "请选择带有内置生图要求的对应文章工单。");
  const { styleYear } = fields;
  requireFact(styleYear === undefined || isArticleIllustrationStyleYear(styleYear) &&
    fields.visualStyle === articleIllustrationStyleRule(fields.slot.kind, styleYear), "工单的当代风格要求与登记策略不一致。");
  return { planId: fields.planId, slotId: fields.slot.id, sourceHash: fields.sourceHash,
    ...(styleYear === undefined ? {} : { styleYear }) };
}

async function completedImageGeneration(root, rolloutPath, receiptId, workOrder) {
  const sessions = await realpath(join(root, "sessions"));
  const rollout = await realpath(rolloutPath);
  requireFact(inside(root, sessions) && inside(sessions, rollout) && rollout.endsWith(".jsonl"),
    "只接受当前工作站 Codex sessions 目录中的原始会话回执。");
  const handle = await regularFile(rollout, 4 * 1024 * 1024 * 1024);
  const lines = createInterface({ input: handle.createReadStream({ autoClose: false }), crlfDelay: Infinity });
  let evidence;
  const marker = `PM-ILLUSTRATION ${workOrder.planId}/${workOrder.slotId} ${workOrder.sourceHash}`;
  try {
    for await (const line of lines) {
      if (!line.includes(receiptId) || !line.includes("image_gen.generation")) continue;
      const event = JSON.parse(line);
      const { type, item, thread_id } = event.payload || {};
      if (event.type !== "event_msg" || type !== "item_completed" || item?.type !== "Extension"
          || item.kind !== "image_gen.generation" || item.id !== receiptId) continue;
      requireFact(!evidence && item.status === "completed" && !item.failure && threadId.test(thread_id ?? "")
        && item.revisedPrompt?.includes(marker)
        && (workOrder.styleYear === undefined || item.revisedPrompt.includes(articleIllustrationStyleMarker(workOrder.styleYear))), "生图任务尚未完成，或其工具回执未绑定该文章图位。");
      evidence = { thread: thread_id, output: item.savedPath, resolvedModel: item.model ?? item.resolvedModel };
    }
  } finally {
    lines.close();
    await handle.close();
  }
  requireFact(evidence?.output, "在指定会话中未找到该次内置生图的完成回执。");
  const generatedRoot = await realpath(join(root, "generated_images"));
  requireFact(inside(root, generatedRoot), "生图目录已移出当前 Codex 工作站目录。");
  const expected = join(generatedRoot, evidence.thread, `${receiptId}.png`);
  requireFact(resolve(evidence.output) === expected && await realpath(expected) === expected,
    "实际图片必须是该生图回执直接保存的原始 PNG。");
  const resolvedModel = typeof evidence.resolvedModel === "string" && id.test(evidence.resolvedModel) ? evidence.resolvedModel : undefined;
  return { file: expected, resolvedModel };
}

export async function openImageGenerationSigner(root, { create }) {
  const directory = join(root, "pengmanager-article-illustration-signer");
  if (create) await mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  const directoryInfo = await lstat(directory);
  requireFact(directoryInfo.isDirectory() && directoryInfo.uid === process.getuid() && (directoryInfo.mode & 0o077) === 0,
    "配图签发密钥须在工作站所有者独占的 0700 目录。");
  const path = join(directory, "imagegen-ed25519.pem");
  if (create) {
    const { privateKey } = generateKeyPairSync("ed25519");
    await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const info = await lstat(path);
  requireFact(info.isFile() && (info.mode & 0o077) === 0, "配图私钥须是仅工作站所有者可读取的普通文件。");
  const privateKey = createPrivateKey(await readBounded(path, 4096));
  requireFact(privateKey.asymmetricKeyType === "ed25519", "配图签发密钥类型不正确。");
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return { privateKey, publicKey: der.toString("base64url"),
    producerKeyId: `pk-${createHash("sha256").update(der).digest("hex").slice(0, 32)}` };
}

async function main() {
  const { values } = parseArgs({ options: {
    "public-key": { type: "boolean" }, "work-order": { type: "string" },
    rollout: { type: "string" }, "receipt-id": { type: "string" }, out: { type: "string" },
  } });
  const root = await realpath(process.env.CODEX_HOME || join(homedir(), ".codex"));
  const rootInfo = await lstat(root);
  requireFact(rootInfo.isDirectory() && rootInfo.uid === process.getuid() && (rootInfo.mode & 0o022) === 0,
    "请从已授权的本机 Codex 用户会话执行。");
  if (values["public-key"]) {
    requireFact(Object.keys(values).length === 1, "公钥登记与签发回执请分开执行。");
    const { publicKey, producerKeyId } = await openImageGenerationSigner(root, { create: true });
    console.log(JSON.stringify({ publicKey, producerKeyId }));
    return;
  }
  requireFact(values["work-order"] && values.rollout && values.out && execId.test(values["receipt-id"] ?? ""),
    "传入 --work-order、--rollout、--receipt-id 和 --out，或使用 --public-key 读取登记公钥。");
  console.log(JSON.stringify(await exportImageGenerationReceipt(root, {
    workOrderPath: values["work-order"], rollout: values.rollout, receiptId: values["receipt-id"], out: values.out,
  })));
}

export async function exportImageGenerationReceipt(root, { workOrderPath, rollout, receiptId, out }) {
  requireFact(execId.test(receiptId), "内置生图需要准确的工具执行编号。");
  const order = parseWorkOrder(JSON.parse((await readBounded(await realpath(workOrderPath), 65_536)).toString("utf8")));
  const evidence = await completedImageGeneration(root, rollout, receiptId, order);
  const png = await readBounded(evidence.file, maxImage);
  const image = sharp(png, { limitInputPixels: 16_000_000, failOn: "error" });
  const info = await image.metadata();
  requireFact(info.format === "png" && info.width && info.height && (info.pages ?? 1) === 1, "内置生图原始回执必须对应单帧 PNG。");
  await image.stats();
  const statement = {
    source: "codex-imagegen", requestedProfile: "image2.5", toolReceiptId: receiptId, ...order,
    sha256: createHash("sha256").update(png).digest("hex"), bytes: png.length, width: info.width, height: info.height,
    ...(evidence.resolvedModel ? { resolvedModel: evidence.resolvedModel } : {}),
  };
  const { privateKey, producerKeyId } = await openImageGenerationSigner(root, { create: false });
  const target = resolve(out);
  requireFact(target.endsWith(".json") && !(await lstat(dirname(target))).isSymbolicLink(), "请指定安全目录中的新 JSON 回执文件。");
  const envelope = { statement, signature: sign(null, illustrationStatementBytes(statement), privateKey).toString("base64url"), producerKeyId };
  await writeFile(target, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { receipt: target, image: evidence.file, sha256: statement.sha256, producerKeyId };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    const message = error instanceof SyntaxError ? "工单或原生工具回执的 JSON 格式无效。" : error.message;
    console.error(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  });
}
