import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inside, VideoRuntimeError } from './config.mjs';

const COMPLETE_SCHEMA = 'pengmanager.edit-snapshot/v1';
const PUBLIC_SOURCE_SCHEMA = 'pengmanager.edit-snapshot/public-v1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = message => new VideoRuntimeError('ENGINE_SNAPSHOT_INVALID', message);

function snapshotFiles(snapshot, { commit, fileCount, distribution }) {
  if (snapshot?.source?.commit !== commit || snapshot.sourceFileCount !== fileCount ||
      !Array.isArray(snapshot.files) || !Array.isArray(snapshot.targetOwnedFiles)) {
    throw invalid('The embedded engine inventory is missing or has the wrong source identity.');
  }
  if (distribution === 'complete' && snapshot.schemaVersion === COMPLETE_SCHEMA && snapshot.files.length === fileCount) {
    return snapshot.files;
  }
  if (distribution === 'public-source' && snapshot.schemaVersion === PUBLIC_SOURCE_SCHEMA &&
      snapshot.files.length > 0 && Number.isSafeInteger(snapshot.omittedSourceFileCount) &&
      snapshot.omittedSourceFileCount >= 0 && snapshot.files.length + snapshot.omittedSourceFileCount === fileCount) {
    return snapshot.files;
  }
  throw invalid('The embedded engine inventory does not match its declared distribution.');
}

/** Verify the selected distribution's pinned files byte for byte before loading dependencies or tools. */
export function verifyPinnedSnapshot({ rootDir, engineRoot, commit, fileCount, expectedSha256, distribution = 'complete' }) {
  rootDir = fs.realpathSync(rootDir);
  engineRoot = fs.realpathSync(engineRoot);
  if (!inside(rootDir, engineRoot) || rootDir === engineRoot) {
    throw invalid('The embedded engine inventory must remain inside this product.');
  }
  const raw = fs.readFileSync(path.join(rootDir, 'upstreams', 'workloom-video-edit.snapshot.json'));
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '') || digest(raw) !== expectedSha256) {
    throw invalid('The embedded engine inventory does not match its reviewed pin digest.');
  }
  let snapshot;
  try { snapshot = JSON.parse(raw.toString('utf8')); }
  catch (cause) { throw new VideoRuntimeError('ENGINE_SNAPSHOT_INVALID', 'The embedded engine inventory is not valid JSON.', { cause }); }
  const files = snapshotFiles(snapshot, { commit, fileCount, distribution });
  const names = new Set();
  let bytes = 0;
  for (const item of [...files, ...snapshot.targetOwnedFiles]) {
    if (!item || typeof item.path !== 'string' || !item.path || item.path.includes('\\') || item.path.includes('\0') ||
        path.isAbsolute(item.path) || path.posix.normalize(item.path) !== item.path || names.has(item.path) ||
        !['100644', '100755'].includes(item.mode) || !/^[a-f0-9]{64}$/.test(item.targetSha256 || '')) {
      throw invalid('The embedded engine inventory has an invalid or duplicate path.');
    }
    names.add(item.path);
    const file = path.resolve(engineRoot, item.path);
    if (!inside(engineRoot, file) || file === engineRoot) {
      throw invalid('The embedded engine inventory escaped the product.');
    }
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      if (error.code === 'ENOENT') {
        throw new VideoRuntimeError('COMPLETE_ENGINE_MISSING', `An embedded engine inventory file is missing: ${item.path}.`);
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) {
      throw invalid('The embedded engine inventory contains a linked or non-regular file.');
    }
    const content = fs.readFileSync(file);
    bytes += content.length;
    if (digest(content) !== item.targetSha256) {
      throw new VideoRuntimeError('ENGINE_SNAPSHOT_MISMATCH', `An embedded engine file differs from its reviewed target inventory: ${item.path}.`);
    }
  }
  return {
    fileCount: files.length, targetOwnedFileCount: snapshot.targetOwnedFiles.length, totalFiles: names.size, bytes,
    sourceMain: commit, snapshotSha256: expectedSha256, distribution,
    omittedSourceFileCount: distribution === 'public-source' ? snapshot.omittedSourceFileCount : 0,
    evidence: 'B', semanticReview: false,
  };
}
