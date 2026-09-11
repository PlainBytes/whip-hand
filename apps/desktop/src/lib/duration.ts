/**
 * Elapsed-time arithmetic and formatting, shared by every surface that shows
 * how long something has been going: the runs grid's Duration column, the run
 * header's live total, and each step pill.
 *
 * `now` is always passed in rather than read here, so a ticking timer is one
 * interval owned by the page — and so tests can pin the clock.
 */

/**
 * Milliseconds from `startedAt` to `endMs`, or null when there is no usable
 * start. Null is the "show nothing" signal: a pending step has no duration,
 * and inventing 0s for it would read as "ran instantly".
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
 * timer that rounds up shows a minute the step has not yet spent.
 */
export function formatElapsed(ms: number): string {
  // Clock skew between the run's host and this window can make a live span
  // briefly negative; '0s' is the honest floor, '-1s' is alarming nonsense.
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}
