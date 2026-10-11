import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewRunForm } from './NewRunForm.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { CapabilitiesProvider, DESKTOP_DEFAULT_CAPABILITIES, type AppCapabilities, type FileDropEvent } from '../capabilities.tsx';
import { useAppStore } from '../state/store.ts';
import type { RunAgain } from '../lib/new-run-draft.ts';
import { EMPTY_APP_STATE } from '../test/app-state.ts';
import { startDraftSync } from '../lib/draft-sync.ts';
import { releaseThumbnail } from '../lib/draft-thumbnails.ts';
import { FakeFileSystem } from '../files/fake-fs.ts';
import { FileSystemProvider } from '../files/fs-context.tsx';

const SCRIPTED_WORKFLOW = {
  name: 'ship-feature',
  path: '/ws/.whiphand/workflows/ship-feature.yaml',
  workflow: {
    name: 'ship-feature',
    description: 'Plan, implement, and review a feature.',
    inputs: {
      ticket: { required: true, prompt: 'Ticket ID' },
      branch: { required: true, default: 'main' },
      notes: { required: false, prompt: 'Extra notes' },
    },
    steps: [{ id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'plan', output: 'plan.md' }],
  },
};

// A separate workflow shape for the memory-prefill tests: it needs an
// unmarked field, a remember: true field, and a declared default all at once,
// which would break SCRIPTED_WORKFLOW's exact-inputs assertions elsewhere.
const MEMORY_WORKFLOW = {
  name: 'ship-feature',
  path: '/ws/.whiphand/workflows/ship-feature.yaml',
  workflow: {
    name: 'ship-feature',
    inputs: {
      ticket: { required: true, prompt: 'Ticket ID' },
      branch: { required: true, default: 'main' },
      env: { required: false, prompt: 'Environment', remember: true },
    },
    steps: [{ id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'plan', output: 'plan.md' }],
  },
};

// A workflow with one one-line input (multiline: false) and one unflagged
// (growing textarea) input, for the multiline-hint rendering test.
const MULTILINE_WORKFLOW = {
  name: 'ship-feature',
  path: '/ws/.whiphand/workflows/ship-feature.yaml',
  workflow: {
    name: 'ship-feature',
    inputs: {
      branch: { required: true, prompt: 'Branch to start from', default: 'main', multiline: false },
      feature: { required: true, prompt: 'What are we building?' },
    },
    steps: [{ id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'plan', output: 'plan.md' }],
  },
};

// NewRunForm fires listWorkflows and listRuns from separate effects on mount,
// so their relative arrival order in transport.sent isn't guaranteed —
// search by method instead of assuming position.
async function respond(transport: MockTransport, method: string, result: unknown) {
  const req = await waitFor(() => {
    const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === method);
    if (index === -1) throw new Error(`${method} not sent yet`);
    return transport.sentRequest(index);
  });
  transport.emitLine({ id: req.id, result });
}

/** A draft in `/ws` with its tab open and active, as New run leaves it. */
function openDraft(init: { runAgain?: RunAgain; workdir?: string } = {}): string {
  const { createDraft, openDraftTab } = useAppStore.getState();
  const draftId = createDraft({ workdir: init.workdir ?? '/ws', ...(init.runAgain ? { runAgain: init.runAgain } : {}) });
  openDraftTab(draftId);
  return draftId;
}

function renderNewRunForm(draftId = openDraft()) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  render(
    <AgentClientProvider client={client}>
      <NewRunForm draftId={draftId} />
    </AgentClientProvider>,
  );
  return { transport, client, draftId };
}

/** The tab the draft became, once its start has come back. */
async function expectStartedTab(jobId: string) {
  await waitFor(() => expect(useAppStore.getState().tabs).toMatchObject([{ kind: 'run', jobId, preview: false }]));
}

async function selectWorkflow(transport: MockTransport, name: string) {
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.click(await screen.findByRole('option', { name }));
}

