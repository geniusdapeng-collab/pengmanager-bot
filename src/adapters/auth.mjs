import { spawnSync } from "node:child_process";
import { platform } from "node:os";

export function resolveDeepSeekApiKey(env = process.env) {
  const direct = env.LLM_API_KEY?.trim() || env.DEEPSEEK_API_KEY?.trim();
  if (direct) {
    return direct;
  }

  if (env.DEEPSEEK_AUTH_COMMAND) {
    const command = spawnSync(env.DEEPSEEK_AUTH_COMMAND, {
      shell: true,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const value = command.stdout?.trim();
    if (command.status === 0 && value) {
      return value;
    }
    throw new Error("DEEPSEEK_AUTH_COMMAND 未返回可用凭据。");
  }

  const account = env.DEEPSEEK_KEYCHAIN_ACCOUNT?.trim();
  const service = env.DEEPSEEK_KEYCHAIN_SERVICE?.trim();
  if (platform() === "darwin" && account && service) {
    const command = spawnSync(
      "security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const value = command.stdout?.trim();
    if (command.status === 0 && value) {
      return value;
    }
  }

  throw new Error(
    "缺少 DeepSeek 凭据。配置进程密钥、显式授权命令，或同时指定 macOS 钥匙串账号和服务。",
  );
}
