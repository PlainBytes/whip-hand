/**
 * The row format of `run.log` (see engine/run-log.ts): what one event
 * summarizes to, how a row is written as a line, and how that line parses back.
 *
 * Deliberately dependency-free, unlike engine/run-log.ts (which imports
 * node:fs to read the file): the desktop imports this module directly, so its
 * Logs tab builds rows from the live event stream with the very same
 * `summarizeEvent` the journal used to write the file, and reads a finished
 * run's file back with the very same `parseLogLine`. That is also why byte
 * counting goes through TextEncoder rather than Node's `Buffer` — this module
 * runs in the web bundle. `LoopRef`/`StepProgress`/`WhiphandEvent` are
 * type-only imports, so they add nothing at runtime; format.ts is itself
 * dependency-free.
 *
 * It is also where the *shared* spellings of a step's progress live —
 * nestedPrefix, progressActionText, mergeUsage, usageParts — because every
 * surface that renders progress (this file, the CLI renderer, the journal's
 * manifest fold, the desktop store and step pills) can already import it.
 */
import type { LoopRef, StepProgress, WhiphandEvent } from './types.ts';
import { formatBytes, stageLabel } from './format.ts';

/** One line's budget, after which it is truncated with a marker — one giant blob must not own the file. */
export const MAX_LOG_LINE_BYTES = 8 * 1024;

