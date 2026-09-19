import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  awaitStateName, awaitStatePath, clearAwaitState, isAwaitStateName, parseAwaitState,
} from './await-state.ts';
import { isEndMarkerName } from './session-end.ts';

test('the state file lives in the run dir, named after the step', () => {
  assert.equal(awaitStateName('plan'), '.plan.await');
  assert.equal(awaitStatePath('/w/.whiphand/runs/r1', 'plan'), join('/w/.whiphand/runs/r1', '.plan.await'));
});

test('a step id is used verbatim, and one that is not a legal segment is refused rather than flattened', () => {
  // Step ids are validated segments (schema.ts), so no two steps can share a
  // state file the way two flattened ids could.
  assert.equal(awaitStateName('a b'), '.a b.await');
  assert.throws(() => awaitStateName('a/b'), /invalid step id/);
  assert.throws(() => awaitStatePath('/w/.whiphand/runs/r1', '../escape'), /invalid step id/);
});

test('await state and end markers never claim each other', () => {
  assert.ok(isAwaitStateName('.plan.await'));
  assert.ok(isAwaitStateName('.review-triage.await'));
  assert.ok(!isAwaitStateName('.plan.done'));
  assert.ok(!isEndMarkerName('.plan.await'));
  assert.ok(!isAwaitStateName('plan.md'));
  assert.ok(!isAwaitStateName('.await'));
});

test('our own hooks write a reason directly', () => {
  for (const reason of ['turn', 'permission', 'away']) {
    assert.deepEqual(parseAwaitState(`{"r":"${reason}"}`), { kind: 'state', reason });
  }
});

test("claude's raw Notification payload is mapped by notification_type", () => {
  // Captured verbatim from a live session.
  const idle = '{"session_id":"x","hook_event_name":"Notification",' +
    '"notification_type":"idle_prompt","message":"Claude is waiting for your input"}';
  assert.deepEqual(parseAwaitState(idle), { kind: 'state', reason: 'away' });
  assert.deepEqual(
    parseAwaitState('{"notification_type":"permission_prompt"}'), { kind: 'state', reason: 'permission' });
});

test('anything unrecognized is ignored, never a cleared state', () => {
  // Absence of the file is what means "not waiting" — a body we do not
  // understand must leave the last known state standing.
  for (const raw of [
    '',
    '   ',
    'not json',
    '{"r":"nonsense"}',
    '{"r":"TURN"}',
    '{"notification_type":"auth_success"}',
    '[]',
    'null',
  ]) {
    assert.deepEqual(parseAwaitState(raw), { kind: 'ignore' }, `for ${JSON.stringify(raw)}`);
  }
});

test('a partially written body is ignored: printf truncates before it writes', () => {
  assert.deepEqual(parseAwaitState('{"r":"tu'), { kind: 'ignore' });
});

test('clearAwaitState removes a leftover and is a no-op when there is none', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'whiphand-await-'));
  const path = awaitStatePath(runDir, 'plan');
  await writeFile(path, '{"r":"turn"}');

  await clearAwaitState(runDir, 'plan');
  await assert.rejects(() => stat(path));

  await clearAwaitState(runDir, 'plan');
});
