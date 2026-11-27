import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTestEnvironment() {
  const inherited = Object.entries(process.env).filter(([name]) =>
    /^(?:PATH|Path|TMPDIR|TEMP|TMP|LANG|LC_.+|SYSTEMROOT|SystemRoot|WINDIR|CI|TERM)$/u.test(name));
  const cache = mkdtempSync(join(tmpdir(), "pengmanager-test-cache-"));
  process.once("exit", () => rmSync(cache, { recursive: true, force: true }));
  return { ...Object.fromEntries(inherited), NODE_ENV: "test", XDG_CACHE_HOME: cache };
}
