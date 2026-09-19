import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandlers } from './handlers.ts';
import { JobManager } from './jobs.ts';
import { AppStateStore } from './app-state.ts';
import { createScrollback } from './scrollback.ts';
import { createNotifyHub } from './notify-hub.ts';
import type { JobSummary, JobScrollbackResult } from './protocol.ts';

async function harness() {
  const jobs = new JobManager();
  const scrollback = createScrollback();
  const hub = createNotifyHub((m, p) => scrollback.record(m, p));
  const appState = new AppStateStore(join(await mkdtemp(join(tmpdir(), 'whiphand-attach-')), 'a.json'));
  const handlers = createHandlers({ jobs, notify: hub.notify, appState, scrollback });
  return { jobs, hub, handlers, scrollback };
}

const ctx = { notify: () => {} };

test('listJobs reveals a run that started before this client connected', async () => {
  const { jobs, handlers } = await harness();
  const job = jobs.create('/ws');
  job.runId = 'run-1';

  const result = await handlers.listJobs!({}, ctx) as JobSummary[];

  assert.equal(result.length, 1);
  assert.equal(result[0]!.jobId, job.jobId);
  assert.equal(result[0]!.workdir, '/ws');
  assert.equal(result[0]!.runId, 'run-1');
  assert.equal(result[0]!.status, 'running');
  assert.equal(result[0]!.pty, null, 'no interactive session open');
});

test('listJobs carries the job identity key so a client can tell which workspace it belongs to', async () => {
  const { jobs, handlers } = await harness();
  jobs.create('/link', '/real/ws');
  jobs.create('/other');

  const result = await handlers.listJobs!({}, ctx) as JobSummary[];
  assert.equal(result[0]!.identityKey, '/real/ws');
  assert.equal(result[1]!.identityKey, undefined);
});

test('listJobs reports the live pty, with the step id only the transcript knows', async () => {
  const { jobs, hub, handlers } = await harness();
  const job = jobs.create('/ws');
  // Job tracks the handle; which STEP opened it is only on the wire.
  job.pty = {} as never;
  job.ptyCols = 120;
  job.ptyRows = 40;
  hub.notify('ptyStarted', { jobId: job.jobId, stepId: 'implement', cols: 80, rows: 24 });

  const result = await handlers.listJobs!({}, ctx) as JobSummary[];

  assert.deepEqual(result[0]!.pty, { stepId: 'implement', cols: 120, rows: 40 });
});

test('listJobs carries the run name the frontend recorded on the job', async () => {
  const { jobs, handlers } = await harness();
  const job = jobs.create('/ws');
  job.runName = 'OAuth support';

  const result = await handlers.listJobs!({}, ctx) as JobSummary[];
  assert.equal(result[0]!.name, 'OAuth support');
});

test('listJobs omits the name for a run that never got one', async () => {
  const { jobs, handlers } = await harness();
  jobs.create('/ws');

  const result = await handlers.listJobs!({}, ctx) as JobSummary[];
  assert.equal(result[0]!.name, undefined);
});

test('listJobs surfaces a job parked on a human, which is the one a client must not miss', async () => {
  const { jobs, handlers } = await harness();
  const job = jobs.create('/ws');
  const request = { stepId: 'approve', prompt: 'Ship it?', choices: [] } as never;
  job.pendingManual = { request, answer: () => {}, reject: () => {} };

  const result = await handlers.listJobs!({}, ctx) as JobSummary[];
  assert.equal(result[0]!.pendingManual, request);
});

test('getJobScrollback returns the transcript recorded off the wire', async () => {
  const { jobs, hub, handlers } = await harness();
  const job = jobs.create('/ws');
  hub.notify('ptyStarted', { jobId: job.jobId, stepId: 's1', cols: 80, rows: 24 });
  hub.notify('ptyData', { jobId: job.jobId, data: 'aGk=' });
  hub.notify('ptyData', { jobId: job.jobId, data: 'eW8=' });
  hub.notify('stepLog', { jobId: job.jobId, stream: 'stdout', line: 'building' });

  const snapshot = await handlers.getJobScrollback!(
    { jobId: job.jobId }, ctx) as JobScrollbackResult;

  assert.deepEqual(snapshot.pty!.chunks, ['aGk=', 'eW8=']);
  assert.equal(snapshot.pty!.baseIndex, 0);
  assert.equal(snapshot.pty!.stepId, 's1');
  assert.deepEqual(snapshot.logs.lines, [{ stream: 'stdout', line: 'building' }]);
});

test('every ptyData on the wire carries the seq that indexes it', async () => {
  const { jobs, hub, handlers } = await harness();
  const job = jobs.create('/ws');
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  hub.addSink((method, params) => sent.push({ method, params: params as Record<string, unknown> }));

  hub.notify('ptyStarted', { jobId: job.jobId, stepId: 's1', cols: 80, rows: 24 });
  hub.notify('ptyData', { jobId: job.jobId, data: 'a' });
  hub.notify('ptyData', { jobId: job.jobId, data: 'b' });

  const chunks = sent.filter(m => m.method === 'ptyData');
  assert.deepEqual(chunks.map(c => c.params.seq), [0, 1]);

  // And the seq a client received really does index the snapshot it fetches.
  const snapshot = await handlers.getJobScrollback!({ jobId: job.jobId }, ctx) as JobScrollbackResult;
  for (const chunk of chunks) {
    const seq = chunk.params.seq as number;
    assert.equal(snapshot.pty!.chunks[seq - snapshot.pty!.baseIndex], chunk.params.data);
  }
});

test('getJobScrollback is null, not an error, for a job with no transcript', async () => {
  const { handlers } = await harness();
  assert.equal(await handlers.getJobScrollback!({ jobId: 'nope' }, ctx), null);
});

test('an agent built without a scrollback still answers both methods', async () => {
  const jobs = new JobManager();
  const appState = new AppStateStore(join(await mkdtemp(join(tmpdir(), 'whiphand-attach-')), 'a.json'));
  const handlers = createHandlers({ jobs, notify: () => {}, appState });
  jobs.create('/ws');

  const list = await handlers.listJobs!({}, ctx) as JobSummary[];
  assert.equal(list.length, 1);
  assert.equal(await handlers.getJobScrollback!({ jobId: list[0]!.jobId }, ctx), null);
});
