import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRunLocked, lockPath, LOCK_MARKER_NAME, setRunLocked } from './run-lock.ts';

async function tmpRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'whiphand-run-lock-'));
}

test('lockPath names the marker directly in the run dir', () => {
  assert.equal(lockPath('/w/.whiphand/runs/r1'), join('/w/.whiphand/runs/r1', '.locked'));
  assert.equal(LOCK_MARKER_NAME, '.locked');
});

test('a fresh run dir is not locked', async () => {
  const runDir = await tmpRunDir();
  assert.equal(await isRunLocked(runDir), false);
});

test('setRunLocked(true) creates the marker; isRunLocked then reports true', async () => {
  const runDir = await tmpRunDir();
  await setRunLocked(runDir, true);
  assert.equal(await isRunLocked(runDir), true);
  const entries = await readdir(runDir);
  assert.deepEqual(entries, ['.locked']);
});

test('setRunLocked(false) clears the marker and is a no-op when there is none', async () => {
  const runDir = await tmpRunDir();
  await setRunLocked(runDir, true);
  await setRunLocked(runDir, false);
  assert.equal(await isRunLocked(runDir), false);

  await setRunLocked(runDir, false); // second time: nothing to do, no throw
});

test('setRunLocked is idempotent in both directions', async () => {
  const runDir = await tmpRunDir();
  await setRunLocked(runDir, true);
  await setRunLocked(runDir, true);
  assert.equal(await isRunLocked(runDir), true);
});
