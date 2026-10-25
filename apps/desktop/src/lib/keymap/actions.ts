/** Every keyboard shortcut, as a named action with its default binding. */

export type ActionGroup = 'tabs' | 'workspaces' | 'pages' | 'run' | 'files';

export interface ActionDef {
  id: string;
  label: string;
  group: ActionGroup;
  /** Chord strings (see chord.ts) per platform; null when the action ships unbound. */
  defaultChord: { mac: string; other: string } | null;
  /**
   * Fire even when the keystroke comes from a terminal's helper textarea.
   * Only for chords a shell gives no meaning (Ctrl+Tab); every other input,
   * textarea, select and contenteditable still blocks the shortcut.
   */
  allowInTerminal?: boolean;
}

const both = (chord: string) => ({ mac: chord, other: chord });

export const ACTIONS = [
  { id: 'tabs.next', label: 'Next tab', group: 'tabs', defaultChord: { mac: 'Mod+Alt+ArrowRight', other: 'Mod+PageDown' } },
  { id: 'tabs.previous', label: 'Previous tab', group: 'tabs', defaultChord: { mac: 'Mod+Alt+ArrowLeft', other: 'Mod+PageUp' } },
  // Ctrl on every platform: Cmd+Tab is the macOS app switcher.
  { id: 'tabs.nextInWorkspace', label: 'Next tab in this workspace', group: 'tabs', defaultChord: both('Ctrl+Tab'), allowInTerminal: true },
  { id: 'tabs.nextAll', label: 'Next tab in any workspace', group: 'tabs', defaultChord: both('Ctrl+Shift+Tab'), allowInTerminal: true },
  { id: 'tabs.close', label: 'Close tab', group: 'tabs', defaultChord: both('Mod+Alt+KeyW') },
  { id: 'tabs.newRun', label: 'New run', group: 'tabs', defaultChord: both('Mod+Alt+KeyN') },
  { id: 'tabs.runsList', label: 'Runs list', group: 'tabs', defaultChord: both('Mod+Alt+Digit1') },
  { id: 'workspace.quickSwitch', label: 'Switch workspace', group: 'workspaces', defaultChord: both('Mod+KeyK') },
  { id: 'files.find', label: 'Find in document', group: 'files', defaultChord: both('Mod+KeyF') },
] as const satisfies readonly ActionDef[];

export type ActionId = (typeof ACTIONS)[number]['id'];

export function actionById(id: string): ActionDef | undefined {
  return ACTIONS.find(action => action.id === id);
}
