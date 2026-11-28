import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createBotCore } from "./core.mjs";
import { createBotOperations, createDevConnector, loadOperationsCatalog } from "./operations.mjs";
import { createBotBrowserService } from "./browser-service.mjs";
import { browserTaskAuthorizes, configuredBrowserTargets, deriveNativeCapability, inspectNative, readTaskIllustrations } from "./admin.mjs";
import { createSources } from "./sources.mjs";
import { loadSettings } from "./settings.mjs";
import { createMeter } from "./meter.mjs";
import { createDaemon, createNotificationDelivery, registrationFromFeeds } from "./daemon.mjs";
import { openIntentJournal, privateDirectory, putRecord, readRecord } from "./files.mjs";
import { createBotHttp } from "./http.mjs";
import { createPengManagerApplication } from "../application.mjs";
import { hashAdminPassword } from "../security/admin-auth.mjs";
import { DeepSeekAdapter } from "../adapters/deepseek.mjs";
import { ContentDirectorModel } from "../services/content-director-model.mjs";
import { truncatedNativeRevision } from "./draft-continuation.mjs";
import { createAiApproval } from "../services/ai-approval.mjs";
import { publicEditorialClaim } from "../domain/editorial.mjs";
import { DEEPSEEK_OFFICIAL_BASE_URL, TEXT_PRIMARY_MODEL } from "../model-routing/registry.mjs";

