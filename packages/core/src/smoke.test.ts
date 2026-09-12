import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORE_VERSION } from './index.ts';

// Against core's own package.json rather than a literal: a literal here is a
// tenth version location that scripts/version.mjs does not know about, so the
// first real bump broke this test and every later one would have too. What is
// worth pinning is that the `CORE_VERSION` literal agrees with the package —
// the thing `whiphand --version` prints — not which number it happens to be.
test('toolchain runs TypeScript tests natively', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(CORE_VERSION, pkg.version);
});
