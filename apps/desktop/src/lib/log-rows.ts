/**
 * The desktop's own copy of core's `packages/core/src/engine/run-log.ts`: that
 * module imports `node:fs` and cannot be pulled into the web bundle, unlike
 * `executionKey` (packages/core/src/execution-key.ts), which is
 * dependency-free and so the desktop imports it directly. Keep this in
 * lockstep with run-log.ts's `summarizeEvent` and `parseLogLine` by hand;
 * there is no build-time check that can do it for us.
 *
 * `summarizeEvent` turns a live WhiphandEvent into the same row shape a
 * finished run's `run.log` parses back into (via `parseLogLine`), which is
 * what lets the Logs tab render "live" and "read from disk" rows identically.
 */
import type { WhiphandEvent } from '../../../../packages/core/src/types.ts';

export interface LogRow {
  seq: number;
  ts: string;
  kind: string;
  stepId?: string;
  text: string;
  stream?: 'stdout' | 'stderr';
}

function bytesLabel(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

const WHIPHAND_ENV_KEYS = new Set([
  'WHIPHAND_RUN_DIR', 'WHIPHAND_RUN_ID', 'WHIPHAND_RUN_SLUG', 'WHIPHAND_RUN_NAME', 'WHIPHAND_STEP_ID',
]);

function redactedEnvSuffix(env: Record<string, string>): string {
  const keys = Object.keys(env).filter(k => !WHIPHAND_ENV_KEYS.has(k));
  return keys.length === 0 ? '' : `, env: {${keys.map(k => `${k}=<redacted>`).join(', ')}}`;
}

/** Mirrors core's run-log.ts summarizeEvent — see that file for the canonical version and its comments. */
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
        + `${spec.argv.length} arg(s), prompt ${bytesLabel(new TextEncoder().encode(prompt).length)}`
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
      // Stream rides on `kind` (see core's run-log.ts) so it survives a round
      // trip through parseLogLine, which has no fifth column for it.
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

/** Mirrors core's run-log.ts unescapeText — see that file for why the two tokens must be matched together. */
function unescapeText(text: string): string {
  return text.replace(/\\\\|\\n/g, m => (m === '\\\\' ? '\\' : '\n'));
}

/** Inverse of core's formatLogLine — see run-log.ts. `null` for a line that doesn't match the fixed prefix. */
export function parseLogLine(line: string): LogRow | null {
  const parts = line.split('  ');
  if (parts.length < 4) return null;
  const [ts, seqRaw, rawKind, stepIdRaw, ...rest] = parts;
  const seq = Number(seqRaw);
  if (!Number.isFinite(seq)) return null;
  // step:progress:(tool|text|usage) kinds need no inverse mapping here either
  // — see core's run-log.ts parseLogLine for why.
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
