import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchAwaitState } from './await-state.ts';
import type { AwaitReason } from '@whiphand/core';

const tick = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function fixture(): Promise<{ path: string; seen: Array<AwaitReason | undefined>; stop(): void }> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-awaitw-'));
  const path = join(dir, '.plan.await');
  const seen: Array<AwaitReason | undefined> = [];
  const watcher = watchAwaitState(path, r => seen.push(r), 10);
  return { path, seen, stop: () => watcher.stop() };
}

test('says nothing while the session is working', async () => {
  const { seen, stop } = await fixture();
  await tick(50);
  assert.deepEqual(seen, []);
  stop();
});

test('reports a state once, not once per poll', async () => {
  const { path, seen, stop } = await fixture();
  await writeFile(path, '{"r":"turn"}');
  await tick(60);
  assert.deepEqual(seen, ['turn']);
  stop();
});

test('reports each change, and the file going away means the human answered', async () => {
  const { path, seen, stop } = await fixture();
  await writeFile(path, '{"r":"turn"}');
  await tick(40);
  await writeFile(path, '{"r":"permission"}');
  await tick(40);
  await rm(path);
  await tick(40);
  assert.deepEqual(seen, ['turn', 'permission', undefined]);
  stop();
});

test('an empty file mid-write does not flap the state', async () => {
  // `printf x > path` truncates before writing, so a poll can land on "".
  const { path, seen, stop } = await fixture();
  await writeFile(path, '{"r":"turn"}');
  await tick(40);
  await writeFile(path, '');
  await tick(40);
  await writeFile(path, '{"r":"turn"}');
  await tick(40);
  assert.deepEqual(seen, ['turn'], 'no spurious turn -> undefined -> turn');
  stop();
});

test('an unfamiliar notification leaves the last state standing', async () => {
  const { path, seen, stop } = await fixture();
  await writeFile(path, '{"r":"turn"}');
  await tick(40);
  await writeFile(path, '{"notification_type":"auth_success"}');
  await tick(40);
  assert.deepEqual(seen, ['turn']);
  stop();
});

test('a stopped watcher reports nothing further', async () => {
  const { path, seen, stop } = await fixture();
  stop();
  await writeFile(path, '{"r":"turn"}');
  await tick(50);
  assert.deepEqual(seen, []);
});
