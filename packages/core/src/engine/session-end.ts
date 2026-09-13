/**
 * The end-of-session marker: how an interactive step says "we're done here".
 * A frontend watching the filesystem closes the session once the model
 * creates this file, per guidance seeded into every interactive session.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Flattens a step id to a single path segment that needs no shell quoting.
 * Step ids are only `.min(1)` in the schema, and the names built from them end
 * up inside shell commands in a runner's settings, so this is the guarantee
 * every one of those names rests on. Shared with await-state.ts so the two
 * cannot drift.
 */
export function sanitizeStepId(stepId: string): string {
  return stepId.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * A path as a *runner* will read it, for the strings we hand one to parse: the
 * `touch <marker>` in a session's guidance, the permission rule that
 * pre-approves it, and the hook commands that write the await-state file.
 *
 * Windows accepts `/` in every API that takes a path, so this names the same
 * file — but a native `D:\w\.whiphand\runs\r1\.plan.done` does not survive being
 * pasted into a command line: Claude runs hook commands and Bash tool calls
 * through Git Bash on Windows, where `\` escapes rather than separates, and
 * our own SHELL_SAFE_PATH guard rejects a backslash outright.
 *
 * Only for strings a runner parses. Paths that go to `fs` stay native.
 */
export function shellPath(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Marker basename for a step: one safe path segment. */
export function endMarkerName(stepId: string): string {
  return `.${sanitizeStepId(stepId)}.done`;
}

/** Absolute path of a step's marker: its appearance means the human agreed we're done. */
export function endMarkerPath(runDir: string, stepId: string): string {
  return join(runDir, endMarkerName(stepId));
}

/** True for any name endMarkerName could have produced — used to hide markers from artifact lists. */
export function isEndMarkerName(name: string): boolean {
  return /^\..+\.done$/.test(name);
}

/**
 * Removes a leftover marker so a re-run never starts with a session that is
 * already "finished". Never throws: a marker we cannot delete is not a reason
 * to fail the run, and the worst case is one session that closes immediately.
 */
export async function clearEndMarker(runDir: string, stepId: string): Promise<void> {
  try {
    await rm(endMarkerPath(runDir, stepId), { force: true });
  } catch {
  }
}
