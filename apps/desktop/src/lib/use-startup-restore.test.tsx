import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useStartupRestore } from './use-startup-restore.ts';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { useAppStore } from '../state/store.ts';
import { EMPTY_APP_STATE } from '../test/app-state.ts';
import type { AppState } from '../shared/protocol.gen.ts';

async function respond(transport: MockTransport, method: string, result: unknown) {
  const index = await waitFor(() => {
    const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === method);
    if (i === -1) throw new Error(`${method} not sent yet`);
    return i;
  });
  transport.emitLine({ id: transport.sentRequest(index).id, result });
}

function reset(): void {
  useAppStore.setState({
    agentStatus: 'connecting', restoreDone: false, workspacePath: null, workspaceIdentityKey: null,
    appState: null, drafts: {}, tabs: [], activeTabKey: null, page: 'runs', jobs: {},
  });
}

const SAVED: AppState = {
  ...EMPTY_APP_STATE,
  lastPage: 'runs',
  recentWorkspaces: [{ path: '/ws/a', lastOpenedAt: '2' }, { path: '/ws/b', lastOpenedAt: '1' }],
  runDrafts: [{
    id: 'd1', workdir: '/ws/b', workflow: 'triage', inputs: { ticket: 'T-1' }, name: 'mine', dryRun: true,
    attachments: [{ path: '/data/drafts/d1/pasted-1.png', pasted: true }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }],
  runTabs: {
    tabs: [
      { kind: 'run', workdir: '/ws/a', runId: 'r1', preview: false },
      { kind: 'run', workdir: '/ws/a', runId: 'gone', preview: true },
      { kind: 'draft', draftId: 'd1' },
    ],
    active: 'd1',
  },
};

describe('useStartupRestore: drafts and tabs', () => {
  beforeEach(reset);
  afterEach(reset);

  it('hydrates drafts and tabs once, drops a run that is gone, and lands on the active tab\'s workspace', async () => {
    const transport = new MockTransport();
    const client = new AgentClient(transport);
    const { unmount } = renderHook(() => useStartupRestore(client));
    useAppStore.setState({ agentStatus: 'connected' });

    await respond(transport, 'getAppState', SAVED);
    await respond(transport, 'listRuns', [{ runId: 'r1' }]);
    await waitFor(() => expect(useAppStore.getState().restoreDone).toBe(true));

    const state = useAppStore.getState();
    expect(state.tabs).toEqual([
      { kind: 'run', key: 'r1', workdir: '/ws/a', runId: 'r1', preview: false },
      { kind: 'draft', key: 'd1' },
    ]);
    expect(state.activeTabKey).toBe('d1');
    expect(state.drafts.d1).toMatchObject({
      workflowRef: 'triage', values: { ticket: 'T-1' }, name: 'mine', dryRun: true,
      attachments: [{ key: 0, path: '/data/drafts/d1/pasted-1.png', pasted: true }],
    });
    // The most recent workspace is /ws/a; the active tab is a draft in /ws/b.
    expect(state.workspacePath).toBe('/ws/b');
    // Restoring is not an edit: nothing is written back.
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(transport.sent.map(line => (JSON.parse(line) as { method: string }).method))
      .not.toContain('saveRunDraft');
    unmount();
  });

  it('restores nothing, and still finishes, when the agent has no app state', async () => {
    const transport = new MockTransport();
    const client = new AgentClient(transport);
    renderHook(() => useStartupRestore(client));
    useAppStore.setState({ agentStatus: 'connected' });
    const req = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'getAppState');
      if (i === -1) throw new Error('not sent');
      return transport.sentRequest(i);
    });
    transport.emitLine({ id: req.id, error: { code: -32000, message: 'no state' } });
    await waitFor(() => expect(useAppStore.getState().restoreDone).toBe(true));
    expect(useAppStore.getState().tabs).toEqual([]);
  });
});
