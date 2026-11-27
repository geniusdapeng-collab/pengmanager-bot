import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { verifyPinnedSnapshot } from '../src/video-runtime/snapshot.mjs';

test('pinned engine inventory rejects tampering, missing files, external links and stale counts',t=>{
  const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'pengmanager-snapshot-test-'));t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));
  const engineRoot=path.join(rootDir,'engine');fs.mkdirSync(engineRoot);fs.mkdirSync(path.join(rootDir,'upstreams'));const commit='a'.repeat(40);
  const item={path:'entry.mjs',mode:'100644',targetSha256:createHash('sha256').update('original').digest('hex')};
  const snapshot={schemaVersion:'pengmanager.edit-snapshot/v1',source:{commit},sourceFileCount:1,files:[item],targetOwnedFiles:[]};
  let expectedSha256;
  const save=()=>{const raw=JSON.stringify(snapshot);fs.writeFileSync(path.join(rootDir,'upstreams','workloom-video-edit.snapshot.json'),raw);expectedSha256=createHash('sha256').update(raw).digest('hex');};
  const verify=()=>verifyPinnedSnapshot({rootDir,engineRoot,commit,fileCount:1,expectedSha256});
  save();fs.writeFileSync(path.join(engineRoot,item.path),'original');assert.equal(verify().fileCount,1);
  fs.writeFileSync(path.join(engineRoot,item.path),'changed');assert.throws(verify,{code:'ENGINE_SNAPSHOT_MISMATCH'});
  fs.unlinkSync(path.join(engineRoot,item.path));assert.throws(verify,{code:'COMPLETE_ENGINE_MISSING'});
  fs.writeFileSync(path.join(rootDir,'external'),'original');fs.symlinkSync(path.join(rootDir,'external'),path.join(engineRoot,item.path));assert.throws(verify,{code:'ENGINE_SNAPSHOT_INVALID'});
  fs.unlinkSync(path.join(engineRoot,item.path));fs.writeFileSync(path.join(engineRoot,item.path),'original');snapshot.sourceFileCount=2;save();assert.throws(verify,{code:'ENGINE_SNAPSHOT_INVALID'});
  snapshot.sourceFileCount=1;snapshot.files[0].path='../external';save();assert.throws(verify,{code:'ENGINE_SNAPSHOT_INVALID'});
  snapshot.files[0].path='entry.mjs';snapshot.targetOwnedFiles=[{path:'managed.mjs',mode:'100644',targetSha256:createHash('sha256').update('managed').digest('hex')}];fs.writeFileSync(path.join(engineRoot,'managed.mjs'),'managed');save();assert.equal(verify().targetOwnedFileCount,1);
  fs.writeFileSync(path.join(engineRoot,'managed.mjs'),'tampered');assert.throws(verify,{code:'ENGINE_SNAPSHOT_MISMATCH'});fs.writeFileSync(path.join(engineRoot,'managed.mjs'),'managed');
  snapshot.targetOwnedFiles.push({...item});save();assert.throws(verify,{code:'ENGINE_SNAPSHOT_INVALID'});snapshot.targetOwnedFiles.pop();
  snapshot.targetOwnedFiles[0].path='./managed.mjs';save();assert.throws(verify,{code:'ENGINE_SNAPSHOT_INVALID'});snapshot.targetOwnedFiles[0].path='managed.mjs';save();
  fs.appendFileSync(path.join(rootDir,'upstreams','workloom-video-edit.snapshot.json'),' ');assert.throws(verify,{code:'ENGINE_SNAPSHOT_INVALID'});
});

test('public engine inventory verifies its selected files without accepting an incomplete production snapshot', t => {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pengmanager-public-snapshot-test-')));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const engineRoot = path.join(rootDir, 'engine');
  fs.mkdirSync(engineRoot);
  fs.mkdirSync(path.join(rootDir, 'upstreams'));
  const commit = 'b'.repeat(40);
  const source = 'public engine source';
  fs.writeFileSync(path.join(engineRoot, 'entry.mjs'), source);
  const file = { path: 'entry.mjs', mode: '100644', targetSha256: createHash('sha256').update(source).digest('hex') };
  const inventory = {
    schemaVersion: 'pengmanager.edit-snapshot/public-v1',
    source: { commit },
    sourceFileCount: 2,
    omittedSourceFileCount: 1,
    files: [file],
    targetOwnedFiles: [],
  };
  function options() {
    const raw = JSON.stringify(inventory);
    fs.writeFileSync(path.join(rootDir, 'upstreams', 'workloom-video-edit.snapshot.json'), raw);
    return {
      rootDir, engineRoot, commit, fileCount: 2,
      expectedSha256: createHash('sha256').update(raw).digest('hex'),
    };
  }
  function verifyPublic() { return verifyPinnedSnapshot({ ...options(), distribution: 'public-source' }); }
  assert.equal(verifyPublic().omittedSourceFileCount, 1);
  assert.throws(() => verifyPinnedSnapshot(options()), { code: 'ENGINE_SNAPSHOT_INVALID' });
  inventory.omittedSourceFileCount = 0;
  assert.throws(verifyPublic, { code: 'ENGINE_SNAPSHOT_INVALID' });
  inventory.omittedSourceFileCount = 1;
  fs.writeFileSync(path.join(engineRoot, 'entry.mjs'), 'tampered');
  assert.throws(verifyPublic, { code: 'ENGINE_SNAPSHOT_MISMATCH' });
  fs.unlinkSync(path.join(engineRoot, 'entry.mjs'));
  assert.throws(verifyPublic, { code: 'COMPLETE_ENGINE_MISSING' });
});

test('the shipped source tree satisfies its own native engine pin', {
  skip: fs.existsSync(new URL('../upstreams/workloom-video-edit.pin.json', import.meta.url))
    ? false : 'Requires the separately provisioned full native snapshot.',
}, () => {
  const rootDir = path.resolve(import.meta.dirname, '..');
  const pin = JSON.parse(fs.readFileSync(path.join(rootDir, 'upstreams', 'workloom-video-edit.pin.json')));
  const receipt = verifyPinnedSnapshot({
    rootDir,
    engineRoot: path.join(rootDir, pin.engineRoot),
    commit: pin.commit,
    fileCount: pin.sourceFileCount,
    expectedSha256: pin.snapshotSha256,
    distribution: pin.distribution,
  });
  assert.equal(receipt.fileCount + receipt.omittedSourceFileCount, pin.sourceFileCount);
  assert.equal(receipt.totalFiles, receipt.fileCount + receipt.targetOwnedFileCount);
});
