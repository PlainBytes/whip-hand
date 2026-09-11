import { describe, expect, it } from 'vitest';
import { bytesToBase64, decodeBase64ToBytes, encodeToBase64 } from './base64.ts';

describe('base64 codec', () => {
  it('round-trips ASCII', () => {
    const encoded = encodeToBase64('hello');
    expect(encoded).toBe(btoa('hello'));
    const decoded = decodeBase64ToBytes(encoded);
    expect(new TextDecoder().decode(decoded)).toBe('hello');
  });

  it('round-trips unicode outside the Latin1 range (accented + astral characters)', () => {
    const text = 'héllo→🚀';
    const encoded = encodeToBase64(text);
    // A bare btoa() on the raw UTF-16 string would throw for characters
    // outside Latin1 (é, →, 🚀) — proves we went through TextEncoder/UTF-8 bytes.
    expect(() => btoa(text)).toThrow();
    const decoded = decodeBase64ToBytes(encoded);
    expect(new TextDecoder().decode(decoded)).toBe(text);
  });

  it('round-trips an empty string', () => {
    const encoded = encodeToBase64('');
    expect(encoded).toBe('');
    expect(decodeBase64ToBytes(encoded)).toEqual(new Uint8Array(0));
  });

  it('decodeBase64ToBytes returns the exact UTF-8 byte sequence', () => {
    // '🚀' is a 4-byte UTF-8 sequence (U+1F680): F0 9F 9A 80.
    const encoded = encodeToBase64('🚀');
    expect(Array.from(decodeBase64ToBytes(encoded))).toEqual([0xf0, 0x9f, 0x9a, 0x80]);
  });

  it('bytesToBase64 round-trips raw bytes that are not UTF-8, across more than one chunk', () => {
    // Every byte value, repeated past the 32 KB chunk boundary: a pasted
    // image is exactly this kind of input, and the chunk seams must not
    // drop or duplicate anything.
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(decodeBase64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
