import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { spawnRunner as spawn, type SpawnSpec } from '@whiphand/core';

// Sentinel exit code for an aborted spawn — mirrors the shell convention for
// signal-terminated processes (128 + SIGINT's 2), so runWorkflow's cancellation
// path can treat it like any other nonzero exit.
const ABORTED_EXIT_CODE = 130;

function doSpawn(
  spec: SpawnSpec, stdio: 'inherit' | ('ignore' | 'inherit' | 'pipe')[], signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(spec.argv, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio,
      signal,
    });
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
 */
function doSpawnCaptured(spec: SpawnSpec, capturePath: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const file = createWriteStream(capturePath, { flags: 'a' });
    const child = spawn(spec.argv, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });

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

    let exitCode: number | null = null;
    let settled = false;
    const finish = async (code: number): Promise<void> => {
      if (settled) return;
      settled = true;
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
 * Pipe it, hand every line to the reader, and echo none of it. stderr stays
 * inherited, so real errors still reach the terminal untouched.
 */
function doSpawnProgress(
  spec: SpawnSpec, onLine: (line: string) => void, signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(spec.argv, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'inherit'],
      signal,
    });
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', onLine);

    let exitCode: number | null = null;
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolvePromise(code);
    };

    child.on('error', err => {
      if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        finish(ABORTED_EXIT_CODE);
        return;
      }
      if (settled) return;
      settled = true;
      rl.close();
      reject(err);
    });
    child.on('exit', code => { exitCode = code ?? 1; });
    // 'close' (not 'exit') is what guarantees stdout has drained, so the last
    // progress lines are never dropped.
    child.on('close', () => finish(exitCode ?? 1));
  });
}

export function spawnHeadless(
  spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string) => void,
): Promise<number> {
  if (spec.capture !== undefined) return doSpawnCaptured(spec, spec.capture.path, signal);
  if (spec.progress !== undefined && onLine !== undefined) return doSpawnProgress(spec, onLine, signal);
  return doSpawn(spec, ['ignore', 'inherit', 'inherit'], signal);
}
