/**
 * Every string the app uses to say "someone is waiting on you", in one place.
 *
 * These lived in three separate tables in three files — the run header's badge
 * labels, a prose set above the terminal, and the notification titles — and
 * had already drifted: `permission` was "needs permission", "The session is
 * asking for permission — answer it in the terminal below." and "Permission
 * needed" depending on which surface you were looking at.
 *
 * Two registers survive, and they are two on purpose:
 *
 *   BADGE  hangs off a subject already on screen ("Run r-42  needs permission"),
 *          so it reads as a predicate and stays lower case.
 *   TITLE  is an OS notification with no subject beside it, so it has to stand
 *          on its own and is capitalised.
 *
 * Rewriting one to match the other would make the other read wrong; keeping
 * them in one file is what stops a third from appearing.
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
