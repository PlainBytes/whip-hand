import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OpenInEditorButton } from './OpenInEditorButton.tsx';
import { CapabilitiesProvider, type AppCapabilities } from '../capabilities.tsx';
import { useAppStore } from '../state/store.ts';

const WORKTREE = { path: '.whiphand/worktrees/r1', branch: 'whiphand/r1' };

function renderButton(
  capabilities: AppCapabilities,
  props: Partial<React.ComponentProps<typeof OpenInEditorButton>> = {},
  onRowClick = vi.fn(),
) {
  render(
    <CapabilitiesProvider value={capabilities}>
      <div onClick={onRowClick}>
        <OpenInEditorButton workdir="/ws" worktree={WORKTREE} size="medium" {...props} />
      </div>
    </CapabilitiesProvider>,
  );
  return { onRowClick };
}

describe('OpenInEditorButton', () => {
  afterEach(() => {
    useAppStore.setState({ appState: null });
  });

  it('renders nothing without the openInEditor capability', () => {
    renderButton({ host: 'browser', localFiles: false });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('falls back to vscode when no editor is stored', async () => {
    const openInEditor = vi.fn().mockResolvedValue(undefined);
    renderButton({ host: 'desktop', localFiles: true, openInEditor });

    fireEvent.click(screen.getByRole('button', { name: 'Open in Visual Studio Code' }));

    await waitFor(() => expect(openInEditor).toHaveBeenCalledWith('/ws', WORKTREE.path, { kind: 'vscode' }));
  });

  it('uses the stored editor, and says "editor" for a custom command', async () => {
    const openInEditor = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ appState: { editor: { kind: 'custom', command: 'hx' } } as never });
    renderButton({ host: 'desktop', localFiles: true, openInEditor });

    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }));

    await waitFor(() => expect(openInEditor).toHaveBeenCalledWith(
      '/ws', WORKTREE.path, { kind: 'custom', command: 'hx' },
    ));
  });

  it('does not trigger the enclosing row click', async () => {
    const openInEditor = vi.fn().mockResolvedValue(undefined);
    const { onRowClick } = renderButton({ host: 'desktop', localFiles: true, openInEditor }, { iconOnly: true });

    fireEvent.click(screen.getByRole('button', { name: 'Open in Visual Studio Code' }));

    await waitFor(() => expect(openInEditor).toHaveBeenCalled());
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('reports a rejection through onError', async () => {
    const openInEditor = vi.fn().mockRejectedValue(new Error('no longer exists'));
    const onError = vi.fn();
    renderButton({ host: 'desktop', localFiles: true, openInEditor }, { onError });

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(onError).toHaveBeenLastCalledWith('no longer exists'));
  });

  it('shows the rejection beside the button when no onError is given', async () => {
    const openInEditor = vi.fn().mockRejectedValue(new Error('no longer exists'));
    renderButton({ host: 'desktop', localFiles: true, openInEditor });

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByRole('alert')).toHaveTextContent('no longer exists');
  });
});
