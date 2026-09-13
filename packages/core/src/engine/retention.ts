/**
 * Manual deletion and automatic retention for runs under a workspace's
 * artifacts dir: both are `rm -rf` of a run directory, guarded by the same two rules — never touch a locked run, never touch one still running.
 */
import { rm } from 'node:fs/promises';
import type { WorkspaceConfig } from '../types.ts';
import { getRun, isSafeRunId, listRuns, HEARTBEAT_STALE_MS } from './manifest.ts';

export type DeleteRunReason = 'locked' | 'running' | 'missing';

export interface DeleteRunResult {
  deleted: boolean;
  reason?: DeleteRunReason;
}

/**
 * Deletes one run's directory outright. Returns a reason rather than
 * throwing on refusal — matching the `ok: false` posture cancelRun and
 * endSession already use — because a run that finished, or got locked, out
 * from under this call is a race, not a client error.
 */
export async function deleteRun(
  workdir: string, config: WorkspaceConfig, runId: string,
): Promise<DeleteRunResult> {
  if (!isSafeRunId(runId)) return { deleted: false, reason: 'missing' };
  const detail = await getRun(workdir, config, runId);
  if (!detail) return { deleted: false, reason: 'missing' };
  if (detail.locked) return { deleted: false, reason: 'locked' };
  if (detail.status === 'running') return { deleted: false, reason: 'running' };
  // No grace window for `status: 'unknown'` here, unlike pruneRuns: this is a
  // person clicking Delete on a row they can see, the reason comes back to
  // them either way, and a corrupt run directory is exactly what they would be
  // reaching for. Refusing it would strand the thing permanently.
  await rm(detail.runDir, { recursive: true, force: true });
  return { deleted: true };
}

export interface PruneRunsResult {
  deleted: string[];
}

/**
 * Drops locked runs from consideration entirely, then — if what remains
 * exceeds `max` — deletes oldest-first (by runId, which is timestamp-prefixed)
 * until the count is back at `max`, skipping any run still `running` and
 * moving on to the next-oldest rather than stopping. `null` or `0` mean
 * "keep everything" and are a no-op.
 *
 * A just-created run is also skipped. This runs at the end of every run, so
 * one finishing while another is starting is the ordinary case, not a corner
 * one — and a run directory reads back as `status: 'unknown'` for the handful
 * of filesystem operations before its first manifest write (unbounded on a
 * network share or behind an AV filter driver). Deleting a live run's
 * directory is silent and irreversible, so 'unknown' only becomes prunable
 * once the directory is stale by heartbeat standards, at which point it really
 * is what 'unknown' otherwise means: a crash, or a corrupt run.json.
 *
 * `deleteRun` deliberately does not do this — see there.
 */
export async function pruneRuns(
  workdir: string, config: WorkspaceConfig, max: number | null,
): Promise<PruneRunsResult> {
  const deleted: string[] = [];
  if (max === null || max <= 0) return { deleted };

  const runs = await listRuns(workdir, config);
  const eligible = runs.filter(r => !r.locked);
  let excess = eligible.length - max;
  if (excess <= 0) return { deleted };

  // listRuns sorts newest-first, so walking from the end goes oldest-first.
  const staleBefore = Date.now() - HEARTBEAT_STALE_MS;
  for (let i = eligible.length - 1; i >= 0 && excess > 0; i--) {
    const run = eligible[i];
    if (run.status === 'running') continue;
    if (run.status === 'unknown' && run.mtimeMs > staleBefore) continue;
    await rm(run.runDir, { recursive: true, force: true });
    deleted.push(run.runId);
    excess -= 1;
  }
  return { deleted };
}
