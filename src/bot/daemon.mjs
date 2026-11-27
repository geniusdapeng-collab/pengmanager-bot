import { randomUUID } from "node:crypto";
import { runBotStep } from "./operations.mjs";
import { identifySourceCandidate } from "./sources.mjs";

async function readReceiverReceipt(response) {
  if (!response.body) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8192) return null;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createNotificationDelivery({ core, ctx, mode, url, token, fetchImpl = fetch, clock = Date.now }) {
  const attempts = new Map();
  const target = url ? new URL(url) : null;
  if (target && (target.protocol !== "https:" || target.username || target.password || target.hash || target.search)) {
    throw new Error("Configure a dedicated HTTPS owner notification receiver.");
  }
  return async () => {
    if (!target || mode !== "real") return;
    const due = core.listNotifications(ctx).filter(n => ["pending","failed"].includes(n.state) &&
      (attempts.get(n.id)?.at ?? 0) <= clock()).sort((left, right) =>
      (left.severity === "urgent" ? 0 : 1) - (right.severity === "urgent" ? 0 : 1) ||
      (left.periodEnd ?? left.createdAt) - (right.periodEnd ?? right.createdAt)).slice(0, 10);
    for (const notice of due) {
      const previous = attempts.get(notice.id)?.n || 0;
      try {
        const response = await fetchImpl(target, { method: "POST", redirect: "error", signal: AbortSignal.timeout(6000),
          headers: { "Content-Type": "application/json", "Idempotency-Key": notice.id,
            ...(token ? { Authorization: "Bearer " + token } : {}) },
          body: JSON.stringify({ id: notice.id, type: notice.kind, mandateId: notice.mandateId, taskIds: notice.taskIds,
            summary: notice.summary, createdAt: notice.createdAt, rootCause: notice.rootCause,
            ...(notice.reportId ? { reportId: notice.reportId, periodStart: notice.periodStart, periodEnd: notice.periodEnd,
              terminalReason: notice.terminalReason } : {}) }) });
        if (!response.ok) throw new Error("Receiver declined notification.");
        const body = await readReceiverReceipt(response);
        if (body?.id !== notice.id || typeof body.receiptId !== "string" || !body.receiptId.trim() || body.receiptId.length > 500) {
          throw new Error("Receiver did not acknowledge this notification.");
        }
        core.ackNotification({ id: notice.id, status: "delivered", receiptRef: body.receiptId }, ctx);
        attempts.delete(notice.id);
      } catch {
        attempts.set(notice.id, { n: previous + 1, at: clock() + Math.min(6 * 3600000, 30000 * 2 ** Math.min(previous, 10)) });
        core.ackNotification({ id: notice.id, status: "failed", errorCode: "receiver_ack_missing" }, ctx);
      }
    }
  };
}

export function createDaemon({ core, operations, sources, ctx, meter, notify, tickMs = 2500, logger = console, runStep = runBotStep }) {
  const suffix = randomUUID().slice(0, 8);
  const actors = ["worker", "reviewer", "connector"].map(role => ({ ...ctx, role, actorId: role + "-" + suffix }));
  const running = new Map();
  let timer;
  let closing = false;
  let lastTick = 0;
  function launch(key, work) {
    if (closing || running.has(key)) return;
    const result = Promise.resolve().then(work).catch(error => {
      logger.error?.("BOT work paused", key, /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "WORK_UNAVAILABLE");
    }).finally(() => running.delete(key));
    running.set(key, result);
  }
  async function work(actor) {
    const step = core.claim({ leaseMs: 90000 }, actor);
    if (!step) return;
    const renew = setInterval(() => {
      try { core.heartbeat({ id: step.id, epoch: step.epoch, leaseMs: 90000 }, actor); }
      catch { clearInterval(renew); }
    }, 20000);
    try { await meter.run(step, actor, () => runStep(core, operations, step, actor)); }
    finally { clearInterval(renew); }
  }
  function pulse() {
    if (closing) return;
    launch("schedule", () => { core.tick(ctx); lastTick = Date.now(); });
    launch("sources", sources.poll);
    launch("notify", notify);
    for (const actor of actors) launch(actor.role, () => work(actor));
  }
  return {
    health() { return { ready: !closing && lastTick > 0 && Date.now() - lastTick <= Math.max(15000, 4*tickMs), lastTick }; },
    start() { if (!timer && !closing) { pulse(); timer = setInterval(pulse, tickMs); } },
    async drainOnce() { pulse(); await Promise.all([...running.values()]); },
    async stop() { closing = true; clearInterval(timer); await Promise.all([...running.values()]); },
  };
}

export function registrationFromFeeds({ sources, app, approval }) {
  return async ({ task, material, runReview }) => {
    const c = sources.candidate(task);
    const identity = identifySourceCandidate(c);
    if (!identity || !c.text || !c.sourceExcerpt || c.sourceUrl !== material.sourceUrl) return null;
    const { id, sourceDigest } = identity;
    const candidate = { id, text: c.text, type: "project", state: "draft", publicLevel: "private",
      source: { url: c.sourceUrl, label: c.sourceLabel, visibility: "public" },
      evidenceLevel: "B", sensitivity: "low", expiresAt: null };
    if (!app.store.snapshot(["claims"]).claims.some(row => row.id === id)) {
      await app.store.mutate({ type: "bot.source_candidate_recorded", actor: "bot-source-reader", payload: { id, sourceDigest }, includeState: false }, state => {
        if (!state.claims.some(row => row.id === id)) state.claims.push(candidate);
      });
    }
    const review = {
      review: input => runReview(input, request => approval.review(request ?? input)),
    };
    const row = await app.service.approveClaim(id, { publicLevel: "approved_public", sourceExcerpt: c.sourceExcerpt },
      { actor: "bot-independent-fact-review", aiApproval: review });
    if (row.state !== "approved" || !row.aiReview) return null;
    return { claimId: id, sourceUrl: c.sourceUrl, sourceDigest };
  };
}
