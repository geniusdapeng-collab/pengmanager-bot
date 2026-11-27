import test from "node:test";
import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { articleIllustrationStyleYear } from "../public/article-illustration-style.js";
import { articleSceneWorkOrder } from "../src/video-runtime/article-visuals.mjs";
import { originalIllustrationCriteria } from "../src/services/editorial-article-review-evidence.mjs";
import { hashObject } from "../src/domain/hash.mjs";
import { ARTICLE_ILLUSTRATION_SCHEMA, articleIllustrationPlanHash, articleIllustrationSourceHash,
  assertArticleIllustrationStateIntegrity, placeArticleIllustrations, sceneBriefHashForPlan } from "../src/domain/article-illustrations.mjs";
import { approvedRelease, context, createEditionVariant, editorialFixture, FIXED_TIME, readyWebsite, scheduleVariant } from "./editorial-fixtures.mjs";
import { bindFixtureIllustrations, fixtureIllustrationProof, registerFixtureIllustrator,
  syntheticIllustrationPng, uploadFixtureIllustration } from "./fixtures/article-illustrations.mjs";

const title = "私有资料系统的架构与恢复流程";
const body = "入口根据账号权限处理来自编辑器的文件。\n\n状态变化需要保留版本、拒绝原因和复审证据。\n\n编辑把核对结果交给下一班的操作员。";
const blocks = body.split("\n\n").map(text => ({ type: "paragraph", text }));
const article = { title, summary: "对照每个独立环节和业务场景。", body, locale: "zh-CN" };

async function newFixture(t, imageGeneration = false) {
  const f = await editorialFixture(t);
  await readyWebsite(f);
  const story = await f.service.createStory({ workingTitle: title, claimIds: ["C003"] }, context());
  const suggestion = f.service.suggestIllustrations(articleText());
  const slots = suggestion.slots.map(slot => ({ ...slot, imageGeneration: imageGeneration && slot.kind === "scene" }));
  const params = { ...article, slots };
  const plan = await f.service.createArticleIllustrations(story.id, params, context(story));
  return { ...f, story, plan, params, slots };
}

function articleText() { const { title, summary, body } = article; return { title, summary, body }; }
function bind(f, plan, index, asset, evidence = {}, incoming = context(plan)) {
  return f.service.bindArticleIllustration(plan.storyId, plan.id, { slotId: plan.slots[index].id,
    assetId: asset.id, sha256: asset.sha256, ...evidence }, incoming);
}

test("a plan can freeze an exact article release while preserving the legacy digest", () => {
  const source = { title: "Fixture", summary: "", body: "One", locale: "zh-CN" };
  const plan = { schema: ARTICLE_ILLUSTRATION_SCHEMA, id: "ILP-00001", storyId: "STY-00001",
    locale: source.locale, sourceHash: articleIllustrationSourceHash(source), articleType: "technical",
    slots: ["architecture", "logic", "scene"].map((kind, index) => ({ id: `slot-${index + 1}`, kind })) };
  const legacyDigest = "52136f53a110466497e45d5842751404540dfe1ed49bbdb95180dd9c9b8ee2e6";
  const baseline = { id: "REL-00001", storyId: plan.storyId, locale: plan.locale, format: "article" };
  const edition = { ...source, storyId: plan.storyId, format: "article",
    illustrationPlanId: plan.id, illustrationPlanHash: legacyDigest };
  const state = { schemaVersion: 4, stories: [{ id: plan.storyId }], articleIllustrationPlans: [plan],
    editions: [edition], mediaAssets: [] };
  assert.equal(articleIllustrationPlanHash(plan), legacyDigest);
  assert.equal(articleIllustrationPlanHash({ ...plan, baseReleaseId: undefined }), legacyDigest);
  assert.doesNotThrow(() => assertArticleIllustrationStateIntegrity(state));

  const bound = { ...plan, baseReleaseId: baseline.id };
  const boundDigest = articleIllustrationPlanHash(bound);
  assert.notEqual(boundDigest, legacyDigest);
  assert.notEqual(boundDigest, articleIllustrationPlanHash({ ...bound, baseReleaseId: "REL-00002" }));
  const boundState = { ...state, articleIllustrationPlans: [bound], websiteReleases: [baseline],
    editions: [{ ...edition, illustrationPlanHash: boundDigest }] };
  assert.doesNotThrow(() => assertArticleIllustrationStateIntegrity(boundState));
  const invalid = { code: "STATE_ARTICLE_ILLUSTRATION_INVALID" };
  for (const baseReleaseId of [null, "", "REL-1", "STY-00001", "REL-00002"]) {
    const malformed = { ...plan, baseReleaseId };
    assert.throws(() => assertArticleIllustrationStateIntegrity({ ...boundState,
      articleIllustrationPlans: [malformed], editions: [] }), invalid);
  }
  for (const release of [
    { ...baseline, storyId: "STY-00002" }, { ...baseline, locale: "en-US" }, { ...baseline, format: "video" },
  ]) {
    assert.throws(() => assertArticleIllustrationStateIntegrity({ ...boundState, websiteReleases: [release] }), invalid);
  }
  assert.throws(() => assertArticleIllustrationStateIntegrity({ ...boundState, editions: [edition] }), invalid);
});

