import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { Readable } from "node:stream";
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
import { bindFixtureIllustrations } from "./fixtures/article-illustrations.mjs";
import { createContentVideoHandoff } from "../src/video-runtime/content-video-router.mjs";
import { createNativeBotAdapter } from "../src/bot/operations-native.mjs";
import { hashObject } from "../src/domain/hash.mjs";

const RECEIPT = {
  requestedModel: "advanced-fixture",
  resolvedModel: "advanced-fixture",
  responseId: "advanced",
  requestHash: "a".repeat(64),
  responseHash: "b".repeat(64),
  usage: { total_tokens: 1 },
};

const paragraph = (topic, key, part) =>
  `${part}。这是「${topic}」在 ${key} 场景中的完整说明，需要交代问题、权限、执行、失败恢复、人工责任和真实回执，不能只给抽象结论。第 ${key} 段还必须解释取舍、限制和不能自动化的边界，确保读者能够复核判断。`;

class AdvancedModel {
  constructor(options = {}) {
    this.options = options;
    this.activeDrafts = 0;
    this.maxActiveDrafts = 0;
    this.draftCalls = [];
    this.auditCalls = 0;
    this.firstDraftStarted = null;
    this.releaseFirstDraft = null;
    this.started = new Promise(resolve => { this.firstDraftStarted = resolve; });
    this.release = new Promise(resolve => { this.releaseFirstDraft = resolve; });
  }

  async generateOutline({ brief }) {
    if (brief.topic.includes("MODEL_FAILURE")) {
      const error = new Error("fixture model failure");
      error.code = "FIXTURE_MODEL_FAILURE";
      throw error;
    }
    return {
      value: {
        title: brief.topic.slice(0, 100),
        summary: "围绕真实问题、工程取舍和交付边界展开。",
        sections: [
          { key: "problem", title: "问题与约束", purpose: "界定问题", targetCharacters: 250, claimIds: [] },
          { key: "method", title: "方法与取舍", purpose: "说明方法和失败路径", targetCharacters: 300, claimIds: [] },
          { key: "delivery", title: "交付与验证", purpose: "说明回执边界", targetCharacters: 250, claimIds: [] },
        ],
      },
      receipt: RECEIPT,
    };
  }

  async draftSection({ brief, section }) {
    this.draftCalls.push(`${brief.topic}:${section.key}`);
    this.activeDrafts++;
    this.maxActiveDrafts = Math.max(this.maxActiveDrafts, this.activeDrafts);
    try {
      if (this.options.pauseFirst && this.draftCalls.length === 1) {
        this.firstDraftStarted();
        await this.release;
      }
      if (this.options.delayMs) await new Promise(resolve => setTimeout(resolve, this.options.delayMs));
      const retained = brief.mustKeep?.length ? `必须保留：${brief.mustKeep.join("；")}。` : "";
      const body = [`${paragraph(brief.topic, section.key, "先看真实问题")}${retained}`, paragraph(brief.topic, section.key, "再看工程取舍"), paragraph(brief.topic, section.key, "最后看交付")]
        .join("\n\n");
      return { value: { title: section.title, body, paragraphs: body.split("\n\n"), claimIds: this.options.citeClaimIds ?? [] }, receipt: RECEIPT };
    } finally {
      this.activeDrafts--;
    }
  }

  async auditArticle() {
    this.auditCalls++;
    if (this.options.repairFirst && this.auditCalls === 1) {
      return {
        value: {
          assessment: "A section needs a bounded repair.",
          findings: [{
            severity: "blocker",
            dimension: "structure",
            code: "FIXTURE_REPAIR_REQUIRED",
            location: "section:0",
            message: "The first section needs a bounded replacement.",
            allowedChanges: ["section:0"],
          }],
          coverage: { facts: "checked", structure: "blocked", expression: "checked", policy: "checked", technical: "checked", visual: "not-applicable" },
        },
        receipt: RECEIPT,
      };
    }
    return {
      value: {
        assessment: "No blocking findings.",
        findings: [],
        coverage: { facts: "checked", structure: "checked", expression: "checked", policy: "checked", technical: "checked", visual: "not-applicable" },
      },
      receipt: RECEIPT,
    };
  }

