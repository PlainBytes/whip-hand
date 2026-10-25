import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModalOpen } from './tab-shortcuts.ts';

describe('isModalOpen', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('is false on a bare page and true once a dialog is up', () => {
    expect(isModalOpen()).toBe(false);
    document.body.innerHTML = '<div role="dialog"></div>';
    expect(isModalOpen()).toBe(true);
  });
});
