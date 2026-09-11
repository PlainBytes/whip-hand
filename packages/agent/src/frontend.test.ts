import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSpec } from '@whiphand/core';
import { createFrontend, type RunIdBox } from './frontend.ts';
import type { Job } from './jobs.ts';

function fakeJob(overrides: Partial<Job> = {}): Job {
  return {
    jobId: randomUUID(),
    workdir: process.cwd(),
    status: 'running',
    controller: new AbortController(),
    promise: Promise.resolve(),
    ptyCols: 80,
    ptyRows: 24,
    ...overrides,
  };
}

function collectNotify(): { calls: Array<{ method: string; params: any }>; notify: (m: string, p: unknown) => void } {
  const calls: Array<{ method: string; params: any }> = [];
  return { calls, notify: (method, params) => calls.push({ method, params }) };
}

function catSpec(): SpawnSpec {
  return { argv: ['cat'], cwd: process.cwd(), env: {}, interactive: true };
}

test('onEvent tags whiphandEvent and runStateChanged with the job workdir', () => {
  const job = fakeJob({ workdir: '/ws/acme' });
  const { calls, notify } = collectNotify();
  const runIdBox: RunIdBox = {};
  const frontend = createFrontend(job, notify, runIdBox);

  frontend.onEvent({ type: 'run:start', runId: 'run-1', workflow: 'demo' });

  const event = calls.find(c => c.method === 'whiphandEvent');
  assert.equal(event?.params.workdir, '/ws/acme');
  const state = calls.find(c => c.method === 'runStateChanged');
  assert.equal(state?.params.workdir, '/ws/acme');
});

test('runInteractive spawns a PTY, emits ptyStarted with default 80x24, and resolves with the exit code', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const runIdBox: RunIdBox = {};
  const frontend = createFrontend(job, notify, runIdBox);

  frontend.onEvent({ type: 'step:start', stepId: 'chat', kind: 'agent', runner: 'claude', mode: 'interactive' });
  const promise = frontend.runInteractive({ argv: ['bash', '-c', 'exit 0'], cwd: process.cwd(), env: {}, interactive: true });
  const exitCode = await promise;

  assert.equal(exitCode, 0);
  const started = calls.find(c => c.method === 'ptyStarted');
  assert.deepEqual(started?.params, { jobId: job.jobId, stepId: 'chat', cols: 80, rows: 24 });
  const exit = calls.find(c => c.method === 'ptyExit');
  assert.deepEqual(exit?.params, { jobId: job.jobId, exitCode: 0, reason: 'exit' });
  assert.equal(job.pty, undefined, 'job.pty is cleared once the pty exits');
});

test('runInteractive with no preceding step:start falls back to a sensible stepId instead of crashing', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {});

  await frontend.runInteractive({ argv: ['bash', '-c', 'exit 0'], cwd: process.cwd(), env: {}, interactive: true });

  const started = calls.find(c => c.method === 'ptyStarted');
  assert.equal(typeof started?.params.stepId, 'string');
  assert.ok(started!.params.stepId.length > 0);
});

test('ptyData notifications carry base64 and round-trip to the original bytes', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {});

  await frontend.runInteractive({ argv: ['bash', '-c', 'echo marker-xyz'], cwd: process.cwd(), env: {}, interactive: true });

  const dataEvents = calls.filter(c => c.method === 'ptyData');
  const decoded = dataEvents.map(c => Buffer.from(c.params.data, 'base64').toString('utf8')).join('');
  assert.ok(decoded.includes('marker-xyz'), `expected marker in decoded output, got: ${decoded}`);
});

test('a second concurrent runInteractive on the same job is rejected: only one live PTY per job', async () => {
  const job = fakeJob();
  const { notify } = collectNotify();
  const frontend = createFrontend(job, notify, {});

  const first = frontend.runInteractive(catSpec());
  // give the first pty a tick to register itself on the job before the second call
  await new Promise(r => setTimeout(r, 20));
  assert.ok(job.pty, 'first pty should be live');

  await assert.rejects(() => frontend.runInteractive(catSpec()), /already has a live PTY/);

  job.pty!.kill();
  await first;
});

test('an aborted signal kills the interactive PTY and the promise still resolves', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {});
  const controller = new AbortController();

  const promise = frontend.runInteractive(catSpec(), controller.signal);
  await new Promise(r => setTimeout(r, 20));
  controller.abort();
  const exitCode = await promise;

  assert.equal(typeof exitCode, 'number');
  assert.ok(calls.some(c => c.method === 'ptyExit'));
});

