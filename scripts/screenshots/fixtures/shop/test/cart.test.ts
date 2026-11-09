import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/cart.ts';

test('cart totals round to cents', () => {
  assert.equal(total([{ sku: 'mug', unitPrice: 9.99, quantity: 3 }], 0.2), 3596);
});
