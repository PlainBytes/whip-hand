/**
 * The end-of-session marker: how an interactive step says "we're done here".
 * A frontend watching the filesystem closes the session once the model
 * creates this file, per guidance seeded into every interactive session.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSegment } from '../segment.ts';

/**
 * The shape every per-step file in a run dir shares: `.<step>.<suffix>`,
 * sitting directly in the run dir. The end marker, the await-state file, the
 * session-capture file and opencode's support files all need the same four
 * things — the name, the path, a "could this be one?" check to hide it from
 * artifact lists, and a best-effort clear before a new session — and every
 * copy of that quartet was a chance for one of them to forget the segment
 * check or drift its hiding pattern away from the names it actually produces.
 */
export interface StepStateFile {
  /** Basename for a step: one path segment. */
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
  // Step ids are validated segments (schema.ts), so the id goes in verbatim and
  // no two steps can share a state file. Asserted rather than trusted: a Workflow
  // built in code never passed through the parser.
  const name = (stepId: string): string => {
    assertSegment(stepId, 'step id');
    return `.${stepId}.${suffix}`;
  };
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

/** Marker basename for a step: one path segment. */
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
