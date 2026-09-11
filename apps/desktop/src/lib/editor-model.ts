/**
 * Pure view model for the workflow editor: the flat row list that replaces
 * `renderSteps`' recursion (indentation carries nesting instead of cards
 * containing cards), and the wiring lookup behind the reads:/writes: chip
 * highlight. Free of React, like `step-tree.ts` and `run-tree.ts` — this is
 * where the bulk of the editor's assertions live.
 */
import type { LoopStep, Step, Workflow } from '../../../../packages/core/src/types.ts';
import { isCommandStep, isLoopStep } from '../../../../packages/core/src/steps.ts';
import { disabledIds, untilTargetOf } from '../../../../packages/core/src/enabled.ts';
import { ATTACHMENTS_REF } from '../../../../packages/core/src/attachments.ts';
import type { StepPath } from './step-tree.ts';

export interface EditorRow {
  path: StepPath;
  depth: number;
  step: Step;
  /** This step is named by its enclosing tree's nearest loop `until:` — the "ends loop" badge. */
  endsLoop: boolean;
  /** This step will not run: it is disabled itself, or a descendant of a disabled loop. */
  dimmed: boolean;
}

/** The flat, indented row list the editor renders — one row per step, at any depth. */
export function editorRows(workflow: Workflow): EditorRow[] {
  const dimmedIds = disabledIds(workflow.steps);
  const rows: EditorRow[] = [];
  const walk = (steps: Step[], prefix: StepPath, depth: number): void => {
    steps.forEach((step, i) => {
      const path = [...prefix, i];
      rows.push({
        path,
        depth,
        step,
        endsLoop: untilTargetOf(workflow.steps, step.id) !== undefined,
        dimmed: dimmedIds.has(step.id),
      });
      if (isLoopStep(step)) walk(step.steps, path, depth + 1);
    });
  };
  walk(workflow.steps, [], 0);
  return rows;
}

export interface Wiring {
  /** Ids this step reads from — the cards its `reads:` chip lights up. */
  sources(id: string): string[];
  /** Ids of steps that read this one — the cards its `writes:` chip lights up. */
  dependents(id: string): string[];
}

/** Precomputes the reads/writes graph once per draft, for the chip-highlight lookups. */
export function wiring(workflow: Workflow): Wiring {
  const flat: Step[] = [];
  const walk = (steps: Step[]): void => {
    for (const step of steps) {
      flat.push(step);
      if (isLoopStep(step)) walk(step.steps);
    }
  };
  walk(workflow.steps);

  const byId = new Map(flat.map(s => [s.id, s]));
  // `attachments` names the run's attached files, not a card: there is
  // nothing for it to light up, and a step wrongly *called* `attachments`
  // must not light up every reader of the files.
  const stepRefs = (step: Exclude<Step, LoopStep>): string[] =>
    (step.inputs ?? []).filter(ref => ref !== ATTACHMENTS_REF);
  const dependents = new Map<string, string[]>();
  for (const step of flat) {
    if (isLoopStep(step) || isCommandStep(step)) continue; // a command's inputs: is a runtime no-op
    for (const src of stepRefs(step)) {
      const list = dependents.get(src) ?? [];
      list.push(step.id);
      dependents.set(src, list);
    }
  }

  return {
    sources(id: string): string[] {
      const step = byId.get(id);
      if (step === undefined || isLoopStep(step) || isCommandStep(step)) return [];
      return stepRefs(step);
    },
    dependents(id: string): string[] {
      return dependents.get(id) ?? [];
    },
  };
}
