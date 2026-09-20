import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomePage } from './WelcomePage.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { EMPTY_APP_STATE } from '../../../../packages/agent/src/app-state.ts';
import { CapabilitiesProvider, type AppCapabilities } from '../capabilities.tsx';

const BROWSER_CAPS: AppCapabilities = { host: 'browser', localFiles: false };
/** Production supplies the real Tauri dialog; a stub is enough to prove the branch. */
const DESKTOP_CAPS: AppCapabilities = {
  host: 'desktop', localFiles: true, pickDirectory: async () => '/picked',
};

function renderWelcome(capabilities?: AppCapabilities) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  const tree = (
    <AgentClientProvider client={client}>
      <WelcomePage />
    </AgentClientProvider>
  );
  render(
    capabilities
      ? <CapabilitiesProvider value={capabilities}>{tree}</CapabilitiesProvider>
      : tree,
  );
  return { transport, client };
}

async function respond(transport: MockTransport, method: string, result: unknown) {
  const req = await waitFor(() => {
    const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === method);
    if (index === -1) throw new Error(`${method} not sent yet`);
    return transport.sentRequest(index);
  });
  transport.emitLine({ id: req.id, result });
}

describe('WelcomePage', () => {
  beforeEach(() => {
    useAppStore.setState({
      workspacePath: null, doctorResult: null,
      appState: {
        ...EMPTY_APP_STATE,
        recentWorkspaces: [{ path: '/ws-a', lastOpenedAt: '2026-01-01T00:00:00Z' }],
      },
      restoreDone: true,
    });
  });

  it('shows the product mark beside the greeting', () => {
    renderWelcome();
    // Decorative, so it is reachable by role rather than by an accessible name.
    const mark = document.querySelector('img[src="/logo.png"]');
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute('alt')).toBe('');
  });

  it('lists recent workspaces as clickable cards and opens one via touchRecentWorkspace', async () => {
    const { transport } = renderWelcome();
    fireEvent.click(await screen.findByRole('button', { name: /ws-a/ }));
    await respond(transport, 'touchRecentWorkspace', {
      recentWorkspaces: [{ path: '/ws-a', lastOpenedAt: 'now' }],
    });
    await waitFor(() => expect(useAppStore.getState().workspacePath).toBe('/ws-a'));
  });

  it('shows doctor status inline', async () => {
    const { transport } = renderWelcome();
    await respond(transport, 'doctor', [
      { id: 'claude', label: 'Claude Code', group: 'harness', runner: true, optional: false, installed: true, version: '3.0.0' },
      { id: 'copilot', label: 'GitHub Copilot CLI', group: 'harness', runner: true, optional: false, installed: false },
    ]);
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(await screen.findByText(/not installed/)).toBeInTheDocument();
  });

  it('lists only actual runners — not support tools', async () => {
    // Doctor reports the whole machine now; this heading says "Runners" and
    // must keep meaning it, or jq shows up as something you could run a
    // workflow on.
    const { transport } = renderWelcome();
    await respond(transport, 'doctor', [
      { id: 'claude', label: 'Claude Code', group: 'harness', runner: true, optional: false, installed: true, version: '3.0.0' },
      { id: 'git', label: 'Git', group: 'support', runner: false, optional: false, installed: true, version: '2.53.0' },
      { id: 'jq', label: 'jq', group: 'support', runner: false, optional: true, installed: true, version: '1.8.1' },
    ]);

    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.queryByText('Git')).not.toBeInTheDocument();
    expect(screen.queryByText('jq')).not.toBeInTheDocument();
  });

  // Regression guard: this is the exact degraded path the app must survive —
  // getAppState failed (old agent, broken disk file) so useStartupRestore's
  // `finally` still called setRestoreDone(), and WelcomePage renders with
  // appState still null. An inline `?? []` selector fallback allocates a new
  // array every render, which fails zustand's Object.is check and loops
  // forever ("Maximum update depth exceeded"). Every other test here seeds a
  // non-null appState, which is why this went undetected across 14 task reviews.
  it('renders without an infinite render loop when appState is null', async () => {
    useAppStore.setState({
      workspacePath: null,
      doctorResult: null,
      appState: null,
      restoreDone: true,
    });

    renderWelcome();

    expect(await screen.findByText('Welcome to Whiphand')).toBeInTheDocument();
    expect(screen.queryByText('Recent workspaces')).not.toBeInTheDocument();
  });

  it('offers the native picker on the desktop', async () => {
    const { transport } = renderWelcome(DESKTOP_CAPS);
    await respond(transport, 'doctor', []);
    expect(await screen.findByRole('button', { name: /open workspace…/i })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /workspace path/i })).not.toBeInTheDocument();
  });

  it('offers a path field instead where there is no native picker', async () => {
    // A browser cannot open a folder dialog, so the affordance is replaced
    // rather than shown and left inert.
    const { transport } = renderWelcome(BROWSER_CAPS);
    await respond(transport, 'doctor', []);

    expect(screen.queryByRole('button', { name: /open workspace…/i })).not.toBeInTheDocument();
    const field = await screen.findByRole('textbox', { name: /workspace path/i });
    fireEvent.change(field, { target: { value: '/srv/project' } });
    fireEvent.click(screen.getByRole('button', { name: /open workspace/i }));

    const req = await waitFor(() => {
      const i = transport.sent.findIndex(l =>
        (JSON.parse(l) as { method: string }).method === 'touchRecentWorkspace');
      if (i === -1) throw new Error('not sent yet');
      return transport.sentRequest(i);
    });
    expect(req.params).toEqual({ path: '/srv/project' });
  });
});
