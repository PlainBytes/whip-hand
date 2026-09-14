import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { RunJournal, listRuns, getRun, renameRun, WORKFLOW_SNAPSHOT_NAME, renameReplacing } from './manifest.ts';
import type { RunManifest } from './manifest.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { setRunLocked } from './run-lock.ts';
import { NAME_MARKER_NAME, setRunName } from './run-name.ts';
import { RUN_LOG_NAME, parseLogLine } from './run-log.ts';
import type { WhiphandEvent } from '../types.ts';

async function tmpRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'whiphand-manifest-'));
}

function baseInit(runDir: string, runId: string) {
  return {
    runDir,
    runId,
    workflow: 'r',
    workdir: '/work',
    dryRun: false,
    inputs: { feature: 'x' },
    sessionIds: { a: 'sess-a' },
    steps: [
      { id: 'a', kind: 'agent' as const, runner: 'fake', mode: 'headless' as const },
      { id: 'b', kind: 'agent' as const, runner: 'fake', mode: 'headless' as const },
    ],
  };
}

test('renameReplacing retries a transient rename and then succeeds', async () => {
  // Windows only, in practice: MoveFileEx over a target someone else holds —
  // or is itself replacing — fails, where POSIX rename(2) just wins. Two
  // journals flushing over one run dir is the case that hits it, and losing a
  // manifest write is exactly what tmp+rename exists to prevent.
  let calls = 0;
  await renameReplacing('from', 'to', async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  });
  assert.equal(calls, 3);
});

test('renameReplacing rethrows anything that is not transient, without retrying', async () => {
  let calls = 0;
  await assert.rejects(
    () => renameReplacing('from', 'to', async () => {
      calls += 1;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    /ENOENT/,
  );
  assert.equal(calls, 1, 'a missing source is not going to appear');
});

test('renameReplacing gives up rather than retrying forever', async () => {
  let calls = 0;
  await assert.rejects(
    () => renameReplacing('from', 'to', async () => {
      calls += 1;
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    }),
    /EBUSY/,
  );
  assert.ok(calls > 1 && calls <= 20, `bounded retries, got ${calls}`);
});

test('a fresh journal records workflowSource on the manifest when given one', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal({ ...baseInit(runDir, 'run-source'), workflowSource: 'global' });
  assert.equal(journal.manifest.workflowSource, 'global');
  // A fresh journal writes run.json eagerly now, so the write has to be
  // awaited or it outlives the test and its temp directory.
  await journal.flush();
});

test('a fresh journal leaves workflowSource undefined when none was given', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-no-source'));
  assert.equal(journal.manifest.workflowSource, undefined);
  await journal.flush();
});

test('reopen preserves the original workflowSource, even without one supplied to reopen', async () => {
  const runDir = await tmpRunDir();
  const original = new RunJournal({ ...baseInit(runDir, 'run-reopen'), workflowSource: 'project' });
  const reopened = RunJournal.reopen(runDir, original.manifest);
  assert.equal(reopened.manifest.workflowSource, 'project');
  await Promise.all([original.flush(), reopened.flush()]);
});

test('a fresh journal puts run.json on disk before any event is recorded', async () => {
  // Without this, a run directory reads back as `status: 'unknown'` until its
  // first event lands — and pruneRuns only refuses a run it can see is
  // 'running'. With auto-naming on, that window is up to 20 seconds wide.
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-eager'));
  await journal.flush();
  const written = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunManifest;
  assert.equal(written.status, 'running');
  assert.equal(written.runId, 'run-eager');
  assert.deepEqual(written.steps.map(s => s.status), ['pending', 'pending']);
  assert.deepEqual(written.sessionIds, { a: 'sess-a' });
});

test('reducer: realistic event sequence builds final manifest fields', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-1'));

  const events: WhiphandEvent[] = [
    { type: 'run:start', runId: 'run-1', workflow: 'r' },
    { type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' },
    { type: 'step:spawn', stepId: 'a', spec: { argv: [], cwd: '/', env: {}, interactive: false }, phase: 'main' },
    { type: 'step:artifact', stepId: 'a', path: '/work/.whiphand/runs/run-1/a.md' },
    { type: 'step:done', stepId: 'a', exitCode: 0 },
    { type: 'step:start', stepId: 'b', kind: 'agent', runner: 'fake', mode: 'headless' },
    { type: 'step:spawn', stepId: 'b', spec: { argv: [], cwd: '/', env: {}, interactive: false }, phase: 'main' },
    { type: 'step:artifact', stepId: 'b', path: '/work/.whiphand/runs/run-1/b.md' },
    { type: 'step:verdict', stepId: 'b', verdict: 'pass' },
    { type: 'step:done', stepId: 'b', exitCode: 0 },
    { type: 'run:done', runId: 'run-1', ok: true },
  ];
  for (const e of events) journal.record(e);
  await journal.flush();

  const m = journal.manifest;
  assert.equal(m.status, 'succeeded');
  assert.equal(m.ok, true);
  assert.ok(m.endedAt);
  assert.equal(m.steps.length, 2);
  const a = m.steps.find(s => s.id === 'a')!;
  assert.equal(a.status, 'done');
  assert.equal(a.exitCode, 0);
  assert.equal(a.artifact, '/work/.whiphand/runs/run-1/a.md');
  const b = m.steps.find(s => s.id === 'b')!;
  assert.equal(b.status, 'done');
  assert.equal(b.verdict, 'pass');
});

test('reducer: failed run via step:done non-zero exit', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-2'));
  journal.record({ type: 'run:start', runId: 'run-2', workflow: 'r' });
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:done', stepId: 'a', exitCode: 1 });
  journal.record({ type: 'run:error', stepId: 'a', message: 'boom' });
  journal.record({ type: 'run:done', runId: 'run-2', ok: false });
  await journal.flush();

  const m = journal.manifest;
  assert.equal(m.steps.find(s => s.id === 'a')!.status, 'failed');
  assert.equal(m.status, 'failed');
  assert.equal(m.ok, false);
  assert.deepEqual(m.error, { stepId: 'a', message: 'boom' });
});

test('reducer: run:error without run:done still marks failed with error', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-3'));
  journal.record({ type: 'run:start', runId: 'run-3', workflow: 'r' });
  journal.record({ type: 'run:error', message: 'exploded' });
  await journal.flush();

  const m = journal.manifest;
  assert.equal(m.status, 'failed');
  assert.deepEqual(m.error, { stepId: undefined, message: 'exploded' });
});

test('reducer: run:cancelled sets status cancelled and endedAt', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-cancel-1'));
  journal.record({ type: 'run:start', runId: 'run-cancel-1', workflow: 'r' });
  journal.record({ type: 'run:cancelled', runId: 'run-cancel-1' });
  await journal.flush();

  const m = journal.manifest;
  assert.equal(m.status, 'cancelled');
  assert.ok(m.endedAt);
});

test('reducer: run:done ok:false after run:cancelled does not overwrite status', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-cancel-2'));
  journal.record({ type: 'run:start', runId: 'run-cancel-2', workflow: 'r' });
  journal.record({ type: 'run:cancelled', runId: 'run-cancel-2' });
  journal.record({ type: 'run:done', runId: 'run-cancel-2', ok: false });
  await journal.flush();

  const m = journal.manifest;
  assert.equal(m.status, 'cancelled');
  assert.equal(m.ok, false);
});

test('reducer: guard:warning only updates updatedAt', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-4'));
  const before = journal.manifest.updatedAt;
  await new Promise(r => setTimeout(r, 5));
  journal.record({ type: 'guard:warning', message: 'no git' });
  await journal.flush();
  assert.notEqual(journal.manifest.updatedAt, before);
  assert.equal(journal.manifest.status, 'running');
});

test('reducer: upsert on repeated step:start (loop mode) resets to running', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-5'));
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:done', stepId: 'a', exitCode: 0 });
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  await journal.flush();
  const a = journal.manifest.steps.find(s => s.id === 'a')!;
  assert.equal(a.status, 'running');
  assert.equal(journal.manifest.steps.filter(s => s.id === 'a').length, 1);
});

