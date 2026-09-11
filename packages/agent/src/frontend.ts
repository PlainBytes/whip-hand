/**
 * Frontend factory for @whiphand/core's runWorkflow: turns WhiphandEvents into `whiphandEvent`
 * notifications and runs interactive steps in a PTY, streaming ptyStarted/
 * ptyData/ptyExit notifications and resolving with the session's exit code.
 */
import type {
  AwaitReason, Frontend, ManualRequest, ManualResponse, WhiphandEvent, SpawnSpec,
} from '@whiphand/core';
import type { Job } from './jobs.ts';
import { abandonManual } from './jobs.ts';
import { startPty } from './pty.ts';
import { beginGracefulEnd, watchForMarker } from './session-end.ts';
import { watchAwaitState } from './await-state.ts';

export type NotifyFn = (method: string, params: unknown) => void;

/** Overridable only so tests need not wait out the real graces. */
export interface FrontendTimings {
  markerPollMs?: number;
  awaitPollMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
}

/** What the human sees in the terminal when whiphand closes the session for them. */
const CLOSING_BANNER =
  '\r\n\x1b[2m[whiphand] step complete \u2014 closing this session\u2026\x1b[0m\r\n';

/** Mutable box so callers (e.g. cancelRun) can read the run's id once known. */
export interface RunIdBox {
  current?: string;
}

/**
 * `job` is the live Job record (from JobManager): its `pty` field is used to
 * enforce one live PTY per job (steps run sequentially, so a second
 * concurrent runInteractive call is a bug, not a race to arbitrate) and to
 * let the ptyInput/ptyResize rpc handlers reach the job's current PTY.
 */
