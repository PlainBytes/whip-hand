import { describe, expect, it } from 'vitest';
import { spinInteger } from './spin-value.ts';

describe('spinInteger', () => {
  it('takes a stepped value as is', () => {
    expect(spinInteger({ value: 5 }, { min: 1 })).toBe(5);
  });

  it('falls back to the typed text when the value is absent or null', () => {
    expect(spinInteger({ displayValue: '12' }, { min: 1 })).toBe(12);
    expect(spinInteger({ value: null, displayValue: '12' }, { min: 1 })).toBe(12);
  });

  it('refuses blank, fractional, and non-numeric text', () => {
    expect(spinInteger({ value: null, displayValue: '' }, { min: 1 })).toBeUndefined();
    expect(spinInteger({ displayValue: '1.5' }, { min: 1 })).toBeUndefined();
    expect(spinInteger({ displayValue: 'abc' }, { min: 1 })).toBeUndefined();
  });

  it('refuses anything outside the bounds, inclusive at both ends', () => {
    const port = { min: 1024, max: 65535 };
    expect(spinInteger({ value: 1023 }, port)).toBeUndefined();
    expect(spinInteger({ value: 1024 }, port)).toBe(1024);
    expect(spinInteger({ value: 65535 }, port)).toBe(65535);
    expect(spinInteger({ displayValue: '65536' }, port)).toBeUndefined();
  });
});
