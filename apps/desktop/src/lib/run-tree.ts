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

interface NodeCommon {
  /** The declared step id. Unique among its siblings, not across the tree. */
  id: string;
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
  // A loop's children are gathered by the id its body steps point at, so a
  // loop must be discoverable before its body is reached. Manifest order
  // already guarantees that, but a live job's event order need not.
  const loopIds = new Set(steps.filter(s => s.kind === 'loop').map(s => s.id));

  const build = (parent: string | undefined): StepNode[] => {
    const nodes: StepNode[] = [];
    // Folded steps are found by id so repeat executions land on the node that
    // already exists rather than appending a sibling.
    const leaves = new Map<string, LeafNode>();

    for (const step of steps) {
      if (owner(step, loopIds) !== parent) continue;
      if (step.kind === 'loop') {
        nodes.push({ kind: 'loop', id: step.id, ordinal: 0, loop: step, children: build(step.id) });
        continue;
      }
      const existing = leaves.get(step.id);
      if (existing === undefined) {
        const leaf: LeafNode = { kind: 'step', id: step.id, ordinal: 0, executions: [step], latest: step };
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

/**
 * Which list a step belongs in. A `loopId` naming a loop that isn't in this
 * run puts the step at the top level rather than nowhere: a truncated manifest
 * or a `loop:start` that never arrived should cost the step its indent, not
 * its place on the screen.
 */
function owner(step: StepState, loopIds: ReadonlySet<string>): string | undefined {
  if (step.loopId === undefined) return undefined;
  return loopIds.has(step.loopId) ? step.loopId : undefined;
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
