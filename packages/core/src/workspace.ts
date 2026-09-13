import { readFile, access, readdir } from 'node:fs/promises';
import { resolve, join, basename, extname } from 'node:path';
import { globalWorkflowsDir } from './config-home.ts';
import { WORKFLOW_NAME_RE, assertValidWorkflowName } from './scaffold.ts';
import { parseWorkflow } from './schema.ts';
import type { Scope, Workflow } from './types.ts';

export function parseInputPairs(pairs: string[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new Error(`--input expects key=value, got '${pair}'`);
    inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return inputs;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedWorkflow {
  path: string;
  source: Scope;
}

function projectWorkflowPath(workdir: string, name: string): string {
  return join(workdir, '.whiphand', 'workflows', `${name}.yaml`);
}

function globalWorkflowPath(name: string): string {
  return join(globalWorkflowsDir(), `${name}.yaml`);
}

const EXPLICIT_SCOPE_RE = /^(global|project):(.+)$/;

/**
 * Resolves a workflow reference to a real path plus where it came from.
 * Order:
 *   1. An explicit `global:<name>` / `project:<name>` selector — parsed
 *      first, before any path attempt, and erroring outright if the named
 *      scope doesn't have it.
 *   2. As a filesystem path relative to `workdir` — still ahead of name
 *      lookup (so e.g. `whiphand run examples/cycle.yaml` keeps working).
 *      Treated as belonging to the project scope: it's resolved against the
 *      workspace's own working directory, same as everything else here that
 *      isn't the shared global root.
 *   3. Project `.whiphand/workflows/<ref>.yaml`, if it exists.
 *   4. Global `<configHome>/workflows/<ref>.yaml`, if it exists.
 *   5. Otherwise an error naming both locations searched.
 *
 * A *name* — anything joined into one of the two scope directories, whether it
 * arrived through a selector or as a bare ref — is checked against
 * WORKFLOW_NAME_RE first, the same validator createWorkflow and
 * updateWorkflow already enforce on the way in. Without it `global:../../x`
 * escapes the global root entirely, and the agent's `getWorkflow` hands that
 * string straight through. Step 2 is deliberately exempt: a path is
 * *supposed* to be a path, and it resolves against the caller's own workdir.
 */
export async function resolveWorkflowPath(workflowRef: string, workdir: string): Promise<ResolvedWorkflow> {
  const explicit = EXPLICIT_SCOPE_RE.exec(workflowRef);
  if (explicit) {
    const [, scope, name] = explicit as unknown as [string, Scope, string];
    assertValidWorkflowName(name);
    const path = scope === 'global' ? globalWorkflowPath(name) : projectWorkflowPath(workdir, name);
    if (!(await pathExists(path))) {
      throw new Error(`workflow '${name}' not found at ${scope}:${path}`);
    }
    return { path, source: scope };
  }

  const asPath = resolve(workdir, workflowRef);
  if (await pathExists(asPath)) return { path: asPath, source: 'project' };

  // Not a name we'd ever have written, so there is nothing to look up under
  // either scope — report the same "not found" the lookup would have, rather
  // than building paths out of it.
  if (!WORKFLOW_NAME_RE.test(workflowRef)) {
    throw new Error(`workflow '${workflowRef}' not found — no such file, and not a valid workflow name`);
  }

  const projectPath = projectWorkflowPath(workdir, workflowRef);
  if (await pathExists(projectPath)) return { path: projectPath, source: 'project' };

  const globalPath = globalWorkflowPath(workflowRef);
  if (await pathExists(globalPath)) return { path: globalPath, source: 'global' };

  throw new Error(
    `workflow '${workflowRef}' not found — looked at ${projectPath} and ${globalPath}`);
}

export interface WorkflowListEntry {
  name: string;
  path: string;
  source: Scope;
  /** Set on a global entry whose name is also defined at project scope. */
  shadowed?: true;
  workflow?: Workflow;
  error?: string;
}

/**
 * One scope's own `*.yaml`/`*.yml` entries. A missing directory degrades to
 * nothing (today's behavior for a missing project dir, extended to the
 * global one). A directory that exists but can't be read (EACCES) is
 * different in kind and not silent: it surfaces as a single error entry so
 * the caller learns why a whole scope's workflows vanished, rather than
 * losing them quietly.
 */
async function listScope(dir: string, source: Scope): Promise<WorkflowListEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [{ name: source, path: dir, source, error: `cannot read ${dir}: ${(e as Error).message}` }];
  }
  const files = entries.filter(f => extname(f) === '.yaml' || extname(f) === '.yml').sort();
  const results: WorkflowListEntry[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const name = basename(file, extname(file));
    try {
      const workflow = parseWorkflow(await readFile(path, 'utf8'));
      results.push({ name, path, source, workflow });
    } catch (e) {
      results.push({ name, path, source, error: (e as Error).message });
    }
  }
  return results;
}

/**
 * Merges the workspace's own workflows with the global ones. Sorted by name;
 * where a name exists in both scopes, the project entry comes first with the
 * global one right behind it flagged `shadowed` — so the pair renders
 * adjacently and the override is self-evident rather than one silently
 * disappearing.
 */
export async function listWorkflows(workdir: string): Promise<WorkflowListEntry[]> {
  const [project, global] = await Promise.all([
    listScope(join(workdir, '.whiphand', 'workflows'), 'project'),
    listScope(globalWorkflowsDir(), 'global'),
  ]);
  const projectNames = new Set(project.filter(e => e.error === undefined).map(e => e.name));
  const flagged = [...project, ...global].map(e =>
    (e.source === 'global' && projectNames.has(e.name) ? { ...e, shadowed: true as const } : e));
  flagged.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.source === b.source ? 0 : a.source === 'project' ? -1 : 1;
  });
  return flagged;
}
