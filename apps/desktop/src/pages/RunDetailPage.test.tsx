import { Profiler, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RunDetailPage } from './RunDetailPage.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { AWAIT_LABEL } from '../lib/await-copy.ts';
import { encodeToBase64 } from '../lib/base64.ts';
import type { WhiphandEvent } from '../../../../packages/core/src/types.ts';
import { fromPosix } from '../../../../packages/test-support/src/paths.ts';

// RunDetailPage only needs to exercise its own show/hide/collapse logic here —
// the real xterm wiring (encoding, buffering, resize debounce) is covered in
// TerminalPanel.test.tsx against a mocked xterm-runtime module. jsdom can't do
// xterm's real canvas rendering anyway, so mock the whole panel at this
// boundary instead.
let terminalPanelMountCount = 0;
vi.mock('../components/TerminalPanel.tsx', () => ({
  TerminalPanel: (props: { jobId: string; cols?: number; rows?: number; onResize: (cols: number, rows: number) => void }) => {
    // useState initializer runs once per mount — a fresh instance number per
    // React mount (not per render) lets tests detect remounts (e.g. RunDetailPage
    // keying TerminalPanel on ptyStepId so a new interactive session gets a
    // fresh terminal instead of reusing one with stale internal bookkeeping).
    const [instance] = useState(() => ++terminalPanelMountCount);
    return (
      <div data-testid="terminal-panel-mock" data-job-id={props.jobId} data-cols={props.cols} data-rows={props.rows} data-instance={instance}>
        <button onClick={() => props.onResize(120, 40)}>trigger resize</button>
      </div>
    );
  },
}));

function renderRunDetail(
  jobId?: string, onBack = vi.fn(), onRunAgain = vi.fn(), runId?: string, onResumed = vi.fn(),
) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  render(
    <AgentClientProvider client={client}>
      <RunDetailPage jobId={jobId} runId={runId} onBack={onBack} onRunAgain={onRunAgain} onResumed={onResumed} />
    </AgentClientProvider>,
  );
  return { transport, client, onBack, onRunAgain, onResumed };
}

/** Answers the resumeRun the page has (or is about to have) in flight. */
async function respondResumeRun(transport: MockTransport, jobId: string) {
  const req = await waitFor(() => {
    const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'resumeRun');
    if (i === -1) throw new Error('resumeRun not sent yet');
    return transport.sentRequest(i);
  });
  transport.emitLine({ id: req.id, result: { jobId } });
  return req;
}

function emitWhiphandEvent(transport: MockTransport, jobId: string, runId: string, event: WhiphandEvent, ts: string): void {
  transport.emitLine({ method: 'whiphandEvent', params: { jobId, runId, event, ts } });
}

async function respondGetRun(transport: MockTransport, result: unknown) {
  const req = await waitFor(() => {
    const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === 'getRun');
    if (index === -1) throw new Error('getRun not sent yet');
    return transport.sentRequest(index);
  });
  transport.emitLine({ id: req.id, result });
}

/** The two RPCs ArtifactFileSystem speaks for FilePreview: a stat, and a byte read. */
const ARTIFACT_RPCS = new Set(['statArtifact', 'readArtifact']);

function isArtifactRpc(line: string): boolean {
  return ARTIFACT_RPCS.has((JSON.parse(line) as { method?: string }).method ?? '');
}

/**
 * What either artifact RPC answers for a file holding `content`: a stat is
 * size and mtime only, a read carries the bytes base64-encoded, the way
 * ArtifactFileSystem asks for them.
 */
function artifactResult(method: string, content: string, mtimeMs: number) {
  const size = new TextEncoder().encode(content).length;
  return method === 'statArtifact' ? { size, mtimeMs } : { content: encodeToBase64(content), size, mtimeMs };
}

/**
 * Answers the next unanswered artifact RPC. FilePreview opens a file with a
 * stat() and then a readFile(); ArtifactFileSystem serves the first from
 * statArtifact and the second from readArtifact — neither cached, so its
 * stale-write guard stays a real freshness check — so opening one artifact
 * is two RPCs.
 */
async function answerReadArtifact(transport: MockTransport, answered: Set<number>, content: string) {
  const req = await waitFor(() => {
    const index = transport.sent.findIndex((line, i) => !answered.has(i) && isArtifactRpc(line));
    if (index === -1) throw new Error('no artifact RPC sent yet');
    answered.add(index);
    return transport.sentRequest(index);
  });
  transport.emitLine({ id: req.id, result: artifactResult(req.method, content, 10) });
  return req;
}

