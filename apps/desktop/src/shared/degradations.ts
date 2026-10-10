/**
 * The closed set of things whiphand can lose without stopping (invariant 7),
 * as whiphand-core's degradations.rs has it: a capability that degraded is
 * recorded in the run manifest, and the run views show a line for it.
 * Safety-relevant losses (the git write-guard on a `writes: false` step, say)
 * do not appear here as warnings; they fail the step.
 *
 * The same ids are the vocabulary doctor uses for machine-level facts.
 */
export const DEGRADATION_IDS = [
  /** The workspace is not a git repository, so the read-only tree assertion is off. */
  'git-guard',
  /** The step diff could not be produced. */
  'diff',
  /** The runner reports no await-state (a per-runner gap, not a per-OS one). */
  'await-state',
  /** The runner's hooks were dropped. */
  'hooks',
  /** Pruning an old run directory failed; the run itself is unaffected. */
  'retention',
  /** Workspace canonicalization failed; identity fell back to the lexical form. */
  'workspace-identity',
  /** No process guard in a non-packaged run: grandchildren may outlive a crash. */
  'process-containment',
  /** The tree could not be snapshotted as the run stopped, so a resume cannot diff against it. */
  'stopped-tree',
  /** doctor: no POSIX shell was found, so command steps refuse to run. */
  'posix-shell',
  /** doctor: `git` is a `.cmd` wrapper. */
  'git-wrapper',
  /** doctor: git refuses the workspace repository (dubious ownership). */
  'git-ownership',
  /** doctor: the remote token file's mode cannot be enforced on this OS. */
  'token-file-mode',
  /** doctor: the workspace path leaves too little headroom under the 260-character limit. */
  'long-path',
  /** run: the worktree could not start from the base's synced upstream. */
  'worktree-sync',
] as const;

export type DegradationId = (typeof DEGRADATION_IDS)[number];

export const DEGRADATION_LABELS: Record<DegradationId, string> = {
  'git-guard': 'Read-only tree guard off (not a git repository)',
  diff: 'Step diff unavailable',
  'await-state': 'Await-state unavailable for this runner',
  hooks: 'Runner hooks dropped',
  retention: 'Old run directories could not be pruned',
  'workspace-identity': 'Workspace identity not canonicalized',
  'process-containment': 'Process containment unavailable',
  'stopped-tree': 'Stopped-tree snapshot unavailable',
  'posix-shell': 'No POSIX shell found',
  'git-wrapper': 'git is a .cmd wrapper',
  'git-ownership': 'git refuses this repository (dubious ownership)',
  'token-file-mode': 'Remote token file mode is not enforceable',
  'long-path': 'Workspace path leaves little headroom under 260 characters',
  'worktree-sync': 'Worktree started from the local base, not its upstream',
};

export function isDegradationId(value: string): value is DegradationId {
  return (DEGRADATION_IDS as readonly string[]).includes(value);
}

/** One rendered line: `<label> — <reason>`, with the step when it is step-scoped. */
export function degradationLine(d: { capability: string; reason: string; stepId?: string }): string {
  const label = isDegradationId(d.capability) ? DEGRADATION_LABELS[d.capability] : d.capability;
  return `${label}${d.stepId === undefined ? '' : ` [${d.stepId}]`} — ${d.reason}`;
}
