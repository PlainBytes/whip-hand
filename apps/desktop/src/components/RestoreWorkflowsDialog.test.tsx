import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../agent/client.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { MockTransport } from '../agent/transport.ts';
import type { Scope } from '../shared/types.ts';
import type { ShippedWorkflowEntry } from '../shared/protocol.gen.ts';
import { RestoreWorkflowsDialog } from './RestoreWorkflowsDialog.tsx';

const SHIPPED: ShippedWorkflowEntry[] = [
  { name: 'feature', description: 'Plan, build and review a feature', status: 'missing' },
  { name: 'bugfix', description: 'Find and fix a bug', status: 'stock' },
  { name: 'iterate', description: 'Iterate on a change', status: 'modified' },
];

interface Call { method: string; params: unknown }

/**
 * Answers listShippedWorkflows per scope from `lists` (an Error rejects), and
 * restoreWorkflows with `restoreReply`. Every call is recorded.
 */
function mockClient(
  client: AgentClient,
  lists: Partial<Record<Scope, ShippedWorkflowEntry[] | Error>>,
  restoreReply: unknown = { results: [] },
) {
  const calls: Call[] = [];
  vi.spyOn(client, 'request').mockImplementation(((method: string, params: { scope: Scope }) => {
    if (method === 'listShippedWorkflows') {
      calls.push({ method, params });
      const reply = lists[params.scope] ?? [];
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve({ workflows: reply });
    }
    if (method === 'restoreWorkflows') {
      calls.push({ method, params });
      return restoreReply instanceof Error ? Promise.reject(restoreReply) : Promise.resolve(restoreReply);
    }
    return new Promise(() => {});
  }) as AgentClient['request']);
  return calls;
}

function renderDialog(
  lists: Partial<Record<Scope, ShippedWorkflowEntry[] | Error>>,
  options: { defaultScope?: Scope; restoreReply?: unknown } = {},
) {
  const client = new AgentClient(new MockTransport());
  const calls = mockClient(client, lists, options.restoreReply);
  const onRestored = vi.fn();
  const onDismiss = vi.fn();
  render(
    <AgentClientProvider client={client}>
      <RestoreWorkflowsDialog
        workdir="/ws"
        defaultScope={options.defaultScope ?? 'project'}
        onRestored={onRestored}
        onDismiss={onDismiss}
      />
    </AgentClientProvider>,
  );
  return { calls, onRestored, onDismiss };
}

const restores = (calls: Call[]) => calls.filter(c => c.method === 'restoreWorkflows');

describe('RestoreWorkflowsDialog', () => {
  it('lists each template with its status and ticks only the missing ones', async () => {
    const { calls } = renderDialog({ project: SHIPPED });
    const feature = await screen.findByRole('checkbox', { name: 'feature' });
    expect(calls[0]).toEqual({ method: 'listShippedWorkflows', params: { workdir: '/ws', scope: 'project' } });
    expect(screen.getByText('Plan, build and review a feature')).toBeInTheDocument();
    expect(screen.getByText('Missing')).toBeInTheDocument();
    expect(screen.getByText('Up to date')).toBeInTheDocument();
    expect(screen.getByText('Modified')).toBeInTheDocument();

    expect(feature).toBeChecked();
    expect(feature).toBeEnabled();
    const bugfix = screen.getByRole('checkbox', { name: 'bugfix' });
    expect(bugfix).not.toBeChecked();
    expect(bugfix).toBeDisabled();
    const iterate = screen.getByRole('checkbox', { name: 'iterate' });
    expect(iterate).not.toBeChecked();
    expect(iterate).toBeEnabled();
    expect(screen.queryByText('Will be replaced')).not.toBeInTheDocument();

    fireEvent.click(iterate);
    expect(screen.getByText('Will be replaced')).toBeInTheDocument();
  });

  it('restoring missing-only sends the names and an empty replace, then reports success', async () => {
    const { calls, onRestored } = renderDialog({ project: SHIPPED });
    await screen.findByRole('checkbox', { name: 'feature' });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(restores(calls)).toEqual([{
      method: 'restoreWorkflows',
      params: { workdir: '/ws', scope: 'project', names: ['feature'], replace: [] },
    }]);
  });

  it('ticking a modified one confirms by name before sending, and Back sends nothing', async () => {
    const { calls, onRestored } = renderDialog({ project: SHIPPED });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'iterate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    expect(await screen.findByTestId('restore-confirmation')).toHaveTextContent("Your changes to 'iterate' will be lost");
    expect(restores(calls)).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('checkbox', { name: 'iterate' })).toBeChecked();
    expect(restores(calls)).toEqual([]);
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('accepting the confirmation sends the modified one in replace', async () => {
    const { calls, onRestored } = renderDialog({ project: SHIPPED });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'iterate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace and restore' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(restores(calls)[0]?.params).toEqual({
      workdir: '/ws', scope: 'project', names: ['feature', 'iterate'], replace: ['iterate'],
    });
  });

  it('a global replace says every workspace reads it', async () => {
    renderDialog({ global: SHIPPED }, { defaultScope: 'global' });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'iterate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByTestId('restore-confirmation')).toHaveTextContent(/every workspace on this machine/);
  });

  it('changing the scope re-queries the list and resets the ticks', async () => {
    const { calls } = renderDialog({
      project: SHIPPED,
      workspace: [{ name: 'feature', description: 'Plan, build and review a feature', status: 'stock' }],
    });
    await screen.findByRole('checkbox', { name: 'iterate' });
    fireEvent.click(screen.getByRole('radio', { name: /workspace \(my user folder\)/i }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'iterate' })).not.toBeInTheDocument());
    expect(await screen.findByRole('checkbox', { name: 'feature' })).not.toBeChecked();
    expect(calls.filter(c => c.method === 'listShippedWorkflows').map(c => c.params)).toEqual([
      { workdir: '/ws', scope: 'project' },
      { workdir: '/ws', scope: 'workspace' },
    ]);
    // Nothing ticked, nothing to restore.
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
  });

  it('opens on the scope it is given', async () => {
    const { calls } = renderDialog({ workspace: SHIPPED }, { defaultScope: 'workspace' });
    await screen.findByRole('checkbox', { name: 'feature' });
    expect(screen.getByRole('radio', { name: /workspace \(my user folder\)/i })).toBeChecked();
    expect(calls[0]?.params).toEqual({ workdir: '/ws', scope: 'workspace' });
  });

  it('an agent error on restore shows in the dialog and keeps it open', async () => {
    const { onRestored, onDismiss } = renderDialog(
      { project: SHIPPED },
      { restoreReply: new Error('permission denied') },
    );
    await screen.findByRole('checkbox', { name: 'feature' });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(onRestored).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('an agent error on listing shows in the dialog', async () => {
    renderDialog({ project: new Error('not a workspace') });
    expect(await screen.findByText(/not a workspace/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
  });
});
