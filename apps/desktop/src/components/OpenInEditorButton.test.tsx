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

  it('is disabled with a desktop-only tooltip without the openInEditor capability', async () => {
    const { onRowClick } = renderButton({ host: 'browser', localFiles: false }, { iconOnly: true });

    const button = screen.getByRole('button', { name: 'Open worktree in Visual Studio Code' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.mouseEnter(button);
    expect(await screen.findByText(/only available in the desktop app/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('opens the workdir itself, labelled as the repository, without a worktree', async () => {
    const openInEditor = vi.fn().mockResolvedValue(undefined);
    renderButton({ host: 'desktop', localFiles: true, openInEditor }, { worktree: undefined });

    fireEvent.click(screen.getByRole('button', { name: 'Open repository in Visual Studio Code' }));

    await waitFor(() => expect(openInEditor).toHaveBeenCalledWith('/ws', '', { kind: 'vscode' }));
  });

  it('opens a run\'s work directory when it has no worktree', async () => {
    const openInEditor = vi.fn().mockResolvedValue(undefined);
    renderButton({ host: 'desktop', localFiles: true, openInEditor }, { worktree: undefined, subdir: 'api' });

    fireEvent.click(screen.getByRole('button', { name: 'Open repository in Visual Studio Code' }));

    await waitFor(() => expect(openInEditor).toHaveBeenCalledWith('/ws', 'api', { kind: 'vscode' }));
  });

  it('falls back to vscode when no editor is stored', async () => {
    const openInEditor = vi.fn().mockResolvedValue(undefined);
    renderButton({ host: 'desktop', localFiles: true, openInEditor });

    fireEvent.click(screen.getByRole('button', { name: 'Open worktree in Visual Studio Code' }));

    await waitFor(() => expect(openInEditor).toHaveBeenCalledWith('/ws', WORKTREE.path, { kind: 'vscode' }));
  });

  it('uses the stored editor, and says "editor" for a custom command', async () => {
    const openInEditor = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ appState: { editor: { kind: 'custom', command: 'hx' } } as never });
    renderButton({ host: 'desktop', localFiles: true, openInEditor });

    fireEvent.click(screen.getByRole('button', { name: 'Open worktree in editor' }));

    await waitFor(() => expect(openInEditor).toHaveBeenCalledWith(
      '/ws', WORKTREE.path, { kind: 'custom', command: 'hx' },
    ));
  });

  it('renders icon-only with no visible text and no native title', () => {
    renderButton({ host: 'desktop', localFiles: true, openInEditor: vi.fn() }, { iconOnly: true });

    const button = screen.getByRole('button', { name: 'Open worktree in Visual Studio Code' });
    expect(button.textContent).toBe('');
    expect(button).not.toHaveAttribute('title');
  });

  it('does not trigger the enclosing row click', async () => {
    const openInEditor = vi.fn().mockResolvedValue(undefined);
    const { onRowClick } = renderButton({ host: 'desktop', localFiles: true, openInEditor }, { iconOnly: true });

    fireEvent.click(screen.getByRole('button', { name: 'Open worktree in Visual Studio Code' }));

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
