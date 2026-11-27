import { join } from "node:path";
import { DAY, hash } from "./core-store.mjs";
import { privateDirectory, putRecord, readRecord } from "./files.mjs";

const BASE = 1;
const WINDOW = 7 * DAY;
function comparable(round) {
  if (round.day !== 7 || round.dataMode !== "real" || round.comparison?.status !== "verified" ||
      !round.planned || round.comparison.paired !== round.planned || !round.observations?.length) return null;
  const panel = round.observations.map(o => [o.queryId, o.queryHash, o.model]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  if (panel.some(([,q,m]) => !q || !m)) return null;
  return hash([round.surface,round.provider,round.questionRevision,round.profileHash ?? null,panel]);
}

export function assessCadence(rounds, treatment, control, since, until, minPairs, { exposureStartedAt } = {}) {
  const groups = new Map();
  for (const r of rounds) {
    if (r.observedAt < since || r.observedAt >= until || ![treatment,control].includes(r.sourceId)) continue;
    if (exposureStartedAt !== undefined && (!(r.acceptedAt >= exposureStartedAt) ||
        !(r.publicationAt >= exposureStartedAt) || r.observedAt - r.publicationAt < WINDOW)) continue;
    const panel = comparable(r);
    if (!panel || !r.evidenceRef || r.unknownCost) return { eligible:false, reason:"unpaired_or_unknown" };
    const group = groups.get(panel) ?? { a:new Map(),b:new Map() };
    group[r.sourceId === treatment ? "a" : "b"].set(r.evidenceRef,r);
    groups.set(panel,group);
  }
  if (groups.size !== 1) return { eligible:false, reason:"sample_or_surface_changed" };
  const [{a,b}] = groups.values();
  function total(rows) {
    let paired=0, cited=0, cost=0;
    const tasks = new Set();
    for (const r of rows.values()) {
      paired+=r.comparison.paired; cited+=r.comparison.citations;
      if (!tasks.has(r.taskId)) { tasks.add(r.taskId); cost+=r.cost; }
    }
    return { paired, cited, rate:paired ? cited/paired : null, costPerTask: tasks.size ? cost/tasks.size : null,
      evidence:[...rows.keys()].sort() };
  }
  const candidate=total(a), reference=total(b);
  const eligible=candidate.paired>=minPairs && reference.paired>=minPairs;
  return { eligible, reason:eligible?"paired":"sample_insufficient", panel:[...groups.keys()][0], candidate, reference };
}

// Only the polling interval of one optional, operator-designated feed can change.
// The control feed, granted capabilities, budget, publish gates and deadlines have no setter here.
export function createCadenceTrials({ core, ctx, mode, dataDir, clock = Date.now }) {
  const directory=privateDirectory(join(dataDir,"strategy-trials"));
  let latest = new Map(), nextRefresh=0, lastScope="";
  function collect(m, cfg, windowStart) {
    const costs=core.listCosts(ctx,m.id).filter(c=>c.mandateId===m.id);
    const byTask=new Map();
    for (const c of costs) {
      const row=byTask.get(c.taskId) ?? {cost:0,unknown:false};
      row.cost+=c.actualMinor??0;row.unknown ||= ["unknown","dispatched","reserved"].includes(c.state);
      byTask.set(c.taskId,row);
    }
    const rounds=[];
    for (const t of core.listTasks({mandateId:m.id},ctx)) {
      if (![cfg.sourceId,cfg.controlSourceId].includes(t.input?.sourceId)) continue;
      const task=core.getTask(t.id,ctx), money=byTask.get(t.id);
      for (const step of task.steps) if(step.kind==="observe" && step.input.day===7 && step.output?.observedAt>=windowStart) {
        const observation = task.observations?.find(row => row.id === step.input.observationId);
        rounds.push({...step.output,taskId:t.id,sourceId:t.input.sourceId,acceptedAt:t.createdAt,
          publicationAt:observation?.basePublicationAt,cost:money?.cost??0,unknownCost:money?.unknown??false});
      }
    }
    return rounds;
  }
  function evaluate(m,cfg,now) {
    const id=hash([m.id,m.revision,cfg]);
    const read=stage=>readRecord(join(directory,id+"-"+stage+".json"));
    const save=(stage,body)=>putRecord(directory,id+"-"+stage,{trialId:id,mandateId:m.id,revision:m.revision,sourceId:cfg.sourceId,stage,at:now,...body});
    let start=read("trial");
    const rounds=collect(m,cfg,start ? start.at-WINDOW : now-WINDOW);
    if (!start) {
      const baseline=assessCadence(rounds,cfg.sourceId,cfg.controlSourceId,now-WINDOW,now,cfg.minPairs);
      if (!baseline.eligible || baseline.candidate.rate>=baseline.reference.rate) return {factor:BASE,stage:"observing",reason:baseline.reason};
      start=save("trial",{baseline,baselineFactor:BASE,factor:2,endsAt:now+3*WINDOW,controlSourceId:cfg.controlSourceId});
    }
    const rollback=read("rollback");
    if (rollback) return rollback;
    const promoted=read("adopted");
    if (promoted && now >= promoted.expiresAt) return save("rollback",{factor:BASE,reason:"authorization_window_ended"});
    const startAfterWarmUp = start.at + WINDOW;
    const midpoint = startAfterWarmUp + WINDOW;
    const end = midpoint + WINDOW;
    const exposure = { exposureStartedAt: start.at };
    const readWindow = (since, until) => assessCadence(rounds,cfg.sourceId,cfg.controlSourceId,since,until,cfg.minPairs,exposure);
    const relative = window => (window.candidate.rate-window.reference.rate) - (start.baseline.candidate.rate-start.baseline.reference.rate);
    const comparableToBaseline = window => window.eligible && window.panel===start.baseline.panel;
    const costRegressed = window => window.candidate.costPerTask>start.baseline.candidate.costPerTask;
    if (promoted) {
      const recent = readWindow(now-WINDOW,now+1);
      if (comparableToBaseline(recent) && (relative(recent)<0 || costRegressed(recent))) {
        return save("rollback",{factor:BASE,reason:"cost_or_quality_regression",current:recent});
      }
      return promoted;
    }
    if (now<midpoint) return start;
    const first = readWindow(startAfterWarmUp, midpoint);
    if (!comparableToBaseline(first)) return save("rollback",{factor:BASE,reason:"incomparable_observations",current:first});
    if (relative(first)<=0 || costRegressed(first)) return save("rollback",{factor:BASE,reason:"no_comparable_improvement",current:first});
    if (now<end) return start;
    const second = readWindow(midpoint, end);
    if (!comparableToBaseline(second)) return save("rollback",{factor:BASE,reason:"incomparable_observations",current:second});
    if (relative(second)<=0 || costRegressed(second)) return save("rollback",{factor:BASE,reason:"no_comparable_improvement",current:second});
    return save("adopted",{factor:2,expiresAt:end+WINDOW,windows:[first,second],relativeChanges:[relative(first),relative(second)]});
  }
  function refresh(mandates, configured) {
    if (mode!=="real") return;
    const active=mandates.filter(m=>m.state==="active" && (!m.expiresAt || m.expiresAt>clock()));
    const scope=hash(active.map(m=>[m.id,m.revision]));
    if (clock()<nextRefresh && scope===lastScope) return;
    latest=new Map();lastScope=scope;nextRefresh=clock()+60000;
    for (const s of configured.values()) {
      if (s.allowCadenceTrial!==true) continue;
      const consumers=active.filter(m=>m.trustScope.sources.includes(s.id));
      if(consumers.length!==1) continue;
      const m=consumers[0], cfg=m.trustScope.learning;
      if (!cfg || m.requiredOutcomes?.length || cfg.sourceId!==s.id || cfg.controlSourceId===s.id || !m.trustScope.sources.includes(cfg.controlSourceId) ||
          !configured.has(cfg.controlSourceId) || !Number.isInteger(cfg.minPairs) || cfg.minPairs<5 || cfg.minPairs>10000) continue;
      latest.set(s.id,evaluate(m,cfg,clock()));
    }
  }
  return { refresh, forSource:id=>latest.get(id) ?? {factor:BASE,stage:"baseline"} };
}