test('job.ptyCols/ptyRows (as updated by a ptyResize rpc call) are used as defaults for the next PTY', async () => {
  const job = fakeJob({ ptyCols: 120, ptyRows: 40 });
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {});

  await frontend.runInteractive({ argv: ['bash', '-c', 'exit 0'], cwd: process.cwd(), env: {}, interactive: true });

  const started = calls.find(c => c.method === 'ptyStarted');
  assert.equal(started?.params.cols, 120);
  assert.equal(started?.params.rows, 40);
});

// --- ending a session -------------------------------------------------------
//
// `cat` stands in for a runner's REPL: it never exits on its own, so these
// tests only pass if whiphand is what closes the session.

const FAST = { markerPollMs: 10, termGraceMs: 30, killGraceMs: 30, awaitPollMs: 10 };

async function endableSpec(): Promise<{ spec: SpawnSpec; marker: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-frontend-'));
  const marker = join(dir, '.plan.done');
  return { spec: { ...catSpec(), endSession: { markerPath: marker, quitSequence: '' } }, marker };
}

test('the marker appearing closes the session and reports success, not the kill code', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);
  const { spec, marker } = await endableSpec();

  const promise = frontend.runInteractive(spec);
  await new Promise(r => setTimeout(r, 20));
  await writeFile(marker, '');
  const exitCode = await promise;

  assert.equal(exitCode, 0, 'runWorkflow fails the step on any nonzero code');
  const exit = calls.find(c => c.method === 'ptyExit');
  assert.deepEqual(exit?.params, { jobId: job.jobId, exitCode: 0, reason: 'ended' });
  assert.equal(job.pty, undefined);
  assert.equal(job.endSession, undefined);
});

test('the human is told why the terminal is closing', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);
  const { spec, marker } = await endableSpec();

  const promise = frontend.runInteractive(spec);
  await new Promise(r => setTimeout(r, 20));
  await writeFile(marker, '');
  await promise;

  const decoded = calls
    .filter(c => c.method === 'ptyData')
    .map(c => Buffer.from(c.params.data, 'base64').toString('utf8'))
    .join('');
  assert.ok(decoded.includes('[whiphand] step complete'), decoded);
});

test('job.endSession takes the same path as the marker', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);
  const { spec } = await endableSpec();

  const promise = frontend.runInteractive(spec);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(typeof job.endSession, 'function', 'the endSession rpc reaches the live session here');
  job.endSession!('user');
  job.endSession!('user'); // latched: a double click must not start a second teardown
  const exitCode = await promise;

  assert.equal(exitCode, 0);
  assert.equal(calls.filter(c => c.method === 'ptyExit').length, 1);
});

test('a session that exits on its own still reports its real code', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);
  const { spec } = await endableSpec();

  const exitCode = await frontend.runInteractive({ ...spec, argv: ['bash', '-c', 'exit 3'] });

  assert.equal(exitCode, 3, 'the end-session machinery must not mask a genuine failure');
  const exit = calls.find(c => c.method === 'ptyExit');
  assert.deepEqual(exit?.params, { jobId: job.jobId, exitCode: 3, reason: 'exit' });
});

test('the marker watcher stops with the pty, so a later marker changes nothing', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);
  const { spec, marker } = await endableSpec();

  await frontend.runInteractive({ ...spec, argv: ['bash', '-c', 'exit 0'] });
  const after = calls.length;
  await writeFile(marker, '');
  await new Promise(r => setTimeout(r, 50));

  assert.equal(calls.length, after, 'no notifications after the session is over');
});

test('a spec without endSession behaves exactly as before: the human quits it', async () => {
  const job = fakeJob();
  const { notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);

  const promise = frontend.runInteractive(catSpec());
  await new Promise(r => setTimeout(r, 20));

  assert.equal(job.endSession, undefined, 'nothing to end it with');
  job.pty!.kill();
  await promise;
});

test('a pty that dies immediately leaves no live-session bookkeeping behind', async () => {
  const job = fakeJob();
  const { notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);
  const { spec } = await endableSpec();

  await frontend.runInteractive({ ...spec, argv: ['bash', '-c', 'exit 1'] });

  assert.equal(job.pty, undefined, 'a dead handle must not stay pinned to the job');
  assert.equal(job.endSession, undefined);
});

// --- reporting that the session is blocked on the human -------------------

async function awaitingSpec(): Promise<{ spec: SpawnSpec; statePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-awaiting-'));
  const statePath = join(dir, '.plan.await');
  return { spec: { ...catSpec(), awaitState: { statePath } }, statePath };
}

function awaits(calls: Array<{ method: string; params: any }>): any[] {
  return calls.filter(c => c.method === 'ptyAwait').map(c => c.params);
}