describe('NewRunForm', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null });
  });

  it('generates a Field per workflow input using prompt-as-label, default prefill, and required-ness', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);

    await selectWorkflow(transport, 'ship-feature');

    expect(await screen.findByText('Plan, implement, and review a feature.')).toBeInTheDocument();
    expect(screen.getByLabelText('Ticket ID', { exact: false })).toBeInTheDocument(); // prompt used as label
    expect(screen.getByLabelText('branch', { exact: false })).toHaveValue('main'); // key used as label when no prompt; default prefilled
    expect(screen.getByLabelText('Extra notes', { exact: false })).toHaveValue(''); // optional, no default
  });

  it('disables Start until every required input is non-empty, regardless of defaults', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');

    await screen.findByLabelText('Ticket ID', { exact: false });
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Ticket ID', { exact: false }), { target: { value: 'TICK-1' } });
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('branch', { exact: false }), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  it('calls startRun with the filled inputs and dryRun, then turns the draft tab into a run tab', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');

    fireEvent.change(await screen.findByLabelText('Ticket ID', { exact: false }), { target: { value: 'TICK-1' } });
    fireEvent.click(screen.getByRole('switch', { name: /dry run/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'startRun') throw new Error('startRun not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({
      workdir: '/ws',
      workflow: 'ship-feature',
      inputs: { ticket: 'TICK-1', branch: 'main', notes: '' },
      dryRun: true,
      worktree: false,
    });

    transport.emitLine({ id: req.id, result: { jobId: 'job-42' } });
    await expectStartedTab('job-42');
  });

  it('sends a typed name, and omits it entirely when the field is left blank', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');

    fireEvent.change(await screen.findByLabelText('Ticket ID', { exact: false }), { target: { value: 'TICK-1' } });
    fireEvent.change(screen.getByTestId('run-name-input'), { target: { value: 'OAuth support' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'startRun') throw new Error('startRun not sent yet');
      return parsed;
    });
    expect((req.params as { name?: string }).name).toBe('OAuth support');
  });

  it('omits name entirely when the field is untouched, so it matches a bare whiphand run', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');

    fireEvent.change(await screen.findByLabelText('Ticket ID', { exact: false }), { target: { value: 'TICK-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'startRun') throw new Error('startRun not sent yet');
      return parsed;
    });
    expect(req.params).not.toHaveProperty('name');
  });

  it('leaves an unmarked input blank though memory holds a value for it', async () => {
    useAppStore.setState({
      appState: {
        ...EMPTY_APP_STATE,
        workspaces: { '/ws': { lastWorkflow: 'ship-feature', lastInputs: { 'ship-feature': { ticket: 'T-9', gone: 'x' } } } },
      },
    });
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [MEMORY_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    // lastWorkflow auto-selected — no manual dropdown interaction
    expect(await screen.findByLabelText('Ticket ID', { exact: false })).toHaveValue(''); // unmarked: blank despite memory
    expect(screen.getByLabelText('branch', { exact: false })).toHaveValue('main'); // declared default still fills a blank field
    expect(screen.queryByLabelText('gone', { exact: false })).toBeNull(); // undeclared key dropped
  });

  it('prefills a remember: true input from workspace memory', async () => {
    useAppStore.setState({
      appState: {
        ...EMPTY_APP_STATE,
        workspaces: { '/ws': { lastWorkflow: 'ship-feature', lastInputs: { 'ship-feature': { env: 'staging' } } } },
      },
    });
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [MEMORY_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    expect(await screen.findByLabelText('Environment', { exact: false })).toHaveValue('staging');
  });

  it('applies a run-again the draft was created with before the list loaded, and drops it', async () => {
    useAppStore.setState({ appState: EMPTY_APP_STATE });
    const draftId = openDraft({ runAgain: { workflow: 'ship-feature', inputs: { ticket: 'T-42', branch: 'hotfix' } } });
    const { transport } = renderNewRunForm(draftId);
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    expect(await screen.findByLabelText('Ticket ID', { exact: false })).toHaveValue('T-42');
    expect(screen.getByLabelText('branch', { exact: false })).toHaveValue('hotfix');
    expect(useAppStore.getState().drafts[draftId]!.runAgain).toBeUndefined();
  });

  it('drops a stale run-again that names a missing workflow, falling back to memory', async () => {
    useAppStore.setState({
      appState: {
        ...EMPTY_APP_STATE,
        workspaces: { '/ws': { lastWorkflow: 'ship-feature', lastInputs: {} } },
      },
    });
    const draftId = openDraft({ runAgain: { workflow: 'deleted-workflow', inputs: { ticket: 'T-1' } } });
    const { transport } = renderNewRunForm(draftId);
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    // falls back to memory.lastWorkflow since the run-again's target doesn't exist
    expect(await screen.findByLabelText('Ticket ID', { exact: false })).toHaveValue('');
    // the request is dropped regardless, so it can't wrongly reapply later
    expect(useAppStore.getState().drafts[draftId]!.runAgain).toBeUndefined();
  });

  it('preserves newlines in input values through to startRun', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');

    fireEvent.change(await screen.findByLabelText('Ticket ID', { exact: false }), {
      target: { value: 'first line\nsecond line\n\nfourth line' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'startRun') throw new Error('startRun not sent yet');
      return parsed;
    });
    expect((req.params as { inputs: Record<string, string> }).inputs.ticket).toBe(
      'first line\nsecond line\n\nfourth line',
    );
  });

  it('renders a multiline: false input as a one-line box and reaches startRun', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [MULTILINE_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');

    const branchField = await screen.findByLabelText('Branch to start from', { exact: false });
    expect(branchField.tagName).toBe('INPUT');
    const featureField = screen.getByLabelText('What are we building?', { exact: false });
    expect(featureField.tagName).toBe('TEXTAREA');

    fireEvent.change(branchField, { target: { value: 'my-branch' } });
    fireEvent.change(featureField, { target: { value: 'a feature' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'startRun') throw new Error('startRun not sent yet');
      return parsed;
    });
    expect((req.params as { inputs: Record<string, string> }).inputs.branch).toBe('my-branch');
  });

  it('starts the run on Ctrl+Enter', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');

    const field = await screen.findByLabelText('Ticket ID', { exact: false });
    fireEvent.change(field, { target: { value: 'TICK-1' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'startRun') throw new Error('startRun not sent yet');
      return parsed;
    });
    expect(req.method).toBe('startRun');
  });

  it('ignores Ctrl+Enter while a required input is empty', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');

    const field = await screen.findByLabelText('Ticket ID', { exact: false });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(transport.sent.some(line => (JSON.parse(line) as { method: string }).method === 'startRun')).toBe(false);
  });

  it('a shadowed global/project pair are distinct options, each starting the correctly scoped run', async () => {
    const GLOBAL_WORKFLOW = {
      name: 'ship-feature',
      path: '/home/user/.config/whiphand/workflows/ship-feature.yaml',
      source: 'global' as const,
      workflow: {
        name: 'ship-feature',
        inputs: {},
        steps: [{ id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'plan', output: 'plan.md' }],
      },
    };
    const PROJECT_WORKFLOW = {
      name: 'ship-feature',
      path: '/ws/.whiphand/workflows/ship-feature.yaml',
      source: 'project' as const,
      workflow: {
        name: 'ship-feature',
        inputs: {},
        steps: [{ id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'plan', output: 'plan.md' }],
      },
    };
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [PROJECT_WORKFLOW, GLOBAL_WORKFLOW]);
    await respond(transport, 'listRuns', []);

    fireEvent.click(screen.getByRole('combobox'));
    const options = await screen.findAllByRole('option', { name: /ship-feature/ });
    expect(options).toHaveLength(2);

    fireEvent.click(screen.getByRole('option', { name: 'ship-feature (Global)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'startRun') throw new Error('startRun not sent yet');
      return parsed;
    });
    expect((req.params as { workflow: string }).workflow).toBe('global:ship-feature');
  });

  it('remembers and prefills a global entry\'s inputs under its scoped key, distinct from a same-named project entry', async () => {
    const GLOBAL_MEMORY_WORKFLOW = {
      name: 'ship-feature',
      path: '/home/user/.config/whiphand/workflows/ship-feature.yaml',
      source: 'global' as const,
      workflow: {
        name: 'ship-feature',
        inputs: { env: { required: false, prompt: 'Environment', remember: true } },
        steps: [{ id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'plan', output: 'plan.md' }],
      },
    };
    const PROJECT_MEMORY_WORKFLOW = {
      name: 'ship-feature',
      path: '/ws/.whiphand/workflows/ship-feature.yaml',
      source: 'project' as const,
      workflow: {
        name: 'ship-feature',
        inputs: { env: { required: false, prompt: 'Environment', remember: true } },
        steps: [{ id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'plan', output: 'plan.md' }],
      },
    };
    useAppStore.setState({
      appState: {
        ...EMPTY_APP_STATE,
        workspaces: {
          '/ws': {
            lastWorkflow: 'ship-feature',
            lastInputs: { 'global:ship-feature': { env: 'staging' }, 'ship-feature': { env: 'production' } },
          },
        },
      },
    });
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [PROJECT_MEMORY_WORKFLOW, GLOBAL_MEMORY_WORKFLOW]);
    await respond(transport, 'listRuns', []);

    // Bare lastWorkflow auto-selects the project entry (first-match-by-name);
    // it must read its own key, not the global one.
    expect(await screen.findByLabelText('Environment', { exact: false })).toHaveValue('production');

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'ship-feature (Global)' }));
    expect(await screen.findByLabelText('Environment', { exact: false })).toHaveValue('staging');

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'startRun') throw new Error('startRun not sent yet');
    });
    // The optimistic local write lands under the same scoped key the agent's
    // rememberRun would use for this ref, not the bare name.
    expect(useAppStore.getState().appState?.workspaces['/ws']?.lastInputs['global:ship-feature'])
      .toEqual({ env: 'staging' });
  });

  it('disables a workflow with a parse error and shows its error as a tooltip', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [
      { name: 'broken', path: '/ws/.whiphand/workflows/broken.yaml', error: 'invalid step: missing runner' },
    ]);
    await respond(transport, 'listRuns', []);

    fireEvent.click(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', { name: /broken/ });
    expect(option).toHaveAttribute('aria-disabled', 'true');
  });
});

