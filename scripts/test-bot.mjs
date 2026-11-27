import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const cwd = resolve(import.meta.dirname, "..");
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(?:PATH|Path|TMPDIR|TEMP|TMP|LANG|LC_.+|SYSTEMROOT|SystemRoot|WINDIR|CI|TERM)$/.test(name)));
environment.NODE_ENV = "test";
function run(label, args) {
  process.stdout.write("\n" + label + "\n");
  const p = spawnSync(process.execPath, args, { cwd, env: environment, stdio: "inherit" });
  if (p.error) throw p.error;
  if (p.status !== 0) process.exit(p.status ?? 1);
}
const tests = readdirSync(resolve(cwd,"tests")).filter(name=>name.startsWith("bot-") && name.endsWith(".test.mjs")).sort();
if (!tests.length) throw new Error("No BOT tests found.");
run("PengManager BOT", ["--test","--test-concurrency=1", ...tests.map(name=>"tests/"+name)]);
run("Native regression suite", ["scripts/test-inherited.mjs"]);
run("Public export checks", ["scripts/public-audit.mjs"]);
