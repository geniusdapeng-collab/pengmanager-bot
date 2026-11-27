export const PRODUCT_NAMING_POLICY_VERSION = "generic-product-naming/v1";

export const GENERIC_PRODUCT_NAMES = Object.freeze({
  operatingSystem: "AI Agent 经营系统",
  collaborationPlatform: "企业智能协作平台",
  operationsHub: "平台运营中枢",
  aiVideoProduction: "AI 视频内容生产系统",
  videoPostProduction: "智能视频后期系统",
  digitalEmployeeEvaluation: "数字员工评测系统",
  growthExperiment: "增长实验系统",
  growthMatrixExperiment: "增长矩阵实验系统",
  contentOperations: "内容运营系统",
  aiVisibilityEvidence: "AI 可见度证据系统",
  ecommerceOperations: "多平台电商经营系统",
  consultingOperations: "企业咨询经营系统",
  tradingDiscipline: "交易纪律管理系统",
  agentInteractionExperiment: "智能体交互实验系统",
  hotelOperations: "酒店经营系统",
  productManagementCollaboration: "产品管理协作系统",
  visualEditingTool: "视觉编辑工具",
});

const replacements = [
  {
    source: "product-document-route",
    pattern: /(?:https?:\/\/)?(?:cnb\.cool\/workloom-ai|github\.com\/geniusdapeng-collab)[^\s)\]}>，。；;]*/gi,
    replacement: "公开产品资料",
  },
  { source: "agent-engineering-framework", pattern: /\bDeepSeek\s+(?:Agent\s+)?Harness\b/gi, replacement: "AI Agent 工程框架" },
  { source: "agent-execution-framework", pattern: /\bHarness\b/g, replacement: "Agent 执行框架" },
  { source: "model-service", pattern: /\bDeepSeek\b/gi, replacement: "大模型服务" },
  { source: "general-chat-ai", pattern: /\bChatGPT\b/gi, replacement: "通用对话式 AI" },
  { source: "model-provider", pattern: /\bOpenAI\b/gi, replacement: "大模型服务商" },
  { source: "long-context-ai-assistant", pattern: /\bClaude\b/gi, replacement: "长上下文 AI 助手" },
  { source: "multimodal-ai-assistant", pattern: /\bGemini\b/gi, replacement: "多模态 AI 助手" },
  { source: "code-hosting-platform", pattern: /\bGitHub\b/gi, replacement: "代码托管平台" },
  { source: "data-science-platform", pattern: /\bKaggle\b/gi, replacement: "数据科学平台" },
  { source: "professional-social-platform", pattern: /\bLinkedIn\b/gi, replacement: "职业社交平台" },
  { source: "model-community", pattern: /\bHugging\s*Face\b/gi, replacement: "模型社区平台" },
  { source: "video-post-production", pattern: /WorkLoom\s+Video\s+Edit/gi, replacement: GENERIC_PRODUCT_NAMES.videoPostProduction },
  { source: "video-post-production-slug", pattern: /WorkLoom-video-edit/gi, replacement: GENERIC_PRODUCT_NAMES.videoPostProduction },
  { source: "digital-employee-evaluation", pattern: /WorkLoom\s+Eval/gi, replacement: GENERIC_PRODUCT_NAMES.digitalEmployeeEvaluation },
  { source: "collaboration-platform", pattern: /WorkLoom\s+IM/gi, replacement: GENERIC_PRODUCT_NAMES.collaborationPlatform },
  { source: "growth-matrix-experiment", pattern: /WorkLoom-growthmatrix/gi, replacement: GENERIC_PRODUCT_NAMES.growthMatrixExperiment },
  { source: "growth-experiment-test", pattern: /WorkLoom-growthtest/gi, replacement: GENERIC_PRODUCT_NAMES.growthExperiment },
  { source: "growth-experiment", pattern: /WorkLoom-growth/gi, replacement: GENERIC_PRODUCT_NAMES.growthExperiment },
  { source: "content-operations", pattern: /PengManager\s+(?:System|Codex\s+Edition)/gi, replacement: GENERIC_PRODUCT_NAMES.contentOperations },
  { source: "ai-visibility-evidence", pattern: /GeoEvidence\s+Studio/gi, replacement: GENERIC_PRODUCT_NAMES.aiVisibilityEvidence },
  { source: "ai-visibility-evidence-short", pattern: /GeoEvidence/gi, replacement: GENERIC_PRODUCT_NAMES.aiVisibilityEvidence },
  { source: "ecommerce-operations", pattern: /Panda\s+Cineforge/gi, replacement: GENERIC_PRODUCT_NAMES.ecommerceOperations },
  { source: "video-production", pattern: /HyperReality/gi, replacement: GENERIC_PRODUCT_NAMES.aiVideoProduction },
  { source: "growth-experiment-product", pattern: /GrowthTest/gi, replacement: GENERIC_PRODUCT_NAMES.growthExperiment },
  { source: "growth-experiment-cn", pattern: /AI\s*超增长/gi, replacement: GENERIC_PRODUCT_NAMES.growthExperiment },
  { source: "video-post-production-edit-ai", pattern: /Edit-AI/gi, replacement: GENERIC_PRODUCT_NAMES.videoPostProduction },
  { source: "visual-editing-tool", pattern: /Compositor(?:\s+CLI)?/gi, replacement: GENERIC_PRODUCT_NAMES.visualEditingTool },
  { source: "collaboration-platform-agent-im", pattern: /Agent\s+IM/gi, replacement: GENERIC_PRODUCT_NAMES.collaborationPlatform },
  { source: "operations-hub", pattern: /Andromeda/gi, replacement: GENERIC_PRODUCT_NAMES.operationsHub },
  { source: "operations-hub-cn", pattern: /仙女座/g, replacement: GENERIC_PRODUCT_NAMES.operationsHub },
  { source: "agent-interaction-experiment", pattern: /狐狸先生/g, replacement: GENERIC_PRODUCT_NAMES.agentInteractionExperiment },
  { source: "consulting-operations", pattern: /\bEagle\b/gi, replacement: GENERIC_PRODUCT_NAMES.consultingOperations },
  { source: "trading-discipline", pattern: /\bTiger\b/gi, replacement: GENERIC_PRODUCT_NAMES.tradingDiscipline },
  { source: "collaboration-platform-im-slug", pattern: /workloom-im/gi, replacement: GENERIC_PRODUCT_NAMES.collaborationPlatform },
  { source: "operations-hub-slug", pattern: /workroom-andromeda/gi, replacement: GENERIC_PRODUCT_NAMES.operationsHub },
  { source: "consulting-operations-slug", pattern: /workroom-eagle/gi, replacement: GENERIC_PRODUCT_NAMES.consultingOperations },
  { source: "trading-discipline-slug", pattern: /workroom-tiger/gi, replacement: GENERIC_PRODUCT_NAMES.tradingDiscipline },
  { source: "agent-interaction-experiment-slug", pattern: /workroom-fox/gi, replacement: GENERIC_PRODUCT_NAMES.agentInteractionExperiment },
  { source: "ecommerce-operations-slug", pattern: /panda-cineforge/gi, replacement: GENERIC_PRODUCT_NAMES.ecommerceOperations },
  { source: "video-production-slug", pattern: /hyperreality-system/gi, replacement: GENERIC_PRODUCT_NAMES.aiVideoProduction },
  { source: "ai-visibility-evidence-slug", pattern: /geo-evidence-studio/gi, replacement: GENERIC_PRODUCT_NAMES.aiVisibilityEvidence },
  { source: "digital-employee-evaluation-slug", pattern: /workloom-eval/gi, replacement: GENERIC_PRODUCT_NAMES.digitalEmployeeEvaluation },
  { source: "digital-employee-evaluation-cn", pattern: /丰臣秀吉(?:数字员工评测与迭代平台)?|秀吉系统/g, replacement: GENERIC_PRODUCT_NAMES.digitalEmployeeEvaluation },
  { source: "hotel-operations", pattern: /workloom-hotel/gi, replacement: GENERIC_PRODUCT_NAMES.hotelOperations },
  { source: "product-management-collaboration", pattern: /workloom-pm/gi, replacement: GENERIC_PRODUCT_NAMES.productManagementCollaboration },
  { source: "content-operations-short", pattern: /PengManager/gi, replacement: GENERIC_PRODUCT_NAMES.contentOperations },
  { source: "content-operations-cn", pattern: /鹏经理(?:系统|Codex版)?/gi, replacement: GENERIC_PRODUCT_NAMES.contentOperations },
  { source: "operating-system-cn", pattern: /织元/g, replacement: GENERIC_PRODUCT_NAMES.operatingSystem },
  { source: "operating-system", pattern: /WorkLoom/gi, replacement: GENERIC_PRODUCT_NAMES.operatingSystem },
].map(rule => Object.freeze(rule));

