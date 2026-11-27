import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBotCore } from "../src/bot/core.mjs";
import { DAY } from "../src/bot/core-store.mjs";
import { createBotHost } from "../src/bot/host.mjs";
import { digest, openIntentJournal, putRecord } from "../src/bot/files.mjs";
import { createMeter } from "../src/bot/meter.mjs";
import { createCadenceTrials } from "../src/bot/learning.mjs";
import { deliveryScorecard } from "../src/bot/scorecard.mjs";
import { loadSettings } from "../src/bot/settings.mjs";
import { createSources, identifySourceCandidate } from "../src/bot/sources.mjs";

function dir(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pm-bot-boundaries-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("public-fact consent binds the registered source, rejects credential-shaped links, and detects new same-title evidence", async t => {
  let now = 2000;
  let version = 1;
  let fetchCount = 0;
  const accepted = [];
  const app = createSources({ dataDir: dir(t), ctx: {}, mode: "real", clock: () => now,
    core: {
      listMandates: () => [{ id: "m", revision: 1, state: "active", expiresAt: 125000, trustScope: { sources: ["feed"] } }],
      ingestEvent: event => accepted.push(event),
    },
    sources: [{ id: "feed", format: "json-feed", intervalMs: 60000, url: "https://primary.example.test/feed",
      allowPublicFacts: true, itemOrigins: ["https://docs.example.test"] }],
    async fetchImpl() {
      fetchCount++;
      return Response.json({ items: [
        { id: "approved", url: "https://docs.example.test/reference", title: "Same stable title",
          content_text: `The documented interval is now revision ${version} and this original boundary changes.` },
        { id: "unapproved", url: "https://other.example.test/reference", title: "Related secondary coverage",
          content_text: "This other origin is a clue without public-fact authority." },
        { id: "credential", url: "https://www.sqlite.org/index.html?api_key=placeholder", title: "Credential-bearing link" },
      ] });
    } });
  await app.poll();
  const original = app.candidate({ input: accepted.find(row => row.title === "Same stable title") });
  const secondary = accepted.find(row => row.title === "Related secondary coverage");
  assert.ok(original);
  assert.equal(app.candidate({ input: secondary }), null);
  assert.equal(accepted.some(row => row.title === "Credential-bearing link"), false);
  version = 2;
  now += 60001;
  await app.poll();
  const revised = app.candidate({ input: accepted.filter(row => row.title === "Same stable title").at(-1) });
  assert.notEqual(identifySourceCandidate(original).sourceDigest, identifySourceCandidate(revised).sourceDigest);
  assert.match(revised.text, /revision 2/u);
  now = 200000;
  await app.poll();
  assert.equal(fetchCount, 2);
});

test("a source revoked during one feed read cannot accept its returned items or dispatch the next feed read", async t => {
  let active = true;
  const calls = [];
  const app = createSources({ dataDir: dir(t), ctx: {}, mode: "real", clock: () => 100,
    core: { listMandates: () => [{ id: "m", revision: 1, state: active ? "active" : "revoked", trustScope: { sources: ["one", "two"] } }],
      ingestEvent: () => assert.fail("Revoked source accepted an event.") },
    sources: ["one", "two"].map(id => ({ id, format: "json-feed", url: `https://${id}.example.test/feed` })),
    async fetchImpl(url) {
      calls.push(url);
      active = false;
      return Response.json({ items: [{ id: "new", url: "https://one.example.test/new", title: "Revoked object" }] });
    } });
  await app.poll();
  assert.deepEqual(calls, ["https://one.example.test/feed"]);
});

test("a paid request cannot cross an out-of-scope path, stream, or changed price or receipt on retry", async t => {
  const dataDir = dir(t);
  const journal = openIntentJournal(dir(t), { primaryDirectory: dataDir, requireSeparateVolume: false });
  const core = createBotCore({ mode: "real", journal });
  t.after(() => core.close());
  const owner = { actorId: "owner", role: "owner", workspaceId: "test", projectId: "budget" };
  const worker = { ...owner, actorId: "worker", role: "worker" };
  const m = core.createMandate({ objective: "Exercise exact priced call", idempotencyKey: "tariff-mandate",
    budget: { currency: "CNY", limitMinor: 3000 } }, owner);
  core.createTask({ mandateId: m.id, title: "Metered isolated request", idempotencyKey: "tariff-task" }, owner);
  const step = core.claim({ kinds: ["discover"] }, worker);
  const endpoint = "https://model.example.test/v1";
  const pricing = { currency: "CNY", reference: "owner-tariff-a", inputPerMillion: 1000, cacheHitPerMillion: 500, outputPerMillion: 2000 };
  let actualCalls = 0;
  function start(price) {
    return createMeter({ core, dataDir, endpoint, pricing: price, mode: "real",
      async fetchImpl() {
        actualCalls++;
        return Response.json({ id: "isolated-provider-request", model: "deepseek-flash", usage: {
          prompt_tokens: 7000, prompt_cache_hit_tokens: 2000, completion_tokens: 200 } });
      } });
  }
  const meter = start(pricing);
  const request = (service, url = endpoint + "/chat/completions", extra = {}) => service.run(step, worker,
    () => service.fetch(url, { method: "POST", body: JSON.stringify({ model: "deepseek-flash", max_tokens: 400, ...extra }) }));
  await assert.rejects(request(meter, endpoint + "/unpriced/chat/completions"), { code: "PROVIDER_SCOPE_DENIED" });
  await assert.rejects(request(meter, undefined, { stream: true }), { code: "PROVIDER_REQUEST_INVALID" });
  assert.equal(core.listCosts(worker).length, 0);
  assert.equal((await request(meter)).status, 200);
  const cost = core.listCosts(worker)[0];
  assert.equal(cost.state, "settled");
  await assert.rejects(request(start({ ...pricing, reference: "owner-tariff-b" })), { code: "COST_IDEMPOTENCY_CONFLICT" });
  const filename = join(dataDir, "provider-receipts", cost.id + ".json");
  const previous = JSON.parse(readFileSync(filename, "utf8"));
  writeFileSync(filename, JSON.stringify({ ...previous, actualMinor: 0 }));
  await assert.rejects(request(meter), { code: "PROVIDER_RECEIPT_CHANGED" });
  assert.equal(actualCalls, 1);
});

test("fixture needs an exact loopback listener, and a persisted native mode marker prevents crossover", async t => {
  const root = dir(t);
  assert.throws(() => loadSettings({ BOT_DATA_DIR: root, HOST: "0.0.0.0", BOT_ORIGIN: "https://site.example.test" }), /loopback/u);
  assert.throws(() => loadSettings({ BOT_DATA_DIR: root, PORT: "4321", BOT_ORIGIN: "http://127.0.0.1:4322" }), /exact loopback/u);
  putRecord(root, "runtime-data-mode", { schema: "pengmanager.bot.workspace-mode/v1", mode: "real" });
  await assert.rejects(createBotHost({ env: { BOT_DATA_DIR: root } }), /different BOT data mode/u);
});

test("intent ledger reads refuse symlink namespaces and cannot borrow another mounted scope", t => {
  const volume = dir(t);
  const journal = openIntentJournal(volume, { primaryDirectory: dir(t), requireSeparateVolume: false });
  const elsewhere = dir(t);
  putRecord(elsewhere, digest("known-key"), { key: "known-key", at: 1 });
  symlinkSync(elsewhere, join(volume, digest("victim")), "dir");
  assert.throws(() => journal.get({ scope: "victim", key: "known-key" }), /canonical/u);
  assert.throws(() => journal.list({ scope: "victim" }), /canonical/u);
});

test("a deadline on a weekly boundary is counted once", () => {
  const task = { id: "exact-boundary", deadline_at: 20, commitments: JSON.stringify([{ id: "delivery", outcome: "result" }]) };
  const input = { tasks: [task], events: [], effects: [], observations: [], mode: "real" };
  assert.equal(deliveryScorecard({ ...input, start: 10, end: 20 }).due, 1);
  assert.equal(deliveryScorecard({ ...input, start: 20, end: 30 }).due, 0);
});

test("cadence trials stay off critical feeds and ignore measurements from before treatment exposure", t => {
  const origin = Date.UTC(2026, 10, 1);
  let clock = origin;
  const sources = new Map([["test", { id: "test", allowCadenceTrial: true }], ["control", { id: "control" }]]);
  const mandate = { id: "m", revision: 1, state: "active", requiredOutcomes: [{ outcome: "public" }],
    trustScope: { sources: ["test", "control"], learning: { sourceId: "test", controlSourceId: "control", minPairs: 5 } } };
  const sample = (sourceId, observedAt, citations, acceptedAt) => ({
    id: sourceId + observedAt, sourceId, observedAt, acceptedAt, day: 7, dataMode: "real",
    surface: "same", provider: "same", questionRevision: "same", evidenceRef: sourceId + observedAt, planned: 5,
    comparison: { status: "verified", paired: 5, citations },
    observations: Array.from({ length: 5 }, (_, i) => ({ queryId: "q" + i, queryHash: "hash-" + i, model: "same" })),
  });
  const rows = [sample("test", origin-DAY, 0, origin-10*DAY), sample("control", origin-DAY, 1, origin-10*DAY)];
  const core = {
    listCosts: () => [],
    listTasks: () => rows.map(r => ({ id: r.id, createdAt: r.acceptedAt, input: { sourceId: r.sourceId } })),
    getTask: id => {
      const r = rows.find(row => row.id === id);
      return { observations: [{ id, basePublicationAt: r.observedAt-7*DAY }],
        steps: [{ kind: "observe", input: { day: 7, observationId: id }, output: r }] };
    },
  };
  const trial = createCadenceTrials({ core, ctx: {}, dataDir: dir(t), mode: "real", clock: () => clock });
  trial.refresh([mandate], sources);
  assert.equal(trial.forSource("test").stage, "baseline");
  trial.refresh([{ ...mandate, revision: 2, requiredOutcomes: [] }], sources);
  assert.equal(trial.forSource("test").stage, "trial");
  clock += 14 * DAY;
  rows.push(sample("test", clock-1, 5, origin-1), sample("control", clock-1, 1, origin+1));
  trial.refresh([{ ...mandate, revision: 2, requiredOutcomes: [] }], sources);
  assert.equal(trial.forSource("test").stage, "rollback");
  assert.equal(trial.forSource("test").factor, 1);
});