test('reducer: unknown step id from events gets appended', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-6'));
  journal.record({ type: 'step:start', stepId: 'a-triage', kind: 'agent', runner: 'fake', mode: 'interactive' });
  await journal.flush();
  assert.equal(journal.manifest.steps.length, 3);
  const triage = journal.manifest.steps.find(s => s.id === 'a-triage')!;
  assert.equal(triage.status, 'running');
  assert.equal(triage.mode, 'interactive');
});

test('journal writes: run.json exists, parses, is atomic (no .tmp left)', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-7'));
  journal.record({ type: 'run:start', runId: 'run-7', workflow: 'r' });
  journal.record({ type: 'run:done', runId: 'run-7', ok: true });
  await journal.flush();

  const entries = await readdir(runDir);
  assert.ok(entries.includes('run.json'));
  assert.ok(!entries.some(e => e.endsWith('.tmp')));

  const parsed: RunManifest = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
  assert.equal(parsed.status, 'succeeded');
});

test('journal writes: events.ndjson has one line per event', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-8'));
  const evs: WhiphandEvent[] = [
    { type: 'run:start', runId: 'run-8', workflow: 'r' },
    { type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' },
    { type: 'run:done', runId: 'run-8', ok: true },
  ];
  for (const e of evs) journal.record(e);
  await journal.flush();

  const raw = await readFile(join(runDir, 'events.ndjson'), 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.ok(parsed.ts);
    assert.ok(parsed.event);
  }
  assert.equal(JSON.parse(lines[0]).event.type, 'run:start');
});

test('listRuns: valid manifest is picked up', async () => {
  const workdir = await tmpRunDir();
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, '20260101-000000-aaaa');
  await mkdir(runDir, { recursive: true });
  const journal = new RunJournal(baseInit(runDir, '20260101-000000-aaaa'));
  journal.record({ type: 'run:start', runId: '20260101-000000-aaaa', workflow: 'r' });
  journal.record({ type: 'run:done', runId: '20260101-000000-aaaa', ok: true });
  await journal.flush();

  const runs = await listRuns(workdir, DEFAULT_CONFIG);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].runDir, runDir);
});

test('listRuns: manifest-less dir reported as unknown', async () => {
  const workdir = await tmpRunDir();
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, '20260101-000001-bbbb');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'notes.txt'), 'hi');

  const runs = await listRuns(workdir, DEFAULT_CONFIG);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'unknown');
  assert.equal(runs[0].runId, '20260101-000001-bbbb');
});

test('listRuns: unparseable run.json reported as unknown', async () => {
  const workdir = await tmpRunDir();
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, '20260101-000002-cccc');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'run.json'), '{ not json');

  const runs = await listRuns(workdir, DEFAULT_CONFIG);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'unknown');
});

/**
 * Writes an abandoned run: `status: 'running'` on disk with a step still
 * in flight, exactly as a SIGKILLed process leaves it. `pid`/`heartbeatAt`
 * are overridden after construction to control which staleness arm fires.
 */
async function writeAbandonedRun(
  workdir: string, runId: string, overrides: Partial<RunManifest> = {},
): Promise<string> {
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  const journal = new RunJournal(baseInit(runDir, runId));
  journal.record({ type: 'run:start', runId, workflow: 'r' });
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:done', stepId: 'a', exitCode: 0 });
  journal.record({ type: 'step:start', stepId: 'b', kind: 'agent', runner: 'fake', mode: 'headless' });
  await journal.flush();
  journal.close();
  Object.assign(journal.manifest, { pid: DEAD_PID, ...overrides });
  await writeFile(join(runDir, 'run.json'), JSON.stringify(journal.manifest, null, 2));
  return runDir;
}

/** A pid high enough to be unused; process.kill(pid, 0) throws ESRCH for it. */
const DEAD_PID = 999999999;

test('listRuns: abandoned run with a dead pid is repaired to interrupted on disk', async () => {
  const workdir = await tmpRunDir();
  const runDir = await writeAbandonedRun(workdir, '20260101-000003-dddd');

  const runs = await listRuns(workdir, DEFAULT_CONFIG);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'interrupted');

  const onDisk: RunManifest = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
  assert.equal(onDisk.status, 'interrupted');
  assert.ok(onDisk.endedAt, 'repair sets endedAt so durations stop growing');
  // The step that was in flight is finalized; the completed one is untouched
  // and the one that never started stays pending.
  assert.equal(onDisk.steps.find(s => s.id === 'a')!.status, 'done');
  const b = onDisk.steps.find(s => s.id === 'b')!;
  assert.equal(b.status, 'interrupted');
  assert.equal(b.endedAt, onDisk.endedAt);
  assert.equal(onDisk.error?.stepId, 'b');
  assert.match(onDisk.error!.message, /interrupted/i);
});

test('listRuns: repair is idempotent across repeated reads', async () => {
  const workdir = await tmpRunDir();
  const runDir = await writeAbandonedRun(workdir, '20260101-000004-eeee');

  const first = await listRuns(workdir, DEFAULT_CONFIG);
  const afterFirst = await readFile(join(runDir, 'run.json'), 'utf8');
  const second = await listRuns(workdir, DEFAULT_CONFIG);
  const afterSecond = await readFile(join(runDir, 'run.json'), 'utf8');

  assert.equal(first[0].status, 'interrupted');
  assert.equal(second[0].status, 'interrupted');
  // RunsPage polls listRuns every 5s; the second read must not rewrite the file.
  assert.equal(afterFirst, afterSecond);
});

test('listRuns: a live pid with a stale heartbeat is still detected as interrupted', async () => {
  const workdir = await tmpRunDir();
  // pid is our own (very much alive) — only the heartbeat arm can catch this.
  // This is the pid-reuse case and the threw-without-a-terminal-event case.
  await writeAbandonedRun(workdir, '20260101-000005-ffff', {
    pid: process.pid,
    heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  });

  const runs = await listRuns(workdir, DEFAULT_CONFIG);
  assert.equal(runs[0].status, 'interrupted');
});

test('listRuns: a live pid with a fresh heartbeat is left running', async () => {
  const workdir = await tmpRunDir();
  const runDir = await writeAbandonedRun(workdir, '20260101-000006-aaab', {
    pid: process.pid,
    heartbeatAt: new Date().toISOString(),
  });

  const runs = await listRuns(workdir, DEFAULT_CONFIG);
  assert.equal(runs[0].status, 'running');
  const onDisk: RunManifest = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
  assert.equal(onDisk.status, 'running', 'a live run must never be repaired out from under itself');
});

test('listRuns: a manifest with no heartbeatAt falls back to the pid check alone', async () => {
  const workdir = await tmpRunDir();
  // Pre-heartbeat manifests have no heartbeatAt and an arbitrarily old
  // updatedAt; a live pid must keep them running rather than tripping the
  // time-based arm.
  await writeAbandonedRun(workdir, '20260101-000007-aaac', {
    pid: process.pid,
    heartbeatAt: undefined,
    updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  });

  const runs = await listRuns(workdir, DEFAULT_CONFIG);
  assert.equal(runs[0].status, 'running');
});

test('listRuns: an unwritable run dir still reports interrupted', async () => {
  const workdir = await tmpRunDir();
  const runDir = await writeAbandonedRun(workdir, '20260101-000008-aaad');
  await chmod(runDir, 0o500); // r-x: the repair write fails, the read must not
  try {
    const runs = await listRuns(workdir, DEFAULT_CONFIG);
    assert.equal(runs[0].status, 'interrupted');
  } finally {
    await chmod(runDir, 0o700);
  }
});

test('reducer: run:cancelled finalizes a step that was still in flight', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-cancel-3'));
  journal.record({ type: 'run:start', runId: 'run-cancel-3', workflow: 'r' });
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'run:cancelled', runId: 'run-cancel-3' });
  journal.record({ type: 'run:done', runId: 'run-cancel-3', ok: false });
  await journal.flush();
  journal.close();

  const a = journal.manifest.steps.find(s => s.id === 'a')!;
  assert.equal(a.status, 'interrupted', 'a cancelled run must not leave a step spinning');
  assert.ok(a.endedAt);
});

test('reducer: run:error blames its own step as failed and interrupts the rest', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-err-2'));
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:start', stepId: 'b', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'run:error', stepId: 'a', message: 'session exited with code 1' });
  await journal.flush();
  journal.close();

  assert.equal(journal.manifest.steps.find(s => s.id === 'a')!.status, 'failed');
  assert.equal(journal.manifest.steps.find(s => s.id === 'b')!.status, 'interrupted');
});

