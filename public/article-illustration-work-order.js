import { articleIllustrationStyleMarker, articleIllustrationStyleRule } from "./article-illustration-style.js";

export function articleIllustrationWorkOrder(plan, slot) {
  if (slot.kind === "scene" && !/^[a-f0-9]{64}$/.test(slot.sceneBriefHash ?? "")) {
    throw new Error("请重新读取配图计划，下载含准确场景简报摘要的工单。");
  }
  const production = slot.kind === "scene" ? ["pengmanager-agent-designer", "local-compositor"] : ["article-diagram"];
  if (slot.imageGeneration) production.push("builtin-imagegen");
  return { schema: "pengmanager.article-illustration-work-order/v1", planId: plan.id, storyId: plan.storyId,
    sourceHash: plan.sourceHash, articleType: plan.articleType, locale: plan.locale, title: plan.title,
    ...(plan.styleYear === undefined ? {} : { styleYear: plan.styleYear, visualStyle: articleIllustrationStyleRule(slot.kind, plan.styleYear) }),
    slot: { id: slot.id, kind: slot.kind, anchor: slot.anchor, description: slot.description,
      alt: slot.alt, caption: slot.caption, imageGeneration: slot.imageGeneration,
      ...(slot.kind === "scene" ? { sceneBriefHash: slot.sceneBriefHash } : {}) }, production };
}

export function articleIllustrationImageGenPrompt(plan, slot) {
  const marker = `PM-ILLUSTRATION ${plan.id}/${slot.id} ${plan.sourceHash}`;
  if (plan.styleYear !== undefined) {
    const style = articleIllustrationStyleRule(slot.kind, plan.styleYear);
    return `请用内置生图工具（需求配置 image2.5）为《${plan.title}》生成一张配图。\n\n必须符合的画面风格：${style}\n\n需要忠实呈现的画面：${slot.description}\n替代文字中出现的可见主体、物件和动作须能直接看出：${slot.alt}\n\n保留以下两行工单标记作为工具提示中的追踪信息，画面内不要出现标记或文字。\n${articleIllustrationStyleMarker(plan.styleYear)}\n${marker}`;
  }
  return `请用内置生图工具（需求配置 image2.5）为《${plan.title}》生成一张配图。\n\n${slot.description}\n\n保留以下工单标记作为工具提示中的追踪信息，画面内不要出现标记或文字。\n${marker}`;
}
