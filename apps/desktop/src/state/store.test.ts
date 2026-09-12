import { beforeEach, describe, expect, it } from 'vitest';
import { ongoingJobs, useAppStore, waitingRunIds, type JobState } from './store.ts';
import { EMPTY_APP_STATE } from '../../../../packages/agent/src/app-state.ts';

/** A JobState with the fields these selector tests do not care about filled in. */
function baseJob(jobId: string): JobState {
  return {
    jobId, finished: false, stepOrder: [], steps: {}, currentExecution: {}, events: [], logTail: [], activityTail: [], hasNarrated: false,
    ptyActive: true, ptyDataBuffer: [], ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
  };
}

function resetStore(): void {
  useAppStore.setState({
    workspacePath: null,
    agentStatus: 'connecting',
    workflows: [],
    runs: [],
    doctorResult: null,
    config: null,
    jobs: {},
    appState: null,
    restoreDone: false,
    page: 'runs',
    pendingRunAgain: null,
    filesDirty: false,
  });
}

describe('setWorkspacePath', () => {
  beforeEach(() => resetStore());

  it('clears the previous workspace\'s cached data', () => {
    useAppStore.setState({
      workspacePath: '/ws/a',
      runs: [{ runId: 'r1', runDir: '/ws/a/.whiphand/runs/r1', status: 'succeeded' }],
      workflows: [{ name: 'feature', path: '/ws/a/.whiphand/workflows/feature.yaml', source: 'project' }],
      config: {
        config: {} as never,
        global: { config: {}, path: '/g/config.yaml', exists: false },
        project: { config: {}, path: '/ws/a/.whiphand/config.yaml', exists: true },
      },
      pendingRunAgain: { workflow: 'feature', inputs: {} },
    });

    useAppStore.getState().setWorkspacePath('/ws/b');

    const state = useAppStore.getState();
    expect(state.workspacePath).toBe('/ws/b');
    expect(state.runs).toEqual([]);
    expect(state.workflows).toEqual([]);
    expect(state.config).toBeNull();
    expect(state.pendingRunAgain).toBeNull();
  });

  it('keeps state the doctor RPC, the guard and Activity depend on', () => {
    const jobs = { j1: { ...baseJob('j1'), workdir: '/ws/a' } };
    useAppStore.setState({
      workspacePath: '/ws/a',
      doctorResult: [{
        id: 'claude', label: 'Claude Code', group: 'harness',
        runner: true, optional: false, installed: true,
      }],
      jobs,
      filesDirty: true,
    });

    useAppStore.getState().setWorkspacePath('/ws/b');

    const state = useAppStore.getState();
    expect(state.doctorResult).not.toBeNull();
    expect(state.jobs.j1).toBeDefined();
    // The guard has to run before the switch, so clearing this here would
    // silently bypass it.
    expect(state.filesDirty).toBe(true);
  });

  it('is a no-op when the path is already open', () => {
    const runs = [{ runId: 'r1', runDir: '/ws/a/.whiphand/runs/r1', status: 'succeeded' }];
    useAppStore.setState({ workspacePath: '/ws/a', runs });

    // openWorkspace re-adopts the agent's canonical path on every open,
    // including of the workspace already open.
    useAppStore.getState().setWorkspacePath('/ws/a');

    expect(useAppStore.getState().runs).toBe(runs);
  });
});

describe('job workspace attribution', () => {
  beforeEach(() => resetStore());

  it('tags a job at startRun, before any notification arrives', () => {
    useAppStore.getState().noteJobWorkspace('j1', '/ws/a');
    expect(useAppStore.getState().jobs.j1.workdir).toBe('/ws/a');
  });

  it('adopts the workdir carried on an whiphandEvent', () => {
    useAppStore.getState().applyWhiphandEvent({
      jobId: 'j1', workdir: '/ws/a', ts: '2026-01-01T00:00:00Z',
      event: { type: 'run:start', runId: 'r1', workflow: 'demo' },
    });
    expect(useAppStore.getState().jobs.j1.workdir).toBe('/ws/a');
  });

  it('does not restatus a visible run from another workspace', () => {
    const runs = [{ runId: 'r1', runDir: '/ws/a/.whiphand/runs/r1', status: 'running' }];
    useAppStore.setState({ workspacePath: '/ws/a', runs });

    useAppStore.getState().applyRunStateChanged({
      jobId: 'j2', runId: 'r1', workdir: '/ws/elsewhere', status: 'failed',
    });

    expect(useAppStore.getState().runs[0].status).toBe('running');
  });

  it('filters waiting run ids by workspace', () => {
    const jobs = {
      here: {
        ...baseJob('here'), runId: 'r1', workdir: '/ws/a',
        awaiting: { stepId: 's', reason: 'permission' as const },
      },
      elsewhere: {
        ...baseJob('elsewhere'), runId: 'r2', workdir: '/ws/b',
        awaiting: { stepId: 's', reason: 'permission' as const },
      },
    };
    expect(waitingRunIds(jobs, '/ws/a')).toEqual(new Set(['r1']));
    expect(waitingRunIds(jobs)).toEqual(new Set(['r1', 'r2']));
  });
});

