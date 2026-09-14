/**
 * spawnHeadless: runs a headless step's command, forwarding each stdout/
 * stderr line as a `stepLog` notification. On abort, sends SIGTERM, then
 * SIGKILL after a grace period if the child hasn't exited.
 *
 * A command step also asks for its output to be kept (`spec.capture`), so the
 * same lines are appended to that file on their way out. Draining, capture and
 * settlement are core's `pipeChild`, shared with the CLI; what stays here is
 * this frontend's own policy — lines rather than a raw tee, and how to abort.
 */
import { pipeChild, routeHeadless, spawnRunner as spawn, type SpawnSpec } from '@whiphand/core';
import type { NotifyFn } from './frontend.ts';

const DEFAULT_KILL_GRACE_MS = 5000;

export function createSpawnHeadless(
  jobId: string, notify: NotifyFn, opts: { killGraceMs?: number } = {},
): (
  spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
) => Promise<number> {
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  // async so a launch that throws synchronously (an argv cmd.exe cannot carry)
  // still surfaces as a rejection, as it did from inside a Promise executor.
  return async function spawnHeadless(
    spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<number> {
    const child = spawn(spec.argv, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
      capture: route.capture === undefined ? undefined : { ...route.capture, unit: 'line' },
      // The child's own exit code is the result, even when aborted: a child
      // that traps SIGTERM and exits cleanly has said something worth keeping.
      // SIGKILL is the backstop for one that does not exit at all.
      signal,
      onAbort: target => {
        target.kill('SIGTERM');
        const killTimer = setTimeout(() => target.kill('SIGKILL'), killGraceMs);
        killTimer.unref?.();
        return () => clearTimeout(killTimer);
      },
    });
  };
}
