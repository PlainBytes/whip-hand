/**
 * Human-readable sizes and spans, spelled as whiphand-core's format.rs spells
 * them, so the webview's file preview, runs grid and step pills read the same
 * as run.log and the CLI. Checked against core's goldens (through log-rows)
 * by core-goldens.test.ts.
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
 * Wall-clock milliseconds from `startedAt` to `endMs` — no surface shows this
 * any more (see `activeMs`); it remains for callers that need a raw span. Null
 * when there is no usable start. Null is the "show nothing" signal: a pending step has no duration,
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

/** The fields of a step or run row that active time reads; all optional, as old manifests have none of the wait ones. */
export interface ActiveTimeRow {
  startedAt?: unknown;
  /** Total of the waits already closed, in ms. */
  waitedMs?: unknown;
  /** When the wait still open began. */
  waitingSince?: unknown;
}

function dateMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Milliseconds a row was actually working, up to `endMs`: the span from
 * `startedAt`, less the waits it recorded (`waitedMs`) and the one still open
 * (`waitingSince`, counted up to `endMs`), floored at 0. A row with neither
 * field is its plain span. Null when there is no usable start.
 *
 * A TS copy of whiphand-core's `active_ms`, held to it by the golden in
 * core-goldens.test.ts. `endMs` is passed in for the same reason as in
 * `elapsedMs`: the page owns the one ticking clock.
 */
export function activeMs(row: ActiveTimeRow, endMs: number): number | null {
  const started = dateMs(row.startedAt);
  if (started === null || Number.isNaN(endMs)) return null;
  const waited = typeof row.waitedMs === 'number' ? row.waitedMs : 0;
  let active = endMs - started - waited;
  const since = dateMs(row.waitingSince);
  if (since !== null) active -= endMs - since;
  return Math.max(0, active);
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
