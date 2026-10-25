/**
 * Shared by the tab shortcuts. The bindings themselves live in the keymap
 * (lib/keymap); Ctrl+W / Ctrl+T stay unbound by default because the Tauri
 * webview and browsers claim them for the window or browser tab.
 */
export { IS_MAC } from './keymap/chord.ts';

/** True while a modal (confirm dialog, unsaved-changes guard, quick switch) is up. */
export function isModalOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') !== null;
}
