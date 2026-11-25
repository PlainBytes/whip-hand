import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTerminalGuest } from './use-terminal-guest.ts';
import { useNarrowLayout } from './use-narrow-layout.ts';
import {
  PHONE_LANDSCAPE, PHONE_PORTRAIT, SHORT_DESKTOP_WINDOW, TABLET, stubScreen,
} from '../test/match-media.ts';

describe('useTerminalGuest', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a guest on a phone in portrait', () => {
    stubScreen(PHONE_PORTRAIT);
    expect(renderHook(() => useTerminalGuest()).result.current).toBe(true);
  });

  it('is a guest on a phone in landscape, which still gets the wide layout', () => {
    stubScreen(PHONE_LANDSCAPE);
    expect(renderHook(() => useTerminalGuest()).result.current).toBe(true);
    expect(renderHook(() => useNarrowLayout()).result.current).toBe(false);
  });

  it('is not a guest on a touch tablet', () => {
    stubScreen(TABLET);
    expect(renderHook(() => useTerminalGuest()).result.current).toBe(false);
  });

  it('is not a guest in a short mouse-driven window', () => {
    stubScreen(SHORT_DESKTOP_WINDOW);
    expect(renderHook(() => useTerminalGuest()).result.current).toBe(false);
  });

  it('is a guest in a narrow mouse-driven window, like the narrow layout', () => {
    stubScreen({ width: 600, height: 900, coarse: false });
    expect(renderHook(() => useTerminalGuest()).result.current).toBe(true);
  });

  it('stays a guest through a rotation, follows a live change, and unsubscribes on unmount', () => {
    const screen = stubScreen(PHONE_PORTRAIT);
    const seen: boolean[] = [];
    const { result, unmount } = renderHook(() => { const guest = useTerminalGuest(); seen.push(guest); return guest; });
    act(() => screen.change(PHONE_LANDSCAPE));
    act(() => screen.change(PHONE_PORTRAIT));
    expect(seen.every(Boolean)).toBe(true);

    act(() => screen.change(SHORT_DESKTOP_WINDOW));
    expect(result.current).toBe(false);
    act(() => screen.change(PHONE_LANDSCAPE));
    expect(result.current).toBe(true);
    unmount();
    expect(screen.listeners.size).toBe(0);
  });

  it('is never a guest without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(renderHook(() => useTerminalGuest()).result.current).toBe(false);
  });
});
