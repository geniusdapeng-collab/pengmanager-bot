import assert from "node:assert/strict";
import { createHash, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { articleIllustrationStyleMarker, articleIllustrationStyleRule } from "../public/article-illustration-style.js";
import { illustrationStatementBytes } from "../src/domain/article-illustrations.mjs";
import { exportImageGenerationReceipt, openImageGenerationSigner } from "../scripts/article-illustration-imagegen.mjs";

test("local ImageGen receipt binds a completed built-in event, its original PNG and the exact work order", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-imagegen-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const thread = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const receiptId = "exec-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const sourceHash = "c".repeat(64);
  const generated = join(root, "generated_images", thread);
  const sessions = join(root, "sessions");
  await mkdir(generated, { recursive: true });
  await mkdir(sessions);
  const savedPath = join(generated, `${receiptId}.png`);
  const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#296277" } }).png().toBuffer();
  await writeFile(savedPath, png);
  const workOrderPath = join(root, "work-order.json");
  const order = { schema: "pengmanager.article-illustration-work-order/v1", planId: "ILP-00001", sourceHash,
    slot: { id: "slot-3", imageGeneration: true }, production: ["local-compositor", "builtin-imagegen"] };
  await writeFile(workOrderPath, JSON.stringify(order));
  const rollout = join(sessions, "record.jsonl");
  const out = join(root, "signed-imagegen.json");
  const active = await openImageGenerationSigner(root, { create: true });
  assert.equal((await openImageGenerationSigner(root, { create: true })).producerKeyId, active.producerKeyId);
  const item = { type: "Extension", kind: "image_gen.generation", id: receiptId, status: "completed", savedPath };
  const transcript = event => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", thread_id: thread, item: event } }) + "\n";
  const request = { workOrderPath, rollout, receiptId, out };
  await writeFile(rollout, transcript({ ...item, revisedPrompt: "Fixture contains the wrong plan marker" }));
  await assert.rejects(exportImageGenerationReceipt(root, request), /未绑定/);
  await writeFile(rollout, transcript({ ...item, revisedPrompt: `Example prompt PM-ILLUSTRATION ILP-00001/slot-3 ${sourceHash}` }));
  const result = await exportImageGenerationReceipt(root, request);
  const { statement, signature, producerKeyId } = JSON.parse(await readFile(out, "utf8"));
  assert.equal(basename(result.image), `${receiptId}.png`);
  assert.equal(producerKeyId, active.producerKeyId);
  assert.equal(statement.sha256, createHash("sha256").update(png).digest("hex"));
  assert.equal(statement.bytes, png.length);
  assert.equal(statement.width, 640);
  assert.equal(statement.height, 360);
  assert.equal(statement.requestedProfile, "image2.5");
  assert.ok(!Object.hasOwn(statement, "resolvedModel"));
  assert.ok(verify(null, illustrationStatementBytes(statement), {
    key: Buffer.from(active.publicKey, "base64url"), format: "der", type: "spki",
  }, Buffer.from(signature, "base64url")));
  await assert.rejects(exportImageGenerationReceipt(root, request), { code: "EEXIST" });
  const styleYear = 2026;
  const styled = { ...order, slot: { ...order.slot, kind: "scene" }, styleYear,
    visualStyle: articleIllustrationStyleRule("scene", styleYear) };
  const styledOut = join(root, "signed-styled-imagegen.json");
  const styledRequest = { ...request, out: styledOut };
  await writeFile(workOrderPath, JSON.stringify(styled));
  await assert.rejects(exportImageGenerationReceipt(root, styledRequest), /未绑定/);
  await writeFile(rollout, transcript({ ...item,
    revisedPrompt: `PM-ILLUSTRATION ILP-00001/slot-3 ${sourceHash}\n${articleIllustrationStyleMarker(styleYear)}` }));
  await exportImageGenerationReceipt(root, styledRequest);
  assert.equal(JSON.parse(await readFile(styledOut, "utf8")).statement.styleYear, styleYear);
  await rm(savedPath);
  await writeFile(join(root, "outside.png"), png);
  await symlink(join(root, "outside.png"), savedPath);
  await assert.rejects(exportImageGenerationReceipt(root, request), /原始 PNG/);
});
