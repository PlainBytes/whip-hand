/**
 * Watching for a step's end-of-session marker, and closing the session politely
 * once it appears.
 *
 * The marker path is minted in core (endMarkerPath) and rides to us on the
 * SpawnSpec, so the path the model is told to touch and the path we watch are
 * the same expression.
 */
import { stat } from 'node:fs/promises';
import type { PtyHandle } from './pty.ts';

/** How often a live session checks for its end marker. */
export const MARKER_POLL_INTERVAL_MS = 1_000;
/** How long the runner gets to quit on its own before SIGTERM. */
export const QUIT_GRACE_MS = 5_000;
/** How long it then gets to flush and exit before SIGKILL. */
export const TERM_GRACE_MS = 5_000;

export interface MarkerWatcher {
  stop(): void;
}

/**
 * Polls rather than fs.watch: you cannot watch a file that does not exist yet,
 * so this would have to watch the run directory — and directory watching is
 * where fs.watch is least dependable (FSEvents coalesces creations, inotify
 * never fires over network or overlay filesystems, and the run dir lives in
 * whatever workdir the user picked). One stat() a second beside a PTY streaming
 * terminal output costs nothing, and polling handles "the marker was already
 * there" for free.
 */
export function watchForMarker(
  path: string, onAppear: () => void, intervalMs = MARKER_POLL_INTERVAL_MS,
): MarkerWatcher {
  let stopped = false;
  let checking = false;
  let lastErrorTime = 0;

  const timer = setInterval(() => {
    if (stopped || checking) return;
    checking = true;
    void stat(path)
      .then(() => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        onAppear();
      })
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return;
        const now = Date.now();
        if (now - lastErrorTime > 30_000) {
          console.warn(`[watchForMarker] Cannot stat ${path}: ${err.message}`);
          lastErrorTime = now;
        }
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

export interface GracefulEndTimings {
  termGraceMs?: number;
  killGraceMs?: number;
}

/**
 * Asks the runner to quit, then escalates: quit sequence -> SIGTERM -> SIGKILL.
 * The graces are deliberately generous — claude and copilot both persist the
 * session harvest later resumes only as they shut down, and killing either
 * early turns into a baffling "the artifact was never written".
 *
 * Returns a canceller; call it once the pty has exited so no timer outlives it.
 */
export function beginGracefulEnd(
  pty: PtyHandle, quitSequence: string, timings: GracefulEndTimings = {},
): () => void {
  const termGraceMs = timings.termGraceMs ?? QUIT_GRACE_MS;
  const killGraceMs = timings.killGraceMs ?? TERM_GRACE_MS;
  const timers: NodeJS.Timeout[] = [];

  const later = (ms: number, fn: () => void): void => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    timers.push(t);
  };

  if (quitSequence) pty.write(Buffer.from(quitSequence, 'utf8').toString('base64'));

  later(quitSequence ? termGraceMs : 0, () => {
    pty.kill('SIGTERM');
    later(killGraceMs, () => pty.kill('SIGKILL'));
  });

  return (): void => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  };
}
