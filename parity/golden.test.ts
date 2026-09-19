import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { runScenario, GOLDEN_DIR } from './golden-scenario.ts';

function goldenFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap(name => {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    return statSync(path.join(dir, name)).isDirectory() ? goldenFiles(path.join(dir, name), rel) : [rel];
  }).sort();
}

test('the staged scenario produces byte-identical artifacts on every OS (one checked-in golden)', async () => {
  const bundle = await runScenario();
  assert.deepEqual(bundle.map(f => f.path), goldenFiles(GOLDEN_DIR),
    'the run produced a different set of artifacts than the golden — regenerate with `npm run parity:golden` only if that is intended');
  for (const file of bundle) {
    const expected = readFileSync(path.join(GOLDEN_DIR, ...file.path.split('/')));
    // Byte equality, line endings included: normalizing them would hide the exact
    // bug this test exists to catch, and a CRLF in an artifact is a genuine regression.
    assert.equal(file.bytes.toString('utf8'), expected.toString('utf8'), `${file.path} differs from the golden`);
    assert.ok(file.bytes.equals(expected), `${file.path}: bytes differ from the golden`);
  }
});
