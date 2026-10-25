import type { PageId } from '../../nav.ts';

/** Every keyboard shortcut, as a named action with its default binding. */

export type ActionGroup = 'tabs' | 'workspaces' | 'pages' | 'run' | 'files' | 'view';

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
  { id: 'tabs.goTo1', label: 'Go to tab 1', group: 'tabs', defaultChord: both('Mod+Alt+Digit2') },
  { id: 'tabs.goTo2', label: 'Go to tab 2', group: 'tabs', defaultChord: both('Mod+Alt+Digit3') },
  { id: 'tabs.goTo3', label: 'Go to tab 3', group: 'tabs', defaultChord: both('Mod+Alt+Digit4') },
  { id: 'tabs.goTo4', label: 'Go to tab 4', group: 'tabs', defaultChord: both('Mod+Alt+Digit5') },
  { id: 'tabs.goTo5', label: 'Go to tab 5', group: 'tabs', defaultChord: both('Mod+Alt+Digit6') },
  { id: 'tabs.goTo6', label: 'Go to tab 6', group: 'tabs', defaultChord: both('Mod+Alt+Digit7') },
  { id: 'tabs.goTo7', label: 'Go to tab 7', group: 'tabs', defaultChord: both('Mod+Alt+Digit8') },
  { id: 'tabs.goTo8', label: 'Go to tab 8', group: 'tabs', defaultChord: both('Mod+Alt+Digit9') },
  { id: 'tabs.closeOthers', label: 'Close other tabs', group: 'tabs', defaultChord: null },
  { id: 'tabs.reopenClosed', label: 'Reopen closed tab', group: 'tabs', defaultChord: both('Mod+Alt+Shift+KeyT') },
  { id: 'tabs.keepPreview', label: 'Keep preview tab', group: 'tabs', defaultChord: null },
  { id: 'workspace.quickSwitch', label: 'Switch workspace', group: 'workspaces', defaultChord: both('Mod+KeyK') },
  { id: 'workspace.previous', label: 'Previous workspace', group: 'workspaces', defaultChord: both('Mod+Alt+KeyP') },
  { id: 'workspace.pinned1', label: 'Pinned workspace 1', group: 'workspaces', defaultChord: null },
  { id: 'workspace.pinned2', label: 'Pinned workspace 2', group: 'workspaces', defaultChord: null },
  { id: 'workspace.pinned3', label: 'Pinned workspace 3', group: 'workspaces', defaultChord: null },
  { id: 'workspace.pinned4', label: 'Pinned workspace 4', group: 'workspaces', defaultChord: null },
  { id: 'workspace.pinned5', label: 'Pinned workspace 5', group: 'workspaces', defaultChord: null },
  { id: 'workspace.pinned6', label: 'Pinned workspace 6', group: 'workspaces', defaultChord: null },
  { id: 'workspace.pinned7', label: 'Pinned workspace 7', group: 'workspaces', defaultChord: null },
  { id: 'workspace.pinned8', label: 'Pinned workspace 8', group: 'workspaces', defaultChord: null },
  { id: 'workspace.pinned9', label: 'Pinned workspace 9', group: 'workspaces', defaultChord: null },
  { id: 'page.runs', label: 'Go to Runs', group: 'pages', defaultChord: null },
  { id: 'page.workflows', label: 'Go to Workflows', group: 'pages', defaultChord: null },
  { id: 'page.files', label: 'Go to Files', group: 'pages', defaultChord: null },
  { id: 'page.workspaceSettings', label: 'Go to Workspace settings', group: 'pages', defaultChord: null },
  { id: 'page.activity', label: 'Go to Activity', group: 'pages', defaultChord: null },
  { id: 'page.doctor', label: 'Go to Doctor', group: 'pages', defaultChord: null },
  { id: 'page.preferences', label: 'Go to Preferences', group: 'pages', defaultChord: both('Mod+Comma') },
  { id: 'run.focusTerminal', label: 'Focus terminal', group: 'run', defaultChord: both('Mod+Alt+KeyT') },
  { id: 'run.openInEditor', label: 'Open run in editor', group: 'run', defaultChord: both('Mod+Alt+KeyE') },
  { id: 'files.find', label: 'Find in document', group: 'files', defaultChord: both('Mod+KeyF') },
  { id: 'view.toggleSidebar', label: 'Toggle sidebar', group: 'view', defaultChord: both('Mod+KeyB') },
] as const satisfies readonly ActionDef[];

export type ActionId = (typeof ACTIONS)[number]['id'];

/** The action that opens `page`: 'workspace-settings' -> 'page.workspaceSettings'. A test keeps ACTIONS in step with PAGES. */
export function pageActionId(page: PageId): ActionId {
  return `page.${page.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}` as ActionId;
}

export function actionById(id: string): ActionDef | undefined {
  return ACTIONS.find(action => action.id === id);
}
