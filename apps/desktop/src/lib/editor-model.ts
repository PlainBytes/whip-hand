/**
 * Pure view model for the workflow editor: the flat row list that replaces
 * `renderSteps`' recursion (indentation carries nesting instead of cards
 * containing cards), and the wiring lookup behind the reads:/writes: chip
 * highlight. Free of React, like `step-tree.ts` and `run-tree.ts` — this is
 * where the bulk of the editor's assertions live.
 */
import type { LoopStep, StagesStep, Step, Workflow } from '../shared/types.ts';
import { flattenSteps, isCommandStep, isContainerStep, isStagesStep } from '../shared/steps.ts';
import { disabledIds, untilTargetOf } from '../shared/enabled.ts';
import { ATTACHMENTS_REF } from '../shared/attachments.ts';
import { STAGE_REF } from '../shared/types.ts';
import type { StepPath } from './step-tree.ts';

export interface EditorRow {
  path: StepPath;
  depth: number;
  step: Step;
  /** This step is named by its enclosing tree's nearest loop `until:` — the "ends loop" badge. */
  endsLoop: boolean;
  /** This step will not run: it is disabled itself, or a descendant of a disabled container. */
  dimmed: boolean;
  /**
   * Sits inside a `stages` body, at any depth — where `stage` (the current
   * stage file) is a readable input and another `stages` step cannot go.
   */
  inStages: boolean;
}

/** The flat, indented row list the editor renders — one row per step, at any depth. */
export function editorRows(workflow: Workflow): EditorRow[] {
  const dimmedIds = disabledIds(workflow.steps);
  const rows: EditorRow[] = [];
  const walk = (steps: Step[], prefix: StepPath, depth: number, inStages: boolean): void => {
    steps.forEach((step, i) => {
      const path = [...prefix, i];
      rows.push({
        path,
        depth,
        step,
        endsLoop: untilTargetOf(workflow.steps, step.id) !== undefined,
        dimmed: dimmedIds.has(step.id),
        inStages,
      });
      if (isContainerStep(step)) walk(step.steps, path, depth + 1, inStages || isStagesStep(step));
    });
  };
  walk(workflow.steps, [], 0, false);
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
  const located = flattenSteps(workflow.steps);
  const flat = located.map(f => f.step);
  const inStagesIds = new Set(located.filter(f => f.stagesId !== undefined).map(f => f.step.id));

  const byId = new Map(flat.map(s => [s.id, s]));
  // `attachments` names the run's attached files, not a card: there is
  // nothing for it to light up, and a step wrongly *called* `attachments`
  // must not light up every reader of the files. Inside a stages body
  // `stage` is the same — the current stage file — whereas outside one it can
  // only be a real step of that name (schema.ts's STAGE_REF rule).
  const stepRefs = (step: Exclude<Step, LoopStep | StagesStep>): string[] =>
    (step.inputs ?? []).filter(ref => ref !== ATTACHMENTS_REF && !(ref === STAGE_REF && inStagesIds.has(step.id)));
  const dependents = new Map<string, string[]>();
  for (const step of flat) {
    if (isContainerStep(step) || isCommandStep(step)) continue; // a command's inputs: is a runtime no-op
    for (const src of stepRefs(step)) {
      const list = dependents.get(src) ?? [];
      list.push(step.id);
      dependents.set(src, list);
    }
  }

  return {
    sources(id: string): string[] {
      const step = byId.get(id);
      if (step === undefined || isContainerStep(step) || isCommandStep(step)) return [];
      return stepRefs(step);
    },
    dependents(id: string): string[] {
      return dependents.get(id) ?? [];
    },
  };
}
