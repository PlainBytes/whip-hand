import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { liveStageProgress, useAppStore, waitingRunIds } from './store.ts';
import { sameSet, sameStageProgress, useAppStoreStable } from './use-stable-selector.ts';
import { sameOngoingRows } from '../components/OngoingRuns.tsx';

const store = () => useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({ jobs: {} });
});

describe('useAppStoreStable', () => {
  it('does not re-render on a pty chunk, and does when the slice changes', () => {
    let renders = 0;
    let seen: ReadonlySet<string> = new Set();
    function Probe() {
      renders += 1;
      seen = useAppStoreStable(state => waitingRunIds(state.jobs), sameSet);
      return null;
    }
    store().applyPtyStarted({ jobId: 'j1', stepId: 's1', cols: 80, rows: 24 });
    render(<Probe />);
    const afterMount = renders;

    act(() => {
      for (let i = 0; i < 20; i += 1) store().applyPtyData({ jobId: 'j1', data: `chunk ${i}` });
      store().applyStepLog({ jobId: 'j1', stream: 'stdout', line: 'hello' });
    });
    expect(renders).toBe(afterMount);

    act(() => {
      store().applyManualRequest({
        jobId: 'j1', runId: 'r1',
        request: {
          kind: 'manual', stepId: 'gate', title: 'Gate', instructions: 'Look.',
          choices: ['continue', 'abort'], defaultChoice: 'continue', context: { artifacts: [] },
        },
      } as Parameters<ReturnType<typeof store>['applyManualRequest']>[0]);
    });
    expect(renders).toBe(afterMount + 1);
    expect([...seen]).toEqual(['r1']);
  });
});

describe('equality helpers', () => {
  it('sameSet compares members, not identity', () => {
    expect(sameSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameSet(new Set(['a']), new Set(['a', 'b']))).toBe(false);
    expect(sameSet(new Set(['a', 'c']), new Set(['a', 'b']))).toBe(false);
  });

  it('sameStageProgress compares index and total per run', () => {
    const at = (index: number) => new Map([['r1', { index, total: 7 }]]);
    expect(sameStageProgress(at(3), at(3))).toBe(true);
    expect(sameStageProgress(at(3), at(4))).toBe(false);
    expect(sameStageProgress(at(3), new Map())).toBe(false);
    expect(sameStageProgress(liveStageProgress({}), liveStageProgress({}))).toBe(true);
  });

  it('sameOngoingRows ignores output and notices what a row shows', () => {
    store().applyWhiphandEvent({
      jobId: 'j1', runId: 'r1', ts: 't0', seq: 0, event: { type: 'run:start', runId: 'r1', workflow: 'wf' },
    });
    const before = Object.values(store().jobs);
    store().applyPtyData({ jobId: 'j1', data: 'x' });
    const afterOutput = Object.values(store().jobs);
    expect(afterOutput[0]).not.toBe(before[0]);
    expect(sameOngoingRows(before, afterOutput)).toBe(true);

    store().setJobRunName('j1', 'Renamed');
    expect(sameOngoingRows(afterOutput, Object.values(store().jobs))).toBe(false);
    expect(sameOngoingRows(afterOutput, [])).toBe(false);
  });
});
