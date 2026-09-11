import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSpec } from '@whiphand/core';
import { createSpawnHeadless } from './spawn.ts';

/**
 * `node -e` rather than `/bin/sh -c`: these tests are about how spawn.ts
 * handles a child's streams and exit, not about any particular shell, and
 * `/bin/sh` does not exist on the Windows CI leg.
 */
function nodeSpec(script: string): SpawnSpec {
  return { argv: [process.execPath, '-e', script], cwd: process.cwd(), env: {}, interactive: false };
}

/**
 * The two abort tests below are about POSIX signal *disposition* — a child
 * trapping SIGTERM, and a child ignoring it until SIGKILL. Windows has no
 * equivalent: `child.kill` there is TerminateProcess, which nothing can catch,
 * so there is no behaviour to assert rather than a behaviour that differs.
 */
const posixSignals = { skip: process.platform === 'win32' ? 'POSIX signal semantics' : false };

function collectNotify(): { calls: Array<{ method: string; params: any }>; notify: (m: string, p: unknown) => void } {
  const calls: Array<{ method: string; params: any }> = [];
  return { calls, notify: (method, params) => calls.push({ method, params }) };
}

test('resolves with the child exit code', async () => {
  const { notify } = collectNotify();
  const spawnHeadless = createSpawnHeadless('job-1', notify);
  const code = await spawnHeadless(nodeSpec('process.exit(3)'));
  assert.equal(code, 3);
});

test('forwards each stdout/stderr line as a stepLog notification', async () => {
  const { calls, notify } = collectNotify();
  const spawnHeadless = createSpawnHeadless('job-1', notify);
  await spawnHeadless(nodeSpec("console.log('out1'); console.log('out2'); console.error('err1')"));
  // Per stream, not across them: stdout and stderr are separate pipes with no
  // ordering guarantee between them, and on Windows err1 does arrive before
  // out2. What this test is actually about is that every line is forwarded,
  // once, in order, tagged with the stream it came from.
  const logs = calls.filter(c => c.method === 'stepLog');
  const lines = (stream: string): unknown[] =>
    logs.filter(l => l.params.stream === stream).map(l => l.params);
  assert.deepEqual(lines('stdout'), [
    { jobId: 'job-1', stream: 'stdout', line: 'out1' },
    { jobId: 'job-1', stream: 'stdout', line: 'out2' },
  ]);
  assert.deepEqual(lines('stderr'), [
    { jobId: 'job-1', stream: 'stderr', line: 'err1' },
  ]);
});

test('abort sends SIGTERM and the promise resolves once the child exits', posixSignals, async () => {
  const { notify } = collectNotify();
  let onReady: () => void;
  const ready = new Promise<void>(resolve => { onReady = resolve; });
  const spawnHeadless = createSpawnHeadless('job-1', (method, params) => {
    notify(method, params);
    if (method === 'stepLog' && (params as { line?: string }).line === 'ready') onReady();
  }, { killGraceMs: 200 });
  const controller = new AbortController();
  // The backgrounded sleep's stdio is redirected away from the inherited
  // pipe fds (>/dev/null) so it can't keep resolving on 'close' waiting on
  // it — with the sh process (fd holder) exiting on trap, 'close' fires as
  // soon as that happens rather than waiting out an unrelated orphan.
  // The 'ready' echo guarantees the trap is installed before we abort;
  // aborting immediately after spawn can deliver SIGTERM before /bin/sh
  // has set the trap, killing it with the default disposition.
  const shSpec: SpawnSpec = {
    argv: ['/bin/sh', '-c', 'trap "exit 7" TERM; echo ready; sleep 5 >/dev/null 2>&1 & wait'],
    cwd: process.cwd(), env: {}, interactive: false,
  };
  const promise = spawnHeadless(shSpec, controller.signal);
  await ready;
  controller.abort();
  const code = await promise;
  assert.equal(code, 7);
});

test('abort escalates to SIGKILL after the grace period if the child ignores SIGTERM', posixSignals, async () => {
  const { notify } = collectNotify();
  const spawnHeadless = createSpawnHeadless('job-1', notify, { killGraceMs: 50 });
  const controller = new AbortController();
  const shSpec: SpawnSpec = {
    argv: ['/bin/sh', '-c', 'trap "" TERM; sleep 5 >/dev/null 2>&1'],
    cwd: process.cwd(), env: {}, interactive: false,
  };
  const promise = spawnHeadless(shSpec, controller.signal);
  controller.abort();
  const code = await promise;
  assert.notEqual(code, 0);
});