  async repairSection({ brief, section }) {
    const body = [paragraph(brief.topic, `${section.key}-repaired`, "修复后的目标段"), paragraph(brief.topic, `${section.key}-repaired`, "修复后的证据段"), paragraph(brief.topic, `${section.key}-repaired`, "修复后的边界段")]
      .join("\n\n");
    return { value: { title: section.title, body, paragraphs: body.split("\n\n"), claimIds: [] }, receipt: RECEIPT };
  }

  async planVisuals() {
    return {
      value: {
        visuals: [
          {
            kind: "architecture",
            title: "内容总控架构",
            alt: "内容总控连接文章、视觉和视频生产线的关系图",
            caption: "图 1：三条生产线",
            claimIds: [],
            nodes: [{ id: "director", label: "内容总控" }, { id: "article", label: "文章生产线" }, { id: "video", label: "视频生产线" }],
            edges: [{ from: "director", to: "article", label: "路由" }, { from: "director", to: "video", label: "路由" }],
          },
          {
            kind: "infographic",
            title: "审核与回执",
            alt: "说明审核后仍需独立发布回执的信息图",
            caption: "图 2：审核与回执分开",
            claimIds: [],
            items: [{ label: "审核", description: "核对完整内容" }, { label: "回执", description: "核对真实发布结果" }],
          },
        ],
      },
      receipt: RECEIPT,
    };
  }
}

const context = options => ({ method: "local", actor: "advanced fixture reviewer", idempotencyKey: randomUUID(), ...options });

async function fixture(t, model, { autoStart = false, contentOps = null, mode = "enabled" } = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pm-content-advanced-"));
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  await store.open(() => loadSeedState(resolve(import.meta.dirname, "fixtures/legacy-plane/seed")));
  await migrateEditorialState(store, { publicOrigin: "https://workbench.example.net" });
  const backup = createEditorialBackup({ store });
  await migrateContentOpsState(store, { beforeMigration: () => backup.captureCurrent() });
  await migrateContentDirectorState(store, { beforeMigration: () => backup.captureCurrent() });
  const geo = new GeoOsService({ store });
  await geo.approveClaim("C003", { approvedBy: "advanced fixture reviewer", publicLevel: "private" });
  const mediaAssets = new MediaAssets({ store });
  await mediaAssets.initialize();
  const editorial = new EditorialService({ store, geoService: geo, mediaAssets, publicOrigin: "https://workbench.example.net" });
  const director = new ContentDirectorService({
    store,
    model,
    editorial,
    contentOps,
    artifactRoot: join(directory, "content-director"),
    autoStart,
    mode,
  });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, editorial, director, mediaAssets };
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("TIMEOUT");
}

