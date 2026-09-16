/**
 * Human-readable sizes and spans, spelled once for every surface that shows
 * them: the CLI's attachment line and step summary, `run.log`'s spawn and
 * artifact rows, and the desktop's file preview, runs grid and step pills.
 * Each of those used to carry its own copy, and they had drifted into three
 * different byte formats and two different clocks — the same 340 KB file read
 * `340 KB` in the terminal, `340.0KB` in run.log and `340.0 KB` in the app.
 *
 * Deliberately dependency-free, like execution-key.ts and log-rows.ts: the
 * desktop web bundle imports this module directly by relative path, so it
 * must never pull in a node builtin, even transitively.
 */

const KB = 1024;
const MB = 1024 * 1024;

/** `1.2 MB`, `340 KB`, `12 B` — one decimal only where it carries information. */
export function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${bytes} B`;
}

/**
 * Milliseconds from `startedAt` to `endMs`, or null when there is no usable
 * start. Null is the "show nothing" signal: a pending step has no duration,
 * and inventing 0s for it would read as "ran instantly".
 *
 * `endMs` is always passed in rather than read here, so a ticking timer is one
 * interval owned by the page — and so tests can pin the clock.
 */
export function elapsedMs(startedAt: string | undefined, endMs: number): number | null {
  if (startedAt === undefined) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start) || Number.isNaN(endMs)) return null;
  return endMs - start;
}

/**
 * A span at the coarsest useful precision: seconds under a minute, minutes and
 * seconds under an hour, hours and minutes beyond. Seconds are floored — a
 * timer that rounds up shows a minute the step has not yet spent, and a live
 * pill and the CLI's after-the-fact summary must agree on the same span.
 */
export function formatElapsed(ms: number): string {
  // Clock skew between the run's host and the reader's machine can make a live
  // span briefly negative; '0s' is the honest floor, '-1s' is alarming nonsense.
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/**
 * `stage 2 of 7 · Add API routes` — the one spelling for a `stages` step's
 * current position, shared by run.log's `stages:item` line, the CLI and the
 * desktop's stepper.
 */
export function stageLabel(index: number, total: number, title: string): string {
  return `stage ${index} of ${total} · ${title}`;
}
