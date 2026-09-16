import { describe, expect, it } from 'vitest';
import { nonNegativeOrUndefined, numberOrUndefined } from './number-field.ts';

describe('numberOrUndefined', () => {
  it('reads a positive integer', () => {
    expect(numberOrUndefined('30000')).toBe(30000);
  });

  it('clears the field for blank, zero, negative, and garbage', () => {
    for (const raw of ['', '0', '-3', 'abc']) expect(numberOrUndefined(raw)).toBeUndefined();
  });

  it('keeps parseInt leniency: leading digits win', () => {
    expect(numberOrUndefined('12s')).toBe(12);
    expect(numberOrUndefined('1.5')).toBe(1);
  });
});

describe('nonNegativeOrUndefined', () => {
  it('reads zero as a real value, and a positive integer', () => {
    expect(nonNegativeOrUndefined('0')).toBe(0);
    expect(nonNegativeOrUndefined('3')).toBe(3);
  });

  it('clears the field for blank, negative, and garbage', () => {
    for (const raw of ['', '-1', 'abc']) expect(nonNegativeOrUndefined(raw)).toBeUndefined();
  });
});
