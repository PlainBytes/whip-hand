import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, VERDICT_INSTRUCTION } from './verdict.ts';

test('parses pass and fail, case-insensitive, first line only', () => {
  assert.equal(parseVerdict('VERDICT: PASS\nall good'), 'pass');
  assert.equal(parseVerdict('verdict: fail\nproblems'), 'fail');
  assert.equal(parseVerdict('summary\nVERDICT: FAIL'), null);
  assert.equal(parseVerdict('no verdict here'), null);
});

test('the verdict instruction defines PASS and FAIL and fixes the section order', () => {
  assert.ok(VERDICT_INSTRUCTION.startsWith("The very first line of the artifact MUST be exactly 'VERDICT: PASS' or 'VERDICT: FAIL'."));
  assert.ok(VERDICT_INSTRUCTION.includes('PASS means nothing blocking remains'));
  assert.ok(VERDICT_INSTRUCTION.includes('FAIL means at least one blocking finding'));
  assert.ok(VERDICT_INSTRUCTION.includes('the file, what is wrong, and what would fix it'));
  const at = ['## Blocking', '## Non-blocking', '## Needs a human'].map(h => VERDICT_INSTRUCTION.indexOf(h));
  assert.ok(at.every(i => i >= 0), 'all three sections are named');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in the required order');
  assert.ok(VERDICT_INSTRUCTION.includes('never turn a PASS into a FAIL by themselves'));
});

test('a report following the instruction still parses from its first line', () => {
  const report = 'VERDICT: FAIL\n\n## Blocking\n- a.ts: wrong\n\n## Non-blocking\n\n## Needs a human\n';
  assert.equal(parseVerdict(report), 'fail');
  assert.equal(parseVerdict(report.replace('FAIL', 'PASS')), 'pass');
});
