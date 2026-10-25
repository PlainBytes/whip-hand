import { ACTIONS, actionById, type ActionId } from './actions.ts';
import { IS_MAC, chordLabel, matchesChord, parseChord } from './chord.ts';

/** Per-action chord overrides; null unbinds the action. */
export type KeymapOverrides = Record<string, string | null>;

/**
 * The effective chord string per action: its default for this platform,
 * unless `overrides` says otherwise. Unknown ids and unparseable chords in
 * the overrides are ignored, so a stale or hand-edited file cannot break a shortcut.
 */
export function resolveKeymap(overrides: KeymapOverrides, mac = IS_MAC): Map<ActionId, string | null> {
  const keymap = new Map<ActionId, string | null>();
  for (const action of ACTIONS) {
    const fallback: string | null = action.defaultChord === null ? null : mac ? action.defaultChord.mac : action.defaultChord.other;
    const override = Object.hasOwn(overrides, action.id) ? overrides[action.id] : undefined;
    keymap.set(action.id, override === null ? null : override !== undefined && parseChord(override) !== null ? override : fallback);
  }
  return keymap;
}

// Stage 2 swaps in the user's overrides; until then everything runs on the defaults.
const current = resolveKeymap({});

/** The chord string currently bound to an action, or null when unbound. */
export function chordFor(id: ActionId): string | null {
  return current.get(id) ?? null;
}

/** The bound chord as a tooltip label ("Ctrl+Alt+W" / "⌘⌥W"). */
export function actionLabel(id: ActionId): string {
  const chord = parseChord(chordFor(id) ?? '');
  return chord === null ? 'unbound' : chordLabel(chord);
}

/** True when the event matches any bound action that works from inside a terminal. */
export function matchesTerminalPassthrough(event: Parameters<typeof matchesChord>[0]): boolean {
  for (const [id, chordText] of current) {
    if (chordText === null || !actionById(id)?.allowInTerminal) continue;
    const chord = parseChord(chordText);
    if (chord !== null && matchesChord(event, chord)) return true;
  }
  return false;
}
