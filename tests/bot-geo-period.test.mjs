import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createBotCore } from '../src/bot/core.mjs';
import { hash } from '../src/bot/core-store.mjs';
import { compareGeoRounds, createGeoBotAdapter, normalizeGeoScope } from '../src/bot/operations-geo.mjs';

test('the report reads 2100 individual GEO samples and 101 published objects from one isolated database period', t => {
  const folder = mkdtempSync(join(tmpdir(), 'bot-geo-report-'));
  const file = join(folder, 'fixture.sqlite');
  const at = Date.UTC(2026, 9, 26);
  const core = createBotCore({ dbPath: file, clock: () => at });
  const db = new DatabaseSync(file);
  t.after(() => { db.close(); core.close(); rmSync(folder, { recursive:true, force:true }); });
  const owner = { workspaceId: 'team', projectId: 'content', actorId: 'owner', role: 'owner' };
  const mandate = core.createMandate({ objective:'Verify the period totals', idempotencyKey:'scale-mandate' },owner);
  const task = core.createTask({ mandateId:mandate.id, title:'Fixture period receipts', idempotencyKey:'scale-task' }, owner);
  const { scope } = db.prepare('SELECT scope FROM tasks WHERE id=?').get(task.id);
  const step = db.prepare("INSERT INTO steps(id,scope,task_id,step_key,kind,state,due_at,input,output) VALUES(?,?,?,?,'observe','succeeded',?,'{}',?)");
  const effect = db.prepare("INSERT INTO effects(operation_key,scope,mandate_id,task_id,channel_id,state,attempt,consumed_at,settlement,binding) VALUES(?,?,?,?,'official-site','verified',1,?,?,?)");
  db.exec('BEGIN');
  for (let round = 0; round < 43; round++) {
    const runId = 'run-' + Math.min(round, 41);
    const observations = Array.from({ length:50 }, (_, i) => ({ queryId:'q-'+i,
      sampleId:runId+'-'+i, state:i === 49 ? 'failed' : 'sampled', attribution:i === 49 ? 'failed' : 'original' }));
    const output = {runId, provider:'fixture', surface:'isolated', questionRevision:'first', dataMode:'fixture', observations, observedAt:at};
    step.run('step-'+round,scope,task.id,'round-'+round,at,JSON.stringify(output));
  }
  for (let n = 0; n < 102; n++) {
    effect.run('op-'+n,scope,mandate.id,task.id,at,
      JSON.stringify({ accountId:'own', remoteId:'object-'+Math.min(n,100), visibility:'public', verifiedAt:at }),
      JSON.stringify({ target: { channelId:'official-site', accountId:'own' } }));
  }
  db.exec('COMMIT');
  const {geo} = core.outcomes(mandate.id,owner);
  assert.deepEqual([geo.samples,geo.duplicates,geo.publicObjects,geo.fixturePublicObjects], [2100,50,0,101]);
  assert.equal(geo.panels[0].original,2058);
  assert.equal(geo.panels[0].failed,42);
});

test('GEO attribution binds verified reprints to their original, and monitoring conditions to the deployed panel', async () => {
  const url='https://docs.example.org/a', other='https://docs.example.org/b', copy='https://journal.example.org/a';
  const profile={language:'en',region:'fixture-region',access:'isolated API',evidenceRef:'fixture-profile'};
  const input={provider:'fixture',surface:'isolated',queryIds:['q'],questionRevision:'r1',profile,
    subjectNames:['Test Publisher'], verifiedReprints:[{url:copy,originalUrl:url,evidenceRef:'editor-check'}]};
  const scope=normalizeGeoScope({trustScope:{geo:input}},'fixture');
  let answer;
  const engine={listQueries:()=>[{id:'q',text:'A fixed question'}],runVisibility:async()=>({
    runId:'isolated-run',dataMode:'fixture',responseHash:hash(answer),samples:[{ id:'sample',query_id:'q',model:'fixture',
      dataMode:'fixture',status:'success',answer,evidenceHash:hash(answer) }],
  })};
  const adapter=createGeoBotAdapter({engine,mode:'fixture',deploymentProfile:profile});
  async function read(text, target=url) {
    answer=text;
    return adapter.collect(scope,{expectedUrls:[target]});
  }
  const direct=await read('Reference '+url);
  assert.equal(direct.observations[0].attribution,'original');
  assert.equal((await read('Reference '+copy)).observations[0].attribution,'verified_reprint');
  assert.equal((await read('Reference '+copy,other)).observations[0].attribution,'no_citation');
  assert.equal((await read('Test Publisher writes about this.')).observations[0].attribution,'name_only');
  assert.equal(compareGeoRounds(direct,{...direct,profileHash:hash('different')},url).paired,0);
  await assert.rejects(adapter.collect({...scope,profile:{...profile,region:'elsewhere'}}), {code:'GEO_PROFILE_CHANGED'});
});

test('a backfilled weekly report keeps facts known at its cutoff when the task finishes afterwards', () => {
  let now=Date.UTC(2026,9,1);
  const start=now, week=7*86400000;
  const core=createBotCore({clock:()=>now});
  const owner={workspaceId:'lab',projectId:'weekly',actorId:'owner',role:'owner'};
  const system={...owner,actorId:'scheduler',role:'system'}, worker={...owner,actorId:'research',role:'worker'};
  try {
    const m=core.createMandate({objective:'Research one question',schedule:{reportStartsAt:start+week},
      requiredOutcomes:[{id:'finding',outcome:'result'}],resultWindowMs:2*week,idempotencyKey:'report-window'},owner);
    const task=core.createTask({mandateId:m.id,title:'Question',idempotencyKey:'create-question'},owner);
    now=start+week+100;
    const step=core.claim({kinds:['discover'],taskId:task.id},worker);
    core.report({id:step.id,epoch:step.epoch,status:'succeeded',decision:{action:'skip',reason:'No newer evidence',evidenceRefs:['frozen-case']},
      output:{caseId:'frozen-case'}},worker);
    core.tick(system);
    const outcome=core.outcomes(m.id,owner);
    assert.equal(outcome.counts.fulfilled,1);
    const first=outcome.reports.find(report=>report.periodEnd===start+week);
    assert.equal(first.items.find(item=>item.taskId===task.id).outcomes[0].fulfilled,false);
    assert.equal(first.counts.fulfilled,0);
  } finally { core.close(); }
});
