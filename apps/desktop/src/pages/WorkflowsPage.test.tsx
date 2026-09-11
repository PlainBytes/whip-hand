import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkflowsPage } from './WorkflowsPage.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';

const FEATURE_WORKFLOW = {
  name: 'feature',
  path: '/ws/.whiphand/workflows/feature.yaml',
  source: 'project' as const,
  workflow: {
    name: 'feature',
    inputs: { feature: { required: true, prompt: 'What are we building?' } },
    steps: [
      { id: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' },
      { id: 'execute', kind: 'agent', runner: 'claude', mode: 'headless', writes: true, prompt: 'p', output: 'execute-report.md' },
      {
        id: 'review', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, verdict: true, prompt: 'p', output: 'review.md',
      },
    ],
  },
};

// respond() resolves the FIRST not-yet-answered request matching `method` —
// WorkflowsPage's setup-workspace flow triggers a second listWorkflows call to
// refresh the list after initWorkspace succeeds, so a naive "first match by
// method name" helper would resolve the *first* listWorkflows call twice
// instead of answering the second one. Track which sent indices have already
// been resolved and skip them.
function respondFactory() {
  const answered = new Set<number>();
  return async function respond(transport: MockTransport, method: string, result: unknown) {
    const index = await waitFor(() => {
      const i = transport.sent.findIndex((line, idx) => {
        if (answered.has(idx)) return false;
        return (JSON.parse(line) as { method: string }).method === method;
      });
      if (i === -1) throw new Error(`${method} not sent yet`);
      return i;
    });
    answered.add(index);
    const req = transport.sentRequest(index);
    transport.emitLine({ id: req.id, result });
  };
}

function renderWorkflowsPage() {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  const onRunWorkflow = vi.fn();
  render(
    <AgentClientProvider client={client}>
      <WorkflowsPage onRunWorkflow={onRunWorkflow} />
    </AgentClientProvider>,
  );
  return { transport, client, onRunWorkflow };
}

describe('WorkflowsPage', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [] });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [] });
  });

  it('offers workspace setup when the workspace has no workflows', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', []);
    fireEvent.click(await screen.findByRole('button', { name: /set up this workspace/i }));
    await respond(transport, 'initWorkspace', { created: ['.whiphand/config.yaml', '.whiphand/workflows/feature.yaml'] });
    // page refreshes the list afterwards — answer the SECOND listWorkflows request
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    expect(await screen.findByText('feature', { exact: false })).toBeInTheDocument();
  });

  it('creates a workflow through the New workflow dialog', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    fireEvent.click(screen.getByRole('button', { name: /new workflow/i }));
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'review-pr' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'createWorkflow') throw new Error('createWorkflow not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({ workdir: '/ws', name: 'review-pr' });
  });

  it("shows each workflow's steps on its card without any interaction", async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    expect(await screen.findByText('feature')).toBeInTheDocument();
    for (const stepId of ['plan', 'execute', 'review']) {
      expect(screen.getByText(stepId)).toBeInTheDocument();
    }
  });

  it('Run on a card asks to start that workflow', async () => {
    const respond = respondFactory();
    const { transport, onRunWorkflow } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    fireEvent.click(await screen.findByRole('button', { name: /^run$/i }));
    expect(onRunWorkflow).toHaveBeenCalledWith('feature', 'project');
  });

  it('shows a shadowed global/project pair as two cards and routes Run to the right scope', async () => {
    const respond = respondFactory();
    const GLOBAL_FEATURE = {
      ...FEATURE_WORKFLOW,
      path: '/home/user/.config/whiphand/workflows/feature.yaml',
      source: 'global' as const,
      shadowed: true as const,
    };
    const { transport, onRunWorkflow } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW, GLOBAL_FEATURE]);

    expect(await screen.findByText('Global')).toBeInTheDocument();
    expect(screen.getByText(/overridden by this project/i)).toBeInTheDocument();
    const runButtons = screen.getAllByRole('button', { name: /^run$/i });
    expect(runButtons).toHaveLength(2);

    fireEvent.click(runButtons[0]);
    expect(onRunWorkflow).toHaveBeenLastCalledWith('feature', 'project');
    fireEvent.click(runButtons[1]);
    expect(onRunWorkflow).toHaveBeenLastCalledWith('feature', 'global');
  });

  it('creating a global workflow sends scope: global', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    fireEvent.click(screen.getByRole('button', { name: /new workflow/i }));
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'shared-thing' } });
    fireEvent.click(screen.getByRole('radio', { name: /global/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const req = await lastRequest(transport, 'createWorkflow');
    expect(req.params).toEqual({ workdir: '/ws', name: 'shared-thing', scope: 'global' });
  });

  it('an uninitialized workspace still shows a global workflow next to the setup CTA', async () => {
    const respond = respondFactory();
    const GLOBAL_ONLY = { ...FEATURE_WORKFLOW, source: 'global' as const };
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [GLOBAL_ONLY]);
    expect(await screen.findByRole('button', { name: /set up this workspace/i })).toBeInTheDocument();
    expect(screen.getByText('feature')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^run$/i })).toBeInTheDocument();
  });
});


async function lastRequest(transport: MockTransport, method: string) {
  return waitFor(() => {
    const parsed = transport.sentRequest(transport.sent.length - 1);
    if (parsed.method !== method) throw new Error(`${method} not sent yet`);
    return parsed;
  });
}

/**
 * The editor's own behaviour (collapse, disable, insert, rename, save
 * round-trip...) is exercised in workflow-editor/WorkflowEditor.test.tsx —
 * this only proves the page delegates to it correctly: Edit opens it seeded
 * with the right entry, Cancel and a successful save both return to the list.
 */
describe('WorkflowsPage - delegating to the editor', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [] });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [] });
  });

  it('Edit opens the workflow editor, seeded with the entry\'s steps', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));

    expect(await screen.findByText(/edit workflow: feature/i)).toBeInTheDocument();
    for (const stepId of ['plan', 'execute', 'review']) {
      expect(screen.getByTestId(`step-card-${stepId}`)).toBeInTheDocument();
    }
  });

  it('Cancel returns to the list without sending anything', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await screen.findByText(/edit workflow: feature/i);

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(await screen.findByRole('button', { name: /new workflow/i })).toBeInTheDocument();
    expect(transport.sent.some(line => (JSON.parse(line) as { method: string }).method === 'updateWorkflow')).toBe(false);
  });

  it('a successful save returns to the list and reloads it', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await screen.findByText(/edit workflow: feature/i);

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    expect(req.params).toMatchObject({ workdir: '/ws', name: 'feature' });

    await respond(transport, 'updateWorkflow', { path: '/ws/.whiphand/workflows/feature.yaml' });
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    expect(await screen.findByRole('button', { name: /new workflow/i })).toBeInTheDocument();
  });

  it('editing a global entry requires confirmation, and sends scope: global once confirmed', async () => {
    const respond = respondFactory();
    const GLOBAL_FEATURE = { ...FEATURE_WORKFLOW, source: 'global' as const, path: '/home/user/.config/whiphand/workflows/feature.yaml' };
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [GLOBAL_FEATURE]);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await screen.findByText(/edit workflow: feature/i);

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/every workspace on this machine reads it/i)).toBeInTheDocument();
    expect(transport.sent.some(line => (JSON.parse(line) as { method: string }).method === 'updateWorkflow')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /save anyway/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    expect(req.params).toMatchObject({ workdir: '/ws', name: 'feature', scope: 'global' });
  });
});
