import { readFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { privateDirectory } from "./files.mjs";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function loadSettings(env = process.env) {
  let file = {};
  if (env.BOT_CONFIG) {
    const path = resolve(env.BOT_CONFIG);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 262144 || stat.mode & 0o022 ||
        (process.getuid && ![0, process.getuid()].includes(stat.uid))) {
      throw new Error("BOT_CONFIG must be a bounded, owner-controlled JSON file.");
    }
    file = JSON.parse(readFileSync(path, "utf8"));
  }
  const mode = env.BOT_MODE ?? file.mode ?? "fixture";
  if (!["real", "fixture"].includes(mode)) throw new Error("BOT_MODE must be real or fixture.");
  const port = Number(env.PORT ?? file.port ?? 4320);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  const host = env.HOST ?? file.host ?? "127.0.0.1";
  const origin = new URL(env.BOT_ORIGIN || file.origin || ("http://127.0.0.1:" + port));
  if (origin.href !== origin.origin + "/" || origin.username || origin.password ||
      !["https:", "http:"].includes(origin.protocol) || origin.protocol === "http:" &&
        !LOOPBACK.has(origin.hostname) || mode === "real" && origin.protocol !== "https:") {
    throw new Error("Use an exact HTTPS origin for production, or loopback HTTP for a local fixture.");
  }
  if (mode === "fixture" && (!LOOPBACK.has(host) || !LOOPBACK.has(origin.hostname) || origin.protocol !== "http:" ||
      Number(origin.port || 80) !== port)) throw new Error("A fixture must use its exact loopback HTTP listener.");
  const dataDir = privateDirectory(resolve(env.BOT_DATA_DIR || file.dataDir || ("var/bot-" + mode)));
  const ctx = { workspaceId: file.workspaceId || "personal", projectId: file.projectId || "editorial", actorId: file.ownerId || "owner", role: "owner" };
  return { ...file, mode, port, host, origin: origin.origin, dataDir, ctx };
}
