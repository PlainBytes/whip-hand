/**
 * Drop-target projection for dragging a step row in the workflow editor —
 * the "flattened sortable tree" arithmetic, kept free of React and of any
 * drag-and-drop library so it can be tested on its own. The drag layer feeds
 * it where the pointer is (which row, which half of it, how far sideways) and
 * gets back a destination in `moveTo` terms, plus `moveBlocker`'s verdict.
 */
import type { Step } from '../shared/types.ts';
import { isContainerStep } from '../shared/steps.ts';
import type { EditorRow } from './editor-model.ts';
import { moveBlocker, type MoveDestination, type StepPath } from './step-tree.ts';

export interface DropInput {
  steps: Step[];
  /** The rows on screen, in render order — a folded container's body is not among them. */
  rows: EditorRow[];
  /** Id of the dragged step. */
  activeId: string;
  /** Id of the row under the pointer; may be the dragged row itself (a purely sideways drag). */
  overId: string;
  /** Whether the pointer is in the upper or lower half of the over row. Ignored when over the dragged row. */
  placement: 'before' | 'after';
  /** Horizontal drag offset, already divided by the indent width; rounded to the nearest level. */
  offsetDepth: number;
}

export interface DropProjection extends MoveDestination {
  /** Where the dragged step is now — `moveTo(steps, from, { parentPath, index })` applies the drop. */
  from: StepPath;
  /** Indent level of the drop indicator. */
  depth: number;
  /** `moveBlocker`'s reason the drop is not allowed, or `null` when it is. */
  blocker: string | null;
}

function isStrictPrefix(prefix: StepPath, path: StepPath): boolean {
  return prefix.length < path.length && prefix.every((v, i) => v === path[i]);
}

function samePath(a: StepPath, b: StepPath): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Whether a row can take a drop as its first body child: it is a container
 * whose body is either empty or shown — the row right after it in the full
 * visible `rows` (not the candidates, so the dragged row itself counts) is its
 * child. A folded container with a hidden body is one opaque row — dropping
 * "into" it would land somewhere the user cannot see.
 */
function acceptsFirstChild(row: EditorRow, rows: EditorRow[]): boolean {
  if (!isContainerStep(row.step)) return false;
  if (row.step.steps.length === 0) return true;
  const next = rows[rows.indexOf(row) + 1];
  return next !== undefined && isStrictPrefix(row.path, next.path);
}

/**
 * Where the dragged step would land, or `null` when there is no meaningful
 * target: an unknown id, the pointer over one of the dragged step's own
 * descendants, or a drop that resolves to the step's current position.
 *
 * The dragged row's body travels with it, so its descendants are dropped from
 * the candidate rows first. The gap the pointer marks then sits between a row
 * above and a row below, and the drop depth (the dragged row's depth plus
 * `offsetDepth`) is clamped to what that gap allows: no shallower than the
 * row below (or it would be orphaned from its parent) and no deeper than the
 * row above — one deeper only when the row above takes a first body child.
 *
 * An illegal destination (e.g. a `stages` step into a loop) is returned with
 * its `blocker` rather than adjusted to a legal one.
 */
export function projectDrop(input: DropInput): DropProjection | null {
  const { steps, rows, activeId, overId, placement, offsetDepth } = input;
  const active = rows.find(r => r.step.id === activeId);
  if (active === undefined) return null;
  if (rows.some(r => r.step.id === overId && isStrictPrefix(active.path, r.path))) return null;

  const candidates = rows.filter(r => r !== active && !isStrictPrefix(active.path, r.path));
  let gap: number;
  if (overId === activeId) {
    gap = rows.slice(0, rows.indexOf(active)).filter(r => candidates.includes(r)).length;
  } else {
    const overIndex = candidates.findIndex(r => r.step.id === overId);
    if (overIndex < 0) return null;
    gap = placement === 'before' ? overIndex : overIndex + 1;
  }

  const above = gap > 0 ? candidates[gap - 1] : undefined;
  const below = candidates[gap];
  const maxDepth = above === undefined ? 0 : above.depth + (acceptsFirstChild(above, rows) ? 1 : 0);
  const minDepth = below?.depth ?? 0;
  const wanted = active.depth + Math.round(offsetDepth);
  const depth = Math.max(minDepth, Math.min(maxDepth, wanted));

  let destination: MoveDestination;
  if (above === undefined) {
    destination = { parentPath: [], index: 0 };
  } else if (depth > above.depth) {
    destination = { parentPath: above.path, index: 0 };
  } else {
    // After the ancestor of `above` (or `above` itself) that sits at `depth`.
    const anchor = above.path.slice(0, depth + 1);
    destination = { parentPath: anchor.slice(0, -1), index: anchor[anchor.length - 1] + 1 };
  }

  const from = active.path;
  const fromIndex = from[from.length - 1];
  if (samePath(from.slice(0, -1), destination.parentPath)
    && (destination.index === fromIndex || destination.index === fromIndex + 1)) {
    return null;
  }

  return { ...destination, from, depth, blocker: moveBlocker(steps, from, destination.parentPath) };
}
