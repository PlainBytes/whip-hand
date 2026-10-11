import type { AppState as AppStateData, ListWorkflowsResult } from '../shared/protocol.gen.ts';

export type WorkflowEntry = ListWorkflowsResult[number];

type WorkspaceMemory = AppStateData['workspaces'][string];

/** Disambiguates a project/global pair sharing a name. */
export function entryKey(entry: WorkflowEntry): string {
  return `${entry.source}:${entry.name}`;
}

/**
 * The ref sent to `startRun` for this entry — `global:<name>` for a global
 * entry, bare `<name>` for a project one. Also the key the agent's
 * `rememberRun` files lastInputs/lastWorkflow under (`p.workflow` is this
 * same ref), so every read or optimistic local write of remembered state
 * must go through this to stay on the same key a global and project entry
 * of the same name would otherwise collide on.
 */
export function refFor(entry: WorkflowEntry): string {
  return entry.source === 'global' ? `global:${entry.name}` : entry.name;
}

/**
 * Mirrors whiphand-core's workspace.rs, which resolves a workflow ref against
 * the filesystem and so cannot run here. Keep this in lockstep with its
 * explicit-scope pattern by hand; there is no build-time check that can do it
 * for us.
 */
const EXPLICIT_SCOPE_RE = /^(global|project):(.+)$/;

/**
 * Resolves a workflow ref (bare name, or `global:`/`project:`-prefixed) to a
 * list entry. A bare name is ambiguous across scopes — it matches the first
 * entry in list order, which is the project one when both exist.
 */
export function findEntry(workflows: WorkflowEntry[], ref: string): WorkflowEntry | undefined {
  const explicit = EXPLICIT_SCOPE_RE.exec(ref);
  if (explicit) {
    const [, scope, name] = explicit;
    return workflows.find(e => e.name === name && e.source === scope);
  }
  return workflows.find(e => e.name === ref);
}

/**
 * A file waiting to be attached, always as a path: the agent does the copying,
 * and the webview could not read an arbitrary path anyway. A pasted image has
 * no path of its own, so the form stashes its bytes with the agent at once and
 * keeps the stash path here, flagged `pasted` so its chip can show a thumbnail.
 */
export interface PendingAttachment {
  key: number;
  path: string;
  pasted?: boolean;
}

/** A request to reopen a past run's workflow with its inputs ("Run again", "Run workflow"). */
export interface RunAgain {
  workflow: string;
  inputs: Record<string, string>;
}

/**
 * The inputs a workflow's form starts with: an explicit override wins, then
 * the remembered value (only for an input marked `remember: true`), then the
 * declared default, then blank.
 */
export function initialValues(
  entry: WorkflowEntry, memory: WorkspaceMemory | undefined, override?: Record<string, string>,
): Record<string, string> {
  const values: Record<string, string> = {};
  if (!entry.workflow?.inputs) return values;
  const remembered = memory?.lastInputs[refFor(entry)] ?? {};
  for (const [key, input] of Object.entries(entry.workflow.inputs)) {
    values[key] = override?.[key]
      ?? (input.remember ? remembered[key] : undefined)
      ?? input.default
      ?? '';
  }
  return values;
}

/**
 * What a fresh draft starts with: an explicit run-again ref and inputs win;
 * otherwise the workspace's remembered `lastWorkflow`. A target that is gone or
 * has a parse error falls back to the remembered one. Null when nothing
 * qualifies — including when the list is not loaded yet, so the caller can
 * apply it once workflows arrive.
 */
export function preselect(
  workflows: WorkflowEntry[], memory: WorkspaceMemory | undefined, runAgain?: RunAgain,
): { workflowRef: string; values: Record<string, string> } | null {
  if (workflows.length === 0) return null;
  if (runAgain) {
    const target = findEntry(workflows, runAgain.workflow);
    if (target && !target.error) {
      return { workflowRef: refFor(target), values: initialValues(target, memory, runAgain.inputs) };
    }
  }
  const fallback = memory?.lastWorkflow ? findEntry(workflows, memory.lastWorkflow) : undefined;
  if (fallback && !fallback.error) {
    return { workflowRef: refFor(fallback), values: initialValues(fallback, memory) };
  }
  return null;
}
