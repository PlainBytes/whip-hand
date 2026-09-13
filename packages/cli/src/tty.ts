import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawnRunner as spawn, type SpawnSpec } from '@whiphand/core';

// Sentinel exit code for an aborted spawn — mirrors the shell convention for
// signal-terminated processes (128 + SIGINT's 2), so runWorkflow's cancellation
// path can treat it like any other nonzero exit.
const ABORTED_EXIT_CODE = 130;

/** The one place that actually calls spawn — every doSpawn* variant below launches through this. */
function launchChild(
  spec: SpawnSpec, stdio: 'inherit' | ('ignore' | 'inherit' | 'pipe')[], signal?: AbortSignal,
): ChildProcess {
  return spawn(spec.argv, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio,
    signal,
  });
}

function doSpawn(
  spec: SpawnSpec, stdio: 'inherit' | ('ignore' | 'inherit' | 'pipe')[], signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = launchChild(spec, stdio, signal);
    child.on('error', err => {
      // Node kills the child and emits this 'error' (before 'exit') when the
      // signal aborts — verified against real spawn behavior with a `sleep`
      // child: the AbortError always arrives first. Translate it to a
      // sentinel exit code instead of throwing an unhandled rejection.
      if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        resolvePromise(ABORTED_EXIT_CODE);
        return;
      }
      reject(err);
    });
    child.on('exit', code => resolvePromise(code ?? 1));
  });
}

export function spawnInteractive(spec: SpawnSpec, signal?: AbortSignal): Promise<number> {
  return doSpawn(spec, 'inherit', signal);
}

/**
 * A command step asks for its output to be kept (`spec.capture`), which the
 * inherited-stdio path cannot do. Only then do we take over the pipes — and we
 * write every chunk straight back out, so what the operator sees is unchanged.
 *
 * `onLine`, when given, is fed every line on top of that raw tee — a second,
 * line-oriented reader on the same streams, so core can fold the command's
 * output into `step:log` without changing a byte of what actually reaches the
 * terminal or the capture file.
 */
function doSpawnCaptured(
  spec: SpawnSpec, capturePath: string, signal?: AbortSignal,
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const file = createWriteStream(capturePath, { flags: 'a' });
    const child = launchChild(spec, ['ignore', 'pipe', 'pipe'], signal);

    // `toFile` is what `capture.streams` gates: the operator sees both streams
    // regardless, only the artifact is narrowed. See SpawnSpec.capture.
    const tee = (from: NodeJS.ReadableStream, to: NodeJS.WriteStream, toFile: boolean) => {
      from.on('data', (chunk: Buffer) => {
        to.write(chunk);
        if (toFile) file.write(chunk);
      });
    };
    tee(child.stdout!, process.stdout, true);
    tee(child.stderr!, process.stderr, (spec.capture?.streams ?? 'both') === 'both');

    const outRl = onLine ? createInterface({ input: child.stdout! }) : undefined;
    outRl?.on('line', line => onLine!(line, 'stdout'));
    const errRl = onLine ? createInterface({ input: child.stderr! }) : undefined;
    errRl?.on('line', line => onLine!(line, 'stderr'));

    let exitCode: number | null = null;
    let settled = false;
    const finish = async (code: number): Promise<void> => {
      if (settled) return;
      settled = true;
      outRl?.close();
      errRl?.close();
      file.end();
      await once(file, 'close').catch(() => {});
      resolvePromise(code);
    };

    child.on('error', err => {
      if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        void finish(ABORTED_EXIT_CODE);
        return;
      }
      if (settled) return;
      settled = true;
      outRl?.close();
      errRl?.close();
      file.end();
      reject(err);
    });
    child.on('exit', code => { exitCode = code ?? 1; });
    // 'close' (not 'exit') is what guarantees the pipes have drained, so the
    // captured artifact never loses the command's last lines.
    child.on('close', () => { void finish(exitCode ?? 1); });
  });
}

/**
 * A progress spec's stdout is structured output, so it cannot be inherited:
 * dumping raw NDJSON at the terminal is worse than the silence it replaces.
 * Pipe it and hand every line to `onLine`, which parses it into `step:progress`
 * and echoes none of it. stderr is piped too (rather than inherited): real
 * errors still reach the terminal via the raw tee below, and are also handed
 * to `onLine` so core can fold them into `step:log` — a progress-format step
 * that fails is not exempt from the audit.
 */
function doSpawnProgress(
  spec: SpawnSpec, onLine: (line: string, stream: 'stdout' | 'stderr') => void, signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = launchChild(spec, ['ignore', 'pipe', 'pipe'], signal);
    const outRl = createInterface({ input: child.stdout! });
    outRl.on('line', line => onLine(line, 'stdout'));
    child.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    const errRl = createInterface({ input: child.stderr! });
    errRl.on('line', line => onLine(line, 'stderr'));

    let exitCode: number | null = null;
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      outRl.close();
      errRl.close();
      resolvePromise(code);
    };

    child.on('error', err => {
      if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        finish(ABORTED_EXIT_CODE);
        return;
      }
      if (settled) return;
      settled = true;
      outRl.close();
      errRl.close();
      reject(err);
    });
    child.on('exit', code => { exitCode = code ?? 1; });
    // 'close' (not 'exit') is what guarantees stdout has drained, so the last
    // progress lines are never dropped.
    child.on('close', () => finish(exitCode ?? 1));
  });
}

/**
 * The plain headless path: pipes both streams, tees the raw bytes straight to
 * the terminal (so a human watching sees exactly what `stdio: 'inherit'`
 * would show), and hands each line to `onLine` on the side so core can fold
 * it into `step:log`/run.log — otherwise a terminal-run headless step
 * persists nothing of its own output anywhere.
 */
function doSpawnTeeLines(
  spec: SpawnSpec, onLine: (line: string, stream: 'stdout' | 'stderr') => void, signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = launchChild(spec, ['ignore', 'pipe', 'pipe'], signal);
    child.stdout!.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    const outRl = createInterface({ input: child.stdout! });
    outRl.on('line', line => onLine(line, 'stdout'));
    const errRl = createInterface({ input: child.stderr! });
    errRl.on('line', line => onLine(line, 'stderr'));

    let exitCode: number | null = null;
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      outRl.close();
      errRl.close();
      resolvePromise(code);
    };

    child.on('error', err => {
      if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        finish(ABORTED_EXIT_CODE);
        return;
      }
      if (settled) return;
      settled = true;
      outRl.close();
      errRl.close();
      reject(err);
    });
    child.on('exit', code => { exitCode = code ?? 1; });
    // 'close' (not 'exit'): the same drain guarantee as the other spawn paths.
    child.on('close', () => finish(exitCode ?? 1));
  });
}

export function spawnHeadless(
  spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<number> {
  if (spec.capture !== undefined) return doSpawnCaptured(spec, spec.capture.path, signal, onLine);
  if (spec.progress !== undefined && onLine !== undefined) return doSpawnProgress(spec, onLine, signal);
  if (onLine !== undefined) return doSpawnTeeLines(spec, onLine, signal);
  return doSpawn(spec, ['ignore', 'inherit', 'inherit'], signal);
}