export function createFrontend(
  job: Job, notify: NotifyFn, runIdBox: RunIdBox, timings: FrontendTimings = {},
): Frontend {
  const jobId = job.jobId;
  // The engine's on_findings 'interactive' triage branch calls runInteractive
  // directly, without a preceding step:start — fall back to a sensible id
  // rather than crash when that happens.
  let lastStepId: string | undefined;

  return {
    onEvent(event: WhiphandEvent): void {
      // A resumed run emits run:resume in place of run:start. Without it here
      // every notification for a resumed run goes out with runId undefined and
      // the desktop cannot tell which run they belong to.
      if (event.type === 'run:start' || event.type === 'run:resume') runIdBox.current = event.runId;
      if (event.type === 'step:start') lastStepId = event.stepId;
      notify('whiphandEvent', {
        jobId, workdir: job.workdir, runId: runIdBox.current, event, ts: new Date().toISOString(),
      });
      if (event.type === 'run:start' || event.type === 'run:resume') {
        notify('runStateChanged', {
          jobId, workdir: job.workdir, runId: runIdBox.current, status: 'running',
        });
      }
    },

    /**
     * Parks the run on the job and hands the question to the UI. Nothing here
     * times out: a human gate waits as long as the human does. Cancellation is
     * the only other way out, and it comes through the abort listener below.
     */
    runManual(request: ManualRequest, signal?: AbortSignal): Promise<ManualResponse> {
      if (job.pendingManual) {
        return Promise.reject(
          new Error(`job '${jobId}' is already waiting on step '${job.pendingManual.request.stepId}'`));
      }
      if (signal?.aborted) return Promise.reject(new Error('run cancelled'));

      return new Promise<ManualResponse>((resolvePromise, reject) => {
        const onAbort = (): void => abandonManual(job, 'run cancelled');
        const settle = (fn: () => void) => {
          signal?.removeEventListener('abort', onAbort);
          fn();
        };
        job.pendingManual = {
          request,
          answer: response => settle(() => {
            notify('manualResolved', { jobId, stepId: request.stepId, choice: response.choice });
            resolvePromise(response);
          }),
          reject: reason => settle(() => {
            notify('manualResolved', { jobId, stepId: request.stepId });
            reject(reason);
          }),
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        notify('manualRequest', { jobId, runId: runIdBox.current, request });
      });
    },

    runInteractive(spec: SpawnSpec, signal?: AbortSignal): Promise<number> {
      if (job.pty) {
        return Promise.reject(
          new Error(`job '${jobId}' already has a live PTY (only one interactive step runs at a time)`));
      }
      const stepId = lastStepId ?? 'triage';
      const cols = job.ptyCols;
      const rows = job.ptyRows;

      return new Promise((resolvePromise, reject) => {
        // Latched: whichever of the marker, the user, or a second call gets here
        // first owns the shutdown, and the rest are no-ops.
        let ending: 'marker' | 'user' | undefined;
        let watcher: { stop(): void } | undefined;
        let cancelEnd: (() => void) | undefined;
        // A process that dies the instant it starts can exit before the
        // registration below runs; without this it would leave job.pty pinned to
        // a dead handle and a watcher polling for a marker nobody will write.
        let exited = false;

        // Two channels report whether the session is blocked on the human: the
        // runner's own hooks (precise, via the await-state file) and a terminal
        // bell (blunt, but works for runners that have no hooks). Hooks always
        // win — a bell must never downgrade a state we actually know.
        let hookState: AwaitReason | undefined;
        let bell = false;
        let reportedAwait: AwaitReason | undefined;
        let started = false;
        let awaitWatcher: { stop(): void } | undefined;

        const publishAwait = (): void => {
          // ptyStarted must land first; the UI keys this state off a live session.
          if (!started) return;
          const next = hookState ?? (bell ? 'attention' : undefined);
          if (next === reportedAwait) return;
          reportedAwait = next;
          notify('ptyAwait', { jobId, stepId, awaiting: next !== undefined, reason: next });
        };

        let handle;
        try {
          handle = startPty(spec, {
            cols,
            rows,
            onData: data => notify('ptyData', { jobId, data }),
            onBell: () => { bell = true; publishAwait(); },
            onExit: exitCode => {
              exited = true;
              watcher?.stop();
              awaitWatcher?.stop();
              cancelEnd?.();
              job.pty = undefined;
              job.endSession = undefined;
              job.clearBell = undefined;
              // No closing ptyAwait: the store clears this on ptyExit anyway,
              // and a second event would only make ordering matter.
              // Report the deliberate end as success: the runner was killed on
              // our say-so, and runWorkflow fails the step on any nonzero code.
              const reported = ending ? 0 : exitCode;
              notify('ptyExit', { jobId, exitCode: reported, reason: ending ? 'ended' : 'exit' });
              resolvePromise(reported);
            },
            signal,
          });
        } catch (e) {
          reject(e as Error);
          return;
        }
        if (exited) return;
        job.pty = handle;

        const endSession = spec.endSession;
        if (endSession) {
          const trigger = (reason: 'marker' | 'user'): void => {
            if (ending) return;
            ending = reason;
            // We can only write to the child's stdin, never paint its screen —
            // so say what is happening on the same channel its output arrives on.
            notify('ptyData', { jobId, data: Buffer.from(CLOSING_BANNER, 'utf8').toString('base64') });
            cancelEnd = beginGracefulEnd(handle, endSession.quitSequence, timings);
          };
          job.endSession = trigger;
          watcher = watchForMarker(
            endSession.markerPath, () => trigger('marker'), timings.markerPollMs);
        }

        notify('ptyStarted', { jobId, stepId, cols, rows });

        started = true;
        job.clearBell = () => { bell = false; publishAwait(); };
        if (spec.awaitState) {
          awaitWatcher = watchAwaitState(
            spec.awaitState.statePath,
            reason => {
              hookState = reason;
              // A precise state supersedes the bell in both directions:
              // otherwise clearing 'turn' would fall back to a stale beep.
              bell = false;
              publishAwait();
            },
            timings.awaitPollMs);
        }
        // A bell that rang before ptyStarted is reported now, in order.
        publishAwait();
      });
    },
  };
}
