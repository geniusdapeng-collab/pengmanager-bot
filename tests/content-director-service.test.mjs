import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState, migrateEditorialState } from "../src/services/bootstrap.mjs";
import { migrateContentOpsState } from "../src/services/content-ops-migration.mjs";
import { migrateContentDirectorState } from "../src/services/content-director-migration.mjs";
import { createEditorialBackup } from "../src/services/editorial-backup.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { EditorialService } from "../src/services/editorial-service.mjs";
import { ContentDirectorService } from "../src/services/content-director-service.mjs";
import { MediaAssets } from "../src/services/media-assets.mjs";
import { createNativeBotAdapter } from "../src/bot/operations-native.mjs";
import { ApiError } from "../src/domain/errors.mjs";
import { measureArticleLength } from "../src/domain/content-director.mjs";
import { hashObject } from "../src/domain/hash.mjs";
import { bindFixtureIllustrations } from "./fixtures/article-illustrations.mjs";

const context = () => ({ method: "local", actor: "isolated content director reviewer", idempotencyKey: randomUUID() });

class StubModel {
  async generateOutline({ brief }) {
    return {
      value: {
        title: "Agent 产品进入真实业务的工程闭环",
        summary: "从任务、权限、审核、回执和复测解释 Agent 产品如何进入真实业务。",
        sections: [
          { key: "problem", title: "真实业务的问题不是演示", purpose: "说明演示与交付的差别", targetCharacters: 500, claimIds: [] },
          { key: "system", title: "工程闭环的五个要素", purpose: "展开任务、权限、审核、回执和复测", targetCharacters: 700, claimIds: [] },
          { key: "delivery", title: "如何完成可验证交付", purpose: "给出落地路径和限制", targetCharacters: 600, claimIds: [] },
        ],
      },
      receipt: { requestedModel: "fixture", resolvedModel: "fixture", responseId: "outline", requestHash: "a".repeat(64), responseHash: "b".repeat(64), usage: { total_tokens: 1 } },
    };
  }

  async draftSection({ section }) {
    const body = `真正的 Agent 产品必须让${section.title}在真实任务中可验证，而不是只展示一次回答。读者需要看到任务从哪里进入、由谁承担、失败如何恢复，以及最终凭什么确认交付已经发生。${section.key}这一段首先把问题落在可观察行为上。\n\n工程团队需要记录输入、权限、执行、失败和人工介入，再通过独立审核确认内容没有被模型补造成不存在的经历或事实。只有把来源、版本、账号和动作绑定在一起，后续复盘才不会变成对聊天记录的猜测。${section.key}这一段强调证据链而不是语言包装。\n\n这一段还说明落地限制：证据、预算、账号和外部回执必须分别成立，任何缺项都应保留为阻断，而不是用一段更流畅的文字掩盖。系统可以把重复步骤自动化，但不能替用户扩大授权，也不能把未知结果写成成功。${section.key}这一段明确自动化边界。\n\n因此，${section.title}对应的工程能力需要同时覆盖标准流程、异常路径、人工确认和恢复策略。它的价值不是让演示更复杂，而是让一次业务任务在多人、多系统和多次重试之后仍然可以被准确解释。${section.key}这一段完成本节的交付闭环。`;
    return {
      value: { title: section.title, body, paragraphs: body.split(/\n\s*\n/), claimIds: [] },
      receipt: { requestedModel: "fixture", resolvedModel: "fixture", responseId: `draft-${section.key}`, requestHash: "c".repeat(64), responseHash: "d".repeat(64), usage: { total_tokens: 1 } },
    };
  }

  async auditArticle({ article, brief, measuredLength }) {
    assert.equal(measuredLength.characters, article.body.replace(/\s+/g, "").length);
    assert.equal(measuredLength.minCharacters, brief.targetLength.minCharacters);
    assert.equal(measuredLength.maxCharacters, brief.targetLength.maxCharacters);
    return {
      value: { assessment: "Fixture article is structurally complete.", findings: [], coverage: { facts: "checked", structure: "checked", expression: "checked", policy: "checked", technical: "checked", visual: "checked" } },
      receipt: { requestedModel: "fixture", resolvedModel: "fixture", responseId: "audit", requestHash: "e".repeat(64), responseHash: "f".repeat(64), usage: { total_tokens: 1 } },
    };
  }

