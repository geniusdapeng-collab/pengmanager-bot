import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMandateDraft } from '../public/bot/mandate-draft.js';

const day = 86_400_000;
const now = new Date(2026, 10, 28, 12);

test('Chinese goals with spaced amounts preserve cadence, delivery and delegation expiry', () => {
  const draft = parseMandateDraft('每隔 2 天跟踪已登记信源，交付时限为 3 天，仅研究，委托有效期 2 周。', now);
  assert.equal(draft.intervalMs, 2 * day);
  assert.equal(draft.resultWindowMs, 3 * day);
  assert.equal(draft.expiryDate, '2026-12-12');
  assert.equal(draft.ambiguous, false);
  const after = parseMandateDraft('接单后 3 天内交付，运行 1 周。', now);
  assert.equal(after.resultWindowMs, 3 * day);
  assert.equal(after.expiryDate, '2026-12-05');
  assert.equal(parseMandateDraft('７ 天内 提交研究结果。', now).resultWindowMs, 7 * day);
});

test('spaces retain cadence ambiguity for repeated or negated schedules', () => {
  for (const objective of ['每天 2 次研究', '不要每隔 2 天研究', '每 3 天或每 4 天研究']) {
    const draft = parseMandateDraft(objective, now);
    assert.equal(draft.ambiguous, true, objective);
    assert.equal(draft.intervalMs, undefined, objective);
  }
  assert.equal(parseMandateDraft('每周 一 次研究', now).intervalMs, 7 * day);
});