describe('useAppStore reducers', () => {
  beforeEach(() => resetStore());

  it('applyWhiphandEvent upserts a step on step:start and marks it running', () => {
    useAppStore.getState().applyWhiphandEvent({
      jobId: 'j1',
      event: { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', model: 'opus', mode: 'headless' },
      ts: '2026-01-01T00:00:00Z',
    });

    const job = useAppStore.getState().jobs.j1;
    expect(job.stepOrder).toEqual(['plan']);
    expect(job.steps.plan).toMatchObject({
      id: 'plan', runner: 'claude', model: 'opus', mode: 'headless', status: 'running',
    });
    expect(job.finished).toBe(false);
  });

  it('applyWhiphandEvent finalizes an in-flight step when the run is cancelled', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent({
      jobId: 'j-cancel',
      event: { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless' },
      ts: '2026-01-01T00:00:00Z',
    });
    applyWhiphandEvent({
      jobId: 'j-cancel',
      event: { type: 'run:cancelled', runId: 'r1' },
      ts: '2026-01-01T00:00:30Z',
    });

    const step = useAppStore.getState().jobs['j-cancel'].steps['plan'];
    // Mirrors RunJournal in core: a run that is over can have no step in flight.
    expect(step.status).toBe('interrupted');
    expect(step.endedAt).toBe('2026-01-01T00:00:30Z');
  });

  it('applyWhiphandEvent blames the run:error step as failed and interrupts the others', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    for (const stepId of ['plan', 'implement']) {
      applyWhiphandEvent({
        jobId: 'j-err',
        event: { type: 'step:start', stepId, kind: 'agent', runner: 'claude', mode: 'headless' },
        ts: '2026-01-01T00:00:00Z',
      });
    }
    applyWhiphandEvent({
      jobId: 'j-err',
      event: { type: 'run:error', stepId: 'plan', message: 'session exited with code 1' },
      ts: '2026-01-01T00:00:30Z',
    });

    const { steps } = useAppStore.getState().jobs['j-err'];
    expect(steps['plan'].status).toBe('failed');
    expect(steps['implement'].status).toBe('interrupted');
  });

  it('applyWhiphandEvent leaves already-terminal steps alone when the run ends', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent({
      jobId: 'j-done',
      event: { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless' },
      ts: '2026-01-01T00:00:00Z',
    });
    applyWhiphandEvent({
      jobId: 'j-done',
      event: { type: 'step:done', stepId: 'plan', exitCode: 0 },
      ts: '2026-01-01T00:00:10Z',
    });
    applyWhiphandEvent({
      jobId: 'j-done',
      event: { type: 'run:done', runId: 'r1', ok: true },
      ts: '2026-01-01T00:00:20Z',
    });

    const step = useAppStore.getState().jobs['j-done'].steps['plan'];
    expect(step.status).toBe('done');
    expect(step.endedAt).toBe('2026-01-01T00:00:10Z');
  });

  it('applyWhiphandEvent upserts an unknown stepId without crashing (ptyStarted-before-step:start case)', () => {
    // The interactive on_findings triage flow can emit step:artifact for a
    // stepId ('triage') that never got a step:start — must not throw, and
    // must create a sane default entry.
    useAppStore.getState().applyWhiphandEvent({
      jobId: 'j1',
      event: { type: 'step:artifact', stepId: 'triage', path: '/tmp/triage.md' },
      ts: '2026-01-01T00:00:01Z',
    });

    const job = useAppStore.getState().jobs.j1;
    expect(job.steps.triage).toMatchObject({ id: 'triage', status: 'pending', artifact: '/tmp/triage.md' });
  });

  it('applyWhiphandEvent drives status through spawn -> artifact -> verdict -> done, and run:done marks the job finished', () => {
    const apply = useAppStore.getState().applyWhiphandEvent;
    apply({ jobId: 'j1', event: { type: 'run:start', runId: 'r1', workflow: 'demo' }, ts: 't0' });
    apply({
      jobId: 'j1',
      event: { type: 'step:start', stepId: 'review', kind: 'agent', runner: 'claude', mode: 'headless' },
      ts: 't1',
    });
    apply({
      jobId: 'j1',
      event: {
        type: 'step:spawn', stepId: 'review', phase: 'main',
        spec: { argv: ['claude'], cwd: '/ws', env: {}, interactive: false },
      },
      ts: 't2',
    });
    apply({ jobId: 'j1', event: { type: 'step:artifact', stepId: 'review', path: '/ws/review.md' }, ts: 't3' });
    apply({ jobId: 'j1', event: { type: 'step:verdict', stepId: 'review', verdict: 'pass' }, ts: 't4' });
    apply({ jobId: 'j1', event: { type: 'step:done', stepId: 'review', exitCode: 0 }, ts: 't5' });
    apply({ jobId: 'j1', event: { type: 'run:done', runId: 'r1', ok: true }, ts: 't6' });

    const job = useAppStore.getState().jobs.j1;
    expect(job.runId).toBe('r1');
    expect(job.steps.review).toMatchObject({
      status: 'done', exitCode: 0, artifact: '/ws/review.md', verdict: 'pass', startedAt: 't1', endedAt: 't5',
    });
    expect(job.finished).toBe(true);
    expect(job.events).toHaveLength(7);
  });

  it('applyWhiphandEvent marks a step failed on non-zero exit and records run:error message', () => {
    const apply = useAppStore.getState().applyWhiphandEvent;
    apply({
      jobId: 'j1',
      event: { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless' },
      ts: 't0',
    });
    apply({ jobId: 'j1', event: { type: 'step:done', stepId: 'plan', exitCode: 1 }, ts: 't1' });
    apply({ jobId: 'j1', event: { type: 'run:error', stepId: 'plan', message: 'boom' }, ts: 't2' });

    const job = useAppStore.getState().jobs.j1;
    expect(job.steps.plan.status).toBe('failed');
    expect(job.finished).toBe(true);
    expect(job.errorMessage).toBe('boom');
  });

  it('applyWhiphandEvent blames the run:error step even after a clean step:done', () => {
    // The tail of a step — the read-only guard, the artifact assertion — runs
    // after its child exits, so step:done reports 0 for a step that then fails.
    const apply = useAppStore.getState().applyWhiphandEvent;
    apply({
      jobId: 'j1',
      event: { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive' },
      ts: 't0',
    });
    apply({ jobId: 'j1', event: { type: 'step:done', stepId: 'plan', exitCode: 0 }, ts: 't1' });
    apply({
      jobId: 'j1',
      event: { type: 'run:error', stepId: 'plan', message: "read-only step 'plan' modified the tree: M a.ts" },
      ts: 't2',
    });

    const job = useAppStore.getState().jobs.j1;
    expect(job.steps.plan.status).toBe('failed');
    expect(job.steps.plan.exitCode).toBe(0);
    expect(job.steps.plan.endedAt).toBe('t1'); // step:done already knew when it ended
  });

  it('applyRunStateChanged sets job status and merges into a matching runs list entry', () => {
    useAppStore.getState().setRuns([
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'running' },
      { runId: 'r2', runDir: '/ws/.whiphand/runs/r2', status: 'succeeded' },
    ]);

    useAppStore.getState().applyRunStateChanged({ jobId: 'j1', runId: 'r1', status: 'succeeded' });

    const state = useAppStore.getState();
    expect(state.jobs.j1).toMatchObject({ jobId: 'j1', runId: 'r1', status: 'succeeded' });
    expect(state.runs.find(r => r.runId === 'r1')?.status).toBe('succeeded');
    expect(state.runs.find(r => r.runId === 'r2')?.status).toBe('succeeded'); // unaffected: different runId
  });

  it('applyStepLog appends lines and caps the tail at 2000', () => {
    const apply = useAppStore.getState().applyStepLog;
    for (let i = 0; i < 2005; i += 1) {
      apply({ jobId: 'j1', stream: 'stdout', line: `line ${i}` });
    }
    const job = useAppStore.getState().jobs.j1;
    expect(job.logTail).toHaveLength(2000);
    expect(job.logTail[0].line).toBe('line 5'); // oldest 5 lines evicted
    expect(job.logTail.at(-1)?.line).toBe('line 2004');
  });

  it('applyPtyStarted sets ptyActive/ptyStepId/cols/rows and applyPtyExit clears ptyActive', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'j1', stepId: 'triage', cols: 80, rows: 24 });
    expect(useAppStore.getState().jobs.j1).toMatchObject({
      ptyActive: true, ptyStepId: 'triage', ptyCols: 80, ptyRows: 24,
    });

    useAppStore.getState().applyPtyExit({ jobId: 'j1', exitCode: 0 });
    expect(useAppStore.getState().jobs.j1.ptyActive).toBe(false);
  });

  it('applyPtyExit sets ptyExited and records the exit code', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'j1', stepId: 'triage', cols: 80, rows: 24 });
    useAppStore.getState().applyPtyExit({ jobId: 'j1', exitCode: 3 });

    expect(useAppStore.getState().jobs.j1).toMatchObject({ ptyExited: true, ptyExitCode: 3 });
  });

  it('applyPtyExit records why the session ended, so the UI can tell a deliberate close from a crash', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'j1', stepId: 'plan', cols: 80, rows: 24 });
    useAppStore.getState().applyPtyExit({ jobId: 'j1', exitCode: 0, reason: 'ended' });

    expect(useAppStore.getState().jobs.j1.ptyExitReason).toBe('ended');
  });

  it('applyPtyAwait records what the session is waiting for, and clears when it works again', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'j1', stepId: 'plan', cols: 80, rows: 24 });
    useAppStore.getState().applyPtyAwait({ jobId: 'j1', stepId: 'plan', awaiting: true, reason: 'permission' });
    expect(useAppStore.getState().jobs.j1.awaiting).toEqual({ stepId: 'plan', reason: 'permission' });

    useAppStore.getState().applyPtyAwait({ jobId: 'j1', stepId: 'plan', awaiting: false });
    expect(useAppStore.getState().jobs.j1.awaiting).toBeUndefined();
  });

  it('a new session and a finished one both drop a stale awaiting flag', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'j1', stepId: 'first', cols: 80, rows: 24 });
    useAppStore.getState().applyPtyAwait({ jobId: 'j1', stepId: 'first', awaiting: true, reason: 'turn' });
    useAppStore.getState().applyPtyExit({ jobId: 'j1', exitCode: 0, reason: 'ended' });
    expect(useAppStore.getState().jobs.j1.awaiting).toBeUndefined();

    useAppStore.getState().applyPtyAwait({ jobId: 'j1', stepId: 'first', awaiting: true, reason: 'turn' });
    useAppStore.getState().applyPtyStarted({ jobId: 'j1', stepId: 'second', cols: 80, rows: 24 });
    expect(useAppStore.getState().jobs.j1.awaiting).toBeUndefined();
  });

  it('applyPtyData buffers chunks for a job in arrival order, so a not-yet-mounted terminal loses nothing', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'j1', stepId: 'triage', cols: 80, rows: 24 });
    useAppStore.getState().applyPtyData({ jobId: 'j1', data: 'aGVsbG8=' });
    useAppStore.getState().applyPtyData({ jobId: 'j1', data: 'IHdvcmxk' });

    expect(useAppStore.getState().jobs.j1.ptyDataBuffer).toEqual(['aGVsbG8=', 'IHdvcmxk']);
  });

  it('applyPtyStarted resets the ptyData buffer and exit state for a fresh session', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'j1', stepId: 'first', cols: 80, rows: 24 });
    useAppStore.getState().applyPtyData({ jobId: 'j1', data: 'aGVsbG8=' });
    useAppStore.getState().applyPtyExit({ jobId: 'j1', exitCode: 0, reason: 'ended' });

    useAppStore.getState().applyPtyStarted({ jobId: 'j1', stepId: 'second', cols: 80, rows: 24 });

    expect(useAppStore.getState().jobs.j1).toMatchObject({
      ptyDataBuffer: [], ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false, ptyExitCode: undefined,
    });
    expect(useAppStore.getState().jobs.j1.ptyExitReason).toBeUndefined();
  });

  it('applyPtyData trims from the front once the buffer exceeds its size cap, advancing ptyDataBaseIndex and setting ptyDataTrimmed', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'j1', stepId: 'triage', cols: 80, rows: 24 });

    // Each chunk is 1,000,000 chars; the cap is 2,000,000 — a 3rd chunk must
    // push the total over the cap and force the oldest chunk out.
    const chunk = (id: string) => id.repeat(1_000_000 / id.length);
    useAppStore.getState().applyPtyData({ jobId: 'j1', data: chunk('a') });
    useAppStore.getState().applyPtyData({ jobId: 'j1', data: chunk('b') });
    expect(useAppStore.getState().jobs.j1.ptyDataTrimmed).toBe(false);
    expect(useAppStore.getState().jobs.j1.ptyDataBaseIndex).toBe(0);

    useAppStore.getState().applyPtyData({ jobId: 'j1', data: chunk('c') });

    const job = useAppStore.getState().jobs.j1;
    expect(job.ptyDataBuffer).toEqual([chunk('b'), chunk('c')]); // oldest ('a') trimmed from the front
    expect(job.ptyDataBaseIndex).toBe(1); // buffer[0] is now absolute chunk index 1
    expect(job.ptyDataTrimmed).toBe(true);
  });

  it('applyPtyData never drops the single newest chunk, even if it alone exceeds the cap', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'j1', stepId: 'triage', cols: 80, rows: 24 });
    const huge = 'x'.repeat(3_000_000);

    useAppStore.getState().applyPtyData({ jobId: 'j1', data: huge });

    const job = useAppStore.getState().jobs.j1;
    expect(job.ptyDataBuffer).toEqual([huge]);
    expect(job.ptyDataBaseIndex).toBe(0);
    expect(job.ptyDataTrimmed).toBe(false); // nothing was actually dropped — the lone chunk was kept as-is
  });

  it('ptyDataTrimmed stays true once set for the session, even if later chunks bring the total back under the cap threshold logic', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'j1', stepId: 'triage', cols: 80, rows: 24 });
    const chunk = (id: string) => id.repeat(1_000_000 / id.length);
    useAppStore.getState().applyPtyData({ jobId: 'j1', data: chunk('a') });
    useAppStore.getState().applyPtyData({ jobId: 'j1', data: chunk('b') });
    useAppStore.getState().applyPtyData({ jobId: 'j1', data: chunk('c') }); // triggers the first trim

    useAppStore.getState().applyPtyData({ jobId: 'j1', data: 'small' }); // small chunk, no further trim needed

    expect(useAppStore.getState().jobs.j1.ptyDataTrimmed).toBe(true);
  });
});