test("suggestions distinguish three article types and point to body excerpts", async t => {
  const f = await newFixture(t);
  assert.equal(f.plan.articleType, "technical");
  assert.deepEqual(f.plan.slots.map(slot => slot.kind), ["architecture", "logic", "scene"]);
  for (const slot of f.plan.slots) assert.ok(body.includes(slot.anchor));
  const lifestyle = f.service.suggestIllustrations({ title: "周末徒步与咖啡", summary: "记一次日常旅行",
    body: "周末我沿河散步。\n\n半山旁有露营的人在冲咖啡。\n\n傍晚从林间回家整理照片。" });
  assert.equal(lifestyle.articleType, "lifestyle");
  assert.deepEqual(lifestyle.kinds, ["scene", "scene", "scene"]);
  assert.equal(new Set(lifestyle.slots.map(slot => slot.anchor)).size, 3);
  const product = f.service.suggestIllustrations({ title: "产品运营和客户服务", body: "按业务记录复核客户需求、流程、验收和分工。" });
  assert.equal(product.articleType, "product");
  assert.equal(product.needsReview, true);
  assert.deepEqual(f.service.listArticleIllustrations(f.story.id).items.map(row => row.id), [f.plan.id]);
  await assert.rejects(f.service.createArticleIllustrations(f.story.id, { ...f.params, slots: f.slots.slice(0, 2) }, context(f.story)), { code: "ILLUSTRATION_SLOT_COUNT" });
  await assert.rejects(f.service.createArticleIllustrations(f.story.id, { ...f.params, articleType: "lifestyle" }, context(f.story)), { code: "ILLUSTRATION_COVERAGE_REQUIRED" });
  await assert.rejects(f.service.createArticleIllustrations(f.story.id, { ...f.params, slots: f.slots.map((slot, index) => index === 1
    ? { ...slot, anchor: "不存在的锚点，不能使用。" } : slot) }, context(f.story)), { code: "ILLUSTRATION_ANCHOR_INVALID" });
  const lifetime = await f.service.createArticleIllustrations(f.story.id, { ...f.params, articleType: "lifestyle",
    slots: f.slots.map(slot => ({ ...slot, kind: "scene" })) }, context(f.story));
  assert.equal(lifetime.articleType, "lifestyle");
  assert.equal(lifetime.suggestion.articleType, "technical");
});

test("new plans freeze a 2026-or-later style across official work orders without changing the original", async t => {
  const f = await newFixture(t, true);
  const fresh = f.service.getArticleIllustrations(f.story.id, f.plan.id);
  const scene = fresh.workOrders.find(row => row.workOrder.slot.kind === "scene");
  const diagram = fresh.workOrders.find(row => row.workOrder.slot.kind === "architecture");
  assert.equal(articleIllustrationStyleYear(new Date("2021-12-31T23:59:59Z")), 2026);
  assert.equal(articleIllustrationStyleYear(new Date("2027-01-01T00:00:00Z")), 2027);
  assert.equal(fresh.styleYear, articleIllustrationStyleYear(new Date(FIXED_TIME)));
  assert.equal(fresh.sourceHash, articleIllustrationSourceHash(article));
  assert.equal(scene.workOrder.slot.description, fresh.slots[2].description);
  assert.match(scene.imageGenPrompt, /互联网或科技公司/u);
  assert.ok(scene.imageGenPrompt.includes(fresh.slots[2].alt));
  assert.ok(scene.imageGenPrompt.includes(`PM-VISUAL-STYLE contemporary-tech-v1/${fresh.styleYear}`));
  assert.match(diagram.workOrder.visualStyle, /清晰字号层级/u);
  assert.equal(articleSceneWorkOrder(scene.workOrder).brief.styleYear, fresh.styleYear);
  assert.throws(() => articleSceneWorkOrder({ ...scene.workOrder, visualStyle: "复古办公" }), { code: "ARTICLE_SCENE_STYLE_INVALID" });
  const { styleYear, visualStyle, ...withoutPolicy } = scene.workOrder;
  assert.throws(() => articleSceneWorkOrder(withoutPolicy), { code: "ARTICLE_SCENE_BRIEF_MISMATCH" });
  assert.ok(!Object.hasOwn(originalIllustrationCriteria("release"), "contemporary_style"));
  for (const stage of ["variant", "release"]) {
    assert.match(originalIllustrationCriteria(stage, styleYear).contemporary_style, /实际像素.*过时应 fail/su);
  }
});

