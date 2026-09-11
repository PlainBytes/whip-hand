/**
 * The wire shape of a working diff, mirroring packages/core/src/engine/diff.ts.
 *
 * Declared here rather than imported from core so the diff view stays a
 * frontend module with no build-time dependency on the engine — the same
 * posture files/fs-port.ts takes. The agent's zod schema
 * (packages/agent/src/protocol.ts, getWorkingDiffResult) is what actually
 * validates it at the boundary.
 */

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFileEntry {
  path: string;
  oldPath?: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Absent when binary, or dropped by one of core's size caps. */
  patch?: string;
  /** The patch was dropped for size — not "there is no patch". */
  truncated?: boolean;
}

export interface WorkingDiff {
  files: DiffFileEntry[];
  filesTruncated?: number;
  patchesOmitted?: number;
}
