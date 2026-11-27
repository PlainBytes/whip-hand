import { describe, expect, it } from 'vitest';
import {
  appendAt, indentTarget, insertAfter, moveAt, moveBlocker, moveTo, outdentTarget, referenceableIds, removeAt,
  removeStep, renameStep, siblingsAt, stepAt, updateAt,
} from './step-tree.ts';
import { stagesRule } from './step-describe.ts';
import type { CommandStep, LoopStep, StagesStep, Step, Workflow } from '../shared/types.ts';
import { act, renderHook } from '@testing-library/react';
import { useWorkflowDraft } from '../workflow-editor/use-workflow-draft.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const READS_FROM_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../../../parity/fixtures/desktop/reads-from.json',
);

const cmd = (id: string, output?: string): CommandStep =>
  ({ kind: 'command', id, run: `echo ${id}`, ...(output ? { output } : {}) });

const staged = (): Step[] => [
  cmd('plan', 'plan.md'),
  { kind: 'stages', id: 'build', items: 'plans/*.md', steps: [{ ...cmd('impl', 'impl.log'), inputs: ['stage', 'plan'] }] } as StagesStep,
];

const tree = (): Step[] => [
  cmd('a', 'a.log'),
  { kind: 'loop', id: 'fix', until: 'c', steps: [cmd('b', 'b.log'), cmd('c', 'c.log')] } as LoopStep,
  cmd('d', 'd.log'),
];

describe('step tree addressing', () => {
  it('reads a step out of a loop body by path', () => {
    expect(stepAt(tree(), [1, 0])?.id).toBe('b');
    expect(stepAt(tree(), [2])?.id).toBe('d');
    expect(stepAt(tree(), [9])).toBeUndefined();
  });

  it('lists the siblings a path addresses into', () => {
    expect(siblingsAt(tree(), []).map(s => s.id)).toEqual(['a', 'fix', 'd']);
    expect(siblingsAt(tree(), [1]).map(s => s.id)).toEqual(['b', 'c']);
    // A path through a step that is not a loop addresses nothing.
    expect(siblingsAt(tree(), [0])).toEqual([]);
  });
});

describe('step tree edits', () => {
  it('updates a nested step without disturbing anything else', () => {
    const next = updateAt(tree(), [1, 1], cmd('renamed', 'c.log'));
    expect((next[1] as LoopStep).steps.map(s => s.id)).toEqual(['b', 'renamed']);
    expect(next[0].id).toBe('a');
    expect(next[2].id).toBe('d');
  });

  it('does not mutate the input', () => {
    const original = tree();
    removeAt(original, [1, 0]);
    expect((original[1] as LoopStep).steps.map(s => s.id)).toEqual(['b', 'c']);
  });

  it('removes a nested step and a top-level one', () => {
    expect((removeAt(tree(), [1, 0])[1] as LoopStep).steps.map(s => s.id)).toEqual(['c']);
    expect(removeAt(tree(), [0]).map(s => s.id)).toEqual(['fix', 'd']);
  });

  it('appends into a loop body or at the top level', () => {
    expect((appendAt(tree(), [1], cmd('e'))[1] as LoopStep).steps.map(s => s.id))
      .toEqual(['b', 'c', 'e']);
    expect(appendAt(tree(), [], cmd('e')).map(s => s.id)).toEqual(['a', 'fix', 'd', 'e']);
  });

  it('moves a step within its own list, and refuses to fall off either end', () => {
    expect((moveAt(tree(), [1, 1], -1)[1] as LoopStep).steps.map(s => s.id)).toEqual(['c', 'b']);
    expect((moveAt(tree(), [1, 0], -1)[1] as LoopStep).steps.map(s => s.id)).toEqual(['b', 'c']);
    expect(moveAt(tree(), [2], 1).map(s => s.id)).toEqual(['a', 'fix', 'd']);
    expect(moveAt(tree(), [0], 1).map(s => s.id)).toEqual(['fix', 'a', 'd']);
  });
});

