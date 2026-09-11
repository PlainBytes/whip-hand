import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Sidebar } from './Sidebar.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { pagesInGroup, type PageId } from '../nav.ts';
import { CapabilitiesProvider, type AppCapabilities } from '../capabilities.tsx';

const BROWSER_CAPS: AppCapabilities = { host: 'browser', localFiles: false };

function renderSidebar(page: PageId = 'runs', capabilities?: AppCapabilities) {
  const onSelectPage = vi.fn();
  const tree = (
    <FluentProvider theme={webLightTheme}>
      <AgentClientProvider client={new AgentClient(new MockTransport())}>
        <Sidebar page={page} onSelectPage={onSelectPage} />
      </AgentClientProvider>
    </FluentProvider>
  );
  render(
    capabilities
      ? <CapabilitiesProvider value={capabilities}>{tree}</CapabilitiesProvider>
      : tree,
  );
  return { onSelectPage };
}

afterEach(() => useAppStore.setState({ workspacePath: null, appState: null, remoteAccess: null }));

describe('Sidebar', () => {
  it('renders both groups inside one navigation landmark', () => {
    useAppStore.setState({ workspacePath: '/ws' });
    renderSidebar();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const def of [...pagesInGroup('workspace'), ...pagesInGroup('app')]) {
      expect(within(nav).getByRole('button', { name: def.label })).toBeInTheDocument();
    }
  });

  it('enables the workspace group only when a workspace is open', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Files' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Doctor' })).toBeEnabled();
  });

  it('marks the selected page, but never a gated one', () => {
    useAppStore.setState({ workspacePath: '/ws' });
    renderSidebar('workflows');
    expect(screen.getByRole('button', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Runs' })).not.toHaveAttribute('aria-current');
  });

  it('badges Activity with live jobs from every workspace', () => {
    const job = (jobId: string, workdir: string, awaiting = false) => ({
      jobId, workdir, finished: false, stepOrder: [], steps: {}, currentExecution: {},
      events: [], logTail: [], activityTail: [], hasNarrated: false, ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0,
      ptyDataTrimmed: false, ptyExited: false,
      ...(awaiting ? { awaiting: { stepId: 's', reason: 'permission' as const } } : {}),
    });
    useAppStore.setState({
      workspacePath: '/ws/a',
      jobs: { j1: job('j1', '/ws/a'), j2: job('j2', '/ws/b') },
    });
    renderSidebar();
    // The badge itself is aria-hidden, so the count reaches the name instead.
    expect(screen.getByRole('button', { name: 'Activity (2 running)' })).toBeInTheDocument();
  });

  it('shows no badge when nothing is running', () => {
    useAppStore.setState({ workspacePath: '/ws', jobs: {} });
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument();
  });

  it('does not mark a workspace page current while no workspace is open', () => {
    renderSidebar('runs');
    expect(screen.getByRole('button', { name: 'Runs' })).not.toHaveAttribute('aria-current');
  });

  it('shows nothing about remote access while it is off', () => {
    useAppStore.setState({ workspacePath: '/ws' });
    renderSidebar();
    expect(screen.queryByText(/remote access on/i)).not.toBeInTheDocument();
  });

  it('marks the app persistently while this machine is reachable', () => {
    // Remote access survives a restart once enabled, so a listening port with
    // nothing on screen saying so is exactly the state to avoid.
    useAppStore.setState({
      workspacePath: '/ws',
      remoteAccess: {
        enabled: true, port: 61338, listening: true, error: null,
        clientCount: 2, addresses: ['192.168.1.20'], webRootPresent: true,
      },
    });
    renderSidebar();

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByText(/remote access on/i)).toBeInTheDocument();
  });

  it('does not mark the app when remote access is enabled but failed to bind', () => {
    useAppStore.setState({
      workspacePath: '/ws',
      remoteAccess: {
        enabled: true, port: 61338, listening: false, error: 'Port 61338 is already in use',
        clientCount: 0, addresses: [], webRootPresent: true,
      },
    });
    renderSidebar();
    expect(screen.queryByText(/remote access on/i)).not.toBeInTheDocument();
  });

  it('omits the Files page where there is no local filesystem', () => {
    useAppStore.setState({ workspacePath: '/ws' });
    renderSidebar('runs', BROWSER_CAPS);

    expect(screen.queryByRole('button', { name: /^Files$/ })).not.toBeInTheDocument();
    // Everything else still reaches the agent over RPC and stays.
    for (const label of ['Runs', 'Workflows', 'Settings', 'Activity', 'Doctor', 'Preferences']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}$`) })).toBeInTheDocument();
    }
  });
});
