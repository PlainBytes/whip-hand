import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore, type HighRateNotification } from './store.ts';
import { createHighRateQueue } from '../agent/agent-context.tsx';

const store = () => useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({ jobs: {} });
});

const stepLog = (i: number, jobId = 'j1'): HighRateNotification =>
  ({ method: 'stepLog', params: { jobId, stream: 'stdout', line: `line ${i}` } });
const logEvent = (i: number, jobId = 'j1'): HighRateNotification => ({
  method: 'whiphandEvent',
  params: {
    jobId, runId: 'r1', ts: `t${i}`, seq: i,
    event: { type: 'step:log', stepId: 's1', stream: i % 3 === 0 ? 'stderr' : 'stdout', line: `out ${i}` },
  },
});
const pty = (data: string, seq?: number, jobId = 'j1'): HighRateNotification =>
  ({ method: 'ptyData', params: { jobId, data, ...(seq === undefined ? {} : { seq }) } });

/** Applies the items one store write each — the shape of the old per-notification path. */
function applyOneByOne(items: HighRateNotification[]) {
  for (const item of items) store().applyHighRateBatch([item]);
  return store().jobs;
}

function applyAsOneBatch(items: HighRateNotification[]) {
  store().applyHighRateBatch(items);
  return store().jobs;
}

describe('applyHighRateBatch', () => {
  it('lands exactly where one write per notification would, across the caps', () => {
    // 2500 lines of each kind overflow the 2000-line caps; 30 × 100k-char
    // chunks overflow the 2M pty budget, so both trims are exercised.
    const big = 'x'.repeat(100_000);
    const items: HighRateNotification[] = [];
    for (let i = 1; i <= 2500; i += 1) {
      items.push(stepLog(i), logEvent(i));
      if (i % 80 === 0) items.push(pty(big + i));
      if (i % 500 === 0) items.push(stepLog(i, 'j2'), pty(`other ${i}`, undefined, 'j2'));
    }

    const oneByOne = applyOneByOne(items);
    useAppStore.setState({ jobs: {} });
    const batched = applyAsOneBatch(items);

    expect(batched).toEqual(oneByOne);
    const job = batched.j1!;
    expect(job.logTail).toHaveLength(2000);
    expect(job.logTail.at(-1)).toEqual({ stream: 'stdout', line: 'line 2500' });
    expect(job.logRows).toHaveLength(2000);
    expect(job.logRows[0].seq).toBe(501);
    expect(job.ptyDataTrimmed).toBe(true);
    expect(job.ptyDataBaseIndex + job.ptyDataBuffer.length).toBe(31);
    expect(job.runId).toBe('r1');
    expect(job.events).toEqual([]);
  });

  it('writes the store once for the whole batch', () => {
    const writes = vi.fn();
    const unsubscribe = useAppStore.subscribe(writes);
    store().applyHighRateBatch([stepLog(1), pty('a'), logEvent(2), stepLog(3, 'j2')]);
    unsubscribe();
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('files a late joiner\'s first chunk at its real position, as a single chunk does', () => {
    store().applyHighRateBatch([pty('x', 5000), pty('y', 5001)]);
    const job = store().jobs.j1!;
    expect(job.ptyDataBaseIndex).toBe(5000);
    expect(job.ptyDataBuffer).toEqual(['x', 'y']);
    expect(job.ptyDataTrimmed).toBe(true);
  });

  it('never drops the newest chunk, even one over the whole budget', () => {
    store().applyHighRateBatch([pty('a'), pty('b'.repeat(2_500_000))]);
    const job = store().jobs.j1!;
    expect(job.ptyDataBuffer).toHaveLength(1);
    expect(job.ptyDataBaseIndex).toBe(1);
  });

  it('keeps a non-step:log event in order with the lines around it', () => {
    store().applyHighRateBatch([
      logEvent(1),
      {
        method: 'whiphandEvent',
        params: { jobId: 'j1', runId: 'r1', ts: 't2', seq: 2, event: { type: 'step:done', stepId: 's1', exitCode: 0 } },
      },
      logEvent(3),
    ]);
    const job = store().jobs.j1!;
    expect(job.logRows.map(row => row.seq)).toEqual([1, 3]);
    expect(job.events.map(e => e.seq)).toEqual([2]);
  });
});

describe('createHighRateQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('applies the first item at once, then the rest of the window as one batch', () => {
    const apply = vi.fn();
    const queue = createHighRateQueue(apply);
    queue.push(stepLog(1));
    queue.push(stepLog(2));
    queue.push(stepLog(3));
    expect(apply.mock.calls).toEqual([[[stepLog(1)]]]);

    vi.advanceTimersByTime(100);
    expect(apply.mock.calls).toEqual([[[stepLog(1)]], [[stepLog(2), stepLog(3)]]]);

    // Still inside the follow-on window: queued, not applied.
    queue.push(stepLog(4));
    expect(apply).toHaveBeenCalledTimes(2);
    queue.dispose();
    expect(apply.mock.calls.at(-1)).toEqual([[stepLog(4)]]);
  });

  it('flush() drains early and is a no-op when empty', () => {
    const apply = vi.fn();
    const queue = createHighRateQueue(apply);
    queue.push(stepLog(1));
    queue.flush();
    expect(apply).toHaveBeenCalledTimes(1);
    queue.push(stepLog(2));
    queue.flush();
    expect(apply.mock.calls.at(-1)).toEqual([[stepLog(2)]]);
    queue.dispose();
  });
});
