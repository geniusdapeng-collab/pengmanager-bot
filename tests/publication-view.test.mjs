import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parsePublicRoute, renderPublicPage, renderSiteHeader, renderSiteFooter,
  renderDocumentBlocks, documentBlocksFromText, publicAssets, safePublicUrl,
  chapterMarkers, languagePath, publicPageMetadata, escapeHtml,
} from "../public/publication-view.js";
import { renderWebsiteDocument } from "../src/http/public-website.mjs";
import {
  destinationLocatorFromFields, destinationKindsForPlatform,
  editionReferenceChoices, variantRevisionChoices, mountEditorialWorkbench, buildIllustrationCopyEdition,
} from "../public/editorial-workbench.js";
import { contentMatchesAccount } from "../public/operations.js";
import { createArticleIllustrationControls, placeArticleIllustrations, readArticleIllustrationProofs } from "../public/article-illustrations.js";

test("editorial reads stop when their deadline expires and a later read can recover", async t => {
  const controller = new AbortController();
  const deadline = t.mock.method(AbortSignal, "timeout", () => controller.signal);
  const attributes = new Map();
  const root = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null,
    setAttribute: (name, value) => attributes.set(name, value), addEventListener() {} };
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector: () => root };
  let stalled = true;
  try {
    const workbench = mountEditorialWorkbench({
      getData: () => ({ claims: [] }),
      api(path, { signal }) {
        if (path === "/api/media/assets") return Promise.resolve(null);
        if (!stalled) return Promise.resolve({ stories: [], editions: [] });
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    });
    const loading = workbench.load();
    assert.equal(attributes.get("aria-busy"), "true");
    assert.equal(deadline.mock.calls[0].arguments[0], 90_000);
    controller.abort(new DOMException("deadline", "TimeoutError"));
    assert.equal(await loading, false);
    assert.match(root.innerHTML, /读取编辑数据超时/);
    assert.equal(attributes.get("aria-busy"), "false");
    stalled = false;
    assert.equal(await workbench.load(), true);
    assert.match(root.innerHTML, /还没有选题/);
    assert.doesNotMatch(root.innerHTML, /超时/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("an editorial rendering failure replaces the busy panel with a retryable error", async t => {
  const attributes = new Map();
  const root = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null,
    setAttribute: (name, value) => attributes.set(name, value), addEventListener() {} };
  const prior = globalThis.document;
  const errorLog = t.mock.method(console, "error", () => {});
  globalThis.document = { querySelector: () => root };
  const payload = { stories: [null], editions: [] };
  try {
    const workbench = mountEditorialWorkbench({
      api: async path => path === "/api/editorial/bootstrap" ? payload : { items: [] },
      getData: () => ({ claims: [] }),
    });
    assert.equal(await workbench.load(), false);
    assert.equal(attributes.get("aria-busy"), "false");
    assert.match(root.innerHTML, /无法显示编辑数据/);
    assert.match(root.innerHTML, /data-editorial-refresh>刷新编辑数据/);
    assert.equal(errorLog.mock.callCount(), 1);
    payload.stories = [];
    assert.equal(await workbench.load(), true);
    assert.doesNotMatch(root.innerHTML, /无法显示编辑数据/);
  } finally {
    if (prior === undefined) delete globalThis.document;
    else globalThis.document = prior;
  }
});

const zhArticle = parsePublicRoute("/zh/articles/a-real-question");
const enArticle = parsePublicRoute("/en/articles/a-real-question");
const piece = (extra = {}) => ({
  id: "CNT-TEST", releaseId: "REL-TEST", locale: "zh-CN", format: "article",
  title: "标题 <b>不是 HTML</b>", summary: "完整导语 & 核对", body: "完整正文，必须保留。\n下一行。",
  blocks: [{ type: "paragraph", text: "完整正文，必须保留。\n下一行。" }],
  assets: [], sources: [], alternates: {}, snapshotHash: "a".repeat(64),
  canonicalPath: "/zh/articles/a-real-question", canonicalUrl: "https://workbench.example.net/zh/articles/a-real-question",
  publishedAt: "2026-10-25T01:00:00.000Z", updatedAt: "2026-10-26T01:00:00.000Z", ...extra,
});
const asset = (id, role, extra = {}) => ({ assetId: id, role, sha256: "b".repeat(64), url: `/public-media/${id}/${"b".repeat(64)}`, ...extra });

test("hydrated bilingual page titles and descriptions match the initial server document", async () => {
  const template = await readFile(new URL("../public/site.html", import.meta.url), "utf8");
  const cases = [
    ["/zh", "PengManager · 李大鹏的个人媒体"], ["/en", "PengManager · Writing from practice"],
    ["/zh/articles", "文章"], ["/en/articles", "Article"], ["/zh/visuals", "图文"], ["/en/videos", "Video"],
    ["/zh/about", "关于李大鹏"], ["/en/about", "About Dapeng Li"], ["/zh/work", "作品与公开证据"], ["/en/work", "Work & public evidence"],
  ];
  for (const [path, expected] of cases) {
    const route = parsePublicRoute(path);
    const metadata = publicPageMetadata(route);
    const initial = renderWebsiteDocument(template, route, {}, { origin: "https://workbench.example.net" });
    assert.equal(metadata.title, expected, path);
    assert.ok(initial.includes(`<title>${escapeHtml(metadata.title)}</title>`), path);
    assert.ok(initial.includes(`<meta name="description" content="${escapeHtml(metadata.description)}" />`), path);
    assert.equal((metadata.title.match(/PengManager/g) || []).length, path === "/zh" || path === "/en" ? 1 : 0, path);
  }
});

test("page metadata retains the exact edition title and summary with an explicit private-preview prefix", () => {
  const data = { detail: piece({ title: "A reviewed title <unchanged>", summary: "The exact summary & context" }) };
  assert.deepEqual(publicPageMetadata(enArticle, data), { title: "A reviewed title <unchanged>", description: "The exact summary & context" });
  assert.equal(publicPageMetadata(enArticle, data, { preview: true }).title, "Preview · A reviewed title <unchanged>");
  assert.equal(publicPageMetadata(zhArticle, data, { preview: true }).title, "预览 · A reviewed title <unchanged>");
});

test("public routes keep language, format and slug independent", () => {
  assert.deepEqual(parsePublicRoute("/en/visuals/the-work/"), { lang: "en", locale: "en-US", kind: "detail", format: "image_text", slug: "the-work" });
  assert.deepEqual(parsePublicRoute("/zh/videos"), { lang: "zh", locale: "zh-CN", kind: "archive", format: "video" });
  assert.equal(parsePublicRoute("/en/work").kind, "work");
  assert.equal(parsePublicRoute("/").kind, "home");
  for (const route of ["/fr/articles/work", "/en/articles/Not-Safe", "/en/articles/a/b", "/en/%E0%A4%A", "/zh/private"]) assert.equal(parsePublicRoute(route).kind, "not_found");
  assert.equal(languagePath("en", zhArticle), "/en/articles");
});

test("renderer rejects executable, credentialed and ambiguous URLs", () => {
  for (const url of ["javascript:alert(1)", "data:image/svg+xml,x", "//evil.example", "/\\evil.example", "https://user:secret@example.com", "https://example.com/a\nb", ""]) assert.equal(safePublicUrl(url), null);
  assert.equal(safePublicUrl("/public-media/asset/hash"), "/public-media/asset/hash");
  assert.equal(safePublicUrl("https://workbench.example.net/path"), "https://workbench.example.net/path");
  assert.equal(safePublicUrl("/relative", { relative: false }), null);
  assert.deepEqual(publicAssets({ assets: [{ url: "javascript:bad", id: "bad" }, asset("good", "image")] }).map(row => row.assetId), ["good"]);
});

test("bilingual headers link only the same published edition and explain missing translations", () => {
  const missing = renderSiteHeader(zhArticle, piece());
  assert.match(missing, /data-language-unavailable="en"/);
  assert.doesNotMatch(missing, /href="\/en\/articles\/a-real-question"/);
  const linked = renderSiteHeader(zhArticle, piece({ alternates: { "en-US": "https://workbench.example.net/en/articles/its-own-slug" } }));
  assert.match(linked, /href="https:\/\/workbench.example.net\/en\/articles\/its-own-slug"/);
  const unsafe = renderSiteHeader(enArticle, piece({ alternates: { "zh-CN": "javascript:alert(1)" } }));
  assert.match(unsafe, /data-language-unavailable="zh"/);
  assert.doesNotMatch(unsafe, /href="javascript:/);
  assert.match(renderSiteFooter(enArticle), /Workspace/);
});

test("empty production site contains truthful empty states without invented publications", () => {
  const zh = renderPublicPage(parsePublicRoute("/zh"), { listing: { items: [], total: 0 } });
  const en = renderPublicPage(parsePublicRoute("/en/visuals"), { listing: { items: [], total: 0 } });
  assert.match(zh, /第一批内容，正在认真准备/);
  assert.match(en, /no published pieces/i);
  for (const output of [zh, en]) {
    assert.doesNotMatch(output, /data-public-release=/);
    assert.doesNotMatch(output, /data-load-more/);
    assert.doesNotMatch(output, /class="journal-row"/);
  }
});

test("article rendering preserves full text, escapes markup and exposes only safe source links", () => {
  const output = renderPublicPage(zhArticle, { detail: piece({ sources: [
    { url: "javascript:alert(1)", title: "forbidden" },
    { url: "https://example.org/evidence", title: "真实公开依据 <script>" },
  ] }) });
  assert.match(output, /标题 &lt;b&gt;不是 HTML&lt;\/b&gt;/);
  assert.match(output, /完整正文，必须保留。<br \/>下一行。/);
  assert.match(output, /data-public-release="REL-TEST"/);
  assert.match(output, /data-snapshot-hash="a{64}"/);
  assert.match(output, /href="https:\/\/example.org\/evidence"/);
  assert.doesNotMatch(output, /forbidden|<script>|<b>不是 HTML/);
});

test("structured blocks preserve heading order, list semantics and code as text", () => {
  const original = "## 第一个问题\n\n全文 & <script>alert(1)</script>\n第二行\n\n- 一\n- 二\n\n### 第二个问题\n\n1. 步骤\n\n> 说明\n\n```js\nconst exact = '<img onerror=bad>';\n```";
  const blocks = documentBlocksFromText(original);
  assert.deepEqual(blocks.map(row => row.type), ["heading", "paragraph", "list", "heading", "list", "quote", "code"]);
  assert.equal(blocks[2].ordered, false);
  assert.equal(blocks[4].ordered, true);
  const output = renderPublicPage(zhArticle, { detail: piece({ body: original, blocks }) });
  assert.match(output, /href="#section-0"/);
  assert.match(output, /href="#section-3"/);
  assert.match(output, /<ol><li>步骤<\/li><\/ol>/);
  assert.match(output, /const exact = &#039;&lt;img onerror=bad&gt;&#039;;/);
  assert.doesNotMatch(output, /<script>|<img onerror/);
  assert.equal(original.includes("<script>"), true);
});

test("historic paragraph or body-only articles render Markdown headings with working section links", () => {
  const body = "## 第一个问题 ##\r\n引言正文。\r\n\r\n   #### 第二个问题\r\n- 第一步\r\n- 第二步";
  for (const blocks of [
    undefined,
    [{ type: "paragraph", text: "## 第一个问题 ##\n引言正文。" },
      { type: "paragraph", text: "   #### 第二个问题\n- 第一步\n- 第二步" }],
  ]) {
    const detail = piece({ body, blocks });
    const before = structuredClone(detail);
    const output = renderPublicPage(zhArticle, { detail });
    assert.match(output, /href="#section-0">第一个问题/);
    assert.match(output, /href="#section-2">第二个问题/);
    assert.match(output, /<h2 id="section-0">第一个问题<\/h2><p>引言正文。<\/p>/);
    assert.match(output, /<h3 id="section-2">第二个问题<\/h3><ul><li>第一步<\/li><li>第二步<\/li><\/ul>/);
    assert.doesNotMatch(output, /##/);
    assert.deepEqual(detail, before);
  }
});

test("gallery keeps explicit block order, exact alt/captions and adds unplaced images once", () => {
  const output = renderPublicPage(parsePublicRoute("/zh/visuals/the-work"), { detail: piece({ format: "image_text",
    blocks: [{ type: "image", assetId: "two", alt: "第二图的真实替代文字", caption: "图二" }, { type: "paragraph", text: "两图之间的解释" }, { type: "image", assetId: "one", alt: "图一" }],
    assets: [asset("one", "image", { alt: "图一", caption: "第一张" }), asset("two", "image", { alt: "图二" }), asset("three", "image", { alt: "第三图", caption: "补充图" })],
  }) });
  assert.ok(output.indexOf('data-piece-image="two"') < output.indexOf("两图之间的解释"));
  assert.ok(output.indexOf("两图之间的解释") < output.indexOf('data-piece-image="one"'));
  assert.ok(output.indexOf('data-piece-image="one"') < output.indexOf('data-piece-image="three"'));
  assert.equal((output.match(/data-piece-image=/g) || []).length, 3);
  assert.match(output, /alt="第二图的真实替代文字"/);
  assert.match(output, /data-image-caption="图二"/);
  assert.match(output, /data-enlarge-image/);
});

test("exported block renderer filters unsafe asset URLs before creating media controls", () => {
  const output = renderDocumentBlocks([{ type: "image", assetId: "bad" }, { type: "video", assetId: "bad-video" }], { assets: [{ assetId: "bad", url: "javascript:alert(1)" }, { assetId: "bad-video", url: "data:text/html,unsafe" }] });
  assert.equal(output, "");
});

test("video rendering uses real native controls, separate captions, chapter seeking and full transcript", () => {
  const output = renderPublicPage(parsePublicRoute("/en/videos/a-real-question"), { detail: piece({ format: "video", locale: "en-US",
    blocks: [{ type: "heading", level: 2, text: "00:00 The question" }, { type: "paragraph", text: "The complete transcript, without autoplay." }, { type: "heading", level: 2, text: "01:12 A real decision" }],
    assets: [asset("movie", "video", { kind: "video", mime: "video/mp4" }), asset("poster", "poster", { kind: "image" }), asset("caption-en", "subtitle", { locale: "en-US", caption: "English" }), asset("caption-zh", "subtitle", { locale: "zh-CN", caption: "中文" })],
  }) });
  assert.match(output, /<video controls playsinline preload="metadata"/);
  assert.doesNotMatch(output, /<iframe|<video[^>]*\sautoplay(?:\s|=|>)/);
  assert.match(output, /<source [^>]*type="video\/mp4"/);
  assert.match(output, /srclang="en-US" label="English" default/);
  assert.match(output, /srclang="zh-CN" label="中文"/);
  assert.match(output, /data-seek="72"/);
  assert.match(output, /The complete transcript, without autoplay\./);
  assert.match(output, /data-retry-video/);
  const unavailable = renderPublicPage(parsePublicRoute("/en/videos/no-bytes"), { detail: piece({ blocks: [{ type: "heading", level: 2, text: "00:00 Still readable" }] }) });
  assert.match(unavailable, /video is currently unavailable/i);
  assert.match(unavailable, /Still readable/);
  assert.doesNotMatch(unavailable, /data-seek=/);
  assert.deepEqual(chapterMarkers([{ type: "heading", text: "00:99 Invalid" }, { type: "heading", text: "01:02:03 A chapter" }]), [{ label: "A chapter", time: "01:02:03", seconds: 3723 }]);
});

test("withdrawn and never-published pages have distinct public states and no old body", () => {
  for (const [status, phrase] of [[404, "暂时找不到这篇内容"], [410, "这篇内容目前不可用"]]) {
    const output = renderPublicPage(zhArticle, { error: { status }, detail: piece() });
    assert.match(output, new RegExp(phrase));
    assert.match(output, /data-public-unavailable="true"/);
    assert.doesNotMatch(output, /完整正文，必须保留|data-public-release=/);
  }
});

test("published stale translations clearly retain independent text and dates", () => {
  const output = renderPublicPage(enArticle, { detail: piece({ locale: "en-US", title: "The reviewed translation", translationStatus: "needs_review", sourceCanonicalUrl: "https://workbench.example.net/zh/articles/newer-source" }) });
  assert.match(output, /earlier source revision/);
  assert.match(output, /href="https:\/\/workbench.example.net\/zh\/articles\/newer-source"/);
  assert.match(output, /The reviewed translation/);
  assert.match(output, /2026-10-25T01:00:00.000Z/);
  const original = renderPublicPage(enArticle, { detail: piece({ translationStatus: "original" }) });
  assert.doesNotMatch(original, /earlier source revision/);
});

test("destination forms serialize only the selected locator schema", () => {
  const fields = new Map(Object.entries({ origin: "https://workbench.example.net", locatorUrl: "https://github.com/owner/repo", serverId: "123456", channelId: "456789", threadId: "", artifactKind: "model" }));
  assert.deepEqual(destinationLocatorFromFields("owned_origin", fields), { origin: "https://workbench.example.net" });
  assert.deepEqual(destinationLocatorFromFields("community_channel", fields), { serverId: "123456", channelId: "456789" });
  fields.set("threadId", "987654");
  assert.deepEqual(destinationLocatorFromFields("community_channel", fields), { serverId: "123456", channelId: "456789", threadId: "987654" });
  assert.deepEqual(destinationLocatorFromFields("repository", fields), { url: "https://github.com/owner/repo" });
  assert.deepEqual(destinationLocatorFromFields("artifact_repository", fields), { url: "https://github.com/owner/repo", artifactKind: "model" });
  assert.deepEqual(destinationKindsForPlatform({ kind: "owned_site" }), ["owned_origin"]);
  assert.deepEqual(destinationKindsForPlatform({ id: "discord" }), ["community_channel"]);
  assert.deepEqual(destinationKindsForPlatform({ id: "reddit" }), ["community"]);
  assert.deepEqual(destinationKindsForPlatform({ kind: "technical_artifact" }), ["repository", "artifact_repository"]);
});

test("edition revision choices reject unrelated source families and require the newest same-language revision", () => {
  const rows = [
    { id: "zh-old", storyId: "story", locale: "zh-CN", format: "article", editorialRevision: 1 },
    { id: "zh-current", storyId: "story", locale: "zh-CN", format: "article", editorialRevision: 2 },
    { id: "en-source", storyId: "story", locale: "en-US", format: "article", editorialRevision: 1 },
    { id: "en-video", storyId: "story", locale: "en-US", format: "video", editorialRevision: 3 },
    { id: "other", storyId: "other-story", locale: "en-US", format: "article", editorialRevision: 9 },
  ];
  const choices = editionReferenceChoices(rows, { storyId: "story", locale: "zh-CN", format: "article" });
  assert.equal(choices.previous.id, "zh-current");
  assert.deepEqual(choices.sources.map(row => row.id), ["en-source"]);
  const newFamily = editionReferenceChoices(rows, { storyId: "story", locale: "zh-CN", format: "video" });
  assert.equal(newFamily.previous, null);
  assert.deepEqual(newFamily.sources.map(row => row.id), ["en-video"]);
  assert.equal(rows[0].id, "zh-old");
});

test("channel revisions stay in their exact story, locale, format and destination", () => {
  const edition = { storyId: "story", locale: "en-US", format: "article" };
  const matching = { id: "old-channel", ...edition, destinationId: "destination" };
  const rows = [matching, { ...matching, id: "other-destination", destinationId: "other" }, { ...matching, id: "other-locale", locale: "zh-CN" }, { ...matching, id: "other-format", format: "video" }, { ...matching, id: "other-story", storyId: "other" }];
  assert.deepEqual(variantRevisionChoices(rows, edition, "destination").map(row => row.id), ["old-channel"]);
});

test("article plans place three approved images beside their individual anchors without duplicating blocks", () => {
  const blocks = [
    { type: "heading", level: 2, text: "架构关系" },
    { type: "image", assetId: "img-3", alt: "未更新替代文本" },
    { type: "paragraph", text: "一次完整的\n复核动作" },
    { type: "list", items: ["模拟前置材料", "跨岗位夜班场景"] },
  ];
  const assets = [1, 2, 3].map(index => ({
    id: `img-${index}`, status: "reviewed", kind: "image", sha256: String(index).repeat(64),
  }));
  const [first, second, third] = ["架构关系", "完整的 复核", "跨岗位夜班场景"].map((anchor, index) => ({
    anchor, alt: `对第 ${index + 1} 个主题的替代说明`, caption: `图 ${index + 1} 的解释`,
    evidence: { assetId: assets[index].id, sha256: assets[index].sha256 },
  }));
  const plan = { isComplete: true, slots: [third, first, second] };
  const result = placeArticleIllustrations(blocks, [], plan, assets);
  assert.deepEqual(result.blocks.map(block => block.assetId || block.type),
    ["heading", "img-1", "paragraph", "img-2", "list", "img-3"]);
  assert.deepEqual(result.references.map(ref => ref.assetId), ["img-1", "img-2", "img-3"]);
  assert.deepEqual(result.blocks[5], { type: "image", assetId: "img-3", alt: third.alt, caption: third.caption });
  assert.equal(blocks[1].alt, "未更新替代文本");
  assert.throws(() => placeArticleIllustrations(blocks, [], { ...plan, isComplete: false }, assets), /至少三张/);
  assert.throws(() => placeArticleIllustrations(blocks, [], plan, assets.map(asset => ({ ...asset, status: "revoked" }))), /审核状态/);
  assert.throws(() => placeArticleIllustrations([...blocks, { ...blocks[0] }], [], plan, assets), /明确的正文块/);
  const duplicate = { ...second, evidence: first.evidence };
  assert.throws(() => placeArticleIllustrations(blocks, [], { ...plan, slots: [first, duplicate, third] }, assets), /配图字节/);
});

test("the copy edition sends exact public fields and latest family revision with only planned images added", () => {
  const blocks = [
    { type: "heading", level: 2, text: "Architecture & boundaries" },
    { type: "paragraph", text: "A full\noriginal process" },
    { type: "list", ordered: true, items: ["One choice", "A grounded scene"] },
    { type: "image", assetId: "existing", alt: "original image" },
  ];
  const assetRefs = [{ assetId: "existing", role: "image", sha256: "e".repeat(64), alt: "original image" }];
  const source = piece({ locale: "en-US", title: "Exact title", summary: "Original & unedited.", body: "Original text\n\nNext paragraph.", blocks,
    claimIds: ["C002", "C001"], assetRefs });
  const release = { id: "REL-EARLIER", storyId: "story", editionId: "old", publicSnapshot: source };
  const editions = [
    { id: "old", storyId: "story", locale: "en-US", format: "article", editorialRevision: 1, sourceEditionId: "translation-source" },
    { id: "latest", storyId: "story", locale: "en-US", format: "article", editorialRevision: 2 },
    { id: "other-lang", storyId: "story", locale: "zh-CN", format: "article", editorialRevision: 7 },
    { id: "other-format", storyId: "story", locale: "en-US", format: "image_text", editorialRevision: 9 },
  ];
  const assets = [1, 2, 3].map(index => ({ id: `new-${index}`, status: "reviewed", kind: "image", sha256: String(index).repeat(64) }));
  const slots = ["Architecture & boundaries", "original process", "A grounded scene"].map((anchor, index) => ({
    anchor, alt: `New alt ${index}`, caption: `New caption ${index}`, evidence: { assetId: assets[index].id, sha256: assets[index].sha256 },
  }));
  const plan = { id: "plan", storyId: "story", locale: "en-US", baseReleaseId: release.id, isComplete: true, slots };
  const before = structuredClone(source);
  const result = buildIllustrationCopyEdition(release, editions, plan, assets);
  for (const key of ["locale", "format", "title", "summary", "body", "claimIds"]) assert.deepEqual(result[key], before[key]);
  assert.deepEqual(result.blocks.filter(block => !assets.some(item => item.id === block.assetId)), before.blocks);
  assert.equal(result.blocks[1].caption, "New caption 0");
  assert.deepEqual(result.assetRefs.map(ref => ref.assetId), ["existing", "new-1", "new-2", "new-3"]);
  assert.equal(result.supersedesEditionId, "latest");
  assert.equal(result.sourceEditionId, "translation-source");
  assert.equal(result.illustrationPlanId, plan.id);
  assert.equal(Object.hasOwn(result, "baseReleaseId"), false);
  assert.deepEqual(source, before);
  assert.throws(() => buildIllustrationCopyEdition(release, editions, { ...plan, baseReleaseId: "REL-WRONG" }, assets), /完全匹配/);
  assert.throws(() => buildIllustrationCopyEdition(release, editions, { ...plan, isComplete: false }, assets), /至少三张/);
  const overlappingSlots = [{ ...slots[0], evidence: assetRefs[0] }, ...slots.slice(1)];
  assert.throws(() => buildIllustrationCopyEdition(release, editions, { ...plan, slots: overlappingSlots },
    [...assets, { ...assetRefs[0], id: "existing", status: "reviewed", kind: "image" }]), /已经|已绑定/);
});

test("only a matching published copy base can explicitly open the read-only copy form", async t => {
  const events = new Map();
  const root = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null, setAttribute() {},
    addEventListener(name, handler) { events.set(name, handler); } };
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: selector => selector === "#editorial-root" ? root : null };
  t.after(() => { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; });
  const publicSnapshot = piece({ locale: "en-US", claimIds: ["C002"], assetRefs: [] });
  const data = {
    stories: [{ id: "story", workingTitle: "Working title", status: "active", claimIds: ["C001"] }],
    editions: [],
    releases: [{ id: "REL-BASE", storyId: "story", status: "published", publicSnapshot },
      { id: "REL-OTHER", storyId: "other-story", status: "published", publicSnapshot },
      { id: "REL-DRAFT", storyId: "story", status: "draft", publicSnapshot }],
    illustrationCopyBases: ["REL-BASE", "REL-OTHER", "REL-DRAFT"].map(releaseId => ({ storyId: "story", releaseId })),
  };
  const workbench = mountEditorialWorkbench({ api: async route => route === "/api/editorial/bootstrap" ? data : [], getData: () => ({ claims: [] }) });
  await workbench.load();
  const edition = () => root.innerHTML.match(/<form\b[^>]*data-editorial-form="edition-create"[^>]*>[\s\S]*?<\/form>/)?.[0] || "";
  const choose = releaseId => events.get("click")({ target: { closest: () => ({
    dataset: { editorialCopyBase: releaseId }, hasAttribute: attr => attr === "data-editorial-copy-base",
    closest: () => ({ dataset: { entityId: "story" } }),
  }) } });
  assert.match(edition(), /沿用原公开稿，仅补配图 · REL-BASE/);
  assert.doesNotMatch(edition(), /REL-OTHER|REL-DRAFT|readonly/);
  choose("REL-OTHER");
  assert.doesNotMatch(edition(), /data-illustration-base-release-id/);
  choose("REL-BASE");
  assert.match(edition(), /data-illustration-base-release-id="REL-BASE"/);
  for (const name of ["title", "summary", "body", "blocksJson"]) assert.match(edition(), new RegExp(`name="${name}"[^>]*readonly`));
  assert.match(edition(), /name="locale" disabled[\s\S]*value="en-US" selected/);
  assert.match(edition(), /完整正文，必须保留。\n下一行。/);
  assert.match(edition(), /原稿事实依据 <code>C002<\/code>/);
  assert.doesNotMatch(edition(), /name="assetId"|C001/);
  choose("");
  assert.doesNotMatch(edition(), /readonly|data-illustration-base-release-id/);
  choose("REL-BASE");
  data.illustrationCopyBases = [];
  await workbench.load();
  assert.match(edition(), /原公开稿已变化/);
  assert.doesNotMatch(edition(), /data-illustration-base-release-id|data-editorial-copy-base|readonly/);
});

test("the illustration selector filters by exact copy base and only plan save sends the base ID", async () => {
  const events = new Map();
  const root = { addEventListener(name, handler) { events.set(name, handler); } };
  const publicSnapshot = piece({ locale: "en-US" });
  const base = { id: "REL-BASE", publicSnapshot };
  const slots = ["architecture", "logic", "scene"].map(kind => ({
    kind, anchor: "原文位置", description: "图面说明", alt: "替代文字", caption: "", imageGeneration: false,
  }));
  const published = { id: "public-copy-plan", baseReleaseId: base.id, storyId: "story", slots };
  const wrong = { ...published, id: "different-copy-plan", baseReleaseId: "REL-OTHER" };
  const legacy = { id: "ordinary-plan", storyId: "story", slots };
  const requests = [];
  const api = async (url, request) => {
    requests.push({ url, body: request?.body ? JSON.parse(request.body) : null });
    return url.endsWith("/suggest") ? { articleType: "product", slots, reasons: [] } : { items: [published, wrong, legacy] };
  };
  const mutate = async (url, body) => {
    requests.push({ url, body });
    return body.baseReleaseId ? published : legacy;
  };
  const controls = createArticleIllustrationControls(root, { api, mutate, getAssets: () => [],
    getCopyBase: form => form.dataset.illustrationBaseReleaseId ? base : null });
  const select = { value: "", innerHTML: "" };
  const error = { textContent: "" };
  const panel = {
    querySelector: selector => selector === "[data-illustration-error]" ? error : { value: "product" },
    querySelectorAll: () => slots.map(slot => ({ querySelectorAll: () => Object.entries(slot).map(([name, value]) => ({
      dataset: { illustrationEntry: name }, value, checked: value, type: typeof value === "boolean" ? "checkbox" : "text",
    })) })),
  };
  const form = { dataset: { entityId: "story", illustrationBaseReleaseId: base.id }, isConnected: true,
    querySelector: selector => selector === '[name="illustrationPlanId"]' ? select
      : selector === '[name="format"]' ? { value: "article" }
      : selector === "[data-article-illustrations]" ? panel : { value: "Unrelated form text" } };
  const click = async action => {
    const button = { dataset: { illustrationAction: action }, closest: selector => selector === "form" ? form : panel };
    events.get("click")({ target: { closest: () => button } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(error.textContent, "");
  };
  await click("load");
  assert.match(select.innerHTML, /public-copy-plan/);
  assert.doesNotMatch(select.innerHTML, /different-copy-plan|ordinary-plan/);
  select.value = wrong.id;
  assert.equal(controls.selectedPlan(form), undefined);
  select.value = "";
  await click("save");
  assert.equal(requests[1].body.baseReleaseId, base.id);
  assert.equal(requests[1].body.title, publicSnapshot.title);
  assert.equal(requests[1].body.body, publicSnapshot.body);
  await click("suggest");
  assert.equal(requests[2].body.body, publicSnapshot.body);
  assert.equal(Object.hasOwn(requests[2].body, "baseReleaseId"), false);
  delete form.dataset.illustrationBaseReleaseId;
  select.value = published.id;
  assert.equal(controls.selectedPlan(form), undefined);
  await click("save");
  assert.equal(Object.hasOwn(requests[3].body, "baseReleaseId"), false);
  assert.equal(requests[3].body.body, "Unrelated form text");
  assert.match(controls.markup("story"), /ordinary-plan/);
  assert.doesNotMatch(controls.markup("story"), /public-copy-plan/);
});

test("editorial receipt picker preserves the two independent tool envelopes", async () => {
  const create = source => ({ statement: { source }, signature: "test-signature", producerKeyId: "test-key" });
  const designerCompositor = create("pengmanager-designer-compositor");
  const imageGen = create("codex-imagegen");
  const files = [designerCompositor, imageGen].map(envelope => new Blob([JSON.stringify(envelope)]));
  assert.deepEqual(await readArticleIllustrationProofs(files), { designerCompositor, imageGen });
  assert.deepEqual(await readArticleIllustrationProofs([]), {});
  await assert.rejects(() => readArticleIllustrationProofs([files[0], files[0]]), /不同工具/);
  await assert.rejects(() => readArticleIllustrationProofs([new Blob(["{"])]), /有效的 JSON/);
});

test("the operations picker never offers an owned-site or another account's editorial variant", () => {
  const account = { id: "actual-account", platform: "Medium", status: "active" };
  const variant = { editionId: "edition", platforms: ["Medium"], accountSnapshot: { id: "actual-account" }, destinationSnapshot: { accountId: "actual-account" } };
  assert.equal(contentMatchesAccount(variant, account), true);
  assert.equal(contentMatchesAccount(variant, { ...account, id: "other-medium-account" }), false);
  assert.equal(contentMatchesAccount(variant, { ...account, status: "archived" }), false);
  assert.equal(contentMatchesAccount({ ...variant, accountSnapshot: null, destinationSnapshot: { kind: "owned_origin", accountId: null } }, account), false);
  assert.equal(contentMatchesAccount({ platforms: ["Medium"] }, account), true);
  assert.equal(contentMatchesAccount({ platforms: ["GitHub"] }, account), false);
});

test("workbench renders real service-shaped lifecycle data without prechecked human approvals", async () => {
  const events = new Map();
  const root = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null, setAttribute() {}, addEventListener(name, callback) { events.set(name, callback); } };
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector: selector => selector === "#editorial-root" ? root : null };
  const publicSnapshot = { ...piece(), assetRefs: [] };
  const data = {
    catalog: { platforms: [{ id: "official-site", name: "真实官网", nameEn: "Website", kind: "owned_site", role: "长期阅读入口", preferredContentForms: ["article", "video_with_transcript"], configuredAccountCount: 0 }] },
    accounts: [
      { id: "account", platformId: "medium", platform: "Medium", handle: "actual-handle", profileUrl: "https://medium.com/@actual-handle", language: "en-US", displayName: "Actual display", status: "draft", etag: '"account-etag"' },
      { id: "blank-draft-account", platformId: "wechat-official", platform: "微信公众号", handle: "actual-draft-handle", profileUrl: "", language: "zh-CN", displayName: "Draft display", status: "draft", etag: '"blank-draft-etag"' },
      { id: "paused-account", platformId: "medium", platform: "Medium", handle: "paused-handle", profileUrl: "", language: "en-US", displayName: "Paused display", status: "paused", etag: '"paused-etag"' },
    ],
    destinations: [{ id: "owned", platformId: "official-site", kind: "owned_origin", name: "实际官网", locator: { origin: "https://workbench.example.net" }, status: "draft", visibility: "unverified", etag: '"destination-etag"' }],
    stories: [{ id: "story", workingTitle: "真实选题", status: "draft", claimIds: [], etag: '"story-etag"' }],
    editions: [{ id: "edition", storyId: "story", locale: "en-US", format: "article", title: "Reviewed edition", body: "Whole source body", blocks: [{ type: "paragraph", text: "Whole source body" }], assetRefs: [], editorialRevision: 1, translationStatus: "needs_review", snapshotHash: "c".repeat(64), etag: '"edition-etag"' }],
    variants: [{ id: "variant", storyId: "story", editionId: "edition", destinationId: "owned", locale: "en-US", format: "article", title: "Whole channel title", body: "Whole channel body", blocks: [], assetRefs: [], status: "scheduled", etag: '"variant-etag"' }],
    releases: [{ id: "release", storyId: "story", locale: "en-US", format: "article", slug: "actual-slug", canonicalPath: "/en/articles/actual-slug", publicSnapshot, snapshotHash: "d".repeat(64), status: "draft", etag: '"release-etag"' }],
    routes: [], claims: [],
  };
  try {
    const workbench = mountEditorialWorkbench({ api: async path => path === "/api/editorial/bootstrap" ? data : { items: [] }, getData: () => ({ claims: [] }) });
    assert.equal(await workbench.load(), true);
    assert.match(root.innerHTML, /name="supersedesEditionId"/);
    assert.match(root.innerHTML, /按正文识别类型并建议图位/);
    assert.match(root.innerHTML, /name="illustrationPlanId"/);
    assert.equal((root.innerHTML.match(/data-illustration-slot(?=[ >])/g) || []).length, 3);
    assert.match(root.innerHTML, /name="supersedesContentId"/);
    assert.match(root.innerHTML, /译文来源已有较新修订/);
    assert.match(root.innerHTML, /name="slug" required maxlength="100"/);
    assert.match(root.innerHTML, /Whole source body/);
    const choose = tab => events.get("click")({ target: { closest: () => ({ dataset: { editorialTab: tab } }) } });
    choose("destinations");
    assert.match(root.innerHTML, /name="origin"[^>]*value="https:\/\/workbench.example.net"/);
    assert.doesNotMatch(root.innerHTML, /\[object Object\]/);
    choose("accounts");
    assert.match(root.innerHTML, /actual-handle/);
    assert.match(root.innerHTML, /name="identityConfirmed"/);
    const accountForms = [...root.innerHTML.matchAll(/<form\b[^>]*data-editorial-form="(account-create|account-update)"[^>]*>[\s\S]*?<\/form>/g)];
    assert.equal(accountForms.length, 4);
    for (const [form, action] of accountForms) {
      const profileInput = form.match(/<input\b[^>]*name="profileUrl"[^>]*>/)?.[0];
      assert.ok(profileInput);
      if (action === "account-create") assert.match(profileInput, /\brequired(?:\s|=|>)/);
      else assert.doesNotMatch(profileInput, /\brequired(?:\s|=|>)/);
      if (/data-entity-id="(?:blank-draft-account|paused-account)"/.test(form)) assert.match(profileInput, /value=""/);
    }
    choose("releases");
    assert.match(root.innerHTML, /href="\/admin\/preview\/release"/);
    assert.match(root.innerHTML, /data-etag="&quot;release-etag&quot;"/);
    assert.match(root.innerHTML, /name="reviewed" required/);
    for (const tab of ["releases", "accounts", "destinations", "media"]) {
      choose(tab);
      assert.doesNotMatch(root.innerHTML, /name="(?:reviewed|confirm|identityConfirmed|policyReviewed|rightsConfirmed|privacyConfirmed)"[^>]*\bchecked\b/);
      assert.doesNotMatch(root.innerHTML, /name="(?:actor|approvedBy)"/);
    }
    choose("catalog");
    assert.match(root.innerHTML, /视频与完整文稿/);
    assert.match(root.innerHTML, /长期阅读入口/);
    assert.doesNotMatch(root.innerHTML, /video_with_transcript|undefined/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