const placeholderPattern = /(?:^|[^A-Za-z0-9])(?:[XＸ]{2,}|TBD|TODO)(?=$|[^A-Za-z0-9])|(?:[XＸ]{2,}|[*＊×]{2,}|某)\s*(?:系统|平台|产品|品牌|公司|工具|中枢|协同)/giu;

export const PRODUCT_NAMING_PROMPT = [
  "HARD PRODUCT-NAMING RULE:",
  "Never publish a concrete product, company, repository, code name, internal product name, or brand name in article titles, summaries, body text, headings, lists, captions, alt text, visual labels, or user-facing metadata.",
  `Replace each such name with the role-based generic Chinese industry term defined by ${PRODUCT_NAMING_POLICY_VERSION}.`,
  "For example: WorkLoom -> AI Agent 经营系统; Agent IM -> 企业智能协作平台; Andromeda/仙女座 -> 平台运营中枢; HyperReality -> AI 视频内容生产系统; WorkLoom Video Edit/Edit-AI -> 智能视频后期系统; GeoEvidence Studio -> AI 可见度证据系统; Panda Cineforge -> 多平台电商经营系统; Eagle -> 企业咨询经营系统; Tiger -> 交易纪律管理系统; 狐狸先生 -> 智能体交互实验系统; WorkLoom Eval -> 数字员工评测系统.",
  "Never use XX, XXXX, TBD, placeholders, masked names, or vague phrases such as “某产品” as a substitute. If no accurate generic name can be derived, stop and return a blocker instead of inventing one.",
].join(" ");

