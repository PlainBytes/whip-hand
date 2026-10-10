import { useState } from 'react';
import { Button, Spinner, Text } from '@fluentui/react-components';
import { Open16Regular, Open20Regular } from '@fluentui/react-icons';
import { useCapabilities } from '../capabilities.tsx';
import { useAppStore } from '../state/store.ts';
import { DEFAULT_EDITOR, editorLabel } from '../lib/editor.ts';
import { errorMessage } from '../lib/error-message.ts';

export interface OpenInEditorButtonProps {
  workdir: string;
  worktree: { path: string; branch: string };
  size: 'small' | 'medium';
  iconOnly?: boolean;
  /**
   * Where a failed launch is reported. A page passes this to show the message
   * in its own error area; without it the message appears beside the button.
   */
  onError?: (message: string | null) => void;
}

/**
 * Opens a run's worktree in the editor chosen in Preferences. Renders nothing
 * on a host without the `openInEditor` capability (the browser).
 */
export function OpenInEditorButton({ workdir, worktree, size, iconOnly, onError }: OpenInEditorButtonProps) {
  const { openInEditor } = useCapabilities();
  const editor = useAppStore(state => state.appState?.editor ?? DEFAULT_EDITOR);
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (openInEditor === undefined) return null;

  const label = `Open in ${editorLabel(editor)}`;

  async function handleClick(event: React.MouseEvent): Promise<void> {
    // Inside a grid row: the click must not also open the run.
    event.stopPropagation();
    setPending(true);
    setLocalError(null);
    onError?.(null);
    try {
      await openInEditor!(workdir, worktree.path, editor);
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
      <Button
        appearance={iconOnly ? 'subtle' : 'secondary'}
        size={size}
        icon={icon}
        disabled={pending}
        aria-label={label}
        title={label}
        onClick={event => void handleClick(event)}
      >
        {iconOnly ? undefined : label}
      </Button>
      {localError !== null && <Text role="alert" onClick={e => e.stopPropagation()}>{localError}</Text>}
    </>
  );
}
