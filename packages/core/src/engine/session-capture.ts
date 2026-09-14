/**
 * The session-capture file: how a `sessionIdCapture` runner (opencode) tells
 * whiphand the id of the session it minted on its own — the counterpart to
 * `sessionIdInjection`, where whiphand mints the id itself instead. Written
 * out-of-band (by opencode's plugin, not by the model), read once the
 * interactive spawn has exited.
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeStepId } from './session-end.ts';

/** State-file basename for a step: one safe path segment, distinct from `.done` and `.await`. */
export function sessionCaptureName(stepId: string): string {
  return `.${sanitizeStepId(stepId)}.session`;
}

/** Absolute path of a step's session-capture file. */
export function sessionCapturePath(runDir: string, stepId: string): string {
  return join(runDir, sessionCaptureName(stepId));
}

/** True for any name sessionCaptureName could have produced — used to hide it from artifact lists. */
export function isSessionCaptureName(name: string): boolean {
  return /^\..+\.session$/.test(name);
}

/**
 * Removes a leftover capture file so a re-run never mistakes a previous
 * attempt's session for this one's. Never throws, for the same reason
 * clearEndMarker doesn't.
 */
export async function clearSessionCapture(runDir: string, stepId: string): Promise<void> {
  try {
    await rm(sessionCapturePath(runDir, stepId), { force: true });
  } catch {
    // best effort
  }
}

/** The captured session id, or undefined when the file is missing, unreadable, or blank. */
export async function readSessionCapture(runDir: string, stepId: string): Promise<string | undefined> {
  try {
    const text = (await readFile(sessionCapturePath(runDir, stepId), 'utf8')).trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}
