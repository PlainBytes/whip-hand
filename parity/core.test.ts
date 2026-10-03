/**
 * The TypeScript side of the core parity corpus: every suite's ops, run
 * through packages/core, must reproduce the checked-in golden. The Rust side
 * (crates/whiphand-core/tests/parity.rs) checks the same golden, so the two
 * implementations agree whenever both are green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SUITES_DIR, GOLDEN_DIR, canonical, formatLines, readLines, runOp } from './core-probe.ts';
import type { Op } from './core-probe.ts';
import { GENERATED_SUITES } from './core-corpus.ts';

// A new schema.test.ts case or workflow fixture has to reach the Rust side
// too, so a generated suite that no longer matches its sources fails here.
for (const [name, make] of Object.entries(GENERATED_SUITES)) {
  test(`core parity: suites/${name}.json is current with its sources`, () => {
    const onDisk = readFileSync(path.join(SUITES_DIR, `${name}.json`), 'utf8');
    assert.equal(formatLines(make().map(canonical)), onDisk,
      `suites/${name}.json is stale — run \`npm run parity:core-golden\` and review the diff`);
  });
}

for (const file of readdirSync(SUITES_DIR).filter(f => f.endsWith('.json')).sort()) {
  test(`core parity: ${file} matches its golden`, async () => {
    const ops = readLines(path.join(SUITES_DIR, file));
    const golden = readLines(path.join(GOLDEN_DIR, file));
    assert.equal(ops.length, golden.length,
      `${file}: ${ops.length} ops but ${golden.length} golden results — regenerate with \`npm run parity:core-golden\``);
    for (const [i, line] of ops.entries()) {
      assert.equal(await runOp(JSON.parse(line) as Op), golden[i], `${file} op #${i + 1}: ${line}`);
    }
  });
}
