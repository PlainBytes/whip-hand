import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { CapabilitiesProvider, type AppCapabilities } from '../capabilities.tsx';

const DESKTOP_CAPS: AppCapabilities = {
  host: 'desktop', localFiles: true, pickDirectory: async () => '/picked',
};
const BROWSER_CAPS: AppCapabilities = { host: 'browser', localFiles: false };

function renderSwitcher(capabilities?: AppCapabilities) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  const tree = (
    <FluentProvider theme={webLightTheme}>
      <AgentClientProvider client={client}>
        <WorkspaceSwitcher />
      </AgentClientProvider>
    </FluentProvider>
  );
  render(
    capabilities
      ? <CapabilitiesProvider value={capabilities}>{tree}</CapabilitiesProvider>
      : tree,
  );
  return { transport };
}

/** Waits for `method` to have been sent and returns the parsed request. */
async function sentRequest(transport: MockTransport, method: string) {
  return waitFor(() => {
    const index = transport.sent.findIndex(
      line => (JSON.parse(line) as { method: string }).method === method);
    if (index === -1) throw new Error(`${method} not sent yet`);
    return transport.sentRequest(index);
  });
}

async function respond(transport: MockTransport, method: string, result: unknown): Promise<void> {
  transport.emitLine({ id: (await sentRequest(transport, method)).id, result });
}

afterEach(() => {
  useAppStore.setState({ workspacePath: null, appState: null });
});

describe('WorkspaceSwitcher', () => {
  it('lists pinned workspaces above unpinned ones', async () => {
    useAppStore.setState({
      workspacePath: '/ws/recent',
      appState: {
        schemaVersion: 1, window: null, lastPage: null, theme: 'system', workspaces: {},
      runsRetention: { maxPerWorkspace: 0 },
        recentWorkspaces: [
          { path: '/ws/recent', lastOpenedAt: '3' },
          { path: '/ws/pinned', lastOpenedAt: '1', pinned: true },
        ],
      },
    });
    renderSwitcher();

    fireEvent.click(screen.getByRole('button', { name: /recent/ }));
    const items = await screen.findAllByRole('menuitem');
    expect(items[0]).toHaveTextContent('pinned');
    expect(items[1]).toHaveTextContent('recent');
  });

  it('pins the current workspace and adopts the list the agent returns', async () => {
    useAppStore.setState({
      workspacePath: '/ws/a',
      appState: {
        schemaVersion: 1, window: null, lastPage: null, theme: 'system', workspaces: {},
      runsRetention: { maxPerWorkspace: 0 },
        recentWorkspaces: [{ path: '/ws/a', lastOpenedAt: '1' }],
      },
    });
    const { transport } = renderSwitcher();

    fireEvent.click(screen.getByRole('button', { name: /ws\/a/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Pin this workspace/ }));

    const pin = await sentRequest(transport, 'setWorkspacePinned');
    expect(pin.params).toEqual({ path: '/ws/a', pinned: true });
    await respond(transport, 'setWorkspacePinned', {
      recentWorkspaces: [{ path: '/ws/a', lastOpenedAt: '1', pinned: true }],
    });
    await waitFor(() =>
      expect(useAppStore.getState().appState?.recentWorkspaces[0].pinned).toBe(true));
  });

  it('surfaces a failed open instead of swallowing it', async () => {
    useAppStore.setState({
      workspacePath: null,
      appState: {
        schemaVersion: 1, window: null, lastPage: null, theme: 'system', workspaces: {},
      runsRetention: { maxPerWorkspace: 0 },
        recentWorkspaces: [{ path: '/ws/unmounted', lastOpenedAt: '1', pinned: true }],
      },
    });
    const { transport } = renderSwitcher();

    fireEvent.click(screen.getByRole('button', { name: /Open workspace/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /unmounted/ }));

    const open = await sentRequest(transport, 'touchRecentWorkspace');
    transport.emitLine({
      id: open.id,
      error: { code: -32000, message: 'not an existing directory: /ws/unmounted' },
    });

    expect(await screen.findByText(/not an existing directory/)).toBeInTheDocument();
  });

  it('browses with the native picker when the host has one', async () => {
    const { transport } = renderSwitcher(DESKTOP_CAPS);
    fireEvent.click(screen.getByRole('button', { name: /Open workspace/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /browse/i }));

    const req = await sentRequest(transport, 'touchRecentWorkspace');
    expect(req.params).toEqual({ path: '/picked' });
  });

  it('takes a typed path where there is no native picker', async () => {
    const { transport } = renderSwitcher(BROWSER_CAPS);
    fireEvent.click(screen.getByRole('button', { name: /Open workspace/ }));

    // Browse… would open a dialog the browser cannot show, so it is replaced.
    expect(screen.queryByRole('menuitem', { name: /browse/i })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitem', { name: /open path/i }));

    fireEvent.change(await screen.findByRole('textbox', { name: /workspace path/i }), {
      target: { value: '/srv/elsewhere' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    const req = await sentRequest(transport, 'touchRecentWorkspace');
    expect(req.params).toEqual({ path: '/srv/elsewhere' });
  });
});
