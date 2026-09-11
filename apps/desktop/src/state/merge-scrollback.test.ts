import { describe, expect, it } from 'vitest';
import { mergeScrollback } from './store.ts';

/**
 * The invariant every case here defends: buffer[i] is absolute chunk
 * baseIndex + i. TerminalPanel's replay arithmetic is built on it, and a
 * violation shows up as a silently mis-ordered terminal rather than an error.
 */
function assertInvariant(
  result: { buffer: string[]; baseIndex: number },
  expectedAbsolute: Record<number, string>,
) {
  for (let i = 0; i < result.buffer.length; i++) {
    const absolute = result.baseIndex + i;
    expect(result.buffer[i], `absolute chunk ${absolute}`).toBe(expectedAbsolute[absolute]);
  }
}

const ALL = { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e', 5: 'f' };

describe('mergeScrollback', () => {
  it('takes the snapshot wholesale when nothing has been buffered yet', () => {
    const result = mergeScrollback(
      { buffer: [], baseIndex: 0 },
      { chunks: ['a', 'b', 'c'], baseIndex: 0 },
    );
    expect(result).toEqual({ buffer: ['a', 'b', 'c'], baseIndex: 0, trimmed: false });
  });

  it('marks a snapshot that itself starts late as trimmed', () => {
    const result = mergeScrollback(
      { buffer: [], baseIndex: 0 },
      { chunks: ['d', 'e'], baseIndex: 3 },
    );
    expect(result).toEqual({ buffer: ['d', 'e'], baseIndex: 3, trimmed: true });
    assertInvariant(result, ALL);
  });

  it('keeps the live buffer when the snapshot is empty', () => {
    const result = mergeScrollback(
      { buffer: ['e', 'f'], baseIndex: 4 },
      { chunks: [], baseIndex: 0 },
    );
    expect(result).toEqual({ buffer: ['e', 'f'], baseIndex: 4, trimmed: true });
  });

  // The case this whole mechanism exists for: the socket delivered the tail
  // while the snapshot request was still in flight.
  it('prepends an older snapshot in front of live chunks (contiguous)', () => {
    const result = mergeScrollback(
      { buffer: ['d', 'e', 'f'], baseIndex: 3 },
      { chunks: ['a', 'b', 'c'], baseIndex: 0 },
    );
    expect(result.baseIndex).toBe(0);
    expect(result.buffer).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(result.trimmed).toBe(false);
    assertInvariant(result, ALL);
  });

  it('deduplicates an overlap rather than repeating chunks', () => {
    const result = mergeScrollback(
      { buffer: ['c', 'd', 'e'], baseIndex: 2 },
      { chunks: ['a', 'b', 'c', 'd'], baseIndex: 0 },
    );
    expect(result.buffer).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.baseIndex).toBe(0);
    assertInvariant(result, ALL);
  });

  it('handles a snapshot that fully contains the live buffer', () => {
    const result = mergeScrollback(
      { buffer: ['c'], baseIndex: 2 },
      { chunks: ['a', 'b', 'c', 'd'], baseIndex: 0 },
    );
    expect(result.buffer).toEqual(['a', 'b', 'c', 'd']);
    expect(result.baseIndex).toBe(0);
    assertInvariant(result, ALL);
  });

  it('handles a snapshot newer than the live buffer', () => {
    const result = mergeScrollback(
      { buffer: ['a', 'b'], baseIndex: 0 },
      { chunks: ['c', 'd'], baseIndex: 2 },
    );
    expect(result.buffer).toEqual(['a', 'b', 'c', 'd']);
    expect(result.baseIndex).toBe(0);
    assertInvariant(result, ALL);
  });

  it('abutting ranges join with no gap and no duplicate', () => {
    const result = mergeScrollback(
      { buffer: ['c', 'd'], baseIndex: 2 },
      { chunks: ['a', 'b'], baseIndex: 0 },
    );
    expect(result.buffer).toEqual(['a', 'b', 'c', 'd']);
    assertInvariant(result, ALL);
  });

  it('a gap keeps the newer side and reports the loss', () => {
    // The server trimmed past what this client already holds; the middle is
    // genuinely gone, and a flat buffer cannot represent a hole.
    const result = mergeScrollback(
      { buffer: ['e', 'f'], baseIndex: 4 },
      { chunks: ['a'], baseIndex: 0 },
    );
    expect(result).toEqual({ buffer: ['e', 'f'], baseIndex: 4, trimmed: true });
    assertInvariant(result, ALL);
  });

  it('a gap the other way keeps the snapshot', () => {
    const result = mergeScrollback(
      { buffer: ['a'], baseIndex: 0 },
      { chunks: ['e', 'f'], baseIndex: 4 },
    );
    expect(result).toEqual({ buffer: ['e', 'f'], baseIndex: 4, trimmed: true });
    assertInvariant(result, ALL);
  });

  it('the live buffer wins where the two disagree', () => {
    // Same absolute position, different content: the snapshot is a moment
    // older, so live is preferred rather than assuming a strict prefix.
    const result = mergeScrollback(
      { buffer: ['LIVE'], baseIndex: 1 },
      { chunks: ['a', 'SNAP'], baseIndex: 0 },
    );
    expect(result.buffer).toEqual(['a', 'LIVE']);
  });

  it('merging is stable when applied twice', () => {
    const once = mergeScrollback(
      { buffer: ['d', 'e'], baseIndex: 3 },
      { chunks: ['a', 'b', 'c'], baseIndex: 0 },
    );
    const twice = mergeScrollback(once, { chunks: ['a', 'b', 'c'], baseIndex: 0 });
    expect(twice.buffer).toEqual(once.buffer);
    expect(twice.baseIndex).toBe(once.baseIndex);
  });
});