test('a hook writing the state file reports the session as blocked, then working again', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);
  const { spec, statePath } = await awaitingSpec();

  frontend.onEvent({ type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive' });
  const promise = frontend.runInteractive(spec);
  await new Promise(r => setTimeout(r, 20));

  await writeFile(statePath, '{"r":"turn"}');
  await new Promise(r => setTimeout(r, 40));
  await rm(statePath);
  await new Promise(r => setTimeout(r, 40));

  assert.deepEqual(awaits(calls), [
    { jobId: job.jobId, stepId: 'plan', awaiting: true, reason: 'turn' },
    { jobId: job.jobId, stepId: 'plan', awaiting: false, reason: undefined },
  ]);
  job.pty!.kill();
  await promise;
});

test('an unchanged state is not re-reported on every poll', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);
  const { spec, statePath } = await awaitingSpec();

  const promise = frontend.runInteractive(spec);
  await new Promise(r => setTimeout(r, 20));
  await writeFile(statePath, '{"r":"turn"}');
  await new Promise(r => setTimeout(r, 80));

  assert.equal(awaits(calls).length, 1);
  job.pty!.kill();
  await promise;
});

/**
 * These three drive `bash -c "printf '\a'; exec cat"` and, on Windows, the BEL
 * never reaches the scanner. The cause is NOT that ConPTY drops bells: a BEL
 * written directly by a node child does arrive, which pty.test.ts's "onBell
 * fires for a real beep" proves on the same leg. Something about `printf`
 * inside Git Bash under ConPTY is eating it, and that is still unexplained.
 *
 * Skipped rather than diagnosed because the scanner itself is covered directly
 * by bel.test.ts and end to end by pty.test.ts. The way to get these back is to
 * emit the BEL from a `node -e` child as pty.test.ts does — which also means
 * raising the 60ms waits below, since node takes about a second to start.
 */
const noBellOnConpty = {
  skip: process.platform === 'win32' && "a BEL from bash's printf does not reach the scanner",
};

test('a terminal bell reports attention even with no hooks to watch', noBellOnConpty, async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);

  // No awaitState: this is the copilot-shaped path.
  const promise = frontend.runInteractive({
    ...catSpec(), argv: ['bash', '-c', String.raw`printf '\a'; exec cat`] });
  await new Promise(r => setTimeout(r, 60));

  assert.deepEqual(awaits(calls).map(p => p.reason), ['attention']);
  job.pty!.kill();
  await promise;
});

test('a window-title sequence is not mistaken for a bell', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);

  const promise = frontend.runInteractive({
    ...catSpec(), argv: ['bash', '-c', String.raw`printf '\033]0;title\a'; exec cat`] });
  await new Promise(r => setTimeout(r, 60));

  assert.deepEqual(awaits(calls), [], 'claude repaints its title constantly');
  job.pty!.kill();
  await promise;
});

test('a bell never downgrades a state the hooks actually reported', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);
  const { spec, statePath } = await awaitingSpec();
  await writeFile(statePath, '{"r":"permission"}');

  const promise = frontend.runInteractive({
    ...spec, argv: ['bash', '-c', String.raw`sleep 0.1; printf '\a'; exec cat`] });
  await new Promise(r => setTimeout(r, 200));

  assert.deepEqual(awaits(calls).map(p => p.reason), ['permission']);
  job.pty!.kill();
  await promise;
});

test('clearBell withdraws an attention report', noBellOnConpty, async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);

  const promise = frontend.runInteractive({
    ...catSpec(), argv: ['bash', '-c', String.raw`printf '\a'; exec cat`] });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(typeof job.clearBell, 'function');
  job.clearBell!();

  assert.deepEqual(awaits(calls).map(p => p.awaiting), [true, false]);
  job.pty!.kill();
  await promise;
});

test('ptyAwait never arrives before ptyStarted', noBellOnConpty, async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);

  const promise = frontend.runInteractive({
    ...catSpec(), argv: ['bash', '-c', String.raw`printf '\a'; exec cat`] });
  await new Promise(r => setTimeout(r, 60));

  const started = calls.findIndex(c => c.method === 'ptyStarted');
  const awaited = calls.findIndex(c => c.method === 'ptyAwait');
  assert.ok(started >= 0 && awaited > started, `ptyStarted at ${started}, ptyAwait at ${awaited}`);
  job.pty!.kill();
  await promise;
});

test('the state watcher stops with the pty, and the session sends no parting ptyAwait', async () => {
  const job = fakeJob();
  const { calls, notify } = collectNotify();
  const frontend = createFrontend(job, notify, {}, FAST);
  const { spec, statePath } = await awaitingSpec();

  await frontend.runInteractive({ ...spec, argv: ['bash', '-c', 'exit 0'] });
  const after = calls.length;
  await writeFile(statePath, '{"r":"turn"}');
  await new Promise(r => setTimeout(r, 50));

  assert.equal(calls.length, after, 'nothing is reported once the session is over');
  assert.equal(job.clearBell, undefined);
});
