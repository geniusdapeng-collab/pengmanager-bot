import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY, WEEK } from "../src/bot/core-store.mjs";
import { createBotCore } from "../src/bot/core.mjs";
import { createNotificationDelivery } from "../src/bot/daemon.mjs";
import { assessCadence, createCadenceTrials } from "../src/bot/learning.mjs";
import { routeContentDirector } from "../src/http/content-director-routes.mjs";

function directory(t) {
  const path=mkdtempSync(join(realpathSync(tmpdir()),"bot-month-"));
  t.after(()=>rmSync(path,{recursive:true,force:true}));
  return path;
}

test("four virtual weeks retain each expiring commitment, accepted occurrences, and frozen weekly reports across a restart",t=>{
  const base=Date.UTC(2026,0,1,12), root=directory(t), dbPath=join(root,"ledger");
  let now=base, core=createBotCore({dbPath,clock:()=>now});
  t.after(()=>core.close());
  const owner={workspaceId:"w",projectId:"p",actorId:"owner",role:"owner"};
  const system={...owner,actorId:"scheduler",role:"system"};
  const worker={...owner,actorId:"research",role:"worker"};
  const m=core.createMandate({objective:"Validate a weekly decision", sources:["manual"],
    schedule:{startsAt:base,intervalMs:WEEK,reportStartsAt:base+WEEK},resultWindowMs:DAY,
    requiredOutcomes:[{id:"owner-result",outcome:"result"}],idempotencyKey:"month-mandate"},owner);
  for(let week=0;week<4;week++){
    now=base+week*WEEK;
    if(week===2){core.close();core=createBotCore({dbPath,clock:()=>now});}
    core.tick(system);core.tick(system);
    const step=core.claim({kinds:["discover"]},worker);
    assert.ok(step);
    // The third week's deliberately missed promise must stay in the denominator after restart.
    if(week===2) continue;
    core.report({id:step.id,epoch:step.epoch,status:"succeeded",decision:{action:week===3?"skip":"prepare",
      reason:"fixed offline case",evidenceRefs:["case-"+week]},output:{caseId:"case-"+week}},worker);
  }
  now=base+4*WEEK;core.tick(system);
  const summary=core.outcomes(m.id,owner);
  assert.equal(summary.reports.length,4);
  assert.deepEqual(summary.reports.map(r=>r.autonomy.due),[1,1,1,1]);
  assert.deepEqual(summary.reports.map(r=>r.autonomy.autonomous),[1,0,1,1]);
  assert.equal(summary.autonomy.rate,null);
  assert.equal(summary.counts.publicVerified,0);
  assert.equal(core.listNotifications(owner).filter(n=>n.kind==="weekly_report").length,4);
});

test("weeks of downtime backfill each report and close an unanswered owner handoff at the original deadline", t => {
  const base = Date.UTC(2026, 0, 1), deadline = base + 3 * WEEK + DAY;
  const dbPath = join(directory(t), "ledger");
  let now = base;
  const open = () => createBotCore({ dbPath, clock: () => now });
  let core = open();
  t.after(() => core.close());
  const owner = { workspaceId: "w", projectId: "p", actorId: "owner", role: "owner" };
  const system = { ...owner, actorId: "scheduler", role: "system" };
  const worker = { ...owner, actorId: "discovery", role: "worker" };
  const mandate = core.createMandate({ objective: "An exact answer needs the platform owner", expiresAt: deadline,
    schedule: { startsAt: base, intervalMs: WEEK, reportStartsAt: base + WEEK },
    requiredOutcomes: [{ channelId: "zhihu", outcome: "public" }], idempotencyKey: "unanswered-mandate" }, owner);
  const { tasks: [task] } = core.tick(system);
  const lease = core.claim({ kinds: ["discover"] }, worker);
  core.report({ id: lease.id, epoch: lease.epoch, status: "waiting_input",
    output: { code: "PLATFORM_OWNER_CONFIRMATION" } }, worker);
  assert.equal(core.getTask(task.id, owner).state, "waiting_input");
  core.close();

  now = base + 4 * WEEK;
  core = open();
  assert.deepEqual(core.tick(system), { at: now, recovered: 1, tasks: [], reports: 4, recoveryMode: false });
  assert.equal(core.getMandate(mandate.id, owner).state, "expired");
  assert.equal(core.getTask(task.id, owner).state, "expired");
  assert.throws(() => core.confirmTarget({ taskId: task.id, channelId: "zhihu", idempotencyKey: "late-owner-confirmation" }, owner),
    { code: "MANDATE_INACTIVE" });
  const reports = core.outcomes(mandate.id, owner).reports.toReversed();
  assert.deepEqual(reports.map(report => [report.periodStart, report.periodEnd]), [
    [base, base + WEEK], [base + WEEK + 1, base + 2 * WEEK],
    [base + 2 * WEEK + 1, base + 3 * WEEK], [base + 3 * WEEK + 1, deadline],
  ]);
  assert.deepEqual(reports.map(report => report.autonomy.due), [0, 0, 0, 1]);
  assert.equal(reports.at(-1).autonomy.missed, 1);
  assert.equal(reports.at(-1).terminalReason, "mandate_expired");
  assert.equal(core.tick(system).reports, 0);
  assert.equal(core.listNotifications(owner).filter(n => n.kind === "weekly_report").length, 4);
});