test("real uploaded markdown is hashed, persisted and bound into the Job", async t => {
  const model = new AdvancedModel();
  const f = await fixture(t, model);
  const bytes = Buffer.from("# Author material\n\nThis is real author-supplied source material.\n");
  const uploaded = await f.director.uploadAttachment(Readable.from([bytes]), {
    role: "document",
    mime: "text/markdown",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    name: "author-notes.md",
  }, context());
  assert.match(uploaded.id, /^CDU-[a-f0-9]{32}$/);
  assert.equal(uploaded.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal((await f.director.readAttachment(uploaded.id)).bytes.toString(), bytes.toString());
  const job = await f.director.createJob({
    intent: "根据真实作者材料写一篇文章",
    explicitKind: "article",
    attachments: [{ kind: "document", id: uploaded.id }],
    targetLength: { minCharacters: 500, maxCharacters: 1200 },
  }, context());
  assert.equal(job.input.attachments[0].sha256, uploaded.sha256);
  const completed = await f.director.processJob(job.id);
  assert.equal(completed.status, "needs_review");
  assert.equal(completed.steps.some(step => step.kind === "attachment.ingest"), true);
});

test("disabled content director preserves old services while refusing new work", async t => {
  const f = await fixture(t, new AdvancedModel(), { mode: "disabled" });
  assert.deepEqual(f.director.getStatus().enabled, false);
  assert.equal(f.director.getStatus().writable, false);
  await assert.rejects(f.director.resolveIntent({ intent: "写一篇文章" }), { code: "CONTENT_DIRECTOR_DISABLED" });
});

test("batch scheduler stays at two active Jobs and isolates one model failure", async t => {
  const model = new AdvancedModel({ delayMs: 15 });
  const f = await fixture(t, model, { autoStart: true });
  const batch = await f.director.createBatch({
    name: "parallel fixture",
    topics: ["写文章：任务一", "写文章：MODEL_FAILURE", "写文章：任务三", "写文章：任务四"].map(intent => ({ intent })),
    shared: {
      explicitKind: "article",
      claimIds: ["C003"],
      targetLength: { minCharacters: 500, maxCharacters: 1200 },
    },
  }, context());
  assert.equal(batch.jobs.length, 4);
  await waitFor(() => f.director.getBatch(batch.id).jobs.every(job => ["needs_review", "failed", "blocked"].includes(job.status)), 30_000)
    .catch(error => {
      const statuses = f.director.getBatch(batch.id).jobs.map(job => `${job.id}=${job.status}:${job.error?.code ?? job.currentStep}`);
      throw new Error(`Batch jobs did not settle: ${statuses.join(", ")}`, { cause: error });
    });
  const finalBatch = f.director.getBatch(batch.id);
  assert.equal(finalBatch.jobs.filter(job => job.status === "needs_review").length, 3);
  assert.equal(finalBatch.jobs.filter(job => job.status === "failed").length, 1);
  assert.ok(model.maxActiveDrafts <= 2, `max active drafts was ${model.maxActiveDrafts}`);
});

test("pause keeps the completed section checkpoint and resume finishes without a paid repeat", async t => {
  const model = new AdvancedModel({ pauseFirst: true });
  const f = await fixture(t, model, { autoStart: true });
  const job = await f.director.createJob({
    intent: "写一篇关于长任务恢复的技术文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1200 },
  }, context());
  await f.director.startJob(job.id, context());
  await model.started;
  const running = await f.director.getJob(job.id);
  await f.director.pauseJob(job.id, context({ ifMatch: running.etag }));
  model.releaseFirstDraft();
  const paused = await waitFor(async () => {
    const row = await f.director.getJob(job.id);
    return row.status === "needs_resume" ? row : null;
  }).catch(async error => {
    const row = await f.director.getJob(job.id);
    throw new Error(`${error.message}: ${row.status} pauseRequested=${row.pauseRequested} error=${JSON.stringify(row.error)}`, { cause: error });
  });
  await f.director.resumeJob(job.id, context({ ifMatch: paused.etag }));
  const completed = await waitFor(async () => {
    const row = await f.director.getJob(job.id);
    return row.status === "needs_review" ? row : null;
  }).catch(async error => {
    const row = await f.director.getJob(job.id);
    throw new Error(`${error.message}: after resume ${row.status} pauseRequested=${row.pauseRequested} error=${JSON.stringify(row.error)}`, { cause: error });
  });
  assert.equal(completed.status, "needs_review");
  assert.equal(model.draftCalls.filter(value => value.endsWith(":problem")).length, 1);
});

test("Brief edits and a manually frozen outline use exact ETags and drive the final sections", async t => {
  const model = new AdvancedModel();
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "写一篇关于内容治理的技术文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1200 },
  }, context());
  const patched = await f.director.patchBrief(job.id, {
    goal: "解释权限、证据、审核和回执的边界",
    authorThoughts: ["用户中心思想不能被改写"],
    mustKeep: ["用户中心思想不能被改写"],
  }, context({ ifMatch: job.etag }));
  const outline = {
    title: "内容治理的四个边界",
    summary: "从权限、证据、审核和回执解释可核验内容治理。",
    sections: [
      { key: "authority", title: "权限边界", purpose: "解释谁可以动作", targetCharacters: 250, claimIds: ["C003"] },
      { key: "evidence", title: "证据边界", purpose: "解释事实来源", targetCharacters: 300, claimIds: ["C003"] },
      { key: "receipt", title: "回执边界", purpose: "解释完成证明", targetCharacters: 250, claimIds: ["C003"] },
    ],
  };
  const frozen = await f.director.freezeOutline(job.id, { outline }, context({ ifMatch: patched.etag }));
  assert.equal(frozen.outlineRef.hash, (await import("../src/domain/hash.mjs")).hashObject(outline));
  const completed = await f.director.processJob(job.id);
  assert.deepEqual(completed.result.article.sections.map(section => section.key), ["authority", "evidence", "receipt"]);
  assert.equal(completed.result.findings.some(finding => finding.code === "MUST_KEEP_MISSING"), false);
});

