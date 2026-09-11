/**
 * The lock marker: how a run is exempted from deletion and retention pruning.
 *
 * A marker file rather than a field in run.json — RunJournal holds the
 * manifest in memory and rewrites the whole file on every event, so locking a
 * *running* run would be silently clobbered by the next event unless the
 * journal were taught to re-read or carry the flag. A marker file is atomic,
 * needs no manifest schema change, and survives copying the run directory.
 * Mirrors session-end.ts's marker-file approach.
 */
import { access, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LOCK_MARKER_NAME = '.locked';

/** Absolute path of a run's lock marker. */
export function lockPath(runDir: string): string {
  return join(runDir, LOCK_MARKER_NAME);
}

export async function isRunLocked(runDir: string): Promise<boolean> {
  try {
    await access(lockPath(runDir));
    return true;
  } catch {
    return false;
  }
}

/** Sets or clears the lock marker. Idempotent either way. */
export async function setRunLocked(runDir: string, locked: boolean): Promise<void> {
  if (locked) {
    await writeFile(lockPath(runDir), '', 'utf8');
  } else {
    await rm(lockPath(runDir), { force: true });
  }
}
