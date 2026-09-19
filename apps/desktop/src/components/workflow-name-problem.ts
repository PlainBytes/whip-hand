import { WORKFLOW_NAME_RE, workflowNameProblem as coreNameProblem } from '../../../../packages/core/src/workflow-name.ts';
import type { Scope } from '../../../../packages/core/src/types.ts';
import { isWorkflowFile } from './workflow-lane/WorkflowLane.tsx';
import type { WorkflowEntry } from './workflow-lane/WorkflowLane.tsx';

/**
 * Client-side checks for a workflow name about to become a file — New
 * workflow's name and Clone's target name ask the same two questions of it:
 * would the agent accept it, and would it collide with or shadow a file that
 * already exists. The agent re-checks both (protocol regex, `wx` write), so
 * this only exists to say so beside the field while the user is typing,
 * instead of as a raw schema error after the click.
 */

/** Whether `candidate` is already used by a real workflow file in `scope`. */
export function isWorkflowNameTaken(existing: WorkflowEntry[], candidate: string, scope: Scope): boolean {
  return existing.some(e => e.source === scope && e.name === candidate && isWorkflowFile(e));
}

export interface WorkflowNameProblem {
  message: string;
  /** An error blocks the action; a same-name-in-the-other-scope warning does not. */
  blocking: boolean;
}

/**
 * What, if anything, is wrong with naming a new workflow file `name` in
 * `scope`. The other-scope case is a warning, not an error: overriding a
 * global workflow per-project is a supported move, it just shouldn't happen
 * by surprise.
 */
export function workflowNameProblem(
  name: string, scope: Scope, existing: WorkflowEntry[],
): WorkflowNameProblem | null {
  if (!WORKFLOW_NAME_RE.test(name)) {
    return { message: 'Use lowercase letters, digits, - and _ (start with a letter or digit)', blocking: true };
  }
  const reserved = coreNameProblem(name);
  if (reserved !== null) return { message: `${name} is not a usable name: ${reserved}`, blocking: true };
  if (isWorkflowNameTaken(existing, name, scope)) {
    return { message: `A workflow named ${name} already exists`, blocking: true };
  }
  const otherScope: Scope = scope === 'global' ? 'project' : 'global';
  if (isWorkflowNameTaken(existing, name, otherScope)) {
    const message = scope === 'project'
      ? `Will override the global workflow ${name} in this workspace`
      : `Hidden in this workspace by the project workflow ${name}`;
    return { message, blocking: false };
  }
  return null;
}
