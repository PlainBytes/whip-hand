import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../agent/client.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { MockTransport } from '../agent/transport.ts';
import { useAppStore } from '../state/store.ts';
import { DeleteRunDialog } from './DeleteRunDialog.tsx';

const worktree = (path: string) => ({ path, branch: 'whiphand/x' });

function renderDialog(worktreePath?: string) {
  const client = new AgentClient(new MockTransport());
  render(
    <AgentClientProvider client={client}>
      <DeleteRunDialog
        workdir="/ws" runId="r1" onDeleted={vi.fn()} onDismiss={vi.fn()}
        {...(worktreePath === undefined ? {} : { worktreePath })}
      />
    </AgentClientProvider>,
  );
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
});
