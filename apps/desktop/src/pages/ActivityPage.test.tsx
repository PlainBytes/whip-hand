import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ActivityPage } from './ActivityPage.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';

function renderActivity(onSelectRun = vi.fn()) {
  const transport = new MockTransport();
  render(
    <AgentClientProvider client={new AgentClient(transport)}>
      <ActivityPage onSelectRun={onSelectRun} />
    </AgentClientProvider>,
  );
  return { transport, onSelectRun };
}

async function respond(transport: MockTransport, method: string, result: unknown) {
  const req = await waitFor(() => {
    const index = transport.sent.findIndex(
      line => (JSON.parse(line) as { method: string }).method === method);
    if (index === -1) throw new Error(`${method} not sent yet`);
    return transport.sentRequest(index);
  });
  transport.emitLine({ id: req.id, result });
  return req;
}

describe('ActivityPage', () => {
  beforeEach(() => useAppStore.setState({ workspacePath: '/ws', jobs: {} }));
  afterEach(() => useAppStore.setState({ workspacePath: null, jobs: {} }));

  it('lists runs from every recent workspace, naming each one', async () => {
    const { transport } = renderActivity();
    await respond(transport, 'listRecentRuns', [
      { runId: 'r-a', runDir: '/ws/.whiphand/runs/r-a', status: 'succeeded', workflow: 'demo', startedAt: '2026-01-02T00:00:00Z', workspace: '/ws' },
      { runId: 'r-b', runDir: '/other/.whiphand/runs/r-b', status: 'running', workflow: 'demo', startedAt: '2026-01-01T00:00:00Z', workspace: '/dev/other' },
    ]);

    expect(await screen.findByText('r-a')).toBeInTheDocument();
    expect(screen.getByText('r-b')).toBeInTheDocument();
    expect(screen.getByText('other')).toBeInTheDocument();
  });

  it('opens a run in its own workspace, switching there first', async () => {
    const { transport, onSelectRun } = renderActivity();
    await respond(transport, 'listRecentRuns', [
      { runId: 'r-other', runDir: '/other/.whiphand/runs/r-other', status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', workspace: '/other' },
    ]);

    fireEvent.click(await screen.findByText('r-other'));
    await respond(transport, 'touchRecentWorkspace', {
      recentWorkspaces: [{ path: '/other', lastOpenedAt: 'now' }],
    });

    await waitFor(() => expect(useAppStore.getState().workspacePath).toBe('/other'));
    await waitFor(() => expect(onSelectRun).toHaveBeenCalledWith('r-other'));
  });

  it('does not navigate into a run when switching to its workspace fails', async () => {
    const { transport, onSelectRun } = renderActivity();
    await respond(transport, 'listRecentRuns', [
      { runId: 'r-gone', runDir: '/gone/.whiphand/runs/r-gone', status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', workspace: '/gone' },
    ]);

    fireEvent.click(await screen.findByText('r-gone'));
    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'touchRecentWorkspace') throw new Error('touchRecentWorkspace not sent yet');
      return parsed;
    });
    transport.emitLine({ id: req.id, error: { code: -32000, message: 'ENOENT' } });

    expect(await screen.findByText(/Could not open workspace: \/gone/)).toBeInTheDocument();
    expect(onSelectRun).not.toHaveBeenCalled();
    expect(useAppStore.getState().workspacePath).toBe('/ws');
  });

  it('marks a run waiting even when it is blocked in another workspace', async () => {
    useAppStore.setState({
      jobs: {
        j1: {
          jobId: 'j1', runId: 'r-b', workdir: '/dev/other', finished: false, stepOrder: [],
          steps: {}, currentExecution: {}, events: [], logTail: [], activityTail: [], hasNarrated: false, ptyActive: true,
          ptyDataBuffer: [], ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
          awaiting: { stepId: 'plan', reason: 'permission' },
        },
      },
    });
    const { transport } = renderActivity();
    await respond(transport, 'listRecentRuns', [
      { runId: 'r-b', runDir: '/other/.whiphand/runs/r-b', status: 'running', startedAt: '2026-01-01T00:00:00Z', workspace: '/dev/other' },
    ]);

    expect(await screen.findByText('waiting')).toBeInTheDocument();
  });
});
