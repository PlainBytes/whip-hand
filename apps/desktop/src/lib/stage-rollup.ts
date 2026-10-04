/**
 * One stage of a `stages` step, boiled down to the facts its header shows:
 * how it went, how many steps it holds, how long it took, what it cost.
 *
 * Takes every attempt at the stage rather than one `StageGroup`, because a
 * stage sent back after a rejection is one group per attempt (see run-tree.ts)
 * and its header speaks for the stage, not for the attempt.
 *
 * Deliberately pure and free of React, like run-tree.ts: the folding is the
 * part worth testing, and the stepper should only have to lay out what it is
 * handed.
 */
import type { StepState } from '../state/store.ts';
import { elapsedMs, formatElapsed } from '../shared/format.ts';
import { usageParts, type UsageCounters } from '../shared/log-rows.ts';
import { flattenNodes, type StageGroup, type StepNode } from './run-tree.ts';

export interface StageRollup {
  status: StepState['status'];
  /** Nodes, not executions, disabled ones excluded — the stepper's own "N of M" rule. */
  steps: number;
  elapsed: string | null;
  spend: string | null;
}

/** Most urgent first: the first of these any live node is in is the stage's status. */
const PRECEDENCE: readonly StepState['status'][] = ['running', 'failed', 'interrupted', 'pending', 'done'];

/** The row a node is represented by: its own for a container, its newest execution for a leaf. */
function nodeStep(node: StepNode): StepState {
  switch (node.kind) {
    case 'loop': return node.loop;
    case 'stages': return node.stages;
    default: return node.latest;
  }
}

/** Every row a node owns — for timings, a folded step's older executions count as well as its newest. */
function nodeRows(node: StepNode): readonly StepState[] {
  return node.kind === 'step' ? node.executions : [nodeStep(node)];
}

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : a + b;
}

/**
 * `attempts` are one stage's groups, in order. `clock` is the page's ticking
 * `Date.now()`, passed in for the same reason `elapsedMs` takes its end: so a
 * live stage is one interval owned by the page, and so tests can pin it.
 */
export function stageRollup(attempts: readonly StageGroup[], clock: number): StageRollup {
  const nodes = attempts.flatMap(attempt => flattenNodes(attempt.children));
  const live = nodes.filter(node => nodeStep(node).status !== 'disabled');

  const statuses = new Set(live.map(node => nodeStep(node).status));
  const status: StepState['status'] =
    PRECEDENCE.find(candidate => statuses.has(candidate)) ?? (nodes.length === 0 ? 'pending' : 'disabled');

  return { status, steps: live.length, elapsed: stageElapsed(live, status === 'running', clock), spend: stageSpend(live) };
}

/**
 * Earliest start to latest end, or to `clock` while anything is running.
 * With no recorded end at all it reads against `clock` too — what
 * `stepDuration` does for a single step — rather than inventing a frozen span.
 */
function stageElapsed(live: readonly StepNode[], running: boolean, clock: number): string | null {
  let startedAt: string | undefined;
  let earliest = Infinity;
  let latest = -Infinity;
  for (const row of live.flatMap(nodeRows)) {
    const start = row.startedAt === undefined ? NaN : Date.parse(row.startedAt);
    if (start < earliest) {
      earliest = start;
      startedAt = row.startedAt;
    }
    const end = row.endedAt === undefined ? NaN : Date.parse(row.endedAt);
    if (end > latest) latest = end;
  }
  const ms = elapsedMs(startedAt, running || latest === -Infinity ? clock : latest);
  return ms === null ? null : formatElapsed(ms);
}

/**
 * Sums each leaf's *newest* execution only: a loop body step folds every
 * iteration into one node, and each iteration's report is that spawn's own
 * running total, so adding them all would count the step once per lap.
 * A counter nobody reported stays absent instead of summing to a made-up 0.
 */
function stageSpend(live: readonly StepNode[]): string | null {
  const total: UsageCounters = {};
  for (const node of live) {
    if (node.kind !== 'step' || node.latest.progress === undefined) continue;
    const { turns, costUsd, premiumRequests } = node.latest.progress;
    total.turns = addOptional(total.turns, turns);
    total.costUsd = addOptional(total.costUsd, costUsd);
    total.premiumRequests = addOptional(total.premiumRequests, premiumRequests);
  }
  const parts = usageParts(total, usd => `$${usd.toFixed(2)}`);
  return parts.length === 0 ? null : parts.join(' · ');
}
