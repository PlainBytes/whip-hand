/**
 * Regenerates the core parity corpus from the TypeScript implementation —
 * an explicit act (`npm run parity:core-golden`), never done by a test, so a
 * failing comparison cannot quietly rewrite its own expectation. Writes the
 * generated suites (see core-corpus.ts), then every suite's golden results.
 * Review the diff: it shows exactly which results moved.
 */
import { readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SUITES_DIR, GOLDEN_DIR, canonical, formatLines, readLines, runOp } from './core-probe.ts';
import type { Op } from './core-probe.ts';
import { GENERATED_SUITES } from './core-corpus.ts';

mkdirSync(SUITES_DIR, { recursive: true });
for (const [name, make] of Object.entries(GENERATED_SUITES)) {
  writeFileSync(path.join(SUITES_DIR, `${name}.json`), formatLines(make().map(canonical)));
}

rmSync(GOLDEN_DIR, { recursive: true, force: true });
mkdirSync(GOLDEN_DIR, { recursive: true });
let total = 0;
for (const file of readdirSync(SUITES_DIR).filter(f => f.endsWith('.json')).sort()) {
  const ops = readLines(path.join(SUITES_DIR, file)).map(line => JSON.parse(line) as Op);
  const results: string[] = [];
  for (const op of ops) results.push(await runOp(op));
  writeFileSync(path.join(GOLDEN_DIR, file), formatLines(results));
  total += results.length;
}
console.log(`wrote ${total} results to ${path.relative(process.cwd(), GOLDEN_DIR)}`);
