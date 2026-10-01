import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './store.ts';
import type { JobScrollbackResult, JobSummary } from '../../../../packages/agent/src/protocol.ts';

const store = () => useAppStore.getState();

function ptySnapshot(over: Partial<NonNullable<JobScrollbackResult['pty']>> = {}): JobScrollbackResult {
  return {
    pty: {
      stepId: 's1', cols: 80, rows: 24,
      baseIndex: 0, trimmed: false, chunks: ['a', 'b'], exited: false,
      ...over,
    },
    logs: { baseIndex: 0, trimmed: false, lines: [] },
  };
}

beforeEach(() => {
  useAppStore.setState({ jobs: {} });
});

describe('applyPtyData with seq', () => {
  it('files the first chunk at its real position when joining mid-run', () => {
    store().applyPtyStarted({ jobId: 'j1', stepId: 's1', cols: 80, rows: 24 });
    // The run has already produced 5000 chunks; this client only sees #5000.
    store().applyPtyData({ jobId: 'j1', data: 'x', seq: 5000 });

    const job = store().jobs.j1!;
    expect(job.ptyDataBaseIndex).toBe(5000);
    expect(job.ptyDataTrimmed).toBe(true);
    // The invariant: buffer[0] IS absolute chunk 5000.
    expect(job.ptyDataBuffer).toEqual(['x']);
  });

  it('behaves exactly as before when the run is watched from the start', () => {
    store().applyPtyStarted({ jobId: 'j1', stepId: 's1', cols: 80, rows: 24 });
    store().applyPtyData({ jobId: 'j1', data: 'a', seq: 0 });
    store().applyPtyData({ jobId: 'j1', data: 'b', seq: 1 });

    const job = store().jobs.j1!;
    expect(job.ptyDataBaseIndex).toBe(0);
    expect(job.ptyDataTrimmed).toBe(false);
    expect(job.ptyDataBuffer).toEqual(['a', 'b']);
  });

  it('ignores seq once a buffer exists, so live appends stay sequential', () => {
    store().applyPtyStarted({ jobId: 'j1', stepId: 's1', cols: 80, rows: 24 });
    store().applyPtyData({ jobId: 'j1', data: 'a', seq: 0 });
    store().applyPtyData({ jobId: 'j1', data: 'b', seq: 1 });

    expect(store().jobs.j1!.ptyDataBaseIndex).toBe(0);
  });

  it('still works against an agent that sends no seq at all', () => {
    store().applyPtyStarted({ jobId: 'j1', stepId: 's1', cols: 80, rows: 24 });
    store().applyPtyData({ jobId: 'j1', data: 'a' });

    const job = store().jobs.j1!;
    expect(job.ptyDataBaseIndex).toBe(0);
    expect(job.ptyDataTrimmed).toBe(false);
  });
});