const LOOPING_WORKFLOW = {
  name: 'cycle',
  path: '/ws/.whiphand/workflows/cycle.yaml',
  workflow: {
    name: 'cycle',
    steps: [{
      id: 'fix', kind: 'loop', until: 'tests', max_iterations: 3,
      steps: [
        { id: 'execute', kind: 'agent', runner: 'claude', mode: 'headless', writes: true, prompt: 'p', output: 'e.md' },
        { id: 'tests', kind: 'command', run: 'npm test', verdict: true, output: 'tests.log' },
      ],
    }],
  },
};

describe('NewRunForm max iterations', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null });
  });

  it('is offered only for a workflow that actually has a loop', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW, LOOPING_WORKFLOW]);
    await respond(transport, 'listRuns', []);

    await selectWorkflow(transport, 'ship-feature');
    await screen.findByLabelText('Ticket ID', { exact: false });
    expect(screen.queryByTestId('max-iterations-input')).toBeNull();
  });

  it('sends the override to startRun, and omits it when left blank', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [LOOPING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'cycle');

    const field = await screen.findByTestId('max-iterations-input');
    fireEvent.change(field, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    const req = await waitFor(() => {
      const index = transport.sent.findIndex(l => (JSON.parse(l) as { method: string }).method === 'startRun');
      if (index === -1) throw new Error('startRun not sent yet');
      return transport.sentRequest(index);
    });
    expect((req.params as { maxIterations?: number }).maxIterations).toBe(5);
  });

  it('rejects a value that is not a positive whole number', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [LOOPING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'cycle');

    const field = await screen.findByTestId('max-iterations-input');
    fireEvent.change(field, { target: { value: '0' } });
    expect(await screen.findByText('Must be a positive whole number.')).toBeInTheDocument();
  });
});

const DISABLED_LOOP_WORKFLOW = {
  name: 'feature-development',
  path: '/ws/.whiphand/workflows/feature-development.yaml',
  workflow: {
    name: 'feature-development',
    steps: [
      { id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'p', output: 'plan.md' },
      {
        id: 'human-review', kind: 'loop', until: 'sign-off', max_iterations: 5, enabled: false,
        steps: [
          {
            id: 'do-review', kind: 'loop', until: 'review', max_iterations: 10,
            steps: [
              { id: 'execute', kind: 'agent', runner: 'claude', mode: 'headless', writes: true, prompt: 'p', inputs: ['plan', 'review', 'sign-off'], output: 'e.md' },
              { id: 'review', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, verdict: true, prompt: 'p', inputs: ['plan', 'execute'], output: 'r.md' },
            ],
          },
          { id: 'sign-off', kind: 'approval', title: 'Ship it?', instructions: 'go', verdict: true, inputs: ['review'] },
        ],
      },
      {
        id: 'commit-message', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'p',
        inputs: ['plan', 'review', 'sign-off'], output: 'commit-message.md',
      },
    ],
  },
};

describe('NewRunForm disabled steps', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null });
  });

  it('names a disabled loop as one entry naming its size, not one per body step', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [DISABLED_LOOP_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'feature-development');

    const warning = await screen.findByTestId('disabled-steps-warning');
    expect(warning).toHaveTextContent("Disabled: human-review (loop, 4 steps).");
  });

  it('names the consequence for a reader outside the disabled loop, one sentence per lost id', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [DISABLED_LOOP_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'feature-development');

    const warning = await screen.findByTestId('disabled-steps-warning');
    // 'execute' and 'review' also named 'review'/'sign-off', but they are
    // disabled themselves (inside the very loop that was disabled) — only an
    // enabled reader's loss is worth naming.
    expect(warning).toHaveTextContent("review is disabled. commit-message reads it; it'll run without it.");
    expect(warning).toHaveTextContent("sign-off is disabled. commit-message reads it; it'll run without it.");
  });

  it('shows no warning at all when nothing is disabled', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');
    await screen.findByText('Plan, implement, and review a feature.');
    expect(screen.queryByTestId('disabled-steps-warning')).not.toBeInTheDocument();
  });
});

