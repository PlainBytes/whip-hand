/**
 * Turns a headless runner's structured stdout into a normalized progress
 * signal, so a running step can say what it is doing.
 *
 * Both schemas below were read off *recorded runs* of the installed binaries
 * (parity/fixtures/progress/), not off documentation:
 *
 *   claude  --output-format stream-json --verbose
 *     {"type":"assistant","message":{"content":[{"type":"tool_use","name":…,"input":…}]}}
 *     {"type":"assistant","message":{"content":[{"type":"text","text":…}]}}
 *     {"type":"result","num_turns":3,"total_cost_usd":0.0358}
 *     — plus system/hook/thinking_tokens/rate_limit_event/user chatter to ignore.
 *
 *   copilot --output-format json --stream on
 *     {"type":"tool.execution_start","data":{"toolName":…,"arguments":…}}
 *     {"type":"assistant.message","data":{"content":…}}      (may be empty)
 *     {"type":"assistant.turn_end","data":{"turnId":"0"}}     (0-based, stringified)
 *     {"type":"result","usage":{"premiumRequests":0.33}}
 *     — plus session, reasoning and delta chatter to ignore.
 *
 *   opencode run --format json
 *     {"type":"tool_use","sessionID":…,"part":{"tool":…,"state":{"input":…,"status":…}}}
 *     {"type":"text","part":{"text":…}}
 *     {"type":"step_finish","part":{"cost":…,"tokens":{…}}}   — per-step; opencode has
 *       no `num_turns`/`result` summary of its own, so the parser counts
 *       `step_finish` events itself and keeps a running cost total.
 *     {"type":"error","error":{"name":…,"data":{"message":…}}}   — not progress;
 *       see progressErrorMessage. opencode exits 1 with an empty stderr, so
 *       this line is the only place the reason for a failed run exists.
 *     — plus step_start and reasoning (only with --thinking) to ignore.
 *
 * These are third-party output schemas, far less stable than the flags in
 * docs/design.md. Every parse is therefore total: an unrecognized, malformed
 * or empty line yields null. A runner changing its output must degrade what
 * the UI shows, never take a run down with it.
 */

import type { ProgressFormat, StepProgress } from '../types.ts';

export type { ProgressFormat, StepProgress };

/** Targets are truncated here so no renderer has to think about a 400-char command. */
export const PROGRESS_TARGET_MAX = 120;

/** The argument that best names what a tool is acting *on*, across every runner. */
const TARGET_KEYS = ['file_path', 'filePath', 'path', 'command', 'pattern', 'url', 'query'];

function truncate(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= PROGRESS_TARGET_MAX ? clean : `${clean.slice(0, PROGRESS_TARGET_MAX - 1)}…`;
}

/**
 * A plain JSON object — arrays excluded, which `typeof` alone would let
 * through. Exported as core's one copy for everything else in core that picks
 * apart third-party JSON (claude's model probe, opencode's session list);
 * this module has no runtime imports, so depending on it costs nothing.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The object itself, or an empty one — so a missing or malformed nested field reads as "no keys" rather than a guard at every access. */
