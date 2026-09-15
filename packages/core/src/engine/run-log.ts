/**
 * `run.log`: the human-readable audit RunJournal writes beside `events.ndjson`
 * — every structured event plus the merged stdout/stderr feed, one line each,
 * in the fixed format `formatLogLine` produces and `parseLogLine` reads back
 * (both in ../log-rows.ts, which the desktop imports too — this module reads
 * the file, so it cannot be pulled into the web bundle).
 *
 * `events.ndjson` stays the complete machine record (full argv, full prompts,
 * env — never redacted); this file is the one meant to be pasted into an
 * issue, so it summarises rather than dumps, and redacts a command step's
 * declared env values.
 */
import { open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

export const RUN_LOG_NAME = 'run.log';
/** Default per-run byte cap; output lines stop past it, audit entries keep flowing. */
export const DEFAULT_RUN_LOG_CAP_BYTES = 50 * 1024 * 1024;

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
 * - plain `offset`/`limit`: the forward-paging contract — reads the whole
 *   file once and slices it.
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