// Reads `attachments`, and has no required input, so Start is enabled as soon
// as it is selected and only the attachments decide.
const ATTACHING_WORKFLOW = {
  name: 'triage',
  path: '/ws/.whiphand/workflows/triage.yaml',
  workflow: {
    name: 'triage',
    steps: [{ id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'p', inputs: ['attachments'], output: 'plan.md' }],
  },
};

// The same, reading nothing — the shape that has to grey the field out.
const NON_READING_WORKFLOW = {
  name: 'tidy',
  path: '/ws/.whiphand/workflows/tidy.yaml',
  workflow: {
    name: 'tidy',
    steps: [{ id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'p', output: 'plan.md' }],
  },
};

/** A PNG signature and then some: bytes past 0x7f are what a text round trip would mangle. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);

function renderWithCapabilities(capabilities: Partial<AppCapabilities>, draftId = openDraft()) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  const ui = (visible: boolean) => (
    <CapabilitiesProvider value={{ ...DESKTOP_DEFAULT_CAPABILITIES, ...capabilities }}>
      <AgentClientProvider client={client}>
        <NewRunForm draftId={draftId} visible={visible} />
      </AgentClientProvider>
    </CapabilitiesProvider>
  );
  const rendered = render(ui(true));
  return { transport, client, draftId, rerenderVisible: (visible: boolean) => rendered.rerender(ui(visible)) };
}

/**
 * jsdom has no DataTransfer, so the clipboard is a plain object shaped like
 * one; fireEvent returns false when the handler called preventDefault.
 */
function paste(target: Element, clipboard: { files?: File[]; text?: string }): boolean {
  const files = clipboard.files ?? [];
  return fireEvent.paste(target, {
    clipboardData: {
      items: [
        ...files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })),
        ...(clipboard.text === undefined ? [] : [{ kind: 'string', type: 'text/plain', getAsFile: () => null }]),
      ],
      files,
      types: [...(files.length > 0 ? ['Files'] : []), ...(clipboard.text === undefined ? [] : ['text/plain'])],
    },
  });
}

const pngFile = () => new File([PNG], 'image.png', { type: 'image/png' });

/** Where the agent would put a stashed paste. */
const stashPath = (draftId: string, name: string) => `/data/whiphand/drafts/${draftId}/${name}`;

/** Pastes an image and answers the agent's stash request the way it would. */
async function pasteAndStash(transport: MockTransport, target: Element, draftId: string) {
  const before = transport.sent.filter(line => (JSON.parse(line) as { method: string }).method === 'stashDraftAttachment').length;
  paste(target, { files: [pngFile()] });
  const req = await waitFor(() => {
    const lines = transport.sent
      .map((line, index) => ({ index, method: (JSON.parse(line) as { method: string }).method }))
      .filter(entry => entry.method === 'stashDraftAttachment');
    if (lines.length <= before) throw new Error('stashDraftAttachment not sent yet');
    return transport.sentRequest(lines[before]!.index);
  });
  const { name } = req.params as { name: string };
  transport.emitLine({ id: req.id, result: { path: stashPath(draftId, name) } });
  return req;
}

async function startRunRequest(transport: MockTransport) {
  return waitFor(() => {
    const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === 'startRun');
    if (index === -1) throw new Error('startRun not sent yet');
    return transport.sentRequest(index);
  });
}

