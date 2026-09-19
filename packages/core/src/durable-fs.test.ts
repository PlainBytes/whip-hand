import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { posix } from '@whiphand/test-support';
import { RETRY_ATTEMPTS, removeTree, renameReplacing, tempNameFor, writeFileAtomic } from './durable-fs.ts';

const noSleep = { sleep: async () => {} };

function transient(code: string): Error {
  return Object.assign(new Error(code), { code });
}

test('renameReplacing retries a transient rename and then succeeds', async () => {
  // Windows only, in practice: MoveFileEx over a target someone else holds —
  // or is itself replacing — fails, where POSIX rename(2) just wins.
  let calls = 0;
  await renameReplacing('from', 'to', async () => {
    calls += 1;
    if (calls < 3) throw transient('EPERM');
  }, noSleep);
  assert.equal(calls, 3);
});

test('renameReplacing rethrows anything that is not transient, without retrying', async () => {
  let calls = 0;
  await assert.rejects(
    () => renameReplacing('from', 'to', async () => { calls += 1; throw transient('ENOENT'); }, noSleep),
    /ENOENT/,
  );
  assert.equal(calls, 1, 'a missing source is not going to appear');
});

test('renameReplacing gives up rather than retrying forever, and backs off', async () => {
  let calls = 0;
  const waits: number[] = [];
  await assert.rejects(
    () => renameReplacing('from', 'to', async () => { calls += 1; throw transient('EBUSY'); },
      { sleep: async ms => { waits.push(ms); } }),
    /EBUSY/,
  );
  assert.equal(calls, RETRY_ATTEMPTS);
  assert.equal(waits[0], 10);
  assert.ok(waits[1] > waits[0], 'the wait grows');
  assert.ok(Math.max(...waits) <= 250, 'and is capped');
});

test('tempNameFor is unique per call and lives beside the target', () => {
  const a = tempNameFor('/d/run.json');
  const b = tempNameFor('/d/run.json');
  assert.notEqual(a, b);
  assert.match(posix(a), /^\/d\/run\.json\.\d+\.[0-9a-f]{8}\.tmp$/);
});

test('writeFileAtomic replaces the target and leaves no temp behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wh-durable-'));
  const target = join(dir, 'state.json');
  await writeFileAtomic(target, 'one');
  await writeFileAtomic(target, 'two');
  assert.equal(await readFile(target, 'utf8'), 'two');
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('two writers to one file never clobber each other and never surface a torn write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wh-durable-'));
  const target = join(dir, 'state.json');
  const big = (c: string): string => JSON.stringify({ c, pad: c.repeat(50_000) });
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(target, big(i % 2 === 0 ? 'a' : 'b'))));
  const parsed = JSON.parse(await readFile(target, 'utf8')) as { c: string };
  assert.ok(parsed.c === 'a' || parsed.c === 'b');
  assert.deepEqual(await readdir(dir), ['state.json'], 'every temp was renamed away');
});

test('writeFileAtomic passes the mode through on POSIX', { skip: process.platform === 'win32' && 'fs modes are not enforceable on Windows' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wh-durable-'));
  const target = join(dir, 'token.json');
  await writeFileAtomic(target, 'secret', { mode: 0o600 });
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test('a failed rename cleans up its temp file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wh-durable-'));
  // The target is a non-empty directory, so the rename cannot succeed on any platform.
  const target = join(dir, 'blocked');
  await mkdir(join(target, 'inner'), { recursive: true });
  await writeFile(join(target, 'inner', 'f'), 'x');
  await assert.rejects(() => writeFileAtomic(target, 'data', noSleep));
  assert.deepEqual((await readdir(dir)).sort(), ['blocked']);
});

test('removeTree retries a transient failure, ignores a missing path and gives up on a persistent one', async () => {
  let calls = 0;
  await removeTree('x', async () => { calls += 1; if (calls < 3) throw transient('ENOTEMPTY'); }, noSleep);
  assert.equal(calls, 3);
  await removeTree(join(tmpdir(), 'wh-does-not-exist-x'));
  await assert.rejects(() => removeTree('x', async () => { throw transient('EBUSY'); }, noSleep), /EBUSY/);
  let other = 0;
  await assert.rejects(() => removeTree('x', async () => { other += 1; throw transient('EINVAL'); }, noSleep), /EINVAL/);
  assert.equal(other, 1);
});
