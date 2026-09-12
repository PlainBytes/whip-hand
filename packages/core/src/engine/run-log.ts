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
import { readFile } from 'node:fs/promises';
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
    case 'step:progress':
      // Ephemeral — RunJournal never schedules this one to be written, but the
      // switch stays exhaustive so a new StepProgress kind can't slip past unnoticed.
      return { kind: event.type, stepId: event.stepId, text: 'progress' };
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
  // Undo summarizeEvent's step:log encoding — see the comment there.
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

export interface ReadRunLogResult {
  lines: string[];
  total: number;
  truncated: boolean;
}

/**
 * A paged read of `run.log`, for a finished (or reopened) run's Logs tab.
 * Unlike readArtifact this has no whole-file size cap: `offset`/`limit` are
 * the cap. Returns raw formatted lines — the caller (or the desktop's own
 * `parseLogLine`) turns them back into rows.
 */
export async function readRunLog(runDir: string, offset: number, limit: number): Promise<ReadRunLogResult> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, RUN_LOG_NAME), 'utf8');
  } catch {
    return { lines: [], total: 0, truncated: false };
  }
  const allLines = raw.split('\n').filter(l => l.length > 0);
  const total = allLines.length;
  const slice = allLines.slice(offset, offset + limit);
  return { lines: slice, total, truncated: offset + slice.length < total };
}
