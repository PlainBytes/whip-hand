import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RunsPage } from './RunsPage.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { hasInjectedStyle } from '../test/badge-style.ts';

function renderRunsPage(onSelectRun = vi.fn(), onStarted = vi.fn()) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  render(
    <AgentClientProvider client={client}>
      <RunsPage onSelectRun={onSelectRun} onStarted={onStarted} />
    </AgentClientProvider>,
  );
  return { transport, client, onSelectRun, onStarted };
}

describe('RunsPage', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', runs: [], jobs: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    useAppStore.setState({ workspacePath: null, runs: [], pendingRunAgain: null });
  });

  async function respondListRuns(transport: MockTransport, result: unknown) {
    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'listRuns') throw new Error('listRuns not sent yet');
      return parsed;
    });
    transport.emitLine({ id: req.id, result });
  }

  it('renders scripted listRuns rows including an interrupted and an unknown row', async () => {
    const { transport } = renderRunsPage();

    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'running', workflow: 'demo', startedAt: '2026-01-01T00:00:00Z' },
      { runId: 'r2', runDir: '/ws/.whiphand/runs/r2', status: 'interrupted', workflow: 'demo', startedAt: '2026-01-01T00:00:00Z' },
      { runId: 'r3', runDir: '/ws/.whiphand/runs/r3', status: 'unknown' },
    ]);

    expect(await screen.findByText('r1')).toBeInTheDocument();
    expect(screen.getByText('r2')).toBeInTheDocument();
    expect(screen.getByText('r3')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('interrupted')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('shows a named run by its name, with the id still on screen beside it', async () => {
    const { transport } = renderRunsPage();

    await respondListRuns(transport, [
      {
        runId: '20260101-000000-aaaa', runDir: '/ws/.whiphand/runs/20260101-000000-aaaa',
        status: 'succeeded', workflow: 'demo', startedAt: '2026-01-01T00:00:00Z',
        name: 'OAuth support',
      },
      {
        runId: '20260101-010000-bbbb', runDir: '/ws/.whiphand/runs/20260101-010000-bbbb',
        status: 'succeeded', workflow: 'demo', startedAt: '2026-01-01T01:00:00Z',
      },
    ]);

    expect(await screen.findByText('OAuth support')).toBeInTheDocument();
    // The id is what --resume and rename-run take, so it must stay readable.
    expect(screen.getByText('20260101-000000-aaaa')).toBeInTheDocument();
    // An unnamed run is exactly as it was before names existed.
    expect(screen.getByText('20260101-010000-bbbb')).toBeInTheDocument();
    expect(screen.getByText('Run')).toBeInTheDocument();
  });

  it("a named run's row actions and delete dialog say the name, not the id", async () => {
    const { transport } = renderRunsPage();
    await respondListRuns(transport, [{
      runId: '20260101-000000-aaaa', runDir: '/ws/.whiphand/runs/20260101-000000-aaaa',
      status: 'succeeded', workflow: 'demo', startedAt: '2026-01-01T00:00:00Z',
      name: 'OAuth support',
    }]);

    expect(await screen.findByLabelText('Lock OAuth support')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Delete OAuth support'));
    expect(await screen.findByText('Delete OAuth support?')).toBeInTheDocument();
  });

  it('styles the row Delete subtle red and the confirm Delete filled red', async () => {
    const { transport } = renderRunsPage();
    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'succeeded', workflow: 'demo' },
    ]);

    const rowDelete = await screen.findByRole('button', { name: 'Delete r1' });
    expect(hasInjectedStyle(rowDelete, 'color', 'var(--colorPaletteRedForeground1)')).toBe(true);
    expect(hasInjectedStyle(rowDelete, 'background-color', 'var(--colorPaletteRedBackground3)')).toBe(false);

    fireEvent.click(rowDelete);
    const confirm = within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' });
    expect(hasInjectedStyle(confirm, 'background-color', 'var(--colorPaletteRedBackground3)')).toBe(true);
  });

  it('shows a run blocked on the human as waiting, not merely running', async () => {
    // The run row comes off disk, where it just says 'running'; only the live
    // job knows anyone is waiting, so the two are bridged by runId.
    useAppStore.setState({
      jobs: {
        j1: {
          jobId: 'j1', runId: 'r1', workdir: '/ws', finished: false, stepOrder: [], steps: {}, currentExecution: {}, events: [], logTail: [], logRows: [], activityTail: [], hasNarrated: false,
          ptyActive: true, ptyDataBuffer: [], ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
          awaiting: { stepId: 'plan', reason: 'permission' },
        },
      },
    });
    const { transport } = renderRunsPage();

    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'running', workflow: 'demo', startedAt: '2026-01-01T00:00:00Z' },
      { runId: 'r2', runDir: '/ws/.whiphand/runs/r2', status: 'running', workflow: 'demo', startedAt: '2026-01-01T00:00:00Z' },
    ]);

    expect(await screen.findByText('waiting')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('reports a run inside a stages step by stage, from the manifest', async () => {
    const { transport } = renderRunsPage();

    await respondListRuns(transport, [
      {
        runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'failed', workflow: 'staged', startedAt: '2026-01-01T00:00:00Z',
        steps: [{
          id: 'build', kind: 'stages', status: 'failed', total: 7, attempt: 3, exhausted: true,
          currentStage: { id: '03-c', title: 'Add API routes', index: 3 },
        }],
      },
      {
        runId: 'r2', runDir: '/ws/.whiphand/runs/r2', status: 'succeeded', workflow: 'staged', startedAt: '2026-01-01T00:00:00Z',
        steps: [{
          id: 'build', kind: 'stages', status: 'done', total: 7, completed: 7,
          currentStage: { id: '07-g', title: 'Docs', index: 7 },
        }],
      },
    ]);

    expect(await screen.findByTestId('run-stage-progress-r1')).toHaveTextContent('· stage 3/7');
    // A stages step that finished is no longer where the run is.
    expect(screen.queryByTestId('run-stage-progress-r2')).not.toBeInTheDocument();
  });

  it('reports a live run\'s stage from its job, ahead of the slower manifest poll', async () => {
    useAppStore.setState({
      jobs: {
        j1: {
          jobId: 'j1', runId: 'r1', workdir: '/ws', finished: false, stepOrder: [], steps: {}, currentExecution: {}, events: [], logTail: [], logRows: [], activityTail: [], hasNarrated: false,
          ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
          stageProgress: { stagesId: 'build', index: 4, total: 7, title: 'Wire UI', attempt: 1 },
        },
      },
    });
    const { transport } = renderRunsPage();

    await respondListRuns(transport, [{
      runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'running', workflow: 'staged', startedAt: '2026-01-01T00:00:00Z',
      steps: [{
        id: 'build', kind: 'stages', status: 'running', total: 7, attempt: 1,
        currentStage: { id: '03-c', title: 'Add API routes', index: 3 },
      }],
    }]);

    const cell = await screen.findByTestId('run-stage-progress-r1');
    expect(cell).toHaveTextContent('· stage 4/7');
    expect(cell.parentElement).toHaveTextContent('running · stage 4/7');
  });

  it('does not mark a row waiting for a job blocked in another workspace', async () => {
    // Run ids are a timestamp plus two random bytes, so two workspaces can
    // mint the same one within a second — the job's workdir is what decides.
    useAppStore.setState({
      jobs: {
        j1: {
          jobId: 'j1', runId: 'r1', workdir: '/elsewhere', finished: false, stepOrder: [], steps: {},
          currentExecution: {}, events: [], logTail: [], logRows: [], activityTail: [], hasNarrated: false, ptyActive: true, ptyDataBuffer: [],
          ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
          awaiting: { stepId: 'plan', reason: 'permission' },
        },
      },
    });
    const { transport } = renderRunsPage();

    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'running', workflow: 'demo', startedAt: '2026-01-01T00:00:00Z' },
    ]);

    expect(await screen.findByText('running')).toBeInTheDocument();
    expect(screen.queryByText('waiting')).not.toBeInTheDocument();
  });

  it('hides interrupted rows once the "show interrupted" switch is toggled off', async () => {
    const { transport } = renderRunsPage();

    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'succeeded', workflow: 'demo' },
      { runId: 'r2', runDir: '/ws/.whiphand/runs/r2', status: 'interrupted', workflow: 'demo' },
    ]);

    expect(await screen.findByText('r2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Show interrupted' }));

    expect(screen.queryByText('r2')).not.toBeInTheDocument();
    expect(screen.getByText('r1')).toBeInTheDocument();
  });

  it('an interrupted run with no endedAt shows a bounded duration, not one that grows', async () => {
    const { transport } = renderRunsPage();

    // A run abandoned before core could repair it: no endedAt, but heartbeatAt
    // records the last sign of life 30s after it started.
    await respondListRuns(transport, [
      {
        runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'interrupted', workflow: 'demo',
        startedAt: '2026-01-01T00:00:00Z', heartbeatAt: '2026-01-01T00:00:30Z',
        updatedAt: '2026-01-01T00:00:30Z',
      },
    ]);

    expect(await screen.findByText('30s')).toBeInTheDocument();
  });

  it('hides dryRun rows by default and shows them once the "show dry runs" switch is toggled on', async () => {
    const { transport } = renderRunsPage();

    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'succeeded', workflow: 'demo' },
      { runId: 'r2', runDir: '/ws/.whiphand/runs/r2', status: 'succeeded', workflow: 'demo', dryRun: true },
    ]);

    await screen.findByText('r1');
    expect(screen.queryByText('r2')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Show dry runs' }));

    expect(await screen.findByText('r2')).toBeInTheDocument();
  });

  it('calls onSelectRun with the runId when a row is clicked', async () => {
    const { transport, onSelectRun } = renderRunsPage();

    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'succeeded', workflow: 'demo' },
    ]);

    fireEvent.click(await screen.findByText('r1'));
    expect(onSelectRun).toHaveBeenCalledWith('r1');
  });

  it('shows a lock glyph for a locked run', async () => {
    const { transport } = renderRunsPage();
    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'succeeded', workflow: 'demo', locked: true },
    ]);
    expect(await screen.findByRole('img', { name: 'locked' })).toBeInTheDocument();
  });

  it('lock toggle sends setRunLocked without following the row link, and re-polls on success', async () => {
    const { transport, onSelectRun } = renderRunsPage();
    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'succeeded', workflow: 'demo', locked: false },
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Lock r1' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'setRunLocked') throw new Error('setRunLocked not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({ workdir: '/ws', runId: 'r1', locked: true });
    expect(onSelectRun).not.toHaveBeenCalled();

    transport.emitLine({ id: req.id, result: { locked: true } });
    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'succeeded', workflow: 'demo', locked: true },
    ]);
    expect(await screen.findByRole('img', { name: 'locked' })).toBeInTheDocument();
  });

  it('delete asks for confirmation, then sends deleteRun and re-polls on success', async () => {
    const { transport, onSelectRun } = renderRunsPage();
    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'succeeded', workflow: 'demo' },
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete r1' }));
    expect(onSelectRun).not.toHaveBeenCalled();
    expect(transport.sent.some(line => (JSON.parse(line) as { method: string }).method === 'deleteRun')).toBe(false);

    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'deleteRun') throw new Error('deleteRun not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({ workdir: '/ws', runId: 'r1' });

    transport.emitLine({ id: req.id, result: { deleted: true } });
    await respondListRuns(transport, []);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows why a delete was refused and keeps the dialog open', async () => {
    const { transport } = renderRunsPage();
    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'running', workflow: 'demo' },
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete r1' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'deleteRun') throw new Error('deleteRun not sent yet');
      return parsed;
    });
    transport.emitLine({ id: req.id, result: { deleted: false, reason: 'running' } });

    expect(await screen.findByText(/this run is still running/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('a rejected deleteRun shows the error in the dialog instead of escaping unhandled', async () => {
    const { transport } = renderRunsPage();
    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'succeeded', workflow: 'demo' },
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete r1' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'deleteRun') throw new Error('deleteRun not sent yet');
      return parsed;
    });
    transport.emitLine({ id: req.id, error: { code: -32000, message: 'EACCES: permission denied' } });

    expect(await screen.findByText(/EACCES: permission denied/)).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    // Busy cleared: the user can retry or walk away.
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('delete cannot be dismissed while deleteRun is in flight', async () => {
    const { transport } = renderRunsPage();
    await respondListRuns(transport, [
      { runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'succeeded', workflow: 'demo' },
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete r1' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'deleteRun') throw new Error('deleteRun not sent yet');
    });

    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('offers no cross-workspace switch: Runs is this workspace only', async () => {
    const { transport } = renderRunsPage();
    await respondListRuns(transport, []);
    expect(screen.queryByRole('switch', { name: /all workspaces/i })).not.toBeInTheDocument();
  });

  it('opens the New run dialog when the toolbar button is clicked', async () => {
    const { transport } = renderRunsPage();
    await respondListRuns(transport, []);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New run' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'New run' })).toBeInTheDocument();
  });

  it('auto-opens the New run dialog when a run-again request is pending', async () => {
    useAppStore.setState({ pendingRunAgain: { workflow: 'ship-feature', inputs: { ticket: 'T-1' } } });
    const { transport } = renderRunsPage();
    await respondListRuns(transport, []);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
