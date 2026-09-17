import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planResume, ResumeError } from './resume.ts';
import type { ResumeOptions, ResumePlan } from './resume.ts';
import { WORKFLOW_SNAPSHOT_NAME } from './manifest.ts';
import type { RunManifest } from './manifest.ts';
import { DEFAULT_CONFIG } from '../config.ts';

// No test in this file exercises global workflows, but resolveWorkflowPath's
// no-snapshot fallback now checks the global dir too — point it at a temp
// directory so nothing here ever touches the real home directory.
let prevConfigHome: string | undefined;
before(async () => {
  prevConfigHome = process.env.WHIPHAND_CONFIG_HOME;
  process.env.WHIPHAND_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'whiphand-config-home-'));
});
after(() => {
  if (prevConfigHome === undefined) delete process.env.WHIPHAND_CONFIG_HOME;
  else process.env.WHIPHAND_CONFIG_HOME = prevConfigHome;
});

const WORKFLOW = `name: cycle
steps:
  - id: plan
    kind: agent
    runner: fake
    mode: headless
    writes: false
    prompt: plan it
    output: plan.md
  - kind: loop
    id: fix
    until: check
    steps:
      - id: edit
        kind: agent
        runner: fake
        mode: headless
        writes: true
        prompt: edit
        output: edit.md
      - id: check
        kind: command
        run: "true"
        verdict: true
        output: check.log
`;

const RUN_ID = '20260101-000000-aaaa';

/** A run directory on disk with the given manifest steps. */
async function fixture(
  steps: RunManifest['steps'],
  overrides: Partial<RunManifest> = {},
  opts: { snapshot?: boolean; snapshotText?: string } = {},
): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), 'whiphand-resume-'));
  const runDir = join(workdir, DEFAULT_CONFIG.artifacts_dir, RUN_ID);
  await mkdir(runDir, { recursive: true });
  const manifest: RunManifest = {
    version: 2, runId: RUN_ID, workflow: 'cycle', workdir, dryRun: false,
    pid: 999_999, startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z',
    endedAt: '2026-01-01T00:01:00Z', status: 'failed', ok: false,
    inputs: { feature: 'x' }, sessionIds: {}, steps, ...overrides,
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(manifest), 'utf8');
  if (opts.snapshot !== false) {
    await writeFile(join(runDir, WORKFLOW_SNAPSHOT_NAME), opts.snapshotText ?? WORKFLOW, 'utf8');
  }
  return workdir;
}

const NESTED_WORKFLOW = `name: cycle
steps:
  - kind: loop
    id: human-review
    until: sign-off
    steps:
      - kind: loop
        id: fix-cycle
        until: review
        steps:
          - id: execute
            kind: agent
            runner: fake
            mode: headless
            writes: true
            prompt: edit
            output: edit.md
          - id: review
            kind: agent
            runner: fake
            mode: headless
            writes: false
            verdict: true
            prompt: review it
            output: review.md
      - id: sign-off
        kind: approval
        title: Ship it?
        instructions: Look at it.
        verdict: true
        capture: review
        output: feedback.md
`;

test('planResume marks completed steps done and names the restart point', async () => {
  const workdir = await fixture([
    { id: 'plan', kind: 'agent', status: 'done', artifact: '/r/plan.md' },
    { id: 'fix', kind: 'loop', status: 'running', iterations: 1 },
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 1, status: 'done', artifact: '/r/fix/iter-1/edit.md' },
    { id: 'check', kind: 'command', loopId: 'fix', iteration: 1, status: 'failed' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.done.has('plan'), true);
  assert.equal(plan.done.has('edit'), true);
  assert.equal(plan.done.has('check'), false);
  assert.equal(plan.restartAt?.stepId, 'check');
  assert.equal(plan.artifacts.plan, '/r/plan.md');
  assert.equal(plan.workflow.name, 'cycle');
  assert.equal(plan.inputs.feature, 'x');
});

test('planResume keeps only completed artifacts, so a half-written one is never referenced', async () => {
  const workdir = await fixture([
    { id: 'plan', kind: 'agent', status: 'done', artifact: '/r/plan.md' },
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 1, status: 'failed', artifact: '/r/half.md' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.artifacts.plan, '/r/plan.md');
  assert.equal(plan.artifacts.edit, undefined);
});

test('planResume records a verdict so a skipped check still drives its loop', async () => {
  const workdir = await fixture([
    // A command step registers its capture path before it runs, so a done row
    // for one that declares an output always carries an artifact — without it
    // this row would be healed as an incomplete step rather than skipped.
    { id: 'check', kind: 'command', loopId: 'fix', iteration: 1, status: 'done',
      verdict: 'fail', artifact: '/r/fix/iter-1/check.log' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.done.get('check')?.verdict, 'fail');
});

test('planResume keys a second iteration separately from the first', async () => {
  const workdir = await fixture([
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 1, status: 'done', artifact: '/r/1.md' },
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 2, status: 'done', artifact: '/r/2.md' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.done.has('edit'), true);
  assert.equal(plan.done.has('edit#2'), true);
  // ctx.artifacts must end on the newest, which is what a forward reference wants.
  assert.equal(plan.artifacts.edit, '/r/2.md');
  assert.deepEqual(plan.attempts.edit, ['/r/1.md', '/r/2.md']);
});

test('planResume resumes a session only for a step that actually started', async () => {
  // Session ids are minted for every interactive step before the run begins,
  // so a pending step has an id but no session on disk to resume.
  const workdir = await fixture(
    [
      { id: 'plan', kind: 'agent', status: 'interrupted' },
      { id: 'later', kind: 'agent', status: 'pending' },
    ],
    { sessionIds: { plan: 'sess-plan', later: 'sess-later' } },
  );

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.resumedStepIds.has('plan'), true);
  assert.equal(plan.resumedStepIds.has('later'), false);
  assert.equal(plan.sessionIds.later, 'sess-later', 'the id is still carried, just not resumed');
});

test('planResume refuses a run that succeeded', async () => {
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'done' }],
    { status: 'succeeded', ok: true });

  await assert.rejects(() => planResume(workdir, DEFAULT_CONFIG, RUN_ID), ResumeError);
});

