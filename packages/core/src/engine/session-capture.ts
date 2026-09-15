/**
 * The session-capture file: how a `sessionIdCapture` runner (opencode) tells
 * whiphand the id of the session it minted on its own — the counterpart to
 * `sessionIdInjection`, where whiphand mints the id itself instead. Written
 * out-of-band (by opencode's plugin, not by the model), read once the
 * interactive spawn has exited.
 */
import { readFile } from 'node:fs/promises';
import { stepStateFile } from './session-end.ts';

const sessionCapture = stepStateFile('session');

/** State-file basename for a step: one safe path segment, distinct from `.done` and `.await`. */
export const sessionCaptureName: (stepId: string) => string = sessionCapture.name;

/** Absolute path of a step's session-capture file. */
export const sessionCapturePath: (runDir: string, stepId: string) => string = sessionCapture.path;

/** True for any name sessionCaptureName could have produced — used to hide it from artifact lists. */
export const isSessionCaptureName: (name: string) => boolean = sessionCapture.isName;

/**
 * Removes a leftover capture file so a re-run never mistakes a previous
 * attempt's session for this one's. Never throws, for the same reason
 * clearEndMarker doesn't.
 */
export const clearSessionCapture: (runDir: string, stepId: string) => Promise<void> = sessionCapture.clear;

/** The captured session id, or undefined when the file is missing, unreadable, or blank. */
export async function readSessionCapture(runDir: string, stepId: string): Promise<string | undefined> {
  try {
    const text = (await readFile(sessionCapturePath(runDir, stepId), 'utf8')).trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}
