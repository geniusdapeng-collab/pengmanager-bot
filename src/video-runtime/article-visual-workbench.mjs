import { ARTICLE_SCENE_MAX_BYTES } from './article-visuals.mjs';

export function articleVisualWorkbench(nonce, csrf, showNativeLink = true) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>文章场景图工位</title>
<style>
:root{font:16px/1.5 system-ui;color:#eaf2f5;background:#111c23;color-scheme:dark}*{box-sizing:border-box}body{margin:0}main{width:min(100% - 32px,820px);margin:3rem auto}h1{margin:0 0 1.2rem}h2{font-size:1.13rem;margin:0 0 .65rem}form,section{border:1px solid #425660;border-radius:12px;background:#16262f;padding:1.15rem;margin:1rem 0}label{display:block;margin:.65rem 0}.row{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}input:not([type=checkbox]){display:block;width:100%;min-height:2.4rem;padding:.4rem .5rem;border:1px solid #506873;border-radius:6px;background:#111c23;color:inherit}button,a.download{display:inline-block;margin:.4rem .4rem 0 0;padding:.55rem .8rem;border-radius:7px;border:1px solid #6cacbc;background:#1c4050;color:#eefbfd;text-decoration:none;font:inherit;cursor:pointer}button:hover,a.download:hover{background:#29566a}button:active{background:#112d3a}button[disabled]{opacity:.55;cursor:wait}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #a1e3f3;outline-offset:2px}img{display:block;max-width:100%;max-height:510px;margin:.75rem auto;border-radius:6px}output,pre{display:block;overflow-wrap:anywhere;white-space:pre-wrap;min-height:1.5rem}pre{padding:.65rem;background:#111c23;font-size:.86rem}a{color:#a1e3f3}[hidden]{display:none!important}@media(max-width:560px){main{margin:1.25rem auto}.row{grid-template-columns:1fr}form,section{padding:.85rem}}
</style></head><body><main>
${showNativeLink ? '<a href="/ai-video/assets">返回本机工作台</a>' : ''}<h1>文章场景图工位</h1>
<section id="workspace"><h2>本机工作区</h2><output id="workspace-status" aria-live="polite">正在读取经营阶段。</output>
<div id="workspace-setup" hidden><button type="button" id="journey" hidden>采用本人已确认的向导阶段</button>
<label>按实际情况设置初始阶段 <select id="workspace-stage"><option value="">请选择</option><option value="onboarding">首次配置</option><option value="stable">稳定经营</option></select></label>
<button type="button" id="configure-stage">确认初始阶段</button></div></section>
<form id="scene"><h2>插图计划图位</h2>
<label>插图工单 JSON<input name="workOrderFile" type="file" accept="application/json,.json"></label>
<output id="brief" hidden></output>
<div class="row"><label>计划 ID<input name="planId" readonly></label><label>图位 ID<input name="slotId" readonly></label></div>
<label>原稿 SHA-256<input name="sourceHash" readonly spellcheck="false"></label>
<label>场景标题<input name="title" maxlength="27"></label>
<label>场景原图 PNG<input name="png" type="file" accept="image/png,.png"></label>
<label>源图来源 <select name="sourceKind"><option value="authorized_asset">已授权的现有照片或图层</option><option value="imagegen">已有 ImageGen 生成原图</option></select></label>
<label>取景方式 <select name="framing"><option value="">按场景说明选择</option><option value="environment">保留现场语境</option><option value="detail">突出操作细节</option></select></label>
<div class="row"><label>主体横向位置 %<input name="focusX" type="number" min="0" max="100" value="50"></label>
<label>主体纵向位置 %<input name="focusY" type="number" min="0" max="100" value="50"></label></div>
<label>授权透明标注 PNG（可选，同原图画幅）<input name="overlay" type="file" accept="image/png,.png"></label>
<label><input name="portrait" type="checkbox">含真人肖像</label>
<label><input name="thirdParty" type="checkbox">含第三方素材</label>
<label><input name="rights" type="checkbox">已核对源图的使用权与肖像情况</label>
<button type="button" id="make">交给视觉设计师</button><button type="button" id="check">回读此图位</button></form>
<section><h2>AI 配方审核与核验</h2><output id="status" aria-live="polite">导入插图工单后提交或回读。</output>
<p id="recipe" hidden></p><canvas id="framing-preview" aria-label="构图和标注预览" role="img" style="display:block;max-width:100%;height:auto;border-radius:6px" hidden></canvas>
<img id="preview" alt="已核验的原生场景成品" hidden>
<button type="button" id="export" hidden>核验成品并导出</button>
<a id="download-image" class="download" download="scene.png" hidden>下载成品图</a>
<a id="download-proof" class="download" download="scene-proof.json" hidden>下载签名凭据</a></section>
<section><h2>工位签名公钥</h2><button type="button" id="producer">取得工位公钥</button><pre id="key" hidden></pre></section>
</main><script nonce="${nonce}">
const csrf = ${JSON.stringify(csrf)};
const max = ${ARTICLE_SCENE_MAX_BYTES};
const byId = id => document.getElementById(id);
const form = byId('scene');
const buttons = [...document.querySelectorAll('button')];
let workOrder = null;
let sceneVersion = 0;
let refreshTimer = null;
const label = {missing:'暂无任务',queued:'排队中',running:'合成中',pending_review:'等待 AI 配方审核',completed:'任务完成',failed:'执行失败',cancelled:'已取消',paused:'已暂停'};
const urls = new Map();
function download(id, blob) {
  if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
  urls.delete(id);
  byId(id).hidden = !blob;
  if (blob) {
    const url = URL.createObjectURL(blob);
    urls.set(id, url);
    byId(id).href = url;
  } else byId(id).removeAttribute('href');
}
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('读不到所选的 PNG。'));
    reader.readAsDataURL(file);
  });
}
function binding() {
  if (!workOrder) throw new Error('请先导入编辑出版导出的场景图工单。');
  return {planId:workOrder.planId,slotId:workOrder.slot.id,sourceHash:workOrder.sourceHash};
}
async function request(action, body) {
  const result = await fetch('/_pengmanager/video/article-scenes/' + action, { method:'POST', credentials:'same-origin',
    headers:{'content-type':'application/json','x-pengmanager-video-csrf':csrf}, body:JSON.stringify(body) });
  const payload = await result.json();
  if (!result.ok) throw new Error(payload.message || payload.error || '工位未就绪。');
  return payload;
}
const stageLabel={onboarding:'首次配置',stable:'稳定经营',audit:'体检期',managed:'托管期'};
async function showWorkspace() {
  const workspace=await request('workspace',{});
  byId('workspace-setup').hidden=Boolean(workspace.stage);
  byId('journey').hidden=!workspace.journeyStage;
  byId('workspace-status').textContent=workspace.stage?'当前阶段 ' + (stageLabel[workspace.stage]||workspace.stage) +
    (workspace.stageEventId?' · 设置事件 ' + workspace.stageEventId:'')
    :workspace.journeyStage?'尚未设置；本人向导中已确认 ' + stageLabel[workspace.journeyStage]:'经营阶段待确认。';
}
function resetScene() {
  sceneVersion += 1;
  clearTimeout(refreshTimer);
  for (const id of ['export','preview','recipe','framing-preview']) byId(id).hidden = true;
  byId('preview').removeAttribute('src');
  download('download-image', null);
  download('download-proof', null);
}
async function decodeImage(value) {
  const image=new Image();
  image.src='data:image/png;base64,' + value;
  await image.decode();
  return image;
}
function statusText(data) {
  const review = data.approval?.ai;
  const retryAt = Date.parse(review?.retryAt);
  const text = (label[data.state] || data.state) + ' · ' + data.nativeThreadId +
    (data.approval ? ' · ' + data.approval.id + '（' + data.approval.status + '）' : '') +
    (review ? ' · ' + (review.outcome || (review.event === 'approval.ai_attempt_started' ? 'AI 正在核对'
      : Number.isFinite(retryAt) ? '将在 ' + new Date(retryAt).toLocaleTimeString() + ' 后自动重试' : '本次已暂停')) +
      (review.reason ? ' · ' + review.reason : '') : '');
  if (byId('status').textContent !== text) byId('status').textContent = text;
}
function follow(data, source, version) {
  const review = data.approval?.ai;
  const retryAt = Date.parse(review?.retryAt);
  if (!['queued','running','pending_review'].includes(data.state) || review?.outcome === 'needs_input' ||
      ['approval.ai_blocked','approval.ai_attempt_unresolved'].includes(review?.event) ||
      (review?.event === 'approval.ai_attempt_refused' && !Number.isFinite(retryAt))) return;
  const delay = Number.isFinite(retryAt) ? Math.min(30_000, Math.max(6000, retryAt - Date.now())) : 6000;
  refreshTimer = setTimeout(async () => {
    try {
      const latest = await request('status', source);
      if (version !== sceneVersion) return;
      if (latest.state !== data.state) return await display(latest, source);
      statusText(latest);
      follow(latest, source, version);
    } catch (error) {
      if (version === sceneVersion) byId('status').textContent = error instanceof Error ? error.message : '工作台回读失败。';
    }
  }, delay);
}
async function display(data, source) {
  if (!workOrder || source.planId!==workOrder.planId || source.slotId!==workOrder.slot.id || source.sourceHash!==workOrder.sourceHash) return;
  resetScene();
  const version = sceneVersion;
  statusText(data);
  follow(data, source, version);
  if (data.state === 'completed') byId('export').hidden = false;
  if (data.state !== 'pending_review' || data.approval?.status !== 'pending') return;
  const preview = await request('source', source);
  if (version!==sceneVersion || preview.state!=='pending_review' || preview.approval?.status!=='pending') return;
  const [photo, overlay]=await Promise.all([decodeImage(preview.image),preview.overlay?decodeImage(preview.overlay):null]);
  if (version!==sceneVersion) return;
  const {width,height,photo:placement,mode,focusX,focusY}=preview.framing;
  const canvas=byId('framing-preview'), scale=Math.min(1,960/width);
  canvas.width=Math.round(width*scale); canvas.height=Math.round(height*scale);
  const context=canvas.getContext('2d');
  context.drawImage(photo,placement.x*scale,placement.y*scale,placement.width*scale,placement.height*scale);
  if(overlay)context.drawImage(overlay,0,0,canvas.width,canvas.height);
  canvas.hidden=false;
  const kind = preview.sourceKind === 'imagegen' ? 'ImageGen 原图' : '已有授权素材';
  byId('recipe').textContent = preview.designBrief.sceneDescription + ' · ' + kind + ' · ' +
    (mode==='detail'?'细节取景':'现场取景') + ' · 焦点 ' + focusX + '% / ' + focusY + '%' +
    (overlay?' · 含透明标注图层':'') + '。' +
    (preview.hasPortrait || preview.hasThirdPartyAsset ? '请核对真人肖像或第三方素材授权。' : '请核对原图和用途。');
  byId('recipe').hidden = false;
}
function click(id, action) {
  byId(id).addEventListener('click', async () => {
    for (const control of buttons) control.disabled = true;
    try { await action(); }
    catch (error) { byId('status').textContent = error instanceof Error ? error.message : '工位请求失败。'; }
    finally { for (const control of buttons) control.disabled = false; }
  });
}
form.addEventListener('submit', event => event.preventDefault());
form.addEventListener('input', resetScene);
form.elements.workOrderFile.addEventListener('change',async(event)=>{
  const selected=event.target.files[0];
  workOrder=null;
  byId('brief').hidden=true;
  for (const key of ['planId','slotId','sourceHash','title','framing']) form.elements[key].value='';
  form.elements.sourceKind.disabled=false;
  try {
    if (!selected || selected.size>64*1024) throw new Error('请选择不超过 64 KB 的场景图工单。');
    const next=JSON.parse(await selected.text());
    if (form.elements.workOrderFile.files[0]!==selected) return;
    if (next?.schema!=='pengmanager.article-illustration-work-order/v1' || next.slot?.kind!=='scene' ||
        typeof next.planId!=='string' || typeof next.slot.id!=='string' || !/^[a-f0-9]{64}$/.test(next.sourceHash) ||
        typeof next.slot.imageGeneration!=='boolean' || typeof next.slot.description!=='string' || !next.slot.description.trim()) throw new Error('工单格式无效，或用途不是场景图。');
    workOrder=next;
    byId('brief').textContent=[next.title,next.slot.description,next.slot.caption].filter(item=>typeof item==='string'&&item.trim()).join(String.fromCharCode(10));
    byId('brief').hidden=!byId('brief').textContent;
    const selectedBinding=binding();
    for (const key of ['planId','slotId','sourceHash']) form.elements[key].value=selectedBinding[key];
    form.elements.sourceKind.value=next.slot.imageGeneration?'imagegen':'authorized_asset';
    form.elements.sourceKind.disabled=next.slot.imageGeneration;
    byId('status').textContent='工单已载入。请核对源图与场景标题。';
  } catch(error) { byId('status').textContent=error instanceof Error ? error.message : '读不到场景图工单。'; }
});
click('make',async()=>{
  const source=binding(), file=form.elements.png.files[0], overlayFile=form.elements.overlay.files[0], title=form.elements.title.value.trim();
  const framing={mode:form.elements.framing.value,focusX:form.elements.focusX.valueAsNumber,focusY:form.elements.focusY.valueAsNumber};
  if (!title || !file || !form.elements.rights.checked || !framing.mode || file.size+(overlayFile?.size||0)>max) throw new Error('请核对源图、授权和取景方式，并填写场景标题。');
  byId('status').textContent='正在派给视觉设计师。';
  const order=workOrder, sourceKind=form.elements.sourceKind.value, hasPortrait=form.elements.portrait.checked,hasThirdPartyAsset=form.elements.thirdParty.checked;
  const [png,overlay]=await Promise.all([readFile(file),overlayFile?readFile(overlayFile):undefined]);
  await display(await request('submit',{...source,workOrder:order,title,png,overlay,framing,confirm:true,rightsConfirmed:true,
    sourceKind,hasPortrait,hasThirdPartyAsset}),source);
});
click('check',async()=>{const source=binding();await display(await request('status',source),source);});
click('export',async()=>{
  const version=sceneVersion;
  const data=await request('export',binding());
  if (version!==sceneVersion) return;
  const blob=new Blob([Uint8Array.from(atob(data.image),value=>value.charCodeAt(0))],{type:'image/png'});
  download('download-image',blob);
  download('download-proof',new Blob([JSON.stringify(data.proof,null,2)],{type:'application/json'}));
  byId('preview').src='data:image/png;base64,' + data.image;
  byId('preview').alt='已核验的原生场景成品';
  byId('preview').hidden=false;
  byId('status').textContent='已核验成品与原生回执。SHA-256 ' + data.proof.statement.sha256;
});
click('producer',async()=>{
  byId('key').textContent=JSON.stringify(await request('producer',{}),null,2);
  byId('key').hidden=false;
});
click('journey',async()=>{await request('configure-stage',{source:'journey',confirm:true});await showWorkspace();});
click('configure-stage',async()=>{
  const stage=byId('workspace-stage').value;
  if(!stage)throw new Error('请选择实际工作区阶段。');
  await request('configure-stage',{source:'owner',stage,confirm:true});
  await showWorkspace();
});
showWorkspace().catch(error=>{byId('workspace-status').textContent=error instanceof Error?error.message:'读取工作区失败。';});
</script></body></html>`;
}