describe('app-state slice', () => {
  beforeEach(() => resetStore());

  it('starts unrestored with no appState and the runs page', () => {
    const s = useAppStore.getState();
    expect(s.appState).toBeNull();
    expect(s.restoreDone).toBe(false);
    expect(s.page).toBe('runs');
  });

  it('patchAppState shallow-merges onto a loaded state', () => {
    useAppStore.getState().setAppState(EMPTY_APP_STATE);
    useAppStore.getState().patchAppState({ theme: 'dark' });
    expect(useAppStore.getState().appState?.theme).toBe('dark');
    expect(useAppStore.getState().appState?.recentWorkspaces).toEqual([]);
  });

  it('rememberInputsLocal mirrors the agent-side rememberRun shape', () => {
    useAppStore.getState().setAppState(EMPTY_APP_STATE);
    useAppStore.getState().rememberInputsLocal('/ws', 'feature', { ticket: 'T-1' });
    const memory = useAppStore.getState().appState?.workspaces['/ws'];
    expect(memory?.lastWorkflow).toBe('feature');
    expect(memory?.lastInputs.feature).toEqual({ ticket: 'T-1' });
  });
});

describe('waitingRunIds', () => {
  it('names the runs whose live session is blocked on the human', () => {
    expect(waitingRunIds({
      a: { ...baseJob('a'), runId: 'run-a', awaiting: { stepId: 'plan', reason: 'permission' } },
      b: { ...baseJob('b'), runId: 'run-b' },
    })).toEqual(new Set(['run-a']));
  });

  it('ignores a finished job: a sidecar that died mid-session never sent its ptyExit', () => {
    expect(waitingRunIds({
      a: { ...baseJob('a'), runId: 'run-a', finished: true, awaiting: { stepId: 'plan', reason: 'turn' } },
    })).toEqual(new Set());
  });

  it('ignores a job with no runId yet: the runs grid has nothing to match it to', () => {
    expect(waitingRunIds({
      a: { ...baseJob('a'), awaiting: { stepId: 'plan', reason: 'turn' } },
    })).toEqual(new Set());
  });
});

