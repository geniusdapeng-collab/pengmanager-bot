import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";

const defaults = resolve(import.meta.dirname, "..");
const argumentsList = process.argv.slice(2);
const distribution = argumentsList.includes("--distribution");
const positionals = argumentsList.filter((value) => !value.startsWith("--"));
if (positionals.length > 1 || argumentsList.some((value) => value.startsWith("--") && value !== "--distribution")) {
  console.error("Usage: node scripts/public-audit.mjs [export-root] [--distribution]");
  process.exit(2);
}
const root = resolve(positionals[0] ?? defaults);
const digest = (data) => createHash("sha256").update(data).digest("hex");
const fontsDirectory = "engines/video-edit/bundles/ai-video/library/fonts";
const fontManifestFile = fontsDirectory + "/distribution-assets.json";
const fontManifestSha = "f3b0cf26221d35128a1c78ee1e26cc4b8cd5b0b3c54748a5724ec790dd507c2a";
const publicArtifacts = new Map([
  ["docs/workbench.png", { sha256: "23e5954bc89d1834b9eb23a76705b6959bb3bd3351a2f18d273fe710fcd9a040", binary: true }],
  [fontManifestFile, { sha256: fontManifestSha, binary: false }],
  ["engines/video-edit/packages/base/model-router/assets/deepseek-v4-tokenizer.json",
    { sha256: "c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b", binary: false }],
]);
const rules = [
  ["live_provider_credential", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[\w]{40,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{32,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{35})\b/u],
  ["private_key", /-----BEGIN (?:[A-Z][A-Z0-9 ]+ )?PRIVATE KEY-----/u],
  ["signed_cloud_link", /(?:OSSAccessKeyId=|X-Amz-(?:Credential|Signature)=|X-Goog-Credential=)/iu],
  ["production_origin", new RegExp("\\b" + ["pengmanager", "(?:com|cn)"].join("\\.") + "\\b", "iu")],
  ["private_repository", new RegExp("\\b(?:" + [
    ["pengmanager", "custom-model"].join("[-]"), ["geniusdapeng", "geo-os"].join("[-]"),
    ["cnb", "cool/workloom-ai"].join("\\."),
  ].join("|") + ")\\b", "iu")],
  ["specific_customer", new RegExp(["苏州", "未来前台"].join(""), "u")],
  ["local_owner_path", /\/(?:Users|home)\/(?:mac|dapeng|ubuntu|admin)\b/iu],
  ["internal_service_address", /(?:https?|ssh):\/\/(?:[a-z0-9-]+\.)+(?:internal|lan|local)(?=[:/"'\s]|$)|(?:https?|ssh):\/\/(?:10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(?=[:/"'\s]|$)/iu],
  ["personal_email", /\b[A-Za-z0-9_%+.-]+@(?:qq|gmail|163|outlook|hotmail|icloud|126)\.com\b/iu],
  ["browser_safeguard_evasion", /puppeteer-extra-plugin-stealth|undetected[_.-]chromedriver|selenium-stealth|chrome[/]cookies/iu],
];
const literalSecret = /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization|password|bearer[_-]?token|secret[_-]?key)["']?\s*[:=]\s*["'](?:Bearer )?([A-Za-z0-9_=+/.-]{18,})["']/giu;
const knownFixture = /(?:fixture|synthetic|isolated|not-a-|invalid|test|fake|wrong|different|example|x{8,}|0{24,})/iu;
const relativeModule = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](\.{1,2}\/[^"'\r\n]+)["']/gu;
const hasJavaScriptSyntax = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".tsx"]);
const localToolNames = new Set(["node_modules", ".git", ".pnpm-store", ".DS_Store", ".npm"]);
const localRunNames = new Set(["var", "coverage", "dist", "build", "outputs", ".cache"]);
const privateType = /(?:^\.env(?:$|\.(?!example$).+)|\.(?:sqlite(?:-.*)?|db(?:-.*)?|log|tmp|pem|p12|pfx|key|sess|cookie|tgz|zip|tar|gz|dmg)$)/iu;
const privatePath = /(?:^|[/_-])(?:secret|secrets|credential|credentials|private)(?:[/_-]|$)/iu;
const findings = [];
const skipped = [];
let files = 0;
let textFiles = 0;
let dependencyReferences = 0;

function cleanPath(path) {
  return path.split(sep).join("/");
}

function finding(file, kind, line) {
  // Record only filename, rule and position. Do not emit the matching value or source line.
  findings.push({ file, kind, ...(line === undefined ? {} : { line }) });
}

function pinFontAssets() {
  const fullPath = resolve(root, fontManifestFile);
  if (!existsSync(fullPath) || !lstatSync(fullPath).isFile()) return;
  const bytes = readFileSync(fullPath);
  if (digest(bytes) !== fontManifestSha) return;
  const manifest = JSON.parse(bytes.toString("utf8"));
  for (const asset of manifest.assets) {
    if (!/^(?:cn|en)\/[A-Za-z0-9-]+\.(?:ttf|otf)$/u.test(asset.file)) {
      finding(fontManifestFile, "invalid_font_reference");
      continue;
    }
    publicArtifacts.set(fontsDirectory + "/" + asset.file, { sha256: asset.sha256, binary: true });
  }
  publicArtifacts.set(fontsDirectory + "/licenses/SIL-OFL-1.1.txt", { sha256: manifest.licenseSha256, binary: false });
  publicArtifacts.set(fontsDirectory + "/licenses/EMBEDDED-NOTICES.txt", { sha256: manifest.nameTableNoticesSha256, binary: false });
}

function hasRelativeModule(file, request) {
  const target = resolve(dirname(file), request.split(/[?#]/u)[0]);
  if (!target.startsWith(root + sep)) return false;
  const candidates = [target, target.replace(/\.js$/u, ".ts"), target.replace(/\.mjs$/u, ".mts")];
  return candidates.some((candidate) => existsSync(candidate) && lstatSync(candidate).isFile());
}

function auditFile(file, rel) {
  files += 1;
  const data = readFileSync(file);
  const pinned = publicArtifacts.get(rel);
  if (pinned && digest(data) !== pinned.sha256) finding(rel, "public_asset_changed");
  if (data.includes(0) || pinned?.binary) {
    if (!pinned?.binary) finding(rel, "unexpected_binary");
    return;
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    finding(rel, "unknown_encoding_or_binary");
    return;
  }
  textFiles += 1;
  if (pinned) return;
  for (const [name, pattern] of rules) {
    const match = pattern.exec(source);
    if (match && rel !== "scripts/public-audit.mjs") {
      finding(rel, name, source.slice(0, match.index).split("\n").length);
    }
  }
  for (const match of source.matchAll(literalSecret)) {
    if (!((rel.startsWith("tests/") || rel.includes("/test/") || rel.includes(".test.")) && knownFixture.test(match[1]))) {
      finding(rel, "literal_credential_requires_review", source.slice(0, match.index).split("\n").length);
    }
  }
  if (hasJavaScriptSyntax.has(extname(rel))) {
    for (const match of source.matchAll(relativeModule)) {
      dependencyReferences += 1;
      if (!hasRelativeModule(file, match[1])) {
        finding(rel, "missing_relative_module", source.slice(0, match.index).split("\n").length);
      }
    }
  }
}

function walk(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = resolve(directory, item.name);
    const rel = cleanPath(relative(root, file));
    if (localToolNames.has(item.name)) {
      if (distribution) finding(rel, "local_tool_or_dependency_in_export");
      else skipped.push(rel);
      continue;
    }
    if (localRunNames.has(item.name) && item.isDirectory() || privatePath.test(rel) || privateType.test(item.name)) {
      finding(rel, "private_or_generated_file");
      continue;
    }
    if (item.isSymbolicLink()) {
      finding(rel, "unexpected_symlink");
      continue;
    }
    if (item.isDirectory()) walk(file);
    else if (item.isFile()) auditFile(file, rel);
    else finding(rel, "unexpected_file_type");
  }
}

pinFontAssets();
walk(root);
for (const rel of ["LICENSE", "NOTICE", "engines/geo-evidence/LICENSE", "engines/geo-evidence/NOTICE",
  "engines/video-edit/LICENSE", "engines/video-edit/NOTICE", ...publicArtifacts.keys()]) {
  if (!existsSync(resolve(root, rel))) finding(rel, "missing_license_or_pinned_asset");
}
const license = resolve(root, "package.json");
if (!existsSync(license) || JSON.parse(readFileSync(license, "utf8")).license !== "Apache-2.0") {
  finding("package.json", "distribution_license_mismatch");
}
const stats = { ok: findings.length === 0, distribution, filesScanned: files, textFiles,
  publicAssetsPinned: publicArtifacts.size, dependencyReferences, skippedDependencyDirectories: skipped, findings };
console.log(JSON.stringify(stats, null, 2));
process.exitCode = findings.length ? 1 : 0;
