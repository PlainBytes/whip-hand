import { describe, expect, it } from 'vitest';
import { errorMessage } from './error-message.ts';

describe('errorMessage', () => {
  it('reads an Error\'s message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies anything else', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});
