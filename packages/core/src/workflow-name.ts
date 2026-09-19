/**
 * The workflow name pattern, split out from scaffold.ts so it can be
 * imported without pulling in scaffold.ts's `node:*` dependencies — the
 * desktop renderer (a browser context) needs this pattern for client-side
 * validation but must never load Node-only modules.
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
