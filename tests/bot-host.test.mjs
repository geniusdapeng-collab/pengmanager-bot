import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { createBotHost } from "../src/bot/host.mjs";
import { createMeter } from "../src/bot/meter.mjs";
import { createNotificationDelivery } from "../src/bot/daemon.mjs";
import { createSources } from "../src/bot/sources.mjs";
import { openIntentJournal } from "../src/bot/files.mjs";
import { loadSettings } from "../src/bot/settings.mjs";

function dir(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pengmanager-bot-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("clean host serves the owner app, persists a task, and exposes the exact native public readback routes", async t => {
  const root = dir(t);
  const socket = createServer();
  socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(done => socket.close(done));
  const env = { BOT_DATA_DIR: root, PORT: String(port) };
  const host = await createBotHost({ env });
  const origin = host.settings.origin;
  let taskId;
  try {
    await host.start();
    const request = (path, options) => fetch(origin + path, { redirect: "manual", ...options });
    for (const path of ["/bot/","/login","/public-api/profile","/public-api/content","/zh/"]) assert.equal((await request(path)).status, 200, path);
    for (const path of ["/admin","/api/bootstrap","/api/live/github/publish"]) assert.equal((await request(path)).status, 404, path);
    assert.equal((await request("/api/bot/v1/dashboard")).status, 401);
    const { password } = JSON.parse(readFileSync(join(root, "local-login.json"), "utf8"));
    const login = await request("/api/bot/v1/session", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(login.status, 201);
    const session = await login.json();
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const post = (path, input, key) => request("/api/bot/v1/" + path, { method: "POST", headers: {
      Origin: origin, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": session.csrfToken, "Idempotency-Key": key }, body: JSON.stringify(input) });
    const dashboard = await (await request("/api/bot/v1/dashboard", { headers: { Cookie: cookie } })).json();
    assert.equal(dashboard.channels.length, 28);
    const mandate = await post("mandates", { objective: "核对公开的技术变更", sources: ["manual"] }, "smoke-mandate");
    assert.equal(mandate.status, 201);
    const m = await mandate.json();
    const payload = { mandateId: m.id, externalId: "release-a", title: "Official release", text: "A change requires an original source." };
    const first = await post("events", payload, "event-source-a");
    assert.equal(first.status, 202);
    const opened = await first.json();
    assert.equal(opened.tasks.length, 1);
    taskId = opened.tasks[0].id;
    const second = await (await post("events", payload, "event-source-a")).json();
    assert.equal(second.tasks[0].id, taskId);
    for (let i = 0; i < 3; i++) await host.daemon.drainOnce();
    const task = host.core.getTask(taskId, host.ctx);
    assert.equal(task.channels.length, 28);
    assert.ok(task.steps.some(s => s.kind === "discover" && s.state === "succeeded"), JSON.stringify(task.steps));
    assert.equal(host.core.outcomes(m.id, host.ctx).counts.publicVerified, 0);
  } finally { await host.stop(); }
  const reopened = await createBotHost({ env });
  try { assert.equal(reopened.core.getTask(taskId, reopened.ctx).id, taskId); }
  finally { await reopened.stop(); }
});

function costLedger() {
  const events = new Map();
  return {
    spent: [], events,
    reserveCost({requestKey, reservedMinor}) {
      const id = "cost-" + requestKey; if (!events.has(id)) events.set(id, { dispatched: false, reservedMinor });
      return { id };
    },
    markCostDispatched({costId}) { const row = events.get(costId); const execute = !row.dispatched; row.dispatched = true; return { execute }; },
    settleCost(record) { this.spent.push(record); },
  };
}
test("model transport checks a live step, saves original provider usage, and deduplicates an identical request", async t => {
  const core = costLedger();
  let requests = 0;
  const root = dir(t);
  const endpoint = "https://model.example.test";
  const meter = createMeter({ core, dataDir:root, mode:"real", endpoint,
    pricing:{ currency:"CNY", reference:"signed-tariff-001", inputPerMillion:1000, cacheHitPerMillion:100, outputPerMillion:2000 },
    async fetchImpl() {
      requests++;
      return Response.json({ id:"response-a", model:"deepseek-flash", usage:{ prompt_tokens:1000, prompt_cache_hit_tokens:500, completion_tokens:250 } });
    } });
  const send = () => meter.fetch(endpoint + "/v1/chat/completions", { method:"POST", body:JSON.stringify({ model:"deepseek-flash", max_tokens:256 }) });
  await assert.rejects(send, { code:"MODEL_COST_AUTHORIZATION_REQUIRED" });
  await meter.run({id:"step-a",epoch:1}, {}, async () => {
    assert.equal((await send()).status, 200); assert.equal((await send()).status, 200);
    await assert.rejects(() => meter.fetch("https://other.example.test/v1/chat/completions", {method:"POST"}), { code:"PROVIDER_SCOPE_DENIED" });
  });
  assert.equal(requests,1);
  assert.equal(core.spent[0].actualMinor,2);
  assert.equal(core.spent[0].providerRef,"response-a");
});

test("unknown provider outcome retains cost and refuses a blind repeat", async t => {
  const core = costLedger();
  let calls = 0;
  const meter = createMeter({ core, dataDir:dir(t), mode:"real", endpoint:"https://model.example.test",
    pricing:{ currency:"USD", reference:"t1", inputPerMillion:1, cacheHitPerMillion:1, outputPerMillion:2 },
    async fetchImpl() { calls++; throw new Error("connection lost"); } });
  const send = () => meter.fetch("https://model.example.test/chat/completions", { method:"POST", body:JSON.stringify({ model:"deepseek-flash", max_tokens:20 }) });
  await meter.run({id:"step-b",epoch:1},{},async () => {
    await assert.rejects(send,/connection lost/); await assert.rejects(send,{code:"ORIGINAL_COST_RECONCILIATION_REQUIRED"});
  });
  assert.equal(calls,1); assert.equal(core.spent[0].status,"unknown");
});

test("feed reads only an active mandate and binds a trustworthy candidate to its original event", async t => {
  const accepted=[]; const core={ listMandates:()=>[{id:"mandate-a",revision:1,state:"active",trustScope:{sources:["upstream"]}}], ingestEvent:event=>(accepted.push(event),event) };
  let time=0, reads=0;
  const sources=createSources({ dataDir:dir(t), core, ctx:{}, mode:"real", clock:()=>time,
    sources:[{id:"upstream",format:"json-feed",url:"https://upstream.example.test/data",allowPublicFacts:true}],
    fetchImpl: async(_url,{headers})=>{
      reads++;
      if(headers["If-None-Match"]) return new Response(null,{status:304});
      return Response.json({items:[{id:"a",title:"A source update",url:"https://upstream.example.test/a",content_text:"Original evidence"}]}, {headers:{etag:'"a"'}});
    } });
  await sources.poll(); await sources.poll(); assert.equal(reads,1); assert.equal(accepted.length,1);
  assert.equal(sources.candidate({input:accepted[0]}).sourceExcerpt,"Original evidence");
  assert.equal(sources.candidate({input:{...accepted[0],eventKey:"other"}}),null);
  time += 900001; await sources.poll(); assert.equal(reads,2); assert.equal(accepted.length,1);
});

test("owner notifications require a receiver acknowledgment bound to the original ID", async () => {
  let state="pending", clock=100, ack;
  const ctx={role:"system"}; const core={listNotifications:()=>[{id:"notice-a",state}],ackNotification(value){ack=value;state=value.status;}};
  let valid=false;
  const deliver=createNotificationDelivery({core,ctx,mode:"real",url:"https://owner.example.test/inbox", clock:()=>clock,
    fetchImpl:async(_u,init)=>{assert.equal(init.headers["Idempotency-Key"],"notice-a");return Response.json({id:valid?"notice-a":"another",receiptId:"receipt-1"});}});
  await deliver(); assert.equal(ack.status,"failed");
  valid=true;clock+=31000;await deliver();assert.equal(ack.receiptRef,"receipt-1");
});

test("production rejects loopback HTTP and same-volume intent log", t => {
  const root=dir(t);
  assert.throws(()=>loadSettings({BOT_MODE:"real",BOT_DATA_DIR:root}),/HTTPS/);
  assert.throws(()=>openIntentJournal(dir(t),{primaryDirectory:root}),/separate durable volume/);
  const journal=openIntentJournal(dir(t),{primaryDirectory:root,requireSeparateVolume:false});
  const row={scope:"x",key:"intent-a",digest:"first",at:1};journal.append(row);journal.append(row);
  assert.equal(journal.list({scope:"x"}).length,1);
  assert.throws(()=>journal.append({...row,digest:"different"}),/conflict/);
});