test('planResume resumes a cancelled run', async () => {
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'interrupted' }],
    { status: 'cancelled' });

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.restartAt?.stepId, 'plan');
});

test('planResume resumes an interrupted run', async () => {
  const workdir = await fixture(
    [
      { id: 'plan', kind: 'agent', status: 'done', artifact: '/r/plan.md' },
      { id: 'edit', kind: 'agent', status: 'interrupted' },
    ],
    { status: 'interrupted' });

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.restartAt?.stepId, 'edit');
});

test('planResume refuses a run whose owner is still alive', async () => {
  // A live pid plus a fresh heartbeat: readRunSummary leaves this 'running',
  // and two processes writing one run directory would corrupt it.
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'running' }],
    {
      status: 'running', pid: process.pid,
      heartbeatAt: new Date().toISOString(), endedAt: undefined,
    });

  await assert.rejects(
    () => planResume(workdir, DEFAULT_CONFIG, RUN_ID),
    (e: Error) => e instanceof ResumeError && /running/.test(e.message));
});

test('planResume refuses an unknown run id', async () => {
  const workdir = await fixture([{ id: 'plan', kind: 'agent', status: 'failed' }]);

  await assert.rejects(() => planResume(workdir, DEFAULT_CONFIG, 'no-such-run'), ResumeError);
});

test('planResume refuses a run id that would escape the artifacts directory', async () => {
  const workdir = await fixture([{ id: 'plan', kind: 'agent', status: 'failed' }]);

  await assert.rejects(() => planResume(workdir, DEFAULT_CONFIG, '../../etc'), ResumeError);
});

test('planResume falls back to the workspace workflow when a run has no snapshot, and says so', async () => {
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'failed' }], {}, { snapshot: false });
  await mkdir(join(workdir, '.whiphand', 'workflows'), { recursive: true });
  await writeFile(join(workdir, '.whiphand', 'workflows', 'cycle.yaml'), WORKFLOW, 'utf8');

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.workflow.name, 'cycle');
  assert.ok(plan.warnings.some(w => w.includes('no workflow snapshot')));
});

test('planResume refuses when there is no snapshot and no workflow to fall back to', async () => {
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'failed' }], {}, { snapshot: false });

  await assert.rejects(() => planResume(workdir, DEFAULT_CONFIG, RUN_ID), ResumeError);
});

test('planResume refuses a run whose snapshot no longer parses', async () => {
  const workdir = await fixture([{ id: 'plan', kind: 'agent', status: 'failed' }]);
  const snapshot = join(workdir, DEFAULT_CONFIG.artifacts_dir, RUN_ID, WORKFLOW_SNAPSHOT_NAME);
  await writeFile(snapshot, 'name: broken\nsteps: [{ id: x }]\n', 'utf8');

  // Falling back to the workspace file here would silently run a different
  // workflow than the one this run recorded.
  await assert.rejects(
    () => planResume(workdir, DEFAULT_CONFIG, RUN_ID),
    (e: Error) => e instanceof ResumeError && /snapshot/.test(e.message));
});

test('planResume says tree drift is unknown when no snapshot was recorded', async () => {
  const workdir = await fixture([{ id: 'plan', kind: 'agent', status: 'failed' }]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.ok(plan.warnings.some(w => w.includes('working tree')));
});

test('planResume refuses to resume against a same-named workflow that now resolves to a different scope', async () => {
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'failed' }], { workflowSource: 'global' }, { snapshot: false });
  // A project-scoped 'cycle' appeared after the run started from a global one.
  await mkdir(join(workdir, '.whiphand', 'workflows'), { recursive: true });
  await writeFile(join(workdir, '.whiphand', 'workflows', 'cycle.yaml'), WORKFLOW, 'utf8');

  await assert.rejects(
    () => planResume(workdir, DEFAULT_CONFIG, RUN_ID),
    (e: Error) => e instanceof ResumeError && /global/.test(e.message) && /project/.test(e.message));
});

test('planResume allows falling back when the recorded scope still matches', async () => {
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'failed' }], { workflowSource: 'project' }, { snapshot: false });
  await mkdir(join(workdir, '.whiphand', 'workflows'), { recursive: true });
  await writeFile(join(workdir, '.whiphand', 'workflows', 'cycle.yaml'), WORKFLOW, 'utf8');

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);
  assert.equal(plan.workflow.name, 'cycle');
});

test('planResume does not check scope when the run predates workflowSource', async () => {
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'failed' }], {}, { snapshot: false });
  await mkdir(join(workdir, '.whiphand', 'workflows'), { recursive: true });
  await writeFile(join(workdir, '.whiphand', 'workflows', 'cycle.yaml'), WORKFLOW, 'utf8');

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);
  assert.equal(plan.workflow.name, 'cycle');
});

