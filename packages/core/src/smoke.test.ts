import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_VERSION } from './index.ts';

test('toolchain runs TypeScript tests natively', () => {
  assert.equal(CORE_VERSION, '0.1.0');
});
