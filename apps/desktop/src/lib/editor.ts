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

/**
 * Opens a run in the editor: its worktree, else its work directory below
 * `workdir` (`subdir`), else `workdir` itself. Rejects with the launch error.
 * The one place that decides the target, shared by the button and the shortcut.
 */
export function openRunInEditor(
  openInEditor: (workdir: string, relPath: string, editor: EditorPreference) => Promise<void>,
  editor: EditorPreference,
  run: { workdir: string; worktree?: { path: string } | null | undefined; subdir?: string | null | undefined },
): Promise<void> {
  return openInEditor(run.workdir, run.worktree?.path ?? run.subdir ?? '', editor);
}