  async planVisuals() {
    return {
      value: {
        visuals: [{
          kind: "architecture",
          title: "Agent 产品工程闭环",
          alt: "从任务输入到审核、执行、回执和复测的架构图",
          caption: "图 1：可验证 Agent 产品闭环",
          nodes: [
            { id: "task", label: "任务输入" },
            { id: "gate", label: "权限与围栏" },
            { id: "receipt", label: "回执与复测" },
          ],
          edges: [
            { from: "task", to: "gate", label: "校验" },
            { from: "gate", to: "receipt", label: "执行并留证" },
          ],
        }],
      },
      receipt: { requestedModel: "fixture", resolvedModel: "fixture", responseId: "visual", requestHash: "1".repeat(64), responseHash: "2".repeat(64), usage: { total_tokens: 1 } },
    };
  }
}

async function fixture(t, { aiApproval = null } = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pm-content-director-"));
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  await store.open(() => loadSeedState(resolve(import.meta.dirname, "fixtures/legacy-plane/seed")));
  await migrateEditorialState(store, { publicOrigin: "https://workbench.example.net" });
  const backup = createEditorialBackup({ store });
  await migrateContentOpsState(store, { beforeMigration: () => backup.captureCurrent() });
  await migrateContentDirectorState(store, { beforeMigration: () => backup.captureCurrent() });
  const geoService = new GeoOsService({ store });
  await geoService.approveClaim("C003", { approvedBy: "isolated reviewer", publicLevel: "private" });
  const mediaAssets = new MediaAssets({ store, aiApproval });
  await mediaAssets.initialize();
  const editorial = new EditorialService({ store, geoService, mediaAssets, publicOrigin: "https://workbench.example.net" });
  const director = new ContentDirectorService({
    store,
    model: new StubModel(),
    editorial,
    mediaAssets,
    artifactRoot: join(directory, "content-director"),
    autoStart: false,
    aiApproval,
  });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, editorial, mediaAssets, director };
}

test("article length counts only the assembled body, including headings and sources", () => {
  const body = "## 一\n\n甲\u3000🌱\n\n核验来源\nhttps://example.org/x";
  const article = { title: "独立标题", body, sections: [{ body }], blocks: [{ text: body }] };
  const target = { minCharacters: 2000, maxCharacters: 4000 };
  assert.deepEqual(measureArticleLength(article, target), {
    method: "article.body/non-whitespace-utf16-v1",
    characters: 31,
    ...target,
  });
  assert.equal(measureArticleLength({ body: " \r\n\u3000" }, target).characters, 0);
  assert.equal(measureArticleLength({ body: "字".repeat(4588) }, target).characters, 4588);
});

test("article Job writes complete sections, independent audit and editable visuals", async t => {
  const f = await fixture(t);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品如何进入真实业务写一篇技术文章，并配一张架构图",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  assert.equal(job.artifactKind, "article_visual");
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.status, "needs_review");
  assert.equal(completed.result.article.sections.length, 3);
  const reports = f.director.state().contentAuditReports.filter(report => report.jobId === job.id);
  assert.deepEqual(reports.map(report => report.phase), ["quality.review", "quality.final"]);
  for (const { measuredLength, reportHash, ...report } of reports) {
    assert.deepEqual(measuredLength, measureArticleLength(completed.result.article, job.route.targetLength));
    assert.equal(hashObject({ ...report, measuredLength }), reportHash);
  }
  assert.ok(completed.result.article.body.length > 1000);
  assert.equal(completed.result.findings.length, 0);
  assert.equal(completed.result.visuals.length, 1);
  assert.deepEqual(completed.result.illustrationHandoff.kinds, ["architecture", "logic", "scene"]);
  assert.equal(completed.result.illustrationHandoff.slots.length, 3);
  const svg = await f.director.readArtifact(job.id, `${completed.result.visuals[0].id}.svg`);
  assert.equal(svg.mime, "image/svg+xml");
  assert.match(svg.bytes.toString("utf8"), /Agent 产品工程闭环/);
});

