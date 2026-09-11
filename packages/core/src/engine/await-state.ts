/**
 * The await-state file: how a live interactive session reports whether it is
 * working or blocked on the human.
 *
 * Written out-of-band by the runner's own hooks — never by the model, which is
 * deliberately not told this file exists. Read by any frontend that can watch
 * the filesystem; the CLI, which hands the child the real tty, ignores it.
 *
 * The content is JSON rather than a bare word so one of the writers can be
 * `cat` — claude's Notification hook dumps its raw payload here, and we map
 * `notification_type` ourselves rather than relying on hook matcher semantics.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeStepId } from './session-end.ts';

/**
 * Why a session is waiting. 'attention' never appears in the file — it is the
 * terminal-bell channel's reason, raised by the agent for runners that have no
 * hooks at all.
 */
export type AwaitReason = 'turn' | 'permission' | 'away' | 'attention';

const FILE_REASONS = new Set<string>(['turn', 'permission', 'away']);

/**
 * How claude's notification types map onto our reasons. Anything absent is
 * ignored rather than guessed at: `auth_success` and friends say nothing about
 * whether the human is needed.
 */
const NOTIFICATION_REASONS: Record<string, AwaitReason> = {
  idle_prompt: 'away',
  permission_prompt: 'permission',
  worker_permission_prompt: 'permission',
};

/** What a read of the file content means. */
export type AwaitParse =
  | { kind: 'state'; reason: AwaitReason }
  /** Says nothing — keep whatever we already believed. */
  | { kind: 'ignore' };

const IGNORE: AwaitParse = { kind: 'ignore' };

/** State-file basename for a step: one safe path segment, distinct from the `.done` marker. */
export function awaitStateName(stepId: string): string {
  return `.${sanitizeStepId(stepId)}.await`;
}

/** Absolute path of a step's await-state file. */
export function awaitStatePath(runDir: string, stepId: string): string {
  return join(runDir, awaitStateName(stepId));
}

/** True for any name awaitStateName could have produced — used to hide it from artifact lists. */
export function isAwaitStateName(name: string): boolean {
  return /^\..+\.await$/.test(name);
}

/**
 * Reads one state-file body.
 *
 * Everything unrecognized is `ignore`, never a cleared state: absence of the
 * file is what means "not waiting", and a half-written or unfamiliar body must
 * not be allowed to flap the UI. An empty body in particular is expected —
 * `printf x > path` truncates before it writes, so a poll can land mid-write.
 */
export function parseAwaitState(raw: string): AwaitParse {
  const text = raw.trim();
  if (text === '') return IGNORE;

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return IGNORE;
  }
  if (typeof body !== 'object' || body === null) return IGNORE;

  const { r, notification_type: type } = body as { r?: unknown; notification_type?: unknown };
  if (typeof r === 'string' && FILE_REASONS.has(r)) return { kind: 'state', reason: r as AwaitReason };
  if (typeof type === 'string' && type in NOTIFICATION_REASONS) {
    return { kind: 'state', reason: NOTIFICATION_REASONS[type] };
  }
  return IGNORE;
}

/**
 * Removes a leftover state file so a new session never opens already looking
 * blocked. Never throws, for the same reason clearEndMarker doesn't.
 */
export async function clearAwaitState(runDir: string, stepId: string): Promise<void> {
  try {
    await rm(awaitStatePath(runDir, stepId), { force: true });
  } catch {
    // best effort
  }
}
