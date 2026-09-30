/**
 * The fence marker: a reader's verdict that a run's lease is over.
 *
 * A reader that finds a stale lease repairs the run to 'interrupted' — but
 * the owner may only have been suspended, and its journal writes run.json
 * blind: a heartbeat that checked the status just before the repair lands
 * `running` right on top of it. Nothing in a plain file makes "check, then
 * write" atomic across processes, so the verdict does not live in run.json.
 * The repair writes this marker first, naming the lease it ended; from then
 * on every reader treats a run.json carrying that lease as repaired, whatever
 * it says, and the owner stops once its next heartbeat finds the marker.
 *
 * Keyed to the lease rather than the run: a resume takes a fresh lease in the
 * same run dir, and a marker left by the earlier repair — or written late by a
 * reader that judged the old lease — must not fence the resumed owner.
 * Mirrors run-lock.ts's marker-file approach.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../durable-fs.ts';

export const FENCE_MARKER_NAME = '.fenced';

export interface RunFence {
  /** The `leaseId` of the manifest the repair ended. */
  leaseId: string;
  /** Why it was ended, as recorded in `interruptedReason`. */
  reason: 'lease-expired' | 'owner-exited';
}

/** Absolute path of a run's fence marker. */
export function fencePath(runDir: string): string {
  return join(runDir, FENCE_MARKER_NAME);
}

export async function writeFence(runDir: string, fence: RunFence): Promise<void> {
  await writeFileAtomic(fencePath(runDir), JSON.stringify(fence));
}

/** The fence on disk, or undefined when there is none or it cannot be read. */
export async function readFence(runDir: string): Promise<RunFence | undefined> {
  try {
    const parsed = JSON.parse(await readFile(fencePath(runDir), 'utf8')) as Partial<RunFence>;
    if (typeof parsed.leaseId !== 'string') return undefined;
    const reason = parsed.reason === 'owner-exited' ? 'owner-exited' : 'lease-expired';
    return { leaseId: parsed.leaseId, reason };
  } catch {
    return undefined;
  }
}
