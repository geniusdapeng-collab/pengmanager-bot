import { ApiError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";
import sharp from "sharp";
import { createHash } from "node:crypto";

const VISUAL_KINDS = new Set(["architecture", "flow", "chart", "infographic"]);
const MAX_NODES = 40;
const MAX_EDGES = 80;
const MAX_POINTS = 30;

function text(value, name, maximum = 500, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new ApiError(502, "VISUAL_SPEC_INVALID", `${name} 必须是非空且不超过 ${maximum} 字符的文本。`);
  }
  return value.trim();
}

function identifier(value, name) {
  const result = text(value, name, 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(result)) throw new ApiError(502, "VISUAL_SPEC_INVALID", `${name} 格式无效。`);
  return result;
}

function finite(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new ApiError(502, "VISUAL_SPEC_INVALID", `${name} 必须是有限数字。`);
  return result;
}

function lineCount(value, width) {
  return wrap(value, width).length;
}

function boundedLabel(value, name, lines, width, maximum = 500) {
  const result = text(value, name, maximum);
  if (lineCount(result, width) > lines) throw new ApiError(502, "VISUAL_SPEC_INVALID", `${name} 在当前版式中会溢出。`);
  return result;
}

export function normalizeVisualPlan(value, { articleHash = null, authorizedClaimIds = [] } = {}) {
  const visuals = value?.visuals;
  if (!Array.isArray(visuals) || visuals.length < 1 || visuals.length > 4) {
    throw new ApiError(502, "VISUAL_SPEC_INVALID", "视觉计划必须包含 1–4 个图形。");
  }
  return {
    visuals: visuals.map((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new ApiError(502, "VISUAL_SPEC_INVALID", "视觉项必须是对象。");
      }
      const kind = text(row.kind, `visuals[${index}].kind`, 40);
      if (!VISUAL_KINDS.has(kind)) throw new ApiError(502, "VISUAL_SPEC_INVALID", `不支持视觉类型 ${kind}。`);
      const title = boundedLabel(row.title, `visuals[${index}].title`, 2, 36, 200);
      const alt = text(row.alt, `visuals[${index}].alt`, 1000);
      const caption = boundedLabel(row.caption, `visuals[${index}].caption`, 2, 52, 2000);
      const claimIds = Array.isArray(row.claimIds) ? [...new Set(row.claimIds.map(String))] : [];
      const authorized = new Set(authorizedClaimIds);
      if (claimIds.some(claimId => !authorized.has(claimId))) throw new ApiError(502, "VISUAL_SPEC_INVALID", "视觉图引用了任务未授权的 Claim。");
      if ((kind === "architecture" || kind === "flow") && (!Array.isArray(row.nodes) || !Array.isArray(row.edges))) {
        throw new ApiError(502, "VISUAL_SPEC_INVALID", "架构图和流程图必须提供 nodes 与 edges。");
      }
      if (kind === "architecture" || kind === "flow") {
        if (row.nodes.length < 2 || row.nodes.length > MAX_NODES || row.edges.length < 1 || row.edges.length > MAX_EDGES) {
          throw new ApiError(502, "VISUAL_SPEC_INVALID", "图节点或边数量无效。");
        }
        const nodes = row.nodes.map((node, nodeIndex) => ({
          id: identifier(node?.id, `visuals[${index}].nodes[${nodeIndex}].id`),
          label: boundedLabel(node?.label, `visuals[${index}].nodes[${nodeIndex}].label`, 2, 16, 160),
          group: node?.group === undefined ? null : boundedLabel(node.group, `visuals[${index}].nodes[${nodeIndex}].group`, 1, 24, 80),
        }));
        if (new Set(nodes.map(node => node.id)).size !== nodes.length) {
          throw new ApiError(502, "VISUAL_SPEC_INVALID", "图节点 ID 不得重复。");
        }
        const ids = new Set(nodes.map(node => node.id));
        const edges = row.edges.map((edge, edgeIndex) => {
          const from = identifier(edge?.from, `visuals[${index}].edges[${edgeIndex}].from`);
          const to = identifier(edge?.to, `visuals[${index}].edges[${edgeIndex}].to`);
          if (!ids.has(from) || !ids.has(to)) throw new ApiError(502, "VISUAL_SPEC_INVALID", "图边引用了不存在的节点。");
          return { from, to, label: text(edge?.label, `visuals[${index}].edges[${edgeIndex}].label`, 120, { optional: true }) };
        });
        const dataHash = hashObject({ nodes, edges });
        return { kind, title, alt, caption, claimIds, sourceArtifactIds: articleHash ? [articleHash] : [], dataHash, nodes, edges };
      }
      if (kind === "chart") {
        if (!Array.isArray(row.data) || row.data.length < 1 || row.data.length > MAX_POINTS) {
          throw new ApiError(502, "VISUAL_SPEC_INVALID", "图表必须提供 1–30 个数据点。");
        }
        const data = row.data.map((point, pointIndex) => ({
          label: boundedLabel(point?.label, `visuals[${index}].data[${pointIndex}].label`, 2, 14, 120),
          value: finite(point?.value, `visuals[${index}].data[${pointIndex}].value`),
        }));
        const dataHash = hashObject(data);
        return {
          kind,
          title,
          alt,
          caption,
          claimIds,
          sourceArtifactIds: articleHash ? [articleHash] : [],
          dataHash,
          chartType: row.chartType === "line" ? "line" : "bar",
          unit: text(row.unit ?? "", `visuals[${index}].unit`, 40, { optional: true }),
          data,
        };
      }
      if (!Array.isArray(row.items) || row.items.length < 2 || row.items.length > 12) {
        throw new ApiError(502, "VISUAL_SPEC_INVALID", "信息图必须提供 2–12 个信息项。");
      }
      return {
        kind,
        title,
        alt,
        caption,
        claimIds,
        sourceArtifactIds: articleHash ? [articleHash] : [],
        dataHash: hashObject(row.items),
        items: row.items.map((item, itemIndex) => ({
          label: boundedLabel(item?.label, `visuals[${index}].items[${itemIndex}].label`, 2, 16, 120),
          description: boundedLabel(item?.description, `visuals[${index}].items[${itemIndex}].description`, 5, 31, 500),
        })),
      };
    }),
  };
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrap(value, width) {
  const characters = [...String(value)];
  const lines = [];
  for (let index = 0; index < characters.length; index += width) lines.push(characters.slice(index, index + width).join(""));
  return lines.length ? lines : [""];
}

