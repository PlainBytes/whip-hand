/**
 * Immutable edits to a workflow's step tree, addressed by path.
 *
 * Containers (`loop` and `stages`) nest steps into a tree, so every editing
 * action (update, move, remove, add) needs to say *where* — `[1, 0]` is the
 * first step of the second top-level step's body, whichever kind of container
 * that is. Kept out of WorkflowsPage so the tree arithmetic is testable on its
 * own.
 */
import type { LoopStep, StagesStep, Step } from '../shared/types.ts';
import { isContainerStep, isLoopStep, isStagesStep } from '../shared/steps.ts';
import { ATTACHMENTS_REF } from '../shared/attachments.ts';

export type StepPath = number[];

/** The list a path addresses into — the top level, or some container's body. */
export function siblingsAt(steps: Step[], parentPath: StepPath): Step[] {
  let list = steps;
  for (const index of parentPath) {
    const step = list[index];
    if (step === undefined || !isContainerStep(step)) return [];
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
    if (i !== head || !isContainerStep(step)) return step;
    return { ...step, steps: mapList(step.steps, rest, edit) };
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
 * action. Asymmetric on purpose: a container card (loop or stages) has no next
 * row inside itself, so inserting after one means its first body child (the
 * row the list actually shows next), which is also what makes a fresh
 * container populatable in one click.
 * Any other card — including a container's last body step — inserts as the next
 * sibling at its own depth — insert-below never escapes the list the card
 * sits in.
 */
export function insertAfter(steps: Step[], path: StepPath, step: Step): Step[] {
  const target = stepAt(steps, path);
  if (target !== undefined && isContainerStep(target)) {
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
    if (isStagesStep(step)) {
      // A `stages` step has no `inputs`/`until` of its own to fix up, but its
      // body can still read steps outside it, so the rename recurses.
      return {
        ...step,
        id: step.id === oldId ? newId : step.id,
        steps: renameStep(step.steps, oldId, newId),
      } satisfies StagesStep;
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
      if (isContainerStep(step)) return [{ ...step, steps: withoutId(step.steps) }];
      return [step];
    });
  const stripInputs = (list: Step[]): Step[] =>
    list.map(step => {
      if (isContainerStep(step)) return { ...step, steps: stripInputs(step.steps) }; // no inputs of its own
      if (id === ATTACHMENTS_REF || !step.inputs?.includes(id)) return step;
      return { ...step, inputs: step.inputs.filter(i => i !== id) };
    });
  return stripInputs(withoutId(steps));
}

/** Appends to the end of the list `parentPath` addresses (`[]` = top level). */
export function appendAt(steps: Step[], parentPath: StepPath, step: Step): Step[] {
  return mapList(steps, parentPath, list => [...list, step]);
}

/**
 * Swaps a step with its previous (`-1`) or next (`1`) sibling — the up/down
 * buttons. Sibling-only by design; moving a step into or out of a container
 * is `moveTo`, gated by `moveBlocker`.
 */
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

/** A slot in some list of the tree: `index` within the list `parentPath` addresses (`[]` = top level). */
export interface MoveDestination {
  parentPath: StepPath;
  index: number;
}

function isPrefix(prefix: StepPath, path: StepPath): boolean {
  return prefix.length <= path.length && prefix.every((v, i) => v === path[i]);
}

function samePath(a: StepPath, b: StepPath): boolean {
  return a.length === b.length && isPrefix(a, b);
}

/** `[]` (the top level) or a path to a container step — anything else has no list to insert into. */
function addressesList(steps: Step[], parentPath: StepPath): boolean {
  if (parentPath.length === 0) return true;
  const step = stepAt(steps, parentPath);
  return step !== undefined && isContainerStep(step);
}

/**
 * Moves the step at `from` to `to`, anywhere in the tree — into or out of a
 * `loop` / `stages` body included. `to.index` is a slot in the destination
 * list *as it is before the move*; when source and destination share a list
 * and the source sits earlier, the removal shift is accounted for here. The
 * step keeps its id, fields and whole body, and nothing else is rewritten
 * (`inputs:` / `until:` references stay as they are — the save-time
 * validator judges them).
 *
 * Returns `steps` itself for a no-op move and for a structurally impossible
 * one (`from` addresses nothing, the destination is not a list, or lies
 * inside the moved step). It does not apply the editor's rules — ask
 * `moveBlocker` first.
 */
export function moveTo(steps: Step[], from: StepPath, to: MoveDestination): Step[] {
  const step = stepAt(steps, from);
  if (step === undefined || !addressesList(steps, to.parentPath) || isPrefix(from, to.parentPath)) return steps;
  const fromParent = from.slice(0, -1);
  const fromIndex = from[from.length - 1];
  const sameList = samePath(fromParent, to.parentPath);
  if (sameList && (to.index === fromIndex || to.index === fromIndex + 1)) return steps;

  // Removing the source shifts every later sibling in its list down by one:
  // that is the destination slot itself when both share a list, or the
  // ancestor of the destination list that sits in the source's list.
  const parentPath = to.parentPath.slice();
  let index = to.index;
  if (sameList) {
    if (fromIndex < index) index -= 1;
  } else if (isPrefix(fromParent, parentPath) && parentPath[fromParent.length] > fromIndex) {
    parentPath[fromParent.length] -= 1;
  }

  const removed = removeAt(steps, from);
  return mapList(removed, parentPath, list => {
    const at = Math.max(0, Math.min(index, list.length));
    return [...list.slice(0, at), step, ...list.slice(at)];
  });
}

/**
 * Why the step at `from` may not move into the list at `toParentPath`, as a
 * short user-facing reason — or `null` when it may. The one place the
 * editor's move rules live (buttons and drag-and-drop both ask here):
 *
 * - a `stages` step only runs at the top level — core refuses one inside a
 *   loop or inside another `stages` step;
 * - a container cannot go into itself or any of its own descendants;
 * - a loop's `until:` target cannot leave that loop's direct body;
 * - the destination must be the top level or a container.
 *
 * Reference direction (an `inputs:` entry that would now point forward) is
 * not checked: the save-time validator remains the authority for that.
 */
export function moveBlocker(steps: Step[], from: StepPath, toParentPath: StepPath): string | null {
  const step = stepAt(steps, from);
  if (step === undefined) return 'There is no step to move';
  if (!addressesList(steps, toParentPath)) return 'Steps can only be placed at the top level or inside a loop or stages body';
  if (isPrefix(from, toParentPath)) return `'${step.id}' cannot be moved inside itself`;
  if (isStagesStep(step) && toParentPath.length > 0) {
    const into = stepAt(steps, toParentPath);
    const where = into !== undefined && isStagesStep(into) ? 'another stages step' : 'a loop';
    return `'${step.id}' is a stages step — it cannot run inside ${where}`;
  }
  const fromParent = from.slice(0, -1);
  const parent = stepAt(steps, fromParent);
  if (parent !== undefined && isLoopStep(parent) && parent.until === step.id && !samePath(fromParent, toParentPath)) {
    return `'${step.id}' ends loop '${parent.id}' — it cannot leave it`;
  }
  return null;
}

/** "Outdent": the slot just after the step's parent container, or `undefined` for a top-level step. */
export function outdentTarget(path: StepPath): MoveDestination | undefined {
  if (path.length < 2) return undefined;
  return { parentPath: path.slice(0, -2), index: path[path.length - 2] + 1 };
}

/** "Indent": the end of the previous sibling's body when that sibling is a container, else `undefined`. */
export function indentTarget(steps: Step[], path: StepPath): MoveDestination | undefined {
  if (path.length === 0) return undefined;
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1];
  if (index < 1) return undefined;
  const prev = siblingsAt(steps, parentPath)[index - 1];
  if (prev === undefined || !isContainerStep(prev)) return undefined;
  return { parentPath: [...parentPath, index - 1], index: prev.steps.length };
}

/**
 * Ids a step at `path` is allowed to reference: everything declared before it,
 * plus — when it sits in a loop body — its later siblings, which resolve to the
 * previous iteration's artifact. Mirrors validate_workflow_semantics in
 * whiphand-core's schema/semantics.rs (parity/fixtures/desktop/reads-from.json
 * ties the two together); a dropdown that offers an id the validator will
 * reject is worse than one that offers too few. So, for `stages`:
 *
 * - the stages step itself produces no artifact and is never offered;
 * - its body is only looked into from a step inside that same body — a
 *   stage's artifacts do not outlive the stage, so a reader after the stages
 *   step would find nothing;
 * - a later sibling in a stages body is never offered: each stage is a fresh
 *   pass, not an iteration with a "previous" artifact to mean.
 *
 * `stage` (the current stage file) is not a step and is not returned here —
 * like `attachments`, the Reads from dropdown offers it itself.
 */
export function referenceableIds(steps: Step[], path: StepPath): string[] {
  const ids: string[] = [];
  const isPrefixOfPath = (p: StepPath): boolean => p.length < path.length && p.every((v, j) => v === path[j]);
  const collect = (list: Step[], prefix: StepPath, inLoopBody: boolean): void => {
    list.forEach((step, i) => {
      const here = [...prefix, i];
      const isSelf = here.length === path.length && here.every((v, j) => v === path[j]);
      if (isSelf) return;
      if (isLoopStep(step)) {
        collect(step.steps, here, true);
        return;
      }
      if (isStagesStep(step)) {
        if (isPrefixOfPath(here)) collect(step.steps, here, false);
        return;
      }
      if (!step.output) return;
      const inSameLoopBody = inLoopBody
        && here.length === path.length
        && here.slice(0, -1).every((v, j) => v === path[j]);
      if (before(here, path) || inSameLoopBody) ids.push(step.id);
    });
  };
  collect(steps, [], false);
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
