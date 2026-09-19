import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { pbkdf2 } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PosixContainer, type SpawnSpec } from '@whiphand/core';
import { ABORTED_EXIT_CODE, createSpawnHeadless } from './spawn.ts';

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

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
const windowsCounterpart = {
  skip: process.platform !== 'win32' ? 'Windows only: the counterpart of the POSIX signal-disposition tests' : false,
};

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

test('an ordinary (non-progress) spec still hands every line to onLine too, tagged with its stream', async () => {
  // Regression for the run-audit design: onLine used to be reserved for
  // progress specs; core now wants every headless spawn's output back, to
  // fold into step:log, on top of the stepLog notification it already got.
  const { calls, notify } = collectNotify();
  const spawnHeadless = createSpawnHeadless('job-1', notify);
  const seen: Array<{ line: string; stream: string }> = [];
  await spawnHeadless(
    nodeSpec("console.log('out1'); console.error('err1')"),
    undefined,
    (line, stream) => seen.push({ line, stream }),
  );
  seen.sort((a, b) => a.stream.localeCompare(b.stream));
  assert.deepEqual(seen, [{ line: 'err1', stream: 'stderr' }, { line: 'out1', stream: 'stdout' }]);
  // And the stepLog notification still went out exactly as before — onLine is additive.
  assert.equal(calls.filter(c => c.method === 'stepLog').length, 2);
});

test('abort settles at once with the sentinel exit code and still signals the child', posixSignals, async () => {
  const { notify } = collectNotify();
  let onReady: () => void;
  const ready = new Promise<void>(resolve => { onReady = resolve; });
  const spawnHeadless = createSpawnHeadless('job-1', (method, params) => {
    notify(method, params);
    if (method === 'stepLog' && (params as { line?: string }).line === 'ready') onReady();
  }, { killGraceMs: 200 });
  const controller = new AbortController();
  // The trap file proves the child was actually told to stop, not just abandoned:
  // settling at once must not mean leaving it running.
  const dir = mkdtempSync(join(tmpdir(), 'whiphand-abort-'));
  const trapFile = join(dir, 'terminated');
  const shSpec: SpawnSpec = {
    argv: ['/bin/sh', '-c', `trap "echo x > '${trapFile}'; exit 7" TERM; echo ready; sleep 5 >/dev/null 2>&1 & wait`],
    cwd: process.cwd(), env: {}, interactive: false,
  };
  const promise = spawnHeadless(shSpec, controller.signal);
  await ready;
  controller.abort();
  // Not the child's own 7: a cancel settles without waiting for 'close', which
  // waits on pipes an orphan may hold, so its exit status is not the result.
  assert.equal(await promise, ABORTED_EXIT_CODE);
  await waitFor(() => existsSync(trapFile));
});

test('a cancelled step in a container ends the whole tree, grandchildren included', posixSignals, async () => {
  const { notify } = collectNotify();
  const container = new PosixContainer(200);
  let onReady: () => void;
  const ready = new Promise<void>(resolve => { onReady = resolve; });
  const dir = mkdtempSync(join(tmpdir(), 'whiphand-tree-'));
  const pidFile = join(dir, 'grandchild.pid');
  const spawnHeadless = createSpawnHeadless('job-1', (method, params) => {
    notify(method, params);
    if (method === 'stepLog' && (params as { line?: string }).line === 'ready') onReady();
  }, { container });
  const controller = new AbortController();
  // A shell that starts a long-lived grandchild and waits, as a command step does.
  const spec: SpawnSpec = {
    argv: ['/bin/sh', '-c', `sleep 100 & echo $! > '${pidFile}'; echo ready; wait`],
    cwd: process.cwd(), env: {}, interactive: false,
  };
  const promise = spawnHeadless(spec, controller.signal);
  await ready;
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(pidAlive(grandchild), 'the grandchild is running');
  controller.abort();
  assert.equal(await promise, ABORTED_EXIT_CODE);
  await container.dispose();
  await waitFor(() => !pidAlive(grandchild));
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

test('the capture file is complete and closed by the time the promise resolves', async () => {
  // Regression: spawn.ts used to `end()` the capture stream and resolve in the
  // same breath, so core's footer (runner.ts appends it the moment the spawn
  // resolves) or auto-name's read-back could beat the last buffered write to
  // disk. On a quiet local disk that write nearly always wins anyway, so the
  // race is forced: fs writes run on libuv's threadpool and pipe reads do
  // not, so occupying every pool thread as the last line arrives holds its
  // write back while the child's 'close' still fires on time.
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-capture-close-'));
  const path = join(dir, 'out.log');
  const busy: Promise<void>[] = [];
  const spawnHeadless = createSpawnHeadless('job-1', (method, params) => {
    if (method !== 'stepLog' || (params as { line?: string }).line !== 'last') return;
    // Well past the default pool of 4, in case UV_THREADPOOL_SIZE was raised.
    for (let i = 0; i < 16; i++) {
      busy.push(new Promise(resolve => pbkdf2('k', 's', 200_000, 64, 'sha512', () => resolve())));
    }
  });
  const code = await spawnHeadless({ ...nodeSpec("console.log('first'); console.log('last')"), capture: { path } });
  assert.equal(code, 0);
  // Synchronously, before yielding to anything that could let a straggling
  // write land: this is what "closed at resolve time" has to mean.
  appendFileSync(path, 'FOOTER\n');
  assert.equal(await readFile(path, 'utf8'), 'first\nlast\nFOOTER\n');
  await Promise.all(busy);
  await rm(dir, { recursive: true, force: true });
});

test('abort on Windows settles at once and terminates the child — there is no signal disposition to honour', windowsCounterpart, async () => {
  // The Windows half of the two POSIX tests above: `child.kill` is
  // TerminateProcess, which nothing can catch, so there is no trap to assert and
  // no escalation to wait for. What must still hold is what holds everywhere:
  // the cancel settles with the sentinel, and the child does not survive it.
  const { notify, calls } = collectNotify();
  const spawnHeadless = createSpawnHeadless('job-1', notify, { killGraceMs: 200 });
  const controller = new AbortController();
  const promise = spawnHeadless(nodeSpec("console.log('pid ' + process.pid); setInterval(() => {}, 1000)"), controller.signal);
  await waitFor(() => calls.some(c => c.method === 'stepLog' && /^pid \d+$/.test(c.params.line)));
  const pid = Number(/pid (\d+)/.exec(calls.find(c => c.method === 'stepLog')!.params.line)![1]);
  controller.abort();
  assert.equal(await promise, ABORTED_EXIT_CODE);
  await waitFor(() => !pidAlive(pid));
});