describe('ongoingJobs', () => {
  it('excludes finished jobs', () => {
    const jobs = {
      a: { ...baseJob('a'), finished: true },
      b: { ...baseJob('b') },
    };
    expect(ongoingJobs(jobs).map(j => j.jobId)).toEqual(['b']);
  });

  it('sorts jobs waiting on the human before running ones', () => {
    const pendingManual = {
      stepId: 's', kind: 'approval' as const, title: 'Ship it?', instructions: '',
      choices: ['continue' as const, 'abort' as const], context: { artifacts: [] },
      defaultChoice: 'continue' as const,
    };
    const jobs = {
      a: { ...baseJob('a') },
      b: { ...baseJob('b'), awaiting: { stepId: 's', reason: 'permission' as const } },
      c: { ...baseJob('c'), pendingManual },
    };
    expect(ongoingJobs(jobs).map(j => j.jobId)).toEqual(['b', 'c', 'a']);
  });

  it('keeps arrival order stable within each group', () => {
    const jobs = {
      first: { ...baseJob('first') },
      second: { ...baseJob('second') },
      third: { ...baseJob('third') },
    };
    expect(ongoingJobs(jobs).map(j => j.jobId)).toEqual(['first', 'second', 'third']);
  });

  it('a job that starts waiting jumps to the top', () => {
    const jobs = {
      first: { ...baseJob('first') },
      second: { ...baseJob('second'), awaiting: { stepId: 's', reason: 'turn' as const } },
    };
    expect(ongoingJobs(jobs).map(j => j.jobId)).toEqual(['second', 'first']);
  });
});