const WIDTH = 840;
const MARGIN = 44;
const INNER = WIDTH - 2 * MARGIN;
const MAX_RASTER_HEIGHT = 16_000;
const FONT = "PingFang SC, Noto Sans CJK SC, Microsoft YaHei, Arial, sans-serif";
const INK = "#122039";
const MUTED = "#435570";
const BLUE = "#1659BD";
const LINK = "#55708F";
const BORDER = "#CBD7E7";
const SURFACE = "#FFFFFF";
const BACKGROUND = "#F4F7FB";

function glyphWidth(character, fontSize) {
  if (/\p{Mark}/u.test(character)) return 0;
  if (/^[\x20-\x7E]$/.test(character)) {
    return fontSize * (/[MW@%&]/.test(character) ? 0.94 : /[ ilI.,:;'!|]/.test(character) ? 0.36 : 0.68);
  }
  return fontSize * 1.05;
}

function textBlock(value, maxWidth, size, { weight = 400, fill = INK, lineHeight = Math.ceil(size * 1.32) } = {}) {
  const lines = [];
  let next = "", length = 0;
  const space = glyphWidth(" ", size);
  const shorten = () => {
    lines.push(next.trimEnd());
    next = "";
    length = 0;
  };
  for (const word of String(value).trim().split(/\s+/u)) {
    const characters = [...word].map(character => ({ character, width: glyphWidth(character, size) }));
    const wordWidth = characters.reduce((sum, entry) => sum + entry.width, 0);
    if (next && wordWidth <= maxWidth && length + space + wordWidth > maxWidth) shorten();
    if (next) { next += " "; length += space; }
    for (const { character, width } of characters) {
      if (next && length + width > maxWidth) shorten();
      next += character;
      length += width;
    }
  }
  lines.push(next);
  return {
    height: lines.length * lineHeight,
    lines,
    draw(x, y, align = "start") {
      return lines.map((line, index) => `<text x="${x}" y="${y + size + index * lineHeight}" text-anchor="${align}" font-size="${size}" font-weight="${weight}" fill="${fill}" font-family="${FONT}">${xml(line)}</text>`).join("");
    },
  };
}

function rect(x, y, width, height, radius, fill, stroke = "none") {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
}

function frame(spec, height, body) {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${xml(spec.alt)}"><title>${xml(spec.title)}</title><rect width="100%" height="100%" fill="${BACKGROUND}"/>${body}</svg>`;
  return { source, height };
}

function header(spec) {
  const top = 36;
  const title = textBlock(spec.title, INNER, 43, { weight: 700 });
  const caption = spec.caption ? textBlock(spec.caption, INNER, 27, { fill: MUTED }) : null;
  const captionTop = top + title.height + 5;
  const bottom = (caption ? captionTop + caption.height : top + title.height) + 30;
  const rule = `<path d="M${MARGIN} ${bottom}h${INNER}" stroke="${BORDER}" stroke-width="2"/>`;
  return { bottom, markup: title.draw(MARGIN, top) + (caption?.draw(MARGIN, captionTop) ?? "") + rule };
}

function graphEdge(from, to, nodeWidth, nodeHeight) {
  const fromRight = from.column === 0;
  const toRight = to.column === 0;
  const startX = from.x + (fromRight ? nodeWidth : 0);
  const endX = to.x + (toRight ? nodeWidth : 0);
  const startY = from.y + Math.round(nodeHeight * 0.4);
  const endY = to.y + Math.round(nodeHeight * 0.62);
  const middle = WIDTH / 2;
  if (from === to) {
    const loopX = startX + (fromRight ? 37 : -37);
    return { path: `M${startX} ${startY} C${loopX} ${startY} ${loopX} ${endY} ${endX} ${endY}`, inline: null };
  }
  if (from.row === to.row) {
    const y = fromRight ? startY : endY;
    return { path: `M${startX} ${y}H${endX}`, inline: { x: middle, y: y - 23, width: 128 } };
  }
  if (from.column === to.column && Math.abs(from.row - to.row) === 1) {
    const x = from.x + nodeWidth / 2;
    const down = from.row < to.row;
    const start = from.y + (down ? nodeHeight : 0);
    const end = to.y + (down ? 0 : nodeHeight);
    const offset = down ? -22 : 22;
    return { path: `M${x + offset} ${start} V${end}`, inline: { x: x + (down ? 48 : -48), y: (start + end) / 2, width: 142 } };
  }
  const lane = middle + (from.row < to.row ? -24 : 24) + (fromRight ? -7 : 7);
  const start = from.y + Math.round(nodeHeight * 0.29);
  const end = to.y + Math.round(nodeHeight * 0.75);
  return {
    path: `M${startX} ${start} H${lane} V${end} H${endX}`,
    inline: null,
  };
}

function graphSvg(spec) {
  const intro = header(spec);
  const gapX = 154;
  const gapY = 85;
  const nodeWidth = (INNER - gapX) / 2;
  const top = intro.bottom + 34;
  const inset = 25;
  const nodes = spec.nodes.map(node => ({ ...node,
    title: textBlock(node.label, nodeWidth - 2 * inset, 29, { weight: 650 }),
    tag: node.group ? textBlock(node.group, nodeWidth - 2 * inset, 25, { fill: BLUE }) : null,
  }));
  const nodeHeight = Math.max(112, ...nodes.map(node => 2 * inset + node.title.height + (node.tag ? 6 + node.tag.height : 0)));
  const positions = new Map(nodes.map((node, index) => {
    const row = Math.floor(index / 2);
    const column = row % 2 === 0 ? index % 2 : 1 - index % 2;
    return [node.id, { node, row, column, x: MARGIN + column * (nodeWidth + gapX), y: top + row * (nodeHeight + gapY) }];
  }));
  const definitions = `<defs><marker id="visual-arrow" markerWidth="6" markerHeight="6" refX="5.8" refY="3" orient="auto"><path d="M0 0l6 3-6 3z" fill="${LINK}"/></marker></defs>`;
  const cards = [...positions.values()].map(({ x, y, node }) => `<g>${rect(x, y, nodeWidth, nodeHeight, 17, SURFACE, BORDER)}${rect(x + inset, y + 13, 28, 4, 2, BLUE)}${node.title.draw(x + inset, y + inset)}${node.tag?.draw(x + inset, y + inset + node.title.height + 6) ?? ""}</g>`).join("");
  const hasCenterRoute = spec.edges.some(edge => {
    const from = positions.get(edge.from), to = positions.get(edge.to);
    return from.row !== to.row && (from.column !== to.column || Math.abs(from.row - to.row) > 1);
  });
  const labels = [];
  const edgeDetails = [];
  const connections = spec.edges.map(edge => {
    const from = positions.get(edge.from), to = positions.get(edge.to);
    const { path, inline } = graphEdge(from, to, nodeWidth, nodeHeight);
    const description = edge.label ? `${from.node.label} → ${to.node.label} · ${edge.label}` : `${from.node.label} → ${to.node.label}`;
    if (edge.label) {
      const clear = inline && (!hasCenterRoute || inline.x !== WIDTH / 2);
      const label = clear ? textBlock(edge.label, inline.width - 12, 23, { fill: MUTED, weight: 600 }) : null;
      if (label?.lines.length === 1 && !labels.some(item => Math.abs(item.x - inline.x) < 135 && Math.abs(item.y - inline.y) < 36)) {
        labels.push({ ...inline, label });
      } else {
        edgeDetails.push(description);
      }
    }
    return `<g><title>${xml(description)}</title><path d="${path}" stroke="${LINK}" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" fill="none" marker-end="url(#visual-arrow)"/></g>`;
  }).join("");
  const edgeLabels = labels.map(({ x, y, width, label }) => `<g>${rect(x - width / 2, y - 16, width, 33, 6, BACKGROUND)}${label.draw(x, y - 17, "middle")}</g>`).join("");
  const rows = Math.ceil(nodes.length / 2);
  let bottom = top + rows * nodeHeight + Math.max(0, rows - 1) * gapY + 27;
  const details = edgeDetails.map(description => {
    const item = textBlock(description, INNER - 2 * inset, 24, { fill: MUTED });
    const result = `<path d="M${MARGIN} ${bottom}h${INNER}" stroke="${BORDER}"/>${item.draw(MARGIN + inset, bottom + 10)}`;
    bottom += item.height + 19;
    return result;
  }).join("");
  return frame(spec, bottom + 23, intro.markup + definitions + connections + cards + edgeLabels + details);
}

function chartSvg(spec) {
  const intro = header(spec);
  const top = intro.bottom + 30;
  const plotLeft = MARGIN + 24, plotRight = WIDTH - plotLeft;
  const data = spec.data;
  const isLine = spec.chartType === "line";
  const magnitude = Math.max(1, ...data.map(point => Math.abs(point.value)));
  const normalized = data.map(point => point.value / magnitude);
  const min = Math.min(0, ...normalized), max = Math.max(0, ...normalized);
  const scale = max - min || 1;
  let listTop = top;
  let plot = "";
  if (isLine) {
    const upper = top + 30, lower = top + 326;
    const y = value => lower - ((value - min) / scale) * (lower - upper);
    const step = (plotRight - plotLeft) / data.length;
    const coords = normalized.map((value, index) => [plotLeft + step * (index + 0.5), y(value)]);
    plot = rect(MARGIN, top, INNER, 356, 17, SURFACE, BORDER) +
      [upper, (upper + lower) / 2, lower].map(line => `<path d="M${plotLeft} ${line}H${plotRight}" stroke="${BORDER}" stroke-dasharray="4 6"/>`).join("") +
      `<path d="M${plotLeft} ${y(0)}H${plotRight}" stroke="${LINK}" stroke-width="1.5"/><path d="M${coords.map(point => point.join(" ")).join("L")}" fill="none" stroke="${BLUE}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
      coords.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="${BLUE}" stroke="${SURFACE}" stroke-width="2"/>`).join("");
    listTop += 375;
  }
  const barX = plotLeft + 306, barWidth = plotRight - barX;
  const zero = barX + ((0 - min) / scale) * barWidth;
  let bottom = listTop;
  const rows = data.map((point, index) => {
    const label = textBlock(point.label, 292, 27, { weight: 600 });
    const value = textBlock(`${point.value}${spec.unit ?? ""}`, 344, 26, { weight: 650, fill: BLUE });
    const textHeight = Math.max(label.height, value.height);
    const height = 30 + textHeight + (isLine ? 0 : 17);
    const end = barX + ((normalized[index] - min) / scale) * barWidth;
    const bar = isLine ? "" : `<path d="M${barX} ${bottom + textHeight + 24}H${plotRight}" stroke="${BORDER}" stroke-width="4"/><path d="M${zero} ${bottom + textHeight + 16}v16" stroke="${LINK}" stroke-width="1.5"/>${point.value !== 0 ? rect(Math.min(zero, end), bottom + textHeight + 18, Math.abs(end - zero), 12, 5, BLUE) : ""}`;
    const row = `<path d="M${plotLeft} ${bottom + height}H${plotRight}" stroke="${BORDER}"/>${label.draw(plotLeft, bottom + 10)}${value.draw(plotRight, bottom + 10, "end")}${bar}`;
    bottom += height;
    return row;
  }).join("");
  return frame(spec, bottom + 30, intro.markup + plot + rect(MARGIN, listTop, INNER, bottom - listTop + 10, 17, SURFACE, BORDER) + rows);
}

function infographicSvg(spec) {
  const intro = header(spec);
  const gap = 20, inset = 23;
  const cardWidth = (INNER - gap) / 2;
  const cards = spec.items.map(item => ({ title: textBlock(item.label, cardWidth - 2 * inset, 28, { weight: 650 }),
    detail: textBlock(item.description, cardWidth - 2 * inset, 26, { fill: MUTED }) }));
  let bottom = intro.bottom + 30;
  const markup = [];
  for (let index = 0; index < cards.length; index += 2) {
    const row = cards.slice(index, index + 2);
    const height = Math.max(...row.map(card => 2 * inset + 12 + card.title.height + card.detail.height));
    markup.push(...row.map((card, column) => {
      const x = MARGIN + column * (cardWidth + gap);
      return `<g>${rect(x, bottom, cardWidth, height, 17, SURFACE, BORDER)}${rect(x + inset, bottom + 12, 28, 4, 2, BLUE)}${card.title.draw(x + inset, bottom + inset)}${card.detail.draw(x + inset, bottom + inset + card.title.height + 12)}</g>`;
    }));
    bottom += height + gap;
  }
  return frame(spec, bottom + 13, intro.markup + markup.join(""));
}

function renderVisualSource(spec) {
  if (!spec || !VISUAL_KINDS.has(spec.kind)) throw new ApiError(502, "VISUAL_SPEC_INVALID", "无法渲染未知 VisualSpec。");
  return spec.kind === "chart" ? chartSvg(spec) : spec.kind === "infographic" ? infographicSvg(spec) : graphSvg(spec);
}

export function renderVisualSvg(spec) {
  const { source } = renderVisualSource(spec);
  return {
    bytes: Buffer.from(source, "utf8"),
    mime: "image/svg+xml",
    sha256: createHash("sha256").update(source).digest("hex"),
    specHash: hashObject(spec),
  };
}

export async function renderVisualPng(spec) {
  const { source, height } = renderVisualSource(spec);
  const density = Math.min(144, Math.floor(72 * MAX_RASTER_HEIGHT / height));
  const bytes = await sharp(Buffer.from(source, "utf8"), { density }).png({ compressionLevel: 9 }).toBuffer();
  return {
    bytes,
    mime: "image/png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    specHash: hashObject(spec),
  };
}

export async function inspectRenderedVisual(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new ApiError(415, "VISUAL_RENDER_INVALID", "渲染结果为空。");
  const metadata = await sharp(bytes).metadata();
  if (!metadata.format || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) ||
      metadata.width < 1 || metadata.height < 1) {
    throw new ApiError(415, "VISUAL_RENDER_INVALID", "渲染结果没有可核对的宽高。");
  }
  return { format: metadata.format, width: metadata.width, height: metadata.height, bytes: bytes.length };
}

export function mermaidSource(spec) {
  if (spec.kind !== "architecture" && spec.kind !== "flow") return null;
  const lines = [spec.kind === "flow" ? "flowchart TD" : "flowchart LR"];
  for (const node of spec.nodes) lines.push(`  ${node.id}["${node.label.replaceAll('"', "'")}"]`);
  for (const edge of spec.edges) lines.push(`  ${edge.from} -->${edge.label ? `|${edge.label.replaceAll("|", "/")}|` : ""} ${edge.to}`);
  return lines.join("\n");
}
