import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginGracefulEnd, watchForMarker } from './session-end.ts';
import type { PtyHandle } from './pty.ts';

const tick = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function recordingPty(): { calls: string[]; pty: PtyHandle } {
  const calls: string[] = [];
  return {
    calls,
    pty: {
      write: b64 => calls.push(`write:${Buffer.from(b64, 'base64').toString('utf8')}`),
      resize: () => {},
      kill: signal => calls.push(`kill:${signal ?? 'default'}`),
    },
  };
}

test('watchForMarker fires once the marker appears', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-watch-'));
  const marker = join(dir, '.plan.done');
  let fired = 0;
  const watcher = watchForMarker(marker, () => { fired += 1; }, 10);

  await tick(40);
  assert.equal(fired, 0, 'nothing to see yet');
  await writeFile(marker, '');
  await tick(60);

  assert.equal(fired, 1);
  watcher.stop();
});

test('watchForMarker fires for a marker that was already there', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-watch-'));
  const marker = join(dir, '.plan.done');
  await writeFile(marker, '');

  let fired = 0;
  const watcher = watchForMarker(marker, () => { fired += 1; }, 10);
  await tick(40);

  assert.equal(fired, 1, 'fires once, not once per poll');
  watcher.stop();
});

test('a stopped watcher never calls back, even if the marker shows up later', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-watch-'));
  const marker = join(dir, '.plan.done');
  let fired = 0;
  const watcher = watchForMarker(marker, () => { fired += 1; }, 10);

  watcher.stop();
  await writeFile(marker, '');
  await tick(50);

  assert.equal(fired, 0);
});

test('beginGracefulEnd asks politely, then escalates SIGTERM and SIGKILL', async () => {
  const { calls, pty } = recordingPty();
  beginGracefulEnd(pty, '/exit\r', { termGraceMs: 20, killGraceMs: 20 });

  assert.deepEqual(calls, ['write:/exit\r'], 'the quit sequence goes first');
  await tick(35);
  assert.deepEqual(calls, ['write:/exit\r', 'kill:SIGTERM']);
  await tick(35);
  assert.deepEqual(calls, ['write:/exit\r', 'kill:SIGTERM', 'kill:SIGKILL']);
});

test('cancelling a graceful end stops both escalations', async () => {
  const { calls, pty } = recordingPty();
  const cancel = beginGracefulEnd(pty, '/exit\r', { termGraceMs: 20, killGraceMs: 20 });

  cancel();
  await tick(60);

  assert.deepEqual(calls, ['write:/exit\r'], 'the process exited on its own; nothing to kill');
});

test('an empty quit sequence goes straight to signals', async () => {
  const { calls, pty } = recordingPty();
  beginGracefulEnd(pty, '', { termGraceMs: 20, killGraceMs: 20 });

  await tick(20);
  assert.deepEqual(calls, ['kill:SIGTERM']);
});
