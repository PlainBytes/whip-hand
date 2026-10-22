/**
 * The Runs page's tab shortcuts. Ctrl+Tab (this workspace's tabs) and
 * Ctrl+Shift+Tab (every workspace's tabs) are used as plain chords. A browser
 * still claims them for its own tabs in the web host, where Ctrl+PageUp/PageDown
 * remain the fallback. Ctrl+W / Ctrl+T stay unused: the Tauri webview and
 * browsers claim them for the window or browser tab. The Alt chords match on
 * `code` because Option (macOS) and AltGr turn `key` into another character.
 */
import type { Shortcut } from './use-global-shortcut.ts';

/** A shortcut whose label names the Ctrl key even on macOS, where `mod` is normally Cmd. */
export interface TabShortcut extends Shortcut {
  ctrl?: boolean;
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const NEXT_TAB: Shortcut = IS_MAC
  ? { key: 'ArrowRight', code: 'ArrowRight', mod: true, alt: true }
  : { key: 'PageDown', code: 'PageDown', mod: true };
export const PREVIOUS_TAB: Shortcut = IS_MAC
  ? { key: 'ArrowLeft', code: 'ArrowLeft', mod: true, alt: true }
  : { key: 'PageUp', code: 'PageUp', mod: true };
// Ctrl on every platform: Cmd+Tab is the macOS app switcher, so the physical Ctrl key is used.
export const WORKSPACE_NEXT_TAB: TabShortcut = { key: 'Tab', code: 'Tab', mod: true, ctrl: true };
export const ALL_NEXT_TAB: TabShortcut = { key: 'Tab', code: 'Tab', mod: true, shift: true, ctrl: true };
export const CLOSE_TAB: Shortcut = { key: 'w', code: 'KeyW', mod: true, alt: true };
export const NEW_RUN_TAB: Shortcut = { key: 'n', code: 'KeyN', mod: true, alt: true };
export const RUNS_LIST_TAB: Shortcut = { key: '1', code: 'Digit1', mod: true, alt: true };

/** "Ctrl+Alt+W" / "⌘⌥W", for tooltips. */
export function shortcutLabel(shortcut: TabShortcut): string {
  const name = shortcut.code?.replace(/^(Key|Digit)/, '') ?? shortcut.key.toUpperCase();
  const arrow = ({ ArrowRight: '→', ArrowLeft: '←' } as Record<string, string>)[name] ?? name;
  if (IS_MAC) {
    return `${shortcut.mod ? (shortcut.ctrl ? '⌃' : '⌘') : ''}${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${arrow}`;
  }
  return [shortcut.mod ? 'Ctrl' : '', shortcut.alt ? 'Alt' : '', shortcut.shift ? 'Shift' : '', arrow].filter(Boolean).join('+');
}

/** True while a modal (confirm dialog, unsaved-changes guard, quick switch) is up. */
export function isModalOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') !== null;
}
