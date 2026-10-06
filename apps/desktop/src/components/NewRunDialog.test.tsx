import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewRunDialog } from './NewRunDialog.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { CapabilitiesProvider, DESKTOP_DEFAULT_CAPABILITIES, type AppCapabilities, type FileDropEvent } from '../capabilities.tsx';
import { useAppStore } from '../state/store.ts';
import { EMPTY_APP_STATE } from '../test/app-state.ts';

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

// NewRunDialog fires listWorkflows and listRuns from separate effects on mount,
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

function renderNewRunDialog(onStarted = vi.fn()) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  render(
    <AgentClientProvider client={client}>
      <NewRunDialog open onOpenChange={() => {}} onStarted={onStarted} />
    </AgentClientProvider>,
  );
  return { transport, client, onStarted };
}

async function selectWorkflow(transport: MockTransport, name: string) {
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.click(await screen.findByRole('option', { name }));
}

describe('NewRunDialog', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [], appState: null, pendingRunAgain: null });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [], appState: null, pendingRunAgain: null });
  });

  it('generates a Field per workflow input using prompt-as-label, default prefill, and required-ness', async () => {
    const { transport } = renderNewRunDialog();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);

    await selectWorkflow(transport, 'ship-feature');

    expect(await screen.findByText('Plan, implement, and review a feature.')).toBeInTheDocument();
    expect(screen.getByLabelText('Ticket ID', { exact: false })).toBeInTheDocument(); // prompt used as label
    expect(screen.getByLabelText('branch', { exact: false })).toHaveValue('main'); // key used as label when no prompt; default prefilled
    expect(screen.getByLabelText('Extra notes', { exact: false })).toHaveValue(''); // optional, no default
  });

  it('disables Start until every required input is non-empty, regardless of defaults', async () => {
    const { transport } = renderNewRunDialog();
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

  it('calls startRun with the filled inputs and dryRun, then reports the returned jobId', async () => {
    const { transport, onStarted } = renderNewRunDialog();
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
    });

    transport.emitLine({ id: req.id, result: { jobId: 'job-42' } });
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('job-42'));
  });

  it('sends a typed name, and omits it entirely when the field is left blank', async () => {
    const { transport } = renderNewRunDialog();
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
    const { transport } = renderNewRunDialog();
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
    const { transport } = renderNewRunDialog();
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
    const { transport } = renderNewRunDialog();
    await respond(transport, 'listWorkflows', [MEMORY_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    expect(await screen.findByLabelText('Environment', { exact: false })).toHaveValue('staging');
  });

  it('applies a pending run-again request over everything else and clears it', async () => {
    useAppStore.setState({
      appState: EMPTY_APP_STATE,
      pendingRunAgain: { workflow: 'ship-feature', inputs: { ticket: 'T-42', branch: 'hotfix' } },
    });
    const { transport } = renderNewRunDialog();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    expect(await screen.findByLabelText('Ticket ID', { exact: false })).toHaveValue('T-42');
    expect(screen.getByLabelText('branch', { exact: false })).toHaveValue('hotfix');
    expect(useAppStore.getState().pendingRunAgain).toBeNull();
  });

  it('clears a stale pending run-again that names a missing workflow, falling back to memory', async () => {
    useAppStore.setState({
      appState: {
        ...EMPTY_APP_STATE,
        workspaces: { '/ws': { lastWorkflow: 'ship-feature', lastInputs: {} } },
      },
      pendingRunAgain: { workflow: 'deleted-workflow', inputs: { ticket: 'T-1' } },
    });
    const { transport } = renderNewRunDialog();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    // falls back to memory.lastWorkflow since pendingRunAgain's target doesn't exist
    expect(await screen.findByLabelText('Ticket ID', { exact: false })).toHaveValue('');
    // stale request is cleared regardless, so it can't wrongly reapply on a later mount
    expect(useAppStore.getState().pendingRunAgain).toBeNull();
  });

  it('preserves newlines in input values through to startRun', async () => {
    const { transport } = renderNewRunDialog();
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
    const { transport } = renderNewRunDialog();
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
    const { transport } = renderNewRunDialog();
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
    const { transport } = renderNewRunDialog();
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
    const { transport } = renderNewRunDialog();
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
    const { transport } = renderNewRunDialog();
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
    const { transport } = renderNewRunDialog();
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

describe('NewRunDialog max iterations', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [], appState: null, pendingRunAgain: null });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [], appState: null, pendingRunAgain: null });
  });

  it('is offered only for a workflow that actually has a loop', async () => {
    const { transport } = renderNewRunDialog();
    await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW, LOOPING_WORKFLOW]);
    await respond(transport, 'listRuns', []);

    await selectWorkflow(transport, 'ship-feature');
    await screen.findByLabelText('Ticket ID', { exact: false });
    expect(screen.queryByTestId('max-iterations-input')).toBeNull();
  });

  it('sends the override to startRun, and omits it when left blank', async () => {
    const { transport } = renderNewRunDialog();
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
    const { transport } = renderNewRunDialog();
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

describe('NewRunDialog disabled steps', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [], appState: null, pendingRunAgain: null });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [], appState: null, pendingRunAgain: null });
  });

  it('names a disabled loop as one entry naming its size, not one per body step', async () => {
    const { transport } = renderNewRunDialog();
    await respond(transport, 'listWorkflows', [DISABLED_LOOP_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'feature-development');

    const warning = await screen.findByTestId('disabled-steps-warning');
    expect(warning).toHaveTextContent("Disabled: human-review (loop, 4 steps).");
  });

  it('names the consequence for a reader outside the disabled loop, one sentence per lost id', async () => {
    const { transport } = renderNewRunDialog();
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
    const { transport } = renderNewRunDialog();
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

function renderWithCapabilities(capabilities: Partial<AppCapabilities>) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  const onStarted = vi.fn();
  render(
    <CapabilitiesProvider value={{ ...DESKTOP_DEFAULT_CAPABILITIES, ...capabilities }}>
      <AgentClientProvider client={client}>
        <NewRunDialog open onOpenChange={() => {}} onStarted={onStarted} />
      </AgentClientProvider>
    </CapabilitiesProvider>,
  );
  return { transport, onStarted };
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

async function startRunRequest(transport: MockTransport) {
  return waitFor(() => {
    const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === 'startRun');
    if (index === -1) throw new Error('startRun not sent yet');
    return transport.sentRequest(index);
  });
}

describe('NewRunDialog attachments', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let revoked: string[];

  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', workflows: [], appState: null, pendingRunAgain: null });
    // jsdom has no object URLs; the thumbnails only need a distinct string each.
    let n = 0;
    revoked = [];
    URL.createObjectURL = () => `blob:thumb-${++n}`;
    URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, workflows: [], appState: null, pendingRunAgain: null });
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it('has no attach field without a file picker, and ignores a pasted image there', async () => {
    const { transport } = renderNewRunDialog(); // the default capabilities: no pickFiles
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
    const { transport } = renderWithCapabilities({ pickFiles: vi.fn(async () => []) });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');

    const nameInput = await screen.findByTestId('run-name-input');
    expect(paste(nameInput, { files: [pngFile()] })).toBe(false); // taken, not pasted as text

    expect(await screen.findByText('pasted-1.png')).toBeInTheDocument();
    expect(screen.getByTestId('attachment-thumbnail')).toHaveAttribute('src', 'blob:thumb-1');

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

  it('sends picked paths and pasted bytes to startRun, in list order, ignoring a path picked twice', async () => {
    const pickFiles = vi.fn()
      .mockResolvedValueOnce(['/home/me/bug.png', '/home/me/logs/server.log'])
      .mockResolvedValueOnce(['/home/me/bug.png']);
    const { transport, onStarted } = renderWithCapabilities({ pickFiles });
    await respond(transport, 'listWorkflows', [ATTACHING_WORKFLOW]);
    await respond(transport, 'listRuns', []);
    await selectWorkflow(transport, 'triage');

    fireEvent.click(await screen.findByRole('button', { name: 'Add files…' }));
    expect(await screen.findByText('server.log')).toBeInTheDocument();
    expect(screen.getByText('bug.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add files…' }));
    await waitFor(() => expect(pickFiles).toHaveBeenCalledTimes(2));

    paste(screen.getByTestId('run-name-input'), { files: [pngFile()] });
    await screen.findByText('pasted-1.png');
    expect(screen.getAllByRole('button', { name: / Remove$/ })).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    const req = await startRunRequest(transport);
    expect((req.params as { attachments?: unknown }).attachments).toEqual([
      { path: '/home/me/bug.png' },
      { path: '/home/me/logs/server.log' },
      { name: 'pasted-1.png', base64: btoa(String.fromCharCode(...PNG)) },
    ]);

    transport.emitLine({ id: req.id, result: { jobId: 'job-7' } });
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('job-7'));
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
});
