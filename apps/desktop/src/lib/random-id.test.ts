import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from './random-id.ts';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Stand in for an insecure context: `getRandomValues` exists, `randomUUID` does not. */
function stubInsecureCrypto(): void {
  const real = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real), randomUUID: undefined });
}

describe('randomId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds a v4 UUID from getRandomValues when randomUUID is missing', () => {
    stubInsecureCrypto();
    const ids = Array.from({ length: 1000 }, () => randomId());
    for (const id of ids) expect(id).toMatch(V4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses the native randomUUID when it exists', () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('11111111-2222-4333-8444-555555555555');
    try {
      expect(randomId()).toBe('11111111-2222-4333-8444-555555555555');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('returns a v4 UUID with the native randomUUID', () => {
    expect(randomId()).toMatch(V4);
  });
});
