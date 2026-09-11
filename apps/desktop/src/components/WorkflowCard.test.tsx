import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { WorkflowCard } from './WorkflowCard.tsx';
import type { WorkflowEntry } from './WorkflowCard.tsx';

const FEATURE: WorkflowEntry = {
  name: 'feature',
  path: '/ws/.whiphand/workflows/feature.yaml',
  source: 'project',
  workflow: {
    name: 'feature',
    description: 'Plan, build and review a feature',
    inputs: { feature: { required: true, prompt: 'What are we building?' } },
    steps: [
      { id: 'plan', kind: 'agent', runner: 'claude', model: 'opus', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' },
      { id: 'execute', kind: 'agent', runner: 'claude', model: 'sonnet', mode: 'headless', writes: true, prompt: 'p', output: 'execute-report.md' },
      { id: 'review', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, verdict: true, prompt: 'p', output: 'review.md' },
    ],
  },
};

function renderCard(entry: WorkflowEntry) {
  const onRun = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  render(<WorkflowCard entry={entry} onRun={onRun} onEdit={onEdit} onDelete={onDelete} />);
  return { onRun, onEdit, onDelete };
}

function stepRows() {
  return screen.getAllByTestId('workflow-card-step-row');
}

function stepIdOf(row: HTMLElement): string {
  return within(row).getByTestId('step-summary-step-id').textContent ?? '';
}

describe('WorkflowCard', () => {
  it('shows the name, description and step count without any interaction', () => {
    renderCard(FEATURE);
    expect(screen.getByText('feature')).toBeInTheDocument();
    expect(screen.getByText('Plan, build and review a feature')).toBeInTheDocument();
    expect(screen.getByText('3 steps · 1 input')).toBeInTheDocument();
  });

  it('lists the steps in order with their mode and writes flag, relabelled "edits files"', () => {
    renderCard(FEATURE);
    const rows = stepRows();
    expect(rows.map(stepIdOf)).toEqual(['plan', 'execute', 'review']);

    expect(within(rows[0]).getByText('interactive')).toBeInTheDocument();
    expect(within(rows[0]).queryByText('edits files')).not.toBeInTheDocument();
    expect(within(rows[1]).getByText('headless')).toBeInTheDocument();
    expect(within(rows[1]).getByText('edits files')).toBeInTheDocument();
    expect(within(rows[2]).getByText('verdict')).toBeInTheDocument();
  });

  it('shows what each step reads and writes, not its runner/model — that moved to the editor rail', () => {
    renderCard(FEATURE);
    const rows = stepRows();
    expect(within(rows[1]).getByTestId('reads-chip-execute')).toBeInTheDocument();
    expect(within(rows[1]).getByTestId('writes-chip-execute')).toHaveTextContent('writes: execute-report.md');
    expect(within(rows[0]).queryByText('claude · opus')).not.toBeInTheDocument();
  });

  it('says so plainly when a workflow has no description, so cards stay aligned', () => {
    renderCard({ ...FEATURE, workflow: { ...FEATURE.workflow!, description: undefined } });
    expect(screen.getByText('No description')).toBeInTheDocument();
  });

  it('counts a single step and a missing inputs map correctly', () => {
    renderCard({
      ...FEATURE,
      workflow: { name: 'feature', steps: [FEATURE.workflow!.steps[0]] },
    });
    expect(screen.getByText('1 step')).toBeInTheDocument();
  });

  it('runs and edits from the card itself', () => {
    const { onRun, onEdit } = renderCard(FEATURE);
    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
    expect(onRun).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(onEdit).toHaveBeenCalledWith(FEATURE);
  });

  it('shows the parse error and offers neither Run nor Edit for an unparseable workflow', () => {
    renderCard({ name: 'broken', path: '/ws/.whiphand/workflows/broken.yaml', source: 'project', error: "duplicate step id 'plan'" });
    expect(screen.getByText('broken')).toBeInTheDocument();
    expect(screen.getByText(/duplicate step id/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it('offers Delete on a parsed card, and hands the whole entry to onDelete', () => {
    const { onDelete } = renderCard(FEATURE);
    fireEvent.click(screen.getByRole('button', { name: 'Delete feature' }));
    expect(onDelete).toHaveBeenCalledWith(FEATURE);
  });

  it('offers Delete on a card whose YAML failed to parse', () => {
    const broken: WorkflowEntry = {
      name: 'broken', path: '/ws/.whiphand/workflows/broken.yaml', source: 'project', error: "duplicate step id 'plan'",
    };
    const { onDelete } = renderCard(broken);
    fireEvent.click(screen.getByRole('button', { name: 'Delete broken' }));
    expect(onDelete).toHaveBeenCalledWith(broken);
  });

  it('offers no Delete on the entry for a workflows folder that could not be read', () => {
    renderCard({
      name: 'global', path: '/home/user/.config/whiphand/workflows', source: 'global',
      error: 'cannot read /home/user/.config/whiphand/workflows: EACCES',
    });
    expect(screen.getByText(/cannot read/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('shows a Global badge and an "overridden" note for a shadowed global entry', () => {
    renderCard({ ...FEATURE, source: 'global', shadowed: true });
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.getByText(/overridden by this project/i)).toBeInTheDocument();
  });

  it('shows no Global badge or note for an ordinary project entry', () => {
    renderCard(FEATURE);
    expect(screen.queryByText('Global')).not.toBeInTheDocument();
    expect(screen.queryByText(/overridden by this project/i)).not.toBeInTheDocument();
  });

  it('appends a disabled-steps count to the summary line when the workflow parks anything', () => {
    renderCard({
      ...FEATURE,
      workflow: { ...FEATURE.workflow!, steps: [{ ...FEATURE.workflow!.steps[0], enabled: false }, ...FEATURE.workflow!.steps.slice(1)] },
    });
    expect(screen.getByText('3 steps · 1 input · 1 step disabled')).toBeInTheDocument();
  });
});

const CYCLE: WorkflowEntry = {
  name: 'cycle',
  path: '/ws/.whiphand/workflows/cycle.yaml',
  source: 'project',
  workflow: {
    name: 'cycle',
    steps: [
      { id: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' },
      {
        id: 'fix', kind: 'loop', until: 'review', max_iterations: 3,
        steps: [
          { id: 'execute', kind: 'agent', runner: 'claude', mode: 'headless', writes: true, prompt: 'p', output: 'e.md' },
          { id: 'tests', kind: 'command', run: 'npm test', verdict: true, output: 'tests.log' },
          { id: 'review', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, verdict: true, prompt: 'p', output: 'r.md' },
        ],
      },
      { id: 'sign', kind: 'approval', title: 'Ship it?', instructions: 'Look.' },
    ],
  },
};

describe('WorkflowCard with cycles and non-agent steps', () => {
  it('lists a loop body under its loop, in order', () => {
    renderCard(CYCLE);
    expect(stepRows().map(stepIdOf)).toEqual(['plan', 'fix', 'execute', 'tests', 'review', 'sign']);
  });

  it('counts steps across loop bodies, and names the loop separately', () => {
    renderCard(CYCLE);
    expect(screen.getByText('5 steps · 1 loop')).toBeInTheDocument();
  });

  it('badges each step with its kind', () => {
    renderCard(CYCLE);
    const rows = stepRows();
    const byId = (id: string) => rows.find(r => stepIdOf(r) === id)!;
    expect(within(byId('tests')).getByText('command')).toBeInTheDocument();
    expect(within(byId('fix')).getByText('loop')).toBeInTheDocument();
    expect(within(byId('sign')).getByText('approval')).toBeInTheDocument();
    // A command step has no mode/writes flags to show — those are agent-only.
    expect(within(byId('tests')).queryByText('headless')).toBeNull();
    expect(within(byId('tests')).getByText('verdict')).toBeInTheDocument();
  });

  it('says what each kind of step actually does on the right', () => {
    renderCard(CYCLE);
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('until review')).toBeInTheDocument();
  });
});