describe('insertAfter', () => {
  it('on a loop card, inserts as the loop\'s first body child', () => {
    const next = insertAfter(tree(), [1], cmd('new'));
    expect((next[1] as LoopStep).steps.map(s => s.id)).toEqual(['new', 'b', 'c']);
    expect(next.map(s => s.id)).toEqual(['a', 'fix', 'd']);
  });

  it('on a leaf card, inserts as the next sibling at that card\'s own depth', () => {
    expect(insertAfter(tree(), [0], cmd('new')).map(s => s.id)).toEqual(['a', 'new', 'fix', 'd']);
  });

  it('on a loop body\'s last step, inserts within the body rather than escaping it', () => {
    const next = insertAfter(tree(), [1, 1], cmd('new'));
    expect((next[1] as LoopStep).steps.map(s => s.id)).toEqual(['b', 'c', 'new']);
    expect(next.map(s => s.id)).toEqual(['a', 'fix', 'd']);
  });

  it('on an empty loop, still lands inside the body', () => {
    const empty: Step[] = [{ kind: 'loop', id: 'fresh', until: '', steps: [] } as unknown as LoopStep];
    const next = insertAfter(empty, [0], cmd('first'));
    expect((next[0] as LoopStep).steps.map(s => s.id)).toEqual(['first']);
  });
});

describe('renameStep', () => {
  it('renames the step\'s own id', () => {
    expect(renameStep(tree(), 'a', 'plan').map(s => s.id)).toEqual(['plan', 'fix', 'd']);
  });

  it('rewrites every inputs: entry naming the old id, at any depth', () => {
    const withRefs: Step[] = [
      cmd('a', 'a.log'),
      { kind: 'loop', id: 'fix', until: 'c', steps: [{ ...cmd('b', 'b.log'), inputs: ['a'] }, cmd('c', 'c.log')] } as LoopStep,
      { ...cmd('d', 'd.log'), inputs: ['a', 'c'] },
    ];
    const next = renameStep(withRefs, 'a', 'plan');
    expect((next[1] as LoopStep & { steps: Array<Step & { inputs?: string[] }> }).steps[0].inputs).toEqual(['plan']);
    expect((next[2] as Step & { inputs?: string[] }).inputs).toEqual(['plan', 'c']);
  });

  it('rewrites a loop\'s until: naming the old id — the half that gets missed', () => {
    const next = renameStep(tree(), 'c', 'review');
    expect((next[1] as LoopStep).until).toBe('review');
    expect((next[1] as LoopStep).steps.map(s => s.id)).toEqual(['b', 'review']);
  });

  it('never rewrites the reserved attachments ref, even renaming a step (invalidly) called that', () => {
    const withRefs: Step[] = [
      cmd('attachments', 'a.log'),
      { ...cmd('d', 'd.log'), inputs: ['attachments'] },
    ];
    const next = renameStep(withRefs, 'attachments', 'fetch');
    expect(next[0].id).toBe('fetch');
    expect((next[1] as Step & { inputs?: string[] }).inputs).toEqual(['attachments']);
  });
  it('rewrites inputs: inside a stages body', () => {
    const next = renameStep(staged(), 'plan', 'design');
    expect((next[1] as StagesStep).steps[0]).toMatchObject({ inputs: ['stage', 'design'] });
  });
});

describe('removeStep', () => {
  it('removes the step wherever it is in the tree', () => {
    expect(removeStep(tree(), 'a').map(s => s.id)).toEqual(['fix', 'd']);
    expect((removeStep(tree(), 'b')[1] as LoopStep).steps.map(s => s.id)).toEqual(['c']);
  });

  it('strips the removed id from every remaining step\'s inputs', () => {
    const withRefs: Step[] = [
      cmd('a', 'a.log'),
      { ...cmd('d', 'd.log'), inputs: ['a'] },
    ];
    expect((removeStep(withRefs, 'a')[0] as Step & { inputs?: string[] }).inputs).toEqual([]);
  });

  it('leaves the reserved attachments ref in place — it names the run\'s files, not a step', () => {
    const withRefs: Step[] = [
      cmd('attachments', 'a.log'),
      { ...cmd('d', 'd.log'), inputs: ['attachments'] },
    ];
    expect((removeStep(withRefs, 'attachments')[0] as Step & { inputs?: string[] }).inputs).toEqual(['attachments']);
  });
  it('removes from and strips inputs inside a stages body', () => {
    expect((removeStep(staged(), 'plan')[0] as StagesStep).steps[0]).toMatchObject({ inputs: ['stage'] });
    expect((removeStep(staged(), 'impl')[1] as StagesStep).steps).toEqual([]);
  });
});