test("an AI-enabled content director autonomously resumes the frozen package with verified visual bytes", async t => {
  const f = await fixture(t), observed = [];
  f.director.aiApproval = { async review(request) {
    observed.push(request);
    if (observed.length === 1) throw new ApiError(409, "AI_APPROVAL_PENDING", "Isolated proof pending");
    return { schema: "pengmanager.ai-approval/v1", actor: "ai-reviewer", kind: request.kind, subjectId: request.subjectId,
      snapshotHash: request.snapshotHash, evidenceHash: hashObject(request.evidence), decision: "approve",
      reviewedAt: new Date().toISOString(), modelReceipt: { responseId: "isolated-review-only" } };
  } };
  const job = await f.director.createJob({ intent: "围绕 Agent 产品如何进入真实业务写一篇技术文章，并配一张架构图", claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 } }, context());
  const frozen = await f.director.processJob(job.id);
  await f.director.continueApproval();
  assert.equal((await f.director.getJob(job.id)).status, "needs_review");
  await f.director.continueApproval();
  const approved = await f.director.getJob(job.id);
  assert.equal(approved.status, "approved");
  assert.equal(approved.review.reviewedBy, "ai-reviewer");
  assert.equal(approved.review.authorizedBy, "content-director-system");
  assert.equal(approved.review.contentHash, frozen.result.contentHash);
  assert.equal(observed[1].evidence.result.article.body, frozen.result.article.body);
  assert.equal(observed[1].evidence.exactFinalReports[0].contentHash, frozen.result.contentHash);
  const visual = frozen.result.visuals[0].artifacts.find(row => row.mime === "image/png");
  assert.deepEqual(observed[1].images[0].bytes, (await f.director.readArtifact(job.id, visual.name)).bytes);
  await f.director.continueApproval();
  assert.equal(observed.length, 2);
});

test("AI-mode visual materialization uses source authorization and its independent media decision", async t => {
  const calls = [];
  const f = await fixture(t, { aiApproval: { async review({ kind, subjectId, snapshotHash, evidence, images }) {
    calls.push({ kind, evidence, images });
    return { schema: "pengmanager.ai-approval/v1", actor: "ai-reviewer", kind, subjectId, snapshotHash,
      evidenceHash: hashObject(evidence), decision: "approve", reviewedAt: new Date().toISOString(), modelReceipt: { responseId: `isolated-${kind}` } };
  } } });
  const job = await f.director.createJob({ intent: "做一张内容生产线架构图，不要文章", explicitKind: "pure_visual" }, context());
  await f.director.processJob(job.id);
  await f.director.continueApproval();
  const approved = await f.director.getJob(job.id);
  const request = { contentHash: approved.result.contentHash }, ctx = { ...context(), ifMatch: approved.etag };
  await assert.rejects(f.director.materializeEdition(job.id, request, ctx), { code: "CONTENT_DIRECTOR_INPUT_INVALID" });
  const note = "Owner-generated isolated chart, approved for this specific image-text edition.";
  const output = await f.director.materializeEdition(job.id, { ...request, visualRightsNote: note }, ctx);
  assert.equal(output.edition.format, "image_text");
  assert.equal(f.mediaAssets.getAsset(output.edition.assetRefs[0].assetId).review.reviewedBy, "ai-reviewer");
  assert.equal(calls.find(row => row.kind === "editorial.media").evidence.rightsEvidence, note);
});