export interface LogRow {
  seq: number;
  ts: string;
  kind: string;
  stepId?: string;
  text: string;
  stream?: 'stdout' | 'stderr';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Injected by command.ts's commandSpec — never a workflow-declared secret, so these are never redacted. */
const WHIPHAND_ENV_KEYS = new Set([
  'WHIPHAND_RUN_DIR', 'WHIPHAND_RUN_ID', 'WHIPHAND_RUN_SLUG', 'WHIPHAND_RUN_NAME', 'WHIPHAND_STEP_ID',
]);

/**
 * `<id>` prefixed with every loop enclosing it, outermost first — e.g.
 * `human-review 2 › fix-cycle`. Empty for a top-level loop, which is what
 * keeps its own rendering byte-identical to what it always was. Exported for
 * the CLI renderer, so run.log and the terminal name a nested loop alike.
 */
export function nestedPrefix(id: string, parentLoopId?: string, parentIteration?: number, outerLoops?: LoopRef[]): string {
  const ancestors = [...(outerLoops ?? [])];
  if (parentLoopId !== undefined) ancestors.push({ id: parentLoopId, iteration: parentIteration ?? 1 });
  return ancestors.length === 0 ? id : `${ancestors.map(l => `${l.id} ${l.iteration}`).join(' › ')} › ${id}`;
}

/** The counters a `usage` report carries — and every summary that accumulates them. */
export interface UsageCounters {
  turns?: number;
  costUsd?: number;
  premiumRequests?: number;
}

/**
 * A tool call as one line of activity: `Read foo.ts`, or just `Bash` when the
 * runner named no target — never a trailing space. The same text is a
 * run.log row, a CLI activity line, the desktop feed entry and the manifest's
 * `lastAction`, so a reader comparing any two sees the identical string.
 */
export function progressActionText(progress: Extract<StepProgress, { kind: 'tool' }>): string {
  return progress.target === undefined ? progress.tool : `${progress.tool} ${progress.target}`;
}

/**
 * `base` with every counter `usage` actually reported laid over it. A report
 * is a running total (see StepProgress), so a present field replaces rather
 * than adds; an absent one leaves the earlier value alone, because copilot
 * reporting turns and premium requests in separate events must not erase
 * whichever arrived first. Returns a new object — callers hand the result to
 * immutable state (the desktop store) as well as mutable (the journal).
 */
export function mergeUsage<T extends UsageCounters>(base: T, usage: UsageCounters): T {
  const next = { ...base };
  if (usage.turns !== undefined) next.turns = usage.turns;
  if (usage.costUsd !== undefined) next.costUsd = usage.costUsd;
  if (usage.premiumRequests !== undefined) next.premiumRequests = usage.premiumRequests;
  return next;
}

/**
 * The present counters as labelled parts, turns first, absent ones omitted
 * rather than shown as zeroes. Only the cost's spelling differs by surface —
 * run.log keeps the raw figure (`$0.0358`) because it is a record, the UIs
 * round to cents — so that is the one thing a caller supplies; joining is left
 * to the caller too, as the CLI also slots its elapsed time in among them.
 */
export function usageParts(usage: UsageCounters, formatCost: (usd: number) => string): string[] {
  const parts: string[] = [];
  if (usage.turns !== undefined) parts.push(`${usage.turns} turns`);
  if (usage.costUsd !== undefined) parts.push(formatCost(usage.costUsd));
  if (usage.premiumRequests !== undefined) parts.push(`${usage.premiumRequests} premium requests`);
  return parts;
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
        + `${spec.argv.length} arg(s), prompt ${formatBytes(byteLength(prompt))}`
        + `${redactedEnvSuffix(spec.env)} [${event.phase}]`;
      return { kind: event.type, stepId: event.stepId, text };
    }
    case 'step:session':
      return { kind: event.type, stepId: event.stepId, text: `session id captured: ${event.sessionId}` };
    case 'step:artifact':
      return {
        kind: event.type, stepId: event.stepId,
        text: `wrote artifact ${event.path}${event.bytes === undefined ? '' : ` (${formatBytes(event.bytes)})`}`,
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
      return {
        kind: event.type,
        text: `loop '${nestedPrefix(event.loopId, event.parentLoopId, event.parentIteration, event.outerLoops)}' `
          + `started, up to ${event.maxIterations} iteration(s)`,
      };
    case 'loop:iteration':
      return {
        kind: event.type,
        text: `loop '${nestedPrefix(event.loopId, event.parentLoopId, event.parentIteration, event.outerLoops)}' `
          + `iteration ${event.iteration}/${event.maxIterations}`,
      };
    case 'loop:done':
      return {
        kind: event.type,
        text: `loop '${nestedPrefix(event.loopId, event.parentLoopId, event.parentIteration, event.outerLoops)}' `
          + `${event.passed ? 'passed' : 'did not pass'} after ${event.iterations} iteration(s)`,
      };
    case 'stages:start':
      return { kind: event.type, stepId: event.id, text: `stages started, ${event.total} stage(s)` };
    case 'stages:item':
      return {
        kind: event.type, stepId: event.id,
        text: `${stageLabel(event.index, event.total, event.title)} (attempt ${event.attempt})`,
      };
    case 'stages:accepted':
      return { kind: event.type, stepId: event.id, text: `stage accepted: ${event.stageId}` };
    case 'stages:done':
      return { kind: event.type, stepId: event.id, text: `stages done, ${event.completed} completed` };
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
        return { kind: 'step:progress:tool', stepId: event.stepId, text: progressActionText(progress) };
      }
      if (progress.kind === 'text') {
        return { kind: 'step:progress:text', stepId: event.stepId, text: progress.text };
      }
      const text = usageParts(progress, usd => `$${usd}`).join(', ');
      return { kind: 'step:progress:usage', stepId: event.stepId, text };
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
  const budget = MAX_LOG_LINE_BYTES - byteLength(prefix);
  if (budget > 0 && byteLength(text) > budget) {
    const marker = '…[truncated]';
    // '…' is 3 bytes in UTF-8, not 1 — budget math has to use its BYTE
    // length, not marker.length (a UTF-16 code-unit count), or the kept slice
    // plus the marker overruns the budget by exactly that difference.
    const markerBytes = byteLength(marker);
    const kept = decoder.decode(encoder.encode(text).subarray(0, Math.max(0, budget - markerBytes)));
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
