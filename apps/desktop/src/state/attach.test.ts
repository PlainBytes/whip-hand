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
});