describe('referenceable ids', () => {
  it('offers earlier steps, including ones inside an earlier loop', () => {
    expect(referenceableIds(tree(), [2])).toEqual(['a', 'b', 'c']);
  });

  it('offers a later sibling inside the same loop body — the previous iteration', () => {
    expect(referenceableIds(tree(), [1, 0])).toEqual(['a', 'c']);
  });

  it('does not offer a loop body step to something declared before the loop', () => {
    expect(referenceableIds(tree(), [0])).toEqual([]);
  });

  it('never offers the step itself, or a loop, or a step with no artifact', () => {
    const withSilent: Step[] = [cmd('quiet'), cmd('loud', 'loud.log'), cmd('z', 'z.log')];
    expect(referenceableIds(withSilent, [2])).toEqual(['loud']);
    expect(referenceableIds(tree(), [1, 1])).toEqual(['a', 'b']);
  });
});

describe('a stages body', () => {
  /** plan → build (stages: impl, fix-loop(check), gate) → after */
  const stagedTree = (): Step[] => [
    cmd('plan', 'plan.md'),
    {
      kind: 'stages', id: 'build', items: 'plans/*.md',
      steps: [
        cmd('impl', 'impl.log'),
        { kind: 'loop', id: 'fix', until: 'check', steps: [cmd('patch', 'patch.log'), cmd('check', 'check.log')] } as LoopStep,
        cmd('gate', 'gate.log'),
      ],
    } as StagesStep,
    cmd('after', 'after.log'),
  ];

  it('a step inside a stages body can be added, moved and described', () => {
    // Addressing: the body is a list like a loop body.
    expect(siblingsAt(stagedTree(), [1]).map(s => s.id)).toEqual(['impl', 'fix', 'gate']);
    expect(stepAt(stagedTree(), [1, 1, 0])?.id).toBe('patch');

    // Add: appended into the body, inserted after a body step, and "insert
    // below" on the stages card itself lands as its first body child.
    expect((appendAt(stagedTree(), [1], cmd('new'))[1] as StagesStep).steps.map(s => s.id))
      .toEqual(['impl', 'fix', 'gate', 'new']);
    expect((insertAfter(stagedTree(), [1, 0], cmd('new'))[1] as StagesStep).steps.map(s => s.id))
      .toEqual(['impl', 'new', 'fix', 'gate']);
    const intoCard = insertAfter(stagedTree(), [1], cmd('new'));
    expect((intoCard[1] as StagesStep).steps.map(s => s.id)).toEqual(['new', 'impl', 'fix', 'gate']);
    expect(intoCard.map(s => s.id)).toEqual(['plan', 'build', 'after']);

    // Move: within the body, and never out of it.
    expect((moveAt(stagedTree(), [1, 2], -1)[1] as StagesStep).steps.map(s => s.id)).toEqual(['impl', 'gate', 'fix']);
    expect((moveAt(stagedTree(), [1, 2], 1)[1] as StagesStep).steps.map(s => s.id)).toEqual(['impl', 'fix', 'gate']);

    // Update: reaches into a loop nested in the body.
    const updated = updateAt(stagedTree(), [1, 1, 1], cmd('verify', 'check.log'));
    expect(((updated[1] as StagesStep).steps[1] as LoopStep).steps.map(s => s.id)).toEqual(['patch', 'verify']);
    expect(removeAt(stagedTree(), [1, 0])[1]).toMatchObject({ steps: [{ id: 'fix' }, { id: 'gate' }] });

    // Described: the lane's label says how often the body runs.
    expect(stagesRule(stagedTree()[1] as StagesStep)).toMatchObject({ phrase: 'once per stage file', items: 'plans/*.md' });
  });

  it('offers a step inside a body everything earlier outside it, and earlier body steps', () => {
    expect(referenceableIds(stagedTree(), [1, 2])).toEqual(['plan', 'impl', 'patch', 'check']);
  });

  it('never offers a later body sibling — a stage is not an iteration', () => {
    expect(referenceableIds(stagedTree(), [1, 0])).toEqual(['plan']);
  });

  it('still offers a later sibling inside a loop nested in the body', () => {
    expect(referenceableIds(stagedTree(), [1, 1, 0])).toEqual(['plan', 'impl', 'check']);
  });

  it('never offers a body step to a step outside the stages step — its artifacts do not outlive a stage', () => {
    expect(referenceableIds(stagedTree(), [2])).toEqual(['plan']);
  });

  it('never offers the stages step itself', () => {
    expect(referenceableIds(stagedTree(), [2])).not.toContain('build');
  });

  // parity/fixtures/desktop/reads-from.json holds what this offers for the
  // same tree; whiphand-core's tests/reads_from.rs checks that its validator
  // accepts every one of those references.
  it('offers exactly the references the validator is checked against', () => {
    const fixture = JSON.parse(readFileSync(READS_FROM_FIXTURE, 'utf8')) as {
      workflow: { steps: Step[] }; offers: Record<string, string[]>;
    };
    const steps = stagedTree();
    expect(fixture.workflow.steps).toEqual(steps);
    const walk = (list: Step[], prefix: number[]): number[][] => list.flatMap((step, i) => [
      [...prefix, i],
      ...('steps' in step ? walk(step.steps, [...prefix, i]) : []),
    ]);
    const offers: Record<string, string[]> = {};
    for (const path of walk(steps, [])) {
      const reader = stepAt(steps, path)!;
      if (reader.kind === 'loop' || reader.kind === 'stages') continue;
      offers[reader.id] = referenceableIds(steps, path);
    }
    expect(offers).toEqual(fixture.offers);
  });
});

