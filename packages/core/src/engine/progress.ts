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
 * These are third-party output schemas, far less stable than the flags in
 * docs/design.md. Every parse is therefore total: an unrecognized, malformed
 * or empty line yields null. A runner changing its output must degrade what
 * the UI shows, never take a run down with it.
 */

import type { ProgressFormat, StepProgress } from '../types.ts';

export type { ProgressFormat, StepProgress };

/** Targets are truncated here so no renderer has to think about a 400-char command. */
export const PROGRESS_TARGET_MAX = 120;

/** The argument that best names what a tool is acting *on*, across both runners. */
const TARGET_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'query'];

function truncate(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= PROGRESS_TARGET_MAX ? clean : `${clean.slice(0, PROGRESS_TARGET_MAX - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        return { kind: 'text', text: block.text.trim() };
      }
    }
    return null;
  }
  if (event.type === 'result') {
    return { kind: 'usage', turns: numberOr(event.num_turns), costUsd: numberOr(event.total_cost_usd) };
  }
  return null;
}

function parseCopilot(event: Record<string, unknown>): StepProgress | null {
  const data = isRecord(event.data) ? event.data : {};
  switch (event.type) {
    case 'tool.execution_start':
      return toolProgress(data.toolName, data.arguments);
    case 'assistant.message': {
      // A message carrying only toolRequests has empty content; the matching
      // tool.execution_start events are what report those.
      const content = data.content;
      if (typeof content !== 'string' || content.trim() === '') return null;
      return { kind: 'text', text: content.trim() };
    }
    case 'assistant.turn_end': {
      // turnId is a stringified 0-based index, so the count is one more.
      const index = Number(data.turnId);
      return Number.isInteger(index) && index >= 0 ? { kind: 'usage', turns: index + 1 } : null;
    }
    case 'result': {
      const usage = isRecord(event.usage) ? event.usage : {};
      return { kind: 'usage', premiumRequests: numberOr(usage.premiumRequests) };
    }
    default:
      return null;
  }
}

export function parseProgressLine(format: ProgressFormat, line: string): StepProgress | null {
  if (line.trim() === '') return null;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(event)) return null;
  return format === 'claude-stream-json' ? parseClaude(event) : parseCopilot(event);
}
