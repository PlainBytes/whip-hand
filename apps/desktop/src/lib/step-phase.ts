/**
 * "This step is writing its artifact right now."
 *
 * The engine runs an interactive step in two phases: the session the human
 * talks to (`main`), and then a headless pass that reads that conversation
 * back and writes the step's artifact (`harvest`, emitted as a `step:spawn`
 * in packages/core/src/engine/runner.ts). Between the two the pty is gone but
 * the step is still very much working, and that window used to be described
 * only inside the terminal's own scrollback.
 *
 * Deliberately narrow: `harvest` is the engine's *only* artifact-generating
 * phase. A headless step writes its artifact through its own Write tool while
 * it works and a command step captures stdout as it goes — neither has a
 * moment to point at, and inventing one would report a guess as a fact.
 */
import type { StepState } from '../state/store.ts';

/**
 * Singular because a step declares exactly one `output`. Shared so the pill,
 * its aria-label and its popover cannot drift into three wordings for one
 * state, the way the awaiting copy did.
 *
 * Deliberately *not* repeated in the Terminal tab. That tab carries output;
 * what phase a step is in is a fact about the step, so it is said once, on the
 * step's own pill.
 */
export const GENERATING_ARTIFACT_LABEL = 'generating artifact';

export function isGeneratingArtifact(step: StepState): boolean {
  return step.status === 'running' && step.phase === 'harvest';
}
