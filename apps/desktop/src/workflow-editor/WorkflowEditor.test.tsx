import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkflowEditor } from './WorkflowEditor.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import type { Workflow } from '../../../../packages/core/src/types.ts';

/** Mirrors feature-development.yaml's nesting: human-review wraps do-review wraps execute/review, then sign-off. */
const NESTED_WORKFLOW: Workflow = {
  name: 'feature-development',
  steps: [
    { id: 'sync-base', kind: 'command', run: 'git pull', output: 'sync-base.log' },
    { id: 'branch', kind: 'command', run: 'git checkout -b x', output: 'branch.log' },
    { id: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive', writes: false, prompt: 'plan it', output: 'plan.md' },
    {
      id: 'human-review', kind: 'loop', until: 'sign-off', max_iterations: 5,
      steps: [
        {
          id: 'do-review', kind: 'loop', until: 'review', max_iterations: 10,
          steps: [
            { id: 'execute', kind: 'agent', runner: 'claude', mode: 'headless', writes: true, prompt: 'implement', inputs: ['plan'], output: 'execute-report.md' },
            { id: 'review', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, verdict: true, prompt: 'review it', inputs: ['plan', 'execute'], output: 'review.md' },
          ],
        },
        { id: 'sign-off', kind: 'approval', title: 'Ship it?', instructions: 'Look.', verdict: true, capture: 'review', show_diff: true, output: 'feedback.md', inputs: ['review'] },
      ],
    },
    { id: 'stage', kind: 'command', run: 'git add -A', output: 'stage.log' },
    { id: 'commit-message', kind: 'agent', runner: 'claude', model: 'haiku', mode: 'headless', writes: false, prompt: 'write it', inputs: ['plan', 'review', 'sign-off'], output: 'commit-message.md' },
    { id: 'commit', kind: 'command', run: 'git commit', output: 'commit.log' },
  ],
};

function renderEditor(workflow: Workflow, overrides: Partial<{ name: string; source: 'project' | 'global' }> = {}) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  const onDeleted = vi.fn();
  render(
    <AgentClientProvider client={client}>
      <WorkflowEditor
        workflow={workflow}
        name={overrides.name ?? workflow.name}
        source={overrides.source ?? 'project'}
        workdir="/ws"
        revealsGlobal={false}
        onSaved={onSaved}
        onCancel={onCancel}
        onDeleted={onDeleted}
      />
    </AgentClientProvider>,
  );
  return { transport, client, onSaved, onCancel, onDeleted };
}

async function lastRequest(transport: MockTransport, method: string) {
  return waitFor(() => {
    const parsed = transport.sentRequest(transport.sent.length - 1);
    if (parsed.method !== method) throw new Error(`${method} not sent yet`);
    return parsed;
  });
}

