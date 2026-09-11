import { describe, expect, it, vi } from 'vitest';
import { debounce, formatWindowTitle } from './window-state.ts';

describe('debounce', () => {
  it('collapses a burst into one trailing call with the last args', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const d = debounce(spy, 500);
    d(1); d(2); d(3);
    vi.advanceTimersByTime(499);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(3);
    vi.useRealTimers();
  });
});

describe('formatWindowTitle', () => {
  it('reflects idle, running, and needs-input states', () => {
    expect(formatWindowTitle(0, 0)).toBe('Whiphand');
    expect(formatWindowTitle(2, 0)).toBe('▶ 2 running — Whiphand');
    expect(formatWindowTitle(2, 1)).toBe('⌨ input needed — Whiphand');
  });
});