test('reducer: run:error blames a step that already reported a clean exit', async () => {
  // A step's tail — the read-only guard, the artifact assertion, the verdict
  // parse — all run after the child has exited, so step:done lands 'done'
  // before any of them can refuse. Leaving that row alone is what made run
  // 20260910-134600-15ec unresumable for good.
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-err-3'));
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:done', stepId: 'a', exitCode: 0 });
  const afterDone = journal.manifest.steps.find(s => s.id === 'a')!.endedAt;
  journal.record({ type: 'run:error', stepId: 'a', message: 'expected artifact was not written' });
  await journal.flush();
  journal.close();

  const a = journal.manifest.steps.find(s => s.id === 'a')!;
  assert.equal(a.status, 'failed', 'a step the run failed on must not read done');
  assert.equal(a.exitCode, 0, 'the child really did exit 0; that stays on the record');
  assert.equal(a.endedAt, afterDone, 'step:done already knew when it ended');
});

test('reducer: blame lands on the execution in flight, not an earlier iteration', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-err-4'));
  const start = { type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' } as const;
  journal.record({ ...start, loopId: 'fix', iteration: 1 });
  journal.record({ type: 'step:done', stepId: 'a', exitCode: 0 });
  journal.record({ type: 'step:artifact', stepId: 'a', path: '/r/fix/iter-1/a.md' });
  journal.record({ ...start, loopId: 'fix', iteration: 2 });
  journal.record({ type: 'step:done', stepId: 'a', exitCode: 0 });
  journal.record({ type: 'run:error', stepId: 'a', message: 'artifact is empty' });
  await journal.flush();
  journal.close();

  const rows = journal.manifest.steps.filter(s => s.id === 'a');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'done', 'iteration 1 completed; its history stands');
  assert.equal(rows[0].artifact, '/r/fix/iter-1/a.md');
  assert.equal(rows[1].status, 'failed');
});

test('reducer: an interactive spawn is what records that a session exists', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-sess-1'));
  const spec = { argv: ['claude'], cwd: '/w', env: {}, interactive: true };
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'interactive' });
  journal.record({ type: 'step:spawn', stepId: 'a', spec, phase: 'main' });
  await journal.flush();
  journal.close();

  assert.equal(journal.manifest.steps.find(s => s.id === 'a')!.sessionStarted, true);
});

test('reducer: a step that started but never spawned records no session', async () => {
  // The field case: buildPrompt threw on a missing input artifact, so the step
  // was recorded as started and its minted id names nothing on disk.
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-sess-2'));
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'interactive' });
  journal.record({ type: 'run:error', stepId: 'a', message: "no artifact recorded for step 'x'" });
  await journal.flush();
  journal.close();

  assert.equal(journal.manifest.steps.find(s => s.id === 'a')!.sessionStarted, undefined);
});

test('reducer: step:session folds a captured id into manifest.sessionIds, same as an injected one', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-sess-capture'));
  const spec = { argv: ['opencode'], cwd: '/w', env: {}, interactive: true };
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'opencode', mode: 'interactive' });
  journal.record({ type: 'step:spawn', stepId: 'a', spec, phase: 'main' });
  journal.record({ type: 'step:session', stepId: 'a', sessionId: 'ses_captured' });
  await journal.flush();
  journal.close();

  assert.equal(journal.manifest.sessionIds.a, 'ses_captured');
  assert.equal(journal.manifest.steps.find(s => s.id === 'a')!.sessionStarted, true);
});

test('reducer: a headless spawn opens no session to resume', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-sess-3'));
  const spec = { argv: ['claude'], cwd: '/w', env: {}, interactive: false };
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:spawn', stepId: 'a', spec, phase: 'main' });
  await journal.flush();
  journal.close();

  assert.equal(journal.manifest.steps.find(s => s.id === 'a')!.sessionStarted, undefined);
});

test('reopen keeps the record that a session was opened', async () => {
  // Sticky like `attempted`: once a conversation exists on disk, it exists.
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-sess-4'));
  const spec = { argv: ['claude'], cwd: '/w', env: {}, interactive: true };
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'interactive' });
  journal.record({ type: 'step:spawn', stepId: 'a', spec, phase: 'main' });
  journal.record({ type: 'run:error', stepId: 'a', message: 'session exited with code 1' });
  await journal.flush();
  journal.close();

  const reopened = RunJournal.reopen(runDir, journal.manifest);
  const a = reopened.manifest.steps.find(s => s.id === 'a')!;
  assert.equal(a.status, 'pending', 'reset to re-run');
  assert.equal(a.sessionStarted, true, 'but its conversation is still there to continue');
  reopened.close();
});

test('a disabled step seeds as status: disabled, not pending', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal({
    ...baseInit(runDir, 'run-disabled-1'),
    steps: [
      { id: 'plan', kind: 'agent' as const, runner: 'fake', mode: 'headless' as const, disabled: true },
      { id: 'execute', kind: 'agent' as const, runner: 'fake', mode: 'headless' as const },
    ],
  });
  assert.equal(journal.manifest.steps.find(s => s.id === 'plan')!.status, 'disabled');
  assert.equal(journal.manifest.steps.find(s => s.id === 'execute')!.status, 'pending');
  journal.close();
});

test('a disabled loop seeds its whole body as disabled too', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal({
    ...baseInit(runDir, 'run-disabled-2'),
    steps: [
      { id: 'fix', kind: 'loop' as const, disabled: true },
      { id: 'execute', kind: 'agent' as const, runner: 'fake', mode: 'headless' as const, loopId: 'fix', disabled: true },
      { id: 'review', kind: 'agent' as const, runner: 'fake', mode: 'headless' as const, loopId: 'fix', disabled: true },
    ],
  });
  for (const id of ['fix', 'execute', 'review']) {
    assert.equal(journal.manifest.steps.find(s => s.id === id)!.status, 'disabled');
  }
  journal.close();
});

test('reopen preserves a disabled status across resume, exactly like done', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal({
    ...baseInit(runDir, 'run-disabled-3'),
    steps: [
      { id: 'plan', kind: 'agent' as const, runner: 'fake', mode: 'headless' as const, disabled: true },
      { id: 'execute', kind: 'agent' as const, runner: 'fake', mode: 'headless' as const },
    ],
  });
  journal.record({ type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'run:error', stepId: 'execute', message: 'boom' });
  await journal.flush();
  journal.close();

  const reopened = RunJournal.reopen(runDir, journal.manifest);
  assert.equal(reopened.manifest.steps.find(s => s.id === 'plan')!.status, 'disabled',
    'a resume must not rewrite it to pending — that would make a parked step render as an ordinary one');
  assert.equal(reopened.manifest.steps.find(s => s.id === 'execute')!.status, 'pending', 'the failed step still resets');
  reopened.close();
});

test('journal: heartbeat refreshes heartbeatAt on disk while the run is live', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal({ ...baseInit(runDir, 'run-hb'), heartbeatIntervalMs: 5 });
  journal.record({ type: 'run:start', runId: 'run-hb', workflow: 'r' });
  await journal.flush();
  const first = journal.manifest.heartbeatAt;
  assert.ok(first);

  await new Promise(r => setTimeout(r, 30));
  await journal.flush();
  assert.notEqual(journal.manifest.heartbeatAt, first);
  // Assert the *disk* moved past `first`, rather than comparing it to a
  // separately sampled in-memory value: with a 5ms tick, a heartbeat firing
  // between the two reads makes them legitimately differ, and that raced.
  const onDisk: RunManifest = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
  assert.ok(onDisk.heartbeatAt !== undefined && onDisk.heartbeatAt > first!,
    `expected the on-disk heartbeat to advance past ${first}, got ${onDisk.heartbeatAt}`);

  // A terminal event stops it: no further ticks once the run is over.
  journal.record({ type: 'run:done', runId: 'run-hb', ok: true });
  await journal.flush();
  const atEnd = journal.manifest.heartbeatAt;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(journal.manifest.heartbeatAt, atEnd);
  journal.close();
});

