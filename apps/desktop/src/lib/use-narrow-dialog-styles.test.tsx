import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNarrowDialogStyles } from './use-narrow-dialog-styles.ts';

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', () => ({ matches, addEventListener() {}, removeEventListener() {} }));
}

describe('useNarrowDialogStyles', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is empty at wide width', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useNarrowDialogStyles());
    expect(result.current).toEqual({ surface: undefined, actions: undefined });
  });

  it('takes near-full width and wraps actions at narrow width', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useNarrowDialogStyles());
    expect(result.current.surface?.width).toBe('calc(100vw - 24px)');
    expect(result.current.surface?.overflowY).toBe('auto');
    expect(result.current.actions?.flexWrap).toBe('wrap');
  });
});
