import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunJournal } from './manifest.ts';
import { setRunLocked } from './run-lock.ts';
import { deleteRun, pruneRuns } from './retention.ts';
import { DEFAULT_CONFIG } from '../config.ts';

async function tmpWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'whiphand-retention-'));
}

function baseInit(runDir: string, runId: string) {
  return {
    runDir, runId, workflow: 'r', workdir: '/work', dryRun: false,
    inputs: {}, sessionIds: {},
    steps: [{ id: 'a', kind: 'agent' as const, runner: 'fake', mode: 'headless' as const }],
  };
}

/** Writes a real run.json under workdir/.whiphand/runs/<runId>, 'running' unless `done`. */
async function makeRun(workdir: string, runId: string, opts: { done?: boolean } = {}): Promise<string> {
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  const journal = new RunJournal(baseInit(runDir, runId));
  journal.record({ type: 'run:start', runId, workflow: 'r' });
  if (opts.done) journal.record({ type: 'run:done', runId, ok: true });
  await journal.flush();
  return runDir;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

// --- deleteRun ---------------------------------------------------------

test('deleteRun removes an eligible run directory outright', async () => {
  const workdir = await tmpWorkdir();
  const runDir = await makeRun(workdir, 'r1', { done: true });

  const result = await deleteRun(workdir, DEFAULT_CONFIG, 'r1');
  assert.deepEqual(result, { deleted: true });
  assert.equal(await exists(runDir), false);
});

test('deleteRun refuses a locked run', async () => {
  const workdir = await tmpWorkdir();
  const runDir = await makeRun(workdir, 'r1', { done: true });
  await setRunLocked(runDir, true);

  const result = await deleteRun(workdir, DEFAULT_CONFIG, 'r1');
  assert.deepEqual(result, { deleted: false, reason: 'locked' });
  assert.equal(await exists(runDir), true);
});

test('deleteRun refuses a still-running run', async () => {
  const workdir = await tmpWorkdir();
  const runDir = await makeRun(workdir, 'r1'); // no run:done: stays 'running'

  const result = await deleteRun(workdir, DEFAULT_CONFIG, 'r1');
  assert.deepEqual(result, { deleted: false, reason: 'running' });
  assert.equal(await exists(runDir), true);
});

test('deleteRun reports missing for an absent runId', async () => {
  const workdir = await tmpWorkdir();
  const result = await deleteRun(workdir, DEFAULT_CONFIG, 'does-not-exist');
  assert.deepEqual(result, { deleted: false, reason: 'missing' });
});

test('deleteRun refuses a path-traversal runId as missing, without touching the filesystem', async () => {
  const workdir = await tmpWorkdir();
  const result = await deleteRun(workdir, DEFAULT_CONFIG, '../escape');
  assert.deepEqual(result, { deleted: false, reason: 'missing' });
});

// --- pruneRuns -----------------------------------------------------------

test('pruneRuns: null or 0 is a no-op', async () => {
  const workdir = await tmpWorkdir();
  await makeRun(workdir, '20260101-000000-aaaa', { done: true });
  await makeRun(workdir, '20260101-000001-bbbb', { done: true });

  assert.deepEqual(await pruneRuns(workdir, DEFAULT_CONFIG, null), { deleted: [], failed: [] });
  assert.deepEqual(await pruneRuns(workdir, DEFAULT_CONFIG, 0), { deleted: [], failed: [] });
});

test('pruneRuns: deletes oldest-first by runId once the count exceeds max', async () => {
  const workdir = await tmpWorkdir();
  const ids = [
    '20260101-000000-r1', '20260101-000001-r2', '20260101-000002-r3',
    '20260101-000003-r4', '20260101-000004-r5',
  ];
  for (const id of ids) await makeRun(workdir, id, { done: true });

  const result = await pruneRuns(workdir, DEFAULT_CONFIG, 3);
  assert.deepEqual(result.deleted, ['20260101-000000-r1', '20260101-000001-r2']);
  assert.equal(await exists(join(workdir, DEFAULT_CONFIG.artifacts_dir, '20260101-000000-r1')), false);
  assert.equal(await exists(join(workdir, DEFAULT_CONFIG.artifacts_dir, '20260101-000001-r2')), false);
  assert.equal(await exists(join(workdir, DEFAULT_CONFIG.artifacts_dir, '20260101-000002-r3')), true);
});

test('pruneRuns: a locked run is excluded from the count entirely', async () => {
  const workdir = await tmpWorkdir();
  // One locked, two unlocked, max 2: the locked run must not count toward the
  // cap, so the two unlocked runs alone (already at the cap) trigger nothing.
  const lockedDir = await makeRun(workdir, '20260101-000000-locked', { done: true });
  await setRunLocked(lockedDir, true);
  await makeRun(workdir, '20260101-000001-a', { done: true });
  await makeRun(workdir, '20260101-000002-b', { done: true });

  const result = await pruneRuns(workdir, DEFAULT_CONFIG, 2);
  assert.deepEqual(result, { deleted: [], failed: [] });
  assert.equal(await exists(lockedDir), true);
});

test('pruneRuns: a locked run is never deleted even when it is the oldest', async () => {
  const workdir = await tmpWorkdir();
  const lockedDir = await makeRun(workdir, '20260101-000000-locked', { done: true });
  await setRunLocked(lockedDir, true);
  await makeRun(workdir, '20260101-000001-a', { done: true });
  await makeRun(workdir, '20260101-000002-b', { done: true });
  await makeRun(workdir, '20260101-000003-c', { done: true });

  const result = await pruneRuns(workdir, DEFAULT_CONFIG, 1);
  assert.ok(!result.deleted.includes('20260101-000000-locked'));
  assert.equal(await exists(lockedDir), true);
});

test('pruneRuns: skips a running run and keeps deleting older ones to make up the count', async () => {
  const workdir = await tmpWorkdir();
  const runningDir = await makeRun(workdir, '20260101-000000-running'); // oldest, still running
  await makeRun(workdir, '20260101-000001-a', { done: true });
  await makeRun(workdir, '20260101-000002-b', { done: true });
  await makeRun(workdir, '20260101-000003-c', { done: true });

  // max 2: two excess beyond it. The oldest is running and gets skipped, so
  // the two next-oldest are deleted instead, leaving the running run plus the
  // newest — two runs on disk, matching max, even though one of them is the
  // run that should nominally have been first in line.
  const result = await pruneRuns(workdir, DEFAULT_CONFIG, 2);
  assert.deepEqual(result.deleted, ['20260101-000001-a', '20260101-000002-b']);
  assert.equal(await exists(runningDir), true);
  assert.equal(await exists(join(workdir, DEFAULT_CONFIG.artifacts_dir, '20260101-000003-c')), true);
});

// --- the startup window ------------------------------------------------

/** A run directory with no run.json yet — what `status: 'unknown'` covers. */
async function makeBareRunDir(workdir: string, runId: string): Promise<string> {
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

test('pruneRuns leaves a just-created run directory alone', async () => {
  // The data-loss path: a run finishing prunes on its way out, while another
  // run is in the handful of fs operations before its first manifest write.
  const workdir = await tmpWorkdir();
  await makeRun(workdir, '20260101-000001-aaaa', { done: true });
  const starting = await makeBareRunDir(workdir, '20260101-000002-bbbb');

  const result = await pruneRuns(workdir, DEFAULT_CONFIG, 1);
  assert.deepEqual(result.deleted, ['20260101-000001-aaaa']);
  assert.equal(await exists(starting), true, 'a starting run must survive retention');
});

test('pruneRuns still collects a stale unknown run directory', async () => {
  // The other half: 'unknown' also means a crash or a corrupt run.json, and
  // those must not accumulate forever.
  const workdir = await tmpWorkdir();
  const abandoned = await makeBareRunDir(workdir, '20260101-000001-aaaa');
  await makeRun(workdir, '20260101-000002-bbbb', { done: true });
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(abandoned, old, old);

  const result = await pruneRuns(workdir, DEFAULT_CONFIG, 1);
  assert.deepEqual(result.deleted, ['20260101-000001-aaaa']);
  assert.equal(await exists(abandoned), false);
});

test('deleteRun still removes a run directory it cannot read, with no grace window', async () => {
  // Deliberately unlike pruneRuns: this is a person acting on a row they can
  // see, and a corrupt run is exactly what they would be reaching for.
  const workdir = await tmpWorkdir();
  const bare = await makeBareRunDir(workdir, '20260101-000001-aaaa');

  assert.deepEqual(await deleteRun(workdir, DEFAULT_CONFIG, '20260101-000001-aaaa'), { deleted: true });
  assert.equal(await exists(bare), false);
});
