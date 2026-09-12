/**
 * spawnHeadless: runs a headless step's command, forwarding each stdout/
 * stderr line as a `stepLog` notification. On abort, sends SIGTERM, then
 * SIGKILL after a grace period if the child hasn't exited.
 *
 * A command step also asks for its output to be kept (`spec.capture`), so the
 * same bytes are appended to that file on their way out.
 */
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawnRunner as spawn, type SpawnSpec } from '@whiphand/core';
import type { NotifyFn } from './frontend.ts';

const DEFAULT_KILL_GRACE_MS = 5000;

export function createSpawnHeadless(
  jobId: string, notify: NotifyFn, opts: { killGraceMs?: number } = {},
): (
  spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
) => Promise<number> {
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return function spawnHeadless(
    spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<number> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(spec.argv, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const capture = spec.capture ? createWriteStream(spec.capture.path, { flags: 'a' }) : undefined;
      const capturesStderr = (spec.capture?.streams ?? 'both') === 'both';
      const forward = (stream: 'stdout' | 'stderr') => (line: string) => {
        notify('stepLog', { jobId, stream, line });
        // stderr still reaches the log panel either way — only the file is gated.
        if (stream === 'stdout' || capturesStderr) capture?.write(`${line}\n`);
      };
      // A progress spec's stdout is structured output for core to parse, not
      // prose for a human: when there is a reader for it, it skips
      // stepLog/capture entirely and goes to onLine alone, exactly as before.
      // Belt and braces: with no reader it still falls back to being logged,
      // so a frontend that ignores onLine never silently swallows the
      // child's output outright. Every other line — both streams on an
      // ordinary step, and stderr even on a progress-format one — is
      // forwarded as always AND handed to onLine, so core can also fold it
      // into `step:log`/run.log.
      const streamsProgress = spec.progress !== undefined && onLine !== undefined;
      const outRl = createInterface({ input: child.stdout! });
      outRl.on('line', line => {
        if (!streamsProgress) forward('stdout')(line);
        onLine?.(line, 'stdout');
      });
      const errRl = createInterface({ input: child.stderr! });
      errRl.on('line', line => {
        forward('stderr')(line);
        onLine?.(line, 'stderr');
      });

      let killTimer: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
        killTimer.unref?.();
      };
      signal?.addEventListener('abort', onAbort);

      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
        if (killTimer) clearTimeout(killTimer);
        outRl.close();
        errRl.close();
        capture?.end();
      };

      let exitCode: number | null = null;
      let settled = false;

      child.on('error', err => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
      child.on('exit', code => {
        exitCode = code ?? 1;
      });
      // 'exit' can fire before the stdio pipes finish draining; 'close' is the
      // event that guarantees every buffered stdout/stderr line has already
      // been forwarded, so resolve there instead to avoid dropping tail output.
      child.on('close', () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(exitCode ?? 1);
      });
    });
  };
}