test("model blocker triggers a bounded repair and a fresh final audit", async t => {
  const model = new AdvancedModel({ repairFirst: true });
  const f = await fixture(t, model);
  const job = await f.director.createJob({
    intent: "写一篇关于定点修复的技术文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1200 },
  }, context());
  const result = await f.director.processJob(job.id);
  assert.equal(result.status, "needs_review");
  assert.equal(result.steps.some(step => step.kind === "article.repair"), true);
  assert.equal(f.store.snapshot().contentRepairAttempts.length, 1);
  assert.equal(result.reports.some(report => report.phase === "quality.final" && report.contentHash === result.result.contentHash), true);
});

test("an approved visual package can be reordered without overwriting the previous revision", async t => {
  const model = new AdvancedModel({ citeClaimIds: ["C003"] });
  const f = await fixture(t, model);
  const releaseUrl = "https://github.com/google/guetzli/releases/tag/v1.0.1";
  await f.store.mutate({ type: "fixture.public_release", actor: "fixture" }, state => {
    state.claims.find(row => row.id === "C003").source = { label: "Guetzli release", url: releaseUrl, visibility: "public" };
  });
  const claim = await new GeoOsService({ store: f.store }).approveClaim("C003", {
    approvedBy: "advanced fixture reviewer", publicLevel: "approved_public",
  });
  const job = await f.director.createJob({
    intent: "写一篇内容系统文章，并配两张可编辑图",
    explicitKind: "article_visual",
    claimIds: ["C003"],
    mustKeep: [`（${claim.source.url}）`],
    targetLength: { minCharacters: 500, maxCharacters: 1200 },
    enableVisuals: true,
  }, context());
  const first = await f.director.processJob(job.id);
  assert.equal(first.status, "needs_review");
  assert.ok(first.result.article.body.includes(claim.source.url));
  assert.equal(first.result.visuals.length, 2);
  const ids = first.result.visuals.map(row => row.id);
  const revised = await f.director.reviseVisuals(job.id, {
    orderedVisualIds: [...ids].reverse(),
    updates: [],
  }, context({ ifMatch: first.etag }));
  assert.deepEqual(revised.result.visuals.map(row => row.id), [...ids].reverse());
  assert.notEqual(revised.result.contentHash, first.result.contentHash);
  assert.equal(revised.status, "needs_review");
  assert.equal(f.store.snapshot().contentDirectorRevisions.some(row => row.kind === "visuals"), true);
});

test("production-shaped findings bind numeric text and keyed sections to independently scoped paragraph edits", async t => {
  const model = new AdvancedModel();
  const originalDraft = model.draftSection.bind(model);
  const originals = new Map();
  model.draftSection = async input => {
    const result = await originalDraft(input);
    if (input.section.key === "problem") {
      result.value.paragraphs[0] += "一个未经验证的数值 42。";
      result.value.body = result.value.paragraphs.join("\n\n");
    }
    originals.set(input.section.key, [...result.value.paragraphs]);
    return result;
  };
  const originalAudit = model.auditArticle.bind(model);
  model.auditArticle = async input => {
    const result = await originalAudit(input);
    if (model.auditCalls === 1) result.value.findings.push({ severity: "major", dimension: "facts", code: "SCOPE_CONTRADICTION",
      location: "section:method", message: "第二段应区分建议和经核查的结论。", allowedChanges: [] });
    return result;
  };
  model.planSectionRepair = async input => {
    assert.equal(input.sectionKey, "method");
    return { value: { paragraphs: [2], reason: "The second original paragraph conflates guidance with a claim." }, receipt: RECEIPT };
  };
  model.repairSection = async input => {
    const n = input.section.key === "problem" ? 1 : 2;
    assert.deepEqual(input.allowedParagraphs, [n]);
    const text = input.currentSection.paragraphs[n-1].replace("一个未经验证的数值 42。", "") + "这属于建议，读者仍可自行核查。";
    return { value: { edits: [{ paragraph: n, text }], claimIds: [] }, receipt: RECEIPT };
  };
  const f = await fixture(t, model);
  const source = "https://github.com/google/guetzli/releases/tag/v1.0.1";
  await f.store.mutate({ type: "fixture.public_scope", actor: "fixture" }, state => {
    state.claims.find(row => row.id === "C003").source = { label: "Historical release", url: source, visibility: "public" };
  });
  await new GeoOsService({ store: f.store }).approveClaim("C003", { approvedBy: "fixture reviewer", publicLevel: "approved_public" });
  const audience = "给维护既有系统的工程师。读者需要知道项目名称、操作步骤和如何设计验证。";
  const job = await f.director.createJob({ intent: "编写回归验证指南", explicitKind: "article", claimIds: ["C003"], audience,
    allowWebResearch: false, targetLength: { minCharacters: 500, maxCharacters: 1600 } }, context());
  const result = await f.director.processJob(job.id);
  assert.equal(result.status, "needs_review");
  const article = result.result.article;
  assert.ok(article.body.includes(source));
  assert.equal(article.tags.includes(audience), false);
  assert.deepEqual(article.sourceReferences, [{claimId: "C003", url: source}]);
  assert.deepEqual(article.sections[0].paragraphs.slice(1), originals.get("problem").slice(1));
  assert.equal(article.sections[1].paragraphs[0], originals.get("method")[0]);
  assert.equal(article.sections[1].paragraphs[2], originals.get("method")[2]);
  assert.deepEqual(article.sections[2].paragraphs, originals.get("delivery"));
  assert.equal(result.reports.find(r => r.phase === "quality.final").contentHash, result.result.contentHash);
  assert.ok(result.steps.some(s => s.kind === "repair.scope" && s.receipt));
});