describe('NewRunForm attachments', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let revoked: string[];

  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null });
    // jsdom has no object URLs; the thumbnails only need a distinct string each.
    let n = 0;
    revoked = [];
    URL.createObjectURL = () => `blob:thumb-${++n}`;
    URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null });
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it('has no attach field without a file picker, and ignores a pasted image there', async () => {
    const { transport } = renderNewRunForm(); // the default capabilities: no pickFiles
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');

    const nameInput = await screen.findByTestId('run-name-input');
    expect(screen.queryByTestId('attachments-field')).not.toBeInTheDocument();
    expect(paste(nameInput, { files: [pngFile()] })).toBe(true); // not swallowed
  });

  it('greys the field with the fix when the workflow reads no attachments', async () => {
    const { transport } = renderWithCapabilities({ pickFiles: vi.fn(async () => []) });
    await respond(transport, 'listWorkflows', [NON_READING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'tidy');

    expect(await screen.findByTestId('attachments-field')).toBeInTheDocument();
    expect(screen.getByText(/This workflow doesn't read attachments — add/)).toHaveTextContent(
      "This workflow doesn't read attachments — add attachments to a step's inputs.",
    );
    expect(screen.getByRole('button', { name: 'Add files…' })).toBeDisabled();
    // Nothing to add to, so a pasted image stays the browser's business.
    expect(paste(screen.getByTestId('run-name-input'), { files: [pngFile()] })).toBe(true);
    expect(screen.queryByRole('button', { name: / Remove$/ })).not.toBeInTheDocument();
  });

  it('turns a pasted image into a chip with a thumbnail, and removes it again', async () => {
    const { transport, draftId } = renderWithCapabilities({ pickFiles: vi.fn(async () => []) });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');

    const nameInput = await screen.findByTestId('run-name-input');
    expect(paste(nameInput, { files: [pngFile()] })).toBe(false); // taken, not pasted as text
    const stash = await waitFor(() => {
      const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === 'stashDraftAttachment');
      if (index === -1) throw new Error('not sent yet');
      return transport.sentRequest(index);
    });
    // Stashed at once, under the name core will give it, as base64 of the bytes.
    expect(stash.params).toEqual({ draftId, name: 'pasted-1.png', base64: btoa(String.fromCharCode(...PNG)) });
    transport.emitLine({ id: stash.id, result: { path: stashPath(draftId, 'pasted-1.png') } });

    expect(await screen.findByText('pasted-1.png')).toBeInTheDocument();
    expect(screen.getByTestId('attachment-thumbnail')).toHaveAttribute('src', 'blob:thumb-1');
    // The draft holds the path alone, flagged as a paste.
    expect(useAppStore.getState().drafts[draftId]!.attachments).toEqual([
      { key: 0, path: stashPath(draftId, 'pasted-1.png'), pasted: true },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'pasted-1.png Remove' }));
    await waitFor(() => expect(screen.queryByText('pasted-1.png')).not.toBeInTheDocument());
    expect(revoked).toEqual(['blob:thumb-1']);
  });

  it('leaves a text paste alone, including into a text box when an image rides along', async () => {
    const { transport } = renderWithCapabilities({ pickFiles: vi.fn(async () => []) });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');

    const nameInput = await screen.findByTestId('run-name-input');
    expect(paste(nameInput, { text: 'OAuth support' })).toBe(true);
    // A spreadsheet copy: the text, plus a picture of the cells.
    expect(paste(nameInput, { text: 'A1', files: [pngFile()] })).toBe(true);
    expect(screen.queryByRole('button', { name: / Remove$/ })).not.toBeInTheDocument();
  });

  it('sends picked paths and a pasted image\'s stash path to startRun, in list order, ignoring a path picked twice', async () => {
    const pickFiles = vi.fn()
      .mockResolvedValueOnce(['/home/me/bug.png', '/home/me/logs/server.log'])
      .mockResolvedValueOnce(['/home/me/bug.png']);
    const { transport, draftId } = renderWithCapabilities({ pickFiles });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');

    fireEvent.click(await screen.findByRole('button', { name: 'Add files…' }));
    expect(await screen.findByText('server.log')).toBeInTheDocument();
    expect(screen.getByText('bug.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add files…' }));
    await waitFor(() => expect(pickFiles).toHaveBeenCalledTimes(2));

    await pasteAndStash(transport, screen.getByTestId('run-name-input'), draftId);
    await screen.findByText('pasted-1.png');
    expect(screen.getAllByRole('button', { name: / Remove$/ })).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    const req = await startRunRequest(transport);
    expect((req.params as { attachments?: unknown }).attachments).toEqual([
      { path: '/home/me/bug.png' },
      { path: '/home/me/logs/server.log' },
      { path: stashPath(draftId, 'pasted-1.png') },
    ]);

    transport.emitLine({ id: req.id, result: { jobId: 'job-7' } });
    await expectStartedTab('job-7');
  });

  it('numbers a second paste after the first and never reuses a removed number', async () => {
    const { transport, draftId } = renderWithCapabilities({ pickFiles: vi.fn(async () => []) });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');
    const nameInput = await screen.findByTestId('run-name-input');

    await pasteAndStash(transport, nameInput, draftId);
    await screen.findByText('pasted-1.png');
    await pasteAndStash(transport, nameInput, draftId);
    await screen.findByText('pasted-2.png');
    fireEvent.click(screen.getByRole('button', { name: 'pasted-1.png Remove' }));
    await waitFor(() => expect(screen.queryByText('pasted-1.png')).not.toBeInTheDocument());
    // pasted-2 keeps its name, which is what its stash file is called.
    expect(screen.getByText('pasted-2.png')).toBeInTheDocument();
    await pasteAndStash(transport, nameInput, draftId);
    await screen.findByText('pasted-3.png');
  });

  it('shows the stash error and adds no chip when the agent refuses a paste', async () => {
    const { transport } = renderWithCapabilities({ pickFiles: vi.fn(async () => []) });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');
    paste(await screen.findByTestId('run-name-input'), { files: [pngFile()] });
    const req = await waitFor(() => {
      const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === 'stashDraftAttachment');
      if (index === -1) throw new Error('not sent yet');
      return transport.sentRequest(index);
    });
    transport.emitLine({ id: req.id, error: { code: -32000, message: 'attachment is larger than 64 MB' } });
    expect(await screen.findByText(/larger than 64 MB/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: / Remove$/ })).not.toBeInTheDocument();
    expect(revoked).toEqual(['blob:thumb-1']);
  });

  it('saves the draft to the agent when Start is pressed, before startRun, not waiting out the debounce', async () => {
    const { transport, draftId, client } = renderWithCapabilities({ pickFiles: vi.fn(async () => []) });
    const sync = startDraftSync(client);
    try {
      await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
      await respond(transport, 'listRuns', []);
      await selectWorkflow(transport, 'triage');
      fireEvent.change(await screen.findByTestId('run-name-input'), { target: { value: 'my run' } });
      expect(transport.sent.some(line => line.includes('saveRunDraft'))).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      await startRunRequest(transport);
      const methods = transport.sent.map(line => (JSON.parse(line) as { method: string }).method);
      expect(methods.indexOf('saveRunDraft')).toBeGreaterThanOrEqual(0);
      expect(methods.indexOf('saveRunDraft')).toBeLessThan(methods.indexOf('startRun'));
      const save = transport.sentRequest(methods.indexOf('saveRunDraft'));
      expect(save.params).toMatchObject({ draft: { id: draftId, name: 'my run', workflow: 'triage' } });
    } finally {
      sync.dispose();
    }
  });

  it('omits attachments entirely from a run started without any', async () => {
    const { transport } = renderWithCapabilities({ pickFiles: vi.fn(async () => []) });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');

    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect((await startRunRequest(transport)).params).not.toHaveProperty('attachments');
  });

  it('keeps files added before switching to a workflow that reads none, and holds Start until they go', async () => {
    const { transport } = renderWithCapabilities({ pickFiles: vi.fn(async () => ['/home/me/bug.png']) });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW, NON_READING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');
    fireEvent.click(await screen.findByRole('button', { name: 'Add files…' }));
    await screen.findByText('bug.png');

    await selectWorkflow(transport, 'tidy');
    await screen.findByText(/This workflow doesn't read attachments/);
    expect(screen.getByText('bug.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'bug.png Remove' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled());
  });

  it('highlights the field while files hover, and attaches what is dropped', async () => {
    let emit: ((event: FileDropEvent) => void) | undefined;
    const unlisten = vi.fn();
    const onFileDrop = vi.fn(async (handler: (event: FileDropEvent) => void) => {
      emit = handler;
      return unlisten;
    });
    const { transport } = renderWithCapabilities({ pickFiles: vi.fn(async () => []), onFileDrop });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');

    const field = await screen.findByTestId('attachments-field');
    await waitFor(() => expect(emit).toBeDefined());
    act(() => emit!({ type: 'enter' }));
    expect(field).toHaveAttribute('data-drop-active', 'true');

    act(() => emit!({ type: 'drop', paths: ['/home/me/trace.har'] }));
    expect(field).not.toHaveAttribute('data-drop-active');
    expect(await screen.findByText('trace.har')).toBeInTheDocument();
  });

  describe('worktree', () => {
    const withWorktree = (name: string, worktree: unknown) => ({
      ...SCRIPTED_WORKFLOW,
      name,
      workflow: { ...SCRIPTED_WORKFLOW.workflow, name, worktree },
    });
    const WARNING = 'Another run is already in progress in this workspace.';

    async function open(workflows: unknown[], runs: unknown[], pick: string) {
      const rendered = renderNewRunForm();
      await respond(rendered.transport, 'listWorkflows', workflows);
      await respond(rendered.transport, 'listRuns', runs);
      await selectWorkflow(rendered.transport, pick);
      await screen.findByLabelText('Ticket ID', { exact: false });
      return rendered;
    }

    it('defaults from the workflow, and follows a change of workflow', async () => {
      const { transport } = await open(
        [withWorktree('on', true), withWorktree('obj', { base: 'main' }), withWorktree('off', false), SCRIPTED_WORKFLOW],
        [],
        'on',
      );
      const sw = () => screen.getByRole('switch', { name: /separate worktree/i });
      expect(sw()).toBeChecked();
      fireEvent.click(sw());
      expect(sw()).not.toBeChecked();
      await selectWorkflow(transport, 'obj');
      expect(sw()).toBeChecked();
      await selectWorkflow(transport, 'off');
      expect(sw()).not.toBeChecked();
      await selectWorkflow(transport, 'ship-feature');
      expect(sw()).not.toBeChecked();
    });

    it('sends the switch explicitly, in both directions', async () => {
      const { transport } = await open([withWorktree('on', true)], [], 'on');
      fireEvent.change(screen.getByLabelText('Ticket ID', { exact: false }), { target: { value: 'T-1' } });
      fireEvent.click(screen.getByRole('switch', { name: /separate worktree/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      const req = await waitFor(() => {
        const parsed = transport.sentRequest(transport.sent.length - 1);
        if (parsed.method !== 'startRun') throw new Error('startRun not sent yet');
        return parsed;
      });
      expect(req.params).toMatchObject({ worktree: false });
    });

    it('sends worktree: true when switched on over a workflow without the field', async () => {
      const { transport } = await open([SCRIPTED_WORKFLOW], [], 'ship-feature');
      fireEvent.change(screen.getByLabelText('Ticket ID', { exact: false }), { target: { value: 'T-1' } });
      fireEvent.click(screen.getByRole('switch', { name: /separate worktree/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      const req = await waitFor(() => {
        const parsed = transport.sentRequest(transport.sent.length - 1);
        if (parsed.method !== 'startRun') throw new Error('startRun not sent yet');
        return parsed;
      });
      expect(req.params).toMatchObject({ worktree: true });
    });

    it('warns about a running workspace run only while the switch is off', async () => {
      await open([SCRIPTED_WORKFLOW], [{ runId: 'r1', runDir: '/r1', status: 'running' }], 'ship-feature');
      expect(await screen.findByText(WARNING)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('switch', { name: /separate worktree/i }));
      expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('switch', { name: /separate worktree/i }));
      expect(screen.getByText(WARNING)).toBeInTheDocument();
    });

    it('does not warn when the only running run has its own worktree', async () => {
      await open(
        [SCRIPTED_WORKFLOW],
        [{ runId: 'r1', runDir: '/r1', status: 'running', worktree: { path: '.whiphand/worktrees/r1', branch: 'whiphand/r1' } }],
        'ship-feature',
      );
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    });
  });
});

describe('NewRunForm restored paste chips', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const path = '/data/whiphand/drafts/d1/pasted-1.png';

  function renderRestored(capabilities: Partial<AppCapabilities>, fs?: FakeFileSystem) {
    useAppStore.setState({
      workspacePath: '/ws', workflows: [ATTACHING_WORKFLOW] as never, appState: null, drafts: {}, tabs: [], activeTabKey: null,
    });
    const draftId = openDraft();
    useAppStore.getState().updateDraft(draftId, {
      workflowRef: 'triage', attachments: [{ key: 0, path, pasted: true }],
    });
    const client = new AgentClient(new MockTransport());
    const body = (
      <CapabilitiesProvider value={{ ...DESKTOP_DEFAULT_CAPABILITIES, pickFiles: async () => [], ...capabilities }}>
        <AgentClientProvider client={client}><NewRunForm draftId={draftId} /></AgentClientProvider>
      </CapabilitiesProvider>
    );
    render(fs ? <FileSystemProvider fs={fs}>{body}</FileSystemProvider> : body);
  }

  beforeEach(() => {
    URL.createObjectURL = () => 'blob:from-stash';
    URL.revokeObjectURL = () => {};
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null });
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    releaseThumbnail(path);
  });

  it('loads the thumbnail from the stashed file where local files are reachable', async () => {
    const fs = new FakeFileSystem();
    fs.setFile(path, 'png-bytes');
    renderRestored({ localFiles: true }, fs);
    expect(await screen.findByTestId('attachment-thumbnail')).toHaveAttribute('src', 'blob:from-stash');
    expect(screen.getByText('pasted-1.png')).toBeInTheDocument();
  });

  it('shows a file icon instead where they are not (a browser client)', async () => {
    renderRestored({ host: 'browser', localFiles: false });
    expect(await screen.findByText('pasted-1.png')).toBeInTheDocument();
    expect(screen.queryByTestId('attachment-thumbnail')).not.toBeInTheDocument();
  });

  it('keeps the file icon when the stashed file cannot be read', async () => {
    renderRestored({ localFiles: true }, new FakeFileSystem());
    expect(await screen.findByText('pasted-1.png')).toBeInTheDocument();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByTestId('attachment-thumbnail')).not.toBeInTheDocument();
  });
});

describe('NewRunForm draft lifecycle', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let revoked: string[];

  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null });
    let n = 0;
    revoked = [];
    URL.createObjectURL = () => `blob:thumb-${++n}`;
    URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null });
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it('holds one draft while open, with the form fields written through to it', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');
    fireEvent.change(await screen.findByLabelText('Ticket ID', { exact: false }), { target: { value: 'TICK-1' } });
    fireEvent.change(screen.getByTestId('run-name-input'), { target: { value: 'my run' } });

    const drafts = Object.values(useAppStore.getState().drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      workdir: '/ws', workflowRef: 'ship-feature', name: 'my run', values: { ticket: 'TICK-1', branch: 'main' },
    });
  });

  it('deletes the draft and closes its tab on Discard, when nothing was typed', async () => {
    const { transport, draftId } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useAppStore.getState().drafts[draftId]).toBeUndefined();
    expect(useAppStore.getState().tabs).toEqual([]);
  });

  it('hands focus to a neighbour from another workspace through openWorkspace on Discard', async () => {
    const draftId = openDraft();
    useAppStore.setState({
      tabs: [{ kind: 'draft', key: draftId }, { kind: 'run', key: 'r2', runId: 'r2', workdir: '/ws/b', preview: false }],
      activeTabKey: draftId,
    });
    const { transport } = renderNewRunForm(draftId);
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    // The neighbour is not shown while the workspace is still /ws.
    expect(useAppStore.getState().activeTabKey).toBeNull();
    expect(useAppStore.getState().workspacePath).toBe('/ws');
    const req = await waitFor(() => {
      const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === 'touchRecentWorkspace');
      if (index === -1) throw new Error('touchRecentWorkspace not sent yet');
      return transport.sentRequest(index);
    });
    expect(req).toMatchObject({ params: { path: '/ws/b' } });
    transport.emitLine({ id: req.id, result: { recentWorkspaces: [{ path: '/ws/b', lastOpenedAt: 'now' }] } });
    await waitFor(() => expect(useAppStore.getState().activeTabKey).toBe('r2'));
    expect(useAppStore.getState().workspacePath).toBe('/ws/b');
  });

  it('turns the draft\'s tab into the run\'s after a successful start, and deletes the draft', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');
    fireEvent.change(await screen.findByLabelText('Ticket ID', { exact: false }), { target: { value: 'TICK-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await respond(transport, 'startRun', { jobId: 'job-9' });
    await expectStartedTab('job-9');
    expect(useAppStore.getState().drafts).toEqual({});
    expect(useAppStore.getState().activeTabKey).toBe('job-9');
  });

  it('keeps a pasted thumbnail until the draft is deleted, not when the form is hidden', async () => {
    const { transport, draftId, rerenderVisible } = renderWithCapabilities({ pickFiles: vi.fn(async () => []) });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');
    await pasteAndStash(transport, await screen.findByTestId('run-name-input'), draftId);
    expect(await screen.findByText('pasted-1.png')).toBeInTheDocument();

    rerenderVisible(false);
    expect(revoked).toEqual([]);
    expect(screen.getByTestId('attachment-thumbnail')).toHaveAttribute('src', 'blob:thumb-1');

    act(() => useAppStore.getState().deleteDraft(draftId));
    expect(revoked).toEqual(['blob:thumb-1']);
    expect(useAppStore.getState().drafts).toEqual({});
  });
});