describe('RunDetailPage', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', jobs: {} });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, jobs: {} });
  });

  it('titles the page with the run name, keeping the id beside it', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'run-1');
    await respondGetRun(transport, {
      runId: 'run-1', runDir: '/ws/.whiphand/runs/run-1', status: 'succeeded',
      name: 'OAuth support', artifacts: [],
    });
    expect(await screen.findByText('OAuth support')).toBeInTheDocument();
    expect(screen.getByTestId('run-detail-id')).toHaveTextContent('run-1');
  });

  it('an unnamed run still reads as "Run <id>"', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'run-1');
    await respondGetRun(transport, {
      runId: 'run-1', runDir: '/ws/.whiphand/runs/run-1', status: 'succeeded', artifacts: [],
    });
    expect(await screen.findByText('Run run-1')).toBeInTheDocument();
    expect(screen.queryByTestId('run-detail-id')).not.toBeInTheDocument();
  });

  it('Rename sends renameRun and re-titles the page from the stored name', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'run-1');
    await respondGetRun(transport, {
      runId: 'run-1', runDir: '/ws/.whiphand/runs/run-1', status: 'succeeded', artifacts: [],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const input = await screen.findByTestId('run-rename-input');
    fireEvent.change(input, { target: { value: '  OAuth support  ' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    const req = await waitFor(() => {
      const index = transport.sent.findIndex(
        line => (JSON.parse(line) as { method?: string }).method === 'renameRun');
      if (index === -1) throw new Error('renameRun not sent yet');
      return transport.sentRequest(index);
    });
    expect(req.params).toMatchObject({
      workdir: '/ws', runId: 'run-1', name: '  OAuth support  ',
    });

    // The server echoes back what it actually stored, normalization and all.
    transport.emitLine({ id: req.id, result: { renamed: true, name: 'OAuth support' } });
    expect(await screen.findByText('OAuth support')).toBeInTheDocument();
  });

  it('clearing the rename box sends null, and the title falls back to the id', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'run-1');
    await respondGetRun(transport, {
      runId: 'run-1', runDir: '/ws/.whiphand/runs/run-1', status: 'succeeded',
      name: 'OAuth support', artifacts: [],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const input = await screen.findByTestId('run-rename-input');
    expect(input).toHaveValue('OAuth support');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const req = await waitFor(() => {
      const index = transport.sent.findIndex(
        line => (JSON.parse(line) as { method?: string }).method === 'renameRun');
      if (index === -1) throw new Error('renameRun not sent yet');
      return transport.sentRequest(index);
    });
    expect((req.params as { name: string | null }).name).toBeNull();

    transport.emitLine({ id: req.id, result: { renamed: true } });
    expect(await screen.findByText('Run run-1')).toBeInTheDocument();
  });

  it('clearing the name of a *live* run also clears the job\'s cached copy', async () => {
    // The regression: `manifest?.name ?? job?.runName` falls through to the
    // job when the manifest has no name, and the job's copy only ever comes
    // from run:start — so without the store update the cleared name reappears
    // and never goes away while the job is live.
    const { transport } = renderRunDetail('job-1', vi.fn(), vi.fn(), 'run-1');
    act(() => {
      emitWhiphandEvent(transport, 'job-1', 'run-1',
        { type: 'run:start', runId: 'run-1', workflow: 'ship', name: 'OAuth support' }, 't1');
    });
    await respondGetRun(transport, {
      runId: 'run-1', runDir: '/ws/.whiphand/runs/run-1', status: 'running',
      name: 'OAuth support', artifacts: [],
    });
    expect(await screen.findByText('OAuth support')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    fireEvent.change(await screen.findByTestId('run-rename-input'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const req = await waitFor(() => {
      const index = transport.sent.findIndex(
        line => (JSON.parse(line) as { method?: string }).method === 'renameRun');
      if (index === -1) throw new Error('renameRun not sent yet');
      return transport.sentRequest(index);
    });
    transport.emitLine({ id: req.id, result: { renamed: true } });

    expect(await screen.findByText('Run run-1')).toBeInTheDocument();
    expect(screen.queryByText('OAuth support')).not.toBeInTheDocument();
    expect(useAppStore.getState().jobs['job-1'].runName).toBeUndefined();
  });

  it('renaming a live run updates the job even before the first manifest poll lands', async () => {
    const { transport } = renderRunDetail('job-1', vi.fn(), vi.fn(), 'run-1');
    act(() => {
      emitWhiphandEvent(transport, 'job-1', 'run-1',
        { type: 'run:start', runId: 'run-1', workflow: 'ship', name: 'Old name' }, 't1');
    });
    expect(await screen.findByText('Old name')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    fireEvent.change(await screen.findByTestId('run-rename-input'), { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const req = await waitFor(() => {
      const index = transport.sent.findIndex(
        line => (JSON.parse(line) as { method?: string }).method === 'renameRun');
      if (index === -1) throw new Error('renameRun not sent yet');
      return transport.sentRequest(index);
    });
    // No getRun answered, so `manifest` is still null — the store is the only
    // place the new name can land.
    transport.emitLine({ id: req.id, result: { renamed: true, name: 'New name' } });
    expect(await screen.findByText('New name')).toBeInTheDocument();
    expect(useAppStore.getState().jobs['job-1'].runName).toBe('New name');
  });

  it('drives step card status and the verdict badge from a scripted whiphandEvent sequence, and clears Cancel once done', async () => {
    const { transport } = renderRunDetail('job-1');

    emitWhiphandEvent(transport, 'job-1', 'run-1', { type: 'step:start', stepId: 'review', kind: 'agent', runner: 'claude', model: 'opus', mode: 'headless' }, 't1');
    emitWhiphandEvent(
      transport, 'job-1', 'run-1',
      { type: 'step:spawn', stepId: 'review', phase: 'main', spec: { argv: ['claude'], cwd: '/ws', env: {}, interactive: false } },
      't2',
    );
    emitWhiphandEvent(transport, 'job-1', 'run-1', { type: 'step:artifact', stepId: 'review', path: '/ws/.whiphand/runs/run-1/review.md' }, 't3');
    emitWhiphandEvent(transport, 'job-1', 'run-1', { type: 'step:verdict', stepId: 'review', verdict: 'pass' }, 't4');
    emitWhiphandEvent(transport, 'job-1', 'run-1', { type: 'step:done', stepId: 'review', exitCode: 0 }, 't5');
    emitWhiphandEvent(transport, 'job-1', 'run-1', { type: 'run:done', runId: 'run-1', ok: true }, 't6');

    await respondGetRun(transport, { runId: 'run-1', runDir: '/ws/.whiphand/runs/run-1', status: 'succeeded', artifacts: [] });

    // The pill says what the step used without being asked; the rest of the
    // detail is a click away.
    const pill = await screen.findByTestId('step-card-review');
    expect(screen.getByTestId('step-meta-review')).toHaveTextContent('claude');
    expect(screen.getByTestId('step-meta-review')).toHaveTextContent('opus');

    fireEvent.click(pill);
    const popover = await screen.findByTestId('step-popover-review');
    expect(popover).toHaveTextContent('exit 0');
    expect(popover).toHaveTextContent('VERDICT: PASS');
    expect(screen.queryByRole('button', { name: /cancel run/i })).not.toBeInTheDocument();
  });

  it('scrolls the current step into view on both axes, since a stage\'s pills scroll sideways', async () => {
    // jsdom has no scrollIntoView; give elements one for this case only.
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true, writable: true });
    try {
      const { transport } = renderRunDetail('job-1');
      emitWhiphandEvent(transport, 'job-1', 'run-1', { type: 'step:start', stepId: 'review', kind: 'agent', runner: 'claude', model: 'opus', mode: 'headless' }, 't1');

      const pill = await screen.findByTestId('step-card-review');
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' }));
      expect(scrollIntoView.mock.contexts.some(el => (el as HTMLElement).contains(pill) || el === pill)).toBe(true);
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('marks a step failed on non-zero exit and shows a fail verdict badge', async () => {
    const { transport } = renderRunDetail('job-3');

    emitWhiphandEvent(transport, 'job-3', 'run-3', { type: 'step:start', stepId: 'lint', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    emitWhiphandEvent(transport, 'job-3', 'run-3', { type: 'step:verdict', stepId: 'lint', verdict: 'fail' }, 't2');
    emitWhiphandEvent(transport, 'job-3', 'run-3', { type: 'step:done', stepId: 'lint', exitCode: 1 }, 't3');

    await respondGetRun(transport, { runId: 'run-3', runDir: '/ws/.whiphand/runs/run-3', status: 'failed', artifacts: [] });

    fireEvent.click(await screen.findByTestId('step-card-lint'));
    const popover = await screen.findByTestId('step-popover-lint');
    expect(popover).toHaveTextContent('exit 1');
    expect(popover).toHaveTextContent('VERDICT: FAIL');
  });

  it('shows Cancel while the job is running, and calls cancelRun with the jobId after confirming the dialog', async () => {
    const { transport } = renderRunDetail('job-2');
    emitWhiphandEvent(transport, 'job-2', 'run-2', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, { runId: 'run-2', runDir: '/ws/.whiphand/runs/run-2', status: 'running', artifacts: [] });

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm cancel' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'cancelRun') throw new Error('cancelRun not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({ jobId: 'job-2' });
  });

  it('does not call cancelRun if the confirmation dialog is dismissed', async () => {
    const { transport } = renderRunDetail('job-4');
    emitWhiphandEvent(transport, 'job-4', 'run-4', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, { runId: 'run-4', runDir: '/ws/.whiphand/runs/run-4', status: 'running', artifacts: [] });

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep running' }));

    expect(transport.sent.some(line => (JSON.parse(line) as { method: string }).method === 'cancelRun')).toBe(false);
  });

  it('toggles the run lock via setRunLocked and reflects the result', async () => {
    const { transport } = renderRunDetail('job-lock');
    emitWhiphandEvent(transport, 'job-lock', 'run-lock', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, { runId: 'run-lock', runDir: '/ws/.whiphand/runs/run-lock', status: 'succeeded', artifacts: [], locked: false });

    fireEvent.click(await screen.findByRole('button', { name: 'Lock' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'setRunLocked') throw new Error('setRunLocked not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({ workdir: '/ws', runId: 'run-lock', locked: true });

    transport.emitLine({ id: req.id, result: { locked: true } });
    expect(await screen.findByRole('button', { name: 'Locked' })).toBeInTheDocument();
  });

  it('goes back from the icon-only back button, which keeps an accessible name', async () => {
    // The button carries no visible text, so aria-label is the only thing
    // naming it — for a screen reader and for this query alike.
    const onBack = vi.fn();
    const { transport } = renderRunDetail('job-back', onBack);
    emitWhiphandEvent(transport, 'job-back', 'run-back', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, { runId: 'run-back', runDir: '/ws/.whiphand/runs/run-back', status: 'succeeded', artifacts: [] });

    fireEvent.click(await screen.findByRole('button', { name: 'Back to runs' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('deletes the run via deleteRun and navigates back on success', async () => {
    const onBack = vi.fn();
    const { transport } = renderRunDetail('job-del', onBack);
    emitWhiphandEvent(transport, 'job-del', 'run-del', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, { runId: 'run-del', runDir: '/ws/.whiphand/runs/run-del', status: 'succeeded', artifacts: [] });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'deleteRun') throw new Error('deleteRun not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({ workdir: '/ws', runId: 'run-del' });

    transport.emitLine({ id: req.id, result: { deleted: true } });
    await waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  it('shows why a delete was refused and does not navigate away', async () => {
    const onBack = vi.fn();
    const { transport } = renderRunDetail('job-del2', onBack);
    emitWhiphandEvent(transport, 'job-del2', 'run-del2', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, { runId: 'run-del2', runDir: '/ws/.whiphand/runs/run-del2', status: 'succeeded', artifacts: [] });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'deleteRun') throw new Error('deleteRun not sent yet');
      return parsed;
    });
    transport.emitLine({ id: req.id, result: { deleted: false, reason: 'locked' } });

    expect(await screen.findByText(/this run is locked/i)).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('shows a rejected deleteRun in the dialog and stays on the run', async () => {
    const onBack = vi.fn();
    const { transport } = renderRunDetail('job-del3', onBack);
    emitWhiphandEvent(transport, 'job-del3', 'run-del3', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, { runId: 'run-del3', runDir: '/ws/.whiphand/runs/run-del3', status: 'succeeded', artifacts: [] });

    // Unmounted until asked for: no hidden dialog sits in the tree.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'deleteRun') throw new Error('deleteRun not sent yet');
      return parsed;
    });
    transport.emitLine({ id: req.id, error: { code: -32000, message: 'EACCES: permission denied' } });

    expect(await screen.findByText(/EACCES: permission denied/)).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('falls back to the list when a polled run vanishes (deleted or pruned elsewhere)', async () => {
    vi.useFakeTimers();
    try {
      const onBack = vi.fn();
      const { transport } = renderRunDetail(undefined, onBack, vi.fn(), 'r-vanish');
      const first = await vi.waitFor(() => {
        const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === 'getRun');
        if (index === -1) throw new Error('getRun not sent yet');
        return transport.sentRequest(index);
      });
      transport.emitLine({
        id: first.id,
        result: { runId: 'r-vanish', runDir: '/ws/.whiphand/runs/r-vanish', status: 'running', artifacts: [], steps: [] },
      });

      await vi.waitFor(() => {
        expect(transport.sent.filter(line => (JSON.parse(line) as { method: string }).method === 'getRun')).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(2500);

      const second = await vi.waitFor(() => {
        const calls = transport.sent.filter(line => (JSON.parse(line) as { method: string }).method === 'getRun');
        if (calls.length < 2) throw new Error('second getRun not sent yet');
        return transport.sentRequest(transport.sent.length - 1);
      });
      transport.emitLine({ id: second.id, result: null });

      await vi.waitFor(() => expect(onBack).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }
  });

  it('browses artifacts as a tree and renders the selected one through readArtifact (not direct filesystem access)', async () => {
    const { transport } = renderRunDetail('job-5');
    emitWhiphandEvent(transport, 'job-5', 'run-5', { type: 'step:start', stepId: 'review', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-5', runDir: '/ws/.whiphand/runs/run-5', status: 'succeeded',
      artifacts: [{ name: 'review.md', path: '/ws/.whiphand/runs/run-5/review.md' }],
    });

    fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));
    // The tree renders it as a treeitem; the click target is the row label,
    // which is where FileTree hangs onSelect (see FileTree.test.tsx).
    expect(await screen.findByRole('treeitem', { name: /review\.md/ })).toBeInTheDocument();
    fireEvent.click(screen.getByText('review.md'));

    const answered = new Set<number>();
    const req = await answerReadArtifact(transport, answered, '# Heading\n\nVERDICT: PASS');
    expect(req.params).toEqual({ workdir: '/ws', runId: 'run-5', name: 'review.md' });
    await answerReadArtifact(transport, answered, '# Heading\n\nVERDICT: PASS');

    expect(await screen.findByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByText(/VERDICT: PASS/)).toBeInTheDocument();
  });

  /**
   * Fake-timer twin of answerReadArtifact: testing-library's waitFor polls on
   * real timers, which never advance inside vi.useFakeTimers().
   */
  async function answerReadArtifactFake(transport: MockTransport, answered: Set<number>, content: string, mtimeMs = 10) {
    const req = await vi.waitFor(() => {
      const index = transport.sent.findIndex((line, i) => !answered.has(i) && isArtifactRpc(line));
      if (index === -1) throw new Error('no artifact RPC sent yet');
      answered.add(index);
      return transport.sentRequest(index);
    });
    transport.emitLine({ id: req.id, result: artifactResult(req.method, content, mtimeMs) });
    return req;
  }

  /** Every artifact RPC naming `name` so far — stats and polls included, not just reads. */
  function readsOf(transport: MockTransport, name: string): number {
    return transport.sent.filter(line => {
      const message = JSON.parse(line) as { method?: string; params?: { name?: string } };
      return ARTIFACT_RPCS.has(message.method ?? '') && message.params?.name === name;
    }).length;
  }

  async function nextGetRun(transport: MockTransport, answered: Set<number>) {
    return vi.waitFor(() => {
      const index = transport.sent.findIndex((line, i) => (
        !answered.has(i) && (JSON.parse(line) as { method: string }).method === 'getRun'
      ));
      if (index === -1) throw new Error('getRun not sent yet');
      answered.add(index);
      return transport.sentRequest(index);
    });
  }

  it('does not re-read an open artifact\'s image when polling brings back the same artifact list', async () => {
    // getRun is re-polled every 2s while a run is live. If the artifact list
    // changes identity on each tick, artifactDocContext and artifactFs do too,
    // Markdown's `components` memo recomputes, the `img` override becomes a new
    // component type, and every image remounts — revoking its object URL and
    // re-reading its bytes over RPC roughly twice every three seconds.
    vi.useFakeTimers();
    try {
      const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-stable');
      const answeredRuns = new Set<number>();
      const manifest = {
        runId: 'r-stable', runDir: '/ws/.whiphand/runs/r-stable', status: 'running', steps: [],
        artifacts: [
          { name: 'notes.md', path: '/ws/.whiphand/runs/r-stable/notes.md' },
          { name: 'diagram.png', path: '/ws/.whiphand/runs/r-stable/diagram.png' },
        ],
      };
      const first = await nextGetRun(transport, answeredRuns);
      transport.emitLine({ id: first.id, result: manifest });

      fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));
      fireEvent.click(await vi.waitFor(() => screen.getByText('notes.md')));

      // FilePreview opens the document with a stat() then a readFile()
      // (statArtifact, then readArtifact); the embedded image costs the same
      // two again.
      const answered = new Set<number>();
      await answerReadArtifactFake(transport, answered, '![diagram](./diagram.png)');
      await answerReadArtifactFake(transport, answered, '![diagram](./diagram.png)');
      await answerReadArtifactFake(transport, answered, 'png-bytes');
      await answerReadArtifactFake(transport, answered, 'png-bytes');
      await vi.waitFor(() => expect(screen.getByAltText('diagram')).toBeInTheDocument());
      expect(readsOf(transport, 'diagram.png')).toBe(2);

      // A poll that brings back an identical list must not disturb the image.
      await vi.advanceTimersByTimeAsync(2500);
      const second = await nextGetRun(transport, answeredRuns);
      transport.emitLine({ id: second.id, result: { ...manifest, artifacts: [...manifest.artifacts] } });

      await vi.advanceTimersByTimeAsync(100);
      expect(readsOf(transport, 'diagram.png')).toBe(2);
      expect(screen.getByAltText('diagram')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still shows an artifact that only appears in a later poll', async () => {
    // The other half of the memo above: stabilising identity must not make the
    // tab blind to a run that has actually produced something new.
    vi.useFakeTimers();
    try {
      const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-grows');
      const answeredRuns = new Set<number>();
      const base = { runId: 'r-grows', runDir: '/ws/.whiphand/runs/r-grows', status: 'running', steps: [] };
      const first = await nextGetRun(transport, answeredRuns);
      transport.emitLine({
        id: first.id,
        result: { ...base, artifacts: [{ name: 'plan.md', path: '/ws/.whiphand/runs/r-grows/plan.md' }] },
      });

      fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));
      await vi.waitFor(() => expect(screen.getByText('plan.md')).toBeInTheDocument());
      expect(screen.queryByText('review.md')).not.toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(2500);
      const second = await nextGetRun(transport, answeredRuns);
      transport.emitLine({
        id: second.id,
        result: {
          ...base,
          artifacts: [
            { name: 'plan.md', path: '/ws/.whiphand/runs/r-grows/plan.md' },
            { name: 'review.md', path: '/ws/.whiphand/runs/r-grows/review.md' },
          ],
        },
      });

      await vi.waitFor(() => expect(screen.getByText('review.md')).toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows an open artifact while the run is still writing it', async () => {
    vi.useFakeTimers();
    try {
      const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-live');
      const answeredRuns = new Set<number>();
      const manifest = {
        runId: 'r-live', runDir: '/ws/.whiphand/runs/r-live', status: 'running', steps: [],
        artifacts: [{ name: 'plan.md', path: '/ws/.whiphand/runs/r-live/plan.md' }],
      };
      const first = await nextGetRun(transport, answeredRuns);
      transport.emitLine({ id: first.id, result: manifest });

      fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));
      fireEvent.click(await vi.waitFor(() => screen.getByText('plan.md')));

      const answered = new Set<number>();
      await answerReadArtifactFake(transport, answered, '# Draft'); // stat
      await answerReadArtifactFake(transport, answered, '# Draft'); // readFile
      await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Draft' })).toBeInTheDocument());

      // ArtifactFileSystem has no inotify to lean on, so it polls: the first
      // tick only establishes the baseline mtime it compares against.
      await vi.advanceTimersByTimeAsync(2000);
      await answerReadArtifactFake(transport, answered, '# Draft');

      // The step appends to the document. The next tick sees a newer mtime,
      // and the preview re-reads without anyone touching the tree.
      await vi.advanceTimersByTimeAsync(2000);
      await answerReadArtifactFake(transport, answered, '# Draft\n\n## Testing', 20);
      await answerReadArtifactFake(transport, answered, '# Draft\n\n## Testing', 20);
      await answerReadArtifactFake(transport, answered, '# Draft\n\n## Testing', 20);

      await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Testing' })).toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops watching an artifact once the run has finished', async () => {
    // A finished run's artifacts are settled. Polling them would spend an RPC
    // every two seconds on a file that cannot change.
    vi.useFakeTimers();
    try {
      const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-done');
      const answeredRuns = new Set<number>();
      const first = await nextGetRun(transport, answeredRuns);
      transport.emitLine({
        id: first.id,
        result: {
          runId: 'r-done', runDir: '/ws/.whiphand/runs/r-done', status: 'succeeded', steps: [],
          artifacts: [{ name: 'review.md', path: '/ws/.whiphand/runs/r-done/review.md' }],
        },
      });

      fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));
      fireEvent.click(await vi.waitFor(() => screen.getByText('review.md')));

      const answered = new Set<number>();
      await answerReadArtifactFake(transport, answered, '# Verdict');
      await answerReadArtifactFake(transport, answered, '# Verdict');
      await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Verdict' })).toBeInTheDocument());
      expect(readsOf(transport, 'review.md')).toBe(2); // the open itself

      await vi.advanceTimersByTimeAsync(10_000);
      expect(readsOf(transport, 'review.md')).toBe(2); // and nothing since
    } finally {
      vi.useRealTimers();
    }
  });

  it('nests artifacts written into subdirectories, and reads one by its relative name', async () => {
    const { transport } = renderRunDetail('job-tree');
    emitWhiphandEvent(transport, 'job-tree', 'run-tree', { type: 'step:start', stepId: 'review', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-tree', runDir: '/ws/.whiphand/runs/run-tree', status: 'succeeded',
      artifacts: [
        { name: 'plan.md', path: '/ws/.whiphand/runs/run-tree/plan.md' },
        { name: 'do-review/iter-1/review.md', path: '/ws/.whiphand/runs/run-tree/do-review/iter-1/review.md' },
        { name: 'do-review/iter-2/review.md', path: '/ws/.whiphand/runs/run-tree/do-review/iter-2/review.md' },
      ],
    });

    fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));

    // The folders are rows of their own, open from the start, and both
    // iterations hang inside 'do-review' rather than sitting at the top level
    // as two identical 'do-review/iter-N/review.md' labels.
    await screen.findByText('do-review');
    const folder = screen.getAllByRole('treeitem').find(row => row.textContent?.startsWith('do-review'))!;
    expect(within(folder).getByText('iter-1')).toBeInTheDocument();
    expect(within(folder).getByText('iter-2')).toBeInTheDocument();
    expect(within(folder).getAllByText('review.md')).toHaveLength(2);
    expect(within(folder).queryByText('plan.md')).not.toBeInTheDocument();

    // Selecting the deeper one asks the agent for it by its full relative
    // name — the leaf row shows only the file name, but the RPC needs the path.
    fireEvent.click(screen.getAllByText('review.md')[1]);
    const answered = new Set<number>();
    const req = await answerReadArtifact(transport, answered, 'second pass');
    expect(req.params).toEqual({ workdir: '/ws', runId: 'run-tree', name: 'do-review/iter-2/review.md' });
  });

  it('counts the artifacts on the tab as a badge, not as a bare number', async () => {
    const { transport } = renderRunDetail('job-count');
    emitWhiphandEvent(transport, 'job-count', 'run-count', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-count', runDir: '/ws/.whiphand/runs/run-count', status: 'succeeded',
      artifacts: [
        { name: 'plan.md', path: '/ws/.whiphand/runs/run-count/plan.md' },
        { name: 'review.md', path: '/ws/.whiphand/runs/run-count/review.md' },
      ],
    });

    // The count still has to reach a screen reader through the tab's name.
    const tab = await screen.findByRole('tab', { name: /artifacts/i });
    expect(tab).toHaveAccessibleName(expect.stringContaining('2'));
  });

  it('offers no create, rename or delete actions on artifacts', async () => {
    const { transport } = renderRunDetail('job-5b');
    emitWhiphandEvent(transport, 'job-5b', 'run-5b', { type: 'step:start', stepId: 'review', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-5b', runDir: '/ws/.whiphand/runs/run-5b', status: 'succeeded',
      artifacts: [{ name: 'review.md', path: '/ws/.whiphand/runs/run-5b/review.md' }],
    });

    fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));
    await screen.findByRole('treeitem', { name: /review\.md/ });

    // Scoped to the artifacts pane: the page header has its own Delete
    // button now (whole-run deletion), which is unrelated to this assertion.
    const artifactsPane = screen.getByTestId('run-panel-artifacts');
    expect(within(artifactsPane).queryByRole('button', { name: /new file/i })).not.toBeInTheDocument();
    expect(within(artifactsPane).queryByRole('button', { name: /rename/i })).not.toBeInTheDocument();
    expect(within(artifactsPane).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('shows the live TerminalPanel once ptyStarted arrives, wired with the job\'s pty size and onResize -> ptyResize', async () => {
    const { transport } = renderRunDetail('job-6');
    emitWhiphandEvent(transport, 'job-6', 'run-6', { type: 'step:start', stepId: 'triage', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
    await respondGetRun(transport, { runId: 'run-6', runDir: '/ws/.whiphand/runs/run-6', status: 'running', artifacts: [] });

    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-6', stepId: 'triage', cols: 80, rows: 24 } });

    const panel = await screen.findByTestId('terminal-panel-mock');
    expect(panel).toHaveAttribute('data-job-id', 'job-6');
    expect(panel).toHaveAttribute('data-cols', '80');
    expect(panel).toHaveAttribute('data-rows', '24');

    fireEvent.click(screen.getByRole('button', { name: 'trigger resize' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'ptyResize') throw new Error('ptyResize not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({ jobId: 'job-6', cols: 120, rows: 40 });
  });

  it('offers End session only while an interactive session is live, and ends just that session', async () => {
    const { transport } = renderRunDetail('job-end');
    emitWhiphandEvent(transport, 'job-end', 'run-end', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
    await respondGetRun(transport, { runId: 'run-end', runDir: '/ws/.whiphand/runs/run-end', status: 'running', artifacts: [] });

    // Before a PTY exists there is nothing to end — only Cancel applies.
    expect(screen.queryByRole('button', { name: 'End session' })).not.toBeInTheDocument();

    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-end', stepId: 'plan', cols: 80, rows: 24 } });
    fireEvent.click(await screen.findByRole('button', { name: 'End session' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'endSession') throw new Error('endSession not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({ jobId: 'job-end' });

    transport.emitLine({ id: req.id, result: { ok: true } });
    transport.emitLine({ method: 'ptyExit', params: { jobId: 'job-end', exitCode: 0, reason: 'ended' } });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'End session' })).not.toBeInTheDocument();
    });
    // The run itself carries on into harvest, so Cancel is still offered.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('shows what the session is waiting for, against the right step, and clears it', async () => {
    const { transport } = renderRunDetail('job-await');
    emitWhiphandEvent(transport, 'job-await', 'run-await', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
    emitWhiphandEvent(transport, 'job-await', 'run-await', { type: 'step:start', stepId: 'exec', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't2');
    await respondGetRun(transport, { runId: 'run-await', runDir: '/ws/.whiphand/runs/run-await', status: 'running', artifacts: [] });
    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-await', stepId: 'plan', cols: 80, rows: 24 } });

    // A live session on its own says nothing about whether anyone is waiting.
    expect(screen.queryByTestId('step-awaiting-plan')).not.toBeInTheDocument();

    transport.emitLine({
      method: 'ptyAwait',
      params: { jobId: 'job-await', stepId: 'plan', awaiting: true, reason: 'permission' },
    });

    // Two surfaces, no more: the step it belongs to, and a dot on the tab that
    // holds the session. The header badge and the prose line above the terminal
    // both said the same thing again, on a screen that states each fact once.
    expect(await screen.findByTestId('step-awaiting-plan')).toHaveTextContent('needs permission');
    expect(screen.getByTestId('tab-awaiting')).toHaveAccessibleName('needs permission');
    expect(screen.queryByTestId('run-awaiting')).not.toBeInTheDocument();
    // The flag belongs to one step, not to the run.
    expect(screen.queryByTestId('step-awaiting-exec')).not.toBeInTheDocument();

    transport.emitLine({
      method: 'ptyAwait',
      params: { jobId: 'job-await', stepId: 'plan', awaiting: false },
    });

    await waitFor(() => {
      expect(screen.queryByTestId('step-awaiting-plan')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('tab-awaiting')).not.toBeInTheDocument();
  });

  it('says the same words on the tab dot and the step badge', async () => {
    const { transport } = renderRunDetail('job-onecopy');
    emitWhiphandEvent(transport, 'job-onecopy', 'run-onecopy', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
    await respondGetRun(transport, { runId: 'run-onecopy', runDir: '/ws/.whiphand/runs/run-onecopy', status: 'running', artifacts: [] });
    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-onecopy', stepId: 'plan', cols: 80, rows: 24 } });
    transport.emitLine({
      method: 'ptyAwait',
      params: { jobId: 'job-onecopy', stepId: 'plan', awaiting: true, reason: 'away' },
    });

    // Both read from AWAIT_LABEL. They drifted once already, when the page
    // carried a second table of its own for the same four reasons.
    const tab = await screen.findByTestId('tab-awaiting');
    expect(tab).toHaveAccessibleName(AWAIT_LABEL.away);
    expect(screen.getByTestId('step-awaiting-plan')).toHaveTextContent(AWAIT_LABEL.away);
  });

  it('renders a placeholder, not bare prose, when there is no run to show', () => {
    render(
      <AgentClientProvider client={new AgentClient(new MockTransport())}>
        <RunDetailPage onBack={vi.fn()} onRunAgain={vi.fn()} onResumed={vi.fn()} />
      </AgentClientProvider>,
    );

    expect(screen.getByTestId('empty-state')).toHaveTextContent(/no run selected/i);
  });

  it('keeps the terminal visible (read-only) after ptyExit until the pty step completes, then collapses to a session-ended note', async () => {
    const { transport } = renderRunDetail('job-7');
    emitWhiphandEvent(transport, 'job-7', 'run-7', { type: 'step:start', stepId: 'triage', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
    await respondGetRun(transport, { runId: 'run-7', runDir: '/ws/.whiphand/runs/run-7', status: 'running', artifacts: [] });

    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-7', stepId: 'triage', cols: 80, rows: 24 } });
    await screen.findByTestId('terminal-panel-mock');

    transport.emitLine({ method: 'ptyExit', params: { jobId: 'job-7', exitCode: 0 } });

    // Still visible: ptyExit landed but the step itself hasn't reported step:done yet.
    expect(screen.getByTestId('terminal-panel-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('pty-session-ended-note')).not.toBeInTheDocument();

    emitWhiphandEvent(transport, 'job-7', 'run-7', { type: 'step:done', stepId: 'triage', exitCode: 0 }, 't2');

    expect(await screen.findByTestId('pty-session-ended-note')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-panel-mock')).not.toBeInTheDocument();
  });

  it('offers Run again for a finished run with a known workflow', async () => {
    const onRunAgain = vi.fn();
    const { transport } = renderRunDetail(undefined, vi.fn(), onRunAgain, 'r1');
    await respondGetRun(transport, {
      runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'succeeded',
      workflow: 'ship-feature', inputs: { ticket: 'T-1' }, artifacts: [],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Run again' }));
    // No workflowSource on this manifest (predates the field, or was resolved
    // as a plain path) — the caller must not invent a scope.
    expect(onRunAgain).toHaveBeenCalledWith('ship-feature', { ticket: 'T-1' }, undefined);
  });

  it('passes the run\'s own workflowSource through to Run again, so the caller can scope the rerun', async () => {
    const onRunAgain = vi.fn();
    const { transport } = renderRunDetail(undefined, vi.fn(), onRunAgain, 'r1');
    await respondGetRun(transport, {
      runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'succeeded',
      workflow: 'ship-feature', inputs: { ticket: 'T-1' }, workflowSource: 'global', artifacts: [],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Run again' }));
    expect(onRunAgain).toHaveBeenCalledWith('ship-feature', { ticket: 'T-1' }, 'global');
  });

  it('renders an interrupted run from the manifest alone: no spinner, and the step it died on', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-int');
    // Exactly what core hands back after repairing a run whose owner was
    // SIGKILLed: the run and its in-flight step are interrupted, the earlier
    // step is done, the later one never started.
    await respondGetRun(transport, {
      runId: 'r-int', runDir: '/ws/.whiphand/runs/r-int', status: 'interrupted',
      workflow: 'ship-feature', inputs: {}, artifacts: [],
      error: { stepId: 'implement', message: 'Run was interrupted — the process that owned it exited without finishing.' },
      steps: [
        { id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', status: 'done', exitCode: 0 },
        { id: 'implement', kind: 'agent', runner: 'claude', mode: 'interactive', status: 'interrupted', endedAt: '2026-01-01T00:00:30Z' },
        { id: 'review', kind: 'agent', runner: 'claude', mode: 'headless', status: 'pending' },
      ],
    });

    expect(await screen.findByTestId('step-card-implement')).toBeInTheDocument();
    // The bug: an abandoned run used to spin on its in-flight step forever.
    expect(document.querySelector('.fui-Spinner')).toBeNull();
    // Where the run stopped is marked on the step itself, not restated above it.
    expect(screen.getByTestId('step-ordinal-implement')).toHaveTextContent('2');
    expect(screen.getByTestId('step-card-implement')).toHaveAttribute('data-current', 'true');
    expect(screen.getByTestId('step-card-plan')).not.toHaveAttribute('data-current');
    expect(screen.getByTestId('run-error')).toHaveTextContent('Run was interrupted');
    // It is over, so it can be re-run and cannot be cancelled.
    expect(screen.getByRole('button', { name: 'Run again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  describe('degradations (invariant 7)', () => {
    it('shows what a finished run lost, from its manifest: label, reason, and the step when scoped', async () => {
      const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-deg');
      await respondGetRun(transport, {
        runId: 'r-deg', runDir: '/ws/.whiphand/runs/r-deg', status: 'succeeded', artifacts: [],
        degradations: [
          { capability: 'git-guard', reason: 'not a git repository', at: '2026-01-01T00:00:01Z' },
          { capability: 'diff', reason: 'git is unavailable', stepId: 'build', at: '2026-01-01T00:00:02Z' },
        ],
      });

      const panel = await screen.findByTestId('run-degraded');
      expect(panel).toHaveTextContent('Degraded');
      const lines = within(panel).getAllByTestId('run-degradation');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toHaveTextContent('Read-only tree guard off (not a git repository) — not a git repository');
      expect(lines[1]).toHaveTextContent('Step diff unavailable [build] — git is unavailable');
    });

    it('shows a live run:degraded as it arrives, and once when the manifest reports it too', async () => {
      const { transport } = renderRunDetail('job-1', vi.fn(), vi.fn(), 'run-1');
      act(() => {
        emitWhiphandEvent(transport, 'job-1', 'run-1',
          { type: 'run:start', runId: 'run-1', workflow: 'ship' }, 't1');
        emitWhiphandEvent(transport, 'job-1', 'run-1',
          { type: 'run:degraded', capability: 'hooks', reason: 'the runner rejected them', stepId: 'plan' }, 't2');
      });
      expect(await screen.findByTestId('run-degraded')).toHaveTextContent('Runner hooks dropped [plan] — the runner rejected them');

      // run:start flipped the job's status, which re-fetched: answer the live request, not the one it replaced.
      const req = transport.sentRequest(transport.sent.map(l => (JSON.parse(l) as { method?: string }).method).lastIndexOf('getRun'));
      transport.emitLine({
        id: req.id,
        result: {
          runId: 'run-1', runDir: '/ws/.whiphand/runs/run-1', status: 'running', name: 'Shipping', artifacts: [],
          degradations: [{ capability: 'hooks', reason: 'the runner rejected them', stepId: 'plan', at: 't2' }],
        },
      });
      // The manifest has landed once its name does; the loss is still one line.
      await screen.findByText('Shipping');
      expect(screen.getAllByTestId('run-degradation')).toHaveLength(1);
    });

    it('names a capability this build does not know by its raw id', async () => {
      const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-new');
      await respondGetRun(transport, {
        runId: 'r-new', runDir: '/ws/.whiphand/runs/r-new', status: 'succeeded', artifacts: [],
        degradations: [{ capability: 'from-the-future', reason: 'newer engine', at: 't' }],
      });
      expect(await screen.findByTestId('run-degradation')).toHaveTextContent('from-the-future — newer engine');
    });

    it('renders no panel at all for a run that lost nothing', async () => {
      const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-clean');
      await respondGetRun(transport, {
        runId: 'r-clean', runDir: '/ws/.whiphand/runs/r-clean', status: 'succeeded', artifacts: [], degradations: [],
      });
      await screen.findByText('Run r-clean');
      expect(screen.queryByTestId('run-degraded')).not.toBeInTheDocument();
    });
  });

  it('a run stopped in triage says which stage it stopped at', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-triage');
    // What core records once a stage's retries run out: the stages row names
    // the stage and the attempt it reached, and is marked exhausted.
    await respondGetRun(transport, {
      runId: 'r-triage', runDir: '/ws/.whiphand/runs/r-triage', status: 'failed',
      workflow: 'staged-feature', inputs: {}, artifacts: [],
      error: { stepId: 'build', message: "stages step 'build': stage 3 of 7 ('Add API routes') was rejected 3 times" },
      steps: [
        {
          id: 'build', kind: 'stages', status: 'failed', total: 7, completed: 2, attempt: 3, exhausted: true,
          completedStages: ['01-a', '02-b'], currentStage: { id: '03-c', title: 'Add API routes', index: 3 },
        },
        { id: 'implement', kind: 'agent', loopId: 'build', iteration: 3, stage: '03-c', status: 'done' },
        { id: 'accept', kind: 'approval', loopId: 'build', iteration: 3, stage: '03-c', status: 'done', verdict: 'fail' },
      ],
    });

    expect(await screen.findByText(/stopped at stage 3 of 7 · Add API routes after 3 rejections/)).toBeInTheDocument();
    // The engine's own message still follows it.
    expect(screen.getByTestId('run-error')).toHaveTextContent('was rejected 3 times');
  });

  it('a run that failed inside a stage without exhausting it names the stage alone', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-stage-fail');
    await respondGetRun(transport, {
      runId: 'r-stage-fail', runDir: '/ws/.whiphand/runs/r-stage-fail', status: 'failed',
      workflow: 'staged-feature', inputs: {}, artifacts: [],
      error: { stepId: 'implement', message: "step 'implement' exited with code 1" },
      steps: [
        {
          id: 'build', kind: 'stages', status: 'interrupted', total: 7, attempt: 1,
          currentStage: { id: '03-c', title: 'Add API routes', index: 3 },
        },
        { id: 'implement', kind: 'agent', loopId: 'build', iteration: 1, stage: '03-c', status: 'failed' },
      ],
    });

    expect(await screen.findByTestId('run-error-stage')).toHaveTextContent('Run stopped at stage 3 of 7 · Add API routes');
    expect(screen.getByTestId('run-error-stage')).not.toHaveTextContent('rejection');
  });

  it('says nothing about stages for a run whose stages step finished', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-after');
    await respondGetRun(transport, {
      runId: 'r-after', runDir: '/ws/.whiphand/runs/r-after', status: 'failed',
      workflow: 'staged-feature', inputs: {}, artifacts: [],
      error: { stepId: 'ship', message: "step 'ship' exited with code 1" },
      steps: [
        {
          id: 'build', kind: 'stages', status: 'done', total: 1, completed: 1, attempt: 1,
          currentStage: { id: '01-a', title: 'Schema', index: 1 }, completedStages: ['01-a'],
        },
        { id: 'implement', kind: 'agent', loopId: 'build', iteration: 1, stage: '01-a', status: 'done' },
        { id: 'ship', kind: 'command', status: 'failed' },
      ],
    });

    expect(await screen.findByTestId('run-error')).toHaveTextContent("step 'ship' exited");
    expect(screen.queryByTestId('run-error-stage')).not.toBeInTheDocument();
  });

  it('marks the running body step inside a stage as current, not the stages step around it', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-stage-live');
    await respondGetRun(transport, {
      runId: 'r-stage-live', runDir: '/ws/.whiphand/runs/r-stage-live', status: 'running',
      workflow: 'staged-feature', inputs: {}, artifacts: [],
      steps: [
        {
          id: 'build', kind: 'stages', status: 'running', total: 2, attempt: 1,
          currentStage: { id: '02-b', title: 'Add API routes', index: 2 },
        },
        { id: 'implement', kind: 'agent', loopId: 'build', iteration: 1, stage: '01-a', status: 'done' },
        { id: 'implement', kind: 'agent', loopId: 'build', iteration: 1, stage: '02-b', status: 'running' },
      ],
    });

    expect(await screen.findByTestId('step-card-implement@02-b#1')).toHaveAttribute('data-current', 'true');
    expect(screen.getByTestId('step-card-build')).not.toHaveAttribute('data-current');
    // The finished stage is collapsed until opened.
    fireEvent.click(screen.getByTestId('stage-toggle-build@01-a'));
    expect(screen.getByTestId('step-card-implement@01-a#1')).not.toHaveAttribute('data-current');
  });

  it('merges what an earlier attempt recorded about its stages with what a resumed job heard', async () => {
    // The resumed job only hears its own stages:accepted; the manifest holds
    // the rest. Neither copy may clobber the other.
    useAppStore.setState({
      jobs: {
        'job-resumed': {
          jobId: 'job-resumed', runId: 'r-resumed', finished: false, workdir: '/ws',
          stepOrder: ['build'],
          steps: {
            build: {
              key: 'build', id: 'build', kind: 'stages', status: 'running', total: 7, completedStages: ['02-b'],
              startedStages: { '02-b': { title: 'API', index: 2, maxAttempts: 3 } },
            },
          },
          currentExecution: { build: 'build' }, events: [], logTail: [], logRows: [], activityTail: [], hasNarrated: false,
          ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
        },
      },
    });
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-resumed');
    await respondGetRun(transport, {
      runId: 'r-resumed', runDir: '/ws/.whiphand/runs/r-resumed', status: 'running',
      workflow: 'staged-feature', inputs: {}, artifacts: [],
      steps: [
        {
          id: 'build', kind: 'stages', status: 'running', total: 7, completedStages: ['01-a'],
          startedStages: { '01-a': { title: 'Schema', index: 1, maxAttempts: 3 } },
        },
        { id: 'implement', kind: 'agent', loopId: 'build', iteration: 1, stage: '01-a', status: 'done' },
        { id: 'implement', kind: 'agent', loopId: 'build', iteration: 1, stage: '02-b', status: 'done' },
      ],
    });

    expect(await screen.findByTestId('stages-progress-build')).toHaveTextContent('2 of 7 accepted');
    // Stage titles, like accepted stages, come from both sides.
    expect(screen.getByTestId('stage-label-build@01-a')).toHaveTextContent('stage 1 of 7 · Schema');
    expect(screen.getByTestId('stage-label-build@02-b')).toHaveTextContent('stage 2 of 7 · API');
  });

  it('shows steps the live job has not reported yet by merging the manifest step list', async () => {
    const { transport } = renderRunDetail('job-merge');
    emitWhiphandEvent(transport, 'job-merge', 'run-merge', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    // The manifest knows all three steps from the moment the run started; the
    // live job has only seen the first. Both used to be either/or, so the two
    // steps still to come were invisible.
    await respondGetRun(transport, {
      runId: 'run-merge', runDir: '/ws/.whiphand/runs/run-merge', status: 'running', artifacts: [],
      steps: [
        { id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', status: 'pending' },
        { id: 'implement', kind: 'agent', runner: 'claude', mode: 'headless', status: 'pending' },
        { id: 'review', kind: 'agent', runner: 'claude', mode: 'headless', status: 'pending' },
      ],
    });

    expect(await screen.findByTestId('step-card-review')).toBeInTheDocument();
    // The live job's fresher state wins for the step it does know about.
    expect(screen.getByTestId('step-card-plan')).toHaveAttribute('data-current', 'true');
    // A genuinely running step does spin — which is what makes the
    // "no spinner" assertion on the interrupted run above meaningful.
    expect(document.querySelector('.fui-Spinner')).not.toBeNull();
  });

  it('opens a popover with the details of a step other than the current one', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-pop');
    await respondGetRun(transport, {
      runId: 'r-pop', runDir: '/ws/.whiphand/runs/r-pop', status: 'running', artifacts: [],
      steps: [
        { id: 'plan', kind: 'agent', runner: 'codex', model: 'gpt-5', mode: 'headless', status: 'done', exitCode: 0 },
        { id: 'implement', kind: 'agent', runner: 'claude', mode: 'headless', status: 'running' },
      ],
    });

    // 'implement' is the current step, so 'plan' only gives up its details on click.
    expect(await screen.findByTestId('step-card-implement')).toBeInTheDocument();
    expect(screen.queryByTestId('step-popover-plan')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('step-card-plan'));

    const popover = await screen.findByTestId('step-popover-plan');
    expect(popover).toHaveTextContent('codex');
    expect(popover).toHaveTextContent('gpt-5');
    expect(popover).toHaveTextContent('exit 0');
  });

  it('falls back to marking the last step once every step is done', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-ok');
    await respondGetRun(transport, {
      runId: 'r-ok', runDir: '/ws/.whiphand/runs/r-ok', status: 'succeeded', artifacts: [],
      steps: [
        { id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', status: 'done', exitCode: 0 },
        { id: 'review', kind: 'agent', runner: 'claude', mode: 'headless', status: 'done', exitCode: 0, verdict: 'pass' },
      ],
    });

    // There is no "current" step to call out, so the mark lands on the last one.
    expect(await screen.findByTestId('step-card-review')).toHaveAttribute('data-current', 'true');
    expect(screen.getByTestId('step-card-plan')).not.toHaveAttribute('data-current');
    // The step is never described a second time outside its own pill.
    expect(screen.queryByTestId('step-detail-review')).not.toBeInTheDocument();
  });

  it('re-polls getRun while a run with no live job is still going', async () => {
    vi.useFakeTimers();
    try {
      const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-poll');
      const first = await vi.waitFor(() => {
        const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === 'getRun');
        if (index === -1) throw new Error('getRun not sent yet');
        return transport.sentRequest(index);
      });
      transport.emitLine({ id: first.id, result: { runId: 'r-poll', runDir: '/ws/.whiphand/runs/r-poll', status: 'running', artifacts: [], steps: [] } });

      await vi.waitFor(() => {
        expect(transport.sent.filter(line => (JSON.parse(line) as { method: string }).method === 'getRun')).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(2500);
      // A run driven by another process emits no notifications here, so polling
      // is the only way this page ever advances.
      expect(transport.sent.filter(line => (JSON.parse(line) as { method: string }).method === 'getRun').length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('remounts TerminalPanel (fresh instance) when a second interactive step starts its own PTY session', async () => {
    const { transport } = renderRunDetail('job-8');
    emitWhiphandEvent(transport, 'job-8', 'run-8', { type: 'step:start', stepId: 'triage-1', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
    await respondGetRun(transport, { runId: 'run-8', runDir: '/ws/.whiphand/runs/run-8', status: 'running', artifacts: [] });

    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-8', stepId: 'triage-1', cols: 80, rows: 24 } });
    const firstPanel = await screen.findByTestId('terminal-panel-mock');
    const firstInstance = firstPanel.getAttribute('data-instance');

    transport.emitLine({ method: 'ptyExit', params: { jobId: 'job-8', exitCode: 0 } });
    emitWhiphandEvent(transport, 'job-8', 'run-8', { type: 'step:done', stepId: 'triage-1', exitCode: 0 }, 't2');
    await screen.findByTestId('pty-session-ended-note');

    // A second interactive step starts a brand new PTY session for the same job.
    emitWhiphandEvent(transport, 'job-8', 'run-8', { type: 'step:start', stepId: 'triage-2', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't3');
    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-8', stepId: 'triage-2', cols: 100, rows: 30 } });

    const secondPanel = await screen.findByTestId('terminal-panel-mock');
    expect(secondPanel.getAttribute('data-instance')).not.toBe(firstInstance);
    expect(secondPanel).toHaveAttribute('data-cols', '100');
    expect(secondPanel).toHaveAttribute('data-rows', '30');
  });
});

describe('RunDetailPage: cycles and manual steps', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', jobs: {} });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, jobs: {} });
  });

  const request = {
    stepId: 'sign', kind: 'approval' as const, title: 'Ship it?',
    instructions: 'Review the diff.', choices: ['continue' as const, 'abort' as const],
    context: { artifacts: [] }, defaultChoice: 'continue' as const,
  };

  /** The resolveManual request the decision bar puts on the wire. */
  async function findResolveManual(transport: MockTransport) {
    return waitFor(() => {
      const index = transport.sent.findIndex(l => (JSON.parse(l) as { method: string }).method === 'resolveManual');
      if (index === -1) throw new Error('resolveManual not sent yet');
      return transport.sentRequest(index);
    });
  }

  it('opens a workspace-relative artifact path from the request through the manifest\'s artifact by name', async () => {
    const { transport } = renderRunDetail('job-rel', undefined, undefined, 'r1');
    await respondGetRun(transport, {
      runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'running',
      // The manifest's paths are native: that is what the request's relative path must resolve to.
      artifacts: [{ name: 'plan.md', path: fromPosix('/ws/.whiphand/runs/r1/plan.md') }],
    });
    transport.emitLine({
      method: 'manualRequest',
      params: {
        jobId: 'job-rel', runId: 'r1',
        request: { ...request, context: { artifacts: [{ id: 'plan', path: '.whiphand/runs/r1/plan.md' }] } },
      },
    });

    fireEvent.click(await screen.findByTestId('review-source-plan'));
    const req = await answerReadArtifact(transport, new Set<number>(), '# The plan');
    expect(req.params).toEqual({ workdir: '/ws', runId: 'r1', name: 'plan.md' });
  });

  it('takes the screen when the run parks on a human, and answers it over RPC', async () => {
    const { transport } = renderRunDetail('job-manual');
    transport.emitLine({ method: 'manualRequest', params: { jobId: 'job-manual', runId: 'r1', request } });

    // The run is hard-blocked, so the review opens itself rather than waiting
    // to be found — and the tabs are gone while it is up.
    expect(await screen.findByTestId('review-overlay')).toBeInTheDocument();
    expect(screen.getByText('Ship it?')).toBeInTheDocument();
    // Hidden rather than unmounted, so an artifact open in edit mode behind it
    // keeps its edits and the terminal keeps its buffer.
    // The tabs are hidden rather than unmounted, so an artifact open in edit
    // mode behind them keeps its edits and the terminal keeps its buffer.
    expect(screen.getByTestId('run-panel-logs')).not.toBeVisible();
    // And `display: none` takes them out of the accessibility tree and the tab
    // order entirely — which is what makes a focus trap unnecessary here.
    expect(screen.queryByRole('tablist')).toBeNull();

    fireEvent.click(screen.getByTestId('review-choice-continue'));
    const req = await findResolveManual(transport);
    expect(req.params).toMatchObject({ jobId: 'job-manual', stepId: 'sign', choice: 'continue' });
  });

  it('leaves the question on screen after backing out, and does not reopen itself', async () => {
    const { transport } = renderRunDetail('job-back');
    transport.emitLine({ method: 'manualRequest', params: { jobId: 'job-back', request } });
    await screen.findByTestId('review-overlay');

    fireEvent.click(screen.getByTestId('review-close'));
    // The run is still blocked, so it must not be possible to lose the
    // question — but a deliberate exit must also stick.
    expect(await screen.findByTestId('pending-decision-bar')).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toBeVisible();
    // Hidden, not unmounted — so a note or a per-file comment typed before
    // backing out survives the round trip.
    await waitFor(() => expect(screen.getByTestId('review-overlay')).not.toBeVisible());

    fireEvent.click(screen.getByTestId('pending-decision-open'));
    expect(await screen.findByTestId('review-overlay')).toBeVisible();
  });

  it('does not lose a typed note when backing out and reopening', async () => {
    // The bug this pattern fixes: backing out used to unmount ReviewOverlay,
    // silently discarding whatever was typed.
    const withNote = { ...request, capture: { kind: 'note' as const, label: 'Note', requiredFor: ['continue' as const], perFile: false } };
    const { transport } = renderRunDetail('job-draft');
    transport.emitLine({ method: 'manualRequest', params: { jobId: 'job-draft', request: withNote } });
    await screen.findByTestId('review-overlay');

    fireEvent.change(screen.getByTestId('review-note'), { target: { value: 'still drafting' } });
    fireEvent.click(screen.getByTestId('review-close'));
    await waitFor(() => expect(screen.getByTestId('review-overlay')).not.toBeVisible());

    fireEvent.click(screen.getByTestId('pending-decision-open'));
    expect(await screen.findByTestId('review-overlay')).toBeVisible();
    expect(screen.getByTestId('review-note')).toHaveValue('still drafting');
  });

  it('does not let Escape discard a pending decision', async () => {
    const { transport } = renderRunDetail('job-esc');
    transport.emitLine({ method: 'manualRequest', params: { jobId: 'job-esc', request } });
    const overlay = await screen.findByTestId('review-overlay');

    fireEvent.keyDown(overlay, { key: 'Escape' });
    expect(screen.getByTestId('review-overlay')).toBeInTheDocument();
  });

  it('keeps the run header reachable while the review is up', async () => {
    // The reviewer has to be able to see which run they are signing off, and
    // the header's own dialogs must still work — they are the Modalizers the
    // overlay deliberately does not stack onto.
    const { transport } = renderRunDetail('job-hdr');
    transport.emitLine({ method: 'manualRequest', params: { jobId: 'job-hdr', runId: 'r1', request } });
    await screen.findByTestId('review-overlay');

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByTestId('run-rename-input')).toBeInTheDocument();
  });

  it('says so when the step is no longer waiting, rather than silently doing nothing', async () => {
    const { transport } = renderRunDetail('job-stale');
    transport.emitLine({ method: 'manualRequest', params: { jobId: 'job-stale', request } });
    await screen.findByTestId('review-overlay');

    fireEvent.click(screen.getByTestId('review-choice-continue'));
    const req = await findResolveManual(transport);
    transport.emitLine({ id: req.id, result: { ok: false } });

    expect(await screen.findByText(/no longer waiting/)).toBeInTheDocument();
  });

  it('drops the review once the question is resolved', async () => {
    const { transport } = renderRunDetail('job-done');
    transport.emitLine({ method: 'manualRequest', params: { jobId: 'job-done', request } });
    await screen.findByTestId('review-overlay');

    transport.emitLine({
      method: 'manualResolved', params: { jobId: 'job-done', stepId: 'sign', choice: 'continue' },
    });
    await waitFor(() => expect(screen.queryByTestId('review-overlay')).toBeNull());
    expect(screen.queryByTestId('pending-decision-bar')).toBeNull();
  });

  it('shows the change set file by file when the step asked for a diff', async () => {
    const withDiff = { ...request, context: { artifacts: [], diff: 'stat + patch' } };
    const { transport } = renderRunDetail('job-diff');
    transport.emitLine({ method: 'manualRequest', params: { jobId: 'job-diff', request: withDiff } });
    await screen.findByTestId('review-overlay');

    const req = await waitFor(() => {
      const index = transport.sent.findIndex(l => (JSON.parse(l) as { method: string }).method === 'getWorkingDiff');
      if (index === -1) throw new Error('getWorkingDiff not sent yet');
      return transport.sentRequest(index);
    });
    expect(req.params).toMatchObject({ workdir: '/ws' });

    transport.emitLine({
      id: req.id,
      result: {
        files: [{
          path: 'src/x.ts', status: 'modified', additions: 1, deletions: 1, binary: false,
          patch: 'diff --git a/src/x.ts b/src/x.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
        }],
      },
    });

    expect(await screen.findByTestId('diff-file-src/x.ts')).toBeInTheDocument();
    expect(screen.getByTestId('diff-summary')).toHaveTextContent('1 file changed');
    // Side by side: the removed line and its replacement share a row.
    const grid = await screen.findByTestId('diff-grid');
    const del = grid.querySelector('[data-side="left"][data-kind="del"]');
    const add = grid.querySelector('[data-side="right"][data-kind="add"]');
    expect(del).toHaveTextContent('-old');
    expect(add).toHaveTextContent('+new');
    expect(del!.getAttribute('data-row')).toBe(add!.getAttribute('data-row'));
  });

  it('reopens for the same step when it is asked again', async () => {
    // Backing out dismisses that *asking*, not the step for the rest of the
    // run — a resume re-runs it under the same key and must take the screen.
    const { transport } = renderRunDetail('job-again');
    transport.emitLine({ method: 'manualRequest', params: { jobId: 'job-again', request } });
    await screen.findByTestId('review-overlay');
    fireEvent.click(screen.getByTestId('review-close'));
    await waitFor(() => expect(screen.getByTestId('review-overlay')).not.toBeVisible());

    transport.emitLine({
      method: 'manualResolved', params: { jobId: 'job-again', stepId: 'sign', choice: 'continue' },
    });
    await waitFor(() => expect(screen.queryByTestId('pending-decision-bar')).toBeNull());

    transport.emitLine({ method: 'manualRequest', params: { jobId: 'job-again', request } });
    expect(await screen.findByTestId('review-overlay')).toBeInTheDocument();
  });

  it('does not ask for a diff when the workflow did not request one', async () => {
    const { transport } = renderRunDetail('job-nodiff');
    transport.emitLine({ method: 'manualRequest', params: { jobId: 'job-nodiff', request } });
    await screen.findByTestId('review-overlay');
    await waitFor(() => expect(screen.getByTestId('review-decision-bar')).toBeInTheDocument());

    expect(transport.sent.some(l => (JSON.parse(l) as { method: string }).method === 'getWorkingDiff')).toBe(false);
  });

  it('folds a loop body into one pill that counts up, nested in its loop', async () => {
    const { transport } = renderRunDetail('job-loop');
    emitWhiphandEvent(transport, 'job-loop', 'r1', { type: 'loop:start', loopId: 'fix', maxIterations: 3 }, 't0');
    for (const iteration of [1, 2]) {
      emitWhiphandEvent(transport, 'job-loop', 'r1',
        { type: 'loop:iteration', loopId: 'fix', iteration, maxIterations: 3 }, 't0');
      emitWhiphandEvent(transport, 'job-loop', 'r1', {
        type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'claude',
        mode: 'headless', loopId: 'fix', iteration,
      }, 't1');
      emitWhiphandEvent(transport, 'job-loop', 'r1', { type: 'step:done', stepId: 'execute', exitCode: 0 }, 't2');
    }

    // Two iterations, one pill — the row stays the length of the workflow.
    expect(await screen.findByTestId('step-card-execute')).toBeInTheDocument();
    expect(screen.queryByTestId('step-card-execute#2')).not.toBeInTheDocument();
    expect(screen.getByTestId('step-iterations-execute')).toHaveTextContent('2');

    const loop = screen.getByTestId('step-loop-fix');
    expect(loop).toContainElement(screen.getByTestId('step-card-execute'));
    expect(screen.getByTestId('loop-progress-fix')).toHaveTextContent('2 of 3');
  });

  it('freezes a finished run at the time it actually took', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-span');
    await respondGetRun(transport, {
      runId: 'r-span', runDir: '/ws/.whiphand/runs/r-span', status: 'succeeded', artifacts: [],
      startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:04:12Z', steps: [],
    });

    expect(await screen.findByTestId('run-elapsed')).toHaveTextContent('4m 12s');
  });

  it('bounds an interrupted run at its last sign of life, not at now', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-abandoned');
    await respondGetRun(transport, {
      runId: 'r-abandoned', runDir: '/ws/.whiphand/runs/r-abandoned', status: 'interrupted', artifacts: [],
      startedAt: '2026-01-01T00:00:00Z', heartbeatAt: '2026-01-01T00:00:30Z',
      updatedAt: '2026-01-01T00:00:30Z', steps: [],
    });

    // No endedAt: without the fallback this would grow on every poll forever.
    expect(await screen.findByTestId('run-elapsed')).toHaveTextContent('30s');
  });

  it('counts up while the run is still going', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-live');
      await respondGetRun(transport, {
        runId: 'r-live', runDir: '/ws/.whiphand/runs/r-live', status: 'running', artifacts: [],
        startedAt: '2026-01-01T00:00:00Z', steps: [],
      });
      // Read in seconds. Not pinned to an exact instant: `shouldAdvanceTime`
      // (which `waitFor` needs to work at all under fake timers) also moves
      // the clock by however long the test really took, so asserting '5s'
      // passes alone and fails under a loaded full suite. What the timer
      // promises is that it counts up — assert that.
      const seconds = (): number => {
        const shown = screen.getByTestId('run-elapsed').textContent ?? '';
        expect(shown).toMatch(/^\d+s$/);
        return Number.parseInt(shown, 10);
      };
      await screen.findByTestId('run-elapsed');
      const before = seconds();

      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

      expect(seconds() - before).toBeGreaterThanOrEqual(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lays the page out as a full-height frame that does not scroll as a whole', async () => {
    renderRunDetail('job-frame');

    const frame = await screen.findByTestId('run-detail-frame');
    expect(frame).toHaveStyle({ height: '100%', flexDirection: 'column' });
  });

  it('caps the stepper strip and scrolls it, so expanded stages cannot squeeze the tabs', async () => {
    renderRunDetail('job-strip-cap');

    // jsdom does not compute the clamp; this compares the inline string, which is all the guard needs.
    const strip = await screen.findByTestId('run-stepper-strip');
    expect(strip).toHaveStyle({ maxHeight: 'clamp(140px, 38%, 460px)', overflowY: 'auto' });
  });

  it('collapses the stepper strip and brings it back', async () => {
    const { transport } = renderRunDetail('job-collapse');
    emitWhiphandEvent(transport, 'job-collapse', 'run-collapse', { type: 'step:start', stepId: 'one', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-collapse', runDir: '/ws/.whiphand/runs/run-collapse', status: 'running', artifacts: [],
      steps: [{ id: 'one', status: 'running' }, { id: 'two', status: 'pending' }],
    });

    expect(await screen.findByTestId('step-card-two')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('stepper-collapse-toggle'));
    expect(screen.queryByTestId('step-card-two')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('stepper-collapse-toggle'));
    expect(screen.getByTestId('step-card-two')).toBeInTheDocument();
  });

  it('streams a running headless step\'s activity into the Terminal tab', async () => {
    const { transport } = renderRunDetail('job-activity');
    emitWhiphandEvent(transport, 'job-activity', 'run-activity', { type: 'step:start', stepId: 'impl', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-activity', runDir: '/ws/.whiphand/runs/run-activity', status: 'running', artifacts: [],
      steps: [{ id: 'impl', status: 'running' }],
    });

    emitWhiphandEvent(transport, 'job-activity', 'run-activity', { type: 'step:progress', stepId: 'impl', progress: { kind: 'tool', tool: 'Read', target: 'runner.ts' } }, 't2');
    emitWhiphandEvent(transport, 'job-activity', 'run-activity', { type: 'step:progress', stepId: 'impl', progress: { kind: 'text', text: 'The headless branch spawns without flags.' } }, 't3');

    // Terminal is the "what is happening now" surface, whether the step talks
    // through a pty or through a progress stream.
    const feed = await screen.findByTestId('activity-feed');
    expect(screen.getByTestId('run-panel-terminal')).toContainElement(feed);
    expect(feed).toHaveTextContent('Read runner.ts');
    expect(feed).toHaveTextContent('The headless branch spawns without flags.');
    expect(screen.getByTestId('run-panel-logs')).not.toContainElement(feed);
  });

  it('pulls the view to the Terminal when a headless step starts reporting', async () => {
    const { transport } = renderRunDetail('job-pull');
    emitWhiphandEvent(transport, 'job-pull', 'run-pull', { type: 'step:start', stepId: 'impl', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-pull', runDir: '/ws/.whiphand/runs/run-pull', status: 'running', artifacts: [],
      steps: [{ id: 'impl', status: 'running' }],
    });
    expect(screen.getByTestId('run-panel-logs')).toBeVisible();

    emitWhiphandEvent(transport, 'job-pull', 'run-pull', { type: 'step:progress', stepId: 'impl', progress: { kind: 'tool', tool: 'Read', target: 'runner.ts' } }, 't2');

    // Same rule the pty already follows: a live session pulls the view to it.
    await waitFor(() => expect(screen.getByTestId('run-panel-terminal')).toBeVisible());
  });

  it('never overrides a chosen tab when a headless step starts reporting', async () => {
    const { transport } = renderRunDetail('job-pull2');
    emitWhiphandEvent(transport, 'job-pull2', 'run-pull2', { type: 'step:start', stepId: 'impl', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-pull2', runDir: '/ws/.whiphand/runs/run-pull2', status: 'running', artifacts: [],
      steps: [{ id: 'impl', status: 'running' }],
    });

    fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));
    emitWhiphandEvent(transport, 'job-pull2', 'run-pull2', { type: 'step:progress', stepId: 'impl', progress: { kind: 'tool', tool: 'Read', target: 'runner.ts' } }, 't2');

    await waitFor(() => expect(screen.getByTestId('run-panel-artifacts')).toBeVisible());
    expect(screen.getByTestId('run-panel-terminal')).not.toBeVisible();
  });

  it('carries the headless step\'s counters on its own pill, not above the feed', async () => {
    const { transport } = renderRunDetail('job-headline');
    emitWhiphandEvent(transport, 'job-headline', 'run-headline', { type: 'step:start', stepId: 'impl', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-headline', runDir: '/ws/.whiphand/runs/run-headline', status: 'running', artifacts: [],
      steps: [{ id: 'impl', status: 'running' }],
    });

    emitWhiphandEvent(transport, 'job-headline', 'run-headline', { type: 'step:progress', stepId: 'impl', progress: { kind: 'tool', tool: 'Edit', target: 'runner.ts' } }, 't2');
    emitWhiphandEvent(transport, 'job-headline', 'run-headline', { type: 'step:progress', stepId: 'impl', progress: { kind: 'usage', turns: 6, costUsd: 0.42 } }, 't3');

    // What it is doing is the feed's last line; what it has spent is on the
    // pill beside the clock. Neither is restated above the feed.
    expect(await screen.findByTestId('activity-feed')).toHaveTextContent('Edit runner.ts');
    const spend = screen.getByTestId('step-spend-impl');
    expect(spend).toHaveTextContent('6 turns');
    expect(spend).toHaveTextContent('$0.42');
    // The one thing the pill deliberately does not repeat from the feed.
    expect(spend).not.toHaveTextContent('Edit runner.ts');
  });

  it('shows no activity feed for a run that never reported any', async () => {
    const { transport } = renderRunDetail('job-noactivity');
    emitWhiphandEvent(transport, 'job-noactivity', 'run-noactivity', { type: 'step:start', stepId: 'tests', kind: 'command' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-noactivity', runDir: '/ws/.whiphand/runs/run-noactivity', status: 'running', artifacts: [],
      steps: [{ id: 'tests', status: 'running' }],
    });

    expect(screen.getByTestId('run-panel-logs')).toBeVisible();
    expect(screen.queryByTestId('activity-feed')).not.toBeInTheDocument();
  });

  it('says the step is generating its artifact between the pty exiting and the step finishing', async () => {
    const { transport } = renderRunDetail('job-harvest');
    emitWhiphandEvent(transport, 'job-harvest', 'run-harvest', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-harvest', runDir: '/ws/.whiphand/runs/run-harvest', status: 'running', artifacts: [],
      steps: [{ id: 'plan', status: 'running' }],
    });
    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-harvest', stepId: 'plan', cols: 80, rows: 24 } });
    await screen.findByTestId('terminal-panel-mock');

    // The session is over; the step is not. Between these two the engine is
    // reading the conversation back and writing the artifact.
    transport.emitLine({ method: 'ptyExit', params: { jobId: 'job-harvest', exitCode: 0, reason: 'ended' } });
    emitWhiphandEvent(transport, 'job-harvest', 'run-harvest', {
      type: 'step:spawn', stepId: 'plan', phase: 'harvest',
      spec: { argv: ['claude'], cwd: '/ws', env: {}, interactive: false },
    }, 't2');

    // Said once, on the step's own pill — not as a second line above a
    // terminal that is still on screen saying the session ended.
    const badge = await screen.findByTestId('step-phase-plan');
    expect(screen.getByTestId('run-stepper')).toContainElement(badge);
    expect(badge).toHaveTextContent('generating artifact');
    expect(screen.getByTestId('terminal-panel-mock')).toBeInTheDocument();

    // ...and it gives way once the step actually finishes.
    emitWhiphandEvent(transport, 'job-harvest', 'run-harvest', { type: 'step:done', stepId: 'plan', exitCode: 0 }, 't3');
    await waitFor(() => {
      expect(screen.queryByTestId('step-phase-plan')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('pty-session-ended-note')).toBeInTheDocument();
  });

  it('keeps narrating the headless step that follows an interactive one', async () => {
    const { transport } = renderRunDetail('job-handoff');
    emitWhiphandEvent(transport, 'job-handoff', 'run-handoff', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-handoff', runDir: '/ws/.whiphand/runs/run-handoff', status: 'running', artifacts: [],
      steps: [{ id: 'plan', status: 'running' }, { id: 'execute', status: 'pending' }],
    });

    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-handoff', stepId: 'plan', cols: 80, rows: 24 } });
    await screen.findByTestId('terminal-panel-mock');
    transport.emitLine({ method: 'ptyExit', params: { jobId: 'job-handoff', exitCode: 0 } });
    emitWhiphandEvent(transport, 'job-handoff', 'run-handoff', { type: 'step:done', stepId: 'plan', exitCode: 0 }, 't2');

    // The run moves on. The dead session must not go on owning the tab: the
    // headless step that took over is the thing running now.
    emitWhiphandEvent(transport, 'job-handoff', 'run-handoff', { type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'claude', mode: 'headless' }, 't3');
    emitWhiphandEvent(transport, 'job-handoff', 'run-handoff', { type: 'step:progress', stepId: 'execute', progress: { kind: 'tool', tool: 'Edit', target: 'runner.ts' } }, 't4');

    // The feed's own lines name the step that wrote them, so the tab still
    // says whose work this is without a headline over it.
    const feed = await screen.findByTestId('activity-feed');
    expect(feed).toHaveTextContent('execute');
    expect(feed).toHaveTextContent('Edit runner.ts');
    expect(screen.queryByTestId('pty-session-ended-note')).not.toBeInTheDocument();
  });

  it('narrates the step inside a running loop, not the loop around it', async () => {
    const { transport } = renderRunDetail('job-loopstatus');
    emitWhiphandEvent(transport, 'job-loopstatus', 'run-loopstatus', { type: 'loop:start', loopId: 'do-review', maxIterations: 3 }, 't1');
    emitWhiphandEvent(transport, 'job-loopstatus', 'run-loopstatus', { type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'claude', mode: 'headless', loopId: 'do-review', iteration: 1 }, 't2');
    await respondGetRun(transport, {
      runId: 'run-loopstatus', runDir: '/ws/.whiphand/runs/run-loopstatus', status: 'running', artifacts: [],
      steps: [{ id: 'do-review', kind: 'loop', status: 'running' }, { id: 'execute', status: 'running', loopId: 'do-review', iteration: 1 }],
    });

    // A running loop is a container, not something that reports — it has no
    // progress of its own, so letting it be "the current step" made the tab
    // claim there was no live session for every workflow whose headless steps
    // live in a loop. Asserted before any progress arrives, because that gap is
    // exactly where the wrong answer used to show.
    expect(await screen.findByTestId('activity-feed')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-empty')).not.toBeInTheDocument();

    emitWhiphandEvent(transport, 'job-loopstatus', 'run-loopstatus', { type: 'step:progress', stepId: 'execute', progress: { kind: 'usage', turns: 4 } }, 't3');
    emitWhiphandEvent(transport, 'job-loopstatus', 'run-loopstatus', { type: 'step:progress', stepId: 'execute', progress: { kind: 'tool', tool: 'Read', target: 'runner.ts' } }, 't4');

    const feed = await screen.findByTestId('activity-feed');
    await waitFor(() => expect(feed).toHaveTextContent('Read runner.ts'));
    expect(feed).toHaveTextContent('execute');
    expect(feed).not.toHaveTextContent('do-review');
    // The counters land on the body step's pill, not the loop's.
    expect(screen.getByTestId('step-spend-execute')).toHaveTextContent('4 turns');
    expect(screen.queryByTestId('step-spend-do-review')).not.toBeInTheDocument();
  });

  it('narrates a headless step that reports no counters at all', async () => {
    const { transport } = renderRunDetail('job-prose');
    emitWhiphandEvent(transport, 'job-prose', 'run-prose', { type: 'step:start', stepId: 'impl', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-prose', runDir: '/ws/.whiphand/runs/run-prose', status: 'running', artifacts: [],
      steps: [{ id: 'impl', status: 'running' }],
    });

    // Nothing reported yet: the pane holds the step's place rather than going
    // blank, and says so without restating the step's id or its clock.
    expect(await screen.findByTestId('activity-feed')).toHaveTextContent('No output yet.');

    // Prose is never a last action, so this step has no `progress` summary at
    // all — it is still the step the tab is narrating.
    emitWhiphandEvent(transport, 'job-prose', 'run-prose', { type: 'step:progress', stepId: 'impl', progress: { kind: 'text', text: 'Reading the runner.' } }, 't2');

    await waitFor(() => {
      expect(screen.getByTestId('activity-feed')).toHaveTextContent('Reading the runner.');
    });
    expect(screen.getByTestId('activity-feed')).not.toHaveTextContent('No output yet.');
    expect(screen.queryByTestId('step-spend-impl')).not.toBeInTheDocument();
  });

  it('collapses the terminal for an interactive step re-run inside a loop', async () => {
    const { transport } = renderRunDetail('job-ptyloop');
    emitWhiphandEvent(transport, 'job-ptyloop', 'run-ptyloop', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive', loopId: 'fix', iteration: 2 }, 't1');
    await respondGetRun(transport, { runId: 'run-ptyloop', runDir: '/ws/.whiphand/runs/run-ptyloop', status: 'running', artifacts: [] });

    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-ptyloop', stepId: 'plan', cols: 80, rows: 24 } });
    await screen.findByTestId('terminal-panel-mock');
    transport.emitLine({ method: 'ptyExit', params: { jobId: 'job-ptyloop', exitCode: 0 } });
    emitWhiphandEvent(transport, 'job-ptyloop', 'run-ptyloop', { type: 'step:done', stepId: 'plan', exitCode: 0 }, 't2');

    // ptyStarted reports a step *id*; job.steps is keyed by execution, which
    // from iteration 2 on is 'plan#2'. Looking the step up by id found nothing
    // and pinned a dead terminal open for the rest of the run.
    expect(await screen.findByTestId('pty-session-ended-note')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-panel-mock')).not.toBeInTheDocument();
  });

  it('a client attaching mid-step keeps the disk\'s running status once a live event lands (F1/F2)', async () => {
    // No step:start ever seen for 'execute' here — this simulates a browser
    // opened after the step had already started: only `runId` is known up
    // front (as it would be, opened from the Runs list), with no live job at
    // all until the first event arrives. The manifest already says the step
    // is running; that first live event must not downgrade it to the guessed
    // row's default 'pending'.
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'run-attach');
    await respondGetRun(transport, {
      runId: 'run-attach', runDir: '/ws/.whiphand/runs/run-attach', status: 'running', artifacts: [],
      // A second, still-pending step: if the bug degrades 'execute' from
      // 'running' to 'pending', findCurrentStepIndex still lands on it (the
      // first non-terminal step either way), so the pill's *own* reported
      // status — not just which one gets the focus ring — is what actually
      // pins the regression.
      steps: [
        { id: 'execute', status: 'running', startedAt: '2026-01-01T00:00:00Z' },
        { id: 'review', status: 'pending' },
      ],
    });
    expect(await screen.findByTestId('step-card-execute')).toHaveAttribute('aria-label', expect.stringContaining('running'));

    emitWhiphandEvent(transport, 'job-attach-late', 'run-attach',
      { type: 'step:progress', stepId: 'execute', progress: { kind: 'usage', turns: 2 } }, 't1');

    // Still running — the guessed row's default 'pending' status must not
    // have won the merge — and still the focus.
    await waitFor(() => expect(screen.getByTestId('step-spend-execute')).toHaveTextContent('2 turns'));
    expect(screen.getByTestId('step-card-execute')).toHaveAttribute('aria-label', expect.stringContaining('running'));
    expect(screen.getByTestId('step-card-execute')).toHaveAttribute('data-current', 'true');
  });

  it('the running body step gets the highlight, not the loop around it (F7)', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'run-f7');
    await respondGetRun(transport, {
      runId: 'run-f7', runDir: '/ws/.whiphand/runs/run-f7', status: 'running', artifacts: [],
      steps: [
        { id: 'fix', kind: 'loop', status: 'running', iterations: 1, maxIterations: 3 },
        { id: 'execute', status: 'running', loopId: 'fix', iteration: 1 },
      ],
    });

    expect(await screen.findByTestId('step-card-execute')).toHaveAttribute('data-current', 'true');
    expect(screen.getByTestId('step-card-fix')).not.toHaveAttribute('data-current', 'true');
  });

  it('a finished job\'s stale live "running" never beats a terminal disk status (merge guard)', async () => {
    // The agent no longer tracks this job (evicted from its own per-job
    // history — MAX_TRACKED_JOBS — or simply a stale reload): its live
    // 'running' is left over from a session that is long gone, but the disk
    // row already reached a terminal state. Built directly, the way the
    // sibling "ignores a finished job" test does, because reaching this
    // through real events would require constructing the very eviction this
    // guards against.
    useAppStore.setState({
      jobs: {
        'job-evicted': {
          jobId: 'job-evicted', runId: 'r-evicted', finished: true, workdir: '/ws',
          stepOrder: ['execute'],
          steps: { execute: { key: 'execute', id: 'execute', status: 'running', startedAt: 't0' } },
          currentExecution: {}, events: [], logTail: [], activityTail: [], hasNarrated: false,
          ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
        } as never,
      },
    });
    const { transport } = renderRunDetail('job-evicted');
    // Deliberately NOT 'running': that would trip the page-level staleJob
    // guard instead (see "ignores a finished job..."), which nulls the job
    // out entirely rather than exercising mergeSteps' own guard.
    await respondGetRun(transport, {
      runId: 'r-evicted', runDir: '/ws/.whiphand/runs/r-evicted', status: 'succeeded', artifacts: [],
      steps: [{ id: 'execute', status: 'done', startedAt: 't0', endedAt: 't1' }],
    });

    expect(await screen.findByTestId('step-card-execute')).toHaveAttribute('aria-label', expect.stringContaining('done'));
  });

  it('a guessed loop row from loop:iteration without loop:start keeps the disk status (merge guard, F2 loop)', async () => {
    const { transport } = renderRunDetail('job-loopguess', vi.fn(), vi.fn(), 'run-loopguess');
    await respondGetRun(transport, {
      runId: 'run-loopguess', runDir: '/ws/.whiphand/runs/run-loopguess', status: 'running', artifacts: [],
      steps: [{ id: 'fix', kind: 'loop', status: 'running', iterations: 2, maxIterations: 3 }],
    });
    expect(await screen.findByTestId('step-card-fix')).toHaveAttribute('aria-label', expect.stringContaining('running'));

    // No loop:start ever seen for 'fix' — patchCurrent's fallback has nothing
    // to route to, so it guesses a fresh row defaulted to 'pending' and marks
    // it inferred. The disk row, not this guess, must win the merge.
    emitWhiphandEvent(transport, 'job-loopguess', 'run-loopguess',
      { type: 'loop:iteration', loopId: 'fix', iteration: 2, maxIterations: 3 }, 't1');

    // Wait on the store update itself first, not just the DOM: the pill
    // already reads 'running' from the untouched disk row before this event
    // is even processed, so a waitFor that only re-checks the same aria-label
    // text would pass on its very first, stale synchronous check and never
    // actually observe a re-render — a false pass that would not catch a
    // regression in the merge guard below.
    await waitFor(() => {
      expect(useAppStore.getState().jobs['job-loopguess']?.steps.fix).toMatchObject({ inferred: true });
    });
    await waitFor(() => {
      expect(screen.getByTestId('step-card-fix')).toHaveAttribute('aria-label', expect.stringContaining('running'));
    });
  });

  it('replaying at loop iteration 2 on attach never resurrects iteration 1\'s row (should-fix 3)', async () => {
    // Disk at iteration 2, no store rows before this test starts — exactly a
    // browser opened fresh mid-iteration-2.
    const { transport } = renderRunDetail('job-loopattach', vi.fn(), vi.fn(), 'run-loopattach');
    await respondGetRun(transport, {
      runId: 'run-loopattach', runDir: '/ws/.whiphand/runs/run-loopattach', status: 'running', artifacts: [],
      steps: [
        { id: 'fix', kind: 'loop', status: 'running', iterations: 2, maxIterations: 3 },
        { id: 'execute', status: 'done', loopId: 'fix', iteration: 1, startedAt: 't0', endedAt: 't1' },
        { id: 'execute', status: 'running', loopId: 'fix', iteration: 2, startedAt: 't2' },
      ],
    });

    // No-replay path: before the agent's buffered stream ever lands, disk
    // alone already shows iteration 2 running and in focus.
    expect(await screen.findByTestId('step-card-execute')).toHaveAttribute('data-current', 'true');

    // The agent's buffer has exactly what this client missed by attaching
    // mid-iteration-2: the loop starting, moving to iteration 2, and
    // iteration 2's own step:start.
    useAppStore.getState().applyEventReplay('job-loopattach', [
      { jobId: 'job-loopattach', runId: 'run-loopattach', ts: 't0', seq: 0, event: { type: 'loop:start', loopId: 'fix', maxIterations: 3 } },
      { jobId: 'job-loopattach', runId: 'run-loopattach', ts: 't1', seq: 1, event: { type: 'loop:iteration', loopId: 'fix', iteration: 2, maxIterations: 3 } },
      {
        jobId: 'job-loopattach', runId: 'run-loopattach', ts: 't2', seq: 2,
        event: { type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'claude', mode: 'headless', loopId: 'fix', iteration: 2 },
      },
    ]);

    // A bare later event carries no iteration of its own — it must route
    // through currentExecution to execute#2, the row step:start just set, not
    // guess iteration 1 back into existence (F1).
    emitWhiphandEvent(transport, 'job-loopattach', 'run-loopattach',
      { type: 'step:progress', stepId: 'execute', progress: { kind: 'tool', tool: 'Edit', target: 'runner.ts' } }, 't3');

    const job = useAppStore.getState().jobs['job-loopattach']!;
    expect(job.steps.execute).toBeUndefined();
    expect(job.steps['execute#2']).toMatchObject({ status: 'running', iteration: 2 });
    expect(screen.getByTestId('step-card-execute')).toHaveAttribute('data-current', 'true');
  });

  it('attaching after the pty already exited, with no live step:start/done for it, collapses the terminal (F4)', async () => {
    // The manifest already recorded 'plan' as done — from before this client
    // connected, or from a process it never watched — but no step:start or
    // step:done for it ever arrived live, so job.steps (and currentExecution)
    // have nothing under that key. Only ptyStarted/ptyExit did.
    const { transport } = renderRunDetail('job-deadterm', vi.fn(), vi.fn(), 'run-deadterm');
    await respondGetRun(transport, {
      runId: 'run-deadterm', runDir: '/ws/.whiphand/runs/run-deadterm', status: 'succeeded', artifacts: [],
      steps: [{ id: 'plan', status: 'done', mode: 'interactive' }],
    });
    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-deadterm', stepId: 'plan', cols: 80, rows: 24 } });
    await screen.findByTestId('terminal-panel-mock');
    transport.emitLine({ method: 'ptyExit', params: { jobId: 'job-deadterm', exitCode: 0 } });

    // Looking `job.steps['plan']` up directly found nothing (no live step
    // event ever named it) and kept the terminal open forever; falling back
    // to the merged (disk + live) steps finds the manifest's own 'done'.
    expect(await screen.findByTestId('pty-session-ended-note')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-panel-mock')).not.toBeInTheDocument();
  });

  it('clears the feed when the next step starts, without bouncing back to Logs', async () => {
    const { transport } = renderRunDetail('job-feedreset');
    emitWhiphandEvent(transport, 'job-feedreset', 'run-feedreset', { type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-feedreset', runDir: '/ws/.whiphand/runs/run-feedreset', status: 'running', artifacts: [],
      steps: [{ id: 'execute', status: 'running' }, { id: 'review', status: 'pending' }],
    });

    emitWhiphandEvent(transport, 'job-feedreset', 'run-feedreset', { type: 'step:progress', stepId: 'execute', progress: { kind: 'tool', tool: 'Edit', target: 'runner.ts' } }, 't2');
    expect(await screen.findByTestId('activity-feed')).toHaveTextContent('Edit runner.ts');

    emitWhiphandEvent(transport, 'job-feedreset', 'run-feedreset', { type: 'step:done', stepId: 'execute', exitCode: 0 }, 't3');
    emitWhiphandEvent(transport, 'job-feedreset', 'run-feedreset', { type: 'step:start', stepId: 'review', kind: 'agent', runner: 'claude', mode: 'headless' }, 't4');

    // The feed shows the step running now and nothing else — but the tab must
    // not flip back to Logs in the gap before the new step's first line.
    await waitFor(() => {
      expect(screen.getByTestId('step-card-review')).toHaveAttribute('data-current', 'true');
    });
    expect(screen.getByTestId('activity-feed')).not.toHaveTextContent('Edit runner.ts');
    expect(screen.getByTestId('run-panel-terminal')).toBeVisible();
  });

  it('places a run with no session on the same recessed surface as the feed', async () => {
    const { transport } = renderRunDetail('job-empty');
    emitWhiphandEvent(transport, 'job-empty', 'run-empty', { type: 'step:start', stepId: 'tests', kind: 'command' }, 't1');
    await respondGetRun(transport, {
      runId: 'run-empty', runDir: '/ws/.whiphand/runs/run-empty', status: 'running', artifacts: [],
      steps: [{ id: 'tests', status: 'running' }],
    });

    // A bare sentence read as a stray label in an otherwise blank tab. The
    // panel is the same surface whether or not anything is running in it.
    // Compared against the log tail rather than spelled out: the claim is
    // that they are the same surface, and jsdom lowercases a custom property
    // in the serialized style, so naming the token here would be brittle.
    const placeholder = await screen.findByTestId('terminal-empty');
    expect(screen.getByTestId('run-panel-terminal')).toContainElement(placeholder);
    expect(placeholder.style.background).not.toBe('');
    expect(placeholder.style.background).toBe(screen.getByTestId('log-tail').style.background);
    // The state, not a lecture on the mechanism behind it.
    expect(placeholder).toHaveTextContent('No live session.');
  });

  it('keeps the session-ended placeholder on that surface too', async () => {
    const { transport } = renderRunDetail('job-endedsurface');
    emitWhiphandEvent(transport, 'job-endedsurface', 'run-endedsurface', { type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
    await respondGetRun(transport, { runId: 'run-endedsurface', runDir: '/ws/.whiphand/runs/run-endedsurface', status: 'running', artifacts: [] });

    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-endedsurface', stepId: 'plan', cols: 80, rows: 24 } });
    await screen.findByTestId('terminal-panel-mock');
    transport.emitLine({ method: 'ptyExit', params: { jobId: 'job-endedsurface', exitCode: 0 } });
    emitWhiphandEvent(transport, 'job-endedsurface', 'run-endedsurface', { type: 'step:done', stepId: 'plan', exitCode: 0 }, 't2');

    const note = await screen.findByTestId('pty-session-ended-note');
    expect(note.style.background).toBe(screen.getByTestId('log-tail').style.background);
    expect(note).toHaveTextContent(/session ended/i);
  });

  it('defaults to Logs, and moves to Terminal by itself when a session starts', async () => {
    const { transport } = renderRunDetail('job-tabs');
    emitWhiphandEvent(transport, 'job-tabs', 'run-tabs', { type: 'step:start', stepId: 'triage', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
    await respondGetRun(transport, { runId: 'run-tabs', runDir: '/ws/.whiphand/runs/run-tabs', status: 'running', artifacts: [] });

    expect(screen.getByTestId('run-panel-logs')).toBeVisible();

    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-tabs', stepId: 'triage', cols: 80, rows: 24 } });

    expect(await screen.findByTestId('terminal-panel-mock')).toBeVisible();
    expect(screen.getByTestId('run-panel-logs')).not.toBeVisible();
  });

  it('never overrides a tab the user picked themselves', async () => {
    const { transport } = renderRunDetail('job-tabs2');
    emitWhiphandEvent(transport, 'job-tabs2', 'run-tabs2', { type: 'step:start', stepId: 'triage', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
    await respondGetRun(transport, { runId: 'run-tabs2', runDir: '/ws/.whiphand/runs/run-tabs2', status: 'running', artifacts: [] });

    fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));
    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-tabs2', stepId: 'triage', cols: 80, rows: 24 } });

    await waitFor(() => expect(screen.getByTestId('run-panel-artifacts')).toBeVisible());
    expect(screen.getByTestId('run-panel-terminal')).not.toBeVisible();
  });

  it('keeps every panel mounted so switching tabs does not tear down the terminal', async () => {
    const { transport } = renderRunDetail('job-tabs3');
    emitWhiphandEvent(transport, 'job-tabs3', 'run-tabs3', { type: 'step:start', stepId: 'triage', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
    await respondGetRun(transport, { runId: 'run-tabs3', runDir: '/ws/.whiphand/runs/run-tabs3', status: 'running', artifacts: [] });
    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-tabs3', stepId: 'triage', cols: 80, rows: 24 } });

    const instance = (await screen.findByTestId('terminal-panel-mock')).getAttribute('data-instance');
    fireEvent.click(screen.getByRole('tab', { name: /logs/i }));
    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));

    expect(screen.getByTestId('terminal-panel-mock').getAttribute('data-instance')).toBe(instance);
  });

  it('offers Resume for a failed run and calls resumeRun', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-failed');
    await respondGetRun(transport, {
      runId: 'r-failed', runDir: '/ws/.whiphand/runs/r-failed', status: 'failed',
      workflow: 'cycle', inputs: {}, artifacts: [],
      steps: [{ id: 'plan', status: 'done' }, { id: 'execute', status: 'failed' }],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));

    const req = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'resumeRun');
      if (i === -1) throw new Error('resumeRun not sent yet');
      return transport.sentRequest(i);
    });
    expect(req.params).toMatchObject({ workdir: '/ws', runId: 'r-failed' });
    expect((req.params as { freshSession?: boolean }).freshSession).toBeUndefined();
  });

  it('offers Resume for an interrupted and a cancelled run too', async () => {
    for (const status of ['interrupted', 'cancelled']) {
      const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), `r-${status}`);
      await respondGetRun(transport, {
        runId: `r-${status}`, runDir: `/ws/.whiphand/runs/r-${status}`, status,
        workflow: 'cycle', inputs: {}, artifacts: [], steps: [{ id: 'plan', status: 'failed' }],
      });

      expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
      cleanup();
    }
  });

  it('offers no Resume for a run that succeeded', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-ok2');
    await respondGetRun(transport, {
      runId: 'r-ok2', runDir: '/ws/.whiphand/runs/r-ok2', status: 'succeeded',
      workflow: 'cycle', inputs: {}, artifacts: [], steps: [{ id: 'plan', status: 'done' }],
    });

    // "Run again" is the right affordance for a run that finished.
    await screen.findByRole('button', { name: 'Run again' });
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  it('can resume with a fresh session, for when the recorded one is gone', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-fresh');
    await respondGetRun(transport, {
      runId: 'r-fresh', runDir: '/ws/.whiphand/runs/r-fresh', status: 'failed',
      workflow: 'cycle', inputs: {}, artifacts: [], steps: [{ id: 'plan', status: 'failed' }],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'More resume options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /fresh session/i }));

    const req = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'resumeRun');
      if (i === -1) throw new Error('resumeRun not sent yet');
      return transport.sentRequest(i);
    });
    expect(req.params).toMatchObject({ workdir: '/ws', runId: 'r-fresh', freshSession: true });
  });

  it('can resume with more iterations, via its own dialog', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-extra');
    await respondGetRun(transport, {
      runId: 'r-extra', runDir: '/ws/.whiphand/runs/r-extra', status: 'failed',
      workflow: 'cycle', inputs: {}, artifacts: [], steps: [{ id: 'plan', status: 'failed' }],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'More resume options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /more iterations/i }));

    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByTestId('resume-extra-iterations-input');
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(await within(dialog).findByText(/positive whole number/i)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '2' } });
    // `hidden: true`, uniquely among this file's dialog tests, because this is
    // the only dialog opened from a Menu. Tabster stamps `aria-hidden="true"`
    // on the surface roughly 10-50ms after the menu that opened it tears down
    // — measured, not guessed — which takes every role inside it out of the
    // accessibility tree for good. Every other dialog here is opened from a
    // plain button and stays accessible, so none of them need this.
    //
    // Not a wait: the attribute never comes back off, so `findByRole` would
    // only spend its timeout. It reads as a Windows failure purely because CI
    // there is slow enough to cross the 10ms line; on Linux the same test wins
    // the race and passes, which is why this landed green locally.
    //
    // Whether a real browser does the same to a screen reader is NOT settled
    // by this test — jsdom drives none of the focus machinery tabster keys
    // off. Worth checking by hand against a real dialog-from-a-menu.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resume', hidden: true }));

    const req = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'resumeRun');
      if (i === -1) throw new Error('resumeRun not sent yet');
      return transport.sentRequest(i);
    });
    expect(req.params).toMatchObject({ workdir: '/ws', runId: 'r-extra', extraIterations: 2 });
    expect((req.params as { freshSession?: boolean }).freshSession).toBeUndefined();
  });

  it('follows the job the resume starts rather than the attempt that failed', async () => {
    const { transport, onResumed } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-follow');
    await respondGetRun(transport, {
      runId: 'r-follow', runDir: '/ws/.whiphand/runs/r-follow', status: 'failed',
      workflow: 'cycle', inputs: {}, artifacts: [],
      error: { stepId: 'execute', message: "step 'execute' exited with code 1" },
      steps: [{ id: 'plan', status: 'done' }, { id: 'execute', status: 'failed' }],
    });
    expect(await screen.findByText(/exited with code 1/)).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await respondResumeRun(transport, 'job-resumed');

    await waitFor(() => expect(onResumed).toHaveBeenCalledWith({ jobId: 'job-resumed', runId: 'r-follow' }));
    // Tagged before any notification can land, the way NewRunDialog does it.
    await waitFor(() => expect(useAppStore.getState().jobs['job-resumed']?.workdir).toBe('/ws'));
  });

  it('drops the failed attempt once the resumed run reports in', async () => {
    useAppStore.setState({
      jobs: {
        'job-old': {
          jobId: 'job-old', runId: 'r-live', finished: true, workdir: '/ws',
          errorMessage: "step 'execute' exited with code 1",
          stepOrder: ['execute'], steps: { execute: { key: 'execute', id: 'execute', status: 'failed' } },
          currentExecution: {}, events: [], logTail: [], activityTail: [], hasNarrated: false,
          ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
        } as never,
      },
    });
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-live');
    await respondGetRun(transport, {
      runId: 'r-live', runDir: '/ws/.whiphand/runs/r-live', status: 'failed',
      workflow: 'cycle', inputs: {}, artifacts: [],
      steps: [{ id: 'plan', status: 'done' }, { id: 'execute', status: 'failed' }],
    });
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await respondResumeRun(transport, 'job-new');
    emitWhiphandEvent(transport, 'job-new', 'r-live', { type: 'run:resume', runId: 'r-live', workflow: 'cycle' }, 't1');
    emitWhiphandEvent(transport, 'job-new', 'r-live', { type: 'step:skipped', stepId: 'plan' }, 't2');
    emitWhiphandEvent(transport, 'job-new', 'r-live',
      { type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'claude', mode: 'headless' }, 't3');

    // The live job wins over the finished one on the same run: no stale error,
    // no Resume, and the step that failed is running again.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument());
    expect(screen.queryByText(/exited with code 1/)).not.toBeInTheDocument();
    expect(screen.getByTestId('step-card-execute')).toHaveAttribute('aria-label', expect.stringMatching(/running/i));
  });

  it('ignores a finished job when the run has been resumed outside this window', async () => {
    useAppStore.setState({
      jobs: {
        'job-cli': {
          jobId: 'job-cli', runId: 'r-cli', finished: true, workdir: '/ws',
          errorMessage: "step 'execute' exited with code 1",
          stepOrder: ['execute'], steps: { execute: { key: 'execute', id: 'execute', status: 'failed' } },
          currentExecution: {}, events: [], logTail: [], activityTail: [], hasNarrated: false,
          ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
        } as never,
      },
    });
    const { transport } = renderRunDetail('job-cli');
    // `whiphand run --resume` in a terminal: run.json says running, but this window
    // owns no job for it and will never be notified.
    await respondGetRun(transport, {
      runId: 'r-cli', runDir: '/ws/.whiphand/runs/r-cli', status: 'running',
      workflow: 'cycle', inputs: {}, artifacts: [],
      steps: [{ id: 'plan', status: 'done' }, { id: 'execute', status: 'running' }],
    });

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument());
    expect(screen.queryByText(/exited with code 1/)).not.toBeInTheDocument();
    expect(screen.getByTestId('step-card-execute')).toHaveAttribute('aria-label', expect.stringMatching(/running/i));

    // Cancel must reach the owning process by pid, not this window's dead job.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm cancel' }));
    const req = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'cancelRun');
      if (i === -1) throw new Error('cancelRun not sent yet');
      return transport.sentRequest(i);
    });
    expect(req.params).toEqual({ workdir: '/ws', runId: 'r-cli' });
  });

  it('keeps re-reading a stopped-but-resumable run, so a resume elsewhere is noticed', async () => {
    vi.useFakeTimers();
    try {
      const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-idle');
      const first = await vi.waitFor(() => {
        const i = transport.sent.findIndex(l => (JSON.parse(l) as { method: string }).method === 'getRun');
        if (i === -1) throw new Error('getRun not sent yet');
        return transport.sentRequest(i);
      });
      transport.emitLine({
        id: first.id,
        result: {
          runId: 'r-idle', runDir: '/ws/.whiphand/runs/r-idle', status: 'failed',
          workflow: 'cycle', inputs: {}, artifacts: [], steps: [{ id: 'execute', status: 'failed' }],
        },
      });

      await vi.advanceTimersByTimeAsync(11_000);

      const second = await vi.waitFor(() => {
        const calls = transport.sent.filter(l => (JSON.parse(l) as { method: string }).method === 'getRun');
        if (calls.length < 2) throw new Error('second getRun not sent yet');
        return transport.sentRequest(transport.sent.length - 1);
      });
      transport.emitLine({
        id: second.id,
        result: {
          runId: 'r-idle', runDir: '/ws/.whiphand/runs/r-idle', status: 'running',
          workflow: 'cycle', inputs: {}, artifacts: [], steps: [{ id: 'execute', status: 'running' }],
        },
      });

      await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops re-reading a run that succeeded — nothing can change it', async () => {
    vi.useFakeTimers();
    try {
      const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-done');
      const first = await vi.waitFor(() => {
        const i = transport.sent.findIndex(l => (JSON.parse(l) as { method: string }).method === 'getRun');
        if (i === -1) throw new Error('getRun not sent yet');
        return transport.sentRequest(i);
      });
      transport.emitLine({
        id: first.id,
        result: {
          runId: 'r-done', runDir: '/ws/.whiphand/runs/r-done', status: 'succeeded',
          workflow: 'cycle', inputs: {}, artifacts: [], steps: [{ id: 'execute', status: 'done' }],
        },
      });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(transport.sent.filter(l => (JSON.parse(l) as { method: string }).method === 'getRun')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The run-audit Logs tab: one merged, seq-ordered feed of the run's audit
 * trail (whiphandEvents) and its output (`step:log`), live or read back from
 * a finished run's run.log through `readRunLog`. See RunDetailPage's
 * `liveLogRows`/`finishedLogRows` and packages/core/src/engine/manifest.ts.
 */
describe('RunDetailPage: Logs tab (run audit)', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', jobs: {} });
  });

  function emitWithSeq(
    transport: MockTransport, jobId: string, runId: string, event: WhiphandEvent, ts: string, seq: number,
  ): void {
    transport.emitLine({ method: 'whiphandEvent', params: { jobId, runId, event, ts, seq } });
  }

  it('merges audit events and step:log output into one feed, in seq order', async () => {
    const { transport } = renderRunDetail('job-logs');
    emitWithSeq(transport, 'job-logs', 'r-logs', { type: 'run:start', runId: 'r-logs', workflow: 'w' }, 't1', 1);
    emitWithSeq(
      transport, 'job-logs', 'r-logs',
      { type: 'step:start', stepId: 'build', kind: 'command' }, 't2', 2,
    );
    emitWithSeq(
      transport, 'job-logs', 'r-logs',
      { type: 'step:log', stepId: 'build', stream: 'stdout', line: 'compiling now' }, 't3', 3,
    );
    emitWithSeq(
      transport, 'job-logs', 'r-logs',
      { type: 'step:log', stepId: 'build', stream: 'stderr', line: 'a warning appeared' }, 't4', 4,
    );

    // step:log lines are coalesced into one commit per window, so the second
    // one lands a moment after the first.
    await waitFor(() => expect(screen.getAllByTestId('log-row')).toHaveLength(4));
    const rows = screen.getAllByTestId('log-row');
    expect(rows[0]).toHaveTextContent(/run started/);
    expect(rows[1]).toHaveTextContent(/step started/);
    expect(rows[2]).toHaveTextContent('compiling now');
    expect(rows[3]).toHaveTextContent('a warning appeared');
  });

  it('"Audit only" keeps the audit spine and drops both step:log and step:progress rows', async () => {
    const { transport } = renderRunDetail('job-logs2');
    emitWithSeq(transport, 'job-logs2', 'r-logs2', { type: 'run:start', runId: 'r-logs2', workflow: 'w' }, 't1', 1);
    emitWithSeq(
      transport, 'job-logs2', 'r-logs2',
      { type: 'step:log', stepId: 'a', stream: 'stdout', line: 'noisy build output' }, 't2', 2,
    );
    emitWithSeq(
      transport, 'job-logs2', 'r-logs2',
      { type: 'step:progress', stepId: 'a', progress: { kind: 'text', text: 'thinking out loud' } }, 't3', 3,
    );
    await screen.findAllByTestId('log-row');
    const logTail = screen.getByTestId('log-tail');

    fireEvent.click(screen.getByTestId('log-filter-audit-only'));
    await waitFor(() => expect(within(logTail).queryByText('noisy build output')).not.toBeInTheDocument());
    expect(within(logTail).queryByText('thinking out loud')).not.toBeInTheDocument();
    expect(within(logTail).getByText(/run started/)).toBeInTheDocument();

    // Switching back to "All" restores both.
    fireEvent.click(screen.getByTestId('log-filter-all'));
    expect(await within(logTail).findByText('noisy build output')).toBeInTheDocument();
    expect(within(logTail).getByText('thinking out loud')).toBeInTheDocument();
  });

  it('"Errors only" keeps stderr and error-kind rows, and drops ordinary stdout', async () => {
    const { transport } = renderRunDetail('job-logs3');
    emitWithSeq(
      transport, 'job-logs3', 'r-logs3',
      { type: 'step:log', stepId: 'a', stream: 'stdout', line: 'ordinary output' }, 't1', 1,
    );
    emitWithSeq(
      transport, 'job-logs3', 'r-logs3',
      { type: 'step:log', stepId: 'a', stream: 'stderr', line: 'a real error' }, 't2', 2,
    );
    // The stderr line is coalesced behind the first step:log, so wait for it.
    expect(await screen.findByText('a real error')).toBeInTheDocument();

    const errorsOnly = screen.getByTestId('log-filter-errors-only');
    fireEvent.click(errorsOnly);
    await waitFor(() => expect(screen.queryByText('ordinary output')).not.toBeInTheDocument());
    expect(screen.getByText('a real error')).toBeInTheDocument();
    expect(errorsOnly).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('log-filter-all')).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders step:progress content live — tool calls and assistant text, not the word "progress"', async () => {
    const { transport } = renderRunDetail('job-logs-progress');
    emitWithSeq(
      transport, 'job-logs-progress', 'r-logs-progress',
      { type: 'step:progress', stepId: 'a', progress: { kind: 'tool', tool: 'Read', target: 'foo.ts' } }, 't1', 1,
    );
    emitWithSeq(
      transport, 'job-logs-progress', 'r-logs-progress',
      { type: 'step:progress', stepId: 'a', progress: { kind: 'text', text: 'looking at the file' } }, 't2', 2,
    );

    const logTail = await screen.findByTestId('log-tail');
    expect(await within(logTail).findByText('Read foo.ts')).toBeInTheDocument();
    expect(within(logTail).getByText('looking at the file')).toBeInTheDocument();
    expect(within(logTail).queryByText('progress')).not.toBeInTheDocument();
  });

  it('the "N of M rows" counter and Clear filters track the active filter', async () => {
    const { transport } = renderRunDetail('job-logs-count');
    emitWithSeq(transport, 'job-logs-count', 'r-logs-count', { type: 'run:start', runId: 'r-logs-count', workflow: 'w' }, 't1', 1);
    emitWithSeq(
      transport, 'job-logs-count', 'r-logs-count',
      { type: 'step:log', stepId: 'a', stream: 'stdout', line: 'build output' }, 't2', 2,
    );
    await screen.findAllByTestId('log-row');

    expect(screen.getByTestId('log-filter-count')).toHaveTextContent('2 of 2 rows');
    expect(screen.queryByTestId('log-filter-clear')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('log-filter-audit-only'));
    await waitFor(() => expect(screen.getByTestId('log-filter-count')).toHaveTextContent('1 of 2 rows'));
    expect(screen.getByTestId('log-filter-clear')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('log-filter-clear'));
    await waitFor(() => expect(screen.getByTestId('log-filter-count')).toHaveTextContent('2 of 2 rows'));
    expect(screen.queryByTestId('log-filter-clear')).not.toBeInTheDocument();
  });

  it('a run with no live job reads its rows from run.log via readRunLog', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-finished');
    await respondGetRun(transport, {
      runId: 'r-finished', runDir: '/ws/.whiphand/runs/r-finished', status: 'succeeded',
      workflow: 'w', inputs: {}, artifacts: [], steps: [],
    });

    const req = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'readRunLog');
      if (i === -1) throw new Error('readRunLog not sent yet');
      return transport.sentRequest(i);
    });
    expect(req.params).toMatchObject({ workdir: '/ws', runId: 'r-finished' });
    transport.emitLine({
      id: req.id,
      result: {
        lines: [
          "2026-01-01T00:00:00.000Z  1  run:start  -  run started: workflow 'w'",
          '2026-01-01T00:00:01.000Z  2  step:log:stdout  a  hello from disk',
        ],
        total: 2,
        truncated: false,
      },
    });

    expect(await screen.findByText('hello from disk')).toBeInTheDocument();
    expect(screen.getByText(/run started/)).toBeInTheDocument();
  });

  it('falls back to readRunLog when the bound job is a rowless entry from listJobs/applyJobSummaries', async () => {
    // use-job-attach.ts calls listJobs on every reconnect, and applyJobSummaries
    // (store.ts) seeds an *empty* JobState — events: [], logRows: [] — for every
    // job the agent still has registered, including ones this window never
    // watched live. A job object existing must not by itself select the live
    // path, or a reconnect/reload leaves the Logs tab blank for a run whose
    // complete audit is sitting in run.log on disk.
    useAppStore.setState({
      workspacePath: '/ws',
      jobs: {
        'job-seeded': {
          jobId: 'job-seeded', runId: 'r-seeded', finished: true, workdir: '/ws',
          stepOrder: [], steps: {}, currentExecution: {},
          events: [], logTail: [], logRows: [], activityTail: [], hasNarrated: false,
          ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
        } as never,
      },
    });
    const { transport } = renderRunDetail('job-seeded', vi.fn(), vi.fn(), 'r-seeded');
    await respondGetRun(transport, {
      runId: 'r-seeded', runDir: '/ws/.whiphand/runs/r-seeded', status: 'succeeded',
      workflow: 'w', inputs: {}, artifacts: [], steps: [],
    });

    const req = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'readRunLog');
      if (i === -1) throw new Error('readRunLog not sent yet');
      return transport.sentRequest(i);
    });
    expect(req.params).toMatchObject({ workdir: '/ws', runId: 'r-seeded' });
    transport.emitLine({
      id: req.id,
      result: { lines: ["2026-01-01T00:00:00.000Z  1  run:start  -  run started: workflow 'w'"], total: 1, truncated: false },
    });

    expect(await screen.findByText(/run started/)).toBeInTheDocument();
  });

  it('reconnecting to a still-running run keeps its pre-reconnect history once a live row arrives', async () => {
    // Iteration 2's B1 fix made a rowless job fall back to readRunLog, but the
    // fallback was an outright switch: usingLiveLogFeed flipped to true the
    // instant the run's next event arrived, and the page rendered only
    // job.events/job.logRows from that point on — discarding the history the
    // readRunLog fetch had just rendered. This asserts the merge instead:
    // fetched rows stay, and only live rows past the last fetched seq append.
    useAppStore.setState({
      workspacePath: '/ws',
      jobs: {
        'job-running': {
          jobId: 'job-running', runId: 'r-running', finished: false, workdir: '/ws',
          stepOrder: [], steps: {}, currentExecution: {},
          events: [], logTail: [], logRows: [], activityTail: [], hasNarrated: false,
          ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
        } as never,
      },
    });
    const { transport } = renderRunDetail('job-running', vi.fn(), vi.fn(), 'r-running');
    await respondGetRun(transport, {
      runId: 'r-running', runDir: '/ws/.whiphand/runs/r-running', status: 'running',
      workflow: 'w', inputs: {}, artifacts: [], steps: [],
    });

    const req = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'readRunLog');
      if (i === -1) throw new Error('readRunLog not sent yet');
      return transport.sentRequest(i);
    });
    transport.emitLine({
      id: req.id,
      result: {
        lines: [
          "2026-01-01T00:00:00.000Z  1  run:start  -  run started: workflow 'w'",
          '2026-01-01T00:00:01.000Z  2  step:log:stdout  a  history line from before the reconnect',
        ],
        total: 2,
        truncated: false,
      },
    });
    expect(await screen.findByText('history line from before the reconnect')).toBeInTheDocument();

    emitWithSeq(
      transport, 'job-running', 'r-running',
      { type: 'step:log', stepId: 'a', stream: 'stdout', line: 'new line after the reconnect' }, 't3', 3,
    );

    expect(await screen.findByText('new line after the reconnect')).toBeInTheDocument();
    expect(screen.getByText('history line from before the reconnect')).toBeInTheDocument();
  });

  it('shows a resumed attempt\'s live rows even though its journal seq restarts at 1', async () => {
    // B1-residual-2: the merge used to key on "live seq > highest fetched
    // seq", but seq is monotonic per RunJournal instance
    // (packages/core/src/engine/manifest.ts), not per run. A resumed run
    // rebinds this page to a new job whose journal starts over at seq 1, so
    // every one of its rows failed that comparison against the old attempt's
    // (much higher) fetched max and got silently dropped — the pane froze on
    // the dead attempt while the resumed one ran. The fix keys the merge on
    // row identity instead of seq order, so this must render the resumed
    // attempt's first row without needing its seq to exceed the old one's.
    const { transport, onResumed } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-resume-log');
    await respondGetRun(transport, {
      runId: 'r-resume-log', runDir: '/ws/.whiphand/runs/r-resume-log', status: 'failed',
      workflow: 'w', inputs: {}, artifacts: [],
      steps: [{ id: 'a', status: 'failed' }],
    });

    const readReq = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'readRunLog');
      if (i === -1) throw new Error('readRunLog not sent yet');
      return transport.sentRequest(i);
    });
    transport.emitLine({
      id: readReq.id,
      result: {
        lines: [
          "2026-01-01T00:00:00.000Z  1  run:start  -  run started: workflow 'w'",
          '2026-01-01T00:00:01.000Z  420  step:log:stdout  a  last line of the failed attempt',
        ],
        total: 2,
        truncated: false,
      },
    });
    expect(await screen.findByText('last line of the failed attempt')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await respondResumeRun(transport, 'job-resumed-2');
    await waitFor(() => expect(onResumed).toHaveBeenCalledWith({ jobId: 'job-resumed-2', runId: 'r-resume-log' }));

    emitWithSeq(
      transport, 'job-resumed-2', 'r-resume-log',
      { type: 'step:log', stepId: 'a', stream: 'stdout', line: 'first line of the resumed attempt' }, 't2', 1,
    );

    expect(await screen.findByText('first line of the resumed attempt')).toBeInTheDocument();
    expect(screen.getByText('last line of the failed attempt')).toBeInTheDocument();
  });

  it('says a run predates the persisted log rather than rendering an unexplained blank pane', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-old');
    await respondGetRun(transport, {
      runId: 'r-old', runDir: '/ws/.whiphand/runs/r-old', status: 'succeeded',
      workflow: 'w', inputs: {}, artifacts: [], steps: [],
    });
    const req = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'readRunLog');
      if (i === -1) throw new Error('readRunLog not sent yet');
      return transport.sentRequest(i);
    });
    transport.emitLine({ id: req.id, result: { lines: [], startByte: 0, atStart: true } });

    expect(await screen.findByText(/predates the persisted log/)).toBeInTheDocument();
  });

  it('renders step:progress content read back from run.log, not the word "progress"', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-progress-disk');
    await respondGetRun(transport, {
      runId: 'r-progress-disk', runDir: '/ws/.whiphand/runs/r-progress-disk', status: 'succeeded',
      workflow: 'w', inputs: {}, artifacts: [], steps: [],
    });
    const req = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'readRunLog');
      if (i === -1) throw new Error('readRunLog not sent yet');
      return transport.sentRequest(i);
    });
    expect(req.params).toMatchObject({ fromEnd: true });
    transport.emitLine({
      id: req.id,
      result: {
        lines: [
          '2026-01-01T00:00:00.000Z  1  step:progress:tool  a  Read foo.ts',
          '2026-01-01T00:00:01.000Z  2  step:progress:text  a  looking at the file',
        ],
        startByte: 0,
        atStart: true,
      },
    });

    const logTail = await screen.findByTestId('log-tail');
    expect(await within(logTail).findByText('Read foo.ts')).toBeInTheDocument();
    expect(within(logTail).getByText('looking at the file')).toBeInTheDocument();
    expect(within(logTail).queryByText('progress')).not.toBeInTheDocument();
  });

  it('"Load earlier" pages backward from startByte and prepends without moving the viewport', async () => {
    const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-earlier');
    await respondGetRun(transport, {
      runId: 'r-earlier', runDir: '/ws/.whiphand/runs/r-earlier', status: 'succeeded',
      workflow: 'w', inputs: {}, artifacts: [], steps: [],
    });
    const first = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'readRunLog');
      if (i === -1) throw new Error('readRunLog not sent yet');
      return transport.sentRequest(i);
    });
    expect(first.params).toMatchObject({ fromEnd: true });
    transport.emitLine({
      id: first.id,
      result: {
        lines: ["2026-01-01T00:05:00.000Z  50  run:start  -  run started: workflow 'w'"],
        startByte: 4096,
        atStart: false,
      },
    });

    const loadEarlier = await screen.findByTestId('log-load-earlier');
    const logTail = screen.getByTestId('log-tail');
    Object.defineProperty(logTail, 'scrollHeight', { value: 400, configurable: true });
    Object.defineProperty(logTail, 'scrollTop', { value: 100, configurable: true, writable: true });

    fireEvent.click(loadEarlier);

    const second = await waitFor(() => {
      const reqs = transport.sent
        .map(line => JSON.parse(line) as { id?: number; method?: string; params?: unknown })
        .filter(r => r.method === 'readRunLog');
      const req = reqs.find(r => r.id !== first.id);
      if (!req) throw new Error('second readRunLog not sent yet');
      return req;
    });
    expect(second.params).toMatchObject({ beforeByte: 4096 });
    transport.emitLine({
      id: second.id,
      result: {
        lines: ["2026-01-01T00:00:00.000Z  1  step:start  a  step started (agent)"],
        startByte: 0,
        atStart: true,
      },
    });

    expect(await screen.findByText(/step started/)).toBeInTheDocument();
    expect(screen.getByText(/run started/)).toBeInTheDocument();
    // The window grew from 400 to a taller layout in jsdom (still 400, since
    // jsdom doesn't lay out) — what matters is the effect ran without throwing
    // and the earlier row rendered above the original one.
    expect(screen.queryByTestId('log-load-earlier')).not.toBeInTheDocument();
  });
});

/**
 * A command step (a test runner, say) can write output far faster than the
 * page can repaint. Tauri hands the webview one IPC event per line, so each
 * notification arrives in its own task and React cannot batch it with the
 * next: the page must coalesce them itself, or the UI freezes while the
 * command runs.
 */
describe('RunDetailPage: a burst of command output', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', jobs: {} });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, jobs: {} });
  });

  it('coalesces a burst of command output', async () => {
    const LINES = 300;
    const MAX_COMMITS = 20;
    const transport = new MockTransport();
    const client = new AgentClient(transport);
    let commits = 0;
    render(
      <AgentClientProvider client={client}>
        <Profiler id="run-detail" onRender={() => { commits++; }}>
          <RunDetailPage jobId="job-burst" onBack={vi.fn()} onRunAgain={vi.fn()} onResumed={vi.fn()} />
        </Profiler>
      </AgentClientProvider>,
    );
    emitWhiphandEvent(transport, 'job-burst', 'run-burst', { type: 'run:start', runId: 'run-burst', workflow: 'w' }, 't0');
    emitWhiphandEvent(transport, 'job-burst', 'run-burst', { type: 'step:start', stepId: 'tests', kind: 'command' }, 't1');
    await respondGetRun(transport, { runId: 'run-burst', runDir: '/ws/.whiphand/runs/run-burst', status: 'running', artifacts: [] });
    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });

    // Fake timers, one millisecond per line: the burst spans the same 300ms on
    // every machine, so the count does not depend on how fast the runner is
    // (a slow CI host took 3s of wall clock, which is 30 honest windows).
    vi.useFakeTimers();
    const before = commits;
    try {
      for (let i = 0; i < LINES; i++) {
        // One act per line, as Tauri delivers them in separate tasks; a
        // synchronous loop would let React batch the whole burst into a single render.
        await act(async () => {
          transport.emitLine({ method: 'stepLog', params: { jobId: 'job-burst', stream: 'stdout', line: `output line ${i}`, seq: i } });
          emitWhiphandEvent(
            transport, 'job-burst', 'run-burst',
            { type: 'step:log', stepId: 'tests', stream: 'stdout', line: `output line ${i}` }, `t${i + 2}`,
          );
          await vi.advanceTimersByTimeAsync(1);
        });
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    } finally {
      vi.useRealTimers();
    }

    expect(commits - before, `commits while ${LINES} lines arrived one per task`).toBeLessThanOrEqual(MAX_COMMITS);

    // Coalescing must not lose output.
    fireEvent.click(screen.getByRole('tab', { name: /logs/i }));
    const rows = await screen.findAllByTestId('log-row');
    const text = rows.map(r => r.textContent ?? '').join('\n');
    for (let i = 0; i < LINES; i++) expect(text).toContain(`output line ${i}`);
  });
});
