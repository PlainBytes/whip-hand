/**
 * spawnHeadless: runs a headless step's command, forwarding each stdout/
 * stderr line as a `stepLog` notification. On abort the promise settles at
 * once and the run's container ends the whole process tree.
 *
 * A command step also asks for its output to be kept (`spec.capture`), so the
 * same lines are appended to that file on their way out. Draining, capture and
 * settlement are core's `pipeChild`, shared with the CLI; what stays here is
 * this frontend's own policy — lines rather than a raw tee, and how to abort.
 */
import {
  DEFAULT_KILL_GRACE_MS, openStdin, pipeChild, routeHeadless, spawnRunner as spawn, type Container, type SpawnSpec,
} from '@whiphand/core';
import type { NotifyFn } from './frontend.ts';

/** Sentinel exit code for an aborted spawn — the CLI's, so both frontends settle a cancel identically. */
export const ABORTED_EXIT_CODE = 130;

export function createSpawnHeadless(
  jobId: string, notify: NotifyFn, opts: { killGraceMs?: number; container?: Container } = {},
): (
  spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
) => Promise<number> {
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  // async so a launch that throws synchronously (an argv cmd.exe cannot carry)
  // still surfaces as a rejection, as it did from inside a Promise executor.
  return async function spawnHeadless(
    spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<number> {
    // A headless runner verified to read a piped prompt (claude's `-p`) gets its
    // prompt file as fd 0 — see SpawnSpec.stdinFile.
    const input = openStdin(spec);
    let child;
    try {
      child = spawn(spec.argv, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: [input.stdin, 'pipe', 'pipe'],
      }, { container: opts.container });
    } finally {
      input.close();
    }

    // A progress spec's stdout is structured output for core to parse, not
    // prose for a human: when there is a reader for it, it skips
    // stepLog/capture entirely and goes to onLine alone.
    // Belt and braces: with no reader it still falls back to being logged,
    // so a frontend that ignores onLine never silently swallows the
    // child's output outright. Every other line — both streams on an
    // ordinary step, and stderr even on a progress-format one — is
    // forwarded as always AND handed to onLine, so core can also fold it
    // into `step:log`/run.log. `capture.streams` narrows only the file:
    // stderr still reaches the log panel either way.
    const route = routeHeadless(spec, onLine !== undefined);

    return pipeChild(child, {
      onLine: (line, stream) => {
        if (!(route.progress && stream === 'stdout')) notify('stepLog', { jobId, stream, line });
        onLine?.(line, stream);
      },
      capture: route.capture,
      // Cancel and timeout *settle*, like the CLI: 'close' waits for pipes an
      // orphaned grandchild still holds, so waiting on it let a `timeout_ms`
      // step abort and then never resolve. The tree itself is the container's
      // job; without one (a caller with no run) the direct child is signalled,
      // SIGTERM and then SIGKILL after the grace period.
      signal,
      abortExitCode: ABORTED_EXIT_CODE,
      onAbort: target => {
        if (opts.container !== undefined) {
          void opts.container.killAll();
          return;
        }
        target.kill('SIGTERM');
        const killTimer = setTimeout(() => target.kill('SIGKILL'), killGraceMs);
        killTimer.unref?.();
        return () => clearTimeout(killTimer);
      },
    });
  };
}
