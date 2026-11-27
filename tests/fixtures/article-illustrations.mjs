import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { articleIllustrationBlockText, articleIllustrationNativeThreadId, illustrationStatementBytes, placeArticleIllustrations,
  sceneBriefHashForPlan } from "../../src/domain/article-illustrations.mjs";

export function illustrationFixtureContext(row, key = randomUUID()) {
  return { actor: "isolated unit reviewer", method: "local", idempotencyKey: key, ...(row ? { ifMatch: row.etag } : {}) };
}

export function fixtureIllustrationSlots(blocks, types = ["architecture", "logic", "scene"]) {
  const prose = blocks.map(articleIllustrationBlockText).map(text => text.replace(/\s+/gu, " ").trim()).find(text => [...text].length >= 6);
  if (!prose) throw new Error("Illustration fixtures need text long enough for three distinct anchors");
  const characters = [...prose];
  const anchors = new Set();
  for (let index = 0; index < characters.length - 3 && anchors.size < types.length; index++) {
    const excerpt = characters.slice(index, index + 6).join("").trim();
    if ([...excerpt].length >= 4) anchors.add(excerpt);
  }
  if (anchors.size < types.length) throw new Error("Illustration fixtures need distinct excerpts");
  return types.map((kind, index) => ({ kind, anchor: [...anchors][index],
    description: `Isolated test illustration emphasis ${index + 1}`, alt: `Synthetic illustration ${index + 1}`,
    caption: `Isolated caption ${index + 1}`, imageGeneration: false }));
}

export async function registerFixtureIllustrator(service, ctx = illustrationFixtureContext) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const producer = await service.registerIllustrationProducerKey({ label: "Isolated test illustrator",
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url") }, ctx());
  return { producer, privateKey };
}

export async function syntheticIllustrationPng(index, options = {}) {
  const width = 12, height = 10;
  const pixels = Buffer.alloc(width * height * 3);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 3;
      pixels[i] = (x * 9 + index * 29) % 220;
      pixels[i + 1] = (y * 15 + index * 17) % 200;
      pixels[i + 2] = (x * y + index * 41) % 210;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png(options).toBuffer();
}

export async function uploadFixtureIllustration(media, bytes, ctx = illustrationFixtureContext, { review = true } = {}) {
  const asset = await media.upload(Readable.from([bytes]), { contentType: "image/png", contentLength: bytes.length, name: "isolated-illustration.png" }, ctx());
  return review ? media.review(asset.id, { sha256: asset.sha256, rightsConfirmed: true, privacyConfirmed: true,
    rightsNote: "Actual synthetic bytes in an isolated test, never a real platform receipt." }, ctx(asset)) : asset;
}

export function fixtureIllustrationProof(source, plan, slot, asset, { producer, privateKey }, extra = {}) {
  const statement = { source, planId: plan.id, slotId: slot.id, sourceHash: plan.sourceHash,
    sha256: asset.sha256, width: asset.width, height: asset.height, bytes: asset.size,
    ...(source === "pengmanager-designer-compositor"
      ? { nativeThreadId: articleIllustrationNativeThreadId(plan.id, slot.id, plan.sourceHash), approvedApprovalId: `isolated-approval-${plan.id}-${slot.id}`,
        sceneBriefHash: sceneBriefHashForPlan(plan, slot),
        gestureEventId: `isolated-gesture-${plan.id}-${slot.id}`, composeEventId: `isolated-compose-${plan.id}-${slot.id}`,
        verifyEventId: `isolated-verify-${plan.id}-${slot.id}`,
        ...(plan.styleYear === undefined ? {} : { approvalAuthority: "ai", approvalDecisionHash: "a".repeat(64) }) }
      : { requestedProfile: "image2.5", toolReceiptId: `isolated-image-tool-${plan.id}-${slot.id}`,
        ...(plan.styleYear === undefined ? {} : { styleYear: plan.styleYear }) }), ...extra };
  return { statement, signature: sign(null, illustrationStatementBytes(statement), privateKey).toString("base64url"), producerKeyId: producer.id };
}

export async function bindFixtureIllustrations(service, media, plan, ctx = illustrationFixtureContext) {
  const fixture = await registerFixtureIllustrator(service, ctx);
  for (let index = 0; index < plan.slots.length; index++) {
    const slot = plan.slots[index];
    const asset = await uploadFixtureIllustration(media, await syntheticIllustrationPng(index + 1), ctx);
    const designerCompositor = slot.kind === "scene"
      ? fixtureIllustrationProof("pengmanager-designer-compositor", plan, slot, asset, fixture) : undefined;
    plan = await service.bindArticleIllustration(plan.storyId, plan.id, { slotId: slot.id, assetId: asset.id, sha256: asset.sha256,
      ...(designerCompositor ? { designerCompositor } : {}) }, ctx(plan));
  }
  return plan;
}

export async function prepareFixtureIllustrations(service, media, story, article, ctx = illustrationFixtureContext) {
  const { locale, title, summary, body, blocks } = article;
  const plan = await service.createArticleIllustrations(story.id, { locale, title, summary, body, articleType: "technical",
    slots: fixtureIllustrationSlots(blocks) }, ctx(story));
  const prepared = await bindFixtureIllustrations(service, media, plan, ctx);
  return { ...placeArticleIllustrations(prepared, article), illustrationPlanId: plan.id };
}
