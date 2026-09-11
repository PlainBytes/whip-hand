import { randomUUID } from 'node:crypto';
import type { FileComment, ManualChoice, ManualRequest, ManualResponse } from '@whiphand/core';
import type { JobStatus } from './protocol.ts';
import type { PtyHandle } from './pty.ts';

const DEFAULT_PTY_COLS = 80;
const DEFAULT_PTY_ROWS = 24;

export interface Job {
  jobId: string;
  workdir: string;
  runId?: string;
  status: JobStatus;
  controller: AbortController;
  promise: Promise<unknown>;
  /** The job's one live interactive PTY, if a step is currently running one. */
  pty?: PtyHandle;
  /**
   * Closes the job's live interactive session gracefully. Present exactly while
   * `pty` is, and only for specs that carry an endSession. Idempotent.
   */
  endSession?: (reason: 'marker' | 'user') => void;
  /**
   * Clears the terminal-bell attention latch — the human is evidently here.
   * Present exactly while `pty` is.
   */
  clearBell?: () => void;
  /**
   * The manual/approval step this job is parked on, if any. The run is
   * suspended inside core's runManual until `answer` or `reject` is called —
   * so cancelRun MUST reject it, or the job hangs forever with a live run.json.
   */
  pendingManual?: PendingManual;
  /** Sticky across the job's interactive steps; updated by ptyResize. */
  ptyCols: number;
  ptyRows: number;
}

export interface PendingManual {
  request: ManualRequest;
  answer: (response: ManualResponse) => void;
  reject: (reason: Error) => void;
}

/**
 * Answers whatever the job is parked on, if the step still matches. Returns
 * false when there is nothing waiting or the card is stale — a race, not an
 * error. Clearing `pendingManual` before resolving keeps a double answer from
 * settling the same promise twice.
 */
export function answerManual(
  job: Job, stepId: string, choice: ManualChoice, note?: string, comments?: FileComment[],
): boolean {
  const pending = job.pendingManual;
  if (!pending || pending.request.stepId !== stepId) return false;
  job.pendingManual = undefined;
  pending.answer({
    choice, ...(note === undefined ? {} : { note }), ...(comments === undefined ? {} : { comments }),
  });
  return true;
}

/** Tears down a parked question so an aborted run does not wait on a human forever. */
export function abandonManual(job: Job, reason: string): void {
  const pending = job.pendingManual;
  if (!pending) return;
  job.pendingManual = undefined;
  pending.reject(new Error(reason));
}

/** Tracks in-flight (and completed) background runs by jobId. */
export class JobManager {
  #jobs = new Map<string, Job>();

  /**
   * Registers a new job synchronously (before any async work has happened)
   * so its jobId can be returned to the caller immediately. The caller
   * assigns `job.promise` once the background work has started.
   */
  create(workdir: string): Job {
    const job: Job = {
      jobId: randomUUID(),
      workdir,
      status: 'running',
      controller: new AbortController(),
      promise: Promise.resolve(),
      ptyCols: DEFAULT_PTY_COLS,
      ptyRows: DEFAULT_PTY_ROWS,
    };
    this.#jobs.set(job.jobId, job);
    return job;
  }

  get(jobId: string): Job | undefined {
    return this.#jobs.get(jobId);
  }

  /** Every job this process has registered, in creation order. */
  list(): Job[] {
    return [...this.#jobs.values()];
  }
}
