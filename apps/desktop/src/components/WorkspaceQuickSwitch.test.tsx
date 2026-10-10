import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { WorkspaceQuickSwitch } from './WorkspaceQuickSwitch.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';

const RECENTS = [
  { path: '/dev/acme-api', lastOpenedAt: '3' },
  { path: '/dev/acme-web', lastOpenedAt: '2' },
  { path: '/dev/dotfiles', lastOpenedAt: '1' },
];

function renderQuickSwitch(recentWorkspaces = RECENTS) {
  useAppStore.setState({
    appState: {
      schemaVersion: 1, window: null, lastPage: null, theme: 'system', workspaces: {},
      runsRetention: { maxPerWorkspace: 0 }, showOngoingRuns: true, editor: { kind: 'vscode' },
      recentWorkspaces,
    },
  });
  const transport = new MockTransport();
  const onClose = vi.fn();
  render(
    <FluentProvider theme={webLightTheme}>
      <AgentClientProvider client={new AgentClient(transport)}>
        <WorkspaceQuickSwitch onClose={onClose} />
      </AgentClientProvider>
    </FluentProvider>,
  );
  return { transport, onClose };
}

async function sentRequest(transport: MockTransport, method: string) {
  return waitFor(() => {
    const index = transport.sent.findIndex(
      line => (JSON.parse(line) as { method: string }).method === method);
    if (index === -1) throw new Error(`${method} not sent yet`);
    return transport.sentRequest(index);
  });
}

afterEach(() => {
  useAppStore.setState({ appState: null, workspacePath: null, filesDirty: false });
});

describe('WorkspaceQuickSwitch', () => {
  it('filters as you type', async () => {
    renderQuickSwitch();
    expect(screen.getAllByRole('option')).toHaveLength(3);

    fireEvent.change(screen.getByLabelText('Filter workspaces'), { target: { value: 'acme' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('acme-api');
  });

  it('says so when nothing matches', () => {
    renderQuickSwitch();
    fireEvent.change(screen.getByLabelText('Filter workspaces'), { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No workspace matches/)).toBeInTheDocument();
  });

  it('opens the highlighted workspace on ArrowDown then Enter', async () => {
    const { transport, onClose } = renderQuickSwitch();
    const input = screen.getByLabelText('Filter workspaces');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'Enter' });
    const req = await sentRequest(transport, 'touchRecentWorkspace');
    expect(req.params).toEqual({ path: '/dev/acme-web' });

    transport.emitLine({
      id: req.id, result: { recentWorkspaces: [{ path: '/dev/acme-web', lastOpenedAt: '4' }] },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('pins from a row without opening that workspace', async () => {
    const { transport, onClose } = renderQuickSwitch();

    fireEvent.click(screen.getByRole('button', { name: 'Pin acme-api' }));

    const req = await sentRequest(transport, 'setWorkspacePinned');
    expect(req.params).toEqual({ path: '/dev/acme-api', pinned: true });
    expect(transport.sent.map(l => (JSON.parse(l) as { method: string }).method))
      .not.toContain('touchRecentWorkspace');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open when the unsaved-edits guard is answered "keep editing"', async () => {
    useAppStore.setState({ filesDirty: true });
    const { onClose } = renderQuickSwitch();

    fireEvent.keyDown(screen.getByLabelText('Filter workspaces'), { key: 'Enter' });

    await waitFor(() =>
      expect(useAppStore.getState().pendingWorkspaceSwitch).toBe('/dev/acme-api'));
    const { settlePendingWorkspaceSwitch } = await import('../lib/workspace-switch.ts');
    settlePendingWorkspaceSwitch(false);

    await waitFor(() => expect(useAppStore.getState().pendingWorkspaceSwitch).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });
});