export async function createBotHost({ env = process.env, settings = loadSettings(env), logger = console } = {}) {
  const { ctx, origin, port, dataDir, mode } = settings;
  const real = mode === "real";
  const sys = { ...ctx, role: "system", actorId: "scheduler" };
  const site = new URL(origin);
  const dataModePath = join(dataDir, "runtime-data-mode.json");
  const identity = readRecord(dataModePath);
  if (identity && (identity.schema !== "pengmanager.bot.workspace-mode/v1" || identity.mode !== mode)) {
    throw new Error("The native workspace belongs to a different BOT data mode.");
  }
  if (!identity && existsSync(join(dataDir, "native.json")) && !existsSync(join(dataDir, "bot.sqlite"))) {
    throw new Error("Restore the original BOT data-mode marker together with the native state.");
  }
  let passwordHash = env.BOT_OWNER_PASSWORD_HASH;
  if (!passwordHash && real) throw new Error("Configure BOT_OWNER_PASSWORD_HASH before starting real mode.");
  // A private randomly generated local login survives restarts and stays out of stdout.
  if (!passwordHash) {
    const login = readRecord(join(dataDir, "local-login.json")) ?? putRecord(dataDir, "local-login", { password: randomBytes(24).toString("base64url") });
    passwordHash = await hashAdminPassword(login.password);
  }
  const journal = real ? openIntentJournal(env.BOT_JOURNAL_DIR || settings.journalDir, { primaryDirectory: dataDir }) : null;
  const catalog = loadOperationsCatalog();
  let checkGeo = () => ({ ready: false });
  let app, daemon, server, stopOnce, meter;
  const readProviderReceipt = id => readRecord(join(dataDir, "provider-receipts", id + ".json"));
  const core = createBotCore({ dbPath: join(dataDir, "bot.sqlite"), channels: catalog, mode, journal,
    readProviderReceipt,
    readTruncatedRevision: id => truncatedNativeRevision(app?.store.snapshot(["contentDirectorJobs", "contentDirectorSteps"]), id),
    providerQuotaFingerprint: id => settings.taskProviderQuota?.taskIds.includes(id) ? meter?.quotaFingerprint : null,
    recoveryMode: env.BOT_RECOVERY === "1", geoPreflight: scope => checkGeo(scope) });
  try {
    const frozen = putRecord(dataDir, "runtime-data-mode", { schema: "pengmanager.bot.workspace-mode/v1", mode });
    if (frozen.schema !== "pengmanager.bot.workspace-mode/v1" || frozen.mode !== mode) {
      throw new Error("The original workspace data mode changed before startup.");
    }
    const modelEndpoint = settings.modelEndpoint || DEEPSEEK_OFFICIAL_BASE_URL;
    meter = createMeter({ core, dataDir, pricing: settings.pricing, endpoint: modelEndpoint, mode,
      taskQuota: settings.taskProviderQuota });
    const apiKey = real ? env.BOT_MODEL_KEY : null;
    const client = new DeepSeekAdapter({ apiKey: apiKey || "unconfigured", baseUrl: modelEndpoint, fetchImpl: meter.fetch,
      taskOutputCap: meter.maxOutputTokens, maxRetries: 0 });
    const approvalDir = privateDirectory(join(dataDir, "bot-review"));
    if (existsSync(join(approvalDir, "reviewer-public-key.json"))) throw new Error("Use a separate directory for external reviewer jobs with separate billing.");
    const approval = createAiApproval({ directory: approvalDir, origin, model: real && apiKey && meter.ready ? client : undefined });
    const nativeEnv = { HOST: "127.0.0.1", PORT: String(port), ALLOWED_HOSTS: site.hostname,
      ADMIN_PASSWORD_HASH: passwordHash, PUBLIC_WEBSITE: "1", ENABLE_MEDIA_RENDER: "false", ENABLE_CONTENT_DIRECTOR: "true",
      DATA_FILE: join(dataDir, "native.json"), GEO_ENGINE_DB: join(dataDir, "geo.sqlite"),
      DEEPSEEK_BASE_URL: modelEndpoint, DEEPSEEK_API_KEY: apiKey || "unconfigured",
      ...(site.protocol === "https:" ? { PUBLIC_ORIGIN: origin, NODE_ENV: "production" } : {}) };
    app = await createPengManagerApplication({ env: nativeEnv, aiApproval: approval,
      geoFetch: meter.fetch, contentModel: new ContentDirectorModel({ deepSeek: client }), finalContentBackup: null, logger });
    const sources = createSources({ dataDir, core, ctx: sys, sources: settings.sources, mode });
    const dev = real && settings.dev ? createDevConnector({ ...settings.dev, mode, apiKey: env.BOT_DEV_API_KEY }) : null;
    const operations = createBotOperations({ nativeApp: app, mode, catalog, dev, sourceInbox: sources.inbox,
      illustrationInbox: privateDirectory(join(dataDir, "illustrations")), modelReady: Boolean(apiKey && meter.ready),
      geoDeploymentProfile: settings.geoProfile, geoConfigured: Boolean(apiKey && meter.ready), registerCandidate: registrationFromFeeds({ sources, app, approval }), perRequestMetering: true });
    checkGeo = ({ provider, queryIds, currency }) => {
      const pricing = settings.pricing;
      if (!operations.geo.ready || pricing?.currency !== currency) return { ready: false };
      const original = new Map(app.geoEngine.listQueries({ limit: 2000 }).map(row => [row.id, row.text]));
      if (!queryIds.every(id => typeof original.get(id) === "string" && original.get(id).trim())) return { ready: false };
      const search = provider === "deepseek-search" ? pricing.searchPerRequest : 0;
      if (!Number.isSafeInteger(search) || search < (provider === "deepseek-search" ? 1 : 0)) return { ready: false };
      const tokenBound = Math.ceil((TEXT_PRIMARY_MODEL.contextTokens * pricing.inputPerMillion +
        TEXT_PRIMARY_MODEL.maxOutputTokens * pricing.outputPerMillion) / 1_000_000);
      return { ready: true, minimumMinor: queryIds.length * (Math.max(1, tokenBound) + search) };
    };
    let handler;
    const browserTargets = real ? configuredBrowserTargets(settings) : [];
    const browserById = new Map(browserTargets.map(target => [target.id, target]));
    const browser = createBotBrowserService({ dataDir, sessionTargets: browserTargets,
      onViewerConnected: ({ targetId, taskId, leaseId }) =>
        core.recordBrowserHandoff({ taskId, channelId: browserById.get(targetId).channelId, leaseId }, ctx),
      gatewaySecret: env.BOT_BROWSER_KEY, gatewayControlUrl: settings.browserControlUrl, isSessionActive: id => handler?.isSessionActive(id) === true,
      canUseTarget(target) {
        return Boolean(browserTaskAuthorizes(core, ctx, { ...target, channelId: browserById.get(target.id)?.channelId })?.channel);
      },
    });
    handler = createBotHttp({ core, operations, browser, sources, ctx, ownerPasswordHash: passwordHash, origin,
      ...(real ? { validateCapability: input => deriveNativeCapability({ app, ctx, settings }, input) } : {}),
      describeOnboarding() {
        const { accounts } = inspectNative(app);
        const now = new Date();
        const facts = app.store.snapshot(["claims"]).claims.map(claim => publicEditorialClaim(claim, { now }))
          .filter(claim => claim?.source.url.startsWith("https://"));
        return { modelReady: operations.modelReady,
          accounts: accounts.map(({ id, platformId, usable }) => ({ id, platformId, usable })),
          facts: facts.slice(-100).reverse().map(claim => ({ id: claim.id, label: claim.text.slice(0, 160) })),
          content: { verifiedClaims: facts.length, stories: app.editorial.listStories().items.length,
            verifiedPublicReleases: app.editorial.listReleases().items.filter(row => row.status === 'published' && row.receipt).length } };
      },
      readProviderReceipt,
      readReviewedRevision: (jobId, source) => app.contentDirector.readReviewedRevisionPreview(jobId, source),
      readIllustrations: task => readTaskIllustrations(app, task) });
    server = createServer(async (req, res) => {
      try {
        if (await handler(req, res)) return;
        const url = new URL(req.url, origin);
        if (req.headers.host !== site.host) { res.writeHead(421).end(); return; }
        if (url.pathname === "/healthz" && ["GET","HEAD"].includes(req.method)) {
          const ready = daemon?.health().ready && core.health(sys).ready;
          res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(req.method === "HEAD" ? undefined : JSON.stringify({ service: "pengmanager-bot", ready: Boolean(ready),
            taskProviderQuotaFingerprint: meter.quotaFingerprint })); return;
        }
        if (url.pathname === "/" && ["GET","HEAD"].includes(req.method)) { res.writeHead(302, { Location: "/bot/" }).end(); return; }
        if (["GET","HEAD"].includes(req.method) && (/^\/(?:zh|en)(?:\/|$)/.test(url.pathname) ||
          /^\/(?:public-api\/content|public-media)(?:\/|$)/.test(url.pathname) ||
          ["/public-api/profile","/site.css","/site.js","/publication-view.js","/favicon.svg","/robots.txt","/styles.css","/about"].includes(url.pathname))) {
          app.server.emit("request", req, res);
          return;
        }
        res.writeHead(404).end();
      } catch (error) {
        logger.error?.("BOT request failed", /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "HTTP_ERROR");
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    const notify = createNotificationDelivery({ core, ctx: sys, mode, url: settings.notificationUrl, token: env.BOT_NOTIFICATION_KEY });
    daemon = createDaemon({ core, operations, sources, ctx: sys, meter, notify, logger });
    return {
      core, app, daemon, sources, operations, server, browser, ctx, sys, settings, meter, approval,
      async start() {
        await new Promise((done, reject) => { server.once("error", reject); server.listen(port, settings.host, () => { server.off("error", reject); done(); }); });
        daemon.start();
        logger.log?.("鹏经理 BOT · " + mode + " · " + origin + "/bot/");
        if (!env.BOT_OWNER_PASSWORD_HASH) logger.log?.("本机演练登录密码见 " + join(dataDir, "local-login.json"));
      },
      stop() {
        return stopOnce ??= (async () => {
          const closed = server.listening ? new Promise(done => {
            const deadline = setTimeout(() => server.closeAllConnections(), 5000);
            deadline.unref();
            server.close(() => { clearTimeout(deadline); done(); });
            server.closeIdleConnections();
          }) : Promise.resolve();
          await daemon.stop(); await closed;
          try { await app.stop(); } finally { core.close(); }
        })();
      },
    };
  } catch (error) {
    try { if (app) await app.stop(); } finally { core.close(); }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let host;
  try {
    host = await createBotHost();
    await host.start();
    const shutdown = () => { host.stop().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error("BOT startup failed:", error.code || error.message);
    if (host) await host.stop();
    process.exitCode = 1;
  }
}
