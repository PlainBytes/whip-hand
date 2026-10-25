import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS } from './actions.ts';
import { resolveKeymap } from './keymap.ts';

const TODAY_OTHER: Record<string, string> = {
  'tabs.next': 'Mod+PageDown',
  'tabs.previous': 'Mod+PageUp',
  'tabs.nextInWorkspace': 'Ctrl+Tab',
  'tabs.nextAll': 'Ctrl+Shift+Tab',
  'tabs.close': 'Mod+Alt+KeyW',
  'tabs.newRun': 'Mod+Alt+KeyN',
  'tabs.runsList': 'Mod+Alt+Digit1',
  'workspace.quickSwitch': 'Mod+KeyK',
  'files.find': 'Mod+KeyF',
};

describe('resolveKeymap', () => {
  it("yields today's chord for each of the 9 actions", () => {
    expect(ACTIONS).toHaveLength(9);
    const other = resolveKeymap({}, false);
    for (const [id, chord] of Object.entries(TODAY_OTHER)) expect(other.get(id as never), id).toBe(chord);
    const mac = resolveKeymap({}, true);
    expect(mac.get('tabs.next')).toBe('Mod+Alt+ArrowRight');
    expect(mac.get('tabs.previous')).toBe('Mod+Alt+ArrowLeft');
    expect(mac.get('files.find')).toBe('Mod+KeyF');
  });

  it('applies a valid override and an explicit unbind', () => {
    const keymap = resolveKeymap({ 'tabs.close': 'Mod+KeyQ', 'files.find': null }, false);
    expect(keymap.get('tabs.close')).toBe('Mod+KeyQ');
    expect(keymap.get('files.find')).toBeNull();
  });

  it('ignores unknown ids and bad chords', () => {
    const keymap = resolveKeymap({ 'no.such.action': 'Mod+KeyA', 'tabs.close': 'Mod+', 'tabs.newRun': 'nonsense' }, false);
    expect(keymap.size).toBe(ACTIONS.length);
    expect(keymap.has('no.such.action' as never)).toBe(false);
    expect(keymap.get('tabs.close')).toBe('Mod+Alt+KeyW');
    expect(keymap.get('tabs.newRun')).toBe('Mod+Alt+KeyN');
  });
});

describe('matchesTerminalPassthrough', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is true for the Ctrl+Tab pair and false for Ctrl/Cmd+K', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' });
    const { matchesTerminalPassthrough } = await import('./keymap.ts');
    const base = { key: '', code: '', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    expect(matchesTerminalPassthrough({ ...base, code: 'Tab' })).toBe(true);
    expect(matchesTerminalPassthrough({ ...base, code: 'Tab', shiftKey: true })).toBe(true);
    expect(matchesTerminalPassthrough({ ...base, code: 'KeyK' })).toBe(false);
  });
});