function recordOr(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * One JSON-object line, or null for anything else: blank, malformed, or valid
 * JSON that isn't an object. Total by design (see the module doc) — every
 * NDJSON reader in core starts here, so none of them can throw on a runner's
 * stray output line.
 */
export function parseJsonRecord(line: string): Record<string, unknown> | null {
  if (line.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function targetOf(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of TARGET_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return truncate(value);
  }
  return undefined;
}

function toolProgress(name: unknown, input: unknown): StepProgress | null {
  if (typeof name !== 'string' || name === '') return null;
  const target = targetOf(input);
  return target === undefined ? { kind: 'tool', tool: name } : { kind: 'tool', tool: name, target };
}

/** Assistant prose, trimmed; null when there isn't any, since an empty message says nothing worth showing. */
function textProgress(value: unknown): StepProgress | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return { kind: 'text', text: value.trim() };
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseClaude(event: Record<string, unknown>): StepProgress | null {
  if (event.type === 'assistant') {
    const message = event.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return null;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_use') return toolProgress(block.name, block.input);
      // An empty text block falls through to the next block rather than ending the scan.
      const text = block.type === 'text' ? textProgress(block.text) : null;
      if (text !== null) return text;
    }
    return null;
  }
  if (event.type === 'result') {
    return { kind: 'usage', turns: numberOr(event.num_turns), costUsd: numberOr(event.total_cost_usd) };
  }
  return null;
}

function parseCopilot(event: Record<string, unknown>): StepProgress | null {
  const data = recordOr(event.data);
  switch (event.type) {
    case 'tool.execution_start':
      return toolProgress(data.toolName, data.arguments);
    case 'assistant.message':
      // A message carrying only toolRequests has empty content; the matching
      // tool.execution_start events are what report those.
      return textProgress(data.content);
    case 'assistant.turn_end': {
      // turnId is a stringified 0-based index, so the count is one more.
      const index = Number(data.turnId);
      return Number.isInteger(index) && index >= 0 ? { kind: 'usage', turns: index + 1 } : null;
    }
    case 'result': {
      const usage = recordOr(event.usage);
      return { kind: 'usage', premiumRequests: numberOr(usage.premiumRequests) };
    }
    default:
      return null;
  }
}

/**
 * opencode reports no cumulative `result` event of its own — each `step_finish`
 * is per-step — so the parser keeps its own running totals across the calls it
 * is fed, which is what makes its `usage` reports agree with the "running total
 * for this spawn so far" contract every other runner already satisfies for
 * free. One closure per spawn (see `createProgressParser`), so a fresh spawn
 * always starts back at zero.
 */
function makeOpencodeParser(): (event: Record<string, unknown>) => StepProgress | null {
  let turns = 0;
  let costUsd = 0;
  let sawCost = false;
  return (event: Record<string, unknown>): StepProgress | null => {
    switch (event.type) {
      case 'tool_use': {
        const part = recordOr(event.part);
        return toolProgress(part.tool, recordOr(part.state).input);
      }
      case 'text':
        return textProgress(recordOr(event.part).text);
      case 'step_finish': {
        const part = recordOr(event.part);
        turns += 1;
        const cost = numberOr(part.cost);
        if (cost !== undefined) { sawCost = true; costUsd += cost; }
        return { kind: 'usage', turns, ...(sawCost ? { costUsd } : {}) };
      }
      default:
        return null;
    }
  };
}

/**
 * One parser per spawn, so a runner with per-spawn running state (opencode's
 * turn/cost totals) never leaks them into the next spawn. claude and copilot
 * are stateless, so their "parser" is just `parseProgressLine` bound to their
 * format — cheap enough that a fresh closure per spawn costs nothing.
 */
export function createProgressParser(format: ProgressFormat): (line: string) => StepProgress | null {
  if (format !== 'opencode-json') {
    return (line: string) => parseProgressLine(format, line);
  }
  const parseOpencode = makeOpencodeParser();
  return (line: string): StepProgress | null => {
    const event = parseJsonRecord(line);
    return event === null ? null : parseOpencode(event);
  };
}

/**
 * The reason a runner gave for failing, when a structured-output line carries
 * one — never progress, so the runner logs it and names it in the step's
 * failure instead. Only opencode reports errors this way; claude and copilot
 * print theirs to stderr, which is already logged.
 */
export function progressErrorMessage(format: ProgressFormat, line: string): string | undefined {
  if (format !== 'opencode-json') return undefined;
  const event = parseJsonRecord(line);
  if (event === null || event.type !== 'error') return undefined;
  const error = recordOr(event.error);
  const message = recordOr(error.data).message ?? error.message ?? error.name;
  return typeof message === 'string' && message.trim() !== '' ? message.replace(/\s+/g, ' ').trim() : undefined;
}

export function parseProgressLine(format: ProgressFormat, line: string): StepProgress | null {
  const event = parseJsonRecord(line);
  if (event === null) return null;
  if (format === 'claude-stream-json') return parseClaude(event);
  if (format === 'copilot-jsonl') return parseCopilot(event);
  // opencode-json is stateful (running totals) — parseProgressLine has no
  // per-spawn memory to keep them in, so a lone call only ever sees tool/text
  // progress; callers that need usage totals must use createProgressParser.
  return makeOpencodeParser()(event);
}