test('planResume resumes a session for a step an earlier resume reset to pending', async () => {
  // reopen resets everything it will re-run to 'pending', so status alone can no
  // longer tell "never started" from "started, then reset" — `attempted` does.
  const workdir = await fixture(
    [
      { id: 'plan', kind: 'agent', status: 'pending', attempted: true },
      { id: 'later', kind: 'agent', status: 'pending' },
    ],
    { sessionIds: { plan: 'sess-plan', later: 'sess-later' } },
  );

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.resumedStepIds.has('plan'), true);
  assert.equal(plan.resumedStepIds.has('later'), false);
});

// ---------------------------------------------------------------------------
// Healing: a 'done' row that never recorded the artifact its step declares
// ---------------------------------------------------------------------------

const RUN_START = '2026-01-01T00:00:00Z';

/** Writes an artifact into a fixture's run dir, dated after the step started. */
async function leaveArtifact(workdir: string, rel: string, body = '# real work\n'): Promise<string> {
  const path = join(workdir, DEFAULT_CONFIG.artifacts_dir, RUN_ID, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return path;
}

test('planResume adopts an artifact the step left behind but never recorded', async () => {
  // The field wedge: the harvest wrote a perfectly good plan.md, then the
  // read-only guard refused the step before step:artifact could be emitted.
  const workdir = await fixture([
    { id: 'plan', kind: 'agent', status: 'done', startedAt: RUN_START },
  ]);
  const expected = await leaveArtifact(workdir, 'plan.md');

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.done.has('plan'), true, 'the work is really there; do not re-run it');
  assert.equal(plan.artifacts.plan, expected);
  assert.equal(plan.manifest.steps[0].artifact, expected, 'the repair is written back');
  assert.ok(plan.warnings.some(w => w.includes('adopting') && w.includes('plan.md')));
});

test('planResume re-runs a done step whose declared artifact is nowhere to be found', async () => {
  const workdir = await fixture([
    { id: 'plan', kind: 'agent', status: 'done', startedAt: RUN_START },
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 1, status: 'pending' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.done.has('plan'), false, 'nothing to adopt, so it must run again');
  assert.equal(plan.restartAt?.stepId, 'plan');
  assert.equal(plan.manifest.steps[0].status, 'failed', 'so reopen resets it to pending');
  assert.ok(plan.warnings.some(w => w.includes('plan.md') && w.includes('run again')));
});

test('planResume will not adopt an artifact that is there but blank', async () => {
  const workdir = await fixture([
    { id: 'plan', kind: 'agent', status: 'done', startedAt: RUN_START },
  ]);
  await leaveArtifact(workdir, 'plan.md', '   \n\n');

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.done.has('plan'), false);
});

test('planResume will not adopt a leftover from an earlier attempt', async () => {
  // Nothing deletes artifacts between attempts, so "the file exists" is not
  // evidence that *this* execution produced it.
  const workdir = await fixture([
    { id: 'plan', kind: 'agent', status: 'done', startedAt: '2099-01-01T00:00:00Z' },
  ]);
  await leaveArtifact(workdir, 'plan.md');

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.done.has('plan'), false, 'the file predates the step that claims it');
  assert.ok(plan.warnings.some(w => w.includes('run again')));
});

test('planResume adopts a loop body artifact from its own iteration directory', async () => {
  const workdir = await fixture([
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 2, status: 'done', startedAt: RUN_START },
  ]);
  const expected = await leaveArtifact(workdir, join('fix', 'iter-2', 'edit.md'));

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.artifacts.edit, expected);
  assert.ok(expected.includes(join('fix', 'iter-2')), 'not the flat top-level path');
});

test('planResume only heals the newest execution of a looped step', async () => {
  const workdir = await fixture([
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 1, status: 'done', startedAt: RUN_START },
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 2, status: 'done',
      startedAt: RUN_START, artifact: '/r/fix/iter-2/edit.md' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  // Iteration 1's gap cannot wedge anything — only the newest flows forward —
  // and re-running it would rewrite the cycle's recorded history.
  assert.equal(plan.manifest.steps[0].status, 'done');
  assert.equal(plan.warnings.filter(w => w.includes('edit.md')).length, 0);
});

test('planResume never second-guesses a dry run, where done-without-artifact is normal', async () => {
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'done', startedAt: RUN_START }],
    { dryRun: true },
  );

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.done.has('plan'), true);
  assert.equal(plan.warnings.filter(w => w.includes('plan.md')).length, 0);
});

test('planResume leaves a done step that never promised an artifact alone', async () => {
  const workdir = await fixture([
    { id: 'sign-off', kind: 'approval', status: 'done', startedAt: RUN_START },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.done.has('sign-off'), true);
  assert.equal(plan.warnings.filter(w => w.includes('sign-off')).length, 0);
});

test('a healed interactive step is still offered its recorded session', async () => {
  // This is what makes re-running cheap: the step reopens the conversation it
  // already had rather than starting from nothing.
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'done', startedAt: RUN_START }],
    { sessionIds: { plan: 'sess-plan' } },
  );

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.done.has('plan'), false);
  assert.equal(plan.resumedStepIds.has('plan'), true);
});

// ---------------------------------------------------------------------------
// Sessions: a step that started is not the same as a session that opened
// ---------------------------------------------------------------------------