function collectLeafStrings(value, path = "content", rows = []) {
  if (typeof value === "string") {
    rows.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectLeafStrings(item, `${path}[${index}]`, rows));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) collectLeafStrings(child, `${path}.${key}`, rows);
  }
  return rows;
}

export function rewriteGenericProductNames(value) {
  if (typeof value !== "string") return { value, changed: false, replacements: [] };
  let next = value;
  const matched = [];
  for (const rule of replacements) {
    let changed = false;
    next = next.replace(rule.pattern, () => {
      changed = true;
      return rule.replacement;
    });
    if (changed) matched.push(rule.source);
  }
  return { value: next, changed: next !== value, replacements: [...new Set(matched)] };
}

export function normalizeGenericProductNames(value, { path = "content" } = {}) {
  const replacements = [];
  const visit = (child, path) => {
    if (typeof child === "string") {
      const result = rewriteGenericProductNames(child);
      if (result.changed) replacements.push({ path, terms: result.replacements });
      return result.value;
    }
    if (Array.isArray(child)) return child.map((item, index) => visit(item, `${path}[${index}]`));
    if (child && typeof child === "object") {
      return Object.fromEntries(Object.entries(child).map(([key, item]) => [key, visit(item, `${path}.${key}`)]));
    }
    return child;
  };
  const normalized = visit(value, path);
  return {
    value: normalized,
    changed: replacements.length > 0,
    replacements,
    policy: {
      version: PRODUCT_NAMING_POLICY_VERSION,
      policy: "replace_concrete_products_with_role_based_generic_names",
      replacements,
    },
  };
}

