import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App.tsx';
import { AgentClient } from './agent/client.ts';
import { MockTransport } from './agent/transport.ts';
import { AgentClientProvider } from './agent/agent-context.tsx';
import { useAppStore } from './state/store.ts';
import { FakeFileSystem } from './files/fake-fs.ts';
import { FileSystemProvider } from './files/fs-context.tsx';
import { EMPTY_APP_STATE } from '../../../packages/agent/src/app-state.ts';

// The real banner renders nothing under vitest (it only runs in production
// builds), so this marker stands in to make its position in the layout
// observable.
vi.mock('./components/UpdateBanner.tsx', () => ({
  UpdateBanner: () => <div data-testid="update-banner-marker" />,
}));

// A FileSystemProvider is always present: the Files tab throws without one,
// and an unused FakeFileSystem costs the other tests nothing.
function renderApp(fs: FakeFileSystem = new FakeFileSystem()) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  render(
    <AgentClientProvider client={client}>
      <FileSystemProvider fs={fs}>
        <App />
      </FileSystemProvider>
    </AgentClientProvider>,
  );
  return { transport, client };
}

// NewRunPage.test.tsx's respond() helper, copied here: waits for `method` to
// have been sent (App fires several startup requests whose relative order
// isn't guaranteed) and resolves it with `result`.
async function respond(transport: MockTransport, method: string, result: unknown) {
  const req = await waitFor(() => {
    const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === method);
    if (index === -1) throw new Error(`${method} not sent yet`);
    return transport.sentRequest(index);
  });
  transport.emitLine({ id: req.id, result });
}

