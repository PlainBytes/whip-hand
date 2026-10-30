import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../agent/client.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { MockTransport } from '../agent/transport.ts';
import { useAppStore } from '../state/store.ts';
import { DeleteRunDialog } from './DeleteRunDialog.tsx';

const worktree = (path: string) => ({ path, branch: 'whiphand/x' });

type Reply = Awaited<ReturnType<AgentClient['request']>> | Error | 'hang';

/** Scripts the deleteRun replies in order; the client's own `hello` handshake is answered with nothing and not counted. */
function scriptDeleteRun(client: AgentClient, ...replies: Reply[]) {
  const calls: unknown[] = [];
  const queue = [...replies];
  vi.spyOn(client, 'request').mockImplementation(((method: string, params: unknown) => {
    if (method !== 'deleteRun') return new Promise(() => {});
    calls.push(params);
    const next = queue.shift();
    if (next === 'hang') return new Promise(() => {});
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }) as AgentClient['request']);
  return { calls, queue };
}

function renderDialog(worktreePath?: string) {
  const client = new AgentClient(new MockTransport());
  const onDeleted = vi.fn();
  const onDismiss = vi.fn();
  render(
    <AgentClientProvider client={client}>
      <DeleteRunDialog
        workdir="/ws" runId="r1" onDeleted={onDeleted} onDismiss={onDismiss}
        {...(worktreePath === undefined ? {} : { worktreePath })}
      />
    </AgentClientProvider>,
  );
  return { client, onDeleted, onDismiss };
}

describe('DeleteRunDialog', () => {
  afterEach(() => useAppStore.setState({ runs: [] }));

  it('says the worktree is kept while another listed run shares it', () => {
    useAppStore.setState({
      runs: [
        { runId: 'r1', runDir: '/r1', status: 'succeeded', worktree: worktree('.whiphand/worktrees/a') },
        { runId: 'r2', runDir: '/r2', status: 'succeeded', name: 'second', worktree: worktree('.whiphand/worktrees/a') },
      ],
    });
    renderDialog('.whiphand/worktrees/a');
    expect(screen.getByTestId('delete-worktree-kept')).toHaveTextContent('kept because run second still uses it');
  });

  it('says nothing about a worktree no other run uses', () => {
    useAppStore.setState({
      runs: [
        { runId: 'r1', runDir: '/r1', status: 'succeeded', worktree: worktree('.whiphand/worktrees/a') },
        { runId: 'r2', runDir: '/r2', status: 'succeeded', worktree: worktree('.whiphand/worktrees/b') },
      ],
    });
    renderDialog('.whiphand/worktrees/a');
    expect(screen.queryByTestId('delete-worktree-kept')).not.toBeInTheDocument();
  });

  describe('dirty worktree', () => {
    const dirty = { deleted: false, reason: 'worktree-dirty' } as const;

    async function reachDiscardState(...then: Reply[]) {
      const view = renderDialog();
      const script = scriptDeleteRun(view.client, dirty, ...then);
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      await screen.findByRole('button', { name: 'Discard changes and delete' });
      return { ...view, ...script };
    }

    it('asks to discard instead of showing an error, without deleting', async () => {
      const { calls, onDeleted } = await reachDiscardState();
      expect(calls).toEqual([{ workdir: '/ws', runId: 'r1' }]);
      expect(screen.getByTestId('delete-discard-warning')).toHaveTextContent('discard them');
      expect(screen.getByTestId('delete-discard-warning')).toHaveTextContent('branch is kept');
      expect(screen.queryByText(/whiphand worktree remove/)).not.toBeInTheDocument();
      expect(screen.queryByText(/uncommitted changes\.$/)).not.toBeInTheDocument();
      expect(onDeleted).not.toHaveBeenCalled();
    });

    it('confirming sends force: true once and reports the deletion', async () => {
      const { calls, onDeleted } = await reachDiscardState({ deleted: true });
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes and delete' }));
      await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
      expect(calls).toEqual([{ workdir: '/ws', runId: 'r1' }, { workdir: '/ws', runId: 'r1', force: true }]);
    });

    it('Cancel dismisses without a second request', async () => {
      const { calls, onDismiss, onDeleted } = await reachDiscardState();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
      expect(onDeleted).not.toHaveBeenCalled();
    });

    it('cannot be dismissed while the forced request is in flight', async () => {
      const { calls, onDismiss } = await reachDiscardState('hang');
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes and delete' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(onDismiss).not.toHaveBeenCalled();
      expect(calls).toHaveLength(2);
    });

    it('shows an error from the forced request', async () => {
      const { onDeleted } = await reachDiscardState({ deleted: false, reason: 'locked' });
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes and delete' }));
      expect(await screen.findByText('This run is locked.')).toBeInTheDocument();
      expect(onDeleted).not.toHaveBeenCalled();
    });

    it('shows a thrown RPC from the forced request', async () => {
      await reachDiscardState(new Error('boom'));
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes and delete' }));
      expect(await screen.findByText(/boom/)).toBeInTheDocument();
    });
  });

  it('a clean delete sends no force and reports the deletion', async () => {
    const { client, onDeleted } = renderDialog();
    const { calls } = scriptDeleteRun(client, { deleted: true });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([{ workdir: '/ws', runId: 'r1' }]);
  });
});
