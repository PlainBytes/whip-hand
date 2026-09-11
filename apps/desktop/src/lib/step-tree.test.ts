import { describe, expect, it } from 'vitest';
import {
  appendAt, insertAfter, moveAt, referenceableIds, removeAt, removeStep, renameStep, siblingsAt, stepAt, updateAt,
} from './step-tree.ts';
import type { CommandStep, LoopStep, Step } from '../../../../packages/core/src/types.ts';

const cmd = (id: string, output?: string): CommandStep =>
  ({ kind: 'command', id, run: `echo ${id}`, ...(output ? { output } : {}) });

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
