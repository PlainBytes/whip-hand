import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatLogLine, parseLogLine, readRunLog, RUN_LOG_NAME, summarizeEvent } from './run-log.ts';
import type { LogRow } from './run-log.ts';
import type { WhiphandEvent } from '../types.ts';

async function tmpRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'whiphand-run-log-'));
}

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
// readRunLog: tail reads
// ---------------------------------------------------------------------------

async function writeRunLog(runDir: string, lines: string[]): Promise<void> {
  await writeFile(join(runDir, RUN_LOG_NAME), lines.map(l => `${l}\n`).join(''), 'utf8');
}

function fmt(seq: number, text: string): string {
  return formatLogLine({ seq, ts: '2026-01-01T00:00:00.000Z', kind: 'step:log:stdout', stepId: 'a', text }).trimEnd();
}

test('readRunLog fromEnd: returns the last `limit` lines of a file larger than the initial window guess', async () => {
  const runDir = await tmpRunDir();
  const lines = Array.from({ length: 500 }, (_, i) => fmt(i + 1, `line ${i + 1}`));
  await writeRunLog(runDir, lines);

  const result = await readRunLog(runDir, { fromEnd: true, limit: 10 });
  assert.equal(result.lines.length, 10);
  assert.ok(result.lines[0].includes('line 491'));
  assert.ok(result.lines[9].includes('line 500'));
  assert.equal(result.atStart, false);
  assert.ok(result.startByte! > 0);
  assert.equal(result.total, undefined, 'tail reads drop total');
});

test('readRunLog fromEnd: a file smaller than the window returns every line and reports atStart', async () => {
  const runDir = await tmpRunDir();
  const lines = Array.from({ length: 3 }, (_, i) => fmt(i + 1, `line ${i + 1}`));
  await writeRunLog(runDir, lines);

  const result = await readRunLog(runDir, { fromEnd: true, limit: 2000 });
  assert.equal(result.lines.length, 3);
  assert.equal(result.atStart, true);
  assert.equal(result.startByte, 0);
});

test('readRunLog fromEnd: a file with no trailing newline still returns its last (unterminated) line', async () => {
  const runDir = await tmpRunDir();
  const lines = Array.from({ length: 5 }, (_, i) => fmt(i + 1, `line ${i + 1}`));
  // Write without the trailing newline formatLogLine normally leaves on the file.
  await writeFile(join(runDir, RUN_LOG_NAME), lines.join('\n'), 'utf8');

  const result = await readRunLog(runDir, { fromEnd: true, limit: 2 });
  assert.equal(result.lines.length, 2);
  assert.ok(result.lines[1].includes('line 5'));
});

test('readRunLog beforeByte: pages backward from a prior startByte, down to byte 0', async () => {
  const runDir = await tmpRunDir();
  const lines = Array.from({ length: 30 }, (_, i) => fmt(i + 1, `line ${i + 1}`));
  await writeRunLog(runDir, lines);

  const tail = await readRunLog(runDir, { fromEnd: true, limit: 10 });
  assert.equal(tail.lines.length, 10);
  assert.ok(tail.lines[0].includes('line 21'));

  const earlier = await readRunLog(runDir, { beforeByte: tail.startByte!, limit: 10 });
  assert.equal(earlier.lines.length, 10);
  assert.ok(earlier.lines[0].includes('line 11'));
  assert.ok(earlier.lines[9].includes('line 20'));
  assert.equal(earlier.atStart, false);

  const start = await readRunLog(runDir, { beforeByte: earlier.startByte!, limit: 100 });
  assert.equal(start.lines.length, 10);
  assert.ok(start.lines[0].includes('line 1'));
  assert.ok(start.lines[9].includes('line 10'));
  assert.equal(start.atStart, true);
  assert.equal(start.startByte, 0);
});

test('readRunLog fromEnd: a missing run.log reads as empty and atStart', async () => {
  const runDir = await tmpRunDir();
  const result = await readRunLog(runDir, { fromEnd: true, limit: 10 });
  assert.deepEqual(result.lines, []);
  assert.equal(result.atStart, true);
});

test('readRunLog offset mode is unchanged: forward paging with total/truncated', async () => {
  const runDir = await tmpRunDir();
  const lines = Array.from({ length: 5 }, (_, i) => fmt(i + 1, `line ${i + 1}`));
  await writeRunLog(runDir, lines);

  const result = await readRunLog(runDir, { offset: 1, limit: 2 });
  assert.equal(result.lines.length, 2);
  assert.ok(result.lines[0].includes('line 2'));
  assert.equal(result.total, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.startByte, undefined, 'offset mode drops startByte');
});

test('readRunLog fromEnd: multi-byte UTF-8 content near a window boundary is not corrupted', async () => {
  const runDir = await tmpRunDir();
  const lines = Array.from({ length: 20 }, (_, i) => fmt(i + 1, `emoji \u{1F600} turn ${i + 1}`));
  await writeRunLog(runDir, lines);

  const result = await readRunLog(runDir, { fromEnd: true, limit: 3 });
  assert.equal(result.lines.length, 3);
  for (const line of result.lines) {
    assert.ok(line.includes('\u{1F600}'), `expected an intact emoji in: ${line}`);
  }
});
