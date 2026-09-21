/**
 * Cuts the run's top level into the bands the stepper stacks: a `stages` step
 * takes a full-width band to itself, and the plain steps between two of them
 * share one track.
 *
 * Deliberately pure and free of React, like run-tree.ts: where the cuts fall
 * is the part worth testing, and the stepper should only have to lay out what
 * it is handed.
 */
import type { StagesNode, StepNode } from './run-tree.ts';

export type RunBand =
  | { kind: 'inline'; key: string; nodes: StepNode[] }
  | { kind: 'block'; key: string; node: StagesNode };

/**
 * A band's `key` is its first node's `key`, which is already unique across the
 * tree — so two inline bands never collide, and neither does a block.
 */
export function runBands(nodes: readonly StepNode[]): RunBand[] {
  const bands: RunBand[] = [];
  let inline: StepNode[] | undefined;
  for (const node of nodes) {
    if (node.kind === 'stages') {
      inline = undefined;
      bands.push({ kind: 'block', key: node.key, node });
      continue;
    }
    if (inline === undefined) {
      inline = [];
      bands.push({ kind: 'inline', key: node.key, nodes: inline });
    }
    inline.push(node);
  }
  return bands;
}