test("articles wait for three reviewed illustrations and a signed on-device scene receipt before materialization", async t => {
  const f = await fixture(t);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品如何进入真实业务写一篇文章，并配一张系统架构图",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const completed = await f.director.processJob(job.id);
  const approved = await f.director.approveJob(job.id, { reviewed: true, contentHash: completed.result.contentHash }, { ...context(), ifMatch: completed.etag });
  const body = { contentHash: completed.result.contentHash };
  await assert.rejects(f.director.materializeEdition(job.id, body, { ...context(), ifMatch: approved.etag }), { code: "ARTICLE_ILLUSTRATION_PLAN_REQUIRED" });
  const planCtx = { ...context(), ifMatch: approved.etag };
  const prepared = await f.director.prepareArticleIllustrations(job.id, body, planCtx);
  assert.equal(prepared.plan.sourceHash, completed.result.illustrationHandoff.sourceHash);
  assert.equal(prepared.plan.isComplete, false);
  assert.equal((await f.director.prepareArticleIllustrations(job.id, body, planCtx)).plan.id, prepared.plan.id);
  await assert.rejects(f.director.materializeEdition(job.id, body, { ...context(), ifMatch: prepared.job.etag }), { code: "ARTICLE_ILLUSTRATION_INCOMPLETE" });
  assert.equal(f.mediaAssets.listAssets().items.length, 0);
  await bindFixtureIllustrations(f.editorial, f.mediaAssets, prepared.plan);
  const materialized = await f.director.materializeEdition(job.id, body, { ...context(), ifMatch: prepared.job.etag });
  assert.equal(materialized.edition.assetRefs.length, 3);
  assert.equal(materialized.edition.illustrationPlanId, prepared.plan.id);
  assert.equal(materialized.edition.assetRefs[0].role, "image");
  assert.equal(f.mediaAssets.getAsset(materialized.edition.assetRefs[0].assetId).status, "reviewed");
  assert.equal(materialized.edition.blocks.filter(block => block.type === "image").length, 3);
  assert.equal((await f.director.materializeEdition(job.id, body, { ...context(), ifMatch: prepared.job.etag })).edition.id, materialized.edition.id);
});

test("approved article materializes as an immutable editorial edition", async t => {
  const f = await fixture(t);
  const job = await f.director.createJob({
    intent: "围绕 Agent 产品进入真实业务写一篇技术文章",
    claimIds: ["C003"],
    targetLength: { minCharacters: 1500, maxCharacters: 2500 },
  }, context());
  const completed = await f.director.processJob(job.id);
  const approved = await f.director.approveJob(job.id, { reviewed: true, contentHash: completed.result.contentHash, note: "read complete package" }, { ...context(), ifMatch: completed.etag });
  assert.equal(approved.status, "approved");
  const body = { contentHash: completed.result.contentHash };
  const prepared = await f.director.prepareArticleIllustrations(job.id, body, { ...context(), ifMatch: approved.etag });
  await bindFixtureIllustrations(f.editorial, f.mediaAssets, prepared.plan);
  const materialized = await f.director.materializeEdition(job.id, body, { ...context(), ifMatch: prepared.job.etag });
  assert.equal(materialized.edition.format, "article");
  assert.equal(materialized.edition.body, completed.result.article.body);
  assert.equal(f.editorial.getEdition(materialized.edition.id).snapshotHash, materialized.edition.snapshotHash);
});

for (const mode of ["bounded repair", "compact continuation", "incomplete compact continuation", "final review truncation"]) {
  test(`a private managed article preserves its original bytes and reviews during ${mode}`, t => verifyRevision(t, mode));
}

