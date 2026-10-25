import { useState } from 'react';
import { Button, Spinner, Text, Tooltip } from '@fluentui/react-components';
import { Open16Regular, Open20Regular } from '@fluentui/react-icons';
import { useCapabilities } from '../capabilities.tsx';
import { useAppStore } from '../state/store.ts';
import { DEFAULT_EDITOR, editorLabel } from '../lib/editor.ts';
import { errorMessage } from '../lib/error-message.ts';

const DESKTOP_ONLY = 'Opening in an editor is only available in the desktop app';

export interface OpenInEditorButtonProps {
  workdir: string;
  /** Without one the button opens `subdir`, or `workdir` itself. */
  worktree?: { path: string; branch: string };
  /** The run's work directory below `workdir`, when it chose one. */
  subdir?: string | undefined;
  size: 'small' | 'medium';
  iconOnly?: boolean;
  /**
   * Where a failed launch is reported. A page passes this to show the message
   * in its own error area; without it the message appears beside the button.
   */
  onError?: (message: string | null) => void;
}

/**
 * Opens a run's worktree, or the repository when it has none (its work
 * directory, or the workspace), in the editor
 * chosen in Preferences. On a host without the `openInEditor` capability (the
 * browser) it stays visible but disabled, with a tooltip saying why.
 */
export function OpenInEditorButton({ workdir, worktree, subdir, size, iconOnly, onError }: OpenInEditorButtonProps) {
  const { openInEditor } = useCapabilities();
  const editor = useAppStore(state => state.appState?.editor ?? DEFAULT_EDITOR);
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const label = `Open ${worktree ? 'worktree' : 'repository'} in ${editorLabel(editor)}`;
  const unavailable = openInEditor === undefined;

  // Fluent swallows clicks on a disabledFocusable button before our onClick
  // runs, so they would still bubble up and open the enclosing row's run.
  const onDisabledClickCapture = unavailable ? (event: React.MouseEvent) => event.stopPropagation() : undefined;

  async function handleClick(event: React.MouseEvent): Promise<void> {
    // Inside a grid row: the click must not also open the run.
    event.stopPropagation();
    if (openInEditor === undefined) return;
    setPending(true);
    setLocalError(null);
    onError?.(null);
    try {
      await openInEditor(workdir, worktree?.path ?? subdir ?? '', editor);
    } catch (err) {
      const message = errorMessage(err);
      if (onError) onError(message);
      else setLocalError(message);
    } finally {
      setPending(false);
    }
  }

  const icon = pending
    ? <Spinner size="tiny" />
    : size === 'small' ? <Open16Regular /> : <Open20Regular />;

  return (
    <>
      {iconOnly ? (
        <Tooltip
          content={unavailable ? DESKTOP_ONLY : label}
          relationship={unavailable ? 'description' : 'label'}
        >
          <Button
            appearance="secondary"
            size={size}
            icon={icon}
            {...(unavailable ? { 'aria-label': label } : {})}
            disabled={pending}
            disabledFocusable={unavailable}
            onClick={event => void handleClick(event)}
            onClickCapture={onDisabledClickCapture}
          />
        </Tooltip>
      ) : (
        <Tooltip content={DESKTOP_ONLY} relationship="description" visible={unavailable ? undefined : false}>
          <Button
            appearance="secondary"
            size={size}
            icon={icon}
            disabled={pending}
            disabledFocusable={unavailable}
            onClick={event => void handleClick(event)}
            onClickCapture={onDisabledClickCapture}
          >
            {label}
          </Button>
        </Tooltip>
      )}
      {localError !== null && <Text role="alert" onClick={e => e.stopPropagation()}>{localError}</Text>}
    </>
  );
}