test('listRuns: sorted newest-first by runId', async () => {
  const workdir = await tmpRunDir();
  for (const id of ['20260101-000000-aaaa', '20260102-000000-bbbb', '20260101-120000-cccc']) {
    const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, id);
    await mkdir(runDir, { recursive: true });
    const journal = new RunJournal(baseInit(runDir, id));
    journal.record({ type: 'run:start', runId: id, workflow: 'r' });
    await journal.flush();
  }
  const runs = await listRuns(workdir, DEFAULT_CONFIG);
  assert.deepEqual(runs.map(r => r.runId), ['20260102-000000-bbbb', '20260101-120000-cccc', '20260101-000000-aaaa']);
});

test('listRuns/getRun surface the name marker, and the ordering is unchanged by it', async () => {
  const workdir = await tmpRunDir();
  const ids = ['20260101-000000-aaaa', '20260102-000000-bbbb'];
  for (const id of ids) {
    const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, id);
    await mkdir(runDir, { recursive: true });
    const journal = new RunJournal(baseInit(runDir, id));
    journal.record({ type: 'run:start', runId: id, workflow: 'r' });
    await journal.flush();
  }
  // Name the *older* run: a name must not disturb the newest-first ordering.
  await setRunName(join(workdir, DEFAULT_CONFIG.artifacts_dir, ids[0]), 'OAuth support');

  const runs = await listRuns(workdir, DEFAULT_CONFIG);
  assert.deepEqual(runs.map(r => r.runId), [ids[1], ids[0]]);
  assert.equal(runs[1].name, 'OAuth support');
  assert.equal(runs[0].name, undefined);

  const detail = await getRun(workdir, DEFAULT_CONFIG, ids[0]);
  assert.equal(detail?.name, 'OAuth support');
  assert.ok(!detail?.artifacts.some(a => a.name === NAME_MARKER_NAME),
    'the name marker is bookkeeping, not an artifact');
});

test('a run with no parseable manifest still reports its name', async () => {
  const workdir = await tmpRunDir();
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, 'broken');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'run.json'), 'not json', 'utf8');
  await setRunName(runDir, 'the broken one');
  const runs = await listRuns(workdir, DEFAULT_CONFIG);
  assert.equal(runs[0].status, 'unknown');
  assert.equal(runs[0].name, 'the broken one');
});

test('renameRun sets, replaces and clears a name; an unknown run is refused', async () => {
  const workdir = await tmpRunDir();
  const runId = '20260101-000000-aaaa';
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  const journal = new RunJournal(baseInit(runDir, runId));
  journal.record({ type: 'run:start', runId, workflow: 'r' });
  await journal.flush();

  assert.deepEqual(await renameRun(workdir, DEFAULT_CONFIG, runId, 'first'),
    { renamed: true, name: 'first' });
  assert.deepEqual(await renameRun(workdir, DEFAULT_CONFIG, runId, '  second  '),
    { renamed: true, name: 'second' });
  assert.deepEqual(await renameRun(workdir, DEFAULT_CONFIG, runId, null), { renamed: true });
  assert.equal((await getRun(workdir, DEFAULT_CONFIG, runId))?.name, undefined);

  assert.deepEqual(await renameRun(workdir, DEFAULT_CONFIG, 'nope', 'x'), { renamed: false });
  assert.deepEqual(await renameRun(workdir, DEFAULT_CONFIG, '../escape', 'x'), { renamed: false });
});

test('a live run can be renamed without the journal clobbering it', async () => {
  const workdir = await tmpRunDir();
  const runId = '20260101-000000-aaaa';
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  const journal = new RunJournal(baseInit(runDir, runId));
  journal.record({ type: 'run:start', runId, workflow: 'r' });
  await renameRun(workdir, DEFAULT_CONFIG, runId, 'mid-flight');
  // The very next event rewrites run.json wholesale — the marker survives it.
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  await journal.flush();
  journal.close();
  assert.equal((await getRun(workdir, DEFAULT_CONFIG, runId))?.name, 'mid-flight');
});

test('listRuns: missing artifacts dir returns empty array', async () => {
  const workdir = await tmpRunDir();
  const runs = await listRuns(workdir, DEFAULT_CONFIG);
  assert.deepEqual(runs, []);
});

test('getRun: returns manifest plus artifacts excluding run.json/events.ndjson', async () => {
  const workdir = await tmpRunDir();
  const runId = '20260101-000000-eeee';
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  const journal = new RunJournal(baseInit(runDir, runId));
  journal.record({ type: 'run:start', runId, workflow: 'r' });
  journal.record({ type: 'step:artifact', stepId: 'a', path: join(runDir, 'a.md') });
  journal.record({ type: 'run:done', runId, ok: true });
  await journal.flush();
  await writeFile(join(runDir, 'a.md'), '# hi');
  await writeFile(join(runDir, 'run.json.tmp'), 'leftover');
  // An interactive step's marker and await state are bookkeeping, not output.
  await writeFile(join(runDir, '.a.done'), '');
  await writeFile(join(runDir, '.a.await'), '{"r":"turn"}');

  const detail = await getRun(workdir, DEFAULT_CONFIG, runId);
  assert.ok(detail);
  assert.equal(detail!.status, 'succeeded');
  const names = detail!.artifacts.map(a => a.name).sort();
  assert.deepEqual(names, ['a.md']);
});

test('listRuns/getRun surface locked, and .locked stays out of the artifact list', async () => {
  const workdir = await tmpRunDir();
  const runId = '20260101-000000-locked';
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  const journal = new RunJournal(baseInit(runDir, runId));
  journal.record({ type: 'run:start', runId, workflow: 'r' });
  journal.record({ type: 'run:done', runId, ok: true });
  await journal.flush();
  await writeFile(join(runDir, 'a.md'), '# hi');

  const before = await getRun(workdir, DEFAULT_CONFIG, runId);
  assert.equal(before!.locked, false);

  await setRunLocked(runDir, true);

  const [summary] = await listRuns(workdir, DEFAULT_CONFIG);
  assert.equal(summary.locked, true);

  const detail = await getRun(workdir, DEFAULT_CONFIG, runId);
  assert.equal(detail!.locked, true);
  assert.deepEqual(detail!.artifacts.map(a => a.name), ['a.md']);
});

test('getRun: missing run returns null', async () => {
  const workdir = await tmpRunDir();
  const detail = await getRun(workdir, DEFAULT_CONFIG, 'nope');
  assert.equal(detail, null);
});

test('getRun: rejects path-traversal runIds instead of listing an arbitrary directory', async () => {
  const workdir = await tmpRunDir();
  // A directory outside workdir's artifacts_dir (a sibling of workdir under
  // the same tmpdir()), containing its own run.json — this is exactly what
  // the reviewer's probe demonstrated: getRun(workdir, config,
  // '../../../secret') returning a listing of an arbitrary directory.
  // workdir/.whiphand/runs/<runId> needs 3 '..' segments to climb back out to
  // tmpdir() and land on secretDir's own basename.
  const secretDir = await tmpRunDir();
  await writeFile(join(secretDir, 'run.json'), JSON.stringify({ secret: true }));
  const reachSecret = join('..', '..', '..', basename(secretDir));

  const badRunIds = ['../x', 'a/b', '..', '', reachSecret, secretDir];
  for (const badRunId of badRunIds) {
    const detail = await getRun(workdir, DEFAULT_CONFIG, badRunId);
    assert.equal(detail, null, `expected null for runId ${JSON.stringify(badRunId)}`);
  }
});

test('getRun: a normal runId still works after traversal hardening', async () => {
  const workdir = await tmpRunDir();
  const runId = '20260101-000000-ffff';
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  const journal = new RunJournal(baseInit(runDir, runId));
  journal.record({ type: 'run:start', runId, workflow: 'r' });
  journal.record({ type: 'run:done', runId, ok: true });
  await journal.flush();

  const detail = await getRun(workdir, DEFAULT_CONFIG, runId);
  assert.ok(detail);
  assert.equal(detail!.status, 'succeeded');
});

// ---------------------------------------------------------------------------
// v2: one entry per execution, loops, and the manual pause
// ---------------------------------------------------------------------------

function cycleInit(runDir: string, runId: string) {
  return {
    runDir, runId, workflow: 'cycle', workdir: '/work', dryRun: false,
    inputs: {}, sessionIds: {},
    steps: [
      { id: 'fix', kind: 'loop' as const },
      { id: 'execute', kind: 'agent' as const, loopId: 'fix', runner: 'fake', mode: 'headless' as const },
      { id: 'tests', kind: 'command' as const, loopId: 'fix' },
    ],
  };
}

