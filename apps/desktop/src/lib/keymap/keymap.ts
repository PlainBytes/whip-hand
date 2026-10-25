import { ACTIONS, actionById, type ActionId } from './actions.ts';
import { IS_MAC, chordLabel, matchesChord, parseChord } from './chord.ts';

/** Per-action chord overrides; null unbinds the action. */
export type KeymapOverrides = Partial<Record<string, string | null>>;

/** The effective chord per action; null when unbound. */
export type Keymap = ReadonlyMap<ActionId, string | null>;

/**
 * The effective chord string per action: its default for this platform,
 * unless `overrides` says otherwise. Unknown ids and unparseable chords in
 * the overrides are ignored, so a stale or hand-edited file cannot break a shortcut.
 */
export function resolveKeymap(overrides: KeymapOverrides, mac = IS_MAC): Keymap {
  const keymap = new Map<ActionId, string | null>();
  for (const action of ACTIONS) {
    const fallback: string | null = action.defaultChord === null ? null : mac ? action.defaultChord.mac : action.defaultChord.other;
    const override = Object.hasOwn(overrides, action.id) ? overrides[action.id] : undefined;
    keymap.set(action.id, override === null ? null : override !== undefined && parseChord(override) !== null ? override : fallback);
  }
  return keymap;
}

/** The chord string bound to an action, or null when unbound. */
export function chordFor(keymap: Keymap, id: ActionId): string | null {
  return keymap.get(id) ?? null;
}

/** The bound chord as a tooltip label ("Ctrl+Alt+W" / "⌘⌥W"). */
export function actionLabel(keymap: Keymap, id: ActionId): string {
  const chord = parseChord(chordFor(keymap, id) ?? '');
  return chord === null ? 'unbound' : chordLabel(chord);
}

/** True when the event matches any bound action that works from inside a terminal. */
export function matchesTerminalPassthrough(keymap: Keymap, event: Parameters<typeof matchesChord>[0]): boolean {
  for (const [id, chordText] of keymap) {
    if (chordText === null || !actionById(id)?.allowInTerminal) continue;
    const chord = parseChord(chordText);
    if (chord !== null && matchesChord(event, chord)) return true;
  }
  return false;
}
