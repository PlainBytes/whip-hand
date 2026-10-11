import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RunTabStrip } from './RunTabStrip.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore, type JobState } from '../state/store.ts';
import { settlePendingWorkspaceSwitch } from '../lib/workspace-switch.ts';
import { isPreview, type RunTab } from '../lib/run-tabs.ts';

const tab = (runId: string, extra: Partial<RunTab> = {}): RunTab => (
  { kind: 'run', key: runId, workdir: '/ws/a', runId, preview: false, ...extra }
);

function renderStrip() {
  const transport = new MockTransport();
  render(
    <AgentClientProvider client={new AgentClient(transport)}>
      <RunTabStrip />
    </AgentClientProvider>,
  );
  return { transport };
}

/** Everything the strip asked the agent for; the client's own `hello` handshake is not its doing. */
const sentMethods = (transport: MockTransport): string[] =>
  transport.sent.map(line => (JSON.parse(line) as { method: string }).method).filter(method => method !== 'hello');

async function touchRequest(transport: MockTransport) {
  return waitFor(() => {
    const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === 'touchRecentWorkspace');
    if (index === -1) throw new Error('touchRecentWorkspace not sent yet');
    return transport.sentRequest(index);
  });
}

function job(jobId: string, extra: Partial<JobState> = {}): JobState {
  return {
    jobId, finished: false, stepOrder: [], steps: {}, currentExecution: {}, events: [], logTail: [], logRows: [],
    activityTail: [], hasNarrated: false, ptyActive: true, ptyDataBuffer: [], ptyDataBaseIndex: 0,
    ptyDataTrimmed: false, ptyExited: false, ...extra,
  };
}

function seed(tabs: RunTab[], activeTabKey: string | null): void {
  useAppStore.setState({ workspacePath: '/ws/a', workspaceIdentityKey: null, tabs, activeTabKey, jobs: {}, runs: [] });
}

