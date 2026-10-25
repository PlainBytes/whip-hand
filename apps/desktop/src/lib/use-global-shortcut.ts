/** Window-level keyboard shortcuts, bound by action id through the keymap (lib/keymap). */
import { useEffect } from 'react';
import { actionById, type ActionId } from './keymap/actions.ts';
import { matchesChord, parseChord } from './keymap/chord.ts';
import { chordFor } from './keymap/keymap.ts';

/**
 * True where a keystroke belongs to whatever the user is typing into.
 *
 * Note this covers the hidden textarea xterm.js focuses while a terminal has
 * focus, so shortcuts deliberately go dead inside a live session — Ctrl+K is
 * kill-to-end-of-line in every shell, and stealing it there would be worse
 * than not having it.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** True for xterm.js's hidden helper textarea, which receives the keys typed into a terminal. */
function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('.xterm') !== null;
}

/**
 * @param enabled Whether the shortcut is live. A disabled shortcut is not
 *   merely inert: it never subscribes, so the keystroke is not swallowed
 *   either. That matters because this hook calls preventDefault on every
 *   match — a shortcut that cannot act on a keypress must not consume it.
 *   An action with no binding never subscribes either.
 */
export function useShortcut(actionId: ActionId, handler: () => void, enabled = true): void {
  const chordText = chordFor(actionId);
  const allowInTerminal = actionById(actionId)?.allowInTerminal ?? false;
  useEffect(() => {
    const chord = chordText === null ? null : parseChord(chordText);
    if (!enabled || chord === null) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing) return;
      if (isTypingTarget(event.target) && !(allowInTerminal && isTerminalTarget(event.target))) return;
      if (!matchesChord(event, chord as NonNullable<typeof chord>)) return;
      event.preventDefault();
      handler();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chordText, handler, enabled, allowInTerminal]);
}
