/**
 * The manual-step handoff over RPC. The case that matters most here is the
 * one nothing else covers: a run parked on a human is waiting on a promise
 * that no signal, timer, or child process will ever settle — only the client
 * answering, or cancellation explicitly tearing it down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontend } from './frontend.ts';
import { JobManager, answerManual, abandonManual } from './jobs.ts';
import { methods, notifications } from './protocol.ts';
import type { ManualRequest } from '@whiphand/core';

const request: ManualRequest = {
  stepId: 'sign', kind: 'approval', title: 'Ship it?', instructions: 'Look at the diff.',
  choices: ['continue', 'abort'], context: { artifacts: [] }, defaultChoice: 'continue',
};

function setup() {
  const jobs = new JobManager();
  const job = jobs.create('/w');
  const sent: Array<{ method: string; params: unknown }> = [];
  const frontend = createFrontend(job, (method, params) => sent.push({ method, params }), {});
  return { jobs, job, sent, frontend };
}

test('runManual notifies the client and parks until it is answered', async () => {
  const { job, sent, frontend } = setup();
  const pending = frontend.runManual!(request);

  const notification = sent.find(s => s.method === 'manualRequest');
  assert.ok(notification, 'the UI is told a human is needed');
  assert.deepEqual((notification.params as { request: ManualRequest }).request, request);
  assert.equal(job.pendingManual?.request.stepId, 'sign');

  assert.equal(answerManual(job, 'sign', 'continue', 'looks good'), true);
  assert.deepEqual(await pending, { choice: 'continue', note: 'looks good' });
  assert.equal(job.pendingManual, undefined);
  assert.ok(sent.some(s => s.method === 'manualResolved'));
});

test('a stale card naming a different step cannot answer the current one', async () => {
  const { job, frontend } = setup();
  const pending = frontend.runManual!(request);
  assert.equal(answerManual(job, 'some-other-step', 'abort'), false);
  assert.equal(job.pendingManual?.request.stepId, 'sign', 'still waiting on the real step');
  answerManual(job, 'sign', 'continue');
  await pending;
});

test('answering twice is a no-op, not a double settle', async () => {
  const { job, frontend } = setup();
  const pending = frontend.runManual!(request);
  assert.equal(answerManual(job, 'sign', 'continue'), true);
  assert.equal(answerManual(job, 'sign', 'abort'), false);
  assert.deepEqual(await pending, { choice: 'continue' });
});

test('cancelling a parked run rejects the question instead of hanging forever', async () => {
  const { job, frontend } = setup();
  const controller = new AbortController();
  const pending = frontend.runManual!(request, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(job.pendingManual, undefined);
});

test('abandonManual settles a parked question when the run ends underneath it', async () => {
  const { job, frontend } = setup();
  const pending = frontend.runManual!(request);
  abandonManual(job, 'run ended');
  await assert.rejects(pending, /run ended/);
});

test('abandonManual on a job with nothing parked is a no-op', () => {
  const { job } = setup();
  assert.doesNotThrow(() => abandonManual(job, 'run ended'));
});

test('runManual refuses a second concurrent question on the same job', async () => {
  const { job, frontend } = setup();
  const first = frontend.runManual!(request);
  await assert.rejects(frontend.runManual!({ ...request, stepId: 'other' }), /already waiting/);
  answerManual(job, 'sign', 'continue');
  await first;
});

test('an already-aborted signal never parks the run at all', async () => {
  const { job, frontend } = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(frontend.runManual!(request, controller.signal), /cancelled/);
  assert.equal(job.pendingManual, undefined);
});

test('resolveManual and the manual notifications are part of the declared surface', () => {
  assert.ok('resolveManual' in methods);
  assert.deepEqual(
    methods.resolveManual.params.parse({ jobId: 'j', stepId: 's', choice: 'retry' }),
    { jobId: 'j', stepId: 's', choice: 'retry' });
  assert.throws(() => methods.resolveManual.params.parse({ jobId: 'j', stepId: 's', choice: 'maybe' }));
  assert.ok('manualRequest' in notifications);
  assert.deepEqual(notifications.manualRequest.parse({ jobId: 'j', request }), { jobId: 'j', request });
});

test('startRun carries a maxIterations override over the wire', () => {
  assert.deepEqual(
    methods.startRun.params.parse({ workdir: '/w', workflow: 'r', maxIterations: 5 }),
    { workdir: '/w', workflow: 'r', maxIterations: 5 });
  assert.throws(() => methods.startRun.params.parse({ workdir: '/w', workflow: 'r', maxIterations: 0 }));
});

test('a per-iteration loop artifact is readable by its nested name', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { getRun, DEFAULT_CONFIG } = await import('@whiphand/core');

  const workdir = await mkdtemp(join(tmpdir(), 'whiphand-nested-'));
  const runId = '20260101-000000-abcd';
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(join(runDir, 'fix', 'iter-2'), { recursive: true });
  await writeFile(join(runDir, 'plan.md'), 'the plan\n');
  await writeFile(join(runDir, 'fix', 'iter-2', 'report.md'), 'attempt 2\n');
  await writeFile(join(runDir, 'events.ndjson'), '');

  const detail = await getRun(workdir, DEFAULT_CONFIG, runId);
  assert.ok(detail);
  // Bookkeeping stays hidden; every iteration's artifact is reachable, named
  // relative to the run dir — which is what readArtifact resolves against.
  assert.deepEqual(detail.artifacts.map(a => a.name), ['fix/iter-2/report.md', 'plan.md']);
});