test("a numbered Markdown list suggestion points to the rendered text and can place its illustration", async t => {
  const f = await newFixture(t);
  const introduction = "架构由入口和台账两个模块组成。";
  const logic = "决策、判断、条件、失败和回滚均保留记录。";
  const scenario = "门店现场的晚班员工核对旧记录。";
  const exact = { title, summary: "", locale: "zh-CN", body: `${introduction}\n\n4. ${logic}\n\n${scenario}` };
  const suggestion = f.service.suggestIllustrations({ title, body: exact.body });
  assert.equal(suggestion.slots[1].anchor, logic);
  const plan = await f.service.createArticleIllustrations(f.story.id, { ...exact, slots: suggestion.slots }, context(f.story));
  const prepared = await bindFixtureIllustrations(f.service, f.mediaAssets, plan);
  const layout = placeArticleIllustrations(prepared, { ...exact, blocks: [{ type: "paragraph", text: introduction },
    { type: "list", ordered: true, items: [logic] }, { type: "paragraph", text: scenario }] });
  assert.equal(layout.blocks.findIndex(block => block.assetId === prepared.slots[1].evidence.assetId), 3);
});

test("binding requires approved bytes, distinct rendered pixels, fresh ETags and a real signed scene receipt", async t => {
  const f = await newFixture(t);
  const { plan } = f;
  const pending = await uploadFixtureIllustration(f.mediaAssets, await syntheticIllustrationPng(1), context, { review: false });
  await assert.rejects(bind(f, plan, 0, pending), { code: "ILLUSTRATION_ASSET_NOT_REVIEWED" });
  const first = await uploadFixtureIllustration(f.mediaAssets, await syntheticIllustrationPng(1, { compressionLevel: 0 }), context);
  const samePixels = await uploadFixtureIllustration(f.mediaAssets, await syntheticIllustrationPng(1, { compressionLevel: 9 }), context);
  assert.notEqual(first.sha256, samePixels.sha256);
  const bindCtx = context(plan);
  const filled = await bind(f, plan, 0, first, {}, bindCtx);
  assert.equal((await bind(f, plan, 0, first, {}, bindCtx)).etag, filled.etag);
  await assert.rejects(bind(f, plan, 1, samePixels), { status: 412 });
  await assert.rejects(bind(f, filled, 1, samePixels), { code: "ILLUSTRATION_ASSET_DUPLICATE" });
  const second = await uploadFixtureIllustration(f.mediaAssets, await syntheticIllustrationPng(2), context);
  const secondFilled = await bind(f, filled, 1, second);
  const scene = await uploadFixtureIllustration(f.mediaAssets, await syntheticIllustrationPng(3), context);
  await assert.rejects(bind(f, secondFilled, 2, scene), { code: "ILLUSTRATION_RECEIPT_REQUIRED" });
  const key = await registerFixtureIllustrator(f.service);
  const proof = fixtureIllustrationProof("pengmanager-designer-compositor", secondFilled, secondFilled.slots[2], scene, key);
  assert.equal(secondFilled.slots[2].sceneBriefHash, sceneBriefHashForPlan(secondFilled, secondFilled.slots[2]));
  await assert.rejects(bind(f, secondFilled, 2, scene, { designerCompositor: { ...proof, producerKeyId: "pk-unknown" } }), { code: "ILLUSTRATION_PRODUCER_UNTRUSTED" });
  await assert.rejects(bind(f, secondFilled, 2, scene, { designerCompositor: { ...proof, statement: { ...proof.statement, width: 999 } } }), { code: "ILLUSTRATION_SIGNATURE_INVALID" });
  const stale = fixtureIllustrationProof("pengmanager-designer-compositor", secondFilled, secondFilled.slots[2], scene, key, { sourceHash: "0".repeat(64) });
  await assert.rejects(bind(f, secondFilled, 2, scene, { designerCompositor: stale }), { code: "ILLUSTRATION_RECEIPT_MISMATCH" });
  for (const sceneBriefHash of [undefined, "f".repeat(64)]) {
    const unbound = fixtureIllustrationProof("pengmanager-designer-compositor", secondFilled, secondFilled.slots[2], scene, key, { sceneBriefHash });
    await assert.rejects(bind(f, secondFilled, 2, scene, { designerCompositor: unbound }), { code: "ILLUSTRATION_SCENE_BRIEF_MISMATCH" });
  }
  const completed = await bind(f, secondFilled, 2, scene, { designerCompositor: proof });
  assert.equal(completed.isComplete, true);
  const maliciouslySwapped = placeArticleIllustrations(completed, { ...article, blocks });
  const firstPictureIndex = maliciouslySwapped.blocks.findIndex(block => block.type === "image");
  const [picture] = maliciouslySwapped.blocks.splice(firstPictureIndex, 1);
  maliciouslySwapped.blocks.push(picture);
  const edition = { ...article, format: "article", claimIds: ["C003"], ...maliciouslySwapped, illustrationPlanId: completed.id };
  await assert.rejects(f.service.createEdition(f.story.id, edition, context(f.story)), { code: "ILLUSTRATION_PLACEMENT_MISMATCH" });
  await assert.rejects(f.service.createEdition(f.story.id, { ...edition, title: "未经重新核验的另一篇文章" }, context(f.story)), { code: "ARTICLE_ILLUSTRATION_PLAN_REQUIRED" });
  assert.equal(f.service.getStory(f.story.id).editions.length, 0);
});

