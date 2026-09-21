import { executionKey, type StepState } from '../state/store.ts';

/** A `StepState` from just the fields a test cares about, keyed the way the store keys it. */
export function step(partial: Partial<StepState> & { id: string }): StepState {
  return {
    key: executionKey(partial.id, partial.iteration, partial.outerLoops, partial.stage),
    status: 'pending',
    ...partial,
  } as StepState;
}
