import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fireEvent, render, screen, waitFor, within,
} from '@testing-library/react';
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
    expect(await screen.findByText('feature')).toBeInTheDocument();
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

  it('New workflow flags an invalid or taken name and disables Create, but only warns across scopes', async () => {
    const respond = respondFactory();
    const GLOBAL_OTHER = {
      ...FEATURE_WORKFLOW, name: 'other-flow', source: 'global' as const,
      path: '/home/user/.config/whiphand/workflows/other-flow.yaml',
    };
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW, GLOBAL_OTHER]);
    fireEvent.click(screen.getByRole('button', { name: /new workflow/i }));
    const nameField = await screen.findByLabelText(/name/i);
    const createButton = () => within(screen.getByRole('dialog')).getByRole('button', { name: 'Create' });

    // Empty is not yet an error, just not submittable.
    expect(screen.queryByText(/use lowercase letters/i)).not.toBeInTheDocument();
    expect(createButton()).toBeDisabled();

    fireEvent.change(nameField, { target: { value: 'Bad Name!' } });
    expect(await screen.findByText(/use lowercase letters, digits, - and _/i)).toBeInTheDocument();
    expect(createButton()).toBeDisabled();

    fireEvent.change(nameField, { target: { value: 'feature' } });
    expect(await screen.findByText('A workflow named feature already exists')).toBeInTheDocument();
    expect(createButton()).toBeDisabled();

    // Switching scope re-asks the question: no global 'feature' exists.
    fireEvent.click(screen.getByRole('radio', { name: /global/i }));
    expect(await screen.findByText('Hidden in this workspace by the project workflow feature')).toBeInTheDocument();
    expect(createButton()).toBeEnabled();

    fireEvent.click(screen.getByRole('radio', { name: /this workspace/i }));
    fireEvent.change(nameField, { target: { value: 'other-flow' } });
    expect(await screen.findByText('Will override the global workflow other-flow in this workspace')).toBeInTheDocument();
    expect(createButton()).toBeEnabled();
    expect(sentMethods(transport)).not.toContain('createWorkflow');
  });

  it('New workflow cannot be dismissed while createWorkflow is in flight, and shows an RPC error', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    fireEvent.click(screen.getByRole('button', { name: /new workflow/i }));
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'review-pr' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create' }));
    const req = await lastRequest(transport, 'createWorkflow');

    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    transport.emitLine({ id: req.id, error: { code: -32000, message: "workflow 'review-pr' already exists" } });
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('New workflow is unmounted while closed, so reopening starts from a clean form', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /new workflow/i }));
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'half-typed' } });
    fireEvent.click(screen.getByRole('radio', { name: /global/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new workflow/i }));
    expect(await screen.findByLabelText(/name/i)).toHaveValue('');
    expect(screen.getByRole('radio', { name: /this workspace/i })).toBeChecked();
  });

  it('a successful create closes the dialog and reloads the list', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    fireEvent.click(screen.getByRole('button', { name: /new workflow/i }));
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'review-pr' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create' }));

    await respond(transport, 'createWorkflow', { path: '/ws/.whiphand/workflows/review-pr.yaml' });
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
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

/** The Fluent Dialog surface — used to scope a query to the confirm dialog's own "Delete"/"Clone" button, since the triggering lane button shares the same accessible name. */
function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

/** Clicks a lane's visible Delete button. With one lane on screen there is exactly one. */
async function clickLaneDelete(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
}

function sentMethods(transport: MockTransport): string[] {
  return transport.sent.map(line => (JSON.parse(line) as { method: string }).method);
}

describe('WorkflowsPage - deleting a workflow', () => {
  const GLOBAL_FEATURE = {
    ...FEATURE_WORKFLOW,
    path: '/home/user/.config/whiphand/workflows/feature.yaml',
    source: 'global' as const,
  };

  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [] });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [] });
  });

  it('card Delete confirms, sends deleteWorkflow without a scope for a project workflow, and reloads the list', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    await clickLaneDelete();

    expect(await screen.findByText("Delete workflow 'feature'?")).toBeInTheDocument();
    expect(screen.getByText(/this deletes its file\. this cannot be undone\. past runs keep their own copy\./i))
      .toBeInTheDocument();
    expect(screen.queryByText(/will be used in this workspace instead/i)).not.toBeInTheDocument();

    fireEvent.click(within(dialog()).getByRole('button', { name: /^delete$/i }));
    const req = await lastRequest(transport, 'deleteWorkflow');
    expect(req.params).toEqual({ workdir: '/ws', name: 'feature' });

    await respond(transport, 'deleteWorkflow', { deleted: true });
    await respond(transport, 'listWorkflows', []);
    await waitFor(() => expect(screen.queryByText("Delete workflow 'feature'?")).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('a global workflow gets the every-workspace wording and sends scope: global', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [GLOBAL_FEATURE]);
    await clickLaneDelete();

    expect(await screen.findByText(/every workspace on this machine loses it/i)).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: /^delete$/i }));
    const req = await lastRequest(transport, 'deleteWorkflow');
    expect(req.params).toEqual({ workdir: '/ws', name: 'feature', scope: 'global' });
  });

  it('deleting a project workflow that overrides a global one says the global one takes over', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW, { ...GLOBAL_FEATURE, shadowed: true as const }]);
    const [projectDelete, globalDelete] = await screen.findAllByRole('button', { name: /^delete$/i });

    fireEvent.click(projectDelete);
    expect(await screen.findByText("The global 'feature' workflow will be used in this workspace instead."))
      .toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByText("Delete workflow 'feature'?")).not.toBeInTheDocument());

    fireEvent.click(globalDelete);
    expect(await screen.findByText(/every workspace on this machine loses it/i)).toBeInTheDocument();
    expect(screen.queryByText(/will be used in this workspace instead/i)).not.toBeInTheDocument();
  });

  it('Cancel closes the dialog without sending anything', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    await clickLaneDelete();
    await screen.findByText("Delete workflow 'feature'?");

    fireEvent.click(within(dialog()).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByText("Delete workflow 'feature'?")).not.toBeInTheDocument());
    expect(sentMethods(transport)).not.toContain('deleteWorkflow');
  });

  it('an RPC error keeps the dialog open and shows the message', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    await clickLaneDelete();
    fireEvent.click(within(dialog()).getByRole('button', { name: /^delete$/i }));

    const req = await lastRequest(transport, 'deleteWorkflow');
    transport.emitLine({ id: req.id, error: { message: 'EACCES: permission denied' } });
    expect(await screen.findByText(/permission denied/i)).toBeInTheDocument();
    expect(screen.getByText("Delete workflow 'feature'?")).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: /^delete$/i })).toBeEnabled();
    expect(sentMethods(transport).filter(m => m === 'listWorkflows')).toHaveLength(1);
  });

  it('a file that was already gone ({ deleted: false }) still closes the dialog and reloads', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    await clickLaneDelete();
    fireEvent.click(within(dialog()).getByRole('button', { name: /^delete$/i }));

    await respond(transport, 'deleteWorkflow', { deleted: false });
    await respond(transport, 'listWorkflows', []);
    await waitFor(() => expect(screen.queryByText("Delete workflow 'feature'?")).not.toBeInTheDocument());
  });

  it('editor Delete, once confirmed, sends deleteWorkflow and returns to the card grid', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await screen.findByText(/edit workflow: feature/i);

    fireEvent.click(screen.getByRole('button', { name: 'Delete feature' }));
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    const req = await lastRequest(transport, 'deleteWorkflow');
    expect(req.params).toEqual({ workdir: '/ws', name: 'feature' });

    await respond(transport, 'deleteWorkflow', { deleted: true });
    await respond(transport, 'listWorkflows', []);
    expect(await screen.findByRole('button', { name: /new workflow/i })).toBeInTheDocument();
    expect(screen.queryByText(/edit workflow: feature/i)).not.toBeInTheDocument();
  });
});