test("bare default keys identify their own section and cannot authorize a different numeric index", async t => {
  const model = new AdvancedModel();
  const generate = model.generateOutline.bind(model);
  model.generateOutline = async input => {
    const result = await generate(input);
    result.value.sections.forEach(section => { delete section.key; });
    return result;
  };
  const audit = model.auditArticle.bind(model);
  model.auditArticle = async input => {
    const result = await audit(input);
    if (model.auditCalls === 1) {
      const base = { severity: "major", dimension: "structure", message: "Only the first section was approved for rewriting.",
        allowedChanges: ["section-1"] };
      result.value.findings = [{ ...base, code: "FIRST", location: "section-1" }, { ...base, code: "SECOND", location: "section:1" }];
    }
    return result;
  };
  const calls = [];
  const repair = model.repairSection.bind(model);
  model.repairSection = async input => {
    calls.push(input.section.key);
    assert.deepEqual(input.findings.map(finding => finding.code), ["FIRST"]);
    return repair(input);
  };
  const f = await fixture(t, model);
  const job = await f.director.createJob({ intent: "编写验证指南", explicitKind: "article", claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1600 } }, context());
  const result = await f.director.processJob(job.id);
  assert.deepEqual(calls, ["section-1"]);
  assert.equal(result.status, "blocked");
  assert.ok(result.findings.some(finding => finding.code === "SECOND" && finding.status === "open"));
});

test("an empty independent repair scope leaves the actual blocking finding open", async t => {
  const model = new AdvancedModel({repairFirst:true});
  const audit = model.auditArticle.bind(model);
  model.auditArticle = async input => {
    const result = await audit(input);
    result.value.findings.forEach(f => { f.allowedChanges = []; });
    return result;
  };
  model.planSectionRepair = async () => ({ value: {paragraphs: [], reason: "No specific edit can be justified."}, receipt: RECEIPT });
  model.repairSection = async () => assert.fail("No paragraph edit was authorized");
  const f = await fixture(t, model);
  const job = await f.director.createJob({ intent: "编写验证指南", explicitKind: "article", claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1600 } }, context());
  const result = await f.director.processJob(job.id);
  assert.equal(result.status, "blocked");
  assert.ok(result.findings.some(f => f.status === "open" && f.code === "FIXTURE_REPAIR_REQUIRED"));
});