describe('applyScrollbackSnapshot', () => {
  it('seeds a job this client never saw start', () => {
    store().applyScrollbackSnapshot('j1', ptySnapshot());

    const job = store().jobs.j1!;
    expect(job.ptyDataBuffer).toEqual(['a', 'b']);
    expect(job.ptyStepId).toBe('s1');
    expect(job.ptyActive).toBe(true);
  });

  it('splices in front of chunks that arrived while the request was in flight', () => {
    // The socket delivered #3 and #4 before getJobScrollback answered.
    store().applyPtyStarted({ jobId: 'j1', stepId: 's1', cols: 80, rows: 24 });
    store().applyPtyData({ jobId: 'j1', data: 'd', seq: 3 });
    store().applyPtyData({ jobId: 'j1', data: 'e', seq: 4 });

    store().applyScrollbackSnapshot('j1', ptySnapshot({ chunks: ['a', 'b', 'c'], baseIndex: 0 }));

    const job = store().jobs.j1!;
    expect(job.ptyDataBuffer).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(job.ptyDataBaseIndex).toBe(0);
    expect(job.ptyDataTrimmed).toBe(false);
  });

  it('never un-sets an exit already seen live', () => {
    store().applyPtyStarted({ jobId: 'j1', stepId: 's1', cols: 80, rows: 24 });
    store().applyPtyExit({ jobId: 'j1', exitCode: 0, reason: 'ended' });

    // A snapshot taken before the exit must not resurrect the session.
    store().applyScrollbackSnapshot('j1', ptySnapshot({ exited: false }));

    const job = store().jobs.j1!;
    expect(job.ptyExited).toBe(true);
    expect(job.ptyExitReason).toBe('ended');
    expect(job.ptyActive).toBe(false);
  });

  it('adopts an exit the snapshot knows about and this client missed', () => {
    store().applyScrollbackSnapshot('j1', ptySnapshot({ exited: true, exitCode: 2, exitReason: 'exit' }));

    const job = store().jobs.j1!;
    expect(job.ptyExited).toBe(true);
    expect(job.ptyExitCode).toBe(2);
    expect(job.ptyActive).toBe(false);
  });

  it('seeds an empty log tail but never disturbs live lines', () => {
    const logs = { baseIndex: 0, trimmed: false, lines: [{ stream: 'stdout' as const, line: 'old' }] };
    store().applyScrollbackSnapshot('j1', { pty: null, logs });
    expect(store().jobs.j1!.logTail).toEqual([{ stream: 'stdout', line: 'old' }]);

    store().applyStepLog({ jobId: 'j2', stream: 'stdout', line: 'live' });
    store().applyScrollbackSnapshot('j2', { pty: null, logs });
    // Live output is strictly newer; re-seeding would duplicate or reorder it.
    expect(store().jobs.j2!.logTail).toEqual([{ stream: 'stdout', line: 'live' }]);
  });

  it('carries a pending await through to a late attacher', () => {
    store().applyScrollbackSnapshot('j1', ptySnapshot({
      awaiting: { stepId: 's1', reason: 'permission' },
    }));
    expect(store().jobs.j1!.awaiting).toEqual({ stepId: 's1', reason: 'permission' });
  });
});

