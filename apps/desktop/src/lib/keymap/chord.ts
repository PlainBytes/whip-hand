/**
 * Key chords as strings, e.g. "Mod+Alt+KeyW", "Ctrl+Tab", "Mod+Comma": modifiers
 * from Mod | Ctrl | Alt | Shift in that order, then one KeyboardEvent.code.
 *
 * `Mod` is Ctrl on Linux/Windows and Cmd on macOS. `Ctrl` is the physical Ctrl
 * key everywhere, for chords like Ctrl+Tab where Cmd+Tab is the macOS app
 * switcher. Keys are `code`s because Option (macOS) and AltGr turn `key` into
 * another character.
 */

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export interface Chord {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** A KeyboardEvent.code, e.g. "KeyW", "Digit1", "ArrowLeft". */
  code: string;
}

interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
}

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];
const MODIFIER_FIELD: Record<Modifier, 'mod' | 'ctrl' | 'alt' | 'shift'> = { Mod: 'mod', Ctrl: 'ctrl', Alt: 'alt', Shift: 'shift' };

/** Codes that are the modifiers themselves: a chord needs a real key besides them. */
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS|Mod|Ctrl)(Left|Right)?$|^AltGraph$/;

export function parseChord(text: string): Chord | null {
  const parts = text.split('+');
  const code = parts.pop();
  if (code === undefined || code === '' || MODIFIER_CODES.test(code)) return null;
  if (!/^[A-Z][A-Za-z0-9]*$/.test(code)) return null;
  const chord: Chord = { mod: false, ctrl: false, alt: false, shift: false, code };
  let last = -1;
  for (const part of parts) {
    const index = MODIFIER_ORDER.indexOf(part as Modifier);
    // Unknown modifier, duplicate, or out of canonical order.
    if (index <= last) return null;
    chord[MODIFIER_FIELD[MODIFIER_ORDER[index] as Modifier]] = true;
    last = index;
  }
  return chord;
}

export function formatChord(chord: Chord): string {
  const modifiers = MODIFIER_ORDER.filter(name => chord[MODIFIER_FIELD[name]]);
  return [...modifiers, chord.code].join('+');
}

/**
 * The code of an event. Real key events always carry one; a synthetic event
 * without it falls back to the letter or digit in `key`.
 */
function eventCode(event: KeyLike): string {
  if (event.code) return event.code;
  if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
  if (/^[0-9]$/.test(event.key)) return `Digit${event.key}`;
  return event.key;
}

export function chordFromEvent(event: KeyLike, mac = IS_MAC): Chord {
  return {
    mod: mac ? event.metaKey : event.ctrlKey || event.metaKey,
    ctrl: mac ? event.ctrlKey : false,
    alt: Boolean(event.altKey),
    shift: event.shiftKey,
    code: eventCode(event),
  };
}

export function matchesChord(event: KeyLike, chord: Chord, mac = IS_MAC): boolean {
  if (eventCode(event) !== chord.code) return false;
  if (chord.alt !== Boolean(event.altKey) || chord.shift !== event.shiftKey) return false;
  if (mac) return chord.mod === event.metaKey && chord.ctrl === event.ctrlKey;
  // Elsewhere Mod is Ctrl, and a Windows/Super key counts for it as it always has.
  if (chord.mod) return event.ctrlKey || event.metaKey;
  return chord.ctrl ? event.ctrlKey && !event.metaKey : !event.ctrlKey && !event.metaKey;
}

/**
 * Whether two chord texts fire on the same keypress. Elsewhere than macOS, Mod
 * and Ctrl match the same key, so "Mod+Tab" and "Ctrl+Tab" are one chord.
 */
export function sameChord(a: string | null, b: string | null, mac = IS_MAC): boolean {
  if (a === null || b === null) return a === b;
  const left = parseChord(a);
  const right = parseChord(b);
  if (left === null || right === null) return a === b;
  const fold = (chord: Chord) => (mac ? chord : { ...chord, mod: chord.mod || chord.ctrl, ctrl: false });
  return formatChord(fold(left)) === formatChord(fold(right));
}

const ARROWS: Record<string, string> = { ArrowRight: '→', ArrowLeft: '←' };

/** "Ctrl+Alt+W" / "⌘⌥W", for tooltips. */
export function chordLabel(chord: Chord, mac = IS_MAC): string {
  const name = chord.code.replace(/^(Key|Digit)/, '');
  const key = ARROWS[name] ?? name;
  if (mac) return `${chord.ctrl ? '⌃' : ''}${chord.mod ? '⌘' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${key}`;
  return [chord.mod || chord.ctrl ? 'Ctrl' : '', chord.alt ? 'Alt' : '', chord.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}