test("a valid old repair receipt is reused after interruption without another paid repair", async t => {
  const model = new AdvancedModel({ repairFirst: true });
  const f = await fixture(t, model);
  let legacyInput;
  const repair = model.repairSection.bind(model);
  model.repairSection = async input => {
    const { sectionIndex, ...original } = input;
    assert.equal(sectionIndex, 0);
    legacyInput = original;
    return repair(input);
  };
  const review = model.auditArticle.bind(model);
  model.auditArticle = async input => {
    if (model.auditCalls === 1) throw new Error("Interrupted after successful repair");
    return review(input);
  };
  const job = await f.director.createJob({ intent: "编写回归验证指南", explicitKind: "article", claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1600 } }, context());
  await assert.rejects(f.director.processJob(job.id), /Interrupted after successful repair/);
  await f.store.mutate({ type: "fixture.old_repair_receipt", actor: "fixture" }, state => {
    const step = state.contentDirectorSteps.find(row => row.jobId === job.id && row.kind === "article.repair");
    assert.equal(step.status, "succeeded");
    step.key = `${step.output.sectionKey}:round-${step.output.round}:${step.output.beforeHash}`;
    step.inputHash = hashObject(legacyInput);
  });
  model.auditArticle = review;
  model.repairSection = async () => assert.fail("A matching old receipt already binds this repair");
  await f.director.startJob(job.id, context());
  const result = await f.director.processJob(job.id);
  assert.equal(result.status, "needs_review");
  assert.equal(result.steps.filter(row => row.kind === "article.repair").length, 1);
});

test("a patch to a paragraph outside the independent scope is rejected", async t => {
  const model = new AdvancedModel({ repairFirst: true });
  const audit = model.auditArticle.bind(model);
  model.auditArticle = async input => {
    const result = await audit(input);
    result.value.findings.forEach(finding => { finding.allowedChanges = []; });
    return result;
  };
  model.planSectionRepair = async () => ({ value: { paragraphs: [2], reason: "Only paragraph 2 addresses the issue." }, receipt: RECEIPT });
  model.repairSection = async () => ({ value: { edits: [{ paragraph: 1, text: "Unexpected change." }] }, receipt: RECEIPT });
  const f = await fixture(t, model);
  const job = await f.director.createJob({ intent: "编写验证指南", explicitKind: "article", claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1600 } }, context());
  await assert.rejects(f.director.processJob(job.id), { code: "REPAIR_SCOPE_VIOLATION" });
  assert.equal(f.store.snapshot().contentRepairAttempts.length, 0);
});

test("stale conditional restarts preserve newer owner pause and cancellation decisions", async t => {
  const f = await fixture(t, new AdvancedModel());
  const job = await f.director.createJob({ intent: "编写验证指南", explicitKind: "article", claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1600 } }, context());
  const paused = await f.director.pauseJob(job.id, context({ ifMatch: job.etag }));
  await assert.rejects(f.director.startJob(job.id, context({ ifMatch: job.etag })), { code: "PRECONDITION_FAILED" });
  assert.equal((await f.director.getJob(job.id)).pauseRequested, true);
  await f.director.cancelJob(job.id, context({ ifMatch: paused.etag }));
  await assert.rejects(f.director.startJob(job.id, context({ ifMatch: paused.etag })), { code: "PRECONDITION_FAILED" });
  await assert.rejects(f.director.startJob(job.id, context()), { code: "CONTENT_JOB_NOT_STARTABLE" });
  assert.equal((await f.director.getJob(job.id)).status, "cancelled");
});

test("the original BOT managed job can recover its known repair failure after losing the step checkpoint", async t => {
  const f = await fixture(t, new AdvancedModel());
  await new GeoOsService({ store: f.store }).approveClaim("C003", { approvedBy: "fixture reviewer", publicLevel: "approved_public" });
  const calls = [];
  const original = { id: "CDJ-fixture", createdBy: "bot-native-preparation", managedExecution: true,
    input: { intent: "原始选题", language: "zh-CN", claimIds: ["C003"] }, status: "failed", error: {code:"REPAIR_SCOPE_REQUIRED"} };
  const director = { aiApproval: {}, getStatus: () => ({runningJobs:0, maxConcurrentJobs:2}),
    async createJob() { calls.push("read original idempotency key"); return original; },
    async startJob(id) { assert.equal(id, original.id); calls.push("resume"); return {...original,status:"queued"}; },
    async processJob(id, policy) { assert.deepEqual(policy,{managedExecution:true}); calls.push("process"); return {...original,status:"queued"}; } };
  const native = createNativeBotAdapter({app:{store:f.store,editorial:f.editorial, contentDirector:director}});
  const input = {taskId:"same-private-task", opportunity:{title:"原始选题",locale:"zh-CN"},claimIds:["C003"],privateDraft:true,
    onJob: id => { assert.equal(id,original.id); calls.push("restore checkpoint"); }, runModel: work => work()};
  assert.equal((await native.prepareArticle(input)).state, "retry");
  assert.deepEqual(calls, ["read original idempotency key","restore checkpoint","resume","process"]);
  calls.length = 0;
  original.error.code = "AI_APPROVAL_REVIEW_UNRESOLVED";
  assert.equal((await native.prepareArticle(input)).state, "waiting_input");
  assert.deepEqual(calls, ["read original idempotency key","restore checkpoint"]);
});

