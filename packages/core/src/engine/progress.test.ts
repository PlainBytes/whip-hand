import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createProgressParser, isRecord, parseJsonRecord, parseProgressLine, PROGRESS_TARGET_MAX } from './progress.ts';
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

// --- opencode ---------------------------------------------------------

test('opencode: reads tool calls out of a recorded run, in order', () => {
  const parser = createProgressParser('opencode-json');
  const tools = fixture('opencode-json.ndjson').map(parser).filter((p): p is StepProgress => p !== null)
    .filter(p => p.kind === 'tool');
  assert.deepEqual(tools.map(t => t.tool), ['read', 'write']);
  assert.ok(tools[0].target?.endsWith('package.json'), `got ${tools[0].target}`);
  assert.ok(tools[1].target?.endsWith('fixture-opencode.txt'), `got ${tools[1].target}`);
});

test('opencode: reads assistant prose as text', () => {
  const parser = createProgressParser('opencode-json');
  const texts = fixture('opencode-json.ndjson').map(parser).filter((p): p is StepProgress => p !== null)
    .filter(p => p.kind === 'text');
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /fixture-opencode\.txt/);
});

test('opencode: ignores step_start noise, only step_finish reports usage', () => {
  const lines = fixture('opencode-json.ndjson');
  const parser = createProgressParser('opencode-json');
  const parsed = lines.map(parser).filter((p): p is StepProgress => p !== null);
  // 2 tools + 1 text + 3 usage (one step_finish per turn) = 6; 3 step_start lines are noise.
  assert.equal(parsed.length, 6);
});

test('opencode: usage is a running total for the spawn, accumulating turns and cost across step_finish events', () => {
  const parser = createProgressParser('opencode-json');
  const usage = fixture('opencode-json.ndjson').map(parser).filter((p): p is StepProgress => p !== null)
    .filter(p => p.kind === 'usage');
  assert.deepEqual(usage.map(u => u.turns), [1, 2, 3]);
  // The fixture's steps all cost 0 (a free model) — the running total still
  // has to be reported once any step_finish carried a cost field at all.
  for (const u of usage) assert.equal(u.costUsd, 0);
});

test('opencode: a fresh parser starts its running totals back at zero — no leakage across spawns', () => {
  const lines = fixture('opencode-json.ndjson');
  const first = createProgressParser('opencode-json');
  for (const line of lines) first(line);

  const second = createProgressParser('opencode-json');
  const usage = lines.map(second).filter((p): p is StepProgress => p !== null).filter(p => p.kind === 'usage');
  assert.deepEqual(usage.map(u => u.turns), [1, 2, 3], 'the second parser is not still counting from the first');
});

test('opencode: noise and malformed lines give null, same as the other formats', () => {
  const parser = createProgressParser('opencode-json');
  for (const line of ['', '   ', 'not json at all', '{', 'null', '[]', '{"type":"who?"}', '{"type":"error"}']) {
    assert.equal(parser(line), null, JSON.stringify(line));
  }
});

test('opencode: parseProgressLine (no per-spawn memory) still reports tool/text progress correctly', () => {
  const tool = JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { input: { command: 'ls' } } } });
  assert.deepEqual(parseProgressLine('opencode-json', tool), { kind: 'tool', tool: 'bash', target: 'ls' });
});

// --- robustness -----------------------------------------------------------

test('never throws on a line a runner should not have emitted', () => {
  for (const format of ['claude-stream-json', 'copilot-jsonl'] as const) {
    for (const line of ['', '   ', 'not json at all', '{', '{"type":', 'null', '[]', '{"type":"who?"}']) {
      assert.equal(parseProgressLine(format, line), null, `${format} / ${JSON.stringify(line)}`);
    }
  }
});

test('claude: an empty text block does not hide the block after it', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '  ' }, { type: 'text', text: ' real prose ' }] },
  });
  assert.deepEqual(parseProgressLine('claude-stream-json', line), { kind: 'text', text: 'real prose' });
});

test('parseJsonRecord accepts only a JSON object, and never throws', () => {
  assert.deepEqual(parseJsonRecord('{"type":"x"}'), { type: 'x' });
  for (const line of ['', '   ', 'not json', '{', 'null', '[]', '"str"', '42']) {
    assert.equal(parseJsonRecord(line), null, JSON.stringify(line));
  }
  assert.equal(isRecord([]), false, 'arrays are objects to typeof, not records to us');
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
