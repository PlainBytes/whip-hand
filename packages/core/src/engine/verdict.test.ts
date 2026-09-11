import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from './verdict.ts';

test('parses pass and fail, case-insensitive, first line only', () => {
  assert.equal(parseVerdict('VERDICT: PASS\nall good'), 'pass');
  assert.equal(parseVerdict('verdict: fail\nproblems'), 'fail');
  assert.equal(parseVerdict('summary\nVERDICT: FAIL'), null);
  assert.equal(parseVerdict('no verdict here'), null);
});
