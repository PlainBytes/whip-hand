/**
 * Folds the run's flat execution list into the shape the stepper draws.
 *
 * The manifest records one entry per *execution*, so a loop that ran three
 * times contributes three `execute` entries and three `review` entries — a
 * flat row that grows without bound as a run churns. Here that becomes a tree:
 * a loop owns its body, and a body step appears once no matter how many times
 * it ran, carrying its executions with it.
 *
 * Deliberately pure and free of React: the arithmetic is the part worth
 * testing, and the stepper should only have to render what it is handed.
 */
import type { StepState } from '../state/store.ts';
import type { LoopRef } from '../../../../packages/core/src/types.ts';

interface NodeCommon {
  /** The declared step id. Unique among its siblings, not across the tree. */
  id: string;
  /**
   * Identifies this node uniquely across the *whole* tree, unlike `id`: a
   * loop row's own execution key for a LoopNode, the first folded
   * execution's key for a LeafNode. Once an outer loop reruns an inner one,
   * two rounds sit side by side sharing a bare id but never a key — this is
   * what a React `key`, a focus/ref lookup, or a testid suffix must use
   * instead. Byte-identical to `id` wherever there is at most one round to
   * disambiguate, so every single-level fixture is unaffected.
   */
  key: string;
  /** 1-based position in a depth-first walk of the whole run. */
  ordinal: number;
}

export interface LeafNode extends NodeCommon {
  kind: 'step';
  /** Every execution of this step under this parent, oldest first. */
  executions: StepState[];
  /** The newest execution — the one whose status and timings the pill shows. */
  latest: StepState;
}

export interface LoopNode extends NodeCommon {
  kind: 'loop';
  /** The loop's own entry: its status, iteration count and timings. */
  loop: StepState;
  children: StepNode[];
}

export type StepNode = LeafNode | LoopNode;

export function buildRunTree(steps: StepState[]): StepNode[] {
  // Once loops nest, the same bare loop id can own several *rounds* — round 2
  // of an outer loop reruns the inner loop from scratch, as its own separate
  // node next to round 1's, not merged into it (see LoopNode: one `loop` row,
  // not an array like LeafNode.executions). So a step's parent is a specific
  // loop *row*, not just an id: `belongsTo` matches on the full loop chain a
  // row's `outerLoops` records, exactly as the manifest identifies it.
  const loopRows = steps.filter(s => s.kind === 'loop');
  const loopIds = new Set(loopRows.map(s => s.id));

  const build = (parent: StepState | undefined): StepNode[] => {
    const nodes: StepNode[] = [];
    // Folded steps are found by id so repeat executions land on the node that
    // already exists rather than appending a sibling.
    const leaves = new Map<string, LeafNode>();

    for (const step of steps) {
      if (!belongsTo(step, parent, loopIds, loopRows)) continue;
      if (step.kind === 'loop') {
        nodes.push({ kind: 'loop', id: step.id, key: step.key, ordinal: 0, loop: step, children: build(step) });
        continue;
      }
      const existing = leaves.get(step.id);
      if (existing === undefined) {
        const leaf: LeafNode = { kind: 'step', id: step.id, key: step.key, ordinal: 0, executions: [step], latest: step };
        leaves.set(step.id, leaf);
        nodes.push(leaf);
        continue;
      }
      existing.executions.push(step);
      existing.latest = step;
    }
    return nodes;
  };

  return number(build(undefined));
}

/** Order-sensitive equality for a row's `outerLoops`, treating absent as empty. */
function sameLoopRefs(a: readonly LoopRef[], b: readonly LoopRef[]): boolean {
  return a.length === b.length && a.every((r, i) => r.id === b[i].id && r.iteration === b[i].iteration);
}

/** The `outerLoops` a body of `node`'s own loop would carry: its `(id, iteration)`, prepended onto whatever is beyond it. */
function loopContextOf(node: StepState): LoopRef[] {
  return node.loopId === undefined ? [] : [...(node.outerLoops ?? []), { id: node.loopId, iteration: node.iteration ?? 1 }];
}

/**
 * Whether `step` sits directly inside loop row `parent` (`undefined` for the
 * top level). A `loopId` naming a loop that isn't in this run at all puts the
 * step at the top level rather than nowhere: a truncated manifest or a
 * `loop:start` that never arrived should cost the step its indent, not its
 * place on the screen — the one fallback kept from the single-level version.
 * Once the id *is* known, which specific round owns a row is decided by the
 * full chain, not just the bare id, so round 2 never inherits round 1's rows.
 *
 * A step that never ran at all (disabled, or simply not reached yet) never
 * had a chance to record its own `outerLoops` — nothing seeds it, since a
 * round's identity depends on iteration numbers the plan cannot know before
 * the workflow runs (see manifest.ts's `beginStep`). That is unambiguous
 * exactly when the parent's bare id names only one loop row in the whole
 * run: once a loop genuinely completes more than one round, every row that
 * exists for it went through a real `step:start` and so has a real
 * `outerLoops` to match structurally instead.
 */
function belongsTo(
  step: StepState, parent: StepState | undefined, loopIds: ReadonlySet<string>, loopRows: readonly StepState[],
): boolean {
  if (parent === undefined) {
    return step.loopId === undefined || !loopIds.has(step.loopId);
  }
  if (step.loopId !== parent.id) return false;
  if (sameLoopRefs(step.outerLoops ?? [], loopContextOf(parent))) return true;
  return step.outerLoops === undefined && loopRows.filter(l => l.id === parent.id).length === 1;
}

/**
 * Numbers the tree depth-first, in place. A pill's ordinal is its place in the
 * run, so a loop's body continues the count rather than restarting at 1 — and
 * because nodes are folded, the count no longer shifts as iterations pass.
 */
function number(nodes: StepNode[]): StepNode[] {
  let next = 1;
  const walk = (list: StepNode[]): void => {
    for (const node of list) {
      node.ordinal = next++;
      if (node.kind === 'loop') walk(node.children);
    }
  };
  walk(nodes);
  return nodes;
}

/**
 * The tree as one depth-first list. Collapsing counts nodes, not executions —
 * "step 3 of 5" has to mean the same thing whether or not a loop has churned.
 */
export function flattenNodes(nodes: StepNode[]): StepNode[] {
  const out: StepNode[] = [];
  const walk = (list: StepNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.kind === 'loop') walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
