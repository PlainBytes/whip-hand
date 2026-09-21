import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RunStepper, StepDetails, StepStatusIcon } from './RunStepper.tsx';
import { hasInjectedStyle } from '../test/badge-style.ts';
import { executionKey, type StepState } from '../state/store.ts';

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
// StepStatusIcon — the one status marker every pill and popover header shares
// ---------------------------------------------------------------------------

describe('StepStatusIcon', () => {
  it('renders filled badges at the shared 24px status size for done, failed and interrupted', () => {
    const cases: Array<[StepState['status'], string]> = [
      ['done', 'var(--colorPaletteGreenBackground3)'],
      ['failed', 'var(--colorPaletteRedBackground3)'],
      ['interrupted', 'var(--colorPaletteDarkOrangeBackground3)'],
    ];
    for (const [status, fill] of cases) {
      const { container, unmount } = render(<StepStatusIcon status={status} />);
      const badge = container.querySelector('.fui-Badge') as HTMLElement;
      expect(badge, `${status} renders a filled badge`).not.toBeNull();
      expect(hasInjectedStyle(badge, 'background-color', fill)).toBe(true);
      expect(hasInjectedStyle(badge, 'height', '24px')).toBe(true);
      unmount();
    }
  });

  it('keeps running a spinner', () => {
    const { container } = render(<StepStatusIcon status="running" />);
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(container.querySelector('.fui-Badge')).toBeNull();
  });

  it('renders nothing for disabled', () => {
    // A disabled step never ran, which is not the fact a pending circle tells.
    const { container } = render(<StepStatusIcon status="disabled" />);
    expect(container.firstChild).toBeNull();
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
// Nested rounds — the shape every shipped workflow now uses: an outer
// human-review loop wraps an inner fix-cycle, and Request changes reruns the
// whole inner loop as a fresh round sitting beside the last one.
// ---------------------------------------------------------------------------

/** One round of `human-review`'s body: a `fix-cycle` loop holding one `execute`. */
function fixCycleRound(round: number, executeStatus: StepState['status']): StepState[] {
  const outerLoops = [{ id: 'human-review', iteration: round }];
  return [
    {
      key: executionKey('fix-cycle', round), id: 'fix-cycle', kind: 'loop',
      loopId: 'human-review', iteration: round, status: round === 2 ? 'running' : 'done',
    } as StepState,
    {
      key: executionKey('execute', 1, outerLoops), id: 'execute', kind: 'agent',
      loopId: 'fix-cycle', iteration: 1, outerLoops,
      runner: 'claude', model: 'sonnet', mode: 'headless', status: executeStatus,
    } as StepState,
  ];
}

/** Round 1 finished and was sent back; round 2 is still running. */
function twoOuterRounds(): StepState[] {
  return [
    { key: executionKey('human-review'), id: 'human-review', kind: 'loop', status: 'running', iterations: 2 } as StepState,
    ...fixCycleRound(1, 'done'),
    {
      key: executionKey('sign-off', 1), id: 'sign-off', kind: 'approval', loopId: 'human-review',
      iteration: 1, status: 'done', verdict: 'fail',
    } as StepState,
    ...fixCycleRound(2, 'running'),
    {
      key: executionKey('sign-off', 2), id: 'sign-off', kind: 'approval', loopId: 'human-review',
      iteration: 2, status: 'pending',
    } as StepState,
  ];
}

describe('nested rounds', () => {
  it('gives each round its own group and pill, with no duplicate-key warning', () => {
    // Before nodes were keyed by execution identity, both fix-cycle rounds
    // and both execute pills shared a bare id, and React logged "Encountered
    // two children with the same key" for the sibling loop nodes.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<RunStepper steps={twoOuterRounds()} focusStepId="execute" />);
    const duplicateKeyWarning = errorSpy.mock.calls.some(call => String(call[0]).includes('same key'));
    errorSpy.mockRestore();
    expect(duplicateKeyWarning).toBe(false);

    const round1Group = screen.getByTestId('step-loop-fix-cycle');
    const round2Group = screen.getByTestId('step-loop-fix-cycle#2');
    expect(within(round1Group).getByTestId('step-card-human-review#1/execute#1')).toBeInTheDocument();
    expect(within(round2Group).getByTestId('step-card-human-review#2/execute#1')).toBeInTheDocument();
  });

  it('shows the running round\'s pill when collapsed, not a finished earlier round', () => {
    render(
      <RunStepper steps={twoOuterRounds()} focusStepId="execute" collapsed onToggleCollapse={vi.fn()} />,
    );
    expect(screen.getByTestId('step-card-human-review#2/execute#1')).toHaveAccessibleName(/running/);
    expect(screen.queryByTestId('step-card-human-review#1/execute#1')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// nodeRef — the page scrolls to the *running execution's own* key
// (e.g. `execute#2`), which is not always the folded node's key (the
// *first* folded execution's key). A pill has to answer to both.
// ---------------------------------------------------------------------------

/** Round 2 of `human-review`, whose `fix-cycle` body has run `execute` twice. */
function nestedRoundWithTwoExecutions(): StepState[] {
  const outerLoops = [{ id: 'human-review', iteration: 2 }];
  return [
    { key: executionKey('human-review', 2), id: 'human-review', kind: 'loop', status: 'running', iterations: 2 } as StepState,
    {
      key: executionKey('fix-cycle', 2), id: 'fix-cycle', kind: 'loop', loopId: 'human-review',
      iteration: 2, status: 'running',
    } as StepState,
    {
      key: executionKey('execute', 1, outerLoops), id: 'execute', kind: 'agent',
      loopId: 'fix-cycle', iteration: 1, outerLoops, status: 'done',
    } as StepState,
    {
      key: executionKey('execute', 2, outerLoops), id: 'execute', kind: 'agent',
      loopId: 'fix-cycle', iteration: 2, outerLoops, status: 'running',
    } as StepState,
  ];
}

describe('nodeRef', () => {
  it('resolves the running execution\'s own key to the same element as the node key, single-level', () => {
    // loopRun(2): folded node key is 'execute' (iteration 1's key); iteration
    // 2 — the one actually running — has its own key, 'execute#2'.
    const refs: Record<string, HTMLElement | null> = {};
    render(<RunStepper steps={loopRun(2)} nodeRef={(key, el) => { refs[key] = el; }} />);
    expect(refs['execute#2']).not.toBeNull();
    expect(refs['execute#2']).toBe(refs.execute);
  });

  it('resolves the running execution\'s own key to the same element as the node key, nested', () => {
    // Folded node key is 'human-review#2/execute#1'; the running execution's
    // own key is 'human-review#2/execute#2'.
    const refs: Record<string, HTMLElement | null> = {};
    render(<RunStepper steps={nestedRoundWithTwoExecutions()} nodeRef={(key, el) => { refs[key] = el; }} />);
    expect(refs['human-review#2/execute#2']).not.toBeNull();
    expect(refs['human-review#2/execute#2']).toBe(refs['human-review#2/execute#1']);
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

// ---------------------------------------------------------------------------
// Stages — a `stages` step runs one body per stage file. Rows are in the
// shapes the runner writes: a body step directly under a stage carries the
// stages id as `loopId`, the attempt as `iteration` and the file as `stage`.
// ---------------------------------------------------------------------------

function stageRow(id: string, stage: string, attempt: number, extra: Partial<StepState> = {}): StepState {
  return {
    key: executionKey(id, attempt, [], stage), id, kind: 'agent', runner: 'claude', mode: 'headless',
    loopId: 'build', iteration: attempt, stage, status: 'done', ...extra,
  } as StepState;
}

function stagesRow(extra: Partial<StepState> = {}): StepState {
  return {
    key: 'build', id: 'build', kind: 'stages', status: 'running', total: 7, attempt: 1,
    currentStage: { id: '02-b', title: 'Add API routes', index: 2 }, completedStages: ['01-a'],
    startedStages: { '01-a': { title: 'Schema', index: 1, maxAttempts: 3 }, '02-b': { title: 'Add API routes', index: 2, maxAttempts: 3 } },
    ...extra,
  } as StepState;
}

function stagedRows(): StepState[] {
  return [
    { key: 'plan', id: 'plan', kind: 'command', status: 'done' } as StepState,
    stagesRow(),
    stageRow('implement', '01-a', 1),
    stageRow('accept', '01-a', 1, { kind: 'approval' }),
    stageRow('implement', '02-b', 1, { status: 'running' }),
  ];
}

describe('stages', () => {
  it('labels a stage group by stage, not by iteration', () => {
    render(<RunStepper steps={stagedRows()} />);
    expect(screen.getByText('stage 2 of 7 · Add API routes')).toBeInTheDocument();
    expect(screen.queryByText(/iteration/)).toBeNull();
  });

  it('draws the stages step as a container holding one group per stage', () => {
    render(<RunStepper steps={stagedRows()} />);
    const container = screen.getByTestId('step-stages-build');
    // The accepted stage starts collapsed; the running one is open already.
    fireEvent.click(screen.getByTestId('stage-toggle-build@01-a'));
    const first = within(container).getByTestId('stage-group-build@01-a');
    const second = within(container).getByTestId('stage-group-build@02-b');
    // The same step id in two stages is two pills, one under each stage.
    expect(within(first).getByTestId('step-card-implement@01-a#1')).toBeInTheDocument();
    expect(within(second).getByTestId('step-card-implement@02-b#1')).toHaveAccessibleName(/running/);
    // Finished before this render, and still named by its title, not its id.
    expect(within(first).getByTestId('stage-label-build@01-a')).toHaveTextContent('stage 1 of 7 · Schema');
  });

  it('says how many stages are accepted on the stages step\'s own pill', () => {
    render(<RunStepper steps={stagedRows()} />);
    expect(screen.getByTestId('step-meta-build')).toHaveTextContent('stages');
    expect(screen.getByTestId('stages-progress-build')).toHaveTextContent('1 of 7 accepted');
  });

  it('badges each attempt of a stage that was sent back', () => {
    render(<RunStepper steps={[
      stagesRow({
        attempt: 2, maxAttempts: 3, currentStage: { id: '01-a', title: 'Schema', index: 1 }, completedStages: [],
        startedStages: { '01-a': { title: 'Schema', index: 1, maxAttempts: 3 } },
      }),
      stageRow('implement', '01-a', 1),
      stageRow('accept', '01-a', 1, { kind: 'approval', verdict: 'fail' }),
      stageRow('implement', '01-a', 2, { status: 'running' }),
    ]} />);
    // The retry is running, so its stage is already open: no click needed,
    // and none wanted — it would close it.
    expect(screen.getByTestId('stage-toggle-build@01-a')).toHaveAttribute('aria-expanded', 'true');
    // One stage label, however many times the stage was attempted.
    expect(screen.getAllByText('stage 1 of 7 · Schema')).toHaveLength(1);
    expect(screen.getByTestId('stage-attempt-build@01-a#1')).toHaveTextContent(/^attempt 1 of 3$/);
    expect(screen.getByTestId('stage-attempt-build@01-a#2')).toHaveTextContent(/^attempt 2 of 3$/);
    expect(within(screen.getByTestId('stage-attempt-group-build@01-a#2'))
      .getByTestId('step-card-implement@01-a#2')).toBeInTheDocument();
  });

  it('drops the budget from the attempt badge when the run never recorded one', () => {
    render(<RunStepper steps={[
      stagesRow({ attempt: 2, currentStage: { id: '01-a', title: 'Schema', index: 1 }, completedStages: [], startedStages: undefined }),
      stageRow('implement', '01-a', 1),
      stageRow('implement', '01-a', 2, { status: 'running' }),
    ]} />);
    expect(screen.getByTestId('stage-attempt-build@01-a#2')).toHaveTextContent(/^attempt 2$/);
  });

  it('shows no attempt badge on a stage accepted first time', () => {
    render(<RunStepper steps={stagedRows()} />);
    fireEvent.click(screen.getByTestId('stage-toggle-build@01-a'));
    expect(screen.getByTestId('step-card-implement@01-a#1')).toBeInTheDocument();
    expect(screen.queryByText(/attempt/)).toBeNull();
  });

  it('counts stages rather than raw steps when collapsed inside a stage', () => {
    render(<RunStepper steps={stagedRows()} focusStepId="implement" collapsed onToggleCollapse={vi.fn()} />);
    expect(screen.getByTestId('step-card-implement@02-b#1')).toBeInTheDocument();
    expect(screen.queryByTestId('step-card-plan')).not.toBeInTheDocument();
    expect(screen.getByText('stage 2 of 7')).toBeInTheDocument();
  });

  it('counts a stages step as one step when collapsed outside it', () => {
    // Its body repeats per stage, so counting body pills would make the total
    // grow as stages pass — the same reason a loop's iterations are folded.
    render(<RunStepper steps={stagedRows()} focusStepId="plan" collapsed onToggleCollapse={vi.fn()} />);
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('collapses a focused stages step to its own pill', () => {
    render(<RunStepper steps={stagedRows().slice(0, 2)} focusStepId="build" collapsed onToggleCollapse={vi.fn()} />);
    expect(screen.getByTestId('step-card-build')).toBeInTheDocument();
    expect(screen.queryByTestId('step-stages-build')).not.toBeInTheDocument();
  });

  it('shows a disabled stages step as one dimmed pill counting its body', () => {
    render(<RunStepper steps={[
      stagesRow({ status: 'disabled', currentStage: undefined, total: undefined, completedStages: undefined }),
      { key: 'implement', id: 'implement', stagesId: 'build', status: 'disabled' } as StepState,
      { key: 'accept', id: 'accept', stagesId: 'build', status: 'disabled' } as StepState,
    ]} />);
    expect(screen.getByTestId('step-disabled-build')).toBeInTheDocument();
    expect(screen.getByTestId('step-meta-build')).toHaveTextContent('stages disabled — 2 steps not run');
    expect(screen.queryByTestId('step-card-implement')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // One collapsible row per stage.
  // -------------------------------------------------------------------------

  /** Three accepted stages and nothing running: the shape of a run that finished cleanly. */
  function finishedStagedRows(): StepState[] {
    return [
      stagesRow({
        status: 'done', total: 3, completed: 3, currentStage: undefined,
        completedStages: ['01-a', '02-b', '03-c'],
        startedStages: {
          '01-a': { title: 'Schema', index: 1, maxAttempts: 3 },
          '02-b': { title: 'API', index: 2, maxAttempts: 3 },
          '03-c': { title: 'UI', index: 3, maxAttempts: 3 },
        },
      }),
      ...['01-a', '02-b', '03-c'].flatMap(id => [
        stageRow('implement', id, 1),
        stageRow('accept', id, 1, { kind: 'approval' }),
      ]),
    ];
  }

  it('renders a finished run with every stage collapsed and no body steps in the tree', () => {
    render(<RunStepper steps={finishedStagedRows()} />);
    for (const id of ['01-a', '02-b', '03-c']) {
      expect(screen.getByTestId(`stage-toggle-build@${id}`)).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId(`step-card-implement@${id}#1`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`step-card-accept@${id}#1`)).not.toBeInTheDocument();
    }
    // The stages step's own pill is not part of any stage's body.
    expect(screen.getByTestId('step-card-build')).toBeInTheDocument();
  });

  it('opens the failed stage of a stopped run and leaves the others closed', () => {
    render(<RunStepper steps={[
      stagesRow({ status: 'failed', total: 3, currentStage: { id: '03-c', title: 'UI', index: 3 }, completedStages: ['01-a', '02-b'] }),
      stageRow('implement', '01-a', 1),
      stageRow('implement', '02-b', 1),
      stageRow('implement', '03-c', 1, { status: 'failed' }),
    ]} />);
    expect(screen.getByTestId('stage-toggle-build@01-a')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('stage-toggle-build@02-b')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('stage-toggle-build@03-c')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('step-card-implement@03-c#1')).toBeInTheDocument();
    expect(screen.queryByTestId('step-card-implement@01-a#1')).not.toBeInTheDocument();
  });

  it('opens the stage holding the focused step even when another stage is running', () => {
    render(<RunStepper steps={stagedRows()} focusStepId="accept" />);
    // `accept` only ran in 01-a, so that is where focus is; 02-b is running but loses to it.
    expect(screen.getByTestId('stage-toggle-build@01-a')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('stage-toggle-build@02-b')).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands a collapsed stage and collapses an expanded one when its header is clicked', () => {
    render(<RunStepper steps={stagedRows()} />);
    const closed = screen.getByTestId('stage-toggle-build@01-a');
    const open = screen.getByTestId('stage-toggle-build@02-b');
    expect(closed).toHaveAttribute('aria-expanded', 'false');
    expect(open).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(closed);
    expect(closed).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('step-card-implement@01-a#1')).toBeInTheDocument();

    fireEvent.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('step-card-implement@02-b#1')).not.toBeInTheDocument();
  });

  it('keeps a stage the reader closed closed while the run moves on', () => {
    const { rerender } = render(<RunStepper steps={stagedRows()} />);
    fireEvent.click(screen.getByTestId('stage-toggle-build@02-b'));
    // The stage is still running after the rerender, so its default would be open: only the
    // reader's recorded close can keep it shut.
    rerender(<RunStepper steps={[...stagedRows(), stageRow('accept', '02-b', 1, { kind: 'approval', status: 'running' })]} />);
    expect(screen.getByTestId('stage-toggle-build@02-b')).toHaveAttribute('aria-expanded', 'false');
  });

  // -------------------------------------------------------------------------
  // Following a live run, until the reader takes over.
  // -------------------------------------------------------------------------

  const LIVE_STAGES = ['01-a', '02-b', '03-c', '04-d'];
  /** A stage that has not started has no row yet, and so is not open. */
  const isOpen = (id: string) => screen.queryByTestId(`stage-toggle-build@${id}`)?.getAttribute('aria-expanded') === 'true';

  /** A four-stage run with stage `running` (1-based) in flight and the ones before it accepted. */
  function liveRows(running: number): StepState[] {
    const started = LIVE_STAGES.slice(0, running);
    return [
      stagesRow({
        total: 4,
        currentStage: { id: started[running - 1], title: `Stage ${running}`, index: running },
        completedStages: started.slice(0, -1),
        startedStages: Object.fromEntries(started.map((id, i) => [id, { title: `Stage ${i + 1}`, index: i + 1, maxAttempts: 3 }])),
      }),
      ...started.map((id, i) => stageRow('implement', id, 1, i === running - 1 ? { status: 'running' } : {})),
    ];
  }

  it('moves the open stage along with the run while nothing has been touched', () => {
    const { rerender } = render(<RunStepper steps={liveRows(3)} />);
    expect(LIVE_STAGES.map(isOpen)).toEqual([false, false, true, false]);

    rerender(<RunStepper steps={liveRows(4)} />);
    expect(LIVE_STAGES.map(isOpen)).toEqual([false, false, false, true]);
    expect(screen.getByTestId('step-card-implement@04-d#1')).toBeInTheDocument();
    expect(screen.queryByTestId('step-card-implement@03-c#1')).not.toBeInTheDocument();
  });

  it('stops following once the reader has opened a stage of their own', () => {
    const { rerender } = render(<RunStepper steps={liveRows(3)} />);
    fireEvent.click(screen.getByTestId('stage-toggle-build@02-b'));
    // Nothing moved under the click: the running stage the reader could see stays as it was.
    expect(LIVE_STAGES.map(isOpen)).toEqual([false, true, true, false]);

    rerender(<RunStepper steps={liveRows(4)} />);
    // The new stage does not steal the view, and the finished one does not fold itself.
    expect(LIVE_STAGES.map(isOpen)).toEqual([false, true, true, false]);
    expect(screen.queryByTestId('step-card-implement@04-d#1')).not.toBeInTheDocument();
  });

  it('collapses the auto-opened stage on the first click, and keeps it collapsed as the run moves on', () => {
    const { rerender } = render(<RunStepper steps={liveRows(3)} />);
    fireEvent.click(screen.getByTestId('stage-toggle-build@03-c'));
    expect(LIVE_STAGES.map(isOpen)).toEqual([false, false, false, false]);

    // Same stage, still running: were the default still contributing it would re-open.
    rerender(<RunStepper steps={[...liveRows(3), stageRow('accept', '03-c', 1, { kind: 'approval', status: 'running' })]} />);
    expect(isOpen('03-c')).toBe(false);

    rerender(<RunStepper steps={liveRows(4)} />);
    expect(LIVE_STAGES.map(isOpen)).toEqual([false, false, false, false]);
  });

  it('follows the run again on a fresh mount', () => {
    const first = render(<RunStepper steps={liveRows(3)} />);
    fireEvent.click(screen.getByTestId('stage-toggle-build@01-a'));
    first.unmount();

    render(<RunStepper steps={liveRows(4)} />);
    expect(LIVE_STAGES.map(isOpen)).toEqual([false, false, false, true]);
  });

  it('summarises a stage as steps, time and spend on its header line', () => {
    render(<RunStepper steps={[
      stagesRow({ status: 'done', total: 1, currentStage: undefined, completedStages: ['01-a'] }),
      stageRow('one', '01-a', 1, { startedAt: at(0), endedAt: at(600), progress: { turns: 8, costUsd: 0.5 } }),
      stageRow('two', '01-a', 1, { startedAt: at(600), endedAt: at(1260), progress: { turns: 12, costUsd: 1.34 } }),
      stageRow('three', '01-a', 1, { kind: 'command', startedAt: at(1260), endedAt: at(1290) }),
    ]} now={Date.parse(at(5000))} />);
    expect(screen.getByTestId('stage-summary-build@01-a')).toHaveTextContent('3 steps · 21m 30s · 20 turns · $1.84');
  });

  it('drops the spend from the summary of a stage whose steps reported none, and never shows a zero', () => {
    render(<RunStepper steps={[
      stagesRow({ status: 'done', total: 1, currentStage: undefined, completedStages: ['01-a'] }),
      stageRow('one', '01-a', 1, { kind: 'command', startedAt: at(0), endedAt: at(90) }),
    ]} now={Date.parse(at(5000))} />);
    const summary = screen.getByTestId('stage-summary-build@01-a');
    expect(summary).toHaveTextContent(/^1 step · 1m 30s$/);
    expect(summary).not.toHaveTextContent(/\$|turn|0 /);
  });

  it('names a stage that has not started, and reads "not started" on it', () => {
    render(<RunStepper steps={[
      stagesRow({ status: 'pending', currentStage: undefined, completedStages: undefined, total: undefined }),
      { key: 'implement', id: 'implement', kind: 'agent', stagesId: 'build', status: 'pending' } as StepState,
    ]} />);
    expect(screen.getByTestId('stage-label-build@')).toHaveTextContent('not started');
  });

  it('still badges both attempts of a retried stage once it is expanded', () => {
    render(<RunStepper steps={[
      stagesRow({
        status: 'done', attempt: 2, maxAttempts: 3, currentStage: undefined, completedStages: ['01-a'], total: 1,
        startedStages: { '01-a': { title: 'Schema', index: 1, maxAttempts: 3 } },
      }),
      stageRow('implement', '01-a', 1),
      stageRow('accept', '01-a', 1, { kind: 'approval', verdict: 'fail' }),
      stageRow('implement', '01-a', 2),
    ]} />);
    expect(screen.queryByTestId('stage-attempt-build@01-a#1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('stage-toggle-build@01-a'));
    expect(screen.getByTestId('stage-attempt-build@01-a#1')).toHaveTextContent(/^attempt 1 of 3$/);
    expect(screen.getByTestId('stage-attempt-build@01-a#2')).toHaveTextContent(/^attempt 2 of 3$/);
  });

  it('scrolls each attempt\'s pills in a track of their own, under the header', () => {
    render(<RunStepper steps={stagedRows()} />);
    const track = screen.getByTestId('stage-track-build@02-b#1');
    expect(track).toHaveStyle({ flexWrap: 'nowrap', overflowX: 'auto' });
    expect(within(track).getByTestId('step-card-implement@02-b#1')).toBeInTheDocument();
    expect(screen.getByTestId('stage-body-build@02-b')).toHaveStyle({ paddingLeft: '24px' });
  });

  it('stacks the stage rows in a column under the stages pill, without the old left marker', () => {
    render(<RunStepper steps={stagedRows()} />);
    expect(screen.getByTestId('step-stages-build')).toHaveStyle({ flexDirection: 'column', alignItems: 'stretch' });
    expect(screen.getByTestId('stage-group-build@01-a').style.borderLeft).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Layout — rows scroll rather than wrap, and the top level stacks. Styles are
// inline (jsdom loads no CSS), so `toHaveStyle` sees them; keep them inline.
// ---------------------------------------------------------------------------

describe('layout', () => {
  const leafRow = (id: string): StepState => ({ key: id, id, kind: 'command', status: 'done' }) as StepState;

  /** Three leaves, a stages step, then one more leaf — the shape that stranded `push` before. */
  function bandedRows(): StepState[] {
    return [
      leafRow('one'), leafRow('two'), leafRow('three'),
      stagesRow(), stageRow('implement', '01-a', 1),
      leafRow('push'),
    ];
  }

  it('stacks two step bands with the stages block between them', () => {
    render(<RunStepper steps={bandedRows()} />);
    const root = screen.getByTestId('run-stepper');
    expect(root).toHaveStyle({ display: 'flex', flexDirection: 'column' });
    const testids = Array.from(root.children).map(child => child.getAttribute('data-testid'));
    expect(testids).toEqual(['step-band-one', 'step-stages-build', 'step-band-push']);

    const first = screen.getByTestId('step-band-one');
    expect(within(first).getByTestId('step-card-one')).toBeInTheDocument();
    expect(within(first).getByTestId('step-card-three')).toBeInTheDocument();
    expect(within(first).queryByTestId('step-card-push')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('step-band-push')).getByTestId('step-card-push')).toBeInTheDocument();
  });

  it('draws a fixed-width connector between two pills, not a growing one', () => {
    render(<RunStepper steps={steps()} focusStepId="b" />);
    expect(screen.getByTestId('step-connector-b')).toHaveStyle({ flex: '0 0 12px' });
    expect(screen.getByTestId('step-connector-c')).toHaveStyle({ flex: '0 0 12px' });
    // Nothing leads the first pill of a track.
    expect(screen.queryByTestId('step-connector-a')).not.toBeInTheDocument();
  });

  it('scrolls a track sideways instead of wrapping it', () => {
    render(<RunStepper steps={bandedRows()} />);
    expect(screen.getByTestId('step-band-one')).toHaveStyle({ flexWrap: 'nowrap', overflowX: 'auto' });
    expect(screen.getByTestId('step-band-push')).toHaveStyle({ flexWrap: 'nowrap', overflowX: 'auto' });
  });

  it('scrolls a loop body too, inside its dashed container', () => {
    render(<RunStepper steps={loopRun(1)} />);
    const container = screen.getByTestId('step-loop-do-review');
    const track = within(container).getByTestId('step-loop-track-do-review');
    expect(track).toHaveStyle({ flexWrap: 'nowrap', overflowX: 'auto' });
    expect(within(track).getByTestId('step-card-do-review')).toBeInTheDocument();
  });

  // A track scrolls rather than shrinks its children: every kind of direct
  // child — not just the pill — must keep its width, or the box is squeezed
  // with the window before the track ever scrolls.
  it('keeps a loop box at its own width instead of shrinking it with the window', () => {
    render(<RunStepper steps={loopRun(1)} />);
    expect(screen.getByTestId('step-loop-do-review')).toHaveStyle({ flexShrink: '0' });
  });

  it('keeps a stages box nested in a loop at its own width instead of shrinking it', () => {
    const inLoop = [
      ...loopRun(1),
      stagesRow({ loopId: 'do-review', iteration: 1 }),
      stageRow('implement', '01-a', 1, { loopId: 'build' }),
    ];
    render(<RunStepper steps={inLoop} />);
    const track = screen.getByTestId('step-loop-track-do-review');
    const stages = within(track).getByTestId('step-stages-build');
    expect(stages.parentElement).toBe(track);
    expect(stages).toHaveStyle({ flexShrink: '0' });
  });

  it('keeps the chevron on a row of its own at the end when expanded', () => {
    render(<RunStepper steps={steps()} focusStepId="b" onToggleCollapse={vi.fn()} />);
    const row = screen.getByTestId('stepper-collapse-toggle').parentElement as HTMLElement;
    expect(row).toHaveStyle({ display: 'flex', justifyContent: 'flex-end' });
    expect(row.parentElement).toBe(screen.getByTestId('run-stepper'));
  });

  it('keeps collapsed as one row, the chevron pushed to its end', () => {
    render(<RunStepper steps={steps()} focusStepId="b" collapsed onToggleCollapse={vi.fn()} />);
    const root = screen.getByTestId('run-stepper');
    expect(root).not.toHaveStyle({ flexDirection: 'column' });
    expect(screen.getByTestId('stepper-collapse-toggle')).toHaveStyle({ marginLeft: 'auto' });
    expect(screen.getByTestId('stepper-collapse-toggle').parentElement).toBe(root);
  });
});
