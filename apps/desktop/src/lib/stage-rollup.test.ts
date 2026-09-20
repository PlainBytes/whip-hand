import { describe, expect, it } from 'vitest';
import { buildRunTree, type StageGroup, type StagesNode } from './run-tree.ts';
import { stageRollup } from './stage-rollup.ts';
import type { StepState } from '../state/store.ts';
import { step } from '../test/step-fixture.ts';

const STAGE = '01-a';

/** A row directly under stage 1 of the stages step 'build', on the given attempt. */
function row(partial: Partial<StepState> & { id: string }, attempt = 1): StepState {
  return step({ stagesId: 'build', loopId: 'build', iteration: attempt, stage: STAGE, ...partial });
}

/** A row inside stage 1's `cycle` loop, on the given iteration of it. */
function inCycle(partial: Partial<StepState> & { id: string }, iteration: number, attempt = 1): StepState {
  return step({
    loopId: 'cycle', iteration, outerLoops: [{ id: 'build', iteration: attempt, stage: STAGE }], ...partial,
  });
}

/** The groups the tree builds for stage 1 from `rows` — one per attempt the rows span. */
function attemptsOf(...rows: StepState[]): StageGroup[] {
  const tree = buildRunTree([step({ id: 'build', kind: 'stages', status: 'running', total: 1 }), ...rows]);
  return (tree[0] as StagesNode).children;
}

const T0 = Date.parse('2026-01-01T10:00:00Z');
const clockAfter = (seconds: number): number => T0 + seconds * 1000;
const stamp = (seconds: number): string => new Date(clockAfter(seconds)).toISOString();

describe('stageRollup: status', () => {
  it('is done when every step is done', () => {
    const groups = attemptsOf(row({ id: 'execute', status: 'done' }), row({ id: 'accept', status: 'done' }));
    expect(stageRollup(groups, T0).status).toBe('done');
  });

  it('is failed when one step failed and the steps after it never started', () => {
    const groups = attemptsOf(
      row({ id: 'execute', status: 'done' }),
      row({ id: 'review', status: 'failed' }),
      row({ id: 'accept', status: 'pending' }),
    );
    expect(stageRollup(groups, T0).status).toBe('failed');
  });

  it('is running when attempt 1 failed and attempt 2 is in flight', () => {
    const groups = attemptsOf(
      row({ id: 'execute', status: 'failed' }, 1),
      row({ id: 'execute', status: 'running' }, 2),
    );
    expect(groups).toHaveLength(2);
    expect(stageRollup(groups, T0).status).toBe('running');
  });

  it('is interrupted below failed and above pending', () => {
    const interrupted = attemptsOf(row({ id: 'execute', status: 'interrupted' }), row({ id: 'accept', status: 'pending' }));
    expect(stageRollup(interrupted, T0).status).toBe('interrupted');
    const failed = attemptsOf(row({ id: 'execute', status: 'interrupted' }), row({ id: 'accept', status: 'failed' }));
    expect(stageRollup(failed, T0).status).toBe('failed');
  });

  it('is pending when nothing has started', () => {
    const groups = attemptsOf(row({ id: 'execute' }), row({ id: 'accept' }));
    expect(stageRollup(groups, T0).status).toBe('pending');
  });

  it('is pending when some steps are done and the rest have not started', () => {
    const groups = attemptsOf(row({ id: 'execute', status: 'done' }), row({ id: 'accept', status: 'pending' }));
    expect(stageRollup(groups, T0).status).toBe('pending');
  });

  it('is disabled when every step is disabled', () => {
    const groups = attemptsOf(row({ id: 'execute', status: 'disabled' }), row({ id: 'accept', status: 'disabled' }));
    expect(stageRollup(groups, T0).status).toBe('disabled');
  });

  it('ignores a disabled step when the others have an opinion', () => {
    const groups = attemptsOf(row({ id: 'execute', status: 'done' }), row({ id: 'skipped', status: 'disabled' }));
    expect(stageRollup(groups, T0).status).toBe('done');
  });

  it('is pending with no children at all', () => {
    expect(stageRollup([], T0).status).toBe('pending');
    expect(stageRollup([{ ...attemptsOf(row({ id: 'execute' }))[0], children: [] }], T0).status).toBe('pending');
  });
});

describe('stageRollup: steps', () => {
  it('counts across attempts', () => {
    const groups = attemptsOf(
      row({ id: 'execute', status: 'failed' }, 1),
      row({ id: 'accept', status: 'pending' }, 1),
      row({ id: 'execute', status: 'running' }, 2),
    );
    expect(stageRollup(groups, T0).steps).toBe(3);
  });

  it('leaves a disabled node out', () => {
    const groups = attemptsOf(
      row({ id: 'execute', status: 'done' }),
      row({ id: 'skipped', status: 'disabled' }),
      row({ id: 'accept', status: 'done' }),
    );
    expect(stageRollup(groups, T0).steps).toBe(2);
  });

  it('counts a folded loop body step once, not once per iteration', () => {
    const groups = attemptsOf(
      row({ id: 'cycle', kind: 'loop', status: 'running' }),
      inCycle({ id: 'execute', status: 'done' }, 1),
      inCycle({ id: 'execute', status: 'done' }, 2),
      inCycle({ id: 'execute', status: 'running' }, 3),
    );
    // The loop itself and its one body step.
    expect(stageRollup(groups, T0).steps).toBe(2);
  });
});

