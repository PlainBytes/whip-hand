import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDrop, type DropInput } from './drag-projection.ts';
import { editorRows, type EditorRow } from './editor-model.ts';
import { moveTo } from './step-tree.ts';
import { isContainerStep } from '../shared/steps.ts';
import type { CommandStep, LoopStep, StagesStep, Step } from '../shared/types.ts';

const cmd = (id: string): CommandStep => ({ kind: 'command', id, run: `echo ${id}` });
const loop = (id: string, until: string, steps: Step[]): LoopStep => ({ kind: 'loop', id, until, steps } as LoopStep);
const stages = (id: string, steps: Step[]): StagesStep => ({ kind: 'stages', id, items: 'plans/*.md', steps } as StagesStep);

/** a, fix (loop until c: b, c), d */
const tree = (): Step[] => [cmd('a'), loop('fix', 'c', [cmd('b'), cmd('c')]), cmd('d')];

/** The rows the editor shows, with the bodies of `folded` containers hidden (as WorkflowEditor does). */
function visibleRows(steps: Step[], folded: string[] = []): EditorRow[] {
  const visible: EditorRow[] = [];
  let hideDepth: number | null = null;
  for (const row of editorRows({ name: 'w', steps })) {
    if (hideDepth !== null) {
      if (row.depth > hideDepth) continue;
      hideDepth = null;
    }
    visible.push(row);
    if (isContainerStep(row.step) && folded.includes(row.step.id)) hideDepth = row.depth;
  }
  return visible;
}

function project(steps: Step[], drag: Omit<DropInput, 'steps' | 'rows'>, folded: string[] = []) {
  return projectDrop({ steps, rows: visibleRows(steps, folded), ...drag });
}

/** Ids as a nested outline, so a final tree reads at a glance. */
function outline(steps: Step[]): unknown[] {
  return steps.map(s => (isContainerStep(s) ? { [s.id]: outline(s.steps) } : s.id));
}

function drop(steps: Step[], drag: Omit<DropInput, 'steps' | 'rows'>, folded: string[] = []): Step[] {
  const p = project(steps, drag, folded);
  expect(p).not.toBeNull();
  expect(p!.blocker).toBeNull();
  return moveTo(steps, p!.from, p!);
}