test("reviewed source bytes reach private planning, authoring and the final independent package review", async t => {
  const model = new AdvancedModel();
  const f = await fixture(t, model);
  const geo = new GeoOsService({ store: f.store });
  const excerpt = "Historical fixture release: adds a documented operating limit.";
  const aiApproval = { async review(input) {
    return { actor: "ai-reviewer", kind: input.kind, decision: "approve", snapshotHash: input.snapshotHash,
      evidenceHash: hashObject(input.evidence), reviewedAt: "2025-01-01T00:00:00.000Z" };
  } };
  await geo.approveClaim("C003", { publicLevel: "approved_public", sourceExcerpt: excerpt }, { ...context(), aiApproval });
  const native = createNativeBotAdapter({ app: { store: f.store, editorial: f.editorial, contentDirector: f.director } });
  const [fact] = await native.resolveClaims(["C003"]);
  assert.equal(fact.reviewedSource.excerpt, excerpt);
  assert.equal(fact.reviewedSource.registeredClaimUrl, fact.sourceUrl);
  const draft = model.draftSection.bind(model);
  model.draftSection = async input => {
    assert.deepEqual(input.brief.claims[0].reviewedSource, fact.reviewedSource);
    return draft(input);
  };
  f.director.aiApproval = { async review(input) {
    assert.equal(input.kind, "content-director-package");
    assert.deepEqual(input.evidence.reviewedClaimSources, [fact.reviewedSource]);
    return aiApproval.review(input);
  } };
  const job = await f.director.createJob({ intent: "编写历史说明的阅读指南", explicitKind: "article", claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1600 } }, context());
  const result = await f.director.processJob(job.id);
  assert.equal(result.status, "needs_review");
  const approved = await f.director.approveJob(job.id, { contentHash: result.result.contentHash }, context({ ifMatch: result.etag }));
  assert.equal(approved.review.aiApproval.decision, "approve");
  await f.store.mutate({ type: "fixture.change_source_bytes", actor: "fixture" }, state => {
    state.editorialClaimSourceExcerpts[0].excerpt += " Altered after review.";
  });
  assert.equal((await native.resolveClaims(["C003"]))[0].reviewedSource, undefined);
});

test("article citations retain legacy URL sources and reject private or unbound links", async t => {
  const f = await fixture(t, new AdvancedModel());
  const legacy = "https://nodejs.org/en/about";
  const restricted = "https://nodejs.org/private";
  const unbound = "https://github.com/google/guetzli/releases/latest";
  await f.store.mutate({ type: "fixture.citation_sources", actor: "fixture" }, state => {
    const claim = state.claims.find(row => row.id === "C003");
    claim.source = legacy;
    state.claims.push(
      { ...claim, id: "C-test-private", publicLevel: "approved_public", source: { visibility: "private", url: restricted } },
      { ...claim, id: "C-test-unbound", publicLevel: "approved_public", source: { visibility: "public", url: unbound } },
    );
  });
  const job = await f.director.createJob({
    intent: "写一篇关于来源引用的文章", explicitKind: "article", claimIds: ["C003", "C-test-private"],
    mustKeep: [legacy, restricted, unbound], targetLength: { minCharacters: 500, maxCharacters: 1600 },
  }, context());
  const { status, result } = await f.director.processJob(job.id);
  assert.equal(status, "blocked");
  assert.ok(result.article.body.includes(legacy));
  const rejected = result.findings.filter(row => row.code === "UNBOUND_URL")
    .map(row => result.article.body.slice(row.location).split(/[；。]/u)[0]);
  assert.deepEqual(new Set(rejected), new Set([restricted, unbound]));
});

test("pure visual and video jobs freeze readable private result artifacts", async t => {
  const model = new AdvancedModel();
  const f = await fixture(t, model);
  const visualJob = await f.director.createJob({
    intent: "做一张内容生产线架构图，不要文章",
    explicitKind: "pure_visual",
  }, context());
  const visual = await f.director.processJob(visualJob.id);
  assert.equal(visual.status, "needs_review");
  assert.equal(visual.result.visuals.length, 2);
  const videoJob = await f.director.createJob({
    intent: "做一条 30 秒 AI 生成的品牌短视频",
    explicitKind: "video_ai",
    durationSec: 30,
  }, context());
  const video = await f.director.processJob(videoJob.id);
  assert.equal(video.status, "needs_input");
  assert.equal(video.result.videoPlan.productionVerified, false);
  assert.equal(video.result.videoPlan.handoff.productionAuthorized, false);
});

