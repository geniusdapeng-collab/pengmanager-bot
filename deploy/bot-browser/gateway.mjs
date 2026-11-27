import { WebSocketServer } from "ws";
import { createBotBrowserGateway } from "../../src/bot/browser-gateway.mjs";

const server = createBotBrowserGateway({
  WebSocketServer,
  publicOrigin: process.env.BOT_BROWSER_PUBLIC_ORIGIN,
  authorityOrigin: process.env.BOT_BROWSER_AUTHORITY_ORIGIN,
  gatewaySecret: process.env.BOT_BROWSER_GATEWAY_SECRET,
  targetId: process.env.BOT_BROWSER_TARGET_ID,
  vncSocketPath: process.env.BOT_BROWSER_VNC_SOCKET || undefined,
  novncRoot: process.env.BOT_BROWSER_NOVNC_ROOT || undefined,
});

const port = Number(process.env.BOT_BROWSER_GATEWAY_PORT || 18760);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new TypeError("Invalid browser gateway port.");
server.listen(port, "127.0.0.1", () => process.stdout.write("Browser gateway listening on loopback.\n"));

function stop() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