test('reducer: each loop iteration adds its own step entry, grouped by id', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(cycleInit(runDir, 'run-loop'));

  journal.record({ type: 'loop:start', loopId: 'fix', maxIterations: 3 });
  for (const iteration of [1, 2]) {
    journal.record({ type: 'loop:iteration', loopId: 'fix', iteration, maxIterations: 3 });
    journal.record({
      type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'fake',
      mode: 'headless', loopId: 'fix', iteration,
    });
    journal.record({ type: 'step:artifact', stepId: 'execute', path: `/a/iter-${iteration}/e.md` });
    journal.record({ type: 'step:done', stepId: 'execute', exitCode: 0 });
    journal.record({ type: 'step:start', stepId: 'tests', kind: 'command', loopId: 'fix', iteration });
    journal.record({ type: 'step:verdict', stepId: 'tests', verdict: iteration === 2 ? 'pass' : 'fail' });
    journal.record({ type: 'step:done', stepId: 'tests', exitCode: iteration === 2 ? 0 : 1 });
  }
  journal.record({ type: 'loop:done', loopId: 'fix', iterations: 2, passed: true });
  await journal.flush();

  const executes = journal.manifest.steps.filter(s => s.id === 'execute');
  assert.equal(executes.length, 2, 'one entry per execution, not one per declared step');
  assert.deepEqual(executes.map(s => s.iteration), [1, 2]);
  assert.deepEqual(executes.map(s => s.artifact), ['/a/iter-1/e.md', '/a/iter-2/e.md']);
  assert.deepEqual(executes.map(s => s.loopId), ['fix', 'fix']);

  const tests = journal.manifest.steps.filter(s => s.id === 'tests');
  assert.deepEqual(tests.map(s => s.verdict), ['fail', 'pass']);

  const loop = journal.manifest.steps.find(s => s.id === 'fix')!;
  assert.equal(loop.kind, 'loop');
  assert.equal(loop.status, 'done');
  assert.equal(loop.iterations, 2);

  // Executions stay grouped with their step, so the plan is still readable.
  assert.deepEqual(journal.manifest.steps.map(s => `${s.id}${s.iteration ?? ''}`),
    ['fix', 'execute1', 'execute2', 'tests1', 'tests2']);
});

test('reducer: manualPending is set while a human is being asked and cleared after', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(cycleInit(runDir, 'run-manual'));
  const request = {
    stepId: 'sign', kind: 'approval' as const, title: 'Ship it?', instructions: 'Look.',
    choices: ['continue' as const, 'abort' as const], context: { artifacts: [] },
    defaultChoice: 'continue' as const,
  };

  journal.record({ type: 'step:start', stepId: 'sign', kind: 'approval' });
  journal.record({ type: 'step:manual', stepId: 'sign', request });
  await journal.flush();
  assert.deepEqual(journal.manifest.manualPending, { stepId: 'sign', title: 'Ship it?' });

  journal.record({ type: 'step:manual-resolved', stepId: 'sign', choice: 'continue' });
  await journal.flush();
  assert.equal(journal.manifest.manualPending, undefined);
});

test('reducer: a cancelled run does not leave a human still being asked', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(cycleInit(runDir, 'run-manual-cancel'));
  journal.record({ type: 'step:start', stepId: 'sign', kind: 'approval' });
  journal.record({
    type: 'step:manual', stepId: 'sign',
    request: {
      stepId: 'sign', kind: 'approval', title: 'Ship it?', instructions: 'Look.',
      choices: ['continue', 'abort'], context: { artifacts: [] }, defaultChoice: 'continue',
    },
  });
  journal.record({ type: 'run:cancelled', runId: 'run-manual-cancel' });
  await journal.flush();
  assert.equal(journal.manifest.manualPending, undefined);
  assert.equal(journal.manifest.steps.find(s => s.id === 'sign')!.status, 'interrupted');
});

test('a v1 manifest on disk still parses, and its steps read as agent steps', async () => {
  const workdir = await tmpRunDir();
  const runId = '20260101-000000-v1v1';
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  const legacy = {
    version: 1, runId: 'old-run', workflow: 'r', workdir: '/work', dryRun: false,
    pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z', status: 'succeeded', ok: true,
    inputs: {}, sessionIds: {},
    steps: [{ id: 'a', runner: 'claude', mode: 'headless', status: 'done', exitCode: 0 }],
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(legacy), 'utf8');
  const detail = await getRun(workdir, DEFAULT_CONFIG, runId);
  assert.ok(detail, 'a run recorded before cycles existed must still be readable');
  assert.equal(detail.status, 'succeeded');
  assert.equal(detail.steps[0].kind, 'agent');
});

// --- progress is folded, not logged --------------------------------------

test('reducer: folds progress counters and the last action onto the step', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-p1'));
  journal.record({ type: 'run:start', runId: 'run-p1', workflow: 'r' });
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:progress', stepId: 'a', progress: { kind: 'tool', tool: 'Read', target: 'runner.ts' } });
  journal.record({ type: 'step:progress', stepId: 'a', progress: { kind: 'text', text: 'thinking out loud' } });
  journal.record({ type: 'step:progress', stepId: 'a', progress: { kind: 'tool', tool: 'Bash', target: 'npm test' } });
  journal.record({ type: 'step:progress', stepId: 'a', progress: { kind: 'usage', turns: 4, costUsd: 0.25 } });
  journal.record({ type: 'step:done', stepId: 'a', exitCode: 0 });
  await journal.flush();

  const a = journal.manifest.steps.find(s => s.id === 'a')!;
  assert.deepEqual(a.progress, { turns: 4, costUsd: 0.25, lastAction: 'Bash npm test' });
});

test('reducer: prose alone never becomes a last action', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-p2'));
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:progress', stepId: 'a', progress: { kind: 'text', text: 'just talking' } });
  await journal.flush();
  assert.equal(journal.manifest.steps.find(s => s.id === 'a')!.progress, undefined);
});

test('progress is ephemeral: it neither logs an event nor rewrites the manifest', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-p3'));
  journal.record({ type: 'run:start', runId: 'run-p3', workflow: 'r' });
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  await journal.flush();
  const before = await readFile(join(runDir, 'events.ndjson'), 'utf8');

  for (let i = 0; i < 200; i++) {
    journal.record({ type: 'step:progress', stepId: 'a', progress: { kind: 'tool', tool: 'Read', target: `f${i}.ts` } });
  }
  await journal.flush();

  assert.equal(await readFile(join(runDir, 'events.ndjson'), 'utf8'), before,
    '200 progress events must add no lines to the event log');
  // The fold still happened in memory, ready for the next real event to persist.
  assert.equal(journal.manifest.steps.find(s => s.id === 'a')!.progress?.lastAction, 'Read f199.ts');
});

test('a step:done after progress persists the folded summary to run.json', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-p4'));
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:progress', stepId: 'a', progress: { kind: 'usage', turns: 3 } });
  journal.record({ type: 'step:done', stepId: 'a', exitCode: 0 });
  await journal.flush();

  const onDisk = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunManifest;
  assert.equal(onDisk.steps.find(s => s.id === 'a')!.progress?.turns, 3);
});

// ---------------------------------------------------------------------------
// Resume groundwork
// ---------------------------------------------------------------------------

test('getRun: the workflow snapshot is bookkeeping, not a step artifact', async () => {
  const workdir = await tmpRunDir();
  const runId = '20260101-000000-ffff';
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  const journal = new RunJournal(baseInit(runDir, runId));
  journal.record({ type: 'run:done', runId, ok: true });
  await journal.flush();
  await writeFile(join(runDir, 'plan.md'), '# plan');
  await writeFile(join(runDir, WORKFLOW_SNAPSHOT_NAME), 'name: r\nsteps: []\n');

  const detail = await getRun(workdir, DEFAULT_CONFIG, runId);

  // The run's own copy of its workflow is how a resume knows what to execute;
  // listing it here would read as a step output.
  assert.deepEqual(detail!.artifacts.map(a => a.name), ['plan.md']);
});