// a | fix(until c)[b, c] | build(stages)[impl] | outer(until x)[x, inner(until y)[y]] | d
const wide = (): Step[] => [
  cmd('a'),
  { kind: 'loop', id: 'fix', until: 'c', steps: [cmd('b'), cmd('c')] } as LoopStep,
  { kind: 'stages', id: 'build', items: 'plans/*.md', steps: [cmd('impl')] } as StagesStep,
  {
    kind: 'loop', id: 'outer', until: 'x',
    steps: [cmd('x'), { kind: 'loop', id: 'inner', until: 'y', steps: [cmd('y')] } as LoopStep],
  } as LoopStep,
  cmd('d'),
];

const ids = (list: Step[]): string[] => list.map(s => s.id);
const body = (list: Step[], path: number[]): string[] => ids((stepAt(list, path) as LoopStep | StagesStep).steps);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('moveTo', () => {
  it('moves a top-level step into a loop body (the loop shifts up as the source leaves)', () => {
    const next = moveTo(wide(), [0], { parentPath: [1], index: 1 });
    expect(ids(next)).toEqual(['fix', 'build', 'outer', 'd']);
    expect(body(next, [0])).toEqual(['b', 'a', 'c']);
  });

  it('moves a loop body step out to the top level', () => {
    const next = moveTo(wide(), [1, 0], { parentPath: [], index: 4 });
    expect(ids(next)).toEqual(['a', 'fix', 'build', 'outer', 'b', 'd']);
    expect(body(next, [1])).toEqual(['c']);
  });

  it('moves a step between two different containers', () => {
    const next = moveTo(wide(), [1, 0], { parentPath: [2], index: 0 });
    expect(body(next, [1])).toEqual(['c']);
    expect(body(next, [2])).toEqual(['b', 'impl']);
  });

  it('moves a deeply nested step into a container earlier in the tree', () => {
    const next = moveTo(wide(), [3, 1, 0], { parentPath: [1], index: 2 });
    expect(body(next, [1])).toEqual(['b', 'c', 'y']);
    expect(body(next, [3, 1])).toEqual([]);
  });

  it('moves a step forwards within one list, landing at the intended slot', () => {
    // Slot 3 is "just before outer" in the list as it was before the move.
    expect(ids(moveTo(wide(), [0], { parentPath: [], index: 3 }))).toEqual(['fix', 'build', 'a', 'outer', 'd']);
    expect(ids(moveTo(wide(), [0], { parentPath: [], index: 5 }))).toEqual(['fix', 'build', 'outer', 'd', 'a']);
    expect(body(moveTo(wide(), [1, 0], { parentPath: [1], index: 2 }), [1])).toEqual(['c', 'b']);
  });

  it('moves a step backwards within one list', () => {
    expect(ids(moveTo(wide(), [4], { parentPath: [], index: 1 }))).toEqual(['a', 'd', 'fix', 'build', 'outer']);
    expect(ids(moveTo(wide(), [4], { parentPath: [], index: 0 }))).toEqual(['d', 'a', 'fix', 'build', 'outer']);
  });

  it('moves a container with its whole body, keeping id and fields', () => {
    const original = wide();
    const next = moveTo(original, [3], { parentPath: [2], index: 1 });
    expect(ids(next)).toEqual(['a', 'fix', 'build', 'd']);
    expect(body(next, [2])).toEqual(['impl', 'outer']);
    expect(stepAt(next, [2, 1])).toBe(original[3]);
    expect(body(next, [2, 1])).toEqual(['x', 'inner']);
    expect(body(next, [2, 1, 1])).toEqual(['y']);
  });

  it('returns the input itself for a no-op move', () => {
    const original = wide();
    expect(moveTo(original, [1], { parentPath: [], index: 1 })).toBe(original);
    expect(moveTo(original, [1], { parentPath: [], index: 2 })).toBe(original);
    expect(moveTo(original, [1, 1], { parentPath: [1], index: 2 })).toBe(original);
  });

  it('returns the input itself for a structurally impossible move', () => {
    const original = wide();
    expect(moveTo(original, [3], { parentPath: [3, 1], index: 0 })).toBe(original);
    expect(moveTo(original, [3], { parentPath: [3], index: 0 })).toBe(original);
    expect(moveTo(original, [0], { parentPath: [4], index: 0 })).toBe(original);
    expect(moveTo(original, [9], { parentPath: [], index: 0 })).toBe(original);
  });

  it('does not mutate its input', () => {
    const original = deepFreeze(wide());
    const snapshot = structuredClone(original);
    moveTo(original, [0], { parentPath: [1], index: 1 });
    moveTo(original, [3, 1, 0], { parentPath: [], index: 0 });
    moveTo(original, [3], { parentPath: [2], index: 0 });
    moveTo(original, [0], { parentPath: [], index: 4 });
    expect(original).toEqual(snapshot);
  });
});