test("reports freeze and send as new work waits on its independent journal, then scheduling resumes once", async t => {
  const base = Date.UTC(2026, 0, 1);
  let now = base;
  let journalAvailable = true;
  const journalRows = new Map();
  const journal = {
    get({ key }) {
      if (!journalAvailable) throw new Error("isolated journal unavailable");
      return journalRows.get(key);
    },
    append(entry) { journalRows.set(entry.key, entry); return { key: entry.key, digest: entry.digest }; },
    list() { return [...journalRows.values()]; },
  };
  const core = createBotCore({ mode: "real", journal, clock: () => now, dbPath: join(directory(t), "ledger") });
  t.after(() => core.close());
  const owner = { workspaceId: "w", projectId: "p", actorId: "owner", role: "owner" };
  const system = { ...owner, actorId: "scheduler", role: "system" };
  const mandate = core.createMandate({ objective: "A scheduled task needs independent intent", idempotencyKey: "journal-mandate",
    schedule: { startsAt: base + WEEK, intervalMs: WEEK, reportStartsAt: base + WEEK } }, owner);
  now += WEEK;
  journalAvailable = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => core.tick(system), { code: "JOURNAL_UNAVAILABLE" });
    assert.equal(core.outcomes(mandate.id, owner).reports.length, 1);
    assert.equal(core.listTasks(owner).length, 0);
  }
  const [report] = core.outcomes(mandate.id, owner).reports;
  const delivered = [];
  const notify = createNotificationDelivery({ core, ctx: system, mode: "real", url: "https://owner.example.test/reports",
    clock: () => now, fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      delivered.push(payload);
      assert.equal(options.headers["Idempotency-Key"], payload.id);
      return Response.json({ id: payload.id, receiptId: "isolated-report-receipt" });
    } });
  await notify();
  await notify();
  assert.deepEqual(delivered.map(item => [item.reportId, item.periodStart, item.periodEnd]), [[report.id, base, base + WEEK]]);
  assert.equal(core.listNotifications(owner)[0].deliveryRef, "isolated-report-receipt");
  journalAvailable = true;
  assert.equal(core.tick(system).tasks.length, 1);
  assert.equal(core.tick(system).tasks.length, 0);
  assert.equal(core.listTasks(owner).length, 1);
  assert.deepEqual(core.outcomes(mandate.id, owner).reports, [report]);
});

const signals=(source,citations,at) => ({id:source+"-"+at,sourceId:source,taskId:"task-"+source+at,day:7,observedAt:at,
  dataMode:"real",mode:"real",surface:"single-model",provider:"licensed-api",questionRevision:"panel-v1",
  evidenceRef:source+"-"+at,planned:5,cost:10,comparison:{status:"verified",paired:5,citations},
  observations:[1,2,3,4,5].map(i=>({queryId:"q"+i,queryHash:"v1-"+i,model:"m1"}))});

test("explicit cadence trial compares two separate feeds, persists the result, and returns to the baseline",t=>{
  const root=directory(t), start=Date.UTC(2026,2,1);
  let now=start;
  const m={id:"m",revision:1,state:"active",trustScope:{sources:["a","b"],learning:{sourceId:"a",controlSourceId:"b",minPairs:5}}};
  const feeds=new Map([["a",{id:"a",allowCadenceTrial:true}],["b",{id:"b"}]]);
  const rows=[signals("a",0,now-DAY),signals("b",2,now-DAY)];
  const core={ listCosts:()=>[],listTasks:()=>rows.map(r=>({id:r.id,createdAt:r.observedAt-7*DAY,input:{sourceId:r.sourceId}})),
    getTask:id=>{
      const signal=rows.find(r=>r.id===id);
      return { observations:[{id,basePublicationAt:signal.observedAt-7*DAY}],
        steps:[{kind:"observe",input:{day:7,observationId:id},output:signal}] };
    } };
  const open=()=>createCadenceTrials({core,ctx:{},mode:"real",dataDir:root,clock:()=>now});
  let trial=open();
  trial.refresh([m],feeds);assert.equal(trial.forSource("a").stage,"trial");assert.equal(trial.forSource("a").factor,2);assert.equal(trial.forSource("b").factor,1);
  now+=14*DAY;rows.push(signals("a",1,now-1),signals("b",2,now-1));
  trial=open();trial.refresh([m],feeds);assert.equal(trial.forSource("a").stage,"trial");
  now+=7*DAY;rows.push(signals("a",1,now-1),signals("b",2,now-1));
  trial=open();trial.refresh([m],feeds);assert.equal(trial.forSource("a").stage,"adopted");
  now+=7*DAY;
  trial.refresh([m],feeds);assert.equal(trial.forSource("a").stage,"rollback");assert.equal(trial.forSource("a").factor,1);
  const changed=signals("b",1,start);changed.observations[0].model="m2";
  assert.equal(assessCadence([rows[0], changed],"a","b",start-2*DAY,start+1,5).eligible,false);
});

test("native batch HTTP pause, resume and cancel resolve the batch ID captured by the action route",async()=>{
  for(const action of ["pause","resume","cancel"]){
    let actual;
    const handled=await routeContentDirector({request:{method:"POST",headers:{"idempotency-key":"batch-action-"+action}},response:{},
      url:new URL("https://local.test/api/content-director/batches/batch-73/"+action),principal:{actor:"owner",method:"session"},
      contentDirector:{async controlBatch(id,input,ctx){actual={id,input,ctx};return {id};}},
      readJsonBody:()=>({}),writeJson:(_res,status,body)=>{assert.equal(status,200);assert.equal(body.id,"batch-73");} });
    assert.equal(handled,true);assert.equal(actual.id,"batch-73");assert.deepEqual(actual.input,{action});assert.equal(actual.ctx.actor,"owner");
  }
});
