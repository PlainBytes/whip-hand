/**
 * Immutable edits to a workflow's step tree, addressed by path.
 *
 * A workflow used to be a flat array, so an index was an address. Loops made it
 * a tree, and every editing action (update, move, remove, add) now needs to
 * say *where* — `[1, 0]` is the first step of the second top-level step's
 * body. Kept out of WorkflowsPage so the tree arithmetic is testable on its own.
 */
import type { LoopStep, Step } from '../../../../packages/core/src/types.ts';
import { isLoopStep } from '../../../../packages/core/src/steps.ts';
import { ATTACHMENTS_REF } from '../../../../packages/core/src/attachments.ts';

export type StepPath = number[];

/** The list a path addresses into — the top level, or some loop's body. */
export function siblingsAt(steps: Step[], parentPath: StepPath): Step[] {
  let list = steps;
  for (const index of parentPath) {
    const step = list[index];
    if (step === undefined || !isLoopStep(step)) return [];
    list = step.steps;
  }
  return list;
}

export function stepAt(steps: Step[], path: StepPath): Step | undefined {
  if (path.length === 0) return undefined;
  return siblingsAt(steps, path.slice(0, -1))[path[path.length - 1]];
}

/** Rebuilds `steps` with `edit` applied to the list the path points into. */
function mapList(steps: Step[], parentPath: StepPath, edit: (list: Step[]) => Step[]): Step[] {
  if (parentPath.length === 0) return edit(steps);
  const [head, ...rest] = parentPath;
  return steps.map((step, i) => {
    if (i !== head || !isLoopStep(step)) return step;
    return { ...step, steps: mapList(step.steps, rest, edit) } satisfies LoopStep;
  });
}

export function updateAt(steps: Step[], path: StepPath, next: Step): Step[] {
  const index = path[path.length - 1];
  return mapList(steps, path.slice(0, -1), list => list.map((s, i) => (i === index ? next : s)));
}

export function removeAt(steps: Step[], path: StepPath): Step[] {
  const index = path[path.length - 1];
  return mapList(steps, path.slice(0, -1), list => list.filter((_, i) => i !== index));
}

/**
 * Inserts `step` next to the card at `path` — the header-row "insert below"
 * action. Asymmetric on purpose: a loop card has no next row inside itself, so
 * inserting after one means its first body child (the row the list actually
 * shows next), which is also what makes a fresh loop populatable in one click.
 * Any other card — including a loop's last body step — inserts as the next
 * sibling at its own depth; move stays sibling-only and this does not change
 * that.
 */
export function insertAfter(steps: Step[], path: StepPath, step: Step): Step[] {
  const target = stepAt(steps, path);
  if (target !== undefined && isLoopStep(target)) {
    return mapList(steps, path, list => [step, ...list]);
  }
  const index = path[path.length - 1];
  return mapList(steps, path.slice(0, -1), list => [
    ...list.slice(0, index + 1), step, ...list.slice(index + 1),
  ]);
}

/**
 * Renames a step id everywhere it is used: the step's own `id`, every
 * `inputs:` entry naming it, and every loop `until:` naming it. `LoopStep`
 * carries no `inputs`, so a rename that only filtered on `inputs` would leave
 * a loop's `until:` dangling — the exact state static validation exists to
 * reject at save time.
 *
 * An `inputs:` entry of `attachments` is never a reference to a step, even
 * in a workflow that (invalidly) has a step of that name: it is the reserved
 * ref for the run's attached files, so renaming that step leaves it alone.
 */
export function renameStep(steps: Step[], oldId: string, newId: string): Step[] {
  return steps.map(step => {
    if (isLoopStep(step)) {
      return {
        ...step,
        id: step.id === oldId ? newId : step.id,
        until: step.until === oldId ? newId : step.until,
        steps: renameStep(step.steps, oldId, newId),
      } satisfies LoopStep;
    }
    return {
      ...step,
      id: step.id === oldId ? newId : step.id,
      ...(step.inputs
        ? { inputs: step.inputs.map(id => (id === oldId && id !== ATTACHMENTS_REF ? newId : id)) }
        : {}),
    };
  });
}

/**
 * Removes the step with id `id`, wherever it is in the tree, and strips that
 * id from every remaining step's `inputs:` — mirroring `renameStep`, for the
 * same reason: leaving the one operation that invalidates a reference as a
 * save-time error (naming the readers, not the step that was removed) is the
 * odd one out once references are first-class objects on screen. As there,
 * `attachments` in `inputs:` is the reserved ref, not a reference to the
 * step being removed, and survives it.
 */
export function removeStep(steps: Step[], id: string): Step[] {
  const withoutId = (list: Step[]): Step[] =>
    list.flatMap((step): Step[] => {
      if (step.id === id) return [];
      if (isLoopStep(step)) return [{ ...step, steps: withoutId(step.steps) }];
      return [step];
    });
  const stripInputs = (list: Step[]): Step[] =>
    list.map(step => {
      if (isLoopStep(step)) return { ...step, steps: stripInputs(step.steps) };
      if (id === ATTACHMENTS_REF || !step.inputs?.includes(id)) return step;
      return { ...step, inputs: step.inputs.filter(i => i !== id) };
    });
  return stripInputs(withoutId(steps));
}

/** Appends to the end of the list `parentPath` addresses (`[]` = top level). */
export function appendAt(steps: Step[], parentPath: StepPath, step: Step): Step[] {
  return mapList(steps, parentPath, list => [...list, step]);
}

/** Moves a step within its own list. Deliberately never across lists: dragging a step into or out of a loop changes what it means, so that stays an explicit remove + add. */
export function moveAt(steps: Step[], path: StepPath, dir: -1 | 1): Step[] {
  const index = path[path.length - 1];
  return mapList(steps, path.slice(0, -1), list => {
    const target = index + dir;
    if (target < 0 || target >= list.length) return list;
    const copy = list.slice();
    [copy[index], copy[target]] = [copy[target], copy[index]];
    return copy;
  });
}

/**
 * Ids a step at `path` is allowed to reference: everything declared before it,
 * plus — when it sits in a loop body — its later siblings, which resolve to the
 * previous iteration's artifact. Mirrors validateWorkflowSemantics in
 * packages/core/src/schema.ts; a dropdown that offers an id the validator will
 * reject is worse than one that offers too few.
 */
export function referenceableIds(steps: Step[], path: StepPath): string[] {
  const ids: string[] = [];
  const collect = (list: Step[], prefix: StepPath): void => {
    list.forEach((step, i) => {
      const here = [...prefix, i];
      const isSelf = here.length === path.length && here.every((v, j) => v === path[j]);
      if (isSelf) return;
      const inSameLoopBody = path.length > 1
        && here.length === path.length
        && here.slice(0, -1).every((v, j) => v === path[j]);
      if (isLoopStep(step)) {
        collect(step.steps, here);
        return;
      }
      if (!step.output) return;
      if (before(here, path) || inSameLoopBody) ids.push(step.id);
    });
  };
  collect(steps, []);
  return ids;
}

function before(a: StepPath, b: StepPath): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? -1;
    const bv = b[i] ?? -1;
    if (av !== bv) return av < bv;
  }
  return false;
}