test("built-in ImageGen output hash is tied to actual scene composition input; missing provider metadata stays absent", async t => {
  const f = await newFixture(t, true);
  const scene = await uploadFixtureIllustration(f.mediaAssets, await syntheticIllustrationPng(3), context);
  const raw = await uploadFixtureIllustration(f.mediaAssets, await syntheticIllustrationPng(4), context);
  const producer = await registerFixtureIllustrator(f.service), slot = f.plan.slots[2];
  const rawProof = fixtureIllustrationProof("codex-imagegen", f.plan, slot, raw, producer);
  const nativeProof = fixtureIllustrationProof("pengmanager-designer-compositor", f.plan, slot, scene, producer, { imageGenInputSha256: raw.sha256 });
  const staleNative = fixtureIllustrationProof("pengmanager-designer-compositor", f.plan, slot, scene, producer, { imageGenInputSha256: "0".repeat(64) });
  await assert.rejects(bind(f, f.plan, 2, scene, { designerCompositor: nativeProof }), { code: "ILLUSTRATION_RECEIPT_REQUIRED" });
  await assert.rejects(bind(f, f.plan, 2, scene, { designerCompositor: staleNative, imageGen: rawProof }), { code: "ILLUSTRATION_RECEIPT_MISMATCH" });
  const current = await bind(f, f.plan, 2, scene, { designerCompositor: nativeProof, imageGen: rawProof });
  assert.equal(current.slots[2].evidence.imageGen.statement.resolvedModel, undefined);
  assert.equal(current.slots[2].evidence.imageGen.statement.requestedProfile, "image2.5");
  assert.equal(current.slots[2].evidence.designerCompositor.statement.sha256, scene.sha256);
});

test("frozen plans verify actual media on activation and stay private on public readback", async t => {
  const f = await newFixture(t);
  const plan = await bindFixtureIllustrations(f.service, f.mediaAssets, f.plan);
  const edition = await f.service.createEdition(f.story.id, { ...article, format: "article", claimIds: ["C003"],
    ...placeArticleIllustrations(plan, { ...article, blocks }), illustrationPlanId: plan.id }, context(f.story));
  assert.equal(f.service.getArticleIllustrations(f.story.id, plan.id).frozen, true);
  await assert.rejects(bind(f, plan, 0, f.mediaAssets.getAsset(plan.slots[0].evidence.assetId)), { code: "ILLUSTRATION_PLAN_FROZEN" });
  const candidate = await f.service.createVariant(edition.id, { destinationId: "official-site" }, context(edition));
  const release = await approvedRelease(f, candidate);
  f.service.mediaAssets = f.mediaAssets;
  const ref = candidate.assetRefs[2];
  const file = join(f.directory, "media-assets", "objects", `${ref.assetId}.bin`);
  const actual = await syntheticIllustrationPng(3);
  await chmod(file, 0o600);
  await writeFile(file, Buffer.alloc(actual.length, 65));
  const activation = { confirm: true, expectedPreviousReleaseId: null }, activationCtx = context(release);
  await assert.rejects(f.service.publishRelease(release.id, activation, activationCtx), { code: "MEDIA_BYTES_UNAVAILABLE" });
  assert.equal(f.store.snapshot().websiteRoutes.length, 0);
  await writeFile(file, actual);
  const active = await f.service.publishRelease(release.id, activation, activationCtx);
  const published = await f.service.verifyRelease(active.id, { confirm: true }, context(active));
  const doc = f.service.publicDetail({ locale: "zh-CN", format: "article", slug: published.slug });
  assert.equal(doc.assets.length, 3);
  assert.equal(published.receipt.assetHashes.length, 3);
  assert.doesNotMatch(JSON.stringify(doc), /ILP-|nativeThreadId|producerKeyId|illustrationPlanHash/);
});

