import { describe, expect, it } from 'vitest';
import { buildRunTree, flattenNodes, type LoopNode, type StagesNode, type StepNode } from './run-tree.ts';
import type { StepState } from '../state/store.ts';
import { step } from '../test/step-fixture.ts';

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

/**
 * A `stages` step 'build' over two stage files, each running the same body — a
 * `cycle` loop holding `execute`, then an `accept` gate — in the row shapes
 * the runner writes (see core's manifest.ts): a body step directly under a
 * stage carries the stages id as its `loopId`, the attempt as its `iteration`
 * and the stage file as `stage`; a step inside the stage's loop carries that
 * same stage frame in `outerLoops`. Stage 2's cycle has run twice.
 */
function staged(): StepState[] {
  const stage1 = [{ id: 'build', iteration: 1, stage: '01-a' }];
  const stage2 = [{ id: 'build', iteration: 1, stage: '02-b' }];
  return [
    step({
      id: 'build', kind: 'stages', status: 'running', total: 2, attempt: 1,
      currentStage: { id: '02-b', title: 'Add API routes', index: 2 },
    }),
    step({ id: 'cycle', kind: 'loop', stagesId: 'build', loopId: 'build', iteration: 1, stage: '01-a', status: 'done' }),
    step({ id: 'execute', stagesId: 'build', loopId: 'cycle', iteration: 1, outerLoops: stage1, status: 'done' }),
    step({ id: 'accept', kind: 'approval', stagesId: 'build', loopId: 'build', iteration: 1, stage: '01-a', status: 'done' }),
    step({ id: 'cycle', kind: 'loop', loopId: 'build', iteration: 1, stage: '02-b', status: 'running' }),
    step({ id: 'execute', loopId: 'cycle', iteration: 1, outerLoops: stage2, status: 'done' }),
    step({ id: 'execute', loopId: 'cycle', iteration: 2, outerLoops: stage2, status: 'running' }),
  ];
}

describe('buildRunTree: stages', () => {
  it('turns rows from two stages of one stages step into two stage groups, not one folded step', () => {
    const tree = buildRunTree(staged());
    expect(ids(tree)).toEqual(['build']);
    const stages = tree[0] as StagesNode;
    expect(stages.kind).toBe('stages');
    expect(stages.children.map(c => c.stage)).toEqual(['01-a', '02-b']);
    expect(ids(stages.children[0].children)).toEqual(['cycle', 'accept']);
    expect(ids(stages.children[1].children)).toEqual(['cycle']);
  });

  it('keeps a loop inside a stage under that stage, folding its iterations as it would outside one', () => {
    const stages = buildRunTree(staged())[0] as StagesNode;
    const first = stages.children[0].children.find(n => n.kind === 'loop') as LoopNode;
    const second = stages.children[1].children.find(n => n.kind === 'loop') as LoopNode;
    // Stage 1's cycle must not absorb stage 2's executions, nor the reverse.
    expect(first.children[0].kind === 'step' && first.children[0].executions).toHaveLength(1);
    expect(second.children[0].kind === 'step' && second.children[0].executions).toHaveLength(2);
    expect(first.key).not.toBe(second.key);
  });

  it('names a stage finished before the page opened by the title the manifest persisted', () => {
    const rows = staged();
    rows[0] = {
      ...rows[0],
      startedStages: {
        '01-a': { title: 'Schema', index: 1, maxAttempts: 3 },
        '02-b': { title: 'Add API routes', index: 2, maxAttempts: 3 },
      },
    };
    const stages = buildRunTree(rows)[0] as StagesNode;
    expect(stages.children.map(g => [g.index, g.total, g.title, g.maxAttempts])).toEqual([
      [1, 2, 'Schema', 3],
      [2, 2, 'Add API routes', 3],
    ]);
  });

  it('falls back to the current stage, then position and id, for a manifest recorded without startedStages', () => {
    const stages = buildRunTree(staged())[0] as StagesNode;
    expect(stages.children.map(g => [g.index, g.total, g.title, g.maxAttempts])).toEqual([
      [1, 2, '01-a', undefined],
      [2, 2, 'Add API routes', undefined],
    ]);
  });

  it('takes the current stage\'s budget from the stages row when startedStages does not carry one', () => {
    const rows = staged();
    rows[0] = { ...rows[0], maxAttempts: 4 };
    const stages = buildRunTree(rows)[0] as StagesNode;
    expect(stages.children.map(g => g.maxAttempts)).toEqual([undefined, 4]);
  });

  it('splits a stage retried after a rejection into one group per attempt', () => {
    const tree = buildRunTree([
      step({ id: 'build', kind: 'stages', status: 'running', total: 1, attempt: 2 }),
      step({ id: 'implement', loopId: 'build', iteration: 1, stage: '01-a', status: 'done' }),
      step({ id: 'accept', kind: 'approval', loopId: 'build', iteration: 1, stage: '01-a', status: 'done', verdict: 'fail' }),
      step({ id: 'implement', loopId: 'build', iteration: 2, stage: '01-a', status: 'running' }),
    ]);
    const stages = tree[0] as StagesNode;
    expect(stages.children.map(g => [g.stage, g.attempt, g.attempts])).toEqual([
      ['01-a', 1, 2],
      ['01-a', 2, 2],
    ]);
    expect(ids(stages.children[0].children)).toEqual(['implement', 'accept']);
    expect(ids(stages.children[1].children)).toEqual(['implement']);
    expect(stages.children[0].key).not.toBe(stages.children[1].key);
  });

  it('holds the declared body under the stages step before any stage has started', () => {
    // Seeded plan rows know their stages step (stagesId) but no stage yet —
    // they belong under it, not loose at the top level.
    const tree = buildRunTree([
      step({ id: 'plan', status: 'done' }),
      step({ id: 'build', kind: 'stages', status: 'pending' }),
      step({ id: 'cycle', kind: 'loop', stagesId: 'build' }),
      step({ id: 'execute', loopId: 'cycle', stagesId: 'build' }),
      step({ id: 'accept', kind: 'approval', stagesId: 'build' }),
    ]);
    expect(ids(tree)).toEqual(['plan', 'build']);
    const stages = tree[1] as StagesNode;
    expect(stages.children).toHaveLength(1);
    expect(stages.children[0].stage).toBeUndefined();
    expect(ids(stages.children[0].children)).toEqual(['cycle', 'accept']);
    expect(ids((stages.children[0].children[0] as LoopNode).children)).toEqual(['execute']);
  });

  it('numbers through a stage body and walks into it when flattened', () => {
    const flat = flattenNodes(buildRunTree(staged()));
    expect(ids(flat)).toEqual(['build', 'cycle', 'execute', 'accept', 'cycle', 'execute']);
    expect(flat.map(n => n.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
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
