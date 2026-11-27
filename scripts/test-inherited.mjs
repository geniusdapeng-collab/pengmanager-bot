import { createTestEnvironment } from "./test-environment.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const standalone = resolve(root, "engines/geo-evidence/test");
const video = resolve(root, "engines/video-edit");
const cleanEnvironment = createTestEnvironment();

function testPaths(directory, match, recursive = false) {
  return readdirSync(directory, { recursive, withFileTypes: true })
    .filter((entry) => entry.isFile() && match(entry.name))
    .map((entry) => relative(root, resolve(entry.parentPath ?? directory, entry.name)))
    .sort();
}

const hostTests = testPaths(resolve(root, "tests"), (name) => name.endsWith(".test.mjs") && !name.startsWith("bot"));
const geoTests = testPaths(standalone, (name) => name.endsWith(".test.mjs"));
const mediaTests = testPaths(video, (name) => name.endsWith(".test.mjs"), true);
const coverFixture = "engines/video-edit/bundles/ai-video/connectors/cover-kb-bridge/core.test.ts";
const coverCorpusIsAvailable = existsSync(resolve(video, "bundles/ai-video/library/cover-kb/_INDEX.md")) &&
  existsSync(resolve(video, "bundles/ai-video/library/account-profiles/chen-zhuo.yml"));
const mediaTypeScript = testPaths(video, (name) => name.endsWith(".test.ts"), true).filter(
  (file) => file !== coverFixture || coverCorpusIsAvailable,
);
if (!coverCorpusIsAvailable) console.log("Omitted the native cover-corpus suite, which requires external corpus and account fixtures.");
const batches = [
  { label: "host and GEO", tests: [...hostTests, ...geoTests], args: ["--test", "--test-concurrency=2", "--test-timeout=60000"] },
  { label: "media modules", tests: mediaTests, args: ["--test", "--test-concurrency=1", "--test-timeout=120000"] },
  { label: "media TypeScript", timeout: 20 * 60_000, tests: mediaTypeScript, args: ["node_modules/vitest/vitest.mjs", "run", "--maxWorkers=1", "--minWorkers=1", "--no-file-parallelism"] },
];

for (const batch of batches) {
  if (!batch.tests.length) {
    console.error(`No test files found for ${batch.label}.`);
    process.exitCode = 1;
    continue;
  }
  console.log(`Inherited ${batch.label} profile: ${batch.tests.length} test files.`);
  const result = spawnSync(process.execPath, [...batch.args, ...batch.tests], {
    cwd: root, env: cleanEnvironment, stdio: "inherit", timeout: batch.timeout ?? 300_000,
  });
  if (result.error) console.error(`Inherited ${batch.label} runner failed: ${result.error.code ?? "runner error"}.`);
  if (result.signal) console.error(`Inherited ${batch.label} runner stopped: ${result.signal}.`);
  if (result.status !== 0) process.exitCode = 1;
}