// ---------------------------------------------------------------------------
// Loops and manual steps
// ---------------------------------------------------------------------------

describe('loop executions', () => {
  it('gives each iteration of a step its own row, keyed by execution', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    const jobId = 'j-loop';
    applyWhiphandEvent({
      jobId, event: { type: 'loop:start', loopId: 'fix', maxIterations: 3 }, ts: 't0',
    });
    for (const iteration of [1, 2]) {
      applyWhiphandEvent({
        jobId, event: { type: 'loop:iteration', loopId: 'fix', iteration, maxIterations: 3 }, ts: 't0',
      });
      applyWhiphandEvent({
        jobId,
        event: {
          type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'claude',
          mode: 'headless', loopId: 'fix', iteration,
        },
        ts: 't1',
      });
      applyWhiphandEvent({
        jobId, event: { type: 'step:artifact', stepId: 'execute', path: `/r/iter-${iteration}/e.md` }, ts: 't2',
      });
      applyWhiphandEvent({ jobId, event: { type: 'step:done', stepId: 'execute', exitCode: 0 }, ts: 't3' });
    }
    applyWhiphandEvent({
      jobId, event: { type: 'loop:done', loopId: 'fix', iterations: 2, passed: true }, ts: 't4',
    });

    const job = useAppStore.getState().jobs[jobId];
    expect(job.stepOrder).toEqual(['fix', 'execute', 'execute#2']);
    expect(job.steps['execute'].artifact).toBe('/r/iter-1/e.md');
    expect(job.steps['execute#2'].artifact).toBe('/r/iter-2/e.md');
    expect(job.steps['execute#2'].iteration).toBe(2);
    expect(job.steps['execute#2'].loopId).toBe('fix');
    expect(job.steps['fix'].kind).toBe('loop');
    expect(job.steps['fix'].iterations).toBe(2);
    expect(job.steps['fix'].status).toBe('done');
  });

  it('routes a later event to the execution that started, not the first one', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    const jobId = 'j-route';
    for (const iteration of [1, 2]) {
      applyWhiphandEvent({
        jobId,
        event: { type: 'step:start', stepId: 'tests', kind: 'command', loopId: 'fix', iteration },
        ts: 't1',
      });
    }
    applyWhiphandEvent({ jobId, event: { type: 'step:verdict', stepId: 'tests', verdict: 'pass' }, ts: 't2' });

    const job = useAppStore.getState().jobs[jobId];
    expect(job.steps['tests'].verdict).toBeUndefined();
    expect(job.steps['tests#2'].verdict).toBe('pass');
  });

  it('records a command step kind so the UI can tell it from an agent turn', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent({
      jobId: 'j-kind', event: { type: 'step:start', stepId: 'tests', kind: 'command' }, ts: 't1',
    });
    expect(useAppStore.getState().jobs['j-kind'].steps['tests'].kind).toBe('command');
  });
});

