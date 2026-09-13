/**
 * Every string the app uses to say "someone is waiting on you", in one place.
 * BADGE hangs off a subject already on screen, so it stays lower case; TITLE
 * is a standalone OS notification, so it's capitalised — kept as two
 * registers on purpose, in one file, so a third can't quietly appear.
 */
import type { AwaitReason } from '../../../../packages/agent/src/protocol.ts';
import type { ManualRequest } from '../../../../packages/core/src/types.ts';

/** Badge register: what the run header and the step pill say. */
export const AWAIT_LABEL: Record<AwaitReason, string> = {
  turn: 'your turn',
  permission: 'needs permission',
  away: 'waiting for you',
  attention: 'wants attention',
};

/**
 * Notification register. `turn` is deliberately absent, and that absence is
 * load-bearing rather than an oversight: in an interactive session the model
 * finishing its turn is the normal resting state of a conversation, so
 * notifying on it would fire constantly. `away` is the runner's own judgement
 * that the human has been silent for about a minute, and that is the one worth
 * interrupting someone for.
 */
export const AWAIT_TITLE: Partial<Record<AwaitReason, string>> = {
  permission: 'Permission needed',
  away: 'Waiting for you',
  attention: 'Session needs attention',
};

/**
 * A parked manual step. One string for both surfaces here, because both are
 * headings with no subject beside them — the card's badge sits above the
 * question's own title, not after a run id.
 */
export function manualLabel(kind: ManualRequest['kind']): string {
  return kind === 'approval' ? 'Decision needed' : 'Your turn';
}
