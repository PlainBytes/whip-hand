/**
 * The desktop's entry points into the `author-workflow` starter: "Design with
 * AI" and "Edit with AI" on the Workflows page, "Open in editor" on a run of
 * it. The starter itself (its inputs, its `save` step) is core's template;
 * this module only names what the UI relies on.
 */
import type { Scope } from '../shared/types.ts';
import type { WorkflowEntry } from './new-run-draft.ts';

/** The shipped starter's name, as `restoreWorkflows` and `startRun` know it. */
export const AUTHOR_WORKFLOW = 'author-workflow';

/** The step that writes the signed-off workflow; once it is done, the workflow exists. */
const SAVE_STEP = 'save';

const SCOPES: readonly Scope[] = ['project', 'workspace', 'global'];

/**
 * The `author-workflow` entry a run would use, or undefined when none is
 * usable: absent, unparseable, or only a copy shadowed by a higher scope.
 */
export function findAuthorWorkflow(workflows: readonly WorkflowEntry[]): WorkflowEntry | undefined {
  return workflows.find(w => w.name === AUTHOR_WORKFLOW && w.workflow !== undefined && !w.error && !w.shadowed);
}

/** The slice of a run's manifest this reads; core's manifest is loosely typed here. */
interface RunLike {
  status?: unknown;
  workflow?: unknown;
  inputs?: unknown;
  steps?: unknown;
}

/**
 * The workflow a finished `author-workflow` run saved, as `{ name, scope }`;
 * null for any other run, a run still going, or one whose `save` step did
 * not succeed. A finished run's manifest status is core's `succeeded`
 * (`done` is only ever a step status). A blank or unknown `scope` reads as the template's default,
 * `project`.
 */
export function savedWorkflowOf(run: RunLike | null | undefined): { name: string; scope: Scope } | null {
  if (!run || run.workflow !== AUTHOR_WORKFLOW || run.status !== 'succeeded') return null;
  const steps = Array.isArray(run.steps) ? (run.steps as Array<{ id?: unknown; status?: unknown }>) : [];
  if (!steps.some(step => step.id === SAVE_STEP && step.status === 'done')) return null;
  const inputs = (run.inputs ?? {}) as Record<string, unknown>;
  const name = typeof inputs.name === 'string' ? inputs.name.trim() : '';
  if (name === '') return null;
  const rawScope = typeof inputs.scope === 'string' ? inputs.scope.trim() : '';
  const scope = (SCOPES as readonly string[]).includes(rawScope) ? (rawScope as Scope) : 'project';
  return { name, scope };
}

/**
 * A placeholder for one of the New Run form's inputs. Only `author-workflow`'s
 * `goal` has one, and only when a workflow file is attached: that draft is an
 * "Edit with AI", so the goal is a change rather than a whole design.
 */
export function authorInputPlaceholder(workflowName: string | undefined, inputKey: string, attachmentCount: number): string | undefined {
  if (workflowName !== AUTHOR_WORKFLOW || inputKey !== 'goal' || attachmentCount === 0) return undefined;
  return 'What should change?';
}
