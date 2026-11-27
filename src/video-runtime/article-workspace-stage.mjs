import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCOPE, requireEngineModule, VideoRuntimeError } from './config.mjs';

const explicitStages = new Set(['onboarding', 'stable']);
const journeyStages = new Set(['audit', 'managed']);
const fail = (code, message) => { throw new VideoRuntimeError(code, message); };

async function scoped(pool, update, handler) {
  const client = await pool.connect();
  try {
    await client.query(update ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [SCOPE.tenantId, SCOPE.workspaceId]);
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function workspace(client, lock = false) {
  const args = [SCOPE.tenantId,SCOPE.workspaceId,SCOPE.memberId,SCOPE.memberNo];
  const { rows: [row] } = await client.query(`SELECT w.stage,p.archive->'journey'->>'stage' AS journey_stage,
    (SELECT b.payload->'decision'->'after'->>'stage' FROM biz_events b WHERE b.tenant_id=w.tenant_id AND b.workspace_id=w.id
       AND b.payload->'decision'->>'action'='onboarding.segment_activated'
       AND b.payload->'who'->>'type'='human' AND b.payload->'who'->>'id'=$4 ORDER BY b.seq DESC LIMIT 1) AS journey_event_stage,
    (SELECT b.event_id FROM biz_events b WHERE b.tenant_id=w.tenant_id AND b.workspace_id=w.id
       AND b.payload->'decision'->>'action'='workspace.stage.configure'
       AND b.payload->'object'->>'type'='workspace' AND b.payload->'object'->>'id'=w.id
       AND b.payload->'decision'->'after'->>'stage'=w.stage
       AND b.payload->'who'->>'type'='human' AND b.payload->'who'->>'id'=$4 ORDER BY b.seq DESC LIMIT 1) AS stage_event_id
    FROM workspaces w JOIN profiles p ON p.workspace_id=w.id AND p.tenant_id=w.tenant_id
    JOIN members m ON m.workspace_id=w.id AND m.id=$3 AND m.member_no=$4 AND m.role='owner' AND m.status='active'
    WHERE w.tenant_id=$1 AND w.id=$2 AND w.is_example=false AND w.bundle_id='geo-growth' ${lock?'FOR UPDATE OF w':''}`, args);
  if (!row) fail('ARTICLE_SCENE_WORKSPACE_UNAVAILABLE', '当前本机身份没有对应的正式工作区。');
  const journeyStage = journeyStages.has(row.journey_stage) && row.journey_stage === row.journey_event_stage ? row.journey_stage : null;
  return { stage: row.stage, journeyStage, ...(row.stage_event_id ? { stageEventId:row.stage_event_id } : {}) };
}

export async function readArticleWorkspaceStage(pool) {
  return scoped(pool, false, client=>workspace(client));
}

export async function configureArticleWorkspaceStage(pool, append, { source, stage }) {
  if (source !== 'journey' && (source !== 'owner' || !explicitStages.has(stage))) {
    fail('ARTICLE_SCENE_STAGE_INVALID', '请选择真实工作区阶段或采用本人已确认的向导阶段。');
  }
  return scoped(pool, true, async client => {
    const before = await workspace(client, true);
    const next = source === 'journey' ? before.journeyStage : stage;
    if (!next) fail('ARTICLE_SCENE_JOURNEY_MISSING', '找不到本工作区由当前主理人确认的向导阶段，请如实选择初始阶段。');
    if (before.stage === next) return { stage: next, changed: false };
    if (before.stage !== null) fail('ARTICLE_SCENE_STAGE_CONFLICT', '已有工作区阶段。此处仅用于首次设置。');
    const update = await client.query('UPDATE workspaces SET stage=$3 WHERE tenant_id=$1 AND id=$2 AND stage IS NULL',
      [SCOPE.tenantId,SCOPE.workspaceId,next]);
    if (update.rowCount!==1) fail('ARTICLE_SCENE_STAGE_CONFLICT', '工作区阶段发生变化，请回读。');
    const event = await append(client, { tenantId:SCOPE.tenantId,workspaceId:SCOPE.workspaceId,actor:{ type:'human',id:SCOPE.memberNo } }, {
      who:{type:'human',id:SCOPE.memberNo},
      context:{tenant_id:SCOPE.tenantId,workspace_id:SCOPE.workspaceId,time:new Date().toISOString(),channel:'inapp'},
      object:{type:'workspace',id:SCOPE.workspaceId},
      decision:{action:'workspace.stage.configure',before:{stage:null},after:{stage:next},params:{source}},
      rule_impact:[],
    });
    return { stage:next,changed:true,eventId:event.eventId };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [, , engineRoot, source, stage] = process.argv;
  try {
    const { Pool } = requireEngineModule({engineRoot},'pg');
    const { gatewayAppendOnClient } = await import(pathToFileURL(path.join(engineRoot,'packages/base/workdata/gateway.ts')));
    const pool = new Pool({connectionString:process.env.DATABASE_APP_URL,max:1,connectionTimeoutMillis:3000,statement_timeout:10000});
    try { console.log(JSON.stringify(await configureArticleWorkspaceStage(pool,gatewayAppendOnClient,{source,stage}))); }
    finally { await pool.end(); }
  } catch(error) {
    if (error instanceof VideoRuntimeError) console.log(JSON.stringify({error:error.code,message:error.message}));
    else { console.error('ARTICLE_SCENE_STAGE_WRITE_FAILED'); process.exitCode=1; }
  }
}
