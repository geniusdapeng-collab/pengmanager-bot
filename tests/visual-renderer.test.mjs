import test from "node:test";
import assert from "node:assert/strict";
import { inspectRenderedVisual, mermaidSource, normalizeVisualPlan, renderVisualPng, renderVisualSvg } from "../src/services/visual-renderer.mjs";
import { hashObject } from "../src/domain/hash.mjs";

const plan = normalizeVisualPlan({
  visuals: [{
    kind: "architecture",
    title: "内容生产架构",
    alt: "内容总控连接文章、视觉和视频生产线的架构图",
    caption: "图 1",
    nodes: [
      { id: "director", label: "内容总控" },
      { id: "article", label: "文章生产线" },
      { id: "video", label: "视频生产线" },
    ],
    edges: [
      { from: "director", to: "article", label: "文章 Job" },
      { from: "director", to: "video", label: "视频 Job" },
    ],
  }],
});

test("visual contract produces editable Mermaid source and deterministic SVG", () => {
  const spec = plan.visuals[0];
  const source = mermaidSource(spec);
  assert.match(source, /flowchart LR/);
  assert.match(source, /director\["内容总控"\]/);
  const first = renderVisualSvg(spec);
  const second = renderVisualSvg(spec);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.specHash, hashObject(spec));
  const svg = first.bytes.toString("utf8");
  assert.match(svg, /role="img" aria-label="内容总控连接文章、视觉和视频生产线的架构图"/);
  assert.match(svg, /文章生产线/);
  assert.match(svg, /marker-end="url\(#visual-arrow\)"/);
  assert.doesNotMatch(svg, /PengManager editable visual source/);
});

test("visual contract renders a real PNG", async () => {
  const result = await renderVisualPng(plan.visuals[0]);
  assert.equal(result.mime, "image/png");
  assert.deepEqual([...result.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const rendered = await inspectRenderedVisual(result.bytes);
  assert.equal(rendered.format, "png");
  assert.equal(rendered.width, 1680);
});

test("signed bar and line charts preserve original values and finite portrait geometry", () => {
  const data = [{ label: "转出", value: -8 }, { label: "持平", value: 0 }, { label: "转入", value: 8 }];
  const visual = { kind: "chart", title: "有符号的净变动", alt: "比较转出、持平和转入数值", caption: "三期变化", unit: "笔", data };
  const [bar, line] = normalizeVisualPlan({ visuals: [visual, { ...visual, chartType: "line" }] }).visuals;
  assert.equal(bar.dataHash, hashObject(data));
  assert.equal(line.dataHash, bar.dataHash);
  const bars = renderVisualSvg(bar).bytes.toString("utf8");
  const zero = Number(bars.match(/d="M([\d.]+) \d+v16"/)[1]);
  const rectangles = [...bars.matchAll(/<rect x="([\d.]+)" y="\d+" width="([\d.]+)" height="12"/g)];
  assert.equal(rectangles.length, 2);
  assert.equal(Number(rectangles[0][1]) + Number(rectangles[0][2]), zero);
  assert.equal(Number(rectangles[1][1]), zero);
  for (const value of ["-8笔", "0笔", "8笔"]) assert.ok(bars.includes(value));
  const widest = { ...line, data: [{ label: "最低值", value: -Number.MAX_VALUE }, { label: "最高值", value: Number.MAX_VALUE }] };
  const lineSvg = renderVisualSvg(widest).bytes.toString("utf8");
  assert.equal((lineSvg.match(/<circle /g) ?? []).length, 2);
  assert.doesNotMatch(lineSvg, /NaN|Infinity/);
});

test("long relationship labels and special characters stay in the editable flow output", () => {
  const longLabel = "完成来源字节核验后由既有审批授权推进正式版本";
  const spec = normalizeVisualPlan({ visuals: [{ kind: "flow", title: "准备 & 复核", alt: "栏目 <内容> 的发布流程", caption: "确认源范围和实际证据",
    nodes: [{ id: "a", label: "原文", group: "来源" }, { id: "b", label: "图位", group: "输出" }],
    edges: [{ from: "a", to: "b", label: longLabel }, { from: "b", to: "b", label: "再查" }],
  }] }).visuals[0];
  const rendered = renderVisualSvg(spec).bytes.toString("utf8");
  assert.match(rendered, /aria-label="栏目 &lt;内容&gt; 的发布流程"/);
  assert.match(rendered, /<title>准备 &amp; 复核<\/title>/);
  assert.ok(rendered.includes(`原文 → 图位 · ${longLabel}`));
  assert.ok(rendered.includes("图位 → 图位 · 再查"));
  assert.equal((rendered.match(/marker-end=/g) ?? []).length, 2);
});

test("maximum graph density keeps every relationship and renders within raster limits", async () => {
  const nodes = Array.from({ length: 40 }, (_, index) => ({ id: `step${index}`, label: "设计工作".repeat(8), group: "核对记录".repeat(6) }));
  const label = "逐项核对真实图片审批原文证据".repeat(8);
  const edges = Array.from({ length: 80 }, (_, index) => ({ from: nodes[index % nodes.length].id, to: nodes[(index + 7) % nodes.length].id, label }));
  const [spec] = normalizeVisualPlan({ visuals: [{ kind: "architecture", title: "发布前的检查流程", alt: "完整列出四十个工作节点及八十条关系",
    caption: "覆盖最大图形规模", nodes, edges }] }).visuals;
  const svg = renderVisualSvg(spec);
  assert.equal((svg.bytes.toString("utf8").match(/marker-end=/g) ?? []).length, edges.length);
  assert.equal(svg.specHash, hashObject(spec));
  const png = await renderVisualPng(spec);
  const meta = await inspectRenderedVisual(png.bytes);
  assert.equal(png.specHash, svg.specHash);
  assert.ok(meta.height <= 16000 && meta.width > 390);
});