test('does not drop tail output: every line survives a fast-exiting, high-volume writer', async () => {
  // A process that writes far more than one pipe buffer's worth of output and
  // exits immediately can race Node's 'exit' event against its stdio pipes
  // still draining ('exit' fires on process reap and is not guaranteed to
  // wait for stdio to finish; per the child_process docs, 'close' "will
  // always emit after 'exit'" and specifically once "the stdio streams of a
  // child process have been closed" — i.e. once every byte has been
  // delivered). This test exercises that high-volume path end-to-end and
  // pins the "every line arrives" contract as a regression guard; the race
  // itself is OS-scheduling-dependent and did not reproduce as a flake on
  // this sandbox even at higher volumes, so this does not on its own prove
  // the old exit-based code was buggy here — the fix is applied on the
  // documented 'exit' vs 'close' semantics, not on a forced local repro.
  const LINE_COUNT = 500_000;
  const { calls, notify } = collectNotify();
  const spawnHeadless = createSpawnHeadless('job-1', notify);
  const code = await spawnHeadless(nodeSpec(`for (let i = 1; i <= ${LINE_COUNT}; i++) console.log(i)`));
  assert.equal(code, 0);
  const lines = calls.filter(c => c.method === 'stepLog' && c.params.stream === 'stdout');
  assert.equal(lines.length, LINE_COUNT, 'no stdout line should be dropped');
  assert.equal(lines[0].params.line, '1');
  assert.equal(lines[LINE_COUNT - 1].params.line, String(LINE_COUNT));
});

test('capture.streams narrows the file without narrowing the log panel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-capture-'));
  const both = join(dir, 'both.log');
  const only = join(dir, 'stdout.log');
  const script = "console.log('answer'); console.error('warning: deprecated flag')";

  const { calls, notify } = collectNotify();
  const spawnHeadless = createSpawnHeadless('job-1', notify);
  await spawnHeadless({ ...nodeSpec(script), capture: { path: both } });
  await spawnHeadless({ ...nodeSpec(script), capture: { path: only, streams: 'stdout' } });

  // A command step's artifact keeps stderr — that is where a failure explains
  // itself. A run name's capture does not, or the warning becomes the name.
  assert.match(await readFile(both, 'utf8'), /warning: deprecated flag/);
  assert.equal(await readFile(only, 'utf8'), 'answer\n');
  // Either way the operator sees both streams.
  assert.equal(
    calls.filter(c => c.method === 'stepLog' && c.params.stream === 'stderr').length, 2,
  );
  await rm(dir, { recursive: true, force: true });
});

// --- progress specs -------------------------------------------------------

function progressSpec(script: string): SpawnSpec {
  return { ...nodeSpec(script), progress: { format: 'claude-stream-json' } };
}

test('a progress spec routes stdout to onLine instead of the log', async () => {
  const { calls, notify } = collectNotify();
  const seen: string[] = [];
  const spawnHeadless = createSpawnHeadless('job-1', notify);
  await spawnHeadless(progressSpec("console.log('one'); console.log('two')"), undefined, l => seen.push(l));
  assert.deepEqual(seen, ['one', 'two']);
  assert.deepEqual(
    calls.filter(c => c.method === 'stepLog' && c.params.stream === 'stdout'),
    [],
    'raw structured output must never reach the log panel',
  );
});

test('a progress spec still logs stderr, where real errors arrive', async () => {
  const { calls, notify } = collectNotify();
  const spawnHeadless = createSpawnHeadless('job-1', notify);
  await spawnHeadless(progressSpec("console.error('boom')"), undefined, () => {});
  assert.deepEqual(calls.filter(c => c.method === 'stepLog').map(c => c.params), [
    { jobId: 'job-1', stream: 'stderr', line: 'boom' },
  ]);
});

test('a progress spec with no reader falls back to logging stdout', async () => {
  // Belt and braces: a frontend that ignores onLine must not silently
  // swallow the child's output altogether.
  const { calls, notify } = collectNotify();
  const spawnHeadless = createSpawnHeadless('job-1', notify);
  await spawnHeadless(progressSpec("console.log('one')"));
  assert.deepEqual(calls.filter(c => c.method === 'stepLog').map(c => c.params.line), ['one']);
});
