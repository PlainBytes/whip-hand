/**
 * Window-level keyboard shortcuts. The app had none before this — every
 * other binding hangs off the control it acts on — so this stays as small as
 * the one shortcut that needs it, rather than becoming a keymap registry.
 */
import { useEffect } from 'react';

export interface Shortcut {
  /** Compared case-insensitively against KeyboardEvent.key. */
  key: string;
  /** Ctrl on Linux/Windows, Cmd on macOS — one branch covers both. */
  mod?: boolean;
  shift?: boolean;
}

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function matchesShortcut(event: KeyLike, shortcut: Shortcut): boolean {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
  if (Boolean(shortcut.mod) !== (event.ctrlKey || event.metaKey)) return false;
  if (Boolean(shortcut.shift) !== event.shiftKey) return false;
  return true;
}

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

/**
 * @param enabled Whether the shortcut is live. A disabled shortcut is not
 *   merely inert: it never subscribes, so the keystroke is not swallowed
 *   either. That matters because this hook calls preventDefault on every
 *   match — a shortcut that cannot act on a keypress must not consume it.
 */
export function useGlobalShortcut(shortcut: Shortcut, handler: () => void, enabled = true): void {
  const { key, mod, shift } = shortcut;
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing) return;
      if (isTypingTarget(event.target)) return;
      if (!matchesShortcut(event, { key, mod, shift })) return;
      event.preventDefault();
      handler();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, mod, shift, handler, enabled]);
}
