/**
 * Regenerates parity/fixtures/golden/staged/ from the current tree — an
 * explicit act (`npm run parity:golden`), never done by a test, so a failing
 * comparison cannot quietly rewrite its own expectation. Review the diff: it
 * shows exactly which bytes moved.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runScenario, GOLDEN_DIR } from './golden-scenario.ts';

const bundle = await runScenario();
rmSync(GOLDEN_DIR, { recursive: true, force: true });
for (const file of bundle) {
  const target = path.join(GOLDEN_DIR, ...file.path.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, file.bytes);
}
console.log(`wrote ${bundle.length} files to ${path.relative(process.cwd(), GOLDEN_DIR)}`);