describe('App', () => {
  afterEach(() => {
    useAppStore.setState({
      appState: null, restoreDone: false, page: 'runs', workspacePath: null, filesDirty: false,
    });
  });

  it('renders every page in one navigation landmark', () => {
    renderApp();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const label of ['Runs', 'Workflows', 'Files', 'Doctor', 'Settings']) {
      expect(within(nav).getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('marks the current page with aria-current', async () => {
    renderApp();
    useAppStore.setState({ workspacePath: '/ws' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-current', 'page'));
    expect(screen.getByRole('button', { name: 'Doctor' })).not.toHaveAttribute('aria-current');
  });

  it('disables the workspace group, and never marks it current, with no workspace open', async () => {
    const { transport } = renderApp();
    await respond(transport, 'hello', { version: '0.0.0', protocolVersion: 1 });
    await respond(transport, 'getAppState', EMPTY_APP_STATE);
    await waitFor(() => expect(useAppStore.getState().restoreDone).toBe(true));

    for (const label of ['Runs', 'Workflows', 'Files', 'Settings']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }
    for (const label of ['Activity', 'Doctor', 'Preferences']) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled();
    }
    // page is 'runs', but a gated page must not paint as the current one.
    expect(screen.getByRole('button', { name: 'Runs' })).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Welcome to Whiphand')).toBeInTheDocument();
  });

  it('shows the agent-down banner before the transport connects', () => {
    renderApp();
    expect(screen.getByText(/whiphand agent/i)).toBeInTheDocument();
  });

  it('renders the update banner inside the height:100% layout column', () => {
    renderApp();
    const marker = screen.getByTestId('update-banner-marker');
    // The sidebar/main row's parent is the column itself, so the banner and
    // the row must share it. A banner outside the column stacks its own
    // height on top of the column's full 100% and pushes Preferences past
    // the window edge.
    const row = screen.getByRole('navigation', { name: 'Main' }).parentElement as HTMLElement;
    expect(marker.parentElement).toBe(row.parentElement);
  });

  it('renders Doctor placeholder rows from a scripted MockTransport doctor response', async () => {
    const { transport } = renderApp();

    // AgentClientProvider fires connect() on mount; once the mock transport
    // "starts" the client is connected without needing a hello response.
    fireEvent.click(screen.getByRole('button', { name: 'Doctor' }));

    // Searched by method, not taken from the end of the list: the app shell
    // issues its own requests on connect (startup restore, job attach), so
    // "the most recent request" is not reliably the one this click caused.
    const doctorReq = await waitFor(() => {
      const index = transport.sent.findIndex(
        line => (JSON.parse(line) as { method: string }).method === 'doctor');
      if (index === -1) throw new Error('doctor request not sent yet');
      return transport.sentRequest(index);
    });

    transport.emitLine({
      id: doctorReq.id,
      result: [
        {
          id: 'claude', label: 'Claude Code', group: 'harness',
          runner: true, optional: false, installed: true, version: '1.2.3',
        },
        {
          id: 'codex', label: 'OpenAI Codex CLI', group: 'harness',
          runner: false, optional: true, installed: false,
        },
      ],
    });

    const claudeCard = await screen.findByTestId('doctor-card-claude');
    const codexCard = screen.getByTestId('doctor-card-codex');
    expect(claudeCard).toHaveTextContent('claude');
    expect(claudeCard).toHaveTextContent('1.2.3');
    expect(claudeCard).toHaveTextContent('Installed');
    expect(codexCard).toHaveTextContent('Not found');
  });

  it('restores the last workspace and page from getAppState on connect', async () => {
    const { transport } = renderApp();
    await respond(transport, 'hello', { version: '0.0.0', protocolVersion: 1 });
    await respond(transport, 'getAppState', {
      schemaVersion: 1,
      recentWorkspaces: [{ path: '/ws-a', lastOpenedAt: '2026-01-01T00:00:00Z' }],
      window: null,
      lastPage: 'workflows',
      theme: 'system',
      workspaces: {},
    });
    await waitFor(() => expect(useAppStore.getState().workspacePath).toBe('/ws-a'));
    expect(useAppStore.getState().page).toBe('workflows');
    // the sidebar switcher names the workspace, and shows its path underneath
    const switcher = await screen.findByRole('button', { name: /ws-a/ });
    expect(within(switcher).getByText('ws-a')).toBeInTheDocument();
    expect(within(switcher).getByText('/ws-a')).toBeInTheDocument();
  });

  it('falls back to Runs when a persisted lastPage names the removed New Run tab', async () => {
    const { transport } = renderApp();
    await respond(transport, 'hello', { version: '0.0.0', protocolVersion: 1 });
    await respond(transport, 'getAppState', {
      schemaVersion: 1,
      recentWorkspaces: [{ path: '/ws-a', lastOpenedAt: '2026-01-01T00:00:00Z' }],
      window: null,
      lastPage: 'new-run',
      theme: 'system',
      workspaces: {},
    });
    await waitFor(() => expect(useAppStore.getState().workspacePath).toBe('/ws-a'));
    expect(useAppStore.getState().page).toBe('runs');
  });

  it('offers recent workspaces in the sidebar switcher and switches via touchRecentWorkspace', async () => {
    const { transport } = renderApp();
    await respond(transport, 'hello', { version: '0.0.0', protocolVersion: 1 });
    await respond(transport, 'getAppState', {
      schemaVersion: 1,
      recentWorkspaces: [
        { path: '/ws-a', lastOpenedAt: '2' },
        { path: '/ws-b', lastOpenedAt: '1' },
      ],
      window: null, lastPage: null, theme: 'system', workspaces: {},
    });
    await waitFor(() => expect(useAppStore.getState().workspacePath).toBe('/ws-a'));

    fireEvent.click(screen.getByRole('button', { name: /ws-a/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /ws-b/ }));
    await respond(transport, 'touchRecentWorkspace', {
      recentWorkspaces: [
        { path: '/ws-b', lastOpenedAt: '3' },
        { path: '/ws-a', lastOpenedAt: '2' },
      ],
    });
    await waitFor(() => expect(useAppStore.getState().workspacePath).toBe('/ws-b'));
  });

  it('shows Preferences (not WelcomePage) with no workspace open', async () => {
    const { transport } = renderApp();
    await respond(transport, 'hello', { version: '0.0.0', protocolVersion: 1 });
    await respond(transport, 'getAppState', EMPTY_APP_STATE);
    await waitFor(() => expect(useAppStore.getState().restoreDone).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Preferences' }));

    expect(await screen.findByLabelText('Theme')).toBeInTheDocument();
    expect(screen.queryByText('Welcome to Whiphand')).not.toBeInTheDocument();
  });

  it('restores a persisted "settings" page to the workspace settings page', async () => {
    const { transport } = renderApp();
    await respond(transport, 'hello', { version: '0.0.0', protocolVersion: 1 });
    await respond(transport, 'getAppState', {
      ...EMPTY_APP_STATE,
      recentWorkspaces: [{ path: '/ws-a', lastOpenedAt: '1' }],
      lastPage: 'settings',
    });
    await waitFor(() => expect(useAppStore.getState().page).toBe('workspace-settings'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page'));
  });

  it('persists the selected page via setUiState', async () => {
    const { transport } = renderApp();
    await respond(transport, 'hello', { version: '0.0.0', protocolVersion: 1 });
    await respond(transport, 'getAppState', EMPTY_APP_STATE);
    useAppStore.setState({ workspacePath: '/ws' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Workflows' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Workflows' }));
    await waitFor(() => {
      const found = transport.sent
        .map(line => JSON.parse(line) as { method: string; params?: unknown })
        .find(r => r.method === 'setUiState' && (r.params as { lastPage?: string }).lastPage === 'workflows');
      expect(found).toBeTruthy();
    });
  });
});

/**
 * Leaving the Files tab unmounts FilesPage, so its own in-page dirty guard
 * can never see this exit — the flag has to be readable from App. See the
 * spec's "selecting another file, switching tabs, or closing with unsaved
 * edits raises a Fluent dialog".
 */
describe('App unsaved-edits guard on tab switch', () => {
  afterEach(() => {
    useAppStore.setState({
      appState: null, restoreDone: false, page: 'runs', workspacePath: null, filesDirty: false,
      pendingWorkspaceSwitch: null,
    });
  });

  async function openFilesWithUnsavedEdits() {
    const fs = new FakeFileSystem();
    fs.setFile('/ws/README.md', '# Readme');
    const { transport } = renderApp(fs);
    await respond(transport, 'hello', { version: '0.0.0', protocolVersion: 1 });
    await respond(transport, 'getAppState', EMPTY_APP_STATE);
    useAppStore.setState({ workspacePath: '/ws' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Files' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    fireEvent.click(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved work' } });
    await waitFor(() => expect(useAppStore.getState().filesDirty).toBe(true));
    return { transport };
  }

  it('warns instead of switching away, and stays on Files when told to keep editing', async () => {
    await openFilesWithUnsavedEdits();

    fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
    expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /keep editing/i }));
    expect(useAppStore.getState().page).toBe('files');
    expect(screen.getByRole('textbox')).toHaveValue('unsaved work');
  });

  it('guards a workspace switch too, not just a page switch', async () => {
    const { transport } = await openFilesWithUnsavedEdits();
    useAppStore.setState({
      appState: {
        ...EMPTY_APP_STATE,
        recentWorkspaces: [{ path: '/ws', lastOpenedAt: '2' }, { path: '/ws-b', lastOpenedAt: '1' }],
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'ws/ws' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /ws-b/ }));

    expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /keep editing/i }));

    await waitFor(() => expect(useAppStore.getState().pendingWorkspaceSwitch).toBeNull());
    expect(useAppStore.getState().workspacePath).toBe('/ws');
    // The guard ran before the agent was ever asked to switch.
    expect(transport.sent.map(l => (JSON.parse(l) as { method: string }).method))
      .not.toContain('touchRecentWorkspace');
  });

  it('completes the switch and clears the flag when discard is confirmed', async () => {
    await openFilesWithUnsavedEdits();

    fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
    fireEvent.click(await screen.findByRole('button', { name: /discard/i }));

    await waitFor(() => expect(useAppStore.getState().page).toBe('runs'));
    expect(useAppStore.getState().filesDirty).toBe(false);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
