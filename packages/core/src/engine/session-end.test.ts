import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { clearEndMarker, endMarkerName, endMarkerPath, isEndMarkerName } from './session-end.ts';

test('marker lives directly in the run dir, named after the step', () => {
  assert.equal(endMarkerName('plan'), '.plan.done');
  assert.equal(endMarkerPath('/w/.whiphand/runs/r1', 'plan'), join('/w/.whiphand/runs/r1', '.plan.done'));
});

test('a step id is used verbatim, and one that is not a legal segment is refused rather than flattened', () => {
  // Distinct legal ids can never collide on one marker, which flattening allowed.
  assert.equal(endMarkerName('plan'), '.plan.done');
  assert.equal(endMarkerName('a b'), '.a b.done');
  assert.notEqual(endMarkerName('a-b'), endMarkerName('a_b'));
  assert.throws(() => endMarkerName('../../etc/passwd'), /invalid step id/);
  assert.throws(() => endMarkerName('nul'), /reserved device name/);
  assert.throws(() => endMarkerPath('/w/.whiphand/runs/r1', '../escape'), /invalid step id/);
});

test('isEndMarkerName tells markers apart from artifacts', () => {
  assert.ok(isEndMarkerName('.plan.done'));
  assert.ok(isEndMarkerName('.review-triage.done'));
  assert.ok(!isEndMarkerName('plan.md'));
  assert.ok(!isEndMarkerName('run.json'));
  assert.ok(!isEndMarkerName('.done'));
});

test('clearEndMarker removes a leftover marker and is a no-op when there is none', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'whiphand-marker-'));
  const marker = endMarkerPath(runDir, 'plan');
  await writeFile(marker, '');

  await clearEndMarker(runDir, 'plan');
  await assert.rejects(() => stat(marker));

  await clearEndMarker(runDir, 'plan'); // second time: nothing to do, no throw
});
