import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(platform: string) {
  vi.resetModules();
  vi.stubGlobal('navigator', { platform });
  return import('./tab-shortcuts.ts');
}

describe('shortcutLabel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('spells out Ctrl, Alt and Shift off macOS', async () => {
    const m = await load('Linux x86_64');
    expect(m.shortcutLabel(m.WORKSPACE_NEXT_TAB)).toBe('Ctrl+Tab');
    expect(m.shortcutLabel(m.ALL_NEXT_TAB)).toBe('Ctrl+Shift+Tab');
    expect(m.shortcutLabel(m.CLOSE_TAB)).toBe('Ctrl+Alt+W');
    expect(m.shortcutLabel(m.NEXT_TAB)).toBe('Ctrl+PageDown');
  });

  it('uses ⌃ for the Tab chords but ⌘ for the rest on macOS', async () => {
    const m = await load('MacIntel');
    expect(m.shortcutLabel(m.WORKSPACE_NEXT_TAB)).toBe('⌃Tab');
    expect(m.shortcutLabel(m.ALL_NEXT_TAB)).toBe('⌃⇧Tab');
    expect(m.shortcutLabel(m.CLOSE_TAB)).toBe('⌘⌥W');
    expect(m.shortcutLabel(m.NEXT_TAB)).toBe('⌘⌥→');
  });
});
