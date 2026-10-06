import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, median, flatten, compare, formatCompare } from './bench/stats.mjs';
import { buildLargeRunLog, smallRunManifest, rng } from './bench/fixtures.mjs';
import { parseLogLine } from '../apps/desktop/src/shared/log-rows.ts';

// The pure half of scripts/bench.mjs. The measuring half spawns real
// processes and a browser and is run by hand (docs/benchmarks.md).

test('percentile is nearest-rank over an ascending array', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(sorted, 50), 5);
  assert.equal(percentile(sorted, 95), 10);
  assert.equal(percentile(sorted, 0), 1);
  assert.equal(percentile([], 50), null);
});

test('summarize sorts, drops non-finite samples and rounds', () => {
  assert.deepEqual(summarize([3.333, 1, NaN, 2]), { n: 3, median: 2, p95: 3.33, p99: 3.33, min: 1, max: 3.33 });
  assert.deepEqual(summarize([]), { n: 0, median: null, p95: null, p99: null, min: null, max: null });
});

test('median ignores nulls from a failed repeat', () => {
  assert.equal(median([5, null, 1, 3]), 3);
  assert.equal(median([null]), null);
});

test('flatten keeps a summary block\'s median and p95 only', () => {
  const flat = flatten({ cli: { help: summarize([1, 2, 3]) }, sizes: { cliBytes: 10, agentBytes: null } });
  assert.deepEqual(flat, { 'cli.help.median': 2, 'cli.help.p95': 3, 'sizes.cliBytes': 10, 'sizes.agentBytes': null });
});

test('compare reports the relative change, and none where either side is missing', () => {
  const rows = compare({ a: 100, b: 5, c: 0 }, { a: 50, c: 1, d: 2 });
  assert.deepEqual(rows, [
    { name: 'a', before: 100, after: 50, delta: -0.5 },
    { name: 'b', before: 5, after: null, delta: null },
    { name: 'c', before: 0, after: 1, delta: null },
    { name: 'd', before: null, after: 2, delta: null },
  ]);
  const table = formatCompare(rows, ['base', 'now']);
  assert.match(table, /^\| metric \| base \| now \| change \|/);
  assert.match(table, /\| a \| 100 \| 50 \| -50\.0% \|/);
});

test('rng is deterministic per seed', () => {
  const a = rng(7);
  const b = rng(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('the large run log has exactly the requested lines, all parseable by core', () => {
  const lines = buildLargeRunLog(1_000);
  assert.equal(lines.length, 1_000);
  assert.deepEqual(buildLargeRunLog(1_000), lines, 'seeded, so every phase measures the same bytes');
  const rows = lines.map(line => parseLogLine(line.replace(/\n$/, '')));
  assert.ok(rows.every(row => row !== null));
  assert.deepEqual(rows.map(row => row.seq), Array.from({ length: 1_000 }, (_, i) => i + 1));
  assert.ok(rows.some(row => row.stream === 'stderr'));
  assert.equal(rows.filter(row => row.kind === 'step:start').length, 3);
});

test('small run manifests have unique, well-formed run ids and a terminal status', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) {
    const manifest = smallRunManifest(i, 'workspace');
    assert.match(manifest.runId, /^\d{8}-\d{6}-[0-9a-z]{4}$/);
    assert.ok(['succeeded', 'failed'].includes(manifest.status));
    ids.add(manifest.runId);
  }
  assert.equal(ids.size, 500);
});
