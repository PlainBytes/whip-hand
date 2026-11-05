import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkspacesPage } from './WorkspacesPage.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { CapabilitiesProvider } from '../capabilities.tsx';
import { useAppStore } from '../state/store.ts';
import { EMPTY_APP_STATE } from '../test/app-state.ts';
import type { WorkspaceDetails } from '../shared/protocol.gen.ts';

const base = {
  lastOpenedAt: '2026-01-02T00:00:00Z', exists: true, initialized: true,
  git: null, storage: 'local', runCount: 0,
} as const;

const WORKSPACES: WorkspaceDetails[] = [
  { ...base, path: '/dev/recent', git: { kind: 'branch', name: 'main' }, runCount: 3, lastRunAt: '2026-01-01T00:00:00Z' },
  { ...base, path: '/dev/plain', pinned: true, storage: 'user' },
  { ...base, path: '/dev/gone', exists: false, initialized: false },
];

function renderPage(pickDirectory?: () => Promise<string | null>) {
  const transport = new MockTransport();
  render(
    <CapabilitiesProvider value={{ host: pickDirectory ? 'desktop' : 'browser', localFiles: true, pickDirectory }}>
      <AgentClientProvider client={new AgentClient(transport)}>
        <WorkspacesPage />
      </AgentClientProvider>
    </CapabilitiesProvider>,
  );
  return transport;
}

async function nextRequest(transport: MockTransport, method: string, nth = 0) {
  return waitFor(() => {
    const matches = transport.sent
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => (JSON.parse(line) as { method: string }).method === method);
    if (matches.length <= nth) throw new Error(`${method} #${nth} not sent yet`);
    return transport.sentRequest(matches[nth].index);
  });
}

async function respond(transport: MockTransport, method: string, result: unknown, nth = 0) {
  const req = await nextRequest(transport, method, nth);
  transport.emitLine({ id: req.id, result });
  return req;
}

const rowOf = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;

describe('WorkspacesPage', () => {
  beforeEach(() => useAppStore.setState({
    workspacePath: '/dev/recent', workspaceIdentityKey: null, appState: { ...EMPTY_APP_STATE, recentWorkspaces: [] },
  }));
  afterEach(() => useAppStore.setState({ workspacePath: null, appState: null }));

  it('lists pinned workspaces first, then the rest in recency order', async () => {
    const transport = renderPage();
    await respond(transport, 'describeWorkspaces', { workspaces: WORKSPACES });

    await screen.findByText('recent');
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map(r => within(r).getAllByRole('gridcell')[0].textContent))
      .toEqual([expect.stringContaining('plain'), expect.stringContaining('recent'), expect.stringContaining('gone')]);
  });

  it('shows git, status, storage and run details per row', async () => {
    const transport = renderPage();
    await respond(transport, 'describeWorkspaces', { workspaces: WORKSPACES });
    await screen.findByText('recent');

    expect(within(rowOf('recent')).getByText('main')).toBeInTheDocument();
    expect(within(rowOf('recent')).getByText('Ready')).toBeInTheDocument();
    expect(within(rowOf('recent')).getByText('Project')).toBeInTheDocument();
    expect(within(rowOf('recent')).getByText('3')).toBeInTheDocument();
    expect(within(rowOf('plain')).getByText('—')).toBeInTheDocument();
    expect(within(rowOf('plain')).getByText('User folder')).toBeInTheDocument();
    expect(within(rowOf('gone')).getByText('Missing')).toBeInTheDocument();
  });

  it('marks the open workspace Current and disables its Open', async () => {
    const transport = renderPage();
    await respond(transport, 'describeWorkspaces', { workspaces: WORKSPACES });
    await screen.findByText('recent');

    expect(within(rowOf('recent')).getByText('Current')).toBeInTheDocument();
    expect(within(rowOf('recent')).getByRole('button', { name: 'Open recent' })).toBeDisabled();
    expect(within(rowOf('plain')).queryByText('Current')).not.toBeInTheDocument();
    expect(within(rowOf('plain')).getByRole('button', { name: 'Open plain' })).toBeEnabled();
  });

  it('disables Open for a missing folder', async () => {
    const transport = renderPage();
    await respond(transport, 'describeWorkspaces', { workspaces: WORKSPACES });
    await screen.findByText('gone');

    expect(within(rowOf('gone')).getByRole('button', { name: 'Open gone' })).toBeDisabled();
  });

  it('opens a workspace through the agent', async () => {
    const transport = renderPage();
    await respond(transport, 'describeWorkspaces', { workspaces: WORKSPACES });
    await screen.findByText('plain');

    fireEvent.click(within(rowOf('plain')).getByRole('button', { name: 'Open plain' }));
    const req = await nextRequest(transport, 'touchRecentWorkspace');
    expect(req.params).toEqual({ path: '/dev/plain' });
  });

  it('pins and unpins with the toggled value and updates the store', async () => {
    const transport = renderPage();
    await respond(transport, 'describeWorkspaces', { workspaces: WORKSPACES });
    await screen.findByText('recent');

    fireEvent.click(within(rowOf('recent')).getByRole('button', { name: 'Pin recent' }));
    const pin = await respond(transport, 'setWorkspacePinned', {
      recentWorkspaces: [{ path: '/dev/recent', lastOpenedAt: '2026-01-02T00:00:00Z', pinned: true }],
    });
    expect(pin.params).toEqual({ path: '/dev/recent', pinned: true });
    await waitFor(() => expect(useAppStore.getState().appState?.recentWorkspaces[0].pinned).toBe(true));

    fireEvent.click(within(rowOf('plain')).getByRole('button', { name: 'Unpin plain' }));
    const unpin = await nextRequest(transport, 'setWorkspacePinned', 1);
    expect(unpin.params).toEqual({ path: '/dev/plain', pinned: false });
  });

  it('reloads when the store recents change, e.g. a pin from the switcher', async () => {
    const transport = renderPage();
    await respond(transport, 'describeWorkspaces', { workspaces: WORKSPACES });
    await screen.findByText('recent');

    act(() => useAppStore.getState().patchAppState({
      recentWorkspaces: [{ path: '/dev/recent', lastOpenedAt: '2026-01-02T00:00:00Z', pinned: true }],
    }));
    await respond(transport, 'describeWorkspaces', {
      workspaces: [{ ...WORKSPACES[0], pinned: true }],
    }, 1);

    await waitFor(() => expect(screen.queryByText('plain')).not.toBeInTheDocument());
  });

  it('shows an inline error when loading fails', async () => {
    const transport = renderPage();
    const req = await nextRequest(transport, 'describeWorkspaces');
    transport.emitLine({ id: req.id, error: { code: -32000, message: 'boom' } });

    expect(await screen.findByText(/Failed to load workspaces: .*boom/)).toBeInTheDocument();
  });

  it('points at Open path when the list is empty and there is no picker', async () => {
    const transport = renderPage();
    await respond(transport, 'describeWorkspaces', { workspaces: [] });

    expect(await screen.findByText(/No workspaces yet/)).toBeInTheDocument();
    expect(screen.getByText(/Open path/, { selector: 'p, span' })).toBeInTheDocument();
  });

  it('offers Browse… when the host has a folder picker', async () => {
    const transport = renderPage(async () => '/dev/picked');
    await respond(transport, 'describeWorkspaces', { workspaces: [] });

    fireEvent.click(await screen.findByRole('button', { name: /Browse/ }));
    const req = await nextRequest(transport, 'touchRecentWorkspace');
    expect(req.params).toEqual({ path: '/dev/picked' });
  });
});