test('noteStoppedTree records the tree digest and persists it', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-tree'));
  journal.record({ type: 'run:done', runId: 'run-tree', ok: false });
  journal.noteStoppedTree('deadbeef');
  await journal.flush();

  const onDisk = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunManifest;
  assert.equal(onDisk.stoppedTree, 'deadbeef');
});

test('manifests written before stoppedTree and resumedAt existed still parse', async () => {
  const workdir = await tmpRunDir();
  const runId = '20260101-000000-old2';
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  const legacy: RunManifest = {
    version: 2, runId, workflow: 'r', workdir: '/work', dryRun: false,
    pid: process.pid, startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z',
    endedAt: '2026-01-01T00:00:02Z', status: 'failed', ok: false, inputs: {}, sessionIds: {},
    steps: [{ id: 'a', kind: 'agent', status: 'failed' }],
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(legacy), 'utf8');

  const runs = await listRuns(workdir, DEFAULT_CONFIG);

  assert.equal(runs.find(r => r.runId === runId)?.status, 'failed');
});

test('reopen continues an existing manifest instead of seeding a new one', async () => {
  const runDir = await tmpRunDir();
  const first = new RunJournal(cycleInit(runDir, 'run-reopen'));
  first.record({ type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'fake', mode: 'headless' });
  first.record({ type: 'step:done', stepId: 'execute', exitCode: 1 });
  first.record({ type: 'run:error', stepId: 'execute', message: 'boom' });
  await first.flush();
  const stopped = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunManifest;
  assert.equal(stopped.status, 'failed');

  const second = RunJournal.reopen(runDir, stopped);
  second.close();
  await second.flush();

  const reopened = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunManifest;
  assert.equal(reopened.status, 'running');
  assert.equal(reopened.runId, 'run-reopen');
  assert.equal(reopened.error, undefined);
  assert.equal(reopened.endedAt, undefined);
  assert.equal(reopened.ok, undefined);
  assert.equal(reopened.pid, process.pid);
  assert.equal(reopened.resumedAt?.length, 1);
  // The plan and its history survive: reopen never reseeds steps.
  assert.deepEqual(reopened.steps.map(s => s.id), stopped.steps.map(s => s.id));
});

test('a restarted step patches its entry rather than appending a second one', async () => {
  const runDir = await tmpRunDir();
  const first = new RunJournal(cycleInit(runDir, 'run-patch'));
  first.record({ type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'fake', mode: 'headless' });
  first.record({ type: 'step:done', stepId: 'execute', exitCode: 1 });
  await first.flush();

  const second = RunJournal.reopen(runDir, first.manifest);
  second.record({ type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'fake', mode: 'headless' });
  second.record({ type: 'step:done', stepId: 'execute', exitCode: 0 });
  second.close();
  await second.flush();

  // "The retry overwrites its failed attempt" — one entry per execution still.
  const entries = second.manifest.steps.filter(s => s.id === 'execute');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'done');
  assert.equal(entries[0].exitCode, 0);
});

test('reopen appends to the existing event log rather than truncating it', async () => {
  const runDir = await tmpRunDir();
  const first = new RunJournal(cycleInit(runDir, 'run-log'));
  first.record({ type: 'run:error', message: 'boom' });
  await first.flush();
  const before = (await readFile(join(runDir, 'events.ndjson'), 'utf8')).trim().split('\n').length;

  const second = RunJournal.reopen(runDir, first.manifest);
  second.record({ type: 'guard:warning', message: 'resumed' });
  second.close();
  await second.flush();

  const after = (await readFile(join(runDir, 'events.ndjson'), 'utf8')).trim().split('\n').length;
  assert.equal(after, before + 1);
});

test('a second resume adds another stamp rather than replacing the first', async () => {
  const runDir = await tmpRunDir();
  const first = new RunJournal(cycleInit(runDir, 'run-twice'));
  first.record({ type: 'run:error', message: 'boom' });
  await first.flush();

  // Sequentially, never overlapping: one journal owns a run dir at a time, which
  // is exactly what planResume's refusal to resume a 'running' run enforces.
  const second = RunJournal.reopen(runDir, first.manifest);
  second.close();
  await second.flush();

  const third = RunJournal.reopen(runDir, second.manifest);
  third.close();
  await third.flush();

  assert.equal(third.manifest.resumedAt?.length, 2);
});

test('reducer: a loop records the iteration budget it was given', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(cycleInit(runDir, 'run-loop-budget'));

  journal.record({ type: 'loop:start', loopId: 'fix', maxIterations: 3 });
  journal.record({ type: 'loop:iteration', loopId: 'fix', iteration: 2, maxIterations: 3 });
  await journal.flush();

  // Without the budget a reader can only say "iteration 2"; it cannot say how
  // much rope is left, which is the part worth knowing while a loop churns.
  const loop = journal.manifest.steps.find(s => s.id === 'fix');
  assert.equal(loop?.maxIterations, 3);
  assert.equal(loop?.iterations, 2);
});

test('manifests written before the loop budget existed still parse', async () => {
  const runDir = await tmpRunDir();
  const legacy: RunManifest = {
    version: 2, runId: 'old', workflow: 'cycle', workdir: '/work', dryRun: false,
    pid: process.pid, startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z',
    endedAt: '2026-01-01T00:00:02Z', status: 'succeeded', ok: true, inputs: {}, sessionIds: {},
    steps: [{ id: 'fix', kind: 'loop', status: 'done', iterations: 2 }],
  };
  await mkdir(join(runDir, 'old'), { recursive: true });
  await writeFile(join(runDir, 'old', 'run.json'), JSON.stringify(legacy), 'utf8');

  const runs = await listRuns(runDir, { ...DEFAULT_CONFIG, artifacts_dir: '.' });
  assert.equal(runs.find(r => r.runId === 'old')?.status, 'succeeded');
});

test('reopen resets the steps a resume will re-run back to pending', async () => {
  const runDir = await tmpRunDir();
  const first = new RunJournal(cycleInit(runDir, 'run-reset'));
  first.record({ type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'fake', mode: 'headless' });
  first.record({ type: 'step:artifact', stepId: 'execute', path: '/r/execute.md' });
  first.record({ type: 'step:done', stepId: 'execute', exitCode: 0 });
  first.record({ type: 'step:start', stepId: 'tests', kind: 'command' });
  first.record({ type: 'step:done', stepId: 'tests', exitCode: 1 });
  first.record({ type: 'run:error', stepId: 'tests', message: 'boom' });
  await first.flush();
  const stopped = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunManifest;

  const second = RunJournal.reopen(runDir, stopped);
  second.close();
  await second.flush();

  const reopened = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunManifest;
  const tests = reopened.steps.find(s => s.id === 'tests');
  assert.equal(tests?.status, 'pending');
  assert.equal(tests?.exitCode, undefined);
  assert.equal(tests?.endedAt, undefined);
  assert.equal(tests?.startedAt, undefined);
  assert.equal(tests?.attempted, true);
  // Completed work is exactly what resume exists to keep.
  const execute = reopened.steps.find(s => s.id === 'execute');
  assert.equal(execute?.status, 'done');
  assert.equal(execute?.artifact, '/r/execute.md');
  assert.notEqual(execute?.endedAt, undefined);
  assert.equal(execute?.attempted, undefined);
});

test('reopen marks a never-started step pending without claiming it was attempted', async () => {
  const runDir = await tmpRunDir();
  const first = new RunJournal(cycleInit(runDir, 'run-untouched'));
  first.record({ type: 'run:error', message: 'boom' });
  await first.flush();

  const second = RunJournal.reopen(runDir, first.manifest);
  second.close();
  await second.flush();

  const execute = second.manifest.steps.find(s => s.id === 'execute');
  assert.equal(execute?.status, 'pending');
  assert.equal(execute?.attempted, undefined);
});