describe('RunTabStrip', () => {
  beforeEach(() => seed([], null));
  afterEach(() => {
    settlePendingWorkspaceSwitch(false);
    useAppStore.setState({ tabs: [], activeTabKey: null, drafts: {}, jobs: {}, filesDirty: false, workspacePath: null });
  });

  it('always starts with the Runs tab, which has no close button', () => {
    seed([tab('r1')], 'r1');
    renderStrip();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent(/^Runs/);
    expect(tabs[1]).toHaveTextContent('r1');
    expect(within(tabs[0]!).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /r1/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('selects the Runs tab when activeTabKey is null', () => {
    seed([tab('r1')], null);
    renderStrip();
    expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
  });

  it('labels a tab by run name, then runId, and a job without a run "(starting…)"', () => {
    seed([tab('r1'), tab('r2'), { kind: 'run', key: 'j1', workdir: '/ws/a', jobId: 'j1', preview: false }], 'r1');
    useAppStore.setState({ jobs: { j1: job('j1') }, runs: [{ runId: 'r1', runDir: '/x', status: 'running', name: 'Nice name' }] });
    renderStrip();
    expect(screen.getByText('Nice name')).toBeInTheDocument();
    expect(screen.getByText('r2')).toBeInTheDocument();
    expect(screen.getByText('(starting…)')).toBeInTheDocument();
  });

  it('shows the live status of the run beside its title', () => {
    seed([tab('r1', { jobId: 'j1' })], 'r1');
    useAppStore.setState({ jobs: { j1: job('j1', { runId: 'r1', pendingManual: {} as never }) } });
    renderStrip();
    // The waiting glyph is a badge; a finished, clean run shows none.
    expect(document.querySelector('.fui-Badge')).not.toBeNull();
    act(() => useAppStore.setState({ jobs: { j1: job('j1', { runId: 'r1', finished: true }) } }));
    expect(document.querySelector('.fui-Badge')).toBeNull();
  });

  it('italicises only the preview tab\'s title', () => {
    seed([tab('r1', { preview: true }), tab('r2')], 'r1');
    renderStrip();
    expect(screen.getByTestId('run-tab-title-r1')).toHaveStyle({ fontStyle: 'italic' });
    expect(screen.getByTestId('run-tab-title-r2')).not.toHaveStyle({ fontStyle: 'italic' });
  });

  it('pins a preview tab when it is double-clicked', () => {
    seed([tab('r1', { preview: true })], 'r1');
    renderStrip();
    fireEvent.doubleClick(screen.getByRole('tab', { name: /r1/ }));
    expect(isPreview(useAppStore.getState().tabs[0]!)).toBe(false);
    expect(screen.getByTestId('run-tab-title-r1')).not.toHaveStyle({ fontStyle: 'italic' });
  });

  it('closes a tab from its button without selecting it, and activates the neighbour', () => {
    seed([tab('r1'), tab('r2')], 'r1');
    renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'Close r1' }));
    expect(useAppStore.getState().tabs.map(t => t.key)).toEqual(['r2']);
    expect(useAppStore.getState().activeTabKey).toBe('r2');
  });

  it('falls back to the Runs tab when the last tab closes', () => {
    seed([tab('r1')], 'r1');
    renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'Close r1' }));
    expect(useAppStore.getState()).toMatchObject({ tabs: [], activeTabKey: null });
  });

  it('never touches the run when its tab closes', () => {
    seed([tab('r1', { jobId: 'j1' })], 'r1');
    useAppStore.setState({ jobs: { j1: job('j1', { runId: 'r1' }) } });
    const { transport } = renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'Close r1' }));
    expect(sentMethods(transport)).toEqual([]);
    expect(useAppStore.getState().jobs.j1!.finished).toBe(false);
  });

  it('activates a tab of the open workspace without any workspace switch', () => {
    seed([tab('r1'), tab('r2')], 'r1');
    const { transport } = renderStrip();
    fireEvent.click(screen.getByRole('tab', { name: /r2/ }));
    expect(useAppStore.getState().activeTabKey).toBe('r2');
    expect(sentMethods(transport)).toEqual([]);
  });

  it('goes back to the Runs tab when it is clicked', () => {
    seed([tab('r1')], 'r1');
    renderStrip();
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(useAppStore.getState().activeTabKey).toBeNull();
  });

  it('switches workspace through openWorkspace before activating a tab from another one', async () => {
    seed([tab('r1'), tab('r2', { workdir: '/ws/b' })], 'r1');
    const { transport } = renderStrip();
    fireEvent.click(screen.getByRole('tab', { name: /r2/ }));

    const req = await touchRequest(transport);
    expect(req).toMatchObject({ method: 'touchRecentWorkspace', params: { path: '/ws/b' } });
    transport.emitLine({ id: req.id, result: { recentWorkspaces: [{ path: '/ws/b', lastOpenedAt: 'now' }] } });

    await waitFor(() => expect(useAppStore.getState().activeTabKey).toBe('r2'));
    expect(useAppStore.getState().workspacePath).toBe('/ws/b');
    expect(useAppStore.getState().tabs).toHaveLength(2);
  });

  it('leaves the workspace and the active tab alone when the unsaved-edits guard is refused', async () => {
    seed([tab('r1'), tab('r2', { workdir: '/ws/b' })], 'r1');
    useAppStore.setState({ filesDirty: true });
    const { transport } = renderStrip();
    fireEvent.click(screen.getByRole('tab', { name: /r2/ }));

    await waitFor(() => expect(useAppStore.getState().pendingWorkspaceSwitch).toBe('/ws/b'));
    act(() => settlePendingWorkspaceSwitch(false));

    await waitFor(() => expect(useAppStore.getState().pendingWorkspaceSwitch).toBeNull());
    expect(useAppStore.getState().activeTabKey).toBe('r1');
    expect(useAppStore.getState().workspacePath).toBe('/ws/a');
    expect(sentMethods(transport)).toEqual([]);
  });

  it('leaves the active tab alone when the other workspace cannot be opened', async () => {
    seed([tab('r1'), tab('r2', { workdir: '/ws/gone' })], 'r1');
    const { transport } = renderStrip();
    fireEvent.click(screen.getByRole('tab', { name: /r2/ }));
    const req = await touchRequest(transport);
    transport.emitLine({ id: req.id, error: { code: -32000, message: 'ENOENT' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(useAppStore.getState().activeTabKey).toBe('r1');
  });

  it('re-keys a just-started tab once its job learns a runId', async () => {
    seed([{ kind: 'run', key: 'j1', workdir: '/ws/a', jobId: 'j1', preview: false }], 'j1');
    useAppStore.setState({ jobs: { j1: job('j1') } });
    renderStrip();
    act(() => useAppStore.setState({ jobs: { j1: job('j1', { runId: 'r9' }) } }));
    await waitFor(() => expect(useAppStore.getState().tabs[0]).toMatchObject({ key: 'r9', jobId: 'j1', runId: 'r9' }));
    expect(useAppStore.getState().activeTabKey).toBe('r9');
  });

  it('shows the Runs list rather than a tab of another workspace after closing the active one', async () => {
    seed([tab('r1'), tab('r2', { workdir: '/ws/b' })], 'r1');
    const { transport } = renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'Close r1' }));
    expect(useAppStore.getState().activeTabKey).toBeNull();
    const req = await touchRequest(transport);
    expect(req).toMatchObject({ method: 'touchRecentWorkspace', params: { path: '/ws/b' } });
  });

  describe('draft tabs', () => {
    function seedDraft(init: Parameters<ReturnType<typeof useAppStore.getState>['createDraft']>[0] = { workdir: '/ws/a' }): string {
      const id = useAppStore.getState().createDraft(init);
      useAppStore.getState().openDraftTab(id);
      return id;
    }

    it('shows "New run" with a pencil glyph for a blank draft', () => {
      const id = seedDraft();
      renderStrip();
      expect(screen.getByTestId(`run-tab-title-${id}`)).toHaveTextContent('New run');
      expect(screen.getByTestId(`draft-tab-glyph-${id}`)).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /New run/ })).toHaveAttribute('aria-selected', 'true');
    });

    it('is titled by the selected workflow, and the typed run name wins', () => {
      const id = seedDraft();
      renderStrip();
      act(() => useAppStore.getState().updateDraft(id, { workflowRef: 'global:ship' }));
      expect(screen.getByTestId(`run-tab-title-${id}`)).toHaveTextContent('ship');
      act(() => useAppStore.getState().updateDraft(id, { name: 'My run' }));
      expect(screen.getByTestId(`run-tab-title-${id}`)).toHaveTextContent('My run');
    });

    it('is never italic, as a preview is', () => {
      const id = seedDraft();
      renderStrip();
      expect(screen.getByTestId(`run-tab-title-${id}`)).not.toHaveStyle({ fontStyle: 'italic' });
    });

    it('closes an untouched draft at once, deleting it', () => {
      const id = seedDraft();
      renderStrip();
      fireEvent.click(screen.getByRole('button', { name: 'Close New run' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(useAppStore.getState()).toMatchObject({ tabs: [], activeTabKey: null });
      expect(useAppStore.getState().drafts[id]).toBeUndefined();
    });

    it('asks before closing a draft with content, and keeps it on Keep editing', async () => {
      const id = seedDraft();
      useAppStore.getState().updateDraft(id, { name: 'work' });
      renderStrip();
      fireEvent.click(screen.getByRole('button', { name: 'Close work' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(useAppStore.getState().drafts[id]).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(useAppStore.getState().tabs).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: 'Close work' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
      expect(useAppStore.getState().drafts[id]).toBeUndefined();
      expect(useAppStore.getState().tabs).toEqual([]);
    });

    it('switches workspace through openWorkspace before activating a draft from another one', async () => {
      const id = seedDraft({ workdir: '/ws/b' });
      act(() => useAppStore.getState().activateTab(null));
      const { transport } = renderStrip();
      fireEvent.click(screen.getByRole('tab', { name: /New run/ }));

      const req = await touchRequest(transport);
      expect(req).toMatchObject({ method: 'touchRecentWorkspace', params: { path: '/ws/b' } });
      transport.emitLine({ id: req.id, result: { recentWorkspaces: [{ path: '/ws/b', lastOpenedAt: 'now' }] } });
      await waitFor(() => expect(useAppStore.getState().activeTabKey).toBe(id));
      expect(useAppStore.getState().workspacePath).toBe('/ws/b');
    });
  });
});
