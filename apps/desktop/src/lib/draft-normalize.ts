/**
 * A pure second line of defence against blank optional fields, ahead of
 * `validateWorkflowDraft` (see @whiphand/core's schema.ts): the editor's own
 * controls already write `undefined` for a field the user blanked out, but a
 * step built by `convertStep` or loaded from an older draft can still carry
 * `''` or `'   '`. Mirrors core's `optionalText` field list exactly, so a
 * field core treats as absent is never the one thing the editor still flags.
 */
import type { Step, Workflow, WorkflowInput } from '../../../../packages/core/src/types.ts';
import { isContainerStep } from '../../../../packages/core/src/steps.ts';

function blank(v: string | undefined): boolean {
  return v === undefined || v.trim() === '';
}

function normalizeInput(input: WorkflowInput): WorkflowInput {
  const next: Record<string, unknown> = { ...input };
  if (blank(input.prompt)) delete next.prompt;
  if (blank(input.default)) delete next.default;
  return next as unknown as WorkflowInput;
}

function normalizeStep(step: Step): Step {
  if (isContainerStep(step)) {
    return { ...step, steps: step.steps.map(normalizeStep) };
  }
  const next = { ...step } as Record<string, unknown>;
  if (step.kind === 'agent' && blank(step.model)) delete next.model;
  if (step.kind === 'command') {
    if (blank(step.shell)) delete next.shell;
    if (blank(step.cwd)) delete next.cwd;
  }
  // Every kind but 'agent' treats output as optional; 'agent' requires one,
  // so a blank there is a real problem for validateWorkflowDraft to flag.
  if (step.kind !== 'agent' && blank(step.output)) delete next.output;
  if (next.verdict === false) delete next.verdict;
  return next as unknown as Step;
}

export function normalizeDraft(workflow: Workflow): Workflow {
  const next = { ...workflow } as Record<string, unknown>;
  if (blank(workflow.description)) delete next.description;
  next.steps = workflow.steps.map(normalizeStep);
  if (workflow.inputs) {
    next.inputs = Object.fromEntries(Object.entries(workflow.inputs).map(([k, v]) => [k, normalizeInput(v)]));
  }
  return next as unknown as Workflow;
}
