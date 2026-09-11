/**
 * Watching a step's await-state file and reporting transitions of it.
 *
 * The path is minted in core (awaitStatePath) and rides here on the SpawnSpec,
 * so the path the runner's hooks write and the path we watch are the same
 * expression.
 */
import { readFile } from 'node:fs/promises';
import { parseAwaitState, type AwaitReason } from '@whiphand/core';

/** Same cadence as the end marker; see session-end.ts for why polling, not fs.watch. */
export const AWAIT_POLL_INTERVAL_MS = 1_000;

export interface AwaitWatcher {
  stop(): void;
}

/**
 * Reports only CHANGES, never the same value twice running. Starts from
 * `undefined` — core pre-cleans the run dir before the session opens, so a
 * first tick that finds nothing has nothing to say.
 *
 * Unlike watchForMarker this is deliberately not one-shot: being blocked on the
 * human is a condition that comes and goes for the whole life of the session.
 */
export function watchAwaitState(
  path: string,
  onChange: (reason: AwaitReason | undefined) => void,
  intervalMs = AWAIT_POLL_INTERVAL_MS,
): AwaitWatcher {
  let stopped = false;
  let checking = false;
  let current: AwaitReason | undefined;

  const settle = (next: AwaitReason | undefined): void => {
    if (stopped || next === current) return;
    current = next;
    onChange(next);
  };

  const timer = setInterval(() => {
    if (stopped || checking) return;
    checking = true;
    void readFile(path, 'utf8')
      .then(raw => {
        // Only an outright state replaces what we believe. An unparseable,
        // half-written or unfamiliar body says nothing, and must not flap the UI.
        const parsed = parseAwaitState(raw);
        if (parsed.kind === 'state') settle(parsed.reason);
      })
      .catch((e: NodeJS.ErrnoException) => {
        // The file being gone is the signal that the human answered. Any other
        // read failure (EACCES, EIO) is transient noise: keep the last state.
        if (e.code === 'ENOENT') settle(undefined);
      })
      .finally(() => { checking = false; });
  }, intervalMs);
  // Never let a forgotten watcher hold the sidecar open past shutdown.
  timer.unref?.();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
