import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { NotificationBridge } from './NotificationBridge.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';

function renderBridge(focused: boolean, minIntervalMs = 0) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  const notifier = vi.fn();
  render(
    <AgentClientProvider client={client}>
      <NotificationBridge
        notifier={notifier}
        isWindowFocused={() => focused}
        minIntervalMs={minIntervalMs}
      />
    </AgentClientProvider>,
  );
  return { transport, notifier };
}

const awaitLine = (jobId: string, reason?: string) => ({
  method: 'ptyAwait',
  params: { jobId, stepId: 'plan', awaiting: reason !== undefined, reason },
});

describe('NotificationBridge', () => {
  it('notifies on run success and failure when unfocused', () => {
    const { transport, notifier } = renderBridge(false);
    transport.emitLine({ method: 'runStateChanged', params: { jobId: 'j1', runId: 'r1', status: 'succeeded' } });
    transport.emitLine({ method: 'runStateChanged', params: { jobId: 'j2', status: 'failed' } });
    expect(notifier).toHaveBeenCalledWith('Run succeeded', 'r1');
    expect(notifier).toHaveBeenCalledWith('Run failed', 'j2');
  });

  it('says nothing merely because a session opened', () => {
    // ptyStarted fires before the model has said a word. Treating it as "needs
    // your input" was the false signal ptyAwait replaces.
    const { transport, notifier } = renderBridge(false);
    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'j3', stepId: 'plan', cols: 80, rows: 24 } });
    expect(notifier).not.toHaveBeenCalled();
  });

  it('notifies when the session is actually blocked on the human', () => {
    const { transport, notifier } = renderBridge(false);
    transport.emitLine(awaitLine('j1', 'permission'));
    transport.emitLine(awaitLine('j2', 'away'));
    transport.emitLine(awaitLine('j3', 'attention'));
    expect(notifier).toHaveBeenCalledWith('Permission needed', 'Step plan');
    expect(notifier).toHaveBeenCalledWith('Waiting for you', 'Step plan');
    expect(notifier).toHaveBeenCalledWith('Session needs attention', 'Step plan');
  });

  it('stays quiet for a plain turn end, which is just the conversation resting', () => {
    // The product decision this test documents: turn-end is the normal state of
    // an interactive session, so it is an indicator only, never an interruption.
    const { transport, notifier } = renderBridge(false);
    transport.emitLine(awaitLine('j1', 'turn'));
    expect(notifier).not.toHaveBeenCalled();
  });

  it('says nothing when the session goes back to working', () => {
    const { transport, notifier } = renderBridge(false);
    transport.emitLine(awaitLine('j1'));
    expect(notifier).not.toHaveBeenCalled();
  });

  it('throttles repeats of the same reason for the same job', () => {
    const { transport, notifier } = renderBridge(false, 30_000);
    transport.emitLine(awaitLine('j1', 'permission'));
    transport.emitLine(awaitLine('j1', 'permission'));
    expect(notifier).toHaveBeenCalledTimes(1);

    // A different job, and a different reason, are each their own signal.
    transport.emitLine(awaitLine('j2', 'permission'));
    transport.emitLine(awaitLine('j1', 'away'));
    expect(notifier).toHaveBeenCalledTimes(3);
  });

  it('stays silent while focused, on running status, and on cancellation', () => {
    const { transport, notifier } = renderBridge(true);
    transport.emitLine({ method: 'runStateChanged', params: { jobId: 'j1', status: 'succeeded' } });
    transport.emitLine(awaitLine('j1', 'permission'));
    expect(notifier).not.toHaveBeenCalled();

    const unfocused = renderBridge(false);
    unfocused.transport.emitLine({ method: 'runStateChanged', params: { jobId: 'j1', status: 'running' } });
    unfocused.transport.emitLine({ method: 'runStateChanged', params: { jobId: 'j1', status: 'cancelled' } });
    expect(unfocused.notifier).not.toHaveBeenCalled();
  });
});

describe('NotificationBridge: manual steps', () => {
  const manualLine = (jobId: string, kind: 'manual' | 'approval', title: string) => ({
    method: 'manualRequest',
    params: {
      jobId,
      request: {
        stepId: 'sign', kind, title, instructions: 'Look.',
        choices: ['continue', 'abort'], context: { artifacts: [] }, defaultChoice: 'continue',
      },
    },
  });

  it('interrupts for a parked approval — the run cannot continue without one', () => {
    const { transport, notifier } = renderBridge(false);
    transport.emitLine(manualLine('j-a', 'approval', 'Ship it?'));
    expect(notifier).toHaveBeenCalledWith('Decision needed', 'Ship it?');
  });

  it('says which stage a gate inside a stage belongs to, keeping the title stable for OS grouping', () => {
    const { transport, notifier } = renderBridge(false);
    const line = manualLine('j-s', 'approval', 'Accept this stage?');
    transport.emitLine({
      ...line,
      params: {
        ...line.params,
        request: {
          ...line.params.request,
          stage: { stagesId: 'build', id: '03-c', title: 'Add API routes', index: 3, total: 7, attempt: 1 },
        },
      },
    });
    expect(notifier).toHaveBeenCalledWith('Decision needed', 'Stage 3 of 7: Add API routes');
  });

  it('distinguishes a plain manual step from an approval', () => {
    const { transport, notifier } = renderBridge(false);
    transport.emitLine(manualLine('j-b', 'manual', 'Release note'));
    expect(notifier).toHaveBeenCalledWith('Your turn', 'Release note');
  });

  it('stays quiet while the window is focused — you can already see the card', () => {
    const { transport, notifier } = renderBridge(true);
    transport.emitLine(manualLine('j-c', 'approval', 'Ship it?'));
    expect(notifier).not.toHaveBeenCalled();
  });
});