describe('manual steps', () => {
  const request = {
    stepId: 'sign', kind: 'approval' as const, title: 'Ship it?', instructions: 'Look.',
    choices: ['continue' as const, 'abort' as const], context: { artifacts: [] },
    defaultChoice: 'continue' as const,
  };

  it('parks the job on a request and clears it when answered', () => {
    const { applyManualRequest, applyManualResolved } = useAppStore.getState();
    applyManualRequest({ jobId: 'j-man', runId: 'r1', request });
    expect(useAppStore.getState().jobs['j-man'].pendingManual).toEqual(request);
    expect(useAppStore.getState().jobs['j-man'].runId).toBe('r1');

    applyManualResolved({ jobId: 'j-man', stepId: 'sign', choice: 'continue' });
    expect(useAppStore.getState().jobs['j-man'].pendingManual).toBeUndefined();
  });

  it('a resolve naming a different step does not dismiss the live card', () => {
    const { applyManualRequest, applyManualResolved } = useAppStore.getState();
    applyManualRequest({ jobId: 'j-stale', request });
    applyManualResolved({ jobId: 'j-stale', stepId: 'some-earlier-step' });
    expect(useAppStore.getState().jobs['j-stale'].pendingManual).toEqual(request);
  });

  it('a run that ends while parked leaves no card behind', () => {
    const { applyManualRequest, applyWhiphandEvent } = useAppStore.getState();
    applyManualRequest({ jobId: 'j-end', request });
    applyWhiphandEvent({ jobId: 'j-end', event: { type: 'run:cancelled', runId: 'r1' }, ts: 't1' });
    expect(useAppStore.getState().jobs['j-end'].pendingManual).toBeUndefined();
  });

  it('counts as waiting on the human, like an interactive session does', () => {
    const { applyManualRequest, applyRunStateChanged } = useAppStore.getState();
    applyRunStateChanged({ jobId: 'j-wait', runId: 'run-wait', status: 'running' });
    applyManualRequest({ jobId: 'j-wait', runId: 'run-wait', request });
    expect(waitingRunIds(useAppStore.getState().jobs).has('run-wait')).toBe(true);
  });
});

