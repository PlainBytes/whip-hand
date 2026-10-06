import type { StepState } from '../../state/store.ts';
import type { StepNode } from '../../lib/run-tree.ts';
import { elapsedMs, formatElapsed } from '../../shared/format.ts';
import { usageParts } from '../../shared/log-rows.ts';

/**
 * The pill outline per status — the same fill the status badge uses, so the
 * ring and the badge always agree. CSS variables (not the `tokens` object) so
 * both webLightTheme and webDarkTheme work with no extra wiring.
 */
const STEP_STATUS_COLOR: Record<StepState['status'], string> = {
  done: 'var(--colorPaletteGreenBackground3)',
  failed: 'var(--colorPaletteRedBackground3)',
  running: 'var(--colorBrandStroke1)',
  interrupted: 'var(--colorPaletteDarkOrangeBackground3)',
  pending: 'var(--colorNeutralStroke2)',
  disabled: 'var(--colorNeutralStroke2)',
};

export function stepStatusColor(status: StepState['status']): string {
  return STEP_STATUS_COLOR[status] ?? 'var(--colorNeutralStroke2)';
}

/**
 * What a step will use, in the pill itself rather than behind a click. A step
 * that spends no tokens has no runner or model to name, so it says what it is
 * instead — the reader still learns why it has no model.
 */
export function metaLine(step: StepState): string {
  switch (step.kind) {
    case 'command':
    case 'manual':
    case 'approval':
    case 'loop':
    case 'stages':
      return step.kind;
    default:
      // 'agent', and undefined for v1 manifests written before kinds existed.
      return [step.runner ?? '—', step.model ?? 'default', step.mode ?? '—'].join(' · ');
  }
}

/**
 * How long this execution has taken: frozen once it ends, still counting
 * against `clock` while it runs, and absent entirely before it starts — a
 * pending step showing '0s' would read as one that ran instantly.
 */
export function stepDuration(step: StepState, clock: number): string | null {
  const end = step.endedAt === undefined ? clock : Date.parse(step.endedAt);
  const ms = elapsedMs(step.startedAt, end);
  return ms === null ? null : formatElapsed(ms);
}

/** 'iteration 2 of 3', or 'iteration 2' for a run that recorded no budget. */
export function loopProgress(loop: StepState): string | null {
  if (!loop.iterations) return null;
  return loop.maxIterations === undefined
    ? `iteration ${loop.iterations}`
    : `iteration ${loop.iterations} of ${loop.maxIterations}`;
}

/**
 * 'N of M accepted' — progress in stages, on the stages step's own pill.
 * Never 'iteration': a stage is not a lap of a loop. `completed` is only
 * written once the step is done, so the running count is the accepted list.
 */
export function stagesProgress(stages: StepState): string | null {
  if (stages.total === undefined) return null;
  const accepted = stages.completed ?? stages.completedStages?.length ?? 0;
  return `${accepted} of ${stages.total} accepted`;
}

/** The pill a node is represented by: its own row for a container, its newest execution for a leaf. */
export function nodeStep(node: StepNode): StepState {
  switch (node.kind) {
    case 'loop': return node.loop;
    case 'stages': return node.stages;
    default: return node.latest;
  }
}

/**
 * What this step has cost so far, for the pill's own second line, beside the
 * duration — spend and elapsed are the same kind of fact and read as one
 * cluster. Every part is optional because it depends on what the runner
 * reported — claude gives a dollar cost, copilot gives premium requests — so
 * absent counters are left out rather than shown as zeroes.
 *
 * Deliberately no `lastAction`: what a step is doing right now is the last
 * line of the Terminal tab's feed, and the pill saying it too is exactly the
 * duplication this row was cleaned up to stop.
 */
export function spendSummary(progress: NonNullable<StepState['progress']>): string | null {
  const parts = usageParts(progress, usd => `$${usd.toFixed(2)}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The one-line answer to "is it stuck?", for the popover: what the step is
 * doing on top of what it has spent. The feed only survives while the step is
 * live, so this is where the last action a *finished* step reported stays
 * readable. Elapsed time is not repeated here: the pill already carries it.
 */
export function progressSummary(progress: NonNullable<StepState['progress']>): string | null {
  const spend = spendSummary(progress);
  const parts = [
    ...(progress.lastAction === undefined ? [] : [progress.lastAction]),
    ...(spend === null ? [] : [spend]),
  ];
  return parts.length === 0 ? null : parts.join(' · ');
}