describe('moveBlocker', () => {
  it('refuses a stages step into a loop', () => {
    expect(moveBlocker(wide(), [2], [1])).toBe("'build' is a stages step — it cannot run inside a loop");
  });

  it('refuses a stages step into another stages step', () => {
    const steps = [...wide(), { kind: 'stages', id: 'more', items: '*.md', steps: [] } as StagesStep];
    expect(moveBlocker(steps, [5], [2])).toBe("'more' is a stages step — it cannot run inside another stages step");
  });

  it('refuses a loop into its own body or a grandchild loop of itself', () => {
    expect(moveBlocker(wide(), [3], [3])).toBe("'outer' cannot be moved inside itself");
    expect(moveBlocker(wide(), [3], [3, 1])).toBe("'outer' cannot be moved inside itself");
  });

  it("refuses a loop's until: target leaving that loop, naming the loop", () => {
    expect(moveBlocker(wide(), [1, 1], [])).toBe("'c' ends loop 'fix' — it cannot leave it");
    expect(moveBlocker(wide(), [1, 1], [2])).toBe("'c' ends loop 'fix' — it cannot leave it");
    expect(moveBlocker(wide(), [3, 1, 0], [3])).toBe("'y' ends loop 'inner' — it cannot leave it");
  });

  it('refuses a destination that is not a container', () => {
    expect(moveBlocker(wide(), [0], [4])).not.toBeNull();
    expect(moveBlocker(wide(), [0], [1, 0])).not.toBeNull();
    expect(moveBlocker(wide(), [0], [9])).not.toBeNull();
  });

  it('allows ordinary legal moves', () => {
    expect(moveBlocker(wide(), [0], [1])).toBeNull();          // top level into a loop
    expect(moveBlocker(wide(), [1, 0], [])).toBeNull();        // loop body out to top level
    expect(moveBlocker(wide(), [1, 0], [2])).toBeNull();       // between containers
    expect(moveBlocker(wide(), [1, 1], [1])).toBeNull();       // until: target reordered within its own loop
    expect(moveBlocker(wide(), [3], [2])).toBeNull();          // a loop into a stages body
    expect(moveBlocker(wide(), [1], [3, 1])).toBeNull();       // a loop into another loop
    expect(moveBlocker(wide(), [2], [])).toBeNull();           // stages step within the top level
    expect(moveBlocker(wide(), [3, 0], [3])).toBeNull();       // outer's until: target stays in outer
  });
});