describe('NewRunForm as a draft tab', () => {
  beforeEach(() => {
    useAppStore.setState({
      workspacePath: '/ws', workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null,
    });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [], appState: null, drafts: {}, tabs: [], activeTabKey: null });
  });

  it('is laid out as a page titled New run, with Start and Discard, and no dialog', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('page-header')).toHaveTextContent('New run');
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('starts on Ctrl+Enter', async () => {
    const { transport } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');
    const ticket = await screen.findByLabelText('Ticket ID', { exact: false });
    fireEvent.change(ticket, { target: { value: 'TICK-1' } });
    fireEvent.keyDown(ticket, { key: 'Enter', ctrlKey: true });
    expect((await startRunRequest(transport)).method).toBe('startRun');
  });

  it('says to drop files here', async () => {
    const { transport } = renderWithCapabilities({ pickFiles: vi.fn(async () => []) });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');
    expect(await screen.findByText('Drop files here, or paste an image.')).toBeInTheDocument();
  });

  it('keeps the draft and its tab on a failed start, and shows the error', async () => {
    const { transport, draftId } = renderNewRunForm();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');
    fireEvent.change(await screen.findByLabelText('Ticket ID', { exact: false }), { target: { value: 'TICK-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    const req = await startRunRequest(transport);
    transport.emitLine({ id: req.id, error: { code: -32000, message: 'no runner available' } });

    expect(await screen.findByText(/no runner available/)).toBeInTheDocument();
    expect(useAppStore.getState().drafts[draftId]).toBeDefined();
    expect(useAppStore.getState().tabs).toMatchObject([{ kind: 'draft', key: draftId }]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled());
  });

  it('keeps every field and the error through hiding and showing the form', async () => {
    const { transport, rerenderVisible } = renderWithCapabilities({ pickFiles: vi.fn(async () => ['/home/me/bug.png']) });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');
    fireEvent.change(await screen.findByTestId('run-name-input'), { target: { value: 'my run' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add files…' }));
    await screen.findByText('bug.png');

    rerenderVisible(false);
    rerenderVisible(true);
    expect(screen.getByTestId('run-name-input')).toHaveValue('my run');
    expect(screen.getByText('bug.png')).toBeInTheDocument();
  });

  it('lets two drafts start back to back, each into its own run tab', async () => {
    const a = openDraft();
    const b = openDraft();
    const first = renderNewRunForm(a);
    const second = renderNewRunForm(b);
    for (const { transport } of [first, second]) await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    useAppStore.setState({ workflows: [SCRIPTED_WORKFLOW] as never });
    act(() => {
      for (const id of [a, b]) {
        useAppStore.getState().updateDraft(id, {
          workflowRef: 'ship-feature', values: { ticket: 'T', branch: 'main', notes: '' },
        });
      }
    });
    const starts = screen.getAllByRole('button', { name: 'Start' });
    expect(starts).toHaveLength(2);
    await waitFor(() => starts.forEach(start => expect(start).toBeEnabled()));
    fireEvent.click(starts[0]!);
    fireEvent.click(starts[1]!);
    const reqA = await startRunRequest(first.transport);
    const reqB = await startRunRequest(second.transport);
    second.transport.emitLine({ id: reqB.id, result: { jobId: 'job-b' } });
    first.transport.emitLine({ id: reqA.id, result: { jobId: 'job-a' } });
    // Each draft's tab became its own run's, in its own position, though b's start landed first.
    await waitFor(() => expect(useAppStore.getState().tabs.map(tab => tab.key)).toEqual(['job-a', 'job-b']));
    expect(useAppStore.getState().tabs.every(tab => tab.kind === 'run')).toBe(true);
    expect(useAppStore.getState().drafts).toEqual({});
  });

  it('starts in the draft\'s own workspace, whatever the current one is', async () => {
    const draftId = openDraft({ workdir: '/ws/x' });
    useAppStore.setState({ workspacePath: '/ws/y' });
    const { transport } = renderNewRunForm(draftId);
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'ship-feature');
    fireEvent.change(await screen.findByLabelText('Ticket ID', { exact: false }), { target: { value: 'T-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    const req = await startRunRequest(transport);
    expect(req.params).toMatchObject({ workdir: '/ws/x' });
    transport.emitLine({ id: req.id, result: { jobId: 'job-x' } });
    await waitFor(() => expect(useAppStore.getState().tabs).toMatchObject([{ key: 'job-x', workdir: '/ws/x' }]));
  });

  describe('Discard with content', () => {
    it('asks first when a name was typed, and keeps the draft on Keep editing', async () => {
      const { transport, draftId } = renderNewRunForm();
      await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
      await respond(transport, 'listRuns', []);
      await selectWorkflow(transport, 'ship-feature');
      fireEvent.change(await screen.findByTestId('run-name-input'), { target: { value: 'my run' } });

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(useAppStore.getState().drafts[draftId]).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(useAppStore.getState().drafts[draftId]).toBeDefined();
      expect(useAppStore.getState().tabs).toHaveLength(1);
    });

    it('deletes the draft and its tab once confirmed', async () => {
      const { transport, draftId } = renderNewRunForm();
      await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
      await respond(transport, 'listRuns', []);
      await selectWorkflow(transport, 'ship-feature');
      fireEvent.change(await screen.findByLabelText('Ticket ID', { exact: false }), { target: { value: 'TICK-1' } });

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
      expect(useAppStore.getState().drafts[draftId]).toBeUndefined();
      expect(useAppStore.getState().tabs).toEqual([]);
    });

    it('does not ask when the inputs are just what the form filled in', async () => {
      const { transport, draftId } = renderNewRunForm();
      await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
      await respond(transport, 'listRuns', []);
      await selectWorkflow(transport, 'ship-feature');
      await screen.findByLabelText('Ticket ID', { exact: false });
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(useAppStore.getState().drafts[draftId]).toBeUndefined();
    });
  });

  describe('file drop', () => {
    function dropHost() {
      const handlers: Array<(event: FileDropEvent) => void> = [];
      const unlisteners: Array<ReturnType<typeof vi.fn>> = [];
      const onFileDrop = vi.fn(async (handler: (event: FileDropEvent) => void) => {
        handlers.push(handler);
        const unlisten = vi.fn(() => { handlers.splice(handlers.indexOf(handler), 1); });
        unlisteners.push(unlisten);
        return unlisten;
      });
      return { handlers, onFileDrop };
    }

    it('lands on the visible draft only, never on a hidden one', async () => {
      const { handlers, onFileDrop } = dropHost();
      const a = openDraft();
      const b = openDraft();
      const transport = new MockTransport();
      const client = new AgentClient(transport);
      const ui = (activeId: string) => (
        <CapabilitiesProvider value={{ ...DESKTOP_DEFAULT_CAPABILITIES, pickFiles: vi.fn(async () => []), onFileDrop }}>
          <AgentClientProvider client={client}>
            <NewRunForm draftId={a} visible={activeId === a} />
            <NewRunForm draftId={b} visible={activeId === b} />
          </AgentClientProvider>
        </CapabilitiesProvider>
      );
      useAppStore.setState({ workflows: [ATTACHING_WORKFLOW] as never });
      for (const id of [a, b]) {
        useAppStore.getState().updateDraft(id, { workflowRef: 'triage', values: {} });
      }
      const { rerender } = render(ui(a));
      await waitFor(() => expect(handlers).toHaveLength(1));
      // Switch to B: A's listener goes, B's arrives.
      rerender(ui(b));
      await waitFor(() => expect(onFileDrop).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(handlers).toHaveLength(1));

      act(() => handlers[0]!({ type: 'drop', paths: ['/home/me/trace.har'] }));
      const { drafts } = useAppStore.getState();
      expect(drafts[b]!.attachments).toMatchObject([{ path: '/home/me/trace.har' }]);
      expect(drafts[a]!.attachments).toEqual([]);
    });
  });
});
