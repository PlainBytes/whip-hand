import { describe, expect, it } from 'vitest';
import { parsePositiveInt } from './parse-number.ts';

describe('parsePositiveInt', () => {
  it('reads a positive whole number, ignoring surrounding whitespace', () => {
    expect(parsePositiveInt('1')).toBe(1);
    expect(parsePositiveInt('  12 ')).toBe(12);
    expect(parsePositiveInt('007')).toBe(7);
  });

  it('rejects trailing junk that parseInt would silently drop', () => {
    expect(parsePositiveInt('12abc')).toBeUndefined();
    expect(parsePositiveInt('3.5')).toBeUndefined();
    expect(parsePositiveInt('1 2')).toBeUndefined();
  });

  it('rejects the forms Number alone would accept', () => {
    expect(parsePositiveInt('1e3')).toBeUndefined();
    expect(parsePositiveInt('0x10')).toBeUndefined();
    expect(parsePositiveInt('+4')).toBeUndefined();
    expect(parsePositiveInt('')).toBeUndefined();
    expect(parsePositiveInt('   ')).toBeUndefined();
  });

  it('rejects zero, negatives, and counts too large to hold exactly', () => {
    expect(parsePositiveInt('0')).toBeUndefined();
    expect(parsePositiveInt('-1')).toBeUndefined();
    expect(parsePositiveInt('99999999999999999999')).toBeUndefined();
  });
});