describe('applyWhiphandEvent: headless step progress', () => {
  beforeEach(() => resetStore());

  const start = (stepId: string, iteration?: number) => ({
    jobId: 'j1', runId: 'r1', ts: '2026-09-06T10:00:00.000Z',
    event: {
      type: 'step:start' as const, stepId, kind: 'agent' as const,
      runner: 'claude', mode: 'headless' as const,
      ...(iteration ? { loopId: 'fix', iteration } : {}),
    },
  });
  const spawn = (stepId: string, phase: 'main' | 'harvest') => ({
    jobId: 'j1', runId: 'r1', ts: '2026-09-06T10:00:00.500Z',
    event: {
      type: 'step:spawn' as const, stepId, phase,
      spec: { argv: ['claude'], cwd: '/ws', env: {}, interactive: false },
    },
  });
  const progress = (stepId: string, p: unknown) => ({
    jobId: 'j1', runId: 'r1', ts: '2026-09-06T10:00:01.000Z',
    event: { type: 'step:progress' as const, stepId, progress: p as never },
  });

  it("records a tool call as the step's last action and in the activity feed", () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent(start('impl'));
    applyWhiphandEvent(progress('impl', { kind: 'tool', tool: 'Edit', target: 'runner.ts' }));

    const job = useAppStore.getState().jobs['j1'];
    expect(job.steps['impl'].progress?.lastAction).toBe('Edit runner.ts');
    expect(job.activityTail).toEqual([{ stepId: 'impl', text: 'Edit runner.ts' }]);
  });

  it('shows prose in the feed but never as the last action', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent(start('impl'));
    applyWhiphandEvent(progress('impl', { kind: 'text', text: 'Looking at the runner' }));

    const job = useAppStore.getState().jobs['j1'];
    expect(job.steps['impl'].progress).toBeUndefined();
    expect(job.activityTail).toEqual([{ stepId: 'impl', text: 'Looking at the runner' }]);
  });

  it('folds counters onto the step without touching the feed', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent(start('impl'));
    applyWhiphandEvent(progress('impl', { kind: 'usage', turns: 5, costUsd: 0.3 }));

    const job = useAppStore.getState().jobs['j1'];
    expect(job.steps['impl'].progress).toEqual({ turns: 5, costUsd: 0.3 });
    expect(job.activityTail).toEqual([]);
  });

  it('caps the activity feed the way the log tail is capped', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent(start('impl'));
    for (let i = 0; i < 2100; i++) {
      applyWhiphandEvent(progress('impl', { kind: 'tool', tool: 'Read', target: `f${i}.ts` }));
    }
    const job = useAppStore.getState().jobs['j1'];
    expect(job.activityTail.length).toBe(2000);
    expect(job.activityTail.at(-1)).toEqual({ stepId: 'impl', text: 'Read f2099.ts' });
  });

  it('attaches progress to the current loop iteration, not an earlier one', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent(start('impl', 1));
    applyWhiphandEvent(progress('impl', { kind: 'tool', tool: 'Read', target: 'first.ts' }));
    applyWhiphandEvent(start('impl', 2));
    applyWhiphandEvent(progress('impl', { kind: 'tool', tool: 'Read', target: 'second.ts' }));

    const job = useAppStore.getState().jobs['j1'];
    expect(job.steps['impl'].progress?.lastAction).toBe('Read first.ts');
    expect(job.steps['impl#2'].progress?.lastAction).toBe('Read second.ts');
  });

  it('records the harvest phase, so a step can say it is writing its artifact', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent(start('plan'));
    expect(useAppStore.getState().jobs['j1'].steps['plan'].phase).toBeUndefined();

    applyWhiphandEvent(spawn('plan', 'main'));
    expect(useAppStore.getState().jobs['j1'].steps['plan'].phase).toBe('main');

    applyWhiphandEvent(spawn('plan', 'harvest'));
    expect(useAppStore.getState().jobs['j1'].steps['plan'].phase).toBe('harvest');
  });

  it('drops the phase when the step finishes, so a done step is not still generating', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent(start('plan'));
    applyWhiphandEvent(spawn('plan', 'harvest'));
    applyWhiphandEvent({
      jobId: 'j1', runId: 'r1', ts: '2026-09-06T10:00:02.000Z',
      event: { type: 'step:done' as const, stepId: 'plan', exitCode: 0 },
    });

    expect(useAppStore.getState().jobs['j1'].steps['plan'].phase).toBeUndefined();
  });

  it('starts a re-run clean rather than inheriting the last attempt\'s phase', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent(start('plan', 1));
    applyWhiphandEvent(spawn('plan', 'harvest'));
    applyWhiphandEvent(start('plan', 2));

    expect(useAppStore.getState().jobs['j1'].steps['plan#2'].phase).toBeUndefined();
  });

  it('starts the feed over for each step, so it only shows the step running now', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent(start('execute'));
    applyWhiphandEvent(progress('execute', { kind: 'tool', tool: 'Edit', target: 'runner.ts' }));
    applyWhiphandEvent(start('review'));

    expect(useAppStore.getState().jobs['j1'].activityTail).toEqual([]);
  });

  it('latches hasNarrated so the per-step reset cannot un-narrate the run', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent(start('execute'));
    expect(useAppStore.getState().jobs['j1'].hasNarrated).toBe(false);

    applyWhiphandEvent(progress('execute', { kind: 'text', text: 'Reading the runner' }));
    expect(useAppStore.getState().jobs['j1'].hasNarrated).toBe(true);

    // The feed empties, but the run has still spoken — the Terminal tab must
    // not fall back to Logs in the gap before the next step's first line.
    applyWhiphandEvent(start('review'));
    expect(useAppStore.getState().jobs['j1'].hasNarrated).toBe(true);
  });

  it('does not narrate on counters alone, which never reach the feed', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent(start('execute'));
    applyWhiphandEvent(progress('execute', { kind: 'usage', turns: 3 }));

    expect(useAppStore.getState().jobs['j1'].hasNarrated).toBe(false);
  });
});

