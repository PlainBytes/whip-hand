import { describe, expect, it } from 'vitest';
import { buildRunTree, flattenNodes, type LoopNode, type StepNode } from './run-tree.ts';
import { executionKey, type StepState } from '../state/store.ts';

function step(partial: Partial<StepState> & { id: string }): StepState {
  return {
    key: executionKey(partial.id, partial.iteration, partial.outerLoops),
    status: 'pending',
    ...partial,
  } as StepState;
}

/** The shape of feature-development.yaml: a step, a loop of two, an approval. */
function planned(): StepState[] {
  return [
    step({ id: 'plan', kind: 'agent', status: 'done' }),
    step({ id: 'do-review', kind: 'loop', status: 'running' }),
    step({ id: 'execute', kind: 'agent', loopId: 'do-review', status: 'done' }),
    step({ id: 'review', kind: 'agent', loopId: 'do-review', status: 'running' }),
    step({ id: 'sign-off', kind: 'approval' }),
  ];
}

const ids = (nodes: StepNode[]): string[] => nodes.map(n => n.id);

describe('buildRunTree', () => {
  it('keeps a loop-free workflow flat, in declared order', () => {
    const tree = buildRunTree([
      step({ id: 'a', status: 'done' }),
      step({ id: 'b', status: 'running' }),
      step({ id: 'c' }),
    ]);
    expect(ids(tree)).toEqual(['a', 'b', 'c']);
    expect(tree.every(n => n.kind === 'step')).toBe(true);
  });

  it('nests a loop body inside its loop instead of listing it alongside', () => {
    const tree = buildRunTree(planned());
    expect(ids(tree)).toEqual(['plan', 'do-review', 'sign-off']);
    const loop = tree[1] as LoopNode;
    expect(loop.kind).toBe('loop');
    expect(ids(loop.children)).toEqual(['execute', 'review']);
  });

  it('numbers every node once, depth-first, across the whole run', () => {
    const tree = buildRunTree(planned());
    const loop = tree[1] as LoopNode;
    expect(tree[0].ordinal).toBe(1);
    expect(loop.ordinal).toBe(2);
    expect(loop.children[0].ordinal).toBe(3);
    expect(loop.children[1].ordinal).toBe(4);
    expect(tree[2].ordinal).toBe(5);
  });

  it('folds repeat executions of one body step into a single node', () => {
    // Three iterations of the loop: the row must not grow three pills long.
    const tree = buildRunTree([
      step({ id: 'fix', kind: 'loop', status: 'running', iterations: 3 }),
      step({ id: 'edit', loopId: 'fix', iteration: 1, status: 'done' }),
      step({ id: 'check', loopId: 'fix', iteration: 1, status: 'done', verdict: 'fail' }),
      step({ id: 'edit', loopId: 'fix', iteration: 2, status: 'done' }),
      step({ id: 'check', loopId: 'fix', iteration: 2, status: 'done', verdict: 'fail' }),
      step({ id: 'edit', loopId: 'fix', iteration: 3, status: 'running' }),
    ]);
    const loop = tree[0] as LoopNode;
    expect(ids(loop.children)).toEqual(['edit', 'check']);
    const edit = loop.children[0];
    expect(edit.kind === 'step' && edit.executions).toHaveLength(3);
    // Oldest first, so the popover reads as a history.
    expect(edit.kind === 'step' && edit.executions.map(e => e.iteration)).toEqual([1, 2, 3]);
  });

  it('lets the newest execution speak for a folded step', () => {
    const tree = buildRunTree([
      step({ id: 'fix', kind: 'loop', status: 'running' }),
      step({ id: 'check', loopId: 'fix', iteration: 1, status: 'done', verdict: 'fail' }),
      step({ id: 'check', loopId: 'fix', iteration: 2, status: 'running' }),
    ]);
    const check = (tree[0] as LoopNode).children[0];
    // The pill must read 'running', not the first iteration's 'done'.
    expect(check.kind === 'step' && check.latest.status).toBe('running');
    expect(check.kind === 'step' && check.latest.iteration).toBe(2);
  });

  it('nests a loop inside a loop', () => {
    // 'inner's own row is identified by its round of 'outer' (iteration 1,
    // here 'outer's only one so far); 'deep', running directly inside
    // 'inner', carries that same round as its outerLoops — exactly what
    // runner.ts's ancestorLoops computes for a real nested execution.
    const tree = buildRunTree([
      step({ id: 'outer', kind: 'loop', status: 'running' }),
      step({ id: 'inner', kind: 'loop', loopId: 'outer', iteration: 1, status: 'running' }),
      step({ id: 'deep', loopId: 'inner', outerLoops: [{ id: 'outer', iteration: 1 }], status: 'running' }),
    ]);
    const outer = tree[0] as LoopNode;
    const inner = outer.children[0] as LoopNode;
    expect(inner.kind).toBe('loop');
    expect(ids(inner.children)).toEqual(['deep']);
    expect(inner.ordinal).toBe(2);
    expect(inner.children[0].ordinal).toBe(3);
  });

  it('gives round 2 of an outer loop its own inner-loop node, not round 1\'s rows', () => {
    // The shape every shipped workflow now uses: an outer human-review loop
    // wraps an inner fix-cycle. Round 2 must not inherit round 1's execute.
    const tree = buildRunTree([
      step({ id: 'human-review', kind: 'loop', status: 'running', iterations: 2 }),
      step({ id: 'fix-cycle', kind: 'loop', loopId: 'human-review', iteration: 1, status: 'done' }),
      step({
        id: 'execute', loopId: 'fix-cycle', iteration: 1,
        outerLoops: [{ id: 'human-review', iteration: 1 }], status: 'done',
      }),
      step({ id: 'sign-off', loopId: 'human-review', iteration: 1, status: 'done', verdict: 'fail' }),
      step({ id: 'fix-cycle', kind: 'loop', loopId: 'human-review', iteration: 2, status: 'running' }),
      step({
        id: 'execute', loopId: 'fix-cycle', iteration: 1,
        outerLoops: [{ id: 'human-review', iteration: 2 }], status: 'running',
      }),
      step({ id: 'sign-off', loopId: 'human-review', iteration: 2, status: 'pending' }),
    ]);
    const humanReview = tree[0] as LoopNode;
    expect(ids(humanReview.children)).toEqual(['fix-cycle', 'sign-off', 'fix-cycle']);
    const [round1, , round2] = humanReview.children as [LoopNode, StepNode, LoopNode];
    expect(round1.children).toHaveLength(1);
    expect(round1.children[0].kind === 'step' && round1.children[0].latest.status).toBe('done');
    expect(round2.children).toHaveLength(1);
    expect(round2.children[0].kind === 'step' && round2.children[0].latest.status).toBe('running');
  });

  it('shows a step whose loop is missing rather than dropping it', () => {
    // Defensive: a manifest truncated mid-write, or a job event for a loop
    // whose loop:start never arrived. Losing the step outright is worse.
    const tree = buildRunTree([
      step({ id: 'a', status: 'done' }),
      step({ id: 'orphan', loopId: 'nowhere', status: 'running' }),
    ]);
    expect(ids(tree)).toEqual(['a', 'orphan']);
  });

  it('keeps a step the live job invented but the plan never had', () => {
    // The interactive on_findings path appends a synthetic '<id>-triage'.
    const tree = buildRunTree([
      step({ id: 'review', status: 'done', verdict: 'fail' }),
      step({ id: 'review-triage', kind: 'manual', status: 'running' }),
    ]);
    expect(ids(tree)).toEqual(['review', 'review-triage']);
    expect(tree[1].ordinal).toBe(2);
  });

  it('has nothing to build from an empty run', () => {
    expect(buildRunTree([])).toEqual([]);
  });
});

describe('flattenNodes', () => {
  it('walks the tree depth-first, so a node sits next to its ordinal', () => {
    // What collapsing needs: "step 3 of 5" counts folded nodes, not executions.
    const flat = flattenNodes(buildRunTree(planned()));
    expect(ids(flat)).toEqual(['plan', 'do-review', 'execute', 'review', 'sign-off']);
    expect(flat.map(n => n.ordinal)).toEqual([1, 2, 3, 4, 5]);
  });
});
