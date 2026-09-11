import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseProgressLine, PROGRESS_TARGET_MAX } from './progress.ts';
import type { StepProgress } from './progress.ts';

/**
 * The fixtures are real recorded runs (see parity/fixtures/progress/README.md).
 * Parsing them, rather than hand-written samples, is what makes a runner
 * changing its output schema show up here as a failure.
 */
const fixtureDir = fileURLToPath(new URL('../../../../parity/fixtures/progress/', import.meta.url));
const fixture = (name: string): string[] =>
  readFileSync(join(fixtureDir, name), 'utf8').split('\n').filter(l => l.trim() !== '');

const parseAll = (format: 'claude-stream-json' | 'copilot-jsonl', lines: string[]): StepProgress[] =>
  lines.map(l => parseProgressLine(format, l)).filter((p): p is StepProgress => p !== null);

// --- claude ---------------------------------------------------------------

test('claude: reads tool calls out of a recorded run, in order', () => {
  const tools = parseAll('claude-stream-json', fixture('claude-stream-json.ndjson'))
    .filter(p => p.kind === 'tool');
  assert.deepEqual(tools.map(t => t.tool), ['Read', 'Write']);
  assert.ok(tools[0].target?.endsWith('package.json'), `got ${tools[0].target}`);
});

test('claude: reads assistant prose as text', () => {
  const texts = parseAll('claude-stream-json', fixture('claude-stream-json.ndjson'))
    .filter(p => p.kind === 'text');
  assert.equal(texts.length, 1);
  // 'mission-control' is the product's old name, and it is baked into these
  // recorded transcripts: the sessions were captured against this repo back
  // when its package.json still said so. The fixtures are frozen, so the
  // assertion stays as-is rather than being renamed to something the data
  // does not contain.
  assert.match(texts[0].text, /mission-control/);
});

test('claude: reads turns and cost off the final result event', () => {
  const usage = parseAll('claude-stream-json', fixture('claude-stream-json.ndjson'))
    .filter(p => p.kind === 'usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].turns, 3);
  assert.equal(usage[0].costUsd, 0.0358903);
});

test('claude: ignores hook, init, thinking and tool_result noise', () => {
  // The recorded run carries SessionStart hook events, thinking_tokens pings,
  // a rate_limit_event and tool_result echoes. None is progress.
  const lines = fixture('claude-stream-json.ndjson');
  const parsed = parseAll('claude-stream-json', lines);
  assert.ok(lines.length > 20, 'fixture should contain plenty of noise');
  assert.equal(parsed.length, 4, 'only 2 tools + 1 text + 1 usage are progress');
});

// --- copilot --------------------------------------------------------------

test('copilot: reads tool calls out of a recorded run, in order', () => {
  const tools = parseAll('copilot-jsonl', fixture('copilot-jsonl.ndjson'))
    .filter(p => p.kind === 'tool');
  assert.deepEqual(tools.map(t => t.tool), ['view', 'bash', 'bash']);
  assert.ok(tools[0].target?.endsWith('package.json'), `got ${tools[0].target}`);
  assert.match(tools[1].target ?? '', /^mkdir -p /, 'a bash tool reports its command');
});

test('copilot: reads assistant prose as text, skipping empty messages', () => {
  const texts = parseAll('copilot-jsonl', fixture('copilot-jsonl.ndjson'))
    .filter(p => p.kind === 'text');
  // Three assistant.message events, but the first carries only tool requests.
  assert.equal(texts.length, 2);
  // 'mission-control' is the product's old name, and it is baked into these
  // recorded transcripts: the sessions were captured against this repo back
  // when its package.json still said so. The fixtures are frozen, so the
  // assertion stays as-is rather than being renamed to something the data
  // does not contain.
  assert.match(texts[1].text, /mission-control/);
});

test('copilot: counts turns from the 0-based turnId on each turn end', () => {
  const turns = parseAll('copilot-jsonl', fixture('copilot-jsonl.ndjson'))
    .filter(p => p.kind === 'usage')
    .map(p => p.turns)
    .filter(t => t !== undefined);
  assert.deepEqual(turns, [1, 2, 3]);
});

test('copilot: reports premium requests, having no dollar cost to report', () => {
  const usage = parseAll('copilot-jsonl', fixture('copilot-jsonl.ndjson'));
  const final = usage.at(-1);
  assert.equal(final?.kind, 'usage');
  assert.equal(final.premiumRequests, 0.33);
  assert.equal(final.costUsd, undefined, 'copilot reports no USD cost; do not invent one');
});

test('copilot: ignores session, delta and reasoning noise', () => {
  const parsed = parseAll('copilot-jsonl', fixture('copilot-jsonl.ndjson'));
  // 3 tools + 2 texts + 3 turn-ends + 1 result.
  assert.equal(parsed.length, 9);
});

// --- robustness -----------------------------------------------------------

test('never throws on a line a runner should not have emitted', () => {
  for (const format of ['claude-stream-json', 'copilot-jsonl'] as const) {
    for (const line of ['', '   ', 'not json at all', '{', '{"type":', 'null', '[]', '{"type":"who?"}']) {
      assert.equal(parseProgressLine(format, line), null, `${format} / ${JSON.stringify(line)}`);
    }
  }
});

test('truncates an overlong target so renderers never have to', () => {
  const long = '/x'.repeat(400);
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: long } }] },
  });
  const p = parseProgressLine('claude-stream-json', line);
  assert.equal(p?.kind, 'tool');
  assert.ok(p.target!.length <= PROGRESS_TARGET_MAX, `got ${p.target!.length}`);
  assert.ok(p.target!.endsWith('…'), 'truncation should be visible');
});

test('a tool call with no recognisable target still reports the tool', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }] },
  });
  assert.deepEqual(parseProgressLine('claude-stream-json', line), { kind: 'tool', tool: 'TodoWrite' });
});
