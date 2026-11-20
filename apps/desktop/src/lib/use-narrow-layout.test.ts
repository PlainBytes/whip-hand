import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { NARROW_MAX_WIDTH, useNarrowLayout } from './use-narrow-layout.ts';

/** A matchMedia stub whose `max-width` query is judged against `width`, and which can fire change. */
export function stubMatchMedia(width: number) {
  const listeners = new Set<() => void>();
  const state = { width };
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return state.width <= Number(/max-width:\s*(\d+)px/.exec(query)?.[1]); },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return { resize(next: number) { state.width = next; listeners.forEach(fn => fn()); }, listeners };
}

describe('useNarrowLayout', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is narrow at the breakpoint and below, wide above', () => {
    stubMatchMedia(NARROW_MAX_WIDTH);
    expect(renderHook(() => useNarrowLayout()).result.current).toBe(true);
    stubMatchMedia(NARROW_MAX_WIDTH + 1);
    expect(renderHook(() => useNarrowLayout()).result.current).toBe(false);
  });

  it('follows a media-query change and unsubscribes on unmount', () => {
    const media = stubMatchMedia(1000);
    const { result, unmount } = renderHook(() => useNarrowLayout());
    expect(result.current).toBe(false);
    act(() => media.resize(390));
    expect(result.current).toBe(true);
    act(() => media.resize(1000));
    expect(result.current).toBe(false);
    unmount();
    expect(media.listeners.size).toBe(0);
  });

  it('is never narrow without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(renderHook(() => useNarrowLayout()).result.current).toBe(false);
  });
});
