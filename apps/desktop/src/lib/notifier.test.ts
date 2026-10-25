import { describe, expect, it, vi } from 'vitest';
import { createTauriNotificationClicks, noopNotificationClicks } from './notifier.ts';

describe('createTauriNotificationClicks', () => {
  it('is the no-op outside Tauri', () => {
    expect('__TAURI_INTERNALS__' in window).toBe(false);
    expect(createTauriNotificationClicks()).toBe(noopNotificationClicks);
    const unsubscribe = noopNotificationClicks(vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});
