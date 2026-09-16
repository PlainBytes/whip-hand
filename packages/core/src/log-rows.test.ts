import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLogLine, mergeUsage, parseLogLine, summarizeEvent, usageParts } from './log-rows.ts';
import type { LogRow } from './log-rows.ts';
import type { StepProgress, WhiphandEvent } from './types.ts';

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

// ---------------------------------------------------------------------------
// shared progress helpers
// ---------------------------------------------------------------------------

test('mergeUsage: a present counter replaces, an absent one keeps the earlier value, and `kind` never leaks in', () => {
  const base = { turns: 2, lastAction: 'Read a.ts' };
  const usage: Extract<StepProgress, { kind: 'usage' }> = { kind: 'usage', premiumRequests: 0.33 };
  const merged = mergeUsage(base, usage);
  assert.deepEqual(merged, { turns: 2, lastAction: 'Read a.ts', premiumRequests: 0.33 });
  assert.deepEqual(base, { turns: 2, lastAction: 'Read a.ts' }, 'returns a new object rather than mutating');
});

test('usageParts: turns first, cost spelled by the caller, absent counters omitted', () => {
  assert.deepEqual(usageParts({ turns: 7, costUsd: 0.4123, premiumRequests: 1 }, usd => `$${usd.toFixed(2)}`),
    ['7 turns', '$0.41', '1 premium requests']);
  assert.deepEqual(usageParts({}, String), []);
});

test('summarizeEvent: an artifact row names its size in the shared byte format', () => {
  const row = summarizeEvent({ type: 'step:artifact', stepId: 'a', path: 'plan.md', bytes: 340 * 1024 });
  assert.equal(row.text, 'wrote artifact plan.md (340 KB)');
});

// ---------------------------------------------------------------------------
// summarizeEvent: stages
// ---------------------------------------------------------------------------

test('stages events summarize as stage lines', () => {
  assert.match(summarizeEvent({
    type: 'stages:item', id: 'build', index: 3, total: 7,
    stageId: '03-api', title: 'Add API routes', attempt: 1,
  })!.text, /stage 3 of 7 · Add API routes/);
});

test('summarizeEvent: stages:start/accepted/done each name the stages step by id', () => {
  assert.equal(summarizeEvent({ type: 'stages:start', id: 'build', total: 2 }).stepId, 'build');
  assert.match(summarizeEvent({ type: 'stages:start', id: 'build', total: 2 }).text, /2 stage/);
  assert.equal(summarizeEvent({ type: 'stages:accepted', id: 'build', stageId: '01-a' }).text, 'stage accepted: 01-a');
  assert.match(summarizeEvent({ type: 'stages:done', id: 'build', completed: 2 }).text, /2 completed/);
});
