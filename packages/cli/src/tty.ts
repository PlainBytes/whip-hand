import type { ChildProcess } from 'node:child_process';
import { openStdin, pipeChild, routeHeadless, spawnRunner as spawn, type Container, type SpawnSpec } from '@whiphand/core';

// Sentinel exit code for an aborted spawn — mirrors the shell convention for
// signal-terminated processes (128 + SIGINT's 2), so runWorkflow's cancellation
// path can treat it like any other nonzero exit.
const ABORTED_EXIT_CODE = 130;

type Stdio = 'inherit' | ('ignore' | 'inherit' | 'pipe' | number)[];

/**
 * The CLI's two launchers, bound to one run's container (or to none, for a
 * caller with no run to contain). A `whiphand run` creates exactly one
 * container; every runner child is adopted into it, and an abort ends its
 * whole tree rather than the direct child alone.
 */
export function createTty(container?: Container): {
  spawnInteractive: (spec: SpawnSpec, signal?: AbortSignal) => Promise<number>;
  spawnHeadless: (
    spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
  ) => Promise<number>;
} {
  /** The one place that actually calls spawn — both variants below launch through this. */
  function launchChild(spec: SpawnSpec, stdio: Stdio, signal: AbortSignal | undefined, grouped: boolean): ChildProcess {
    // A headless runner verified to read a piped prompt (claude's `-p`) gets its
    // prompt file as fd 0; every other spawn keeps the stdin it always had.
    const input = typeof stdio === 'string' ? undefined : openStdin(spec);
    try {
      return spawn(spec.argv, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: input === undefined || input.stdin === 'ignore' ? stdio : [input.stdin, ...(stdio as Exclude<Stdio, string>).slice(1)],
        signal,
      }, { container, group: grouped });
    } finally {
      input?.close();
    }
  }

  /** On abort, ends the whole tree. Node's own `signal` option has already SIGTERMed the direct child. */
  function endTree(signal: AbortSignal | undefined): void {
    if (container === undefined || signal === undefined) return;
    const kill = (): void => { void container.killAll(); };
    if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true });
  }

  function doSpawn(spec: SpawnSpec, stdio: Stdio, signal: AbortSignal | undefined, grouped: boolean): Promise<number> {
    return new Promise((resolvePromise, reject) => {
      const child = launchChild(spec, stdio, signal, grouped);
      endTree(signal);
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

  /**
   * Every piped headless shape at once — a kept command output (`spec.capture`),
   * a progress stream (`spec.progress`), and the plain tee — since they differ
   * only in where each stream goes, which `routeHeadless` decides and
   * `pipeChild` carries out. One path is also what keeps a spec with both
   * capture and progress from echoing raw NDJSON.
   *
   * What the operator sees is what `stdio: 'inherit'` would have shown: every
   * raw chunk of both streams goes straight back out — except a progress
   * stream's stdout, which is structured output. stderr is still teed there,
   * because that is where real errors arrive.
   *
   * `onLine`, when given, is fed every line of both streams on top of that, so
   * core can parse `step:progress` and fold the rest into `step:log`/run.log.
   *
   * The capture file gets raw chunks, CRLF folded to LF on the way to the file
   * only (an artifact is portable by construction; the terminal tee above is
   * untouched). Abort settles at once with the sentinel exit code rather than
   * waiting for pipes a lingering grandchild may still hold open, and the
   * container ends the tree.
   */
  async function doSpawnPiped(
    spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<number> {
    const route = routeHeadless(spec, onLine !== undefined);
    const child = launchChild(spec, ['ignore', 'pipe', 'pipe'], signal, true);
    endTree(signal);
    return pipeChild(child, {
      onChunk: (chunk, stream) => {
        if (stream === 'stderr') process.stderr.write(chunk);
        else if (!route.progress) process.stdout.write(chunk);
      },
      onLine,
      capture: route.capture,
      errorExitCode: err => (err.code === 'ABORT_ERR' ? ABORTED_EXIT_CODE : undefined),
    });
  }

  return {
    // An interactive child inherits the terminal, so it must stay in the
    // foreground process group: `detached` would setsid it away from the tty.
    spawnInteractive: (spec, signal) => doSpawn(spec, 'inherit', signal, false),
    spawnHeadless: (spec, signal, onLine) => {
      // Inherited stdio is the one shape that needs no pipes at all — nothing to
      // keep, nobody reading lines — so it stays the cheapest, most faithful path.
      if (spec.capture === undefined && onLine === undefined) {
        return doSpawn(spec, ['ignore', 'inherit', 'inherit'], signal, true);
      }
      return doSpawnPiped(spec, signal, onLine);
    },
  };
}

// Uncontained launchers, for callers with no run (and the existing tests).
const uncontained = createTty();
export const spawnInteractive = uncontained.spawnInteractive;
export const spawnHeadless = uncontained.spawnHeadless;