test('planResume will not resume a session that was never opened', async () => {
  // step:start fires before the prompt is built and the session is spawned.
  // A step that died in between — a missing input artifact, say — is recorded
  // as started, and its minted id names no conversation on disk. Handing that
  // id to `claude --resume` exits 1 and fails the run all over again.
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', mode: 'headless', status: 'interrupted', attempted: true }],
    { version: 3, sessionIds: { plan: 'sess-plan' } },
  );

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.resumedStepIds.has('plan'), false);
  assert.equal(plan.sessionIds.plan, 'sess-plan', 'the id is still carried, just not resumed');
});

test('planResume resumes a session the run really opened', async () => {
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', mode: 'headless', status: 'interrupted', attempted: true, sessionStarted: true }],
    { version: 3, sessionIds: { plan: 'sess-plan' } },
  );

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.resumedStepIds.has('plan'), true);
});

// ---------------------------------------------------------------------------
// Loop budgets: what a resume grants an unfinished loop
// ---------------------------------------------------------------------------

const WORKFLOW_DECLARED_5 = WORKFLOW.replace(
  '  - kind: loop\n    id: fix\n    until: check\n',
  '  - kind: loop\n    id: fix\n    until: check\n    max_iterations: 5\n');

test('an exhausted loop row grants the default +1', async () => {
  const workdir = await fixture([
    { id: 'fix', kind: 'loop', status: 'failed', iterations: 3, maxIterations: 3, verdict: 'fail' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.deepEqual(plan.loopBudgets.fix, { budget: 4, completed: 3 });
});

test('an explicit extraIterations grants that many instead of the default', async () => {
  const workdir = await fixture([
    { id: 'fix', kind: 'loop', status: 'failed', iterations: 3, maxIterations: 3, verdict: 'fail' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID, { extraIterations: 2 });

  assert.deepEqual(plan.loopBudgets.fix, { budget: 5, completed: 3 });
});

test('an interrupted loop row with no explicit option keeps its recorded budget and gets no bump', async () => {
  const workdir = await fixture([
    { id: 'fix', kind: 'loop', status: 'interrupted', iterations: 1, maxIterations: 3 },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.deepEqual(plan.loopBudgets.fix, { budget: 3, completed: 1 });
});

test('the same interrupted row is bumped when extraIterations is explicit', async () => {
  const workdir = await fixture([
    { id: 'fix', kind: 'loop', status: 'interrupted', iterations: 1, maxIterations: 3 },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID, { extraIterations: 1 });

  assert.deepEqual(plan.loopBudgets.fix, { budget: 4, completed: 1 });
});

test('a done loop row (it passed) produces no budget entry at all', async () => {
  const workdir = await fixture([
    { id: 'fix', kind: 'loop', status: 'done', iterations: 2, maxIterations: 3, verdict: 'pass' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.loopBudgets.fix, undefined);
});

test('a manifest predating maxIterations falls back to the loop\'s declared budget', async () => {
  const workdir = await fixture(
    [{ id: 'fix', kind: 'loop', status: 'failed', iterations: 5 }], {}, { snapshot: false });
  await writeFile(
    join(workdir, DEFAULT_CONFIG.artifacts_dir, RUN_ID, WORKFLOW_SNAPSHOT_NAME), WORKFLOW_DECLARED_5, 'utf8');

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.deepEqual(plan.loopBudgets.fix, { budget: 6, completed: 5 });
});

test('a manifest with no recorded or declared budget falls back to config', async () => {
  const workdir = await fixture([
    { id: 'fix', kind: 'loop', status: 'failed', iterations: 2 },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.deepEqual(plan.loopBudgets.fix, { budget: DEFAULT_CONFIG.loop.max_iterations + 1, completed: 2 });
});

test('a loop id the snapshot no longer declares falls back to config instead of throwing', async () => {
  const workdir = await fixture([
    { id: 'ghost', kind: 'loop', status: 'failed', iterations: 1 },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.deepEqual(plan.loopBudgets.ghost, { budget: DEFAULT_CONFIG.loop.max_iterations + 1, completed: 1 });
});

test('accumulation: an earlier resume\'s grant is this one\'s base', async () => {
  const workdir = await fixture([
    { id: 'fix', kind: 'loop', status: 'failed', iterations: 4, maxIterations: 4 },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.deepEqual(plan.loopBudgets.fix, { budget: 5, completed: 4 });
});

test('planResume warns once per loop it raises', async () => {
  const workdir = await fixture([
    { id: 'fix', kind: 'loop', status: 'failed', iterations: 3, maxIterations: 3 },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.ok(plan.warnings.some(w => w.includes("loop 'fix' ran out of iterations at 3") && w.includes('allows 4')));
});

test('planResume warns when extraIterations is explicit but no loop is eligible', async () => {
  const workdir = await fixture([{ id: 'plan', kind: 'agent', status: 'failed' }]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID, { extraIterations: 2 });

  assert.ok(plan.warnings.some(w => w.includes('no loop in this run has iterations left to raise')));
});

test('restartAt names the exhausted loop\'s body at completed + 1, not the step after the loop', async () => {
  const workdir = await fixture([
    { id: 'plan', kind: 'agent', status: 'done', artifact: '/r/plan.md' },
    { id: 'fix', kind: 'loop', status: 'failed', iterations: 3, maxIterations: 3, verdict: 'fail' },
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 1, status: 'done', artifact: '/r/1.md' },
    {
      id: 'check', kind: 'command', loopId: 'fix', iteration: 1, status: 'done',
      verdict: 'fail', artifact: '/r/c1.md',
    },
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 2, status: 'done', artifact: '/r/2.md' },
    {
      id: 'check', kind: 'command', loopId: 'fix', iteration: 2, status: 'done',
      verdict: 'fail', artifact: '/r/c2.md',
    },
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 3, status: 'done', artifact: '/r/3.md' },
    {
      id: 'check', kind: 'command', loopId: 'fix', iteration: 3, status: 'done',
      verdict: 'fail', artifact: '/r/c3.md',
    },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.deepEqual(plan.restartAt, { stepId: 'edit', iteration: 4 });
});

test('nested loops: an inner loop\'s grant applies to the inner id only', async () => {
  const workdir = await fixture([
    { id: 'outer', kind: 'loop', status: 'interrupted', iterations: 1, maxIterations: 2 },
    { id: 'inner', kind: 'loop', loopId: 'outer', iteration: 1, status: 'failed', iterations: 2, maxIterations: 2 },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.deepEqual(plan.loopBudgets.inner, { budget: 3, completed: 2 }, 'the inner loop exhausted, so it is bumped');
  assert.deepEqual(plan.loopBudgets.outer, { budget: 2, completed: 1 }, 'the outer loop is merely interrupted');
});

test('an inner-loop extra-iterations grant applies only to the round where the loop ran out', async () => {
  // Round 1 of fix-cycle passed; round 2 exhausted. Only round 2's row is
  // eligible for a budget at all — round 1 is 'done' — and the two rounds'
  // rowKeys must not collide, or round 2's grant would look like round 1's.
  const workdir = await fixture(
    [
      { id: 'human-review', kind: 'loop', status: 'interrupted', iterations: 2, maxIterations: 5 },
      { id: 'fix-cycle', kind: 'loop', loopId: 'human-review', iteration: 1, status: 'done', iterations: 1, maxIterations: 3 },
      {
        id: 'execute', kind: 'agent', loopId: 'fix-cycle', iteration: 1,
        outerLoops: [{ id: 'human-review', iteration: 1 }], status: 'done', artifact: '/r/e1.md',
      },
      {
        id: 'review', kind: 'agent', loopId: 'fix-cycle', iteration: 1,
        outerLoops: [{ id: 'human-review', iteration: 1 }], status: 'done', verdict: 'pass', artifact: '/r/rv1.md',
      },
      {
        id: 'sign-off', kind: 'approval', loopId: 'human-review', iteration: 1,
        status: 'done', verdict: 'fail', artifact: '/r/fb1.md',
      },
      {
        id: 'fix-cycle', kind: 'loop', loopId: 'human-review', iteration: 2,
        status: 'failed', iterations: 3, maxIterations: 3,
      },
      {
        id: 'execute', kind: 'agent', loopId: 'fix-cycle', iteration: 1,
        outerLoops: [{ id: 'human-review', iteration: 2 }], status: 'done', artifact: '/r/e2.md',
      },
      {
        id: 'review', kind: 'agent', loopId: 'fix-cycle', iteration: 1,
        outerLoops: [{ id: 'human-review', iteration: 2 }], status: 'done', verdict: 'fail', artifact: '/r/rv2.md',
      },
    ],
    { version: 4 },
    { snapshotText: NESTED_WORKFLOW },
  );

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.deepEqual(plan.loopBudgets['fix-cycle#2'], { budget: 4, completed: 3 },
    'round 2 exhausted, so it gets the default +1');
  assert.equal(plan.loopBudgets['fix-cycle'], undefined,
    'round 1 already passed (its row is done), so it gets no budget entry at all');
  assert.deepEqual(plan.loopBudgets['human-review'], { budget: 5, completed: 2 },
    'the outer loop is merely interrupted, not exhausted, so no bump');
});

test('a pre-v4 manifest whose workflow now has a loop nested inside another is refused, not resumed', async () => {
  const workdir = await fixture(
    [
      { id: 'human-review', kind: 'loop', status: 'interrupted', iterations: 1, maxIterations: 5 },
      { id: 'fix-cycle', kind: 'loop', loopId: 'human-review', status: 'done', iterations: 1, maxIterations: 3 },
      { id: 'execute', kind: 'agent', loopId: 'fix-cycle', status: 'done', artifact: '/r/execute.md' },
      { id: 'review', kind: 'agent', loopId: 'fix-cycle', status: 'done', artifact: '/r/review.md', verdict: 'pass' },
    ],
    { version: 3 },
    { snapshotText: NESTED_WORKFLOW },
  );

  await assert.rejects(
    planResume(workdir, DEFAULT_CONFIG, RUN_ID),
    (e: unknown) => e instanceof ResumeError && e.message.includes('start a fresh run'),
  );
});

test('a pre-v4 manifest whose workflow has no nested loops still resumes normally', async () => {
  // Single-level loops never needed outerLoops to disambiguate rounds, so a
  // run recorded before it existed is still perfectly resumable.
  const workdir = await fixture(
    [
      { id: 'plan', kind: 'agent', status: 'done', artifact: '/r/plan.md' },
      { id: 'fix', kind: 'loop', status: 'interrupted', iterations: 1, maxIterations: 3 },
      { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 1, status: 'done', artifact: '/r/fix/iter-1/edit.md' },
      { id: 'check', kind: 'command', loopId: 'fix', iteration: 1, status: 'interrupted' },
    ],
    { version: 3 },
  );

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);
  assert.deepEqual(plan.restartAt, { stepId: 'check', iteration: 1 });
});

test('restartAt still prefers a loop interrupted mid-iteration over its next-iteration refinement', async () => {
  // The recorded iteration (1) is not finished — 'check' never ran — so the
  // plain scan finding it must win over jumping ahead to iteration 2.
  const workdir = await fixture([
    { id: 'fix', kind: 'loop', status: 'interrupted', iterations: 1, maxIterations: 3 },
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 1, status: 'done', artifact: '/r/1.md' },
    { id: 'check', kind: 'command', loopId: 'fix', iteration: 1, status: 'interrupted' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.deepEqual(plan.restartAt, { stepId: 'check', iteration: 1 });
});

test('a run recorded before sessions were tracked keeps the old heuristic', async () => {
  // Nothing in a version 2 manifest can say whether a session opened, and
  // guessing "no" would hand `--session-id` an id that is already taken.
  const workdir = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'interrupted', attempted: true }],
    { version: 2, sessionIds: { plan: 'sess-plan' } },
  );

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.resumedStepIds.has('plan'), true);
});

// ---------------------------------------------------------------------------
// Staged runs
// ---------------------------------------------------------------------------

/** The same shape runner.stages.test.ts runs: a fix cycle per stage, then a gate. */
const STAGED_WORKFLOW = `name: staged
steps:
  - kind: stages
    id: build
    items: "plans/*.md"
    steps:
      - kind: loop
        id: cycle
        until: review
        max_iterations: 2
        steps:
          - id: execute
            runner: fake
            mode: headless
            writes: true
            prompt: "Implement {{ stage.title }}"
            inputs: [stage, review]
            output: execute-report.md
          - id: review
            runner: fake
            mode: headless
            writes: false
            verdict: true
            prompt: Review it
            inputs: [stage, execute]
            output: review.md
      - kind: approval
        id: accept
        title: "Accept {{ stage.title }}?"
        instructions: Look at the work.
        inputs: [stage, review]
        output: accept.md
`;

type Row = RunManifest['steps'][number];

/**
 * The rows a real run records for one finished attempt at one stage, in the
 * shapes RunJournal writes them (checked against runner.stages.test.ts's
 * run.json): the loop row and the gate sit directly under the stage frame
 * (`loopId: 'build'`, `iteration: <attempt>`, `stage`), while the cycle's own
 * body carries the stage in `outerLoops` and has no `stage` of its own.
 */
function stageAttemptRows(stage: string, attempt: number, over: {
  gate?: 'pass' | 'fail'; cycle?: 'pass' | 'fail';
} = {}): Row[] {
  const cycle = over.cycle ?? 'pass';
  const iterations = cycle === 'pass' ? 1 : 2;
  const dir = `/r/build/${stage}/attempt-${attempt}`;
  const inCycle = (n: number): Pick<Row, 'loopId' | 'iteration' | 'outerLoops'> =>
    ({ loopId: 'cycle', iteration: n, outerLoops: [{ id: 'build', iteration: attempt, stage }] });
  return [
    { id: 'cycle', kind: 'loop', status: cycle === 'pass' ? 'done' : 'failed', loopId: 'build', iteration: attempt,
      stage, iterations, maxIterations: 2, verdict: cycle },
    ...Array.from({ length: iterations }, (_, i) => [
      { id: 'execute', kind: 'agent' as const, status: 'done' as const, ...inCycle(i + 1),
        artifact: `${dir}/cycle/iter-${i + 1}/execute-report.md` },
      { id: 'review', kind: 'agent' as const, status: 'done' as const, ...inCycle(i + 1), verdict: cycle,
        artifact: `${dir}/cycle/iter-${i + 1}/review.md` },
    ]).flat(),
    { id: 'accept', kind: 'approval', status: 'done', loopId: 'build', iteration: attempt, stage,
      verdict: over.gate ?? 'pass', artifact: `${dir}/accept.md` },
  ];
}

function stagesRow(over: Partial<Row>): Row {
  return { id: 'build', kind: 'stages', status: 'failed', total: 3, ...over };
}

async function stagedFixture(steps: Row[], opts: ResumeOptions = {}): Promise<ResumePlan> {
  const workdir = await fixture(steps, { version: 5, workflow: 'staged' }, { snapshotText: STAGED_WORKFLOW });
  return planResume(workdir, DEFAULT_CONFIG, RUN_ID, opts);
}

test('a resumed staged run skips the stages it already accepted', async () => {
  const plan = await stagedFixture([
    stagesRow({ completedStages: ['01-a', '02-b'], currentStage: { id: '03-c', title: 'C', index: 3 }, attempt: 1 }),
    ...stageAttemptRows('01-a', 1),
    ...stageAttemptRows('02-b', 1),
    { id: 'cycle', kind: 'loop', status: 'interrupted', loopId: 'build', iteration: 1, stage: '03-c',
      iterations: 1, maxIterations: 2 },
    { id: 'execute', kind: 'agent', status: 'interrupted', loopId: 'cycle', iteration: 1,
      outerLoops: [{ id: 'build', iteration: 1, stage: '03-c' }] },
  ]);

  assert.deepEqual(plan.stagesCompleted.build, ['01-a', '02-b']);
  assert.equal(plan.restartAt?.stepId, 'execute', 'not the stages row, and not a row of an accepted stage');
  assert.ok(plan.done.has('accept@01-a#1'), 'a gate directly under a stage is keyed by its stage');
  assert.ok(plan.done.has('accept@02-b#1'));
  assert.ok(plan.done.has('build@01-a#1/execute#1'));
  assert.ok(!plan.done.has('accept'), 'never the bare id');
  assert.match(plan.warnings.join('\n'), /stages step 'build' resumes in stage 3 \('C'\); 2 accepted stage\(s\) will not run again/);
  assert.deepEqual(plan.stageBudgets, {});
  assert.deepEqual(plan.stagesInterrupted, { 'build@03-c': 1 });
  assert.deepEqual(plan.stagesStarted, ['build@01-a', 'build@02-b', 'build@03-c'],
    'every stage with a recorded row, so none of their gates claims "no changes"');
});

test('a run stopped in triage grants the rejected stage one more attempt; an interrupted one does not', async () => {
  const rejectedThrice = [
    ...stageAttemptRows('01-a', 1),
    ...stageAttemptRows('02-b', 1, { gate: 'fail' }),
    ...stageAttemptRows('02-b', 2, { gate: 'fail' }),
    ...stageAttemptRows('02-b', 3, { gate: 'fail' }),
  ];
  // `attempt` is deliberately stale: a crash can leave the scalar behind, so
  // the attempts used come from the stage's own rows.
  const exhausted = await stagedFixture([
    stagesRow({ completedStages: ['01-a'], currentStage: { id: '02-b', title: 'B', index: 2 }, attempt: 2,
      exhausted: true }),
    ...rejectedThrice,
  ]);
  assert.equal(exhausted.stageBudgets['build@02-b'], 4, '3 used, one more granted');
  assert.match(exhausted.warnings.join('\n'), /stage '02-b' was rejected 3 times; this resume allows one more attempt/);
  assert.deepEqual(exhausted.stagesInterrupted, {}, 'every attempt was answered');

  const interrupted = await stagedFixture([
    stagesRow({ completedStages: ['01-a'], currentStage: { id: '02-b', title: 'B', index: 2 }, attempt: 2 }),
    ...stageAttemptRows('01-a', 1),
    ...stageAttemptRows('02-b', 1, { gate: 'fail' }),
    { id: 'cycle', kind: 'loop', status: 'interrupted', loopId: 'build', iteration: 2, stage: '02-b',
      iterations: 1, maxIterations: 2 },
    { id: 'execute', kind: 'agent', status: 'interrupted', loopId: 'cycle', iteration: 1,
      outerLoops: [{ id: 'build', iteration: 2, stage: '02-b' }] },
  ]);
  assert.deepEqual(interrupted.stageBudgets, {});
  assert.doesNotMatch(interrupted.warnings.join('\n'), /rejected/);
  assert.deepEqual(interrupted.stagesInterrupted, { 'build@02-b': 2 }, 'the attempt that was cut short');  assert.deepEqual(interrupted.closedLoops, {
    'cycle@01-a#1': { budget: 2, completed: 1 },
    'cycle@02-b#1': { budget: 2, completed: 1 },
  }, 'the accepted stage and the rejected attempt replay at what they recorded; the open attempt is not closed');
  assert.equal(interrupted.loopBudgets['cycle@02-b#2']?.budget, 2);
});

test("a completed stage's exhausted inner loop gets no iteration grant", async () => {
  const plan = await stagedFixture([
    stagesRow({ completedStages: ['01-a'], currentStage: { id: '02-b', title: 'B', index: 2 }, attempt: 1 }),
    ...stageAttemptRows('01-a', 1, { cycle: 'fail' }),
    { id: 'cycle', kind: 'loop', status: 'interrupted', loopId: 'build', iteration: 1, stage: '02-b',
      iterations: 1, maxIterations: 2 },
    { id: 'execute', kind: 'agent', status: 'interrupted', loopId: 'cycle', iteration: 1,
      outerLoops: [{ id: 'build', iteration: 1, stage: '02-b' }] },
  ]);

  assert.equal(plan.loopBudgets['cycle@01-a#1'], undefined);
  assert.doesNotMatch(plan.warnings.join('\n'), /ran out of iterations/);
  assert.deepEqual(plan.loopBudgets['cycle@02-b#1'], { budget: 2, completed: 1 },
    "the unfinished stage's loop is still budgeted, under its stage-keyed row");
});

test('a loop in a stage attempt a gate already answered is replayed as it ran, not granted more', async () => {
  // Attempt 1's cycle exhausted and the human rejected it; attempt 2 was cut
  // short. Replaying attempt 1 must reproduce it — a +1 there would spawn a
  // third review inside an attempt that is already over.
  const plan = await stagedFixture([
    stagesRow({ completedStages: [], currentStage: { id: '01-a', title: 'A', index: 1 }, attempt: 2 }),
    ...stageAttemptRows('01-a', 1, { cycle: 'fail', gate: 'fail' }),
    { id: 'cycle', kind: 'loop', status: 'interrupted', loopId: 'build', iteration: 2, stage: '01-a',
      iterations: 1, maxIterations: 2 },
    { id: 'execute', kind: 'agent', status: 'interrupted', loopId: 'cycle', iteration: 1,
      outerLoops: [{ id: 'build', iteration: 2, stage: '01-a' }] },
  ], { extraIterations: 1 });

  assert.equal(plan.loopBudgets['cycle@01-a#1'], undefined, 'not even an explicit extraIterations reaches it');
  assert.deepEqual(plan.loopBudgets['cycle@01-a#2'], { budget: 3, completed: 1 },
    'the open attempt still takes the explicit grant');
});

test('an exhausted cycle inside a stage gets no default +1: the gate, not the loop, stopped there', async () => {
  const plan = await stagedFixture([
    stagesRow({ completedStages: [], currentStage: { id: '01-a', title: 'A', index: 1 }, attempt: 1 }),
    ...stageAttemptRows('01-a', 1, { cycle: 'fail' }).filter(r => r.id !== 'accept'),
    { id: 'accept', kind: 'approval', status: 'interrupted', loopId: 'build', iteration: 1, stage: '01-a' },
  ]);

  assert.equal(plan.loopBudgets['cycle@01-a#1'], undefined);
  assert.doesNotMatch(plan.warnings.join('\n'), /ran out of iterations/);
  assert.equal(plan.restartAt?.stepId, 'accept');
});

test('an orphaned done row in an earlier stage is still healed to the right path', async () => {
  const workdir = await fixture([
    stagesRow({ completedStages: ['01-a'], currentStage: { id: '02-b', title: 'B', index: 2 }, attempt: 1 }),
    { id: 'execute', kind: 'agent', status: 'done', loopId: 'cycle', iteration: 1,
      outerLoops: [{ id: 'build', iteration: 1, stage: '01-a' }], startedAt: RUN_START },
    { id: 'execute', kind: 'agent', status: 'done', loopId: 'cycle', iteration: 1,
      outerLoops: [{ id: 'build', iteration: 1, stage: '02-b' }], startedAt: RUN_START, artifact: '/r/b.md' },
  ], { version: 5, workflow: 'staged' }, { snapshotText: STAGED_WORKFLOW });
  const expected = await leaveArtifact(workdir, join('build', '01-a', 'attempt-1', 'cycle', 'iter-1', 'execute-report.md'));

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  // Healing must not collapse rows by bare id across stages.
  assert.match(plan.warnings.join('\n'), /adopting the 'execute-report\.md'/);
  assert.equal(plan.done.get('build@01-a#1/execute#1')?.artifact, expected, "in stage 01-a's own directory");
});

test('an orphaned done gate directly under a stage is looked for in that stage attempt', async () => {
  const workdir = await fixture([
    stagesRow({ completedStages: [], currentStage: { id: '01-a', title: 'A', index: 1 }, attempt: 2 }),
    { id: 'accept', kind: 'approval', status: 'done', loopId: 'build', iteration: 2, stage: '01-a',
      startedAt: RUN_START },
  ], { version: 5, workflow: 'staged' }, { snapshotText: STAGED_WORKFLOW });
  const expected = await leaveArtifact(workdir, join('build', '01-a', 'attempt-2', 'accept.md'));

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.equal(plan.done.get('accept@01-a#2')?.artifact, expected);
});

test('an exhausted cycle that chose on_exhausted: interactive stopped the run itself, so it keeps its +1', async () => {
  const workdir = await fixture([
    stagesRow({ completedStages: [], currentStage: { id: '01-a', title: 'A', index: 1 }, attempt: 1 }),
    ...stageAttemptRows('01-a', 1, { cycle: 'fail' }).filter(r => r.id !== 'accept'),
  ], { version: 5, workflow: 'staged' }, {
    snapshotText: STAGED_WORKFLOW.replace('max_iterations: 2\n', 'max_iterations: 2\n        on_exhausted: interactive\n'),
  });

  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);

  assert.deepEqual(plan.loopBudgets['cycle@01-a#1'], { budget: 3, completed: 2 });
  assert.match(plan.warnings.join('\n'), /loop 'cycle' ran out of iterations at 2; this resume allows 3/);
});

test('a granted attempt that was itself interrupted resumes that attempt, not a second triage', async () => {
  // Triage after three rejections, a resume granted attempt 4, and attempt 4
  // was cut short: `exhausted` is still set, but nothing new was rejected.
  const plan = await stagedFixture([
    stagesRow({ completedStages: [], currentStage: { id: '01-a', title: 'A', index: 1 }, attempt: 4,
      exhausted: true }),
    ...stageAttemptRows('01-a', 1, { gate: 'fail' }),
    ...stageAttemptRows('01-a', 2, { gate: 'fail' }),
    ...stageAttemptRows('01-a', 3, { gate: 'fail' }),
    { id: 'cycle', kind: 'loop', status: 'interrupted', loopId: 'build', iteration: 4, stage: '01-a',
      iterations: 1, maxIterations: 2 },
    { id: 'execute', kind: 'agent', status: 'interrupted', loopId: 'cycle', iteration: 1,
      outerLoops: [{ id: 'build', iteration: 4, stage: '01-a' }] },
  ], { extraIterations: 1 });

  assert.equal(plan.stageBudgets['build@01-a'], 4, 'the grant already given, not a fifth attempt');
  assert.doesNotMatch(plan.warnings.join('\n'), /rejected 4 times/);
  assert.doesNotMatch(plan.warnings.join('\n'), /this resume allows one more attempt/);
  assert.deepEqual(plan.stagesInterrupted, { 'build@01-a': 4 });
  assert.deepEqual(plan.loopBudgets['cycle@01-a#4'], { budget: 3, completed: 1 },
    "attempt 4's cycle is open, so the explicit grant reaches it");
  assert.doesNotMatch(plan.warnings.join('\n'), /had no effect/);
});
