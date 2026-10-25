import { describe, expect, it } from 'vitest';
import { ACTIONS } from './actions.ts';
import { chordFromEvent, chordLabel, formatChord, matchesChord, parseChord, sameChord } from './chord.ts';

const event = (over: Partial<{ key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
  ({ key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over });

describe('parseChord / formatChord', () => {
  it('round-trips every default chord in the catalogue', () => {
    for (const action of ACTIONS) {
      for (const text of [action.defaultChord.mac, action.defaultChord.other]) {
        const parsed = parseChord(text);
        expect(parsed, text).not.toBeNull();
        expect(formatChord(parsed!)).toBe(text);
      }
    }
  });

  it.each(['', 'Mod', 'Mod+', 'Mod+Shift', 'Mod+KeyA+KeyB', 'Super+KeyA', 'Alt+Mod+KeyA', 'Mod+Mod+KeyA', 'Mod+Key A', 'mod+KeyA'])(
    'rejects %j',
    text => expect(parseChord(text)).toBeNull(),
  );

  it('parses a lone key and the full modifier set', () => {
    expect(parseChord('KeyA')).toEqual({ mod: false, ctrl: false, alt: false, shift: false, code: 'KeyA' });
    expect(formatChord(parseChord('Mod+Ctrl+Alt+Shift+Comma')!)).toBe('Mod+Ctrl+Alt+Shift+Comma');
  });
});

describe('chordFromEvent', () => {
  it('maps Cmd to Mod and Ctrl to Ctrl on macOS', () => {
    expect(formatChord(chordFromEvent(event({ code: 'KeyW', metaKey: true, altKey: true }), true))).toBe('Mod+Alt+KeyW');
    expect(formatChord(chordFromEvent(event({ code: 'Tab', ctrlKey: true, shiftKey: true }), true))).toBe('Ctrl+Shift+Tab');
  });

  it('maps Ctrl and Meta alike to Mod elsewhere', () => {
    expect(formatChord(chordFromEvent(event({ code: 'KeyK', ctrlKey: true }), false))).toBe('Mod+KeyK');
    expect(formatChord(chordFromEvent(event({ code: 'KeyK', metaKey: true }), false))).toBe('Mod+KeyK');
  });
});

describe('matchesChord', () => {
  const find = parseChord('Mod+KeyF')!;

  it('compares on code plus exact modifiers', () => {
    expect(matchesChord(event({ code: 'KeyF', ctrlKey: true }), find, false)).toBe(true);
    expect(matchesChord(event({ code: 'KeyF', metaKey: true }), find, false)).toBe(true);
    expect(matchesChord(event({ code: 'KeyF' }), find, false)).toBe(false);
    expect(matchesChord(event({ code: 'KeyG', ctrlKey: true }), find, false)).toBe(false);
    expect(matchesChord(event({ code: 'KeyF', ctrlKey: true, shiftKey: true }), find, false)).toBe(false);
    expect(matchesChord(event({ code: 'KeyF', ctrlKey: true, altKey: true }), find, false)).toBe(false);
  });

  it('matches by physical key whatever character Alt produced', () => {
    const close = parseChord('Mod+Alt+KeyW')!;
    expect(matchesChord(event({ key: '∑', code: 'KeyW', ctrlKey: true, altKey: true }), close, false)).toBe(true);
  });

  it('falls back to the letter in key for a synthetic event without a code', () => {
    expect(matchesChord(event({ key: 'F', ctrlKey: true }), find, false)).toBe(true);
  });

  it('keeps Mod to Cmd and Ctrl+Tab to the physical Ctrl key on macOS', () => {
    const tab = parseChord('Ctrl+Tab')!;
    expect(matchesChord(event({ code: 'KeyF', metaKey: true }), find, true)).toBe(true);
    expect(matchesChord(event({ code: 'KeyF', ctrlKey: true }), find, true)).toBe(false);
    expect(matchesChord(event({ code: 'Tab', ctrlKey: true }), tab, true)).toBe(true);
    expect(matchesChord(event({ code: 'Tab', metaKey: true }), tab, true)).toBe(false);
  });

  it('matches Ctrl+Tab on the Ctrl key elsewhere', () => {
    const tab = parseChord('Ctrl+Tab')!;
    expect(matchesChord(event({ code: 'Tab', ctrlKey: true }), tab, false)).toBe(true);
    expect(matchesChord(event({ code: 'Tab' }), tab, false)).toBe(false);
  });
});

describe('chordLabel', () => {
  const label = (text: string, mac: boolean) => chordLabel(parseChord(text)!, mac);

  it('spells out Ctrl, Alt and Shift off macOS', () => {
    expect(label('Ctrl+Tab', false)).toBe('Ctrl+Tab');
    expect(label('Ctrl+Shift+Tab', false)).toBe('Ctrl+Shift+Tab');
    expect(label('Mod+Alt+KeyW', false)).toBe('Ctrl+Alt+W');
    expect(label('Mod+PageDown', false)).toBe('Ctrl+PageDown');
    expect(label('Mod+Alt+Digit1', false)).toBe('Ctrl+Alt+1');
    expect(label('Mod+Comma', false)).toBe('Ctrl+Comma');
  });

  it('uses ⌃ for the Tab chords but ⌘ for the rest on macOS', () => {
    expect(label('Ctrl+Tab', true)).toBe('⌃Tab');
    expect(label('Ctrl+Shift+Tab', true)).toBe('⌃⇧Tab');
    expect(label('Mod+Alt+KeyW', true)).toBe('⌘⌥W');
    expect(label('Mod+Alt+ArrowRight', true)).toBe('⌘⌥→');
    expect(label('Mod+Alt+ArrowLeft', true)).toBe('⌘⌥←');
  });
});

describe('sameChord', () => {
  it('folds Ctrl into Mod off macOS only', () => {
    expect(sameChord('Mod+Tab', 'Ctrl+Tab', false)).toBe(true);
    expect(sameChord('Mod+Tab', 'Ctrl+Tab', true)).toBe(false);
    expect(sameChord('Mod+Shift+Tab', 'Ctrl+Tab', false)).toBe(false);
    expect(sameChord(null, null, false)).toBe(true);
    expect(sameChord(null, 'Mod+KeyW', false)).toBe(false);
  });
});