describe('resumed runs', () => {
  it('picks up the run id from a resume, which has no run:start', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent({
      jobId: 'j-res', event: { type: 'run:resume', runId: 'r-res', workflow: 'cycle' }, ts: 't0',
    });

    expect(useAppStore.getState().jobs['j-res'].runId).toBe('r-res');
  });

  it('shows a skipped step as done rather than leaving it blank', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent({ jobId: 'j-skip', event: { type: 'step:skipped', stepId: 'plan' }, ts: 't1' });

    // It did finish — in an earlier attempt. A pending pill would misreport it.
    expect(useAppStore.getState().jobs['j-skip'].steps['plan'].status).toBe('done');
  });

  it('keys a skipped loop-body step by its iteration', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    applyWhiphandEvent({
      jobId: 'j-skip2',
      event: { type: 'step:skipped', stepId: 'edit', loopId: 'fix', iteration: 2 },
      ts: 't1',
    });

    const job = useAppStore.getState().jobs['j-skip2'];
    expect(job.steps['edit#2'].status).toBe('done');
    expect(job.steps['edit#2'].loopId).toBe('fix');
  });
});

describe('loop iteration budget', () => {
  it('remembers how many iterations a loop is allowed, not just how many it has run', () => {
    const { applyWhiphandEvent } = useAppStore.getState();
    const jobId = 'j-budget';
    applyWhiphandEvent({ jobId, event: { type: 'loop:start', loopId: 'fix', maxIterations: 3 }, ts: 't0' });
    applyWhiphandEvent({
      jobId, event: { type: 'loop:iteration', loopId: 'fix', iteration: 2, maxIterations: 3 }, ts: 't1',
    });

    // 'iteration 2' alone does not say whether the loop is nearly out of rope.
    const loop = useAppStore.getState().jobs[jobId].steps['fix'];
    expect(loop.maxIterations).toBe(3);
    expect(loop.iterations).toBe(2);
  });
});
