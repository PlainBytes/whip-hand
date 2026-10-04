/**
 * The wire shape of a working diff, as whiphand-core's engine/diff.rs
 * produces it and protocol.gen.ts's getWorkingDiffResult names it. Declared
 * here so the diff view's own modules read it without the protocol types.
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
