import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const loopback = "127.0.0.1";
const ownFile = fileURLToPath(import.meta.url);
export const demoSeedDirectory = fileURLToPath(new URL("../data/demo/seed", import.meta.url));

function demoPort(value) {
  const port = Number(value ?? "4318");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PENGMANAGER_DEMO_PORT 必须是 1 至 65535 之间的整数。");
  }
  return String(port);
}

export function demoEnvironment(directory, { port, passwordHash } = {}) {
  return {
    HOST: loopback,
    PORT: demoPort(port),
    ALLOWED_HOSTS: "127.0.0.1,localhost",
    DATA_FILE: join(directory, "state.json"),
    GEO_ENGINE_DB: join(directory, "geo.sqlite"),
    PENGMANAGER_VIDEO_DATA_DIR: join(directory, "video-runtime"),
    ENABLE_MEDIA_RENDER: "false",
    ENABLE_CONTENT_DIRECTOR: "false",
    PUBLIC_WEBSITE: "1",
    LLM_PROVIDER: "mock",
    ...(passwordHash ? { ADMIN_PASSWORD_HASH: passwordHash } : {}),
  };
}

function allowDemoLoopback(value) {
  const input = new URL(value instanceof Request ? value.url : value);
  return input.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(input.hostname);
}

async function serve() {
  const fetchLocally = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!allowDemoLoopback(url)) throw new Error("DEMO_EXTERNAL_REQUEST_DISABLED");
    return fetchLocally(url, { ...init, redirect: "error" });
  };
  const { createPengManagerApplication } = await import(new URL("../src/application.mjs", import.meta.url));
  const application = await createPengManagerApplication({ seedDirectory: demoSeedDirectory, finalContentBackup: null });
  try {
    await application.listen();
    console.log(`本地演示 · http://${loopback}:${process.env.PORT}/zh · 管理后台 /admin · 退出时清除演示数据`);
  } catch (error) {
    await application.stop();
    throw error;
  }
  const close = () => {
    void application.stop().catch(() => {
      console.error("本地演示未能完整停止。");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

async function launch() {
  const port = demoPort(process.env.PENGMANAGER_DEMO_PORT);
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pengmanager-demo-"));
  try {
    const inheritable = ["PATH", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"];
    const platform = Object.fromEntries(inheritable
      .filter(key => process.env[key] !== undefined)
      .map(key => [key, process.env[key]]));
    const child = spawn(process.execPath, [ownFile, "--serve-demo"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...platform,
        ...demoEnvironment(directory, { port, passwordHash: process.env.ADMIN_PASSWORD_HASH }),
        TMPDIR: directory,
      },
      stdio: "inherit",
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      process.exitCode = result.code ?? (["SIGINT", "SIGTERM"].includes(result.signal) ? 0 : 1);
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === ownFile) {
  try {
    if (process.argv[2] === "--serve-demo") {
      if (process.env.HOST !== loopback || process.env.ENABLE_MEDIA_RENDER !== "false" ||
          !process.env.DATA_FILE || !process.env.GEO_ENGINE_DB) throw new Error("DEMO_ENVIRONMENT_REQUIRED");
      await serve();
    } else {
      await launch();
    }
  } catch (error) {
    console.error(`鹏经理本地演示启动失败（${error.code || error.name || "DEMO_START_FAILED"}）。`);
    process.exitCode = 1;
  }
}