test("completed Edition can be handed to the existing content-ops planner without publication authority", async t => {
  const model = new AdvancedModel();
  const contentOps = {
    planTemplate(input) {
      assert.equal(typeof input.editionId, "string");
      return {
        plan: {
          schema: "pengmanager.adaptation-plan/v1",
          storyRef: { id: input.storyId },
          motherEditionRefs: [{ id: input.editionId }],
          targets: input.targets.map(target => ({ ...target, decision: "needs_input" })),
          mode: "prepare",
          containsCommands: false,
        },
        gaps: [{ code: "RULES_REVIEW_REQUIRED", inputKey: "rulesRef", explanation: "fixture gap" }],
        sourceRefs: {},
      };
    },
  };
  const f = await fixture(t, model, { contentOps });
  const job = await f.director.createJob({
    intent: "写一篇关于内容交接的技术文章",
    explicitKind: "article",
    claimIds: ["C003"],
    targetLength: { minCharacters: 500, maxCharacters: 1200 },
  }, context());
  const reviewed = await f.director.processJob(job.id);
  const approved = await f.director.approveJob(job.id, {
    reviewed: true,
    contentHash: reviewed.result.contentHash,
    note: "Read the complete fixture package.",
  }, context({ ifMatch: reviewed.etag }));
  const prepared = await f.director.prepareArticleIllustrations(job.id, {
    contentHash: approved.result.contentHash,
  }, context({ ifMatch: approved.etag }));
  await bindFixtureIllustrations(f.editorial, f.mediaAssets, prepared.plan);
  const materialized = await f.director.materializeEdition(job.id, {
    contentHash: approved.result.contentHash,
  }, context({ ifMatch: prepared.job.etag }));
  assert.ok(materialized.edition.id);
  const completed = await f.director.getJob(job.id);
  const plan = await f.director.createContentOpsPlan(job.id, {
    targets: [{ destinationId: "DST-fixture", locale: "zh-CN", nativeForm: "article" }],
    goal: "Prepare a truthful platform adaptation.",
    budgetAuthorizationId: null,
    sourceArtifactIds: [],
    nativeInputs: [],
  }, context({ ifMatch: completed.etag }));
  assert.equal(plan.publicationAuthorized, false);
  assert.equal(plan.gaps[0].code, "RULES_REVIEW_REQUIRED");
  assert.equal(f.store.snapshot().contentPublishPackages.length, 1);
});

test("video router issues real executor handoffs without claiming production", () => {
  const ai = createContentVideoHandoff({
    id: "CDJ-ai",
    artifactKind: "video_ai",
    input: { intent: "生成一条 30 秒 AI 产品短片", durationSec: 30, attachments: [] },
    route: { videoSubroute: "marketing" },
  }, { capabilities: { ready: true, state: "ready", sourceMain: "fixture", categories: [] } });
  assert.equal(ai.route.executorId, "pengmanager.standard-video");
  assert.equal(ai.productionVerified, false);
  assert.equal(ai.productionAuthorized, false);
  const mixed = createContentVideoHandoff({
    id: "CDJ-mixed",
    artifactKind: "video_mixed",
    input: {
      intent: "实拍加 AI 混合视频",
      durationSec: 30,
      videoRightsConfirmed: true,
      attachments: [{ id: `CDU-${"a".repeat(32)}`, kind: "video", mime: "video/mp4", sha256: "b".repeat(64), size: 10 }],
    },
    route: {
      shotPlan: [
        { sourceType: "real_footage", durationSec: 15, attachmentId: `CDU-${"a".repeat(32)}`, authorizationId: "AUTH-1", description: "" },
        { sourceType: "ai_generated", durationSec: 15, attachmentId: null, description: "产品机制动画", authorizationId: null },
      ],
    },
  });
  assert.equal(mixed.route.shots.length, 2);
  assert.equal(mixed.route.totalDurationSec, 30);
  assert.equal(mixed.productionVerified, false);
});