async function verifyRevision(t, mode) {
  const decisions = [];
  const aiApproval = { async review(request) {
    decisions.push(request);
    return { actor: "ai-reviewer", decision: "approve", snapshotHash: request.snapshotHash,
      evidenceHash: hashObject(request.evidence), reviewedAt: new Date().toISOString(), modelReceipt: { responseId: "fixture-only" } };
  } };
  const f = await fixture(t, { aiApproval });
  const source = { visibility: "public", label: "Paperbird archive", url: "https://github.com/demo/paperbird/releases/tag/v1" };
  await f.store.mutate({ type: "test.synthetic_source", actor: "fixture", payload: {} }, state => {
    state.claims.find(row => row.id === "C003").source = source;
  });
  await new GeoOsService({ store: f.store }).approveClaim("C003", {
    publicLevel: "approved_public", sourceExcerpt: "Paperbird archive records an editorial update.",
  }, { actor: "fixture", aiApproval });

  const calls = [];
  const result = (value, scene = "fixture") => ({ value, receipt: {
    responseId: "synthetic-" + calls.length, responseHash: hashObject(value), finishReason: "stop",
    policy: { scene }, requestedModel: "fixture", returnedModel: "fixture",
  } });
  const titles = [..."甲乙丙丁戊己庚"];
  const letters = [..."天地人"];
  const sections = titles.map((title, i) => ({
    key: "section" + i, title: title + "节资料", purpose: "梳理获准公开资料", targetCharacters: 530, claimIds: ["C003"],
  }));
  const model = f.director.model;
  model.generateOutline = async () => {
    calls.push("outline");
    return result({ title: "历史资料精读", summary: "某历史文档的修订与限制。", sections });
  };
  model.draftSection = async ({ section }) => {
    calls.push("draft");
    const paragraphs = letters.map(letter => section.title + letter +
      "资料使用者可核对原始说明，分别记录原文、事实依据和适用限制。".repeat(8));
    return result({ title: section.title, paragraphs, body: paragraphs.join("\n\n"), claimIds: ["C003"] });
  };
  model.auditArticle = async ({ article, measuredLength }) => {
    calls.push("review");
    const findings = measuredLength.characters > measuredLength.maxCharacters
      ? [{ severity: "major", dimension: "structure", code: "target-length-exceeded", location: "article", message: "缩短重复说明" }]
      : [];
    if (!article.summary.includes("Paperbird")) findings.push({ severity: "major", dimension: "expression",
      code: "vague-masked-product-name", location: "summary", message: "在摘要写明已审核来源项目" });
    if (mode === "final review truncation" && article.summary.includes("Paperbird")) findings.push({ severity: "minor",
      dimension: "expression", code: "EDITORIAL_NOTE", location: "summary", message: "核对专用名词。" });
    return result({ assessment: "fixture", findings, coverage: { facts: true, structure: true, expression: true, policy: true, technical: true, visual: true } }, "content.audit.article");
  };
  if (mode === "final review truncation") {
    model.finalAuditArticle = async input => {
      if (!input.article.summary.includes("Paperbird")) return model.auditArticle(input);
      calls.push("final");
      throw new ApiError(502, "MODEL_OUTPUT_TRUNCATED", "isolated final response reached length");
    };
  }
  model.planBoundedRevision = async () => {
    calls.push("scope");
    return result({ paragraphs: sections.map(s => ({ sectionKey: s.key, paragraph: 2 })), summary: true, reason: "中段重复范围声明" }, "content.audit");
  };
  model.applyBoundedRevision = async ({ article, plan }) => {
    calls.push("edit");
    if (mode !== "bounded repair") throw new ApiError(502, "MODEL_OUTPUT_TRUNCATED", "isolated known truncated response");
    const edits = plan.paragraphs.map(({ sectionKey, paragraph }) => {
      const row = article.sections.find(section => section.key === sectionKey);
      const old = row.paragraphs[paragraph - 1];
      return { sectionKey, paragraph, text: plan.summary ? old.slice(0, -1) : old.slice(0, 35) };
    });
    return result({ edits, ...(plan.summary ? { summary: "Paperbird 历史修订的来源与限制。" } : {}) });
  };
  model.editRevisionBatch = async input => {
    assert.equal(Object.hasOwn(input, "article"), false);
    assert.equal(input.entries.length, 1);
    if (input.privateSummaryScope) {
      calls.push("summary");
      assert.ok(input.entries[0].text.includes("某历史"));
      return result({ texts: ["Paperbird 历史修订的来源与限制。"] }, "content.repair.copyedit");
    }
    const [entry] = input.entries;
    assert.equal(entry.paragraph, 2);
    assert.ok(entry.targetCharacters < entry.text.length);
    calls.push(entry.sectionKey);
    if (mode === "incomplete compact continuation") throw new ApiError(502, "MODEL_OUTPUT_TRUNCATED", "second fixture failure");
    return result({ texts: [entry.text.slice(0, Math.max(12, entry.targetCharacters - 2))] }, "content.repair.copyedit");
  };
  const adapter = createNativeBotAdapter({ app: { ...f, contentDirector: f.director } });
  const request = { taskId: "synthetic-private-trial", privateDraft: true, opportunity: { title: "Paperbird 历史资料精读", locale: "zh-CN" },
    claimIds: ["C003"], reviewCall: (input, review) => review(input) };
  const first = await adapter.prepareArticle(request);
  assert.equal(first.code, "NATIVE_ARTICLE_NOT_APPROVED");
  const original = await f.director.getJob(first.jobId);
  assert.equal(original.status, "blocked");
  const oldBytes = (await f.director.readArtifact(original.id, original.resultRef.name)).bytes;
  assert.ok(original.result.article.body.replace(/\s/g, "").length > 4000);
  calls.length = 0;
  const publicRetry = await adapter.prepareArticle({ ...request, privateDraft: false, jobId: original.id });
  assert.equal(publicRetry.code, "NATIVE_ARTICLE_NOT_APPROVED");
  assert.deepEqual(calls, []);
  if (mode !== "bounded repair") {
    await assert.rejects(adapter.prepareArticle({ ...request, jobId: original.id }), { code: "MODEL_OUTPUT_TRUNCATED" });
    const failed = await f.director.getJob(original.id);
    assert.equal(failed.currentStep, "article.repair");
    const failure = failed.steps.find(s => s.error?.code === "MODEL_OUTPUT_TRUNCATED");
    assert.ok(failure);
    const originalControl = { ...context(), actor: "bot-native-preparation", ifMatch: failed.etag };
    await assert.rejects(f.director.startJob(original.id, originalControl), { code: "ARTICLE_REVISION_UNAVAILABLE" });
    await f.director.startJob(original.id, originalControl, { resumeTruncatedRevision: true });
    await assert.rejects(f.director.processJob(original.id), { code: "MANAGED_JOB_LEASE_REQUIRED" });
    if (mode === "incomplete compact continuation") {
      await assert.rejects(f.director.processJob(original.id, { managedExecution: true }), { code: "MODEL_OUTPUT_TRUNCATED" });
      const incomplete = await f.director.getJob(original.id);
      assert.equal(incomplete.resultHash, original.resultHash);
      assert.equal(incomplete.review, null);
      assert.deepEqual(incomplete.steps.find(s => s.id === failure.id), failure);
      assert.ok(incomplete.steps.some(s => s.key.includes(":batch:") && s.status === "succeeded" && s.receipt?.responseId));
      await assert.rejects(f.director.startJob(original.id, { ...originalControl, ifMatch: incomplete.etag }, { resumeTruncatedRevision: true }),
        { code: "ARTICLE_REVISION_UNAVAILABLE" });
      assert.deepEqual(calls, ["scope", "edit", "summary", "section0"]);
      return;
    }
    if (mode === "final review truncation") {
      await assert.rejects(f.director.processJob(original.id, { managedExecution: true }), { code: "MODEL_OUTPUT_TRUNCATED" });
      const stopped = await f.director.getJob(original.id);
      const scopeStepId = stopped.truncatedRevision.scopeId;
      const binding = { sourceSha256: original.resultRef.sha256, scopeStepId };
      const read = () => f.director.readReviewedRevisionPreview(original.id, binding);
      assert.equal(stopped.currentStep, "quality.final");
      const snapshot = f.store.snapshot();
      const priorCalls = [...calls];
      const preview = await read();
      assert.deepEqual(await read(), preview);
      assert.equal(preview.approved, false);
      assert.equal(preview.editedBatches, 8);
      assert.equal(preview.stage, "quality.final");
      assert.equal(preview.code, "MODEL_OUTPUT_TRUNCATED");
      assert.equal(preview.characters, preview.body.replace(/\s/gu, "").length);
      assert.notEqual(preview.body, original.result.article.body);
      assert.notEqual(preview.contentHash, original.resultHash);
      const first = stopped.reports.find(row => row.contentHash === preview.contentHash && row.phase === "quality.review");
      assert.equal(first.modelReceipt.responseId, preview.reviewResponseId);
      assert.deepEqual(preview.firstReview, { reportHash: first.reportHash, minor: 1, major: 0, blocker: 0, suggestion: 0 });
      assert.deepEqual(f.store.snapshot(), snapshot);
      assert.deepEqual(calls, priorCalls);
      assert.deepEqual(decisions.map(d => d.kind), ["geo_claim"]);
      await assert.rejects(f.director.readReviewedRevisionPreview(original.id, { ...binding, scopeStepId: "other" }),
        { code: "ARTICLE_REVISION_PREVIEW_UNAVAILABLE" });
      await assert.rejects(f.director.readReviewedRevisionPreview(original.id, { ...binding, sourceSha256: "a".repeat(64) }),
        { code: "ARTICLE_REVISION_PREVIEW_UNAVAILABLE" });
      const batch = stopped.steps.find(s => s.kind === "article.repair" && s.key.includes(":batch:"));
      const file = join(f.store.filePath, "..", "content-director", original.id, batch.artifact.name);
      const bytes = await readFile(file);
      await writeFile(file, Buffer.alloc(bytes.length, "x"));
      await assert.rejects(read(), { code: "CONTENT_ARTIFACT_CHANGED" });
      await writeFile(file, bytes);
      const final = stopped.steps.find(s => s.kind === "quality.final" && s.status === "failed");
      await f.store.mutate({ type: "test.mismatched_failed_final", actor: "fixture", payload: {} }, state => {
        state.contentDirectorSteps.find(s => s.id === final.id).inputHash = "f".repeat(64);
      });
      await assert.rejects(read(), { code: "ARTICLE_REVISION_PREVIEW_UNAVAILABLE" });
      assert.deepEqual(calls, priorCalls);
      return;
    }
    const finished = await f.director.processJob(original.id, { managedExecution: true });
    assert.deepEqual(finished.steps.find(s => s.id === failure.id), failure);
    const batches = finished.steps.filter(s => s.key.includes(":batch:"));
    assert.ok(batches.every(s => s.status === "succeeded" && s.receipt.responseId && s.output.scopeId && s.output.batch && s.artifact.sha256));
    assert.deepEqual(calls, ["scope", "edit", "summary", ...sections.map(s => s.key), "review", "review"]);
  }
  const second = await adapter.prepareArticle({ ...request, jobId: original.id });
  assert.equal(second.state, "succeeded");
  if (mode === "bounded repair") assert.deepEqual(calls, ["scope", "edit", "edit", "review", "review"]);
  const revised = await f.director.getJob(original.id);
  assert.equal(revised.status, "approved");
  assert.equal(revised.result.boundedRevision.parentArtifactSha256, original.resultRef.sha256);
  assert.notEqual(revised.resultHash, original.resultHash);
  assert.notEqual(revised.result.illustrationHandoff.sourceHash, original.result.illustrationHandoff.sourceHash);
  assert.equal(revised.result.boundedRevision.revisedLength.characters <= 4000, true);
  assert.deepEqual((await f.director.readArtifact(original.id, original.resultRef.name)).bytes, oldBytes);
  assert.equal(revised.result.article.sourceReferences[0].url, source.url);
  revised.result.article.sections.forEach((section, i) => {
    assert.deepEqual(section.claimIds, original.result.article.sections[i].claimIds);
    assert.equal(section.title, original.result.article.sections[i].title);
    for (const at of [0, 2]) assert.equal(section.paragraphs[at], original.result.article.sections[i].paragraphs[at]);
  });
  assert.deepEqual(decisions.map(d => d.kind), ["geo_claim", "content-director-package"]);
  assert.equal(decisions[1].snapshotHash, revised.resultHash);
  assert.equal(second.privateDraft.body, revised.result.article.body);
  calls.length = 0;
  assert.deepEqual(await adapter.prepareArticle({ ...request, jobId: original.id }), second);
  assert.deepEqual(calls, []);
}