describe('WorkflowsPage - cloning a workflow', () => {
  const GLOBAL_FEATURE = {
    ...FEATURE_WORKFLOW,
    path: '/home/user/.config/whiphand/workflows/feature.yaml',
    source: 'global' as const,
  };

  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [] });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [] });
  });

  /** Clicks Clone on one specific lane — several tests here render two lanes, each with its own Clone button. */
  async function openClone(laneTestId = 'workflow-lane-project-feature'): Promise<void> {
    const lane = await screen.findByTestId(laneTestId);
    fireEvent.click(within(lane).getByRole('button', { name: /^clone$/i }));
    await screen.findByText('Clone workflow');
  }

  it('opens pre-filled with <name>-copy', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    await openClone();

    expect(await screen.findByLabelText(/name/i)).toHaveValue('feature-copy');
    expect(screen.getByText('Clones into: This workspace')).toBeInTheDocument();
  });

  it('opens pre-filled with <name>-copy-2 when <name>-copy is already taken', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    const TAKEN_COPY = { ...FEATURE_WORKFLOW, name: 'feature-copy', path: '/ws/.whiphand/workflows/feature-copy.yaml' };
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW, TAKEN_COPY]);
    await openClone();

    expect(await screen.findByLabelText(/name/i)).toHaveValue('feature-copy-2');
  });

  it('an invalid name, or one already used in the same scope, shows an error and disables Clone', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    await openClone();
    const nameField = await screen.findByLabelText(/name/i);
    const cloneButton = () => within(dialog()).getByRole('button', { name: /^clone$/i });

    fireEvent.change(nameField, { target: { value: 'Bad Name!' } });
    expect(await screen.findByText(/use lowercase letters, digits, - and _/i)).toBeInTheDocument();
    expect(cloneButton()).toBeDisabled();

    fireEvent.change(nameField, { target: { value: 'feature' } });
    expect(await screen.findByText('A workflow named feature already exists')).toBeInTheDocument();
    expect(cloneButton()).toBeDisabled();
  });

  it('a name used only in the other scope shows a warning and keeps Clone enabled', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    const GLOBAL_OTHER = { ...GLOBAL_FEATURE, name: 'other-flow', path: '/home/user/.config/whiphand/workflows/other-flow.yaml' };
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW, GLOBAL_OTHER]);
    await openClone();
    const nameField = await screen.findByLabelText(/name/i);

    fireEvent.change(nameField, { target: { value: 'other-flow' } });
    expect(await screen.findByText('Will override the global workflow other-flow in this workspace')).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: /^clone$/i })).toBeEnabled();
  });

  it('confirming a project clone sends cloneWorkflow without a scope, then reloads and closes', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    await openClone();

    fireEvent.click(within(dialog()).getByRole('button', { name: /^clone$/i }));
    const req = await lastRequest(transport, 'cloneWorkflow');
    expect(req.params).toEqual({ workdir: '/ws', name: 'feature', newName: 'feature-copy' });

    await respond(transport, 'cloneWorkflow', { path: '/ws/.whiphand/workflows/feature-copy.yaml' });
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    await waitFor(() => expect(screen.queryByText('Clone workflow')).not.toBeInTheDocument());
  });

  it('confirming a global clone sends scope: global', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [GLOBAL_FEATURE]);
    await openClone('workflow-lane-global-feature');

    fireEvent.click(within(dialog()).getByRole('button', { name: /^clone$/i }));
    const req = await lastRequest(transport, 'cloneWorkflow');
    expect(req.params).toEqual({
      workdir: '/ws', name: 'feature', newName: 'feature-copy', scope: 'global',
    });
  });

  it('an RPC error keeps the dialog open and shows the message', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    await openClone();

    fireEvent.click(within(dialog()).getByRole('button', { name: /^clone$/i }));
    const req = await lastRequest(transport, 'cloneWorkflow');
    transport.emitLine({ id: req.id, error: { message: "workflow 'feature-copy' already exists" } });
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(screen.getByText('Clone workflow')).toBeInTheDocument();
  });

  it('Cancel sends nothing', async () => {
    const respond = respondFactory();
    const { transport } = renderWorkflowsPage();
    await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
    await openClone();

    fireEvent.click(within(dialog()).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByText('Clone workflow')).not.toBeInTheDocument());
    expect(sentMethods(transport)).not.toContain('cloneWorkflow');
  });
});