test('a reopened run abandoned before its first step blames no step', async () => {
  const workdir = await tmpRunDir();
  const runId = '20260101-000009-rrrr';
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  const first = new RunJournal(cycleInit(runDir, runId));
  first.record({ type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'fake', mode: 'headless' });
  first.record({ type: 'step:done', stepId: 'execute', exitCode: 1 });
  first.record({ type: 'run:error', stepId: 'execute', message: 'boom' });
  await first.flush();
  first.close();

  const second = RunJournal.reopen(runDir, first.manifest);
  await second.flush();
  second.close();
  // A dead owner: no terminal event, a pid that cannot be running.
  Object.assign(second.manifest, { pid: DEAD_PID });
  await writeFile(join(runDir, 'run.json'), JSON.stringify(second.manifest, null, 2));

  const detail = await getRun(workdir, DEFAULT_CONFIG, runId);

  assert.equal(detail?.status, 'interrupted');
  // Nothing was in flight, so the repair has no step to blame — and must not
  // reach back to the attempt the resume already reset.
  assert.equal(detail?.error?.stepId, undefined);
  assert.match(detail!.error!.message, /interrupted/i);
});

test('a fresh journal records the attachments it was given, and none when it was given none', async () => {
  const runDir = await tmpRunDir();
  const attachments = [{ name: 'bug.png', path: 'attachments/bug.png', size: 3, source: '/home/me/bug.png' }];
  const journal = new RunJournal({ ...baseInit(runDir, 'r1'), attachments });
  journal.close();
  await journal.flush();
  const onDisk = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunManifest;
  assert.deepEqual(onDisk.attachments, attachments);

  const bare = await tmpRunDir();
  const empty = new RunJournal({ ...baseInit(bare, 'r2'), attachments: [] });
  empty.close();
  await empty.flush();
  assert.ok(!('attachments' in JSON.parse(await readFile(join(bare, 'run.json'), 'utf8'))));
});

test('attachments round-trip through getRun, and a manifest without the field still parses', async () => {
  const workdir = await tmpRunDir();
  const withId = '20260101-000000-att1';
  const withDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, withId);
  await mkdir(withDir, { recursive: true });
  const attachments = [{ name: 'a.log', path: 'attachments/a.log', size: 1, source: 'pasted' }];
  const journal = new RunJournal({ ...baseInit(withDir, withId), attachments });
  journal.record({ type: 'run:done', runId: withId, ok: true });
  await journal.flush();

  // Written as an older whiphand would have: no attachments key at all.
  const oldId = '20260101-000000-att0';
  const oldDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, oldId);
  await mkdir(oldDir, { recursive: true });
  const old = new RunJournal(baseInit(oldDir, oldId));
  old.record({ type: 'run:done', runId: oldId, ok: true });
  await old.flush();

  const withDetail = await getRun(workdir, DEFAULT_CONFIG, withId);
  assert.ok(withDetail !== null && withDetail.status === 'succeeded');
  assert.deepEqual(withDetail.attachments, attachments);
  const oldDetail = await getRun(workdir, DEFAULT_CONFIG, oldId);
  assert.ok(oldDetail !== null && oldDetail.status === 'succeeded');
  assert.equal(oldDetail.attachments, undefined);
});

test('getRun lists a bookkeeping name below the top level — an attachment called run.json', async () => {
  const workdir = await tmpRunDir();
  const runId = '20260101-000000-book';
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(join(runDir, 'attachments'), { recursive: true });
  const journal = new RunJournal(baseInit(runDir, runId));
  journal.record({ type: 'run:done', runId, ok: true });
  await journal.flush();
  for (const name of ['run.json', 'events.ndjson', WORKFLOW_SNAPSHOT_NAME, '.locked']) {
    await writeFile(join(runDir, 'attachments', name), 'mine');
  }
  await writeFile(join(runDir, WORKFLOW_SNAPSHOT_NAME), 'name: r');
  await setRunLocked(runDir, true);

  const detail = await getRun(workdir, DEFAULT_CONFIG, runId);
  assert.deepEqual(detail!.artifacts.map(a => a.name), [
    'attachments/.locked', 'attachments/events.ndjson', 'attachments/run.json', 'attachments/workflow.yaml',
  ], 'the top-level run.json, workflow.yaml and .locked are still bookkeeping');
});

// ---------------------------------------------------------------------------
// run.log: the human audit
// ---------------------------------------------------------------------------

test('run.log gets one formatted line per event, in seq order, and step:log is excluded from events.ndjson', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-log-1'));
  journal.record({ type: 'run:start', runId: 'run-log-1', workflow: 'r' });
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:log', stepId: 'a', stream: 'stdout', line: 'hello world' });
  journal.record({ type: 'step:done', stepId: 'a', exitCode: 0 });
  journal.record({ type: 'run:done', runId: 'run-log-1', ok: true });
  await journal.flush();

  const log = (await readFile(join(runDir, 'run.log'), 'utf8')).trim().split('\n');
  assert.equal(log.length, 5, 'one run.log line per event, including step:log');
  // Fixed prefix: `<ts>  <seq>  <kind>  <stepId|->  <text>`.
  const rows = log.map(line => {
    const [ts, seq, kind, stepId, ...rest] = line.split('  ');
    return { ts, seq: Number(seq), kind, stepId, text: rest.join('  ') };
  });
  assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 4, 5], 'seq is monotonic across the whole stream');
  assert.equal(rows[2].kind, 'step:log:stdout', 'the stream rides on kind so it survives round-tripping');
  assert.equal(rows[2].stepId, 'a');
  assert.equal(rows[2].text, 'hello world');

  const eventsRaw = (await readFile(join(runDir, 'events.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(eventsRaw.length, 4, 'step:log never reaches events.ndjson');
  assert.ok(!eventsRaw.some(line => JSON.parse(line).event.type === 'step:log'));
  // events.ndjson carries the same seq the run.log line and the live
  // notification (journal.record's return value) agree on.
  assert.deepEqual(eventsRaw.map(line => JSON.parse(line).seq), [1, 2, 4, 5]);
});

test('record() returns the seq and ts it assigned, for the caller to hand to a live notification', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-log-2'));
  const first = journal.record({ type: 'run:start', runId: 'run-log-2', workflow: 'r' });
  const second = journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  // Exactly the reading run.log's own line for this event was stamped with —
  // not a fresh one the caller takes on its own (F9).
  assert.equal(typeof first.ts, 'string');
  await journal.flush();
  const logged = (await readFile(join(runDir, RUN_LOG_NAME), 'utf8')).trim().split('\n').map(parseLogLine);
  assert.equal(logged[0]?.ts, first.ts);
  assert.equal(logged[1]?.ts, second.ts);
});

test('a dry run writes no run.log at all', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal({ ...baseInit(runDir, 'run-log-dry'), dryRun: true });
  journal.record({ type: 'run:start', runId: 'run-log-dry', workflow: 'r' });
  journal.record({ type: 'run:done', runId: 'run-log-dry', ok: true });
  await journal.flush();
  const entries = await readdir(runDir);
  assert.ok(!entries.includes('run.log'));
});

test('a line over the 8KB budget is truncated with a marker, not dropped outright', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-log-3'));
  const huge = 'x'.repeat(20_000);
  journal.record({ type: 'step:log', stepId: 'a', stream: 'stdout', line: huge });
  journal.record({ type: 'run:done', runId: 'run-log-3', ok: true });
  await journal.flush();
  const log = (await readFile(join(runDir, 'run.log'), 'utf8')).trim().split('\n');
  const firstLine = log[0];
  assert.ok(firstLine.length < huge.length, 'the line was cut down');
  assert.ok(firstLine.endsWith('…[truncated]'));
  assert.ok(Buffer.byteLength(firstLine, 'utf8') <= 8192);
});

test('the per-run byte cap drops output lines but keeps audit entries flowing, and notes the drop once', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal({ ...baseInit(runDir, 'run-log-4'), runLogCapBytes: 200 });
  journal.record({ type: 'run:start', runId: 'run-log-4', workflow: 'r' });
  for (let i = 0; i < 50; i++) {
    journal.record({ type: 'step:log', stepId: 'a', stream: 'stdout', line: `output line number ${i}` });
  }
  journal.record({ type: 'step:done', stepId: 'a', exitCode: 0 });
  journal.record({ type: 'run:done', runId: 'run-log-4', ok: true });
  await journal.flush();

  const log = (await readFile(join(runDir, 'run.log'), 'utf8')).trim().split('\n');
  const kinds = log.map(line => line.split('  ')[2]);
  // Every audit entry still landed...
  assert.ok(kinds.includes('run:start'));
  assert.ok(kinds.includes('step:done'));
  assert.ok(kinds.includes('run:done'));
  // ...but not every output line did, and the cap is noted.
  assert.ok(kinds.filter(k => k === 'step:log:stdout').length < 50, 'some output lines were dropped once the cap hit');
  assert.ok(kinds.includes('log:truncated'), 'the drop is noted in the file');
  assert.equal(kinds.filter(k => k === 'log:truncated').length, 1, 'noted exactly once, not once per dropped line');
});

