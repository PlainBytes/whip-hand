import type { EditorPreference } from '../shared/protocol.gen.ts';

/** What the editor preference falls back to until the user picks one. */
export const DEFAULT_EDITOR: EditorPreference = { kind: 'vscode' };

export const CUSTOM_EDITOR = 'custom';

/** The Preferences dropdown's choices: the presets, then "Custom command…". */
export const EDITOR_OPTIONS = [
  { value: 'vscode', label: 'Visual Studio Code' },
  { value: 'vscode-insiders', label: 'VS Code Insiders' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'windsurf', label: 'Windsurf' },
  { value: 'zed', label: 'Zed' },
  { value: CUSTOM_EDITOR, label: 'Custom command…' },
] as const;

/** The editor's name for a button: the preset's label, or a generic one for a custom command. */
export function editorLabel(editor: EditorPreference): string {
  if (editor.kind === 'custom') return 'editor';
  return EDITOR_OPTIONS.find(o => o.value === editor.kind)?.label ?? 'editor';
}
