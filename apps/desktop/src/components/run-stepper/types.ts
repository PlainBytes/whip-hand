import type { StepState } from '../../state/store.ts';
import type { StepNode } from '../../lib/run-tree.ts';

/**
 * What the stepper needs to know about a session waiting on the human. Comes
 * from the live job; the label is the caller's to pass, and every caller takes
 * it from AWAIT_LABEL in lib/await-copy.ts — the header shows the same wording
 * beside the run, and the two drifted when each owned its own table.
 */
export interface StepAwaiting {
  stepId?: string;
  label: string;
}

export interface NodeProps {
  node: StepNode;
  /** The resolved execution identity a bare `focusStepId` names — see `resolveKey`. */
  focusKey?: string;
  /** The resolved execution identity a bare `awaiting.stepId` names — see `resolveKey`. */
  awaitingKey?: string;
  awaiting?: StepAwaiting;
  clock: number;
  nodeRef?: (key: string, el: HTMLElement | null) => void;
}