test('a step:progress event appends exactly one run.log line, nothing to events.ndjson, and triggers no run.json rewrite', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-progress-1'));
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:progress', stepId: 'a', progress: { kind: 'tool', tool: 'Read', target: 'foo.ts' } });
  await journal.flush();

  // Folded into the in-memory manifest immediately (the summary and run.json
  // still depend on this)...
  const a = journal.manifest.steps.find(s => s.id === 'a')!;
  assert.equal(a.progress?.lastAction, 'Read foo.ts');

  // ...but the run.json on disk is exactly what step:start last wrote: the
  // progress event itself never triggered a structuredClone + rewrite.
  const onDisk: RunManifest = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
  const diskStep = onDisk.steps.find(s => s.id === 'a')!;
  assert.equal(diskStep.progress, undefined, 'run.json was not rewritten for the progress event');

  const log = (await readFile(join(runDir, 'run.log'), 'utf8')).trim().split('\n');
  const kinds = log.map(line => line.split('  ')[2]);
  assert.deepEqual(kinds, ['step:start', 'step:progress:tool'], 'one run.log line per event, including step:progress');

  const eventsRaw = (await readFile(join(runDir, 'events.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(eventsRaw.length, 1, 'step:progress never reaches events.ndjson');
  assert.equal(JSON.parse(eventsRaw[0]).event.type, 'step:start');
});

test('step:progress lines count against the per-run byte cap and surface log:truncated, same as step:log', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal({ ...baseInit(runDir, 'run-progress-2'), runLogCapBytes: 200 });
  journal.record({ type: 'run:start', runId: 'run-progress-2', workflow: 'r' });
  for (let i = 0; i < 50; i++) {
    journal.record({
      type: 'step:progress', stepId: 'a',
      progress: { kind: 'text', text: `thinking out loud, iteration ${i}` },
    });
  }
  journal.record({ type: 'run:done', runId: 'run-progress-2', ok: true });
  await journal.flush();

  const log = (await readFile(join(runDir, 'run.log'), 'utf8')).trim().split('\n');
  const kinds = log.map(line => line.split('  ')[2]);
  assert.ok(kinds.includes('run:start'));
  assert.ok(kinds.includes('run:done'));
  assert.ok(kinds.filter(k => k === 'step:progress:text').length < 50, 'some progress lines were dropped once the cap hit');
  assert.ok(kinds.includes('log:truncated'), 'the drop is noted in the file');
});

test('a resumed run seeds its byte counter from the existing run.log, so the cap holds across resumes', async () => {
  const runDir = await tmpRunDir();
  const original = new RunJournal({ ...baseInit(runDir, 'run-log-5'), runLogCapBytes: 100_000 });
  original.record({ type: 'run:start', runId: 'run-log-5', workflow: 'r' });
  original.record({ type: 'step:log', stepId: 'a', stream: 'stdout', line: 'x'.repeat(500) });
  await original.flush();
  const sizeAfterFirstAttempt = (await readFile(join(runDir, 'run.log'), 'utf8')).length;
  assert.ok(sizeAfterFirstAttempt > 0);

  // A tiny remaining budget: the seed should already have consumed most of
  // it, so this next line trips the cap almost immediately rather than
  // getting another full 100_000 bytes to itself.
  const reopened = RunJournal.reopen(runDir, original.manifest, { runLogCapBytes: sizeAfterFirstAttempt + 10 });
  reopened.record({ type: 'step:log', stepId: 'a', stream: 'stdout', line: 'y'.repeat(500) });
  reopened.record({ type: 'run:done', runId: 'run-log-5', ok: true });
  await reopened.flush();

  const finalSize = (await readFile(join(runDir, 'run.log'), 'utf8')).length;
  // Grew by roughly the note line and the audit entries, not by another full
  // 500-byte output line — proof the seed accounted for what was already there.
  assert.ok(finalSize < sizeAfterFirstAttempt + 500, 'the second output line was dropped, its budget already spent');
});

test("a command step's declared env is redacted in run.log but kept in full in events.ndjson", async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-log-6'));
  journal.record({
    type: 'step:spawn',
    stepId: 'build',
    phase: 'main',
    spec: {
      argv: ['/bin/sh', '-c', 'echo $API_TOKEN'],
      cwd: '/work',
      env: { API_TOKEN: 'super-secret', WHIPHAND_RUN_DIR: '/work/.whiphand/runs/run-log-6' },
      interactive: false,
    },
  });
  await journal.flush();

  const log = (await readFile(join(runDir, 'run.log'), 'utf8')).trim().split('\n');
  assert.ok(!log.some(line => line.includes('super-secret')), 'the secret value never reaches run.log');
  assert.ok(log.some(line => line.includes('API_TOKEN=<redacted>')), 'the key is still named');
  assert.ok(!log.some(line => line.includes('WHIPHAND_RUN_DIR=<redacted>')), "whiphand's own env keys are never redacted");

  const eventsRaw = await readFile(join(runDir, 'events.ndjson'), 'utf8');
  assert.ok(eventsRaw.includes('super-secret'), 'the full-fidelity machine record keeps the real value');
});

test('readRunLog pages a finished run.log and reports total/truncated', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-log-7'));
  for (let i = 0; i < 10; i++) {
    journal.record({ type: 'guard:warning', message: `warning ${i}` });
  }
  await journal.flush();

  const { readRunLog } = await import('./run-log.ts');
  const page1 = await readRunLog(runDir, { offset: 0, limit: 4 });
  assert.equal(page1.lines.length, 4);
  assert.equal(page1.total, 10);
  assert.equal(page1.truncated, true);

  const page3 = await readRunLog(runDir, { offset: 8, limit: 4 });
  assert.equal(page3.lines.length, 2);
  assert.equal(page3.truncated, false);

  const missing = await readRunLog(await tmpRunDir(), { offset: 0, limit: 10 });
  assert.deepEqual(missing, { lines: [], total: 0, truncated: false });
});

test('formatLogLine/parseLogLine round-trip, including a newline in the text and a step:log stream', async () => {
  const { formatLogLine, parseLogLine } = await import('./run-log.ts');
  const original = { seq: 3, ts: '2026-01-01T00:00:00.000Z', kind: 'step:log:stderr', stepId: 'build', text: 'line one\nline two', stream: 'stderr' as const };
  const line = formatLogLine(original);
  const parsed = parseLogLine(line.trimEnd());
  assert.deepEqual(parsed, { seq: 3, ts: original.ts, kind: 'step:log', stepId: 'build', text: original.text, stream: 'stderr' });
});

test('formatLogLine/parseLogLine round-trip a literal backslash-n, distinct from an actual newline', async () => {
  const { formatLogLine, parseLogLine } = await import('./run-log.ts');
  // The two-character sequence a tool's own JSON output prints literally — not
  // an actual newline — must survive unchanged, and not be read back as one.
  const original = { seq: 4, ts: '2026-01-01T00:00:00.000Z', kind: 'step:log:stdout', stepId: 'build', text: 'json: {"msg":"line one\\nline two"}', stream: 'stdout' as const };
  const line = formatLogLine(original);
  const parsed = parseLogLine(line.trimEnd());
  assert.deepEqual(parsed, { seq: 4, ts: original.ts, kind: 'step:log', stepId: 'build', text: original.text, stream: 'stdout' });
});

test('formatLogLine/parseLogLine round-trip mixed real newlines, literal backslash-n and bare backslashes', async () => {
  const { formatLogLine, parseLogLine } = await import('./run-log.ts');
  const original = { seq: 5, ts: '2026-01-01T00:00:00.000Z', kind: 'run:error', text: 'path C:\\foo\\bar\nnext: literal \\n here', stepId: undefined };
  const line = formatLogLine(original);
  const parsed = parseLogLine(line.trimEnd());
  assert.deepEqual(parsed, { seq: 5, ts: original.ts, kind: 'run:error', stepId: undefined, text: original.text });
});