describe('projectDrop', () => {
  it('drops a top-level step below a loop at top level with zero offset', () => {
    const steps = tree();
    const p = project(steps, { activeId: 'a', overId: 'c', placement: 'after', offsetDepth: 0 });
    expect(p).toEqual({ from: [0], parentPath: [], index: 2, depth: 0, blocker: null });
    expect(outline(moveTo(steps, p!.from, p!))).toEqual([{ fix: ['b', 'c'] }, 'a', 'd']);
    // The upper half of the row after the loop is the same gap.
    expect(project(steps, { activeId: 'a', overId: 'd', placement: 'before', offsetDepth: 0 }))
      .toMatchObject({ parentPath: [], index: 2, depth: 0 });
  });

  it('drops as the first body step with offset +1 directly below the loop header', () => {
    const steps = tree();
    const p = project(steps, { activeId: 'd', overId: 'fix', placement: 'after', offsetDepth: 1 });
    expect(p).toEqual({ from: [2], parentPath: [1], index: 0, depth: 1, blocker: null });
    expect(outline(moveTo(steps, p!.from, p!))).toEqual(['a', { fix: ['d', 'b', 'c'] }]);
  });

  it('uses the offset to choose between an empty loop body and after the loop', () => {
    const steps = [cmd('a'), loop('empty', 'x', []), cmd('d')];
    expect(project(steps, { activeId: 'a', overId: 'empty', placement: 'after', offsetDepth: 0 }))
      .toMatchObject({ parentPath: [], index: 2, depth: 0 });
    expect(project(steps, { activeId: 'a', overId: 'empty', placement: 'after', offsetDepth: 1 }))
      .toMatchObject({ parentPath: [1], index: 0, depth: 1, blocker: null });
  });

  it('outdents the last body step of a loop to right after the loop with offset -1', () => {
    const steps = [cmd('a'), loop('fix', 'b', [cmd('b'), cmd('c')]), cmd('d')];
    const p = project(steps, { activeId: 'c', overId: 'c', placement: 'after', offsetDepth: -1 });
    expect(p).toEqual({ from: [1, 1], parentPath: [], index: 2, depth: 0, blocker: null });
    expect(outline(moveTo(steps, p!.from, p!))).toEqual(['a', { fix: ['b'] }, 'c', 'd']);
  });

  it('resolves into a loop nested in a stages body at that loop\'s depth', () => {
    const steps = [
      cmd('plan'),
      stages('build', [cmd('impl'), loop('inner', 'x', [cmd('x'), cmd('y')])]),
      cmd('after'),
    ];
    const p = project(steps, { activeId: 'plan', overId: 'y', placement: 'after', offsetDepth: 2 });
    expect(p).toEqual({ from: [0], parentPath: [1, 1], index: 2, depth: 2, blocker: null });
    expect(outline(drop(steps, { activeId: 'plan', overId: 'y', placement: 'after', offsetDepth: 2 })))
      .toEqual([{ build: ['impl', { inner: ['x', 'y', 'plan'] }] }, 'after']);
    // One level shallower is the stages body, after the loop.
    expect(project(steps, { activeId: 'plan', overId: 'y', placement: 'after', offsetDepth: 1 }))
      .toMatchObject({ parentPath: [1], index: 2, depth: 1, blocker: null });
  });

  it('clamps an offset deeper than the gap allows', () => {
    // Below a leaf top-level step, nothing deeper than top level exists.
    expect(project(tree(), { activeId: 'd', overId: 'a', placement: 'after', offsetDepth: 5 }))
      .toEqual({ from: [2], parentPath: [], index: 1, depth: 0, blocker: null });
  });

  it('clamps an offset shallower than the gap allows to the row below\'s depth', () => {
    // Between b and c the row below sits in the loop body; leaving it would orphan c.
    expect(project(tree(), { activeId: 'a', overId: 'b', placement: 'after', offsetDepth: -5 }))
      .toEqual({ from: [0], parentPath: [1], index: 1, depth: 1, blocker: null });
  });

  it('gives no target inside itself when a loop is dragged over its own body rows', () => {
    const steps = tree();
    for (const overId of ['b', 'c']) {
      for (const placement of ['before', 'after'] as const) {
        expect(project(steps, { activeId: 'fix', overId, placement, offsetDepth: 1 })).toBeNull();
      }
    }
    // Its body is not a candidate either: just below d, with room to indent, it stays top-level.
    expect(project(steps, { activeId: 'fix', overId: 'a', placement: 'after', offsetDepth: 3 })).toBeNull();
    expect(project(steps, { activeId: 'fix', overId: 'd', placement: 'after', offsetDepth: 3 }))
      .toMatchObject({ parentPath: [], index: 3, depth: 0, blocker: null });
  });

  it('returns a stages step dropped into a loop body with a blocker', () => {
    const steps = [stages('s', [cmd('x')]), loop('l', 'y', [cmd('y')])];
    const p = project(steps, { activeId: 's', overId: 'y', placement: 'after', offsetDepth: 1 });
    expect(p).toMatchObject({ from: [0], parentPath: [1], index: 1, depth: 1 });
    expect(p!.blocker).toMatch(/stages step/);
  });

  it('returns a loop\'s until step dragged out of the loop with a blocker naming the loop', () => {
    const p = project(tree(), { activeId: 'c', overId: 'c', placement: 'after', offsetDepth: -1 });
    expect(p).toMatchObject({ from: [1, 1], parentPath: [], index: 2, depth: 0 });
    expect(p!.blocker).toMatch(/'fix'/);
  });

  it('drops after a folded container at its depth, not into its hidden body', () => {
    const steps = tree();
    for (const offsetDepth of [0, 1]) {
      expect(project(steps, { activeId: 'a', overId: 'fix', placement: 'after', offsetDepth }, ['fix']))
        .toEqual({ from: [0], parentPath: [], index: 2, depth: 0, blocker: null });
    }
    expect(outline(drop(steps, { activeId: 'a', overId: 'fix', placement: 'after', offsetDepth: 0 }, ['fix'])))
      .toEqual([{ fix: ['b', 'c'] }, 'a', 'd']);
  });

  it('returns null for a projection equal to the current position', () => {
    const steps = tree();
    expect(project(steps, { activeId: 'a', overId: 'a', placement: 'after', offsetDepth: 0 })).toBeNull();
    expect(project(steps, { activeId: 'a', overId: 'fix', placement: 'before', offsetDepth: 0 })).toBeNull();
    expect(project(steps, { activeId: 'b', overId: 'b', placement: 'before', offsetDepth: 3 })).toBeNull();
    // d dropped just after the loop's last body step, at top level, is where d already is.
    expect(project(steps, { activeId: 'd', overId: 'c', placement: 'after', offsetDepth: 0 })).toBeNull();
  });

  it('keeps a container\'s sole body step in place when dragged without moving out', () => {
    // The parents here would not block a move out, so a wrong projection would be a silent legal move.
    for (const steps of [
      [cmd('a'), stages('S', [cmd('b')]), cmd('d')],
      [cmd('a'), loop('L', 'a', [cmd('b')]), cmd('d')],
    ]) {
      const parent = steps[1].id;
      expect(project(steps, { activeId: 'b', overId: 'b', placement: 'after', offsetDepth: 0 })).toBeNull();
      expect(project(steps, { activeId: 'b', overId: 'b', placement: 'before', offsetDepth: 1 })).toBeNull();
      expect(project(steps, { activeId: 'b', overId: parent, placement: 'after', offsetDepth: 0 })).toBeNull();
      expect(project(steps, { activeId: 'b', overId: 'd', placement: 'before', offsetDepth: 0 })).toBeNull();
      // Outdenting still moves it out, right after its container.
      expect(outline(drop(steps, { activeId: 'b', overId: 'b', placement: 'after', offsetDepth: -1 })))
        .toEqual(['a', { [parent]: [] }, 'b', 'd']);
    }
  });

  it('returns null for an unknown active or over id', () => {
    expect(project(tree(), { activeId: 'nope', overId: 'a', placement: 'after', offsetDepth: 0 })).toBeNull();
    expect(project(tree(), { activeId: 'a', overId: 'nope', placement: 'after', offsetDepth: 0 })).toBeNull();
  });

  it('moves a step out of a loop into the next one in a single drop', () => {
    const steps = [loop('one', 'p', [cmd('p'), cmd('q')]), loop('two', 'r', [cmd('r')])];
    expect(outline(drop(steps, { activeId: 'q', overId: 'r', placement: 'after', offsetDepth: 0 })))
      .toEqual([{ one: ['p'] }, { two: ['r', 'q'] }]);
  });

  it('imports nothing from React or @dnd-kit', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.resolve(here, 'drag-projection.ts'), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(/^react|^@dnd-kit/);
      expect(spec.startsWith('.')).toBe(true);
    }
  });
});
