import { describe, expect, it } from 'vitest';
import { PAGES } from '../../nav.ts';
import { ACTIONS, pageActionId } from './actions.ts';
import { actionLabel, matchesTerminalPassthrough, resolveKeymap } from './keymap.ts';

const TODAY_OTHER: Record<string, string> = {
  'tabs.next': 'Mod+PageDown',
  'tabs.previous': 'Mod+PageUp',
  'tabs.nextInWorkspace': 'Ctrl+Tab',
  'tabs.nextAll': 'Ctrl+Shift+Tab',
  'tabs.close': 'Mod+Alt+KeyW',
  'tabs.newRun': 'Mod+Alt+KeyN',
  'tabs.runsList': 'Mod+Alt+Digit1',
  'tabs.goTo1': 'Mod+Alt+Digit2',
  'tabs.goTo2': 'Mod+Alt+Digit3',
  'tabs.goTo3': 'Mod+Alt+Digit4',
  'tabs.goTo4': 'Mod+Alt+Digit5',
  'tabs.goTo5': 'Mod+Alt+Digit6',
  'tabs.goTo6': 'Mod+Alt+Digit7',
  'tabs.goTo7': 'Mod+Alt+Digit8',
  'tabs.goTo8': 'Mod+Alt+Digit9',
  'tabs.reopenClosed': 'Mod+Alt+Shift+KeyT',
  'workspace.quickSwitch': 'Mod+KeyK',
  'workspace.previous': 'Mod+Alt+KeyP',
  'page.preferences': 'Mod+Comma',
  'run.focusTerminal': 'Mod+Alt+KeyT',
  'run.openInEditor': 'Mod+Alt+KeyE',
  'files.find': 'Mod+KeyF',
};

describe('page actions', () => {
  it('has an action for every page', () => {
    for (const def of PAGES) expect(ACTIONS.map(a => a.id), def.id).toContain(pageActionId(def.id));
  });
});

describe('resolveKeymap', () => {
  it("yields today's chord for each bound action", () => {
    expect(ACTIONS).toHaveLength(Object.keys(TODAY_OTHER).length + 2 + 9 + 6);
    const other = resolveKeymap({}, false);
    expect(other.get('tabs.closeOthers')).toBeNull();
    expect(other.get('tabs.keepPreview')).toBeNull();
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
  const base = { key: '', code: '', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };

  it('is true for the Ctrl+Tab pair and false for Ctrl/Cmd+K', () => {
    const keymap = resolveKeymap({}, false);
    expect(matchesTerminalPassthrough(keymap, { ...base, code: 'Tab' })).toBe(true);
    expect(matchesTerminalPassthrough(keymap, { ...base, code: 'Tab', shiftKey: true })).toBe(true);
    expect(matchesTerminalPassthrough(keymap, { ...base, code: 'KeyK' })).toBe(false);
  });

  it('follows overrides: the new chord passes through, the old one and unbound ones do not', () => {
    const keymap = resolveKeymap({ 'tabs.nextInWorkspace': 'Ctrl+KeyJ', 'tabs.nextAll': null }, false);
    expect(matchesTerminalPassthrough(keymap, { ...base, code: 'KeyJ' })).toBe(true);
    expect(matchesTerminalPassthrough(keymap, { ...base, code: 'Tab' })).toBe(false);
    expect(matchesTerminalPassthrough(keymap, { ...base, code: 'Tab', shiftKey: true })).toBe(false);
  });
});

describe('actionLabel', () => {
  it('labels the effective chord and says unbound for null', () => {
    const keymap = resolveKeymap({ 'tabs.newRun': 'Ctrl+Shift+KeyJ', 'tabs.close': null }, false);
    expect(actionLabel(keymap, 'tabs.newRun')).toBe('Ctrl+Shift+J');
    expect(actionLabel(keymap, 'tabs.close')).toBe('unbound');
  });
});