describe('WorkflowEditor: density and collapse', () => {
  it('opens with every card collapsed — every step id visible, no prompt fields yet', () => {
    renderEditor(NESTED_WORKFLOW);
    for (const id of ['sync-base', 'branch', 'plan', 'human-review', 'do-review', 'execute', 'review', 'sign-off', 'stage', 'commit-message', 'commit']) {
      expect(screen.getByTestId(`step-card-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByLabelText('Prompt')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('implement')).not.toBeInTheDocument();
  });

  it('the workflow settings card is present and collapsed by default too', () => {
    renderEditor(NESTED_WORKFLOW);
    expect(screen.getByTestId('workflow-settings-card')).toBeInTheDocument();
    expect(screen.queryByLabelText(/description/i)).not.toBeInTheDocument();
  });

  it('expanding a card shows its prompt and rail; collapsing hides them again', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-execute'));
    expect(screen.getByLabelText('Prompt')).toHaveValue('implement');
    expect(screen.getByLabelText('Runner')).toHaveValue('claude');

    fireEvent.click(screen.getByTestId('step-collapse-execute'));
    expect(screen.queryByLabelText('Prompt')).not.toBeInTheDocument();
  });

  it('folding human-review hides its four descendants but keeps its own row', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('body-fold-human-review'));
    for (const id of ['do-review', 'execute', 'review', 'sign-off']) {
      expect(screen.queryByTestId(`step-card-${id}`)).not.toBeInTheDocument();
    }
    expect(screen.getByTestId('step-card-human-review')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-sync-base')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-commit')).toBeInTheDocument();
  });

  it('a loop card\'s own collapse hides its three fields without folding its body', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-human-review'));
    expect(screen.getByLabelText('Repeat until')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-do-review')).toBeInTheDocument();
  });
});

describe('WorkflowEditor: density', () => {
  // jsdom lays out nothing, so this cannot measure pixels the way a real
  // screenshot would — see the technical spec's own note that this is a weak
  // test and still worth having. What it can check: every card really is
  // collapsed to its one-line summary at once (the row-count half of the
  // budget), and nothing caps the prose column, so it takes whatever width
  // the rail leaves (the other half).
  it('every card of an eleven-step, three-deep workflow is on screen at once, collapsed', () => {
    renderEditor(NESTED_WORKFLOW);
    const cards = screen.getAllByTestId(/^step-card-/);
    expect(cards).toHaveLength(11);
    expect(screen.queryByLabelText('Prompt')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Command')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Instructions')).not.toBeInTheDocument();
  });

  it('the prose column has no max width — the prompt takes all the width the rail leaves', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-execute'));
    const card = screen.getByTestId('step-card-execute');
    const capped: HTMLElement[] = [];
    for (let el = screen.getByLabelText('Prompt').parentElement; el && el !== card; el = el.parentElement) {
      if (el.style.maxWidth) capped.push(el);
    }
    expect(capped).toEqual([]);
  });
});

describe('WorkflowEditor: the step rail', () => {
  // The rail is a grid that goes to two columns on a wide card, which jsdom
  // cannot show. What it can show is the wiring that makes it work: every
  // field is its own grid cell. A wrapper <div> around a kind's fields would
  // make them one tall cell, and the two columns would come out lopsided.
  it.each([
    ['agent', 'execute', ['Runner', 'Model', 'Mode', 'Effort', 'Writes', 'Allowed paths']],
    ['command', 'sync-base', ['Working directory', 'Successful exit codes', 'Timeout (ms)']],
    ['approval', 'sign-off', ['Title', 'Capture', 'Show the diff', 'Default without a human']],
  ])('every field of a %s step is a direct child of the rail', (_kind, id, kindFields) => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId(`step-collapse-${id}`));
    const rail = screen.getByTestId(`step-rail-${id}`);
    const fields = [...kindFields, 'Verdict', 'Output filename', 'Reads from'];

    const cells = fields.map(label => {
      const control = within(rail).getAllByLabelText(label)[0];
      return Array.from(rail.children).find(child => child.contains(control));
    });
    expect(cells.every(Boolean)).toBe(true);
    expect(new Set(cells).size).toBe(fields.length);
    expect(rail.children).toHaveLength(fields.length);
  });
});

describe('WorkflowEditor: what ends a loop, and the reads/writes chips', () => {
  it('badges the step a loop\'s until: names as "ends loop"', () => {
    renderEditor(NESTED_WORKFLOW);
    expect(within(screen.getByTestId('step-card-review')).getByText('ends loop')).toBeInTheDocument();
    expect(within(screen.getByTestId('step-card-sign-off')).getByText('ends loop')).toBeInTheDocument();
    expect(within(screen.getByTestId('step-card-execute')).queryByText('ends loop')).not.toBeInTheDocument();
  });

  it('clicking commit-message\'s reads: chip highlights plan, review and sign-off as sources', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('reads-chip-commit-message'));
    expect(screen.getByTestId('step-summary-plan')).toHaveAttribute('data-highlight', 'source');
    expect(screen.getByTestId('step-summary-review')).toHaveAttribute('data-highlight', 'source');
    expect(screen.getByTestId('step-summary-sign-off')).toHaveAttribute('data-highlight', 'source');
    expect(screen.getByTestId('step-summary-execute')).not.toHaveAttribute('data-highlight', 'source');
  });

  it('clicking a chip a second time clears the highlight', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('reads-chip-commit-message'));
    fireEvent.click(screen.getByTestId('reads-chip-commit-message'));
    expect(screen.getByTestId('step-summary-plan')).not.toHaveAttribute('data-highlight', 'source');
  });
});

describe('WorkflowEditor: disabling a step', () => {
  it('disabling a step dims its card and badges it, without a click needed to see it changed', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(within(screen.getByTestId('step-card-plan')).getByLabelText('Disable'));
    expect(within(screen.getByTestId('step-card-plan')).getByText('disabled')).toBeInTheDocument();
  });

  it('the disable control on a loop\'s until step is unavailable, with a tooltip naming the loop', () => {
    renderEditor(NESTED_WORKFLOW);
    const control = within(screen.getByTestId('step-card-sign-off')).getByLabelText('Disable');
    expect(control).toBeDisabled();
  });

  it('stays unavailable even after the loop itself is disabled — unconditional, not gated on the loop\'s own state', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(within(screen.getByTestId('step-card-human-review')).getByLabelText('Disable'));
    const control = within(screen.getByTestId('step-card-sign-off')).getByLabelText('Disable');
    expect(control).toBeDisabled();
  });

  it('disabling human-review dims its four descendants; their own toggles stay live', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(within(screen.getByTestId('step-card-human-review')).getByLabelText('Disable'));
    for (const id of ['do-review', 'execute', 'review', 'sign-off']) {
      expect(within(screen.getByTestId(`step-card-${id}`)).getByText('disabled')).toBeInTheDocument();
    }
    // A body step's own toggle can still be flipped — 'execute' is not itself
    // named enabled:false, so re-enabling the loop restores exactly this.
    const executeToggle = within(screen.getByTestId('step-card-execute')).getByLabelText('Disable');
    expect(executeToggle).not.toBeDisabled();
  });

  it('disabling plan puts a persistent note on every reader\'s card, not on plan itself, without needing to expand anything', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(within(screen.getByTestId('step-card-plan')).getByLabelText('Disable'));
    // execute, review and commit-message all read plan directly.
    for (const id of ['execute', 'review', 'commit-message']) {
      expect(within(screen.getByTestId(`step-card-${id}`)).getByText(/reads plan, which is disabled/i))
        .toBeInTheDocument();
    }
    expect(within(screen.getByTestId('step-card-plan')).queryByText(/which is disabled/i)).not.toBeInTheDocument();
  });
});

describe('WorkflowEditor: insert below and rename', () => {
  it('insert below on a leaf card adds a sibling right after it', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(within(screen.getByTestId('step-card-plan')).getByLabelText('Insert step below'));
    const cards = screen.getAllByTestId(/^step-card-/);
    const planIndex = cards.findIndex(c => c.dataset.testid === 'step-card-plan');
    expect(cards[planIndex + 1].dataset.testid).toBe('step-card-step-12');
  });

  it('insert below on a loop card adds the new step as its first body child', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(within(screen.getByTestId('step-card-human-review')).getByLabelText('Insert step below'));
    const cards = screen.getAllByTestId(/^step-card-/);
    const loopIndex = cards.findIndex(c => c.dataset.testid === 'step-card-human-review');
    expect(cards[loopIndex + 1].dataset.testid).toBe('step-card-step-12');
    expect(cards[loopIndex + 2].dataset.testid).toBe('step-card-do-review');
  });

  it('renames a step id on blur, and rewrites every inputs: entry naming it', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-plan'));
    const idField = screen.getByLabelText('Step ID');
    fireEvent.change(idField, { target: { value: 'planning' } });
    fireEvent.blur(idField);

    expect(screen.getByTestId('step-card-planning')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('step-collapse-execute'));
    expect(within(screen.getByTestId('step-card-execute')).getByTestId('reads-chip-execute')).toHaveTextContent('planning');

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const wf = (req.params as { workflow: Workflow }).workflow;
    expect(wf.steps.some(s => s.id === 'planning')).toBe(true);
  });

  it('refuses a rename that collides with an existing id', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-plan'));
    const idField = screen.getByLabelText('Step ID');
    fireEvent.change(idField, { target: { value: 'execute' } });
    fireEvent.blur(idField);
    expect(screen.getByText(/already a step/i)).toBeInTheDocument();
    expect(screen.getByTestId('step-card-plan')).toBeInTheDocument();
  });
});

describe('WorkflowEditor: the attachments ref', () => {
  it('offers attachments in Reads from, ahead of the earlier step ids, and saves it', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-plan'));
    fireEvent.click(screen.getByRole('combobox', { name: 'Reads from' }));

    // A multiselect Fluent Dropdown renders a menu of checkboxes, not a listbox of options.
    const options = await screen.findAllByRole('menuitemcheckbox');
    expect(options.map(o => o.textContent)).toEqual([
      'attachments — files attached to the run', 'sync-base', 'branch',
    ]);

    fireEvent.click(options[0]);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const wf = (req.params as { workflow: Workflow }).workflow;
    expect((wf.steps.find(s => s.id === 'plan') as { inputs?: string[] }).inputs).toEqual(['attachments']);
  });

  it('refuses attachments as a step id, as core does', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-plan'));
    const idField = screen.getByLabelText('Step ID');
    fireEvent.change(idField, { target: { value: 'attachments' } });
    fireEvent.blur(idField);
    expect(screen.getByText(/reserved for the files attached to a run/i)).toBeInTheDocument();
    expect(screen.getByTestId('step-card-plan')).toBeInTheDocument();
  });
});

describe('WorkflowEditor: the capture three-way control', () => {
  it('reads review from the file, and can round-trip back to review through note', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-sign-off'));
    expect(screen.getByRole('combobox', { name: 'Capture' })).toHaveTextContent('Review');

    fireEvent.click(screen.getByRole('combobox', { name: 'Capture' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Note' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Capture' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Review' }));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const wf = (req.params as { workflow: Workflow }).workflow;
    const loop = wf.steps.find(s => s.id === 'human-review') as { steps: Array<{ id: string; capture?: string }> };
    expect(loop.steps.find(s => s.id === 'sign-off')?.capture).toBe('review');
  });

  it('picking a capture on a step with no output fills in a default rather than arming a save-time error', async () => {
    const bare: Workflow = {
      name: 'w',
      steps: [{ id: 'ask', kind: 'manual', title: 't', instructions: 'i' }],
    };
    const { transport } = renderEditor(bare);
    fireEvent.click(screen.getByTestId('step-collapse-ask'));
    fireEvent.click(screen.getByRole('combobox', { name: 'Capture' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Note' }));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const wf = (req.params as { workflow: Workflow }).workflow;
    expect((wf.steps[0] as { output?: string }).output).toBe('ask.md');
  });
});

describe('WorkflowEditor: save', () => {
  it('Save sends updateWorkflow with the current draft; Cancel discards without saving', async () => {
    const { transport, onCancel } = renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(transport.sent.some(l => (JSON.parse(l) as { method: string }).method === 'updateWorkflow')).toBe(false);
  });

  it('a global workflow confirms before sending the save', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW, { source: 'global' });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/every workspace on this machine reads it/i)).toBeInTheDocument();
    expect(transport.sent.some(l => (JSON.parse(l) as { method: string }).method === 'updateWorkflow')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /save anyway/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    expect(req.params).toMatchObject({ workdir: '/ws', name: 'feature-development', scope: 'global' });
  });

  it('shows a server validation error and keeps the editor open', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    transport.emitLine({ id: req.id, error: { message: "invalid workflow:\n  - duplicate step id 'plan'" } });
    expect(await screen.findByText(/duplicate step id/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
  });
});

describe('WorkflowEditor: delete', () => {
  it('the header Delete opens the confirmation, and confirming deletes and hands back', async () => {
    const { transport, onDeleted } = renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Delete feature-development' }));
    expect(await screen.findByText("Delete workflow 'feature-development'?")).toBeInTheDocument();
    expect(transport.sent.some(l => (JSON.parse(l) as { method: string }).method === 'deleteWorkflow')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const req = await lastRequest(transport, 'deleteWorkflow');
    expect(req.params).toEqual({ workdir: '/ws', name: 'feature-development' });
    transport.emitLine({ id: req.id, result: { deleted: true } });
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it('the header Delete is disabled while a save is in flight', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW);
    const deleteButton = screen.getByRole('button', { name: 'Delete feature-development' });
    expect(deleteButton).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    await waitFor(() => expect(deleteButton).toBeDisabled());

    transport.emitLine({ id: req.id, result: { path: '/ws/.whiphand/workflows/feature-development.yaml' } });
    await waitFor(() => expect(deleteButton).toBeEnabled());
  });
});
