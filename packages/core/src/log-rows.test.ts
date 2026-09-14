import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLogLine, parseLogLine, summarizeEvent } from './log-rows.ts';
import type { LogRow } from './log-rows.ts';
import type { WhiphandEvent } from './types.ts';

// ---------------------------------------------------------------------------
// summarizeEvent: step:progress
// ---------------------------------------------------------------------------

test('summarizeEvent: a tool call with a target renders the tool and target, not the word "progress"', () => {
  const event: WhiphandEvent = { type: 'step:progress', stepId: 'a', progress: { kind: 'tool', tool: 'Read', target: 'foo.ts' } };
  const row = summarizeEvent(event);
  assert.equal(row.kind, 'step:progress:tool');
  assert.equal(row.text, 'Read foo.ts');
});

test('summarizeEvent: a tool call with no target omits the trailing space', () => {
  const event: WhiphandEvent = { type: 'step:progress', stepId: 'a', progress: { kind: 'tool', tool: 'Bash' } };
  const row = summarizeEvent(event);
  assert.equal(row.kind, 'step:progress:tool');
  assert.equal(row.text, 'Bash');
});

test('summarizeEvent: assistant prose renders as its own text verbatim', () => {
  const event: WhiphandEvent = { type: 'step:progress', stepId: 'a', progress: { kind: 'text', text: 'thinking about the fix' } };
  const row = summarizeEvent(event);
  assert.equal(row.kind, 'step:progress:text');
  assert.equal(row.text, 'thinking about the fix');
});

test('summarizeEvent: usage renders every present field and omits absent ones', () => {
  const both = summarizeEvent({ type: 'step:progress', stepId: 'a', progress: { kind: 'usage', turns: 3, costUsd: 0.0358 } });
  assert.equal(both.kind, 'step:progress:usage');
  assert.equal(both.text, '3 turns, $0.0358');

  const turnsOnly = summarizeEvent({ type: 'step:progress', stepId: 'a', progress: { kind: 'usage', turns: 4 } });
  assert.equal(turnsOnly.text, '4 turns');

  const premium = summarizeEvent({ type: 'step:progress', stepId: 'a', progress: { kind: 'usage', premiumRequests: 0.33 } });
  assert.equal(premium.text, '0.33 premium requests');

  const nothing = summarizeEvent({ type: 'step:progress', stepId: 'a', progress: { kind: 'usage' } });
  assert.equal(nothing.text, '');
});

// ---------------------------------------------------------------------------
// formatLogLine / parseLogLine round trip
// ---------------------------------------------------------------------------

test('formatLogLine -> parseLogLine round-trips each step:progress kind', () => {
  const rows: Array<Omit<LogRow, 'seq' | 'ts'>> = [
    { kind: 'step:progress:tool', stepId: 'a', text: 'Read foo.ts' },
    { kind: 'step:progress:text', stepId: 'a', text: 'thinking about the fix' },
    { kind: 'step:progress:usage', stepId: 'a', text: '3 turns, $0.0358' },
  ];
  for (const partial of rows) {
    const row: LogRow = { seq: 1, ts: '2026-01-01T00:00:00.000Z', ...partial };
    const line = formatLogLine(row);
    const parsed = parseLogLine(line.trimEnd());
    assert.deepEqual(parsed, row);
  }
});

test('formatLogLine -> parseLogLine still round-trips step:log, unaffected by the step:progress change', () => {
  const row: LogRow = { seq: 1, ts: '2026-01-01T00:00:00.000Z', kind: 'step:log', stepId: 'a', stream: 'stdout', text: 'hello' };
  const line = formatLogLine({ ...row, kind: 'step:log:stdout' });
  const parsed = parseLogLine(line.trimEnd());
  assert.deepEqual(parsed, row);
});