describe('applyEventReplay', () => {
  const start = (stepId: string, seq: number, iteration?: number) => ({
    jobId: 'j1', runId: 'r1', ts: `t${seq}`, seq,
    event: {
      type: 'step:start' as const, stepId, kind: 'agent' as const, runner: 'claude', mode: 'headless' as const,
      ...(iteration ? { loopId: 'fix', iteration } : {}),
    },
  });
  const done = (stepId: string, seq: number, exitCode = 0) => ({
    jobId: 'j1', runId: 'r1', ts: `t${seq}`, seq,
    event: { type: 'step:done' as const, stepId, exitCode },
  });

  it('reconstructs currentExecution/stepOrder for a job that attached mid-run', () => {
    // Exactly the F1 scenario, but now solved with real information instead of
    // a guess: the agent's buffer has the step:start this client never saw.
    store().applyEventReplay('j1', [start('execute', 0)]);

    const job = store().jobs.j1!;
    expect(job.stepOrder).toEqual(['execute']);
    expect(job.currentExecution.execute).toBe('execute');
    expect(job.steps.execute).toMatchObject({ status: 'running', inferred: undefined });
  });

  it('learns the run id from a replayed run:start, so a mid-run attach binds to its run', () => {
    // listJobs carries no runId while the run is live; the replay is the only source.
    store().applyJobSummaries([{ jobId: 'j1', workdir: '/w', status: 'running', pty: null }]);
    store().applyEventReplay('j1', [
      { jobId: 'j1', runId: 'r1', ts: 't0', seq: 0, event: { type: 'run:start', runId: 'r1', workflow: 'wf', name: 'Named' } },
      start('execute', 1),
    ]);
    expect(store().jobs.j1).toMatchObject({ runId: 'r1', runName: 'Named' });
  });

  it('routes a loop iteration to its own key, not iteration 1\'s', () => {
    store().applyEventReplay('j1', [start('execute', 0, 2)]);
    expect(store().jobs.j1!.steps['execute#2']).toMatchObject({ status: 'running', iteration: 2 });
    expect(store().jobs.j1!.steps.execute).toBeUndefined();
  });

  it('does not touch job.events or job.logRows (F8)', () => {
    const events = [{
      jobId: 'j1', runId: 'r1', ts: 't0', seq: 0,
      event: { type: 'run:start' as const, runId: 'r1', workflow: 'demo' },
    }];
    store().applyStepLog({ jobId: 'j1', stream: 'stdout', line: 'already here' });
    const before = store().jobs.j1!.events;

    store().applyEventReplay('j1', events);

    expect(store().jobs.j1!.events).toBe(before);
    expect(store().jobs.j1!.logTail).toEqual([{ stream: 'stdout', line: 'already here' }]);
  });

  it('ORs hasNarrated rather than un-narrating a run that has already talked live', () => {
    store().noteJobWorkspace('j1', '/ws'); // seeds a full JobState via emptyJob
    useAppStore.setState(state => ({ jobs: { ...state.jobs, j1: { ...state.jobs.j1!, hasNarrated: true } } }));
    store().applyEventReplay('j1', [start('execute', 0)]); // no progress in the replay itself

    expect(store().jobs.j1!.hasNarrated).toBe(true);
  });

  it('re-applies a live event that raced ahead of the replay (idempotent on reconnect)', () => {
    // The socket delivered step:done before getJobScrollback answered.
    store().applyWhiphandEvent(done('execute', 1));
    // The replay only knows about the step:start — its buffer predates the race.
    store().applyEventReplay('j1', [start('execute', 0)]);

    // The live step:done must not have been rolled back to 'running'.
    expect(store().jobs.j1!.steps.execute.status).toBe('done');
  });

  it('replays a missed step:done and run:done across a disconnect gap, leaving no step running (F3)', () => {
    // This client saw the step start live...
    store().applyWhiphandEvent(start('execute', 0));
    expect(store().jobs.j1!.steps.execute.status).toBe('running');

    // ...then the socket dropped. The step finished and so did the run while
    // this client was dark — it never saw either event live. Reconnecting
    // replays the agent's whole buffered stream, which does have both.
    store().applyEventReplay('j1', [
      start('execute', 0),
      done('execute', 1),
      { jobId: 'j1', runId: 'r1', ts: 't2', seq: 2, event: { type: 'run:done' as const, runId: 'r1', ok: true } },
    ]);

    const job = store().jobs.j1!;
    expect(job.steps.execute.status).toBe('done');
    expect(job.finished).toBe(true);
  });

  it('re-applies a live event that raced ahead even when it carries no seq', () => {
    // A handler-direct run:error (see scrollback.ts's mergeBySeq) has no
    // `seq` at all. `(e.seq ?? -1) > lastReplayedSeq` would never be true for
    // it, silently dropping it from the raced-ahead re-application.
    store().applyWhiphandEvent(start('execute', 0));
    store().applyWhiphandEvent({
      jobId: 'j1', runId: 'r1', ts: 't1', event: { type: 'run:error' as const, message: 'boom' },
    });
    store().applyEventReplay('j1', [start('execute', 0)]);

    expect(store().jobs.j1!.finished).toBe(true);
    expect(store().jobs.j1!.errorMessage).toBe('boom');
  });

  it('does not re-open a finalized step when the replay itself ends with a seq-less event (regression)', () => {
    // A real failure path: runWorkflow's catch (packages/core/src/engine/
    // runner.ts) sends a seq'd run:error and run:done through the journal and
    // rethrows; runJobInBackground's own catch then sends a *second*,
    // handler-direct run:error with no seq at all (packages/agent/src/
    // handlers.ts) — for a runner binary that isn't there, or a pty that
    // won't start. The replay's own last entry can legitimately have no seq,
    // even though real seq'd events came before it.
    store().applyWhiphandEvent(start('execute', 0));

    store().applyEventReplay('j1', [
      start('execute', 0),
      { jobId: 'j1', runId: 'r1', ts: 't1', seq: 1, event: { type: 'run:error' as const, message: 'boom' } },
      { jobId: 'j1', runId: 'r1', ts: 't2', seq: 2, event: { type: 'run:done' as const, runId: 'r1', ok: false } },
      { jobId: 'j1', runId: 'r1', ts: 't3', event: { type: 'run:error' as const, message: 'boom' } },
    ]);

    const job = store().jobs.j1!;
    expect(job.finished).toBe(true);
    // Before the fix, `events.at(-1)?.seq` read as undefined here — the
    // trailing entry has no seq — which re-applied EVERY live event this
    // client held, including the live step:start, right back on top of the
    // fold the replay had already finalized.
    expect(job.steps.execute.status).not.toBe('running');
  });

  it('clears pendingManual only when the replay itself ends the run', () => {
    const request = {
      stepId: 'sign', kind: 'approval' as const, title: 'Ship it?', instructions: '',
      choices: ['continue' as const, 'abort' as const], context: { artifacts: [] },
      defaultChoice: 'continue' as const,
    };
    store().applyManualRequest({ jobId: 'j1', runId: 'r1', request });

    store().applyEventReplay('j1', [start('execute', 0)]);
    expect(store().jobs.j1!.pendingManual).toEqual(request);

    store().applyEventReplay('j1', [
      start('execute', 0),
      { jobId: 'j1', runId: 'r1', ts: 't1', seq: 1, event: { type: 'run:cancelled' as const, runId: 'r1' } },
    ]);
    expect(store().jobs.j1!.pendingManual).toBeUndefined();
  });
});

