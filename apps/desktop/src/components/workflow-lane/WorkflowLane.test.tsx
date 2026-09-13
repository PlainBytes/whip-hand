import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { WorkflowLane } from './WorkflowLane.tsx';
import type { WorkflowEntry } from './WorkflowLane.tsx';

const FEATURE: WorkflowEntry = {
  name: 'feature',
  path: '/ws/.whiphand/workflows/feature.yaml',
  source: 'project',
  workflow: {
    name: 'feature',
    description: 'Plan, build and review a feature',
    inputs: { feature: { required: true, prompt: 'What are we building?' } },
    steps: [
      { id: 'plan', kind: 'agent', runner: 'claude', model: 'opus', mode: 'interactive', writes: false, prompt: 'Plan the thing.', output: 'plan.md' },
      {
        id: 'execute', kind: 'agent', runner: 'claude', model: 'sonnet', mode: 'headless', writes: true, prompt: 'Implement the attached plan.', output: 'execute-report.md', inputs: ['plan'],
      },
      {
        id: 'review', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, verdict: true, prompt: 'Review the implementation against the attached plan.', output: 'review.md', inputs: ['plan', 'execute'],
      },
    ],
  },
};

const CYCLE: WorkflowEntry = {
  name: 'cycle',
  path: '/ws/.whiphand/workflows/cycle.yaml',
  source: 'project',
  workflow: {
    name: 'cycle',
    steps: [
      { id: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive', writes: false, prompt: 'Plan it.', output: 'plan.md' },
      {
        id: 'fix', kind: 'loop', until: 'review', max_iterations: 3,
        steps: [
          {
            id: 'execute', kind: 'agent', runner: 'claude', mode: 'headless', writes: true, prompt: 'Build it.', output: 'e.md', inputs: ['review'],
          },
          { id: 'tests', kind: 'command', run: 'npm test', verdict: true, output: 'tests.log' },
          {
            id: 'review', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, verdict: true, prompt: 'Review it.', output: 'r.md', inputs: ['execute'],
          },
        ],
      },
      {
        id: 'sign', kind: 'approval', title: 'Ship it?', instructions: 'Look at the diff.', verdict: true,
      },
    ],
  },
};

function renderLane(entry: WorkflowEntry) {
  const onRun = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  render(<WorkflowLane entry={entry} onRun={onRun} onEdit={onEdit} onDelete={onDelete} />);
  return { onRun, onEdit, onDelete };
}

describe('WorkflowLane header', () => {
  it('shows name, counts and description without any interaction', () => {
    renderLane(FEATURE);
    expect(screen.getByText('feature')).toBeInTheDocument();
    expect(screen.getByText('3 steps')).toBeInTheDocument();
    expect(screen.getByText('Plan, build and review a feature')).toBeInTheDocument();
  });

  it('shows what the workflow asks for, with defaults in parens', () => {
    const withDefault: WorkflowEntry = {
      ...FEATURE,
      workflow: {
        ...FEATURE.workflow!,
        inputs: { feature: { required: true }, base: { required: false, default: 'main' } },
      },
    };
    renderLane(withDefault);
    expect(screen.getByText('Asks for: feature, base (main)')).toBeInTheDocument();
  });

  it('leaves the description line out entirely when there is none', () => {
    renderLane({ ...FEATURE, workflow: { ...FEATURE.workflow!, description: undefined } });
    expect(screen.queryByText(/no description/i)).not.toBeInTheDocument();
  });

  it('shows a Global badge and "Overridden by this project" for a shadowed global entry', () => {
    renderLane({ ...FEATURE, source: 'global', shadowed: true });
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.getByText(/overridden by this project/i)).toBeInTheDocument();
  });

  it('shows no Global badge or note for an ordinary project entry', () => {
    renderLane(FEATURE);
    expect(screen.queryByText('Global')).not.toBeInTheDocument();
    expect(screen.queryByText(/overridden by this project/i)).not.toBeInTheDocument();
  });

  it('counts loops and disabled steps in the summary line', () => {
    renderLane(CYCLE);
    expect(screen.getByText('5 steps · 1 loop')).toBeInTheDocument();
  });

  it('appends a disabled-steps count when the workflow parks anything', () => {
    const withDisabled: WorkflowEntry = {
      ...FEATURE,
      workflow: {
        ...FEATURE.workflow!,
        steps: [{ ...FEATURE.workflow!.steps[0], enabled: false }, ...FEATURE.workflow!.steps.slice(1)],
      },
    };
    renderLane(withDisabled);
    expect(screen.getByText('3 steps · 1 step disabled')).toBeInTheDocument();
  });

  it('runs and edits from the lane itself', () => {
    const { onRun, onEdit } = renderLane(FEATURE);
    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
    expect(onRun).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(onEdit).toHaveBeenCalledWith(FEATURE);
  });

  it('deletes from the ⋯ menu, handing the whole entry to onDelete', () => {
    const { onDelete } = renderLane(FEATURE);
    fireEvent.click(screen.getByRole('button', { name: /more actions for feature/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith(FEATURE);
  });
});

describe('WorkflowLane parse errors', () => {
  it('shows the error and offers neither Run nor Edit for an unparseable workflow', () => {
    renderLane({ name: 'broken', path: '/ws/.whiphand/workflows/broken.yaml', source: 'project', error: "duplicate step id 'plan'" });
    expect(screen.getByText('broken')).toBeInTheDocument();
    expect(screen.getByText(/duplicate step id/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it('still offers Delete, from the ⋯ menu, for a workflow file that failed to parse', () => {
    const { onDelete } = renderLane({
      name: 'broken', path: '/ws/.whiphand/workflows/broken.yaml', source: 'project', error: "duplicate step id 'plan'",
    });
    fireEvent.click(screen.getByRole('button', { name: /more actions for broken/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalled();
  });

  it('offers no ⋯ menu at all for the entry naming an unreadable scope directory', () => {
    renderLane({
      name: 'global', path: '/home/user/.config/whiphand/workflows', source: 'global',
      error: 'cannot read /home/user/.config/whiphand/workflows: EACCES',
    });
    expect(screen.getByText(/cannot read/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
  });
});

describe('WorkflowLane step track: ordinals and loops', () => {
  it('numbers top-level steps and nests a loop body under its own ordinal', () => {
    renderLane(CYCLE);
    expect(within(screen.getByTestId('step-tile-plan')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('loop-label-fix')).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByTestId('step-tile-execute')).getByText('2.1')).toBeInTheDocument();
    expect(within(screen.getByTestId('step-tile-tests')).getByText('2.2')).toBeInTheDocument();
    expect(within(screen.getByTestId('step-tile-review')).getByText('2.3')).toBeInTheDocument();
    expect(within(screen.getByTestId('step-tile-sign')).getByText('3')).toBeInTheDocument();
  });

  it('labels the loop with its until rule and max iterations', () => {
    renderLane(CYCLE);
    expect(screen.getByTestId('loop-label-fix')).toHaveTextContent('fix · until review passes · max 3');
  });

  it('labels a loop ending on an approval step as "approves"', () => {
    const entry: WorkflowEntry = {
      name: 'human', path: '/ws/.whiphand/workflows/human.yaml', source: 'project',
      workflow: {
        name: 'human',
        steps: [
          {
            id: 'human-review', kind: 'loop', until: 'sign-off',
            steps: [
              { id: 'execute', kind: 'agent', runner: 'claude', mode: 'headless', writes: true, prompt: 'Build.', output: 'e.md' },
              { id: 'sign-off', kind: 'approval', title: 'Ship it?', instructions: 'Look.', verdict: true },
            ],
          },
        ],
      },
    };
    renderLane(entry);
    expect(screen.getByTestId('loop-label-human-review')).toHaveTextContent('human-review · until sign-off approves');
  });

  it('marks the loop\'s until: target with the ends-loop marker', () => {
    renderLane(CYCLE);
    expect(within(screen.getByTestId('step-tile-review')).getByTestId('step-ends-loop-review')).toBeInTheDocument();
    expect(within(screen.getByTestId('step-tile-execute')).queryByTestId('step-ends-loop-execute')).not.toBeInTheDocument();
  });

  it('collapses a disabled loop to a single "loop disabled — N steps" tile', () => {
    const withDisabledLoop: WorkflowEntry = {
      ...CYCLE,
      workflow: {
        ...CYCLE.workflow!,
        steps: CYCLE.workflow!.steps.map(s => (s.id === 'fix' ? { ...s, enabled: false } : s)),
      },
    };
    renderLane(withDisabledLoop);
    expect(screen.getByTestId('loop-disabled-fix')).toHaveTextContent('loop disabled — 3 steps');
    expect(screen.queryByTestId('step-tile-execute')).not.toBeInTheDocument();
  });
});

describe('WorkflowLane step tile: disabled', () => {
  it('dims a disabled step and tags it', () => {
    const withDisabled: WorkflowEntry = {
      ...FEATURE,
      workflow: { ...FEATURE.workflow!, steps: [{ ...FEATURE.workflow!.steps[0], enabled: false }, ...FEATURE.workflow!.steps.slice(1)] },
    };
    renderLane(withDisabled);
    expect(within(screen.getByTestId('step-tile-plan')).getByText('disabled')).toBeInTheDocument();
  });
});

describe('WorkflowLane step tile: popovers', () => {
  it('shows an agent step\'s prompt, runner, model, mode and writes/output', () => {
    renderLane(FEATURE);
    fireEvent.click(screen.getByTestId('step-tile-execute'));
    const popover = screen.getByTestId('step-tile-popover-execute');
    expect(within(popover).getByText('Implement the attached plan.')).toBeInTheDocument();
    expect(within(popover).getByText('claude')).toBeInTheDocument();
    expect(within(popover).getByText('sonnet')).toBeInTheDocument();
    expect(within(popover).getByText('headless')).toBeInTheDocument();
    expect(within(popover).getByText('execute-report.md')).toBeInTheDocument();
    expect(within(popover).getByText('plan')).toBeInTheDocument();
  });

  it('shows a command step\'s run: line', () => {
    renderLane(CYCLE);
    fireEvent.click(screen.getByTestId('step-tile-tests'));
    const popover = screen.getByTestId('step-tile-popover-tests');
    expect(within(popover).getByText('npm test')).toBeInTheDocument();
  });

  it('shows an approval step\'s instructions and show_diff/capture', () => {
    const entry: WorkflowEntry = {
      name: 'sign', path: '/ws/.whiphand/workflows/sign.yaml', source: 'project',
      workflow: {
        name: 'sign',
        steps: [{
          id: 'sign-off', kind: 'approval', title: 'Ship it?', instructions: 'Read the diff first.', show_diff: true, capture: 'review', verdict: true,
        }],
      },
    };
    renderLane(entry);
    fireEvent.click(screen.getByTestId('step-tile-sign-off'));
    const popover = screen.getByTestId('step-tile-popover-sign-off');
    expect(within(popover).getByText('Read the diff first.')).toBeInTheDocument();
    expect(within(popover).getByText('review')).toBeInTheDocument();
    // "Shows diff: yes" and "Verdict: yes" — both rows are "yes", asserted as a pair.
    expect(within(popover).getAllByText('yes')).toHaveLength(2);
  });

  it('marks a read of a later loop-body sibling as the previous iteration', () => {
    renderLane(CYCLE);
    fireEvent.click(screen.getByTestId('step-tile-execute'));
    const popover = screen.getByTestId('step-tile-popover-execute');
    expect(within(popover).getByText('review (previous iteration)')).toBeInTheDocument();
  });
});

describe('WorkflowLane hover highlighting', () => {
  it('tints the tiles a hovered step reads from blue, and the tiles that read it green', () => {
    renderLane(FEATURE);
    fireEvent.mouseEnter(screen.getByTestId('step-tile-execute'));
    expect(screen.getByTestId('step-tile-plan')).toHaveAttribute('data-highlight', 'source');
    expect(screen.getByTestId('step-tile-review')).toHaveAttribute('data-highlight', 'dependent');
    fireEvent.mouseLeave(screen.getByTestId('step-tile-execute'));
    expect(screen.getByTestId('step-tile-plan')).not.toHaveAttribute('data-highlight', 'source');
  });
});
