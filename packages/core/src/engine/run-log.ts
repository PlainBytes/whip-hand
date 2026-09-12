/**
 * `run.log`: the human-readable audit RunJournal writes beside `events.ndjson`
 * — every structured event plus the merged stdout/stderr feed, one line each,
 * in the fixed format `formatLogLine` produces and `parseLogLine` reads back.
 *
 * `events.ndjson` stays the complete machine record (full argv, full prompts,
 * env — never redacted); this file is the one meant to be pasted into an
 * issue, so it summarises rather than dumps, and redacts a command step's
 * declared env values.
 */
import { open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { WhiphandEvent } from '../types.ts';

export const RUN_LOG_NAME = 'run.log';
/** One line's budget, after which it is truncated with a marker — one giant blob must not own the file. */
export const MAX_LOG_LINE_BYTES = 8 * 1024;
/** Default per-run byte cap; output lines stop past it, audit entries keep flowing. */
export const DEFAULT_RUN_LOG_CAP_BYTES = 50 * 1024 * 1024;

export interface LogRow {
  seq: number;
  ts: string;
  kind: string;
  stepId?: string;
  text: string;
  stream?: 'stdout' | 'stderr';
}

/** Injected by command.ts's commandSpec — never a workflow-declared secret, so these are never redacted. */
const WHIPHAND_ENV_KEYS = new Set([
  'WHIPHAND_RUN_DIR', 'WHIPHAND_RUN_ID', 'WHIPHAND_RUN_SLUG', 'WHIPHAND_RUN_NAME', 'WHIPHAND_STEP_ID',
]);

function bytesLabel(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Every other env key on a spawn is plausibly a workflow-declared secret
 * (schema.ts's CommandStep.env) — named so a reader knows one was set, valued
 * as `<redacted>` so the file stays shareable.
 */
function redactedEnvSuffix(env: Record<string, string>): string {
  const keys = Object.keys(env).filter(k => !WHIPHAND_ENV_KEYS.has(k));
  return keys.length === 0 ? '' : `, env: {${keys.map(k => `${k}=<redacted>`).join(', ')}}`;
}

/**
 * The human summary of one WhiphandEvent — what `formatLogLine` serializes.
 * Deliberately not a dump: `step:spawn` names argv length and prompt size
 * rather than the argv itself, which is what makes this file safe to paste
 * into an issue (events.ndjson keeps the full-fidelity version).
 */
export function summarizeEvent(event: WhiphandEvent): Omit<LogRow, 'seq' | 'ts'> {
  switch (event.type) {
    case 'run:start': {
      const parts = [`run started: workflow '${event.workflow}'`];
      if (event.name !== undefined) parts.push(`name '${event.name}'`);
      if (event.source !== undefined) parts.push(`source ${event.source}`);
      if (event.attachments !== undefined && event.attachments.length > 0) {
        parts.push(`${event.attachments.length} attachment(s)`);
      }
      return { kind: event.type, text: parts.join(', ') };
    }
    case 'run:resume': {
      const parts = [`run resumed: workflow '${event.workflow}'`];
      if (event.from !== undefined) {
        parts.push(`from step '${event.from}'${event.iteration === undefined ? '' : ` iteration ${event.iteration}`}`);
      }
      if (event.name !== undefined) parts.push(`name '${event.name}'`);
      return { kind: event.type, text: parts.join(', ') };
    }
    case 'step:start':
      return {
        kind: event.type, stepId: event.stepId,
        text: `step started (${event.kind}`
          + `${event.runner === undefined ? '' : `, runner=${event.runner}`}`
          + `${event.mode === undefined ? '' : `, mode=${event.mode}`})`,
      };
    case 'step:skipped':
      return { kind: event.type, stepId: event.stepId, text: 'step skipped (reused from an earlier attempt)' };
    case 'step:spawn': {
      const { spec } = event;
      const prompt = spec.argv[spec.argv.length - 1] ?? '';
      const text = `spawn ${spec.argv[0] ?? '?'} (${spec.interactive ? 'interactive' : 'headless'}), `
        + `${spec.argv.length} arg(s), prompt ${bytesLabel(Buffer.byteLength(prompt, 'utf8'))}`
        + `${redactedEnvSuffix(spec.env)} [${event.phase}]`;
      return { kind: event.type, stepId: event.stepId, text };
    }
    case 'step:artifact':
      return {
        kind: event.type, stepId: event.stepId,
        text: `wrote artifact ${event.path}${event.bytes === undefined ? '' : ` (${bytesLabel(event.bytes)})`}`,
      };
    case 'step:artifact-missing':
      return { kind: event.type, stepId: event.stepId, text: `artifact ${event.reason}: ${event.path}` };
    case 'step:timeout':
      return { kind: event.type, stepId: event.stepId, text: `timed out after ${event.timeoutMs}ms` };
    case 'step:retry':
      return { kind: event.type, stepId: event.stepId, text: `retrying (attempt ${event.attempt})` };
    case 'step:log':
      // The stream rides on `kind` itself (`step:log:stdout`/`step:log:stderr`)
      // rather than a fifth column: the fixed format has no slot for it, and
      // a finished run's Logs tab still needs to color stderr red after a
      // round trip through parseLogLine.
      return { kind: `${event.type}:${event.stream}`, stepId: event.stepId, stream: event.stream, text: event.line };
    case 'session:await':
      return {
        kind: event.type, stepId: event.stepId,
        text: event.awaiting ? `awaiting human (${event.reason ?? 'unknown'})` : 'no longer awaiting',
      };
    case 'session:ended':
      return { kind: event.type, stepId: event.stepId, text: `session ended via ${event.via}` };
    case 'step:pty-exit':
      return {
        kind: event.type, stepId: event.stepId,
        text: `pty exited, code ${event.exitCode}${event.reason === undefined ? '' : ` (${event.reason})`}`,
      };
    case 'run:env': {
      const runners = event.runners
        .map(r => `${r.id}${r.version !== undefined ? `@${r.version}` : r.installed ? '' : ' (not installed)'}`)
        .join(', ');
      const git = event.git === undefined
        ? ''
        : `, git ${event.git.sha.slice(0, 7)} (${event.git.dirty ? 'dirty' : 'clean'})`;
      return {
        kind: event.type,
        text: `whiphand ${event.whiphandVersion}, node ${event.nodeVersion}, ${event.platform}, `
          + `runners: ${runners || 'none'}${git}`,
      };
    }
    case 'step:tree-delta':
      return {
        kind: event.type, stepId: event.stepId,
        text: `touched ${event.files.length} file(s): ${event.files.join(', ')}`,
      };
    case 'step:verdict':
      return { kind: event.type, stepId: event.stepId, text: `verdict: ${event.verdict}` };
    case 'step:done':
      return { kind: event.type, stepId: event.stepId, text: `done, exit code ${event.exitCode}` };
    case 'step:manual':
      return { kind: event.type, stepId: event.stepId, text: `waiting on a human: ${event.request.title}` };
    case 'step:manual-resolved':
      return { kind: event.type, stepId: event.stepId, text: `human answered: ${event.choice}` };
    case 'loop:start':
      return { kind: event.type, text: `loop '${event.loopId}' started, up to ${event.maxIterations} iteration(s)` };
    case 'loop:iteration':
      return { kind: event.type, text: `loop '${event.loopId}' iteration ${event.iteration}/${event.maxIterations}` };
    case 'loop:done':
      return {
        kind: event.type,
        text: `loop '${event.loopId}' ${event.passed ? 'passed' : 'did not pass'} after ${event.iterations} iteration(s)`,
      };
    case 'guard:warning':
      return { kind: event.type, stepId: event.stepId, text: event.message };
    case 'run:done':
      return { kind: event.type, text: `run done: ${event.ok ? 'ok' : 'failed'}` };
    case 'run:error':
      return { kind: event.type, stepId: event.stepId, text: event.message };
    case 'run:cancelled':
      return { kind: event.type, text: 'run cancelled' };
    case 'step:progress': {
      const { progress } = event;
      if (progress.kind === 'tool') {
        const text = `${progress.tool}${progress.target === undefined ? '' : ` ${progress.target}`}`;
        return { kind: 'step:progress:tool', stepId: event.stepId, text };
      }
      if (progress.kind === 'text') {
        return { kind: 'step:progress:text', stepId: event.stepId, text: progress.text };
      }
      const parts: string[] = [];
      if (progress.turns !== undefined) parts.push(`${progress.turns} turns`);
      if (progress.costUsd !== undefined) parts.push(`$${progress.costUsd}`);
      if (progress.premiumRequests !== undefined) parts.push(`${progress.premiumRequests} premium requests`);
      return { kind: 'step:progress:usage', stepId: event.stepId, text: parts.join(', ') };
    }
  }
}

/**
 * `text`'s structural hazard is a literal newline, which would split one row
 * into two — but a literal backslash must be escaped too, or an already-escaped
 * newline becomes indistinguishable from a line that genuinely printed the two
 * characters `\n` (any tool emitting JSON does this). Single pass over the
 * *source* characters, each expanding to a fixed 2-char token, is what makes
 * the tokens non-overlapping and unescapeText's matching unambiguous.
 */
function escapeText(text: string): string {
  return text.replace(/\\|\n/g, m => (m === '\\' ? '\\\\' : '\\n'));
}

function unescapeText(text: string): string {
  return text.replace(/\\\\|\\n/g, m => (m === '\\\\' ? '\\' : '\n'));
}

/**
 * `<ISO ts>  <seq>  <kind>  <stepId|->  <text>`, two-space separated. Greppable
 * and `less`-readable by design, and parseable with a bounded split — see
 * parseLogLine — so the desktop can rebuild the exact same rows from the file
 * it built live from the event stream.
 */
export function formatLogLine(row: LogRow): string {
  const prefix = `${row.ts}  ${row.seq}  ${row.kind}  ${row.stepId ?? '-'}  `;
  let text = escapeText(row.text);
  const budget = MAX_LOG_LINE_BYTES - Buffer.byteLength(prefix, 'utf8');
  if (budget > 0 && Buffer.byteLength(text, 'utf8') > budget) {
    const marker = '…[truncated]';
    // '…' is 3 bytes in UTF-8, not 1 — budget math has to use its BYTE
    // length, not marker.length (a UTF-16 code-unit count), or the kept slice
    // plus the marker overruns the budget by exactly that difference.
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    const kept = Buffer.from(text, 'utf8').subarray(0, Math.max(0, budget - markerBytes)).toString('utf8');
    text = `${kept}${marker}`;
  }
  return `${prefix}${text}\n`;
}

/** Inverse of formatLogLine. `null` for a line that doesn't match the fixed prefix — a corrupt or foreign line, never thrown over. */
export function parseLogLine(line: string): LogRow | null {
  const parts = line.split('  ');
  if (parts.length < 4) return null;
  const [ts, seqRaw, rawKind, stepIdRaw, ...rest] = parts;
  const seq = Number(seqRaw);
  if (!Number.isFinite(seq)) return null;
  // Undo summarizeEvent's step:log encoding — see the comment there. The
  // step:progress:(tool|text|usage) kinds need no inverse mapping: unlike the
  // stream, which has its own LogRow field to land in, the progress kind IS
  // the whole signal, so it round-trips by passing straight through as `kind`.
  const streamMatch = /^step:log:(stdout|stderr)$/.exec(rawKind);
  const kind = streamMatch ? 'step:log' : rawKind;
  const stream = streamMatch ? (streamMatch[1] as 'stdout' | 'stderr') : undefined;
  return {
    seq, ts, kind,
    stepId: stepIdRaw === '-' ? undefined : stepIdRaw,
    text: unescapeText(rest.join('  ')),
    ...(stream === undefined ? {} : { stream }),
  };
}

export interface ReadRunLogParams {
  /** Forward paging from the start of the file — the original contract. Ignored when `fromEnd` or `beforeByte` is set. */
  offset?: number;
  limit: number;
  /** Open on the last `limit` lines of the file, via a bounded tail read rather than a full-file read. */
  fromEnd?: boolean;
  /** Page backwards from a byte offset a prior tail read reported as its `startByte` — a "load earlier" request. */
  beforeByte?: number;
}

export interface ReadRunLogResult {
  lines: string[];
  /** Only set for an `offset`-mode read: a tail read would have to pay for a full-file read just to compute it. */
  total?: number;
  truncated?: boolean;
  /** Only set for a tail-mode read (`fromEnd` or `beforeByte`): the file byte offset the returned window starts at. */
  startByte?: number;
  /** Only set for a tail-mode read: true once the window reaches byte 0 — nothing earlier to load. */
  atStart?: boolean;
}

/** Initial guess at how many bytes hold `limit` lines — expanded (doubled) when that guess undershoots. */
const TAIL_BYTES_PER_LINE_GUESS = 512;

/**
 * Reads the last `limit` complete lines ending at file byte `endByte`, via a
 * bounded, expanding window — never the whole file, unless the file is
 * genuinely smaller than the window needs to be. Byte offsets throughout
 * (rather than decoding first and re-indexing into the decoded string) are
 * what keep this correct on multi-byte UTF-8 content: `\n` is 0x0A, which
 * never appears as a continuation byte in a multi-byte UTF-8 sequence, so
 * splitting on the raw byte is safe where splitting on a decoded string index
 * would not be.
 */
async function tailLines(
  handle: FileHandle, endByte: number, limit: number,
): Promise<{ lines: string[]; startByte: number; atStart: boolean }> {
  let windowBytes = Math.max(limit * TAIL_BYTES_PER_LINE_GUESS, TAIL_BYTES_PER_LINE_GUESS);
  for (;;) {
    const start = Math.max(0, endByte - windowBytes);
    const len = endByte - start;
    const buf = Buffer.alloc(len);
    if (len > 0) await handle.read(buf, 0, len, start);

    // The window's own start byte is rarely a line boundary; discard whatever
    // partial line it lands in the middle of (there is nothing earlier than
    // `start` to reconstruct it from). At the true start of the file there is
    // no partial line to discard.
    let lineStartByte = 0;
    if (start > 0) {
      const firstNl = buf.indexOf(0x0a);
      lineStartByte = firstNl === -1 ? buf.length : firstNl + 1;
    }
    const usable = buf.subarray(lineStartByte);

    const ranges: Array<[number, number]> = [];
    let lineStart = 0;
    for (let i = 0; i < usable.length; i++) {
      if (usable[i] === 0x0a) {
        ranges.push([lineStart, i]);
        lineStart = i + 1;
      }
    }
    // A trailing run with no terminating \n only occurs at true EOF (every
    // other window boundary this function hands itself, via `startByte`, is
    // guaranteed to fall right after a \n) — keep it rather than drop it.
    if (lineStart < usable.length) ranges.push([lineStart, usable.length]);

    if (ranges.length >= limit || start === 0) {
      const kept = ranges.slice(-limit);
      const startByte = start + lineStartByte + kept[0][0];
      const lines = kept.map(([s, e]) => usable.subarray(s, e).toString('utf8'));
      return { lines, startByte, atStart: startByte === 0 };
    }
    windowBytes *= 2;
  }
}

/**
 * A paged read of `run.log`, for a finished (or reopened) run's Logs tab.
 *
 * Three modes, sharing one result shape:
 * - `fromEnd`: open on the tail — the last `limit` lines, via `tailLines`.
 * - `beforeByte`: page backwards from a byte offset a previous tail read
 *   reported, for a "load earlier" control.
 * - plain `offset`/`limit`: the original forward-paging contract, unchanged
 *   — reads the whole file once and slices it, same as before.
 *
 * Unlike readArtifact this has no whole-file size cap of its own in the
 * offset mode; the tail modes never read the whole file except when the file
 * is genuinely smaller than the requested window.
 */
export async function readRunLog(runDir: string, params: ReadRunLogParams): Promise<ReadRunLogResult> {
  const { limit, fromEnd, beforeByte } = params;
  if (fromEnd || beforeByte !== undefined) {
    let handle: FileHandle;
    try {
      handle = await open(join(runDir, RUN_LOG_NAME), 'r');
    } catch {
      return { lines: [], startByte: 0, atStart: true };
    }
    try {
      const endByte = beforeByte ?? (await handle.stat()).size;
      if (endByte <= 0) return { lines: [], startByte: 0, atStart: true };
      const { lines, startByte, atStart } = await tailLines(handle, endByte, limit);
      return { lines, startByte, atStart };
    } finally {
      await handle.close();
    }
  }

  let raw: string;
  try {
    raw = await readFile(join(runDir, RUN_LOG_NAME), 'utf8');
  } catch {
    return { lines: [], total: 0, truncated: false };
  }
  const offset = params.offset ?? 0;
  const allLines = raw.split('\n').filter(l => l.length > 0);
  const total = allLines.length;
  const slice = allLines.slice(offset, offset + limit);
  return { lines: slice, total, truncated: offset + slice.length < total };
}