test("old two-image drafts and approved candidates cannot activate, while previously active routes are still readable", async t => {
  const f = await newFixture(t);
  const assetRefs = [];
  for (const index of [1, 2]) {
    const asset = await uploadFixtureIllustration(f.mediaAssets, await syntheticIllustrationPng(index), context);
    assetRefs.push({ assetId: asset.id, sha256: asset.sha256, role: "image", alt: `旧测试图片 ${index}`, caption: "" });
  }
  const { variant } = await createEditionVariant(f, { illustrated: false, body, assetRefs,
    blocks: [...blocks, ...assetRefs.map(ref => ({ type: "image", assetId: ref.assetId, alt: ref.alt, caption: ref.caption }))] });
  const content = await scheduleVariant(f, variant);
  const slug = "legacy-isolated-article", canonicalPath = `/zh/articles/${slug}`, canonicalUrl = `https://workbench.example.net${canonicalPath}`;
  await assert.rejects(f.service.createRelease({ contentId: content.id, slug }, context(content)), { code: "ARTICLE_ILLUSTRATION_PLAN_REQUIRED" });
  const snapshot = { locale: content.locale, format: content.format, title: content.title, summary: content.summary, body: content.body,
    blocks: content.blocks, assetRefs: content.assetRefs, claimIds: content.claimIds, claimBindings: content.claimBindings, canonicalPath, canonicalUrl };
  const releaseId = "REL-09991";
  await f.store.mutate({ type: "test.isolated_legacy_fixture", actor: "fixture" }, state => {
    state.websiteReleases.push({ id: releaseId, siteId: "official-site", storyId: content.storyId,
      editionId: content.editionId, contentId: content.id, locale: content.locale, format: content.format, slug,
      canonicalPath, contentSnapshotHash: content.snapshotHash, publicSnapshot: snapshot, snapshotHash: hashObject(snapshot),
      status: "draft", revision: 1, activationAt: null });
  });
  let prior = f.service.getRelease(releaseId);
  const snapshotHash = prior.snapshotHash;
  await assert.rejects(f.service.approveRelease(releaseId, { reviewed: true, snapshotHash, authorizationNote: "Isolated legacy candidate." }, context(prior)),
    { code: "ARTICLE_ILLUSTRATION_PLAN_REQUIRED" });
  await f.store.mutate({ type: "test.isolated_legacy_approved", actor: "fixture" }, state => {
    Object.assign(state.websiteReleases[0], { status: "approved", publicApproval: { snapshotHash } });
  });
  prior = f.service.getRelease(releaseId);
  await assert.rejects(f.service.publishRelease(releaseId, { confirm: true, expectedPreviousReleaseId: null }, context(prior)), { code: "ARTICLE_ILLUSTRATION_PLAN_REQUIRED" });
  await f.store.mutate({ type: "test.isolated_preexisting_active_route", actor: "fixture" }, state => {
    Object.assign(state.websiteReleases[0], { status: "live_unverified", activationAt: FIXED_TIME.toISOString() });
    state.websiteRoutes.push({ id: "RTE-09991", storyId: content.storyId, locale: content.locale,
      format: content.format, activeReleaseId: releaseId, slug, canonicalPath });
  });
  const doc = f.service.publicDetail({ locale: content.locale, format: content.format, slug });
  assert.equal(doc.releaseId, releaseId);
  assert.equal(doc.assets.length, 2);
  assert.equal((await f.service.verifyRelease(releaseId, { confirm: true }, context(f.service.getRelease(releaseId)))).status, "published");
});
