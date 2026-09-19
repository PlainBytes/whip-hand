/**
 * Capabilities a run lost while carrying on (invariant 7), as the desktop holds
 * them: folded from live `run:degraded` events into JobState, and read back from
 * a run's `degradations[]` in its manifest. Both fold through `addDegradation`,
 * de-duplicated on (capability, stepId) exactly as core's RunJournal does.
 */
export interface RunDegradation {
  capability: string;
  reason: string;
  stepId?: string;
  at: string;
}

/** Appends `d` unless its (capability, stepId) is already there, in which case the list itself comes back. */
export function addDegradation(list: readonly RunDegradation[] | undefined, d: RunDegradation): readonly RunDegradation[] {
  const seen = list ?? [];
  if (seen.some(s => s.capability === d.capability && s.stepId === d.stepId)) return seen;
  return [...seen, d];
}

function isDegradation(value: unknown): value is RunDegradation {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.capability === 'string' && typeof v.reason === 'string' && typeof v.at === 'string'
    && (v.stepId === undefined || typeof v.stepId === 'string');
}

/**
 * The manifest's list (an `unknown` off the wire: getRun's schema is loose)
 * folded with what the live job has seen. The manifest comes first, so a run
 * this window watched from the start reports each loss once.
 */
export function mergeDegradations(persisted: unknown, live: readonly RunDegradation[] | undefined): readonly RunDegradation[] {
  let merged: readonly RunDegradation[] = [];
  if (Array.isArray(persisted)) {
    for (const d of persisted) if (isDegradation(d)) merged = addDegradation(merged, d);
  }
  for (const d of live ?? []) merged = addDegradation(merged, d);
  return merged;
}