describe('outdentTarget / indentTarget', () => {
  it('outdents to just after the parent container', () => {
    expect(outdentTarget([1, 0])).toEqual({ parentPath: [], index: 2 });
    expect(outdentTarget([3, 1, 0])).toEqual({ parentPath: [3], index: 2 });
  });

  it('has no outdent target for a top-level step', () => {
    expect(outdentTarget([2])).toBeUndefined();
    expect(outdentTarget([])).toBeUndefined();
  });

  it('indents to the end of the previous sibling container', () => {
    expect(indentTarget(wide(), [2])).toEqual({ parentPath: [1], index: 2 });
    expect(indentTarget(wide(), [4])).toEqual({ parentPath: [3], index: 2 });
    expect(indentTarget(wide(), [3])).toEqual({ parentPath: [2], index: 1 });
  });

  it('has no indent target when the previous sibling is missing or not a container', () => {
    expect(indentTarget(wide(), [0])).toBeUndefined();
    expect(indentTarget(wide(), [1])).toBeUndefined();
    expect(indentTarget(wide(), [3, 0])).toBeUndefined();
    expect(indentTarget(wide(), [])).toBeUndefined();
  });

  it('round-trips: indent then outdent puts a step back where it was', () => {
    const start = wide();
    const into = indentTarget(start, [4])!;
    const indented = moveTo(start, [4], into);
    expect(body(indented, [3])).toEqual(['x', 'inner', 'd']);
    const back = moveTo(indented, [3, 2], outdentTarget([3, 2])!);
    expect(ids(back)).toEqual(ids(start));
  });
});

describe('useWorkflowDraft().moveStepTo', () => {
  const workflow = (): Workflow => ({ name: 'wf', steps: wide() });

  it('applies a legal move', () => {
    const { result } = renderHook(() => useWorkflowDraft(workflow()));
    act(() => result.current.moveStepTo([0], { parentPath: [1], index: 0 }));
    expect(ids(result.current.draft.steps)).toEqual(['fix', 'build', 'outer', 'd']);
    expect(body(result.current.draft.steps, [0])).toEqual(['a', 'b', 'c']);
  });

  it('leaves the draft untouched when the move is blocked', () => {
    const { result } = renderHook(() => useWorkflowDraft(workflow()));
    const before = result.current.draft;
    act(() => result.current.moveStepTo([2], { parentPath: [1], index: 0 }));   // stages into a loop
    act(() => result.current.moveStepTo([1, 1], { parentPath: [], index: 0 })); // until: target out of its loop
    act(() => result.current.moveStepTo([3], { parentPath: [3, 1], index: 0 })); // into itself
    expect(result.current.draft).toBe(before);
  });
});