describe('stageRollup: elapsed', () => {
  it('freezes a finished stage at its last end', () => {
    const groups = attemptsOf(
      row({ id: 'execute', status: 'done', startedAt: stamp(0), endedAt: stamp(30) }),
      row({ id: 'accept', status: 'done', startedAt: stamp(30), endedAt: stamp(95) }),
    );
    expect(stageRollup(groups, clockAfter(600)).elapsed).toBe('1m 35s');
    expect(stageRollup(groups, clockAfter(6000)).elapsed).toBe('1m 35s');
  });

  it('spans attempts, from the first start to the last end', () => {
    const groups = attemptsOf(
      row({ id: 'execute', status: 'failed', startedAt: stamp(10), endedAt: stamp(40) }, 1),
      row({ id: 'execute', status: 'done', startedAt: stamp(50), endedAt: stamp(130) }, 2),
    );
    expect(stageRollup(groups, clockAfter(999)).elapsed).toBe('2m 0s');
  });

  it('counts a running stage against the clock', () => {
    const groups = attemptsOf(
      row({ id: 'execute', status: 'done', startedAt: stamp(0), endedAt: stamp(30) }),
      row({ id: 'accept', status: 'running', startedAt: stamp(30) }),
    );
    expect(stageRollup(groups, clockAfter(45)).elapsed).toBe('45s');
    expect(stageRollup(groups, clockAfter(75)).elapsed).toBe('1m 15s');
  });

  it('counts a running retry against the clock even though attempt 1 ended', () => {
    const groups = attemptsOf(
      row({ id: 'execute', status: 'failed', startedAt: stamp(0), endedAt: stamp(20) }, 1),
      row({ id: 'execute', status: 'running', startedAt: stamp(25) }, 2),
    );
    expect(stageRollup(groups, clockAfter(60)).elapsed).toBe('1m 0s');
  });

  it('reads an earlier iteration of a folded step, not just its newest', () => {
    const groups = attemptsOf(
      row({ id: 'cycle', kind: 'loop', status: 'done', startedAt: stamp(5), endedAt: stamp(50) }),
      inCycle({ id: 'execute', status: 'done', startedAt: stamp(0), endedAt: stamp(20) }, 1),
      inCycle({ id: 'execute', status: 'done', startedAt: stamp(20), endedAt: stamp(50) }, 2),
    );
    expect(stageRollup(groups, clockAfter(999)).elapsed).toBe('50s');
  });

  it('is null when nothing has started', () => {
    const groups = attemptsOf(row({ id: 'execute' }), row({ id: 'accept' }));
    expect(stageRollup(groups, clockAfter(60)).elapsed).toBeNull();
    expect(stageRollup([], clockAfter(60)).elapsed).toBeNull();
  });
});

describe('stageRollup: spend', () => {
  it('sums turns and cost across attempts', () => {
    const groups = attemptsOf(
      row({ id: 'execute', status: 'failed', progress: { turns: 4, costUsd: 0.5 } }, 1),
      row({ id: 'execute', status: 'done', progress: { turns: 6, costUsd: 0.25 } }, 2),
    );
    expect(stageRollup(groups, T0).spend).toBe('10 turns · $0.75');
  });

  it('carries premium requests through', () => {
    const groups = attemptsOf(
      row({ id: 'execute', status: 'done', progress: { turns: 3, premiumRequests: 2 } }),
      row({ id: 'review', status: 'done', progress: { premiumRequests: 5 } }),
    );
    expect(stageRollup(groups, T0).spend).toBe('3 turns · 7 premium requests');
  });

  it('leaves a counter absent when no step reported it', () => {
    const groups = attemptsOf(
      row({ id: 'execute', status: 'done', progress: { costUsd: 1 } }),
      row({ id: 'accept', status: 'done' }),
    );
    expect(stageRollup(groups, T0).spend).toBe('$1.00');
  });

  it('is null when no step reports any usage', () => {
    const groups = attemptsOf(
      row({ id: 'execute', status: 'done', progress: { lastAction: 'Read foo.ts' } }),
      row({ id: 'accept', status: 'done' }),
    );
    expect(stageRollup(groups, T0).spend).toBeNull();
    expect(stageRollup([], T0).spend).toBeNull();
  });

  it('counts a folded loop body step once, from its newest execution', () => {
    const groups = attemptsOf(
      row({ id: 'cycle', kind: 'loop', status: 'running' }),
      inCycle({ id: 'execute', status: 'done', progress: { turns: 2, costUsd: 0.1 } }, 1),
      inCycle({ id: 'execute', status: 'done', progress: { turns: 3, costUsd: 0.2 } }, 2),
      inCycle({ id: 'execute', status: 'running', progress: { turns: 5, costUsd: 0.4 } }, 3),
    );
    expect(stageRollup(groups, T0).spend).toBe('5 turns · $0.40');
  });

  it('reads like the pill spelling: cents, turns first, joined by a middle dot', () => {
    const groups = attemptsOf(row({ id: 'execute', status: 'done', progress: { premiumRequests: 1, costUsd: 0.0358, turns: 1 } }));
    expect(stageRollup(groups, T0).spend).toBe('1 turns · $0.04 · 1 premium requests');
  });
});
