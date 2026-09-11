import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RunStepper, StepDetails } from './RunStepper.tsx';
import type { StepState } from '../state/store.ts';

function steps(): StepState[] {
  return [
    { key: 'a', id: 'a', status: 'done' },
    { key: 'b', id: 'b', status: 'running' },
    { key: 'c', id: 'c', status: 'pending' },
  ] as StepState[];
}

const T0 = '2026-01-01T00:00:00Z';
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString();

describe('RunStepper', () => {
  it('shows every pill when expanded', () => {
    render(<RunStepper steps={steps()} focusStepId="b" />);
    expect(screen.getByTestId('step-card-a')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-c')).toBeInTheDocument();
  });

  it('says a harvesting step is generating its artifact', () => {
    // The pty is gone but the step is still working. This pill is the only
    // place that says so: the Terminal tab carries output, not step state.
    const harvesting = [
      { key: 'plan', id: 'plan', status: 'running', phase: 'harvest' },
    ] as StepState[];
    render(<RunStepper steps={harvesting} focusStepId="plan" />);

    expect(screen.getByTestId('step-phase-plan')).toHaveTextContent('generating artifact');
  });

  it('says nothing of the sort while the step is still in its main phase', () => {
    const working = [
      { key: 'plan', id: 'plan', status: 'running', phase: 'main' },
    ] as StepState[];
    render(<RunStepper steps={working} focusStepId="plan" />);

    expect(screen.queryByTestId('step-phase-plan')).not.toBeInTheDocument();
  });

  it('says so itself when it has no steps to show', () => {
    // The page used to render this line beside the stepper, on the stepper's
    // behalf. The strip belongs to the stepper, so the stepper reports it.
    render(<RunStepper steps={[]} />);
    expect(screen.getByTestId('stepper-empty')).toHaveTextContent(/no steps yet/i);
    expect(screen.queryByTestId('stepper-empty')).toBeInTheDocument();
  });

  it('shows no empty note once there are steps', () => {
    render(<RunStepper steps={steps()} focusStepId="b" />);
    expect(screen.queryByTestId('stepper-empty')).not.toBeInTheDocument();
  });

  it('shows only the focus step, and how many there are, when collapsed', () => {
    render(<RunStepper steps={steps()} focusStepId="b" collapsed onToggleCollapse={vi.fn()} />);
    expect(screen.getByTestId('step-card-b')).toBeInTheDocument();
    expect(screen.queryByTestId('step-card-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-card-c')).not.toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
  });

  it('fires onToggleCollapse from the chevron', () => {
    const onToggleCollapse = vi.fn();
    render(<RunStepper steps={steps()} focusStepId="b" onToggleCollapse={onToggleCollapse} />);
    fireEvent.click(screen.getByTestId('stepper-collapse-toggle'));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('renders no chevron when collapsing is not offered', () => {
    render(<RunStepper steps={steps()} focusStepId="b" />);
    expect(screen.queryByTestId('stepper-collapse-toggle')).not.toBeInTheDocument();
  });

  it('keeps the collapsed pill numbered by its place in the whole run', () => {
    render(<RunStepper steps={steps()} focusStepId="b" collapsed onToggleCollapse={vi.fn()} />);
    // 'b' is step 2 of 3 — collapsing must not renumber it to 1.
    expect(screen.getByTestId('step-ordinal-b')).toHaveTextContent('2');
  });
});

// ---------------------------------------------------------------------------
// What each pill says about itself
// ---------------------------------------------------------------------------

describe('pill self-description', () => {
  it('names the runner, model and mode of an agent step on the pill itself', () => {
    // The whole point: collapsing the panel must not hide what a step will use.
    const step = {
      key: 'plan', id: 'plan', kind: 'agent', runner: 'claude', model: 'opus',
      mode: 'interactive', status: 'pending',
    } as StepState;
    render(<RunStepper steps={[step]} />);
    const meta = screen.getByTestId('step-meta-plan');
    expect(meta).toHaveTextContent('claude');
    expect(meta).toHaveTextContent('opus');
    expect(meta).toHaveTextContent('interactive');
  });

  it('says "default" for an agent step that names no model', () => {
    const step = {
      key: 'plan', id: 'plan', kind: 'agent', runner: 'copilot', mode: 'headless', status: 'pending',
    } as StepState;
    render(<RunStepper steps={[step]} />);
    expect(screen.getByTestId('step-meta-plan')).toHaveTextContent('default');
  });

  it('puts the tool and model in the accessible name too, not just on screen', () => {
    // The pill has an aria-label, which replaces its text for a screen reader
    // — so the label has to carry what the second line says, or the feature
    // exists only for people who can see it.
    const step = {
      key: 'plan', id: 'plan', kind: 'agent', runner: 'claude', model: 'opus',
      mode: 'interactive', status: 'pending',
    } as StepState;
    render(<RunStepper steps={[step]} />);
    expect(screen.getByTestId('step-card-plan')).toHaveAccessibleName(/claude.*opus/);
  });

  it('labels a step that uses no runner by its kind', () => {
    const list = [
      { key: 'build', id: 'build', kind: 'command', status: 'done' },
      { key: 'ship', id: 'ship', kind: 'approval', status: 'pending' },
    ] as StepState[];
    render(<RunStepper steps={list} />);
    expect(screen.getByTestId('step-meta-build')).toHaveTextContent('command');
    expect(screen.getByTestId('step-meta-ship')).toHaveTextContent('approval');
  });
});

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

/** feature-development.yaml's loop, `iterations` iterations deep. */
function loopRun(iterations: number, maxIterations?: number): StepState[] {
  const list: StepState[] = [
    { key: 'do-review', id: 'do-review', kind: 'loop', status: 'running', iterations, maxIterations },
  ] as StepState[];
  for (let i = 1; i <= iterations; i++) {
    list.push({
      key: i === 1 ? 'execute' : `execute#${i}`, id: 'execute', kind: 'agent', loopId: 'do-review',
      runner: 'claude', model: 'sonnet', mode: 'headless', iteration: i,
      status: i === iterations ? 'running' : 'done',
    } as StepState);
  }
  return list;
}

describe('cycles', () => {
  it('draws a loop as a container holding its body', () => {
    render(<RunStepper steps={loopRun(1)} />);
    const container = screen.getByTestId('step-loop-do-review');
    expect(within(container).getByTestId('step-card-execute')).toBeInTheDocument();
  });

  it('shows a repeated body step once, with a count, however long the loop churns', () => {
    render(<RunStepper steps={loopRun(3)} />);
    // Three executions, one pill: the row must not grow with the iterations.
    expect(screen.getAllByTestId('step-card-execute')).toHaveLength(1);
    expect(screen.getByTestId('step-iterations-execute')).toHaveTextContent('3');
  });

  it('shows no count on a body step that has only run once', () => {
    render(<RunStepper steps={loopRun(1)} />);
    expect(screen.queryByTestId('step-iterations-execute')).not.toBeInTheDocument();
  });

  it('reads the newest iteration of a folded step, not the first', () => {
    render(<RunStepper steps={loopRun(3)} />);
    // Iterations 1 and 2 are done; the pill must speak for the third, still
    // running. Status reaches a screen reader through the pill's label — the
    // icon that carries it visually has no text of its own.
    expect(screen.getByTestId('step-card-execute')).toHaveAccessibleName(/running/);
  });

  it('names the step and its status for a screen reader', () => {
    render(<RunStepper steps={loopRun(1)} />);
    expect(screen.getByTestId('step-card-execute')).toHaveAccessibleName(/execute/);
  });

  it('says which iteration the loop is on and how many it may run', () => {
    render(<RunStepper steps={loopRun(2, 3)} />);
    expect(screen.getByTestId('loop-progress-do-review')).toHaveTextContent('2 of 3');
  });

  it('says it on the loop\'s own pill, not beside it', () => {
    // Where a loop is in its budget is a fact about the loop. A line of text
    // floating next to the pill that owns it is the shape this row dropped.
    render(<RunStepper steps={loopRun(2, 3)} />);
    const pill = screen.getByTestId('step-card-do-review');
    expect(pill).toContainElement(screen.getByTestId('loop-progress-do-review'));
    expect(pill).toHaveAccessibleName(/iteration 2 of 3/);
  });

  it('drops the budget when the run never recorded one', () => {
    // An older manifest: iteration count known, budget not.
    render(<RunStepper steps={loopRun(2)} />);
    const progress = screen.getByTestId('loop-progress-do-review');
    expect(progress).toHaveTextContent('iteration 2');
    expect(progress).not.toHaveTextContent('of');
  });

  it('lists every iteration of a folded step in its popover', () => {
    render(<RunStepper steps={loopRun(3)} />);
    fireEvent.click(screen.getByTestId('step-card-execute'));
    const history = screen.getByTestId('step-history-execute');
    expect(within(history).getAllByRole('listitem')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Disabling a step
// ---------------------------------------------------------------------------

describe('disabling a step', () => {
  it('shows a disabled step in place, badged, with no status icon', () => {
    const list = [
      { key: 'plan', id: 'plan', kind: 'agent', status: 'disabled' },
      { key: 'execute', id: 'execute', kind: 'agent', status: 'running' },
    ] as StepState[];
    render(<RunStepper steps={list} focusStepId="execute" />);
    expect(screen.getByTestId('step-card-plan')).toBeInTheDocument();
    expect(screen.getByTestId('step-disabled-plan')).toHaveTextContent('disabled');
  });

  it('a disabled loop is one row naming how many steps it holds, not its body', () => {
    const list = [
      { key: 'human-review', id: 'human-review', kind: 'loop', status: 'disabled' },
      { key: 'do-review', id: 'do-review', kind: 'loop', loopId: 'human-review', status: 'disabled' },
      { key: 'execute', id: 'execute', kind: 'agent', loopId: 'do-review', status: 'disabled' },
      { key: 'review', id: 'review', kind: 'agent', loopId: 'do-review', status: 'disabled' },
      { key: 'sign-off', id: 'sign-off', kind: 'approval', loopId: 'human-review', status: 'disabled' },
    ] as StepState[];
    render(<RunStepper steps={list} />);
    expect(screen.getByTestId('step-card-human-review')).toHaveTextContent('loop disabled — 4 steps not run');
    expect(screen.queryByTestId('step-loop-human-review')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-card-do-review')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-card-execute')).not.toBeInTheDocument();
  });

  it('excludes disabled steps from both halves of the "N of M" progress count', () => {
    const list = [
      { key: 'plan', id: 'plan', kind: 'agent', status: 'disabled' },
      { key: 'execute', id: 'execute', kind: 'agent', status: 'done' },
      { key: 'review', id: 'review', kind: 'agent', status: 'running' },
    ] as StepState[];
    render(<RunStepper steps={list} focusStepId="review" collapsed onToggleCollapse={vi.fn()} />);
    // Three declared steps, one disabled: 'review' is the 2nd of 2 that count.
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Elapsed time
// ---------------------------------------------------------------------------

describe('pill duration', () => {
  const running = { key: 'x', id: 'x', status: 'running', startedAt: T0 } as StepState;

  it('measures a running step against the clock it is handed', () => {
    render(<RunStepper steps={[running]} now={Date.parse(at(47))} />);
    expect(screen.getByTestId('step-duration-x')).toHaveTextContent('47s');
  });

  it('freezes a finished step at its own span, however late it is read', () => {
    const done = { ...running, status: 'done', endedAt: at(64) } as StepState;
    render(<RunStepper steps={[done]} now={Date.parse(at(9999))} />);
    expect(screen.getByTestId('step-duration-x')).toHaveTextContent('1m 4s');
  });

  it('shows no duration for a step that has not started', () => {
    const pending = { key: 'x', id: 'x', status: 'pending' } as StepState;
    render(<RunStepper steps={[pending]} now={Date.parse(at(47))} />);
    expect(screen.queryByTestId('step-duration-x')).not.toBeInTheDocument();
  });

  it('times a folded step from the iteration it is on, not from the loop start', () => {
    const list = loopRun(2);
    list[1] = { ...list[1], startedAt: T0, endedAt: at(10) };
    list[2] = { ...list[2], startedAt: at(30) };
    render(<RunStepper steps={list} now={Date.parse(at(45))} />);
    expect(screen.getByTestId('step-duration-execute')).toHaveTextContent('15s');
  });
});

describe('pill spend', () => {
  const step = (progress?: StepState['progress']): StepState =>
    ({ key: 'impl', id: 'impl', kind: 'agent', status: 'running', mode: 'headless', progress }) as StepState;

  it('shows what a running step has spent, beside its clock', () => {
    // "How long, and how much" is the pair you check on a run you left going —
    // so it sits on the pill, not behind a click and not above the feed.
    render(<RunStepper steps={[step({ turns: 6, costUsd: 0.42 })]} />);
    const spend = screen.getByTestId('step-spend-impl');
    expect(spend).toHaveTextContent('6 turns');
    expect(spend).toHaveTextContent('$0.42');
  });

  it('leaves what the step is doing to the feed', () => {
    // The Terminal tab's last line already says this. The pill saying it too
    // is the duplication this row was cleaned up to stop.
    render(<RunStepper steps={[step({ lastAction: 'Edit runner.ts', turns: 6 })]} />);
    expect(screen.getByTestId('step-spend-impl')).not.toHaveTextContent('Edit runner.ts');
  });

  it('shows a dollar cost for claude and premium requests for copilot', () => {
    const { unmount } = render(<RunStepper steps={[step({ turns: 7, costUsd: 0.41 })]} />);
    expect(screen.getByTestId('step-spend-impl')).toHaveTextContent('$0.41');
    unmount();

    render(<RunStepper steps={[step({ turns: 2, premiumRequests: 0.33 })]} />);
    const spend = screen.getByTestId('step-spend-impl');
    expect(spend).toHaveTextContent('0.33 premium requests');
    expect(spend).not.toHaveTextContent('$');
  });

  it('shows nothing for a step whose runner reported no counters', () => {
    // A command step, or an agent step that has so far only talked: absent
    // counters are left out rather than shown as zeroes.
    render(<RunStepper steps={[step({ lastAction: 'Edit runner.ts' })]} />);
    expect(screen.queryByTestId('step-spend-impl')).not.toBeInTheDocument();
  });

  it('carries the spend into the pill\'s accessible name', () => {
    render(<RunStepper steps={[step({ turns: 6, costUsd: 0.42 })]} />);
    expect(screen.getByTestId('step-card-impl')).toHaveAccessibleName(/6 turns/);
  });
});

describe('StepDetails progress summary', () => {
  const step = (progress?: StepState['progress']): StepState =>
    ({ key: 'impl', id: 'impl', kind: 'agent', status: 'running', mode: 'headless', progress }) as StepState;

  it('says what a running headless step is doing right now', () => {
    render(<StepDetails step={step({ lastAction: 'Edit runner.ts', turns: 7 })} />);
    expect(screen.getByTestId('step-progress')).toHaveTextContent('Edit runner.ts');
    expect(screen.getByTestId('step-progress')).toHaveTextContent('7 turns');
  });

  it('shows a dollar cost for claude and premium requests for copilot', () => {
    const { unmount } = render(<StepDetails step={step({ turns: 7, costUsd: 0.41 })} />);
    expect(screen.getByTestId('step-progress')).toHaveTextContent('$0.41');
    unmount();

    render(<StepDetails step={step({ turns: 2, premiumRequests: 0.33 })} />);
    const summary = screen.getByTestId('step-progress');
    expect(summary).toHaveTextContent('0.33 premium requests');
    expect(summary).not.toHaveTextContent('$');
  });

  it('renders nothing at all for a step that reported no progress', () => {
    render(<StepDetails step={step()} />);
    expect(screen.queryByTestId('step-progress')).not.toBeInTheDocument();
  });
});
