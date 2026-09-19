import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobManager } from './jobs.ts';

test('list returns every registered job so shutdown can abort them all', () => {
  const jobs = new JobManager();
  assert.deepEqual(jobs.list(), []);

  const a = jobs.create('/ws-a');
  const b = jobs.create('/ws-b');
  b.status = 'succeeded';

  // main.ts's SIGTERM handler relies on this to find in-flight runs; without
  // it the manager was write-only and a signal could abort nothing.
  assert.deepEqual(jobs.list().map(j => j.jobId), [a.jobId, b.jobId]);
  assert.deepEqual(jobs.list().filter(j => j.status === 'running').map(j => j.jobId), [a.jobId]);
});

test('list is a snapshot: mutating it does not affect the manager', () => {
  const jobs = new JobManager();
  const job = jobs.create('/ws');
  jobs.list().length = 0;
  assert.equal(jobs.list().length, 1);
  assert.equal(jobs.get(job.jobId), job);
});

test('a fresh job has no live session: what handlers.endSession checks before acting', () => {
  const job = new JobManager().create('/ws');
  assert.equal(job.pty, undefined);
  assert.equal(job.endSession, undefined);
});

test('a job carries the identity key its workspace was opened under, when there is one', () => {
  const jobs = new JobManager();
  assert.equal(jobs.create('/ws').identityKey, undefined);
  assert.equal(jobs.create('/link', '/real/ws').identityKey, '/real/ws');
});
