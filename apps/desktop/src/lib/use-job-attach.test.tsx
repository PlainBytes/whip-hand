/**
 * useJobAttach seeds the store from the agent on every transition into
 * 'connected': listJobs, then getJobScrollback per job, then — when the agent
 * is new enough to send them — applyEventReplay on whatever events came back.
 * Driven directly through the hook against a real AgentClient over a
 * MockTransport, the same fake RunDetailPage.test.tsx uses for its own
 * RPC-round-trip tests. Without this test, deleting the applyEventReplay call
 * in use-job-attach.ts — the whole fix for a client that attaches mid-step —
 * would leave every other suite green.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useJobAttach } from './use-job-attach.ts';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { useAppStore } from '../state/store.ts';

async function respond(transport: MockTransport, method: string, result: unknown) {
  const index = await waitFor(() => {
    const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === method);
    if (i === -1) throw new Error(`${method} not sent yet`);
    return i;
  });
  const req = transport.sentRequest(index);
  transport.emitLine({ id: req.id, result });
}

function connect(): { transport: MockTransport } {
  useAppStore.setState({ jobs: {}, agentStatus: 'connecting' });
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  const { rerender } = renderHook(() => useJobAttach(client));
  // useJobAttach only fires on the TRANSITION into 'connected'.
  useAppStore.setState({ agentStatus: 'connected' });
  rerender();
  return { transport };
}

describe('useJobAttach', () => {
  it('replays the agent\'s buffered events into the store on connect', async () => {
    const { transport } = connect();

    await respond(transport, 'listJobs', [
      { jobId: 'j1', workdir: '/ws', runId: 'r1', status: 'running', pty: null, pendingManual: undefined },
    ]);
    await respond(transport, 'getJobScrollback', {
      pty: null, logs: { baseIndex: 0, trimmed: false, lines: [] },
      events: [{
        jobId: 'j1', runId: 'r1', ts: 't0', seq: 0,
        event: { type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'claude', mode: 'headless' },
      }],
    });

    // Without the replay wired up, this job would have no `execute` row at
    // all — the store is built purely from notifications, and this client
    // never saw a live step:start for it.
    await waitFor(() => {
      expect(useAppStore.getState().jobs.j1?.steps.execute?.status).toBe('running');
    });
  });

  it('is a no-op against an older agent whose scrollback carries no events', async () => {
    const { transport } = connect();

    await respond(transport, 'listJobs', [
      { jobId: 'j1', workdir: '/ws', runId: 'r1', status: 'running', pty: null, pendingManual: undefined },
    ]);
    // No `events` field at all — jobScrollbackSchema makes it optional
    // precisely so an older agent's response still parses.
    await respond(transport, 'getJobScrollback', {
      pty: null, logs: { baseIndex: 0, trimmed: false, lines: [] },
    });

    await waitFor(() => {
      expect(useAppStore.getState().jobs.j1).toBeDefined();
    });
    expect(useAppStore.getState().jobs.j1?.steps).toEqual({});
  });
});
