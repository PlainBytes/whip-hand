import type { ChildProcess } from 'node:child_process';
import { pipeChild, routeHeadless, spawnRunner as spawn, type SpawnSpec } from '@whiphand/core';

// Sentinel exit code for an aborted spawn — mirrors the shell convention for
// signal-terminated processes (128 + SIGINT's 2), so runWorkflow's cancellation
// path can treat it like any other nonzero exit.
const ABORTED_EXIT_CODE = 130;

/** The one place that actually calls spawn — both doSpawn* variants below launch through this. */
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
 * Every piped headless shape at once — a kept command output (`spec.capture`),
 * a progress stream (`spec.progress`), and the plain tee — since they differ
 * only in where each stream goes, which `routeHeadless` decides and
 * `pipeChild` carries out. One path is also what keeps a spec with both
 * capture and progress from echoing raw NDJSON, as the old per-shape dispatch
 * (capture checked first) would have.
 *
 * What the operator sees is what `stdio: 'inherit'` would have shown: every
 * raw chunk of both streams goes straight back out — except a progress
 * stream's stdout, which is structured output, where dumping NDJSON at the
 * terminal is worse than the silence it replaces. stderr is still teed there,
 * because that is where real errors arrive.
 *
 * `onLine`, when given, is fed every line of both streams on top of that, so
 * core can parse `step:progress` and fold the rest into `step:log`/run.log —
 * otherwise a terminal-run headless step persists nothing of its own output,
 * and a progress-format step that fails would be exempt from the audit.
 *
 * The capture file gets raw chunks rather than lines, so the artifact is
 * byte-for-byte what scrolled past. Abort is Node's own `signal` option on the
 * spawn, whose ABORT_ERR becomes the sentinel exit code straight away rather
 * than waiting for pipes a lingering grandchild may still hold open.
 */
async function doSpawnPiped(
  spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<number> {
  const route = routeHeadless(spec, onLine !== undefined);
  const child = launchChild(spec, ['ignore', 'pipe', 'pipe'], signal);
  return pipeChild(child, {
    onChunk: (chunk, stream) => {
      if (stream === 'stderr') process.stderr.write(chunk);
      else if (!route.progress) process.stdout.write(chunk);
    },
    onLine,
    capture: route.capture === undefined ? undefined : { ...route.capture, unit: 'chunk' },
    errorExitCode: err => (err.code === 'ABORT_ERR' ? ABORTED_EXIT_CODE : undefined),
  });
}

export function spawnHeadless(
  spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<number> {
  // Inherited stdio is the one shape that needs no pipes at all — nothing to
  // keep, nobody reading lines — so it stays the cheapest, most faithful path.
  if (spec.capture === undefined && onLine === undefined) {
    return doSpawn(spec, ['ignore', 'inherit', 'inherit'], signal);
  }
  return doSpawnPiped(spec, signal, onLine);
}
