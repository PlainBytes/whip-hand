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

/**
 * The shape every per-step file in a run dir shares: `.<step>.<suffix>`,
 * sitting directly in the run dir. The end marker, the await-state file, the
 * session-capture file and opencode's support files all need the same four
 * things — the name, the path, a "could this be one?" check to hide it from
 * artifact lists, and a best-effort clear before a new session — and every
 * copy of that quartet was a chance for one of them to forget sanitizeStepId
 * or drift its hiding pattern away from the names it actually produces.
 */
export interface StepStateFile {
  /** Basename for a step: one safe path segment. */
  name(stepId: string): string;
  /** Absolute path of the step's file, directly in the run dir. */
  path(runDir: string, stepId: string): string;
  /** True for any name `name` could have produced. */
  isName(name: string): boolean;
  /**
   * Removes a leftover file. Never throws: a file we cannot delete is not a
   * reason to fail the run, and every caller's worst case is one session that
   * starts with stale state.
   */
  clear(runDir: string, stepId: string): Promise<void>;
}

/** Builds the StepStateFile for `.<step>.<suffix>`; `suffix` is literal (dots included), never a pattern. */
export function stepStateFile(suffix: string): StepStateFile {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\..+\\.${escaped}$`);
  const name = (stepId: string): string => `.${sanitizeStepId(stepId)}.${suffix}`;
  const path = (runDir: string, stepId: string): string => join(runDir, name(stepId));
  return {
    name,
    path,
    isName: candidate => pattern.test(candidate),
    clear: async (runDir, stepId) => {
      try {
        await rm(path(runDir, stepId), { force: true });
      } catch {
        // best effort
      }
    },
  };
}

const endMarker = stepStateFile('done');

/** Marker basename for a step: one safe path segment. */
export const endMarkerName: (stepId: string) => string = endMarker.name;

/** Absolute path of a step's marker: its appearance means the human agreed we're done. */
export const endMarkerPath: (runDir: string, stepId: string) => string = endMarker.path;

/** True for any name endMarkerName could have produced — used to hide markers from artifact lists. */
export const isEndMarkerName: (name: string) => boolean = endMarker.isName;

/**
 * Removes a leftover marker so a re-run never starts with a session that is
 * already "finished". Never throws: a marker we cannot delete is not a reason
 * to fail the run, and the worst case is one session that closes immediately.
 */
export const clearEndMarker: (runDir: string, stepId: string) => Promise<void> = endMarker.clear;