describe('applyJobSummaries', () => {
  const summary: JobSummary = {
    jobId: 'j1', workdir: '/ws', runId: 'run-1', status: 'running',
    pty: { stepId: 's1', cols: 100, rows: 30 }, pendingManual: undefined,
  };

  it('makes a job that started before this client connected visible at all', () => {
    store().applyJobSummaries([summary]);

    const job = store().jobs.j1!;
    expect(job.runId).toBe('run-1');
    expect(job.finished).toBe(false);
    expect(job.ptyActive).toBe(true);
    expect(job.ptyCols).toBe(100);
  });

  it('marks a finished job finished', () => {
    store().applyJobSummaries([{ ...summary, status: 'succeeded', pty: null }]);
    expect(store().jobs.j1!.finished).toBe(true);
    expect(store().jobs.j1!.ptyActive).toBeFalsy();
  });

  it('does not overwrite what live notifications already established', () => {
    store().applyPtyStarted({ jobId: 'j1', stepId: 'live-step', cols: 120, rows: 40 });
    store().applyJobSummaries([summary]);

    const job = store().jobs.j1!;
    expect(job.ptyStepId).toBe('live-step');
    expect(job.ptyCols).toBe(120);
  });

  it('seeds runName from the summary for a client attaching mid-run', () => {
    store().applyJobSummaries([{ ...summary, name: 'OAuth support' }]);
    expect(store().jobs.j1!.runName).toBe('OAuth support');
  });

  it('does not overwrite a runName the store already holds', () => {
    store().setJobRunName('j1', 'Renamed locally');
    store().applyJobSummaries([{ ...summary, name: 'OAuth support' }]);
    expect(store().jobs.j1!.runName).toBe('Renamed locally');
  });

  it('lets a later summary update a status an earlier summary itself set (regression)', () => {
    // First attach: no live runStateChanged seen yet, so the summary seeds
    // status from itself.
    store().applyJobSummaries([summary]);
    expect(store().jobs.j1!.status).toBe('running');

    // The socket drops, and the run finishes during the gap: no live
    // runStateChanged ever arrives for it. On reconnect, listJobs is called
    // again and its summary now says the run is over — that must win, even
    // though `status` is already set, because it was only ever set BY a
    // summary, not by a live notification.
    store().applyJobSummaries([{ ...summary, status: 'succeeded', pty: null }]);
    expect(store().jobs.j1!.status).toBe('succeeded');
  });

  it('still never overwrites a live terminal status with a stale running summary', () => {
    store().applyRunStateChanged({ jobId: 'j1', runId: 'run-1', status: 'succeeded' });
    // A stale summary claiming the run is still going (e.g. a slow listJobs
    // answer that raced the live terminal update) must not win over it.
    store().applyJobSummaries([{ ...summary, status: 'running' }]);
    expect(store().jobs.j1!.status).toBe('succeeded');
  });

  it('lets a fresher summary replace a live "running" once the run actually ended (F3)', () => {
    // frontend.ts only ever sends a live runStateChanged with status
    // 'running' (at run:start) — a client that watched the run start live
    // and then went dark for the rest of it holds exactly this kind of
    // stale 'running', not one a summary set. The socket drops, the run
    // finishes during the gap (no live runStateChanged for that), and
    // reconnecting's listJobs summary is the only thing that ever learns
    // the run is over.
    store().applyRunStateChanged({ jobId: 'j1', runId: 'run-1', status: 'running' });
    store().applyJobSummaries([{ ...summary, status: 'succeeded', pty: null }]);
    expect(store().jobs.j1!.status).toBe('succeeded');
  });
});
