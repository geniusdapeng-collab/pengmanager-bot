import test from "node:test";
import assert from "node:assert/strict";
import {
  genericProductNamingFindings,
  normalizeGeneratedTextContent,
  PRODUCT_NAMING_POLICY_VERSION,
} from "../src/domain/product-naming.mjs";
import { deterministicArticleFindings, validateOutline, validateSectionDraft } from "../src/domain/content-director.mjs";
import { assertGenericPublicNaming } from "../src/domain/content-ops-quality.mjs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoSeedDirectory } from "../scripts/demo.mjs";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";

test("generated article text replaces known products with role-based generic industry names", () => {
  const naming = normalizeGeneratedTextContent({
    title: "WorkLoom 如何连接 Andromeda 与 Agent IM",
    summary: "GeoEvidence Studio 和 WorkLoom Video Edit 的产品边界。",
    body: "HyperReality 与 狐狸先生 分别负责视频和交互实验。",
    blocks: [
      { type: "paragraph", text: "Tiger 与 Eagle 代表高风险交易和企业咨询服务。" },
      { type: "image", assetId: "MED-test", alt: "Panda Cineforge 电商流程", caption: "WorkLoom Eval 的评测链路" },
    ],
  });
  assert.equal(naming.changed, true);
  assert.equal(naming.value.title, "AI Agent 经营系统 如何连接 平台运营中枢 与 企业智能协作平台");
  assert.equal(naming.value.summary, "AI 可见度证据系统 和 智能视频后期系统 的产品边界。");
  assert.match(naming.value.body, /AI 视频内容生产系统 与 智能体交互实验系统/);
  assert.match(naming.value.blocks[0].text, /交易纪律管理系统 与 企业咨询经营系统/);
  assert.equal(naming.value.blocks[1].alt, "多平台电商经营系统 电商流程");
  assert.equal(naming.value.blocks[1].caption, "数字员工评测系统 的评测链路");
  assert.equal(naming.value.productNaming.version, PRODUCT_NAMING_POLICY_VERSION);
  assert.deepEqual(genericProductNamingFindings({
    title: naming.value.title,
    summary: naming.value.summary,
    body: naming.value.body,
    blocks: naming.value.blocks,
  }), []);
});

test("XX placeholders remain a hard blocker and are never accepted as generic names", () => {
  const findings = genericProductNamingFindings({
    title: "XX 系统总产品架构",
    body: "XX 协同系统不是通用名称。",
  });
  assert.ok(findings.some(finding => finding.code === "PRODUCT_NAME_PLACEHOLDER_FORBIDDEN"));
  assert.ok(findings.every(finding => finding.severity === "blocker"));
});

test("content director normalizes outline and section text then blocks unresolved placeholders", () => {
  const brief = {
    claimIds: [],
    targetLength: { minCharacters: 600, maxCharacters: 1200 },
  };
  const outline = validateOutline({
    title: "WorkLoom 的工程边界",
    summary: "Andromeda 如何运营 WorkLoom",
    sections: [
      { key: "one", title: "Agent IM 的消息层", purpose: "说明 Agent IM 的职责", targetCharacters: 220, claimIds: [] },
      { key: "two", title: "HyperReality 的生产线", purpose: "说明 HyperReality 的边界", targetCharacters: 220, claimIds: [] },
      { key: "three", title: "WorkLoom Eval 的质量门", purpose: "说明 WorkLoom Eval 的证据", targetCharacters: 220, claimIds: [] },
    ],
  }, brief);
  assert.equal(outline.title, "AI Agent 经营系统 的工程边界");
  assert.equal(outline.summary, "平台运营中枢 如何运营 AI Agent 经营系统");
  assert.equal(outline.sections[0].title, "企业智能协作平台 的消息层");
  assert.equal(outline.sections[1].title, "AI 视频内容生产系统 的生产线");

  const section = validateSectionDraft({
    title: "Tiger 的风险边界",
    body: "Tiger 必须先限制动作，再讨论自动执行。\n\nEagle 则把高信任判断保留给人。",
    claimIds: [],
  }, outline.sections[0], new Set());
  assert.equal(section.title, "交易纪律管理系统 的风险边界");
  assert.match(section.body, /企业咨询经营系统/);
  assert.throws(() => validateSectionDraft({
    title: "XX 系统",
    body: "完整正文。",
    claimIds: [],
  }, outline.sections[0], new Set()), { code: "PRODUCT_NAME_PLACEHOLDER_FORBIDDEN" });
});

test("deterministic article and final publication checks reject residual brands and placeholders", () => {
  const findings = deterministicArticleFindings({
    title: "WorkLoom 总览",
    summary: "XX 系统说明",
    body: "## 一\n\n第一段正文足够长。\n\n第二段正文足够长。\n\n## 二\n\n第一段正文足够长。\n\n第二段正文足够长。\n\n## 三\n\n第一段正文足够长。\n\n第二段正文足够长。",
    blocks: [],
  }, {});
  assert.ok(findings.some(finding => finding.code === "GENERIC_PRODUCT_NAME_REQUIRED"));
  assert.ok(findings.some(finding => finding.code === "PRODUCT_NAME_PLACEHOLDER_FORBIDDEN"));
  assert.throws(() => assertGenericPublicNaming({
    title: "Panda Cineforge 经营系统",
    summary: "",
    body: "正文",
    productNaming: { version: PRODUCT_NAMING_POLICY_VERSION },
    orderedBlocks: [],
    orderedMediaRefs: [],
    nativeManifest: {},
  }), { code: "GENERIC_PRODUCT_NAMING_REQUIRED" });
});

test("legacy article ingress and approval use the same naming policy", async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pengmanager-naming-test-"));
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.open(() => loadSeedState(demoSeedDirectory));
  const geoService = new GeoOsService({ store });
  const content = await geoService.createContent({
    title: "WorkLoom 的经营边界",
    body: "WorkLoom 在 Agent IM 之上形成 AI Agent 经营系统。",
    claimIds: ["C001"],
    platforms: ["GitHub"],
  });
  assert.equal(content.title, "AI Agent 经营系统 的经营边界");
  assert.match(content.body, /企业智能协作平台/);
  assert.equal(content.productNaming.version, PRODUCT_NAMING_POLICY_VERSION);
  await assert.rejects(geoService.createContent({
    title: "XX 系统",
    body: "这是不允许的占位符正文。",
    claimIds: ["C001"],
    platforms: ["GitHub"],
  }), { code: "GENERIC_PRODUCT_NAMING_REQUIRED" });
});
