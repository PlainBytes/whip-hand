import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkflowEditor } from './WorkflowEditor.tsx';
import { convertStep } from './StepRail.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import type { AgentStep, Step, Workflow } from '../shared/types.ts';
import type { DoctorResult, ListModelsResult, ValidateWorkflowResult } from '../shared/protocol.gen.ts';
import { hasInjectedStyle } from '../test/badge-style.ts';
import { answerValidation, type Validator } from '../test/validation.ts';

function flattenSteps(steps: Step[]): Step[] {
  return steps.flatMap(s => ('steps' in s ? [s, ...flattenSteps(s.steps)] : [s]));
}

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

function renderEditor(
  workflow: Workflow,
  overrides: Partial<{ name: string; source: 'project' | 'global'; validator: Validator }> = {},
) {
  const transport = new MockTransport();
  answerValidation(transport, overrides.validator);
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
    // Required fields carry Fluent's own "*" marker on the label text —
    // matched with a prefix regex rather than the bare word.
    expect(screen.getByLabelText(/^Prompt/)).toHaveValue('implement');
    expect(screen.getByLabelText(/^Runner/)).toHaveTextContent('claude');

    fireEvent.click(screen.getByTestId('step-collapse-execute'));
    expect(screen.queryByLabelText(/^Prompt/)).not.toBeInTheDocument();
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
    for (let el = screen.getByLabelText(/^Prompt/).parentElement; el && el !== card; el = el.parentElement) {
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
    ['agent', 'execute', ['Runner', 'Model', 'Mode', 'Effort', 'Writes', 'Allow commits', 'Allowed paths']],
    ['command', 'sync-base', ['Working directory', 'Successful exit codes', 'Timeout (ms)']],
    ['approval', 'sign-off', ['Title', 'Capture', 'Show the diff', 'Default without a human']],
  ])('every field of a %s step is a direct child of the rail', (_kind, id, kindFields) => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId(`step-collapse-${id}`));
    const rail = screen.getByTestId(`step-rail-${id}`);
    const fields = [...kindFields, 'Verdict', 'Output filename', 'Reads from'];

    const cells = fields.map(label => {
      // A few fields carry Fluent's own "*" required marker on the label
      // text — matched with an optional-suffix regex rather than the bare
      // word (anchored at both ends, so e.g. "Mode" cannot match "Model").
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const control = within(rail).getAllByLabelText(new RegExp(`^${escaped}\\*?$`))[0];
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

  it('the Allow commits switch saves allow_commits: true on an agent step', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-plan'));
    const toggle = within(screen.getByTestId('step-rail-plan')).getByLabelText('Allow commits');
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const plan = (req.params as { workflow: Workflow }).workflow.steps.find(s => s.id === 'plan') as AgentStep;
    expect(plan.allow_commits).toBe(true);
  });

  it('switching Allow commits off drops the key rather than saving allow_commits: false', async () => {
    const workflow: Workflow = {
      ...NESTED_WORKFLOW,
      steps: NESTED_WORKFLOW.steps.map(s => (s.id === 'plan' ? { ...s, allow_commits: true } as Step : s)),
    };
    const { transport } = renderEditor(workflow);
    fireEvent.click(screen.getByTestId('step-collapse-plan'));
    const toggle = within(screen.getByTestId('step-rail-plan')).getByLabelText('Allow commits');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const plan = (req.params as { workflow: Workflow }).workflow.steps.find(s => s.id === 'plan') as AgentStep;
    expect(plan.allow_commits).toBeUndefined();
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

  it('removing a card with a pending Step ID error clears it — Save is not stuck blocked forever', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-stage'));
    const idField = screen.getByLabelText('Step ID');
    fireEvent.change(idField, { target: { value: 'commit' } });
    fireEvent.blur(idField);
    expect(screen.getByText(/already a step/i)).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId('step-card-stage')).getByLabelText('Remove step'));
    expect(screen.queryByTestId('step-card-stage')).not.toBeInTheDocument();
    expect(screen.queryByText(/already a step/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await lastRequest(transport, 'updateWorkflow');
  });

  it('renders Remove step in subtle red', () => {
    renderEditor(NESTED_WORKFLOW);
    const buttons = screen.getAllByLabelText('Remove step');
    for (const b of buttons) {
      expect(hasInjectedStyle(b, 'color', 'var(--colorPaletteRedForeground1)')).toBe(true);
    }
  });

  it('collapsing a card with a pending Step ID error clears it, instead of leaving Save stuck', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-stage'));
    const idField = screen.getByLabelText('Step ID');
    fireEvent.change(idField, { target: { value: '' } });
    fireEvent.blur(idField);
    expect(screen.getByText(/an id is required/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('step-collapse-stage'));
    expect(screen.queryByText(/an id is required/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await lastRequest(transport, 'updateWorkflow');
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
    const bar = await screen.findByText(/duplicate step id/i);
    // The error bar lives in the scrolling body, not the fixed-height header.
    expect(screen.getByTestId('page-body')).toContainElement(bar);
    expect(screen.getByTestId('page-header')).not.toContainElement(bar);
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
  });
});

describe('WorkflowEditor: header actions', () => {
  it('Delete, Cancel and Save sit in the header with the title, in that order, and Delete is red', () => {
    renderEditor(NESTED_WORKFLOW);
    const title = screen.getByText(/Edit workflow:/);
    const del = screen.getByRole('button', { name: 'Delete feature-development' });
    const cancel = screen.getByRole('button', { name: /^cancel$/i });
    const save = screen.getByRole('button', { name: /^save$/i });
    const header = title.parentElement!.parentElement!;
    for (const b of [del, cancel, save]) expect(header).toContainElement(b);
    const order = Array.from(header.querySelectorAll('button')).filter(b => [del, cancel, save].includes(b));
    expect(order).toEqual([del, cancel, save]);
    expect(hasInjectedStyle(del, 'background-color', 'var(--colorPaletteRedBackground3)')).toBe(true);
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

// --- what the agent's validator answers, recorded from whiphand-agent -------

type FieldProblem = ValidateWorkflowResult['fieldProblems'][number];

/** One field problem, worded as the Rust validator words it. */
function fieldProblem(stepId: string, field: string, phrase: string, message: string): FieldProblem {
  return { stepId, field, phrase, message };
}

/** A validator that reports whichever of `checks` apply to the draft. */
function reporting(...checks: Array<(steps: Step[]) => FieldProblem | null>): Validator {
  return draft => {
    const fieldProblems = checks.flatMap(check => check(flattenSteps(draft.steps)) ?? []);
    return { workflow: draft, problems: fieldProblems.map(p => p.message), fieldProblems };
  };
}

const field = (steps: Step[], id: string, key: string): unknown =>
  (steps.find(s => s.id === id) as unknown as Record<string, unknown> | undefined)?.[key];
const blank = (v: unknown): boolean => v === undefined || v === '';

const NEW_STEP_PROBLEMS = reporting(
  steps => (blank(field(steps, 'step-12', 'prompt')) ? fieldProblem('step-12', 'prompt', 'is required', "step 'step-12': Prompt is required") : null),
  steps => (blank(field(steps, 'step-12', 'output'))
    ? fieldProblem('step-12', 'output', 'is required', "step 'step-12': Output filename is required") : null),
);

describe('WorkflowEditor: save-time validation', () => {
  it('Add step, Kind command, type Command, Save: updateWorkflow is called and the payload has no output key', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    const newCard = screen.getByTestId('step-card-step-12');
    fireEvent.click(within(newCard).getByRole('combobox', { name: 'Kind' }));
    fireEvent.click(await screen.findByRole('option', { name: 'command' }));
    fireEvent.change(within(newCard).getByLabelText(/^Command/), { target: { value: 'npm test' } });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const wf = (req.params as { workflow: Workflow }).workflow;
    const step = wf.steps.find(s => s.id === 'step-12') as unknown as Record<string, unknown>;
    expect('output' in step).toBe(false);
  });

  it('Save with a blank Prompt: no request is sent, the card expands, the field itself is flagged, and the problem list names it', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW, { validator: NEW_STEP_PROBLEMS });
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(transport.sent.some(l => (JSON.parse(l) as { method: string }).method === 'updateWorkflow')).toBe(false);

    // The new agent step's card auto-expands to show the blank Prompt.
    const prompt = await screen.findByLabelText(/^Prompt/);
    expect(prompt).toBeInTheDocument();
    expect(prompt).toHaveAttribute('aria-invalid', 'true');
    const problem = screen.getByText(/step 'step-12': Prompt/);
    expect(screen.getByTestId('page-body')).toContainElement(problem);
    expect(screen.getByTestId('page-header')).not.toContainElement(problem);

    fireEvent.change(prompt, { target: { value: 'do it' } });
    fireEvent.change(screen.getByLabelText(/^Output filename/), { target: { value: 'step-12.md' } });
    await waitFor(() => expect(screen.queryByText(/step 'step-12': Prompt/)).not.toBeInTheDocument());
    expect(prompt).not.toHaveAttribute('aria-invalid', 'true');

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await lastRequest(transport, 'updateWorkflow');
  });

  it('a blank Prompt and Output filename on the same step both show up as separate problem-list lines', async () => {
    renderEditor(NESTED_WORKFLOW, { validator: NEW_STEP_PROBLEMS });
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/step 'step-12': Output filename is required/)).toBeInTheDocument();
    expect(screen.getByText(/step 'step-12': Prompt is required/)).toBeInTheDocument();
  });

  it('convertStep: an agent with output: \'\' converted to command has no output key', () => {
    const agent: AgentStep = {
      kind: 'agent', id: 'a', runner: 'claude', mode: 'headless', writes: false, prompt: 'p', output: '',
    };
    const command = convertStep(agent, 'command') as unknown as Record<string, unknown>;
    expect('output' in command).toBe(false);
  });

  it('convertStep: a non-blank output survives a kind switch', () => {
    const agent: AgentStep = {
      kind: 'agent', id: 'a', runner: 'claude', mode: 'headless', writes: false, prompt: 'p', output: 'out.md',
    };
    const command = convertStep(agent, 'command') as { output?: string };
    expect(command.output).toBe('out.md');
  });

  it('typing "src, docs" into Allowed paths keeps the comma while typing, and commits the parsed array', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-execute'));
    const field = screen.getByLabelText(/^Allowed paths/);
    fireEvent.change(field, { target: { value: 'src, docs' } });
    expect(field).toHaveValue('src, docs');

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const wf = (req.params as { workflow: Workflow }).workflow;
    const execute = flattenSteps(wf.steps).find(s => s.id === 'execute') as { allow_paths?: string[] };
    expect(execute.allow_paths).toEqual(['src', 'docs']);
  });

  it('an exit-code token that is not an integer shows an inline error instead of silently dropping it', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-sync-base'));
    const field = screen.getByLabelText(/^Successful exit codes/);
    fireEvent.change(field, { target: { value: '0, abc' } });
    expect(screen.getByText(/whole numbers/i)).toBeInTheDocument();
    expect(field).toHaveValue('0, abc');
  });

  it('the Verdict switch is disabled on a loop\'s until target, and Repeat until lists only verdict steps', () => {
    renderEditor(NESTED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-review'));
    const rail = screen.getByTestId('step-rail-review');
    expect(within(rail).getByLabelText(/^Verdict/)).toBeDisabled();

    fireEvent.click(screen.getByTestId('step-collapse-do-review'));
    fireEvent.click(within(screen.getByTestId('step-card-do-review')).getByRole('combobox', { name: 'Repeat until' }));
    const options = screen.getAllByRole('option').map(o => o.textContent);
    expect(options).toEqual(['review']); // 'execute' has no verdict, so it is not offered
  });

  it('Save reveals and badges a reader whose reference is broken, not just a problem-list line pointing nowhere', async () => {
    const refWorkflow: Workflow = {
      name: 'w',
      steps: [
        { id: 'a', kind: 'command', run: 'echo hi', output: 'a.log' },
        {
          id: 'b', kind: 'agent', runner: 'claude', mode: 'headless', writes: false,
          prompt: 'p', inputs: ['a'], output: 'b.md',
        },
      ],
    };
    const { transport } = renderEditor(refWorkflow, {
      validator: reporting(steps => (blank(field(steps, 'a', 'output'))
        ? fieldProblem(
          'b', 'inputs', "references step 'a', which produces no artifact",
          "step 'b' references step 'a', which produces no artifact",
        ) : null)),
    });
    fireEvent.click(screen.getByTestId('step-collapse-a'));
    fireEvent.change(screen.getByLabelText(/^Output filename/), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('step-collapse-a'));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(transport.sent.some(l => (JSON.parse(l) as { method: string }).method === 'updateWorkflow')).toBe(false);
    expect(
      await screen.findByText(/step 'b' references step 'a', which produces no artifact/),
    ).toBeInTheDocument();

    // The reference problem names 'b', not 'a' — Save must reveal and badge
    // b's card, and mark its Reads from field, not leave it collapsed with
    // only the problem-list line to go on.
    const readsFrom = within(screen.getByTestId('step-card-b')).getByRole('combobox', { name: 'Reads from' });
    expect(readsFrom).toHaveAttribute('aria-invalid', 'true');
    expect(within(screen.getByTestId('step-summary-b')).getByText(/1 problem/)).toBeInTheDocument();
  });

  it('Save reveals and badges a manual step whose capture has lost its output', async () => {
    const captureWorkflow: Workflow = {
      name: 'w',
      steps: [
        { id: 'a', kind: 'command', run: 'echo hi', output: 'a.log' },
        { id: 'm', kind: 'manual', title: 't', instructions: 'i', capture: 'note', output: 'm.md' },
      ],
    };
    const { transport } = renderEditor(captureWorkflow, {
      validator: reporting(steps => (blank(field(steps, 'm', 'output'))
        ? fieldProblem(
          'm', 'output', "capture 'note' needs an 'output' to write it to",
          "step 'm': capture 'note' needs an 'output' to write it to",
        ) : null)),
    });
    fireEvent.click(screen.getByTestId('step-collapse-m'));
    fireEvent.change(screen.getByLabelText(/^Output filename/), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('step-collapse-m'));
    expect(screen.queryByLabelText(/^Output filename/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(transport.sent.some(l => (JSON.parse(l) as { method: string }).method === 'updateWorkflow')).toBe(false);
    expect(
      await screen.findByText(/step 'm': capture 'note' needs an 'output' to write it to/),
    ).toBeInTheDocument();

    const output = within(screen.getByTestId('step-card-m')).getByLabelText(/^Output filename/);
    expect(output).toHaveAttribute('aria-invalid', 'true');
    expect(within(screen.getByTestId('step-summary-m')).getByText(/1 problem/)).toBeInTheDocument();
  });
});

// --- the harness catalog: Runner dropdown, Model combobox -----------------

function sentMethods(transport: MockTransport): string[] {
  return transport.sent.map(l => (JSON.parse(l) as { method: string }).method);
}

const runnerRow = (id: string): DoctorResult[number] => (
  { id, label: id, group: 'harness', runner: true, optional: false, installed: true }
);

const oneStepWorkflow = (step: Partial<AgentStep> & { id: string }): Workflow => ({
  name: 'w',
  steps: [{
    kind: 'agent', mode: 'headless', writes: false, prompt: 'p', output: `${step.id}.md`,
    runner: 'claude', ...step,
  } as AgentStep],
});

describe('WorkflowEditor: harness catalog prefetch', () => {
  afterEach(() => {
    useAppStore.setState({ doctorResult: null, modelCatalog: null });
  });

  it('a pre-filled store sends neither a doctor nor a listModels request', () => {
    useAppStore.setState({
      doctorResult: [runnerRow('claude')],
      modelCatalog: { claude: { source: 'live', models: [{ id: 'sonnet' }] } },
    });
    const { transport } = renderEditor(NESTED_WORKFLOW);
    expect(sentMethods(transport)).not.toContain('doctor');
    expect(sentMethods(transport)).not.toContain('listModels');
  });

  it('an empty store sends exactly one doctor and one listModels request on mount', async () => {
    const { transport } = renderEditor(NESTED_WORKFLOW);
    await waitFor(() => {
      const methods = sentMethods(transport);
      expect(methods.filter(m => m === 'doctor')).toHaveLength(1);
      expect(methods.filter(m => m === 'listModels')).toHaveLength(1);
    });
  });
});

describe('WorkflowEditor: the Runner dropdown', () => {
  afterEach(() => {
    useAppStore.setState({ doctorResult: null, modelCatalog: null });
  });

  it('offers doctor\'s runner rows, keeps an unknown current value, and warns about it', async () => {
    useAppStore.setState({
      doctorResult: [runnerRow('claude'), runnerRow('copilot')],
      modelCatalog: {},
    });
    renderEditor(oneStepWorkflow({ id: 'a', runner: 'claud' }));
    fireEvent.click(screen.getByTestId('step-collapse-a'));

    const runnerField = screen.getByRole('combobox', { name: /^Runner/ });
    expect(runnerField).toHaveTextContent('claud');
    expect(screen.getByText(/'claud' isn't a runner whiphand can drive/)).toBeInTheDocument();

    fireEvent.click(runnerField);
    const options = (await screen.findAllByRole('option')).map(o => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['claude', 'copilot', 'claud']));
  });

  it('before doctor answers, only the step\'s own current runner is offered — nothing is lost, no warning', () => {
    renderEditor(oneStepWorkflow({ id: 'a', runner: 'claud' }));
    fireEvent.click(screen.getByTestId('step-collapse-a'));
    expect(screen.queryByText(/isn't a runner whiphand can drive/)).not.toBeInTheDocument();
  });
});

describe('WorkflowEditor: the Model combobox', () => {
  afterEach(() => {
    useAppStore.setState({ doctorResult: null, modelCatalog: null });
  });

  it('warns for a value not in a live list, but not for a value matching a `resolves`', () => {
    useAppStore.setState({
      doctorResult: [runnerRow('claude')],
      modelCatalog: {
        claude: { source: 'live', models: [{ id: 'sonnet', label: 'Sonnet', resolves: 'claude-sonnet-5' }] },
      } satisfies ListModelsResult,
    });
    renderEditor(oneStepWorkflow({ id: 'a', model: 'opsu' }));
    fireEvent.click(screen.getByTestId('step-collapse-a'));
    expect(screen.getByText(/'opsu' isn't in claude's model list/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: 'claude-sonnet-5' } });
    expect(screen.queryByText(/isn't in claude's model list/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: 'sonnet' } });
    expect(screen.queryByText(/isn't in claude's model list/)).not.toBeInTheDocument();
  });

  it('never warns while the catalog has not answered yet, or once it reports unavailable', () => {
    renderEditor(oneStepWorkflow({ id: 'a', model: 'opsu' }));
    fireEvent.click(screen.getByTestId('step-collapse-a'));
    expect(screen.queryByText(/isn't in claude's model list/)).not.toBeInTheDocument();

    act(() => {
      useAppStore.setState({ modelCatalog: { claude: { source: 'unavailable', models: [] } } });
    });
    expect(screen.queryByText(/isn't in claude's model list/)).not.toBeInTheDocument();
  });

  it('never warns for a runner absent from the catalog (no listModels capability)', () => {
    useAppStore.setState({ modelCatalog: {} });
    renderEditor(oneStepWorkflow({ id: 'a', model: 'anything-at-all' }));
    fireEvent.click(screen.getByTestId('step-collapse-a'));
    expect(screen.queryByText(/isn't in claude's model list/)).not.toBeInTheDocument();
  });

  it('a fallback list still warns, and shows its note', () => {
    useAppStore.setState({
      modelCatalog: {
        claude: { source: 'fallback', models: [{ id: 'sonnet' }], note: "couldn't query claude; showing built-in aliases" },
      },
    });
    renderEditor(oneStepWorkflow({ id: 'a', model: 'opsu' }));
    fireEvent.click(screen.getByTestId('step-collapse-a'));
    expect(screen.getByText(/'opsu' isn't in claude's model list/)).toBeInTheDocument();
    expect(screen.getByText(/couldn't query claude; showing built-in aliases/)).toBeInTheDocument();
  });

  it('picking "Default" blanks the field, and the blank is what gets saved', async () => {
    const { transport } = renderEditor(oneStepWorkflow({ id: 'a', model: 'sonnet' }));
    fireEvent.click(screen.getByTestId('step-collapse-a'));
    const modelField = screen.getByRole('combobox', { name: /^Model/ });
    fireEvent.click(modelField);
    fireEvent.click(await screen.findByRole('option', { name: 'Default' }));
    expect(modelField).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const wf = (req.params as { workflow: Workflow }).workflow;
    expect((wf.steps[0] as AgentStep).model).toBeUndefined();
  });

  it('typed free text is committed as-is and survives a save round-trip', async () => {
    const { transport } = renderEditor(oneStepWorkflow({ id: 'a' }));
    fireEvent.click(screen.getByTestId('step-collapse-a'));
    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: 'my-custom-model' } });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const wf = (req.params as { workflow: Workflow }).workflow;
    expect((wf.steps[0] as AgentStep).model).toBe('my-custom-model');
  });

  it('switching runner keeps the model value; only the warning changes', async () => {
    useAppStore.setState({
      doctorResult: [runnerRow('claude'), runnerRow('copilot')],
      modelCatalog: {
        claude: { source: 'live', models: [{ id: 'sonnet' }] },
        copilot: { source: 'live', models: [{ id: 'gpt-5-mini' }] },
      },
    });
    renderEditor(oneStepWorkflow({ id: 'a', runner: 'claude', model: 'gpt-5-mini' }));
    fireEvent.click(screen.getByTestId('step-collapse-a'));
    expect(screen.getByText(/'gpt-5-mini' isn't in claude's model list/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('combobox', { name: /^Runner/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'copilot' }));

    expect(screen.getByRole('combobox', { name: /^Model/ })).toHaveValue('gpt-5-mini');
    expect(screen.queryByText(/isn't in claude's model list/)).not.toBeInTheDocument();
    expect(screen.queryByText(/isn't in copilot's model list/)).not.toBeInTheDocument();
  });

  it('a "Refresh list" action re-requests listModels with refresh: true', async () => {
    useAppStore.setState({ modelCatalog: { claude: { source: 'live', models: [] } } });
    const { transport } = renderEditor(oneStepWorkflow({ id: 'a' }));
    fireEvent.click(screen.getByTestId('step-collapse-a'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));

    const req = await lastRequest(transport, 'listModels');
    expect(req.params).toEqual({ refresh: true });
  });
});

describe('WorkflowEditor: a stages step', () => {
  const STAGED_WORKFLOW: Workflow = {
    name: 'staged',
    inputs: { plan_dir: { required: true } },
    steps: [
      { id: 'plan', kind: 'command', run: 'ls', output: 'plan.md' },
      {
        id: 'build', kind: 'stages', items: 'plans/*.md', max_retries: 2,
        steps: [
          { id: 'impl', kind: 'agent', runner: 'claude', mode: 'headless', writes: true, prompt: 'build', inputs: ['stage', 'plan'], output: 'impl.md' },
          { id: 'gate', kind: 'approval', title: 'Good?', instructions: 'Look.' },
        ],
      },
      { id: 'after', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'wrap up', inputs: ['plan'], output: 'after.md' },
    ],
  };

  async function readsFromOptions(id: string): Promise<string[]> {
    fireEvent.click(screen.getByTestId(`step-collapse-${id}`));
    fireEvent.click(within(screen.getByTestId(`step-card-${id}`)).getByRole('combobox', { name: 'Reads from' }));
    const options = await screen.findAllByRole('menuitemcheckbox');
    return options.map(o => o.textContent ?? '');
  }

  it('a stages step edits its glob and retries, and holds a body', async () => {
    const { transport } = renderEditor(STAGED_WORKFLOW);
    // Its body is cards in the list, one level in, like a loop's.
    expect(screen.getByTestId('step-card-impl')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-gate')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('step-collapse-build'));
    const card = screen.getByTestId('step-card-build');
    expect(within(card).getByLabelText(/^Stage files/)).toHaveValue('plans/*.md');
    expect(within(card).queryByLabelText('Repeat until')).not.toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText(/^Stage files/), { target: { value: '{{ inputs.plan_dir }}/*.md' } });
    fireEvent.change(within(card).getByLabelText(/^Max retries/), { target: { value: '4' } });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const wf = (req.params as { workflow: Workflow }).workflow;
    expect(wf.steps[1]).toMatchObject({
      kind: 'stages', items: '{{ inputs.plan_dir }}/*.md', max_retries: 4,
      steps: [{ id: 'impl' }, { id: 'gate' }],
    });
  });

  it('Max retries takes 0 — no retries — keeps it in the field, and saves it', async () => {
    const { transport } = renderEditor(STAGED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-build'));
    const field = within(screen.getByTestId('step-card-build')).getByLabelText(/^Max retries/);
    fireEvent.change(field, { target: { value: '0' } });
    expect(field).toHaveValue('0');

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const wf = (req.params as { workflow: Workflow }).workflow;
    expect(wf.steps[1]).toMatchObject({ kind: 'stages', max_retries: 0 });
  });

  it('a blank Stage files is flagged on the field at Save', async () => {
    const { transport } = renderEditor(STAGED_WORKFLOW, {
      validator: reporting(steps => (blank(field(steps, 'build', 'items'))
        ? fieldProblem('build', 'items', 'is required', "step 'build': Stage files is required") : null)),
    });
    fireEvent.click(screen.getByTestId('step-collapse-build'));
    fireEvent.change(screen.getByLabelText(/^Stage files/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(transport.sent.some(l => (JSON.parse(l) as { method: string }).method === 'updateWorkflow')).toBe(false);
    await waitFor(() => expect(screen.getByLabelText(/^Stage files/)).toHaveAttribute('aria-invalid', 'true'));
  });

  it('folds its body, and insert below adds the new step as its first body child', () => {
    renderEditor(STAGED_WORKFLOW);
    fireEvent.click(screen.getByTestId('body-fold-build'));
    expect(screen.queryByTestId('step-card-impl')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('body-fold-build'));

    fireEvent.click(within(screen.getByTestId('step-card-build')).getByLabelText('Insert step below'));
    const ids = screen.getAllByTestId(/^step-card-/).map(c => c.dataset.testid);
    expect(ids).toEqual(['step-card-plan', 'step-card-build', 'step-card-step-6', 'step-card-impl', 'step-card-gate', 'step-card-after']);
  });

  it('moves a body step within the body', async () => {
    const { transport } = renderEditor(STAGED_WORKFLOW);
    fireEvent.click(within(screen.getByTestId('step-card-gate')).getByLabelText('Move up'));
    expect(within(screen.getByTestId('step-card-gate')).getByLabelText('Move up')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    const req = await lastRequest(transport, 'updateWorkflow');
    const wf = (req.params as { workflow: Workflow }).workflow;
    expect(wf.steps[1]).toMatchObject({ steps: [{ id: 'gate' }, { id: 'impl' }] });
  });

  it('inside a body, Reads from offers the stage file and earlier steps outside it', async () => {
    renderEditor(STAGED_WORKFLOW);
    expect(await readsFromOptions('gate')).toEqual([
      'attachments — files attached to the run', 'stage — the current stage file', 'plan', 'impl',
    ]);
  });

  it('outside a body, Reads from offers neither the stage file nor any body step', async () => {
    renderEditor(STAGED_WORKFLOW);
    expect(await readsFromOptions('after')).toEqual(['attachments — files attached to the run', 'plan']);
  });

  it('does not offer stages as a kind inside a stages body — it cannot nest', async () => {
    renderEditor(STAGED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-impl'));
    fireEvent.click(within(screen.getByTestId('step-card-impl')).getByRole('combobox', { name: 'Kind' }));
    const options = (await screen.findAllByRole('option')).map(o => o.textContent);
    expect(options).toEqual(['agent', 'command', 'manual', 'approval', 'loop']);
  });

  it('offers stages as a kind at the top level; picking it turns the card into a stages card', async () => {
    renderEditor(STAGED_WORKFLOW);
    fireEvent.click(screen.getByTestId('step-collapse-after'));
    fireEvent.click(within(screen.getByTestId('step-card-after')).getByRole('combobox', { name: 'Kind' }));
    fireEvent.click(await screen.findByRole('option', { name: 'stages' }));
    const card = screen.getByTestId('step-card-after');
    expect(within(card).getByLabelText(/^Stage files/)).toHaveValue('');
    expect(within(card).queryByLabelText(/^Prompt/)).not.toBeInTheDocument();
    expect(within(card).getByTestId('body-fold-after')).toBeInTheDocument();
  });

  it('converting a loop to stages keeps its body', () => {
    const stepA: AgentStep = { kind: 'agent', id: 'a', runner: 'claude', mode: 'headless', writes: false, prompt: 'p', output: 'a.md' };
    expect(convertStep({ kind: 'loop', id: 'x', until: 'a', steps: [stepA] }, 'stages'))
      .toMatchObject({ kind: 'stages', id: 'x', steps: [stepA] });
  });

  it('converting stages to a loop keeps its body, with until left for the author to pick', () => {
    const stepA: AgentStep = { kind: 'agent', id: 'a', runner: 'claude', mode: 'headless', writes: false, prompt: 'p', output: 'a.md' };
    const loop = convertStep({ kind: 'stages', id: 'x', items: 'p/*.md', max_retries: 3, steps: [stepA] }, 'loop');
    expect(loop).toEqual({ kind: 'loop', id: 'x', until: '', enabled: undefined, steps: [stepA] });
  });
});