export function normalizeGeneratedTextContent(value) {
  const output = structuredClone(value);
  const replacements = [];
  const rewriteField = (target, key, path) => {
    if (typeof target?.[key] !== "string") return;
    const result = rewriteGenericProductNames(target[key]);
    target[key] = result.value;
    if (result.changed) replacements.push({ path, terms: result.replacements });
  };
  for (const key of ["title", "summary", "body", "rationale", "alt", "caption", "hook", "cta", "skipReason"]) {
    rewriteField(output, key, `content.${key}`);
  }
  for (const key of ["hashtags", "requiredInputs"]) {
    if (!Array.isArray(output[key])) continue;
    output[key] = output[key].map((row, index) => {
      if (typeof row !== "string") return row;
      const normalized = rewriteGenericProductNames(row);
      if (normalized.changed) replacements.push({ path: `content.${key}[${index}]`, terms: normalized.replacements });
      return normalized.value;
    });
  }
  if (output.blocks !== undefined) {
    const normalized = normalizeGenericProductNames(output.blocks, { path: "content.blocks" });
    output.blocks = normalized.value;
    replacements.push(...normalized.replacements);
  }
  if (Array.isArray(output.outline)) {
    output.outline = output.outline.map((row, index) => {
      if (typeof row !== "string") return row;
      const normalized = rewriteGenericProductNames(row);
      if (normalized.changed) replacements.push({ path: `content.outline[${index}]`, terms: normalized.replacements });
      return normalized.value;
    });
  }
  for (const key of ["nativeContent", "assetRefs"]) {
    if (!Array.isArray(output[key])) continue;
    const fields = key === "nativeContent" ? ["title", "body", "alt", "caption"] : ["alt", "caption"];
    output[key] = output[key].map((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return row;
      const next = { ...row };
      for (const field of fields) rewriteField(next, field, `content.${key}[${index}].${field}`);
      return next;
    });
  }
  if (output.disclosure && typeof output.disclosure === "object" && !Array.isArray(output.disclosure)) {
    const normalized = normalizeGenericProductNames(output.disclosure, { path: "content.disclosure" });
    output.disclosure = normalized.value;
    replacements.push(...normalized.replacements);
  }
  output.productNaming = {
    version: PRODUCT_NAMING_POLICY_VERSION,
    policy: "replace_concrete_products_with_role_based_generic_names",
    replacements,
  };
  return { value: output, changed: replacements.length > 0, replacements, policy: output.productNaming };
}

export function genericProductNamingFindings(value, { location = "content" } = {}) {
  const findings = [];
  for (const leaf of collectLeafStrings(value, location)) {
    for (const rule of replacements) {
      const matches = leaf.value.match(rule.pattern) ?? [];
      for (const match of matches) {
        findings.push({
          severity: "blocker",
          code: "GENERIC_PRODUCT_NAME_REQUIRED",
          dimension: "policy",
          location: leaf.path,
          message: `具体产品或品牌名「${match}」必须自动替换为行业通用名称「${rule.replacement}」。`,
        });
      }
    }
    for (const match of leaf.value.match(placeholderPattern) ?? []) {
      findings.push({
        severity: "blocker",
        code: "PRODUCT_NAME_PLACEHOLDER_FORBIDDEN",
        dimension: "policy",
        location: leaf.path,
        message: `禁止使用「${match.trim()}」等脱敏占位符；必须写出准确的行业通用名称。`,
      });
    }
  }
  const unique = new Map(findings.map(finding => [
    `${finding.code}\0${finding.location}\0${finding.message}`,
    finding,
  ]));
  return [...unique.values()];
}

export function genericProductNamingErrorCode(findings = []) {
  return findings.some(finding => finding.code === "PRODUCT_NAME_PLACEHOLDER_FORBIDDEN")
    ? "PRODUCT_NAME_PLACEHOLDER_FORBIDDEN"
    : "GENERIC_PRODUCT_NAMING_REQUIRED";
}

export function genericProductNamingPolicy(policy = {}) {
  return {
    version: PRODUCT_NAMING_POLICY_VERSION,
    policy: "replace_concrete_products_with_role_based_generic_names",
    replacements: structuredClone(policy.replacements ?? []),
  };
}
