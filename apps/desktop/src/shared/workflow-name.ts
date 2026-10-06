/**
 * The workflow name pattern (whiphand-core's workflow_name.rs), for the
 * webview's client-side checks before createWorkflow and cloneWorkflow.
 * core-goldens.test.ts checks it against core's goldens.
 */
import { validateSegment } from './segment.ts';

export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The shape check *and* the segment validator (invariant 3): the pattern alone
 * lets `con`, `nul` and `com1` through, and a workflow name becomes a file name.
 */
export function isValidWorkflowName(name: string): boolean {
  return WORKFLOW_NAME_RE.test(name) && validateSegment(name).ok;
}

/** Why `name` is not a workflow name, or null when it is. */
export function workflowNameProblem(name: string): string | null {
  if (!WORKFLOW_NAME_RE.test(name)) return `want ${WORKFLOW_NAME_RE}`;
  const segment = validateSegment(name);
  return segment.ok ? null : segment.reason;
}
