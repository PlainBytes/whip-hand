/**
 * Workspace/workflow scaffolding (product def F8/F9). Shared by the CLI
 * (`whiphand init`, `whiphand new-workflow`) and the desktop app (via @whiphand/agent RPCs) so
 * the UI never grows an ability the CLI lacks.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { globalWorkflowsDir } from './config-home.ts';
import { DEFAULT_CONFIG } from './config.ts';
import { WorkflowError, parseWorkflow, validateWorkflowSemantics } from './schema.ts';
import { mergeWorkflow } from './workflow-write.ts';
import type { Scope, Workflow } from './types.ts';
import { WORKFLOW_NAME_RE, workflowNameProblem } from './workflow-name.ts';
import { SHIPPED_TEMPLATES, readTemplate } from './templates.ts';

export { WORKFLOW_NAME_RE } from './workflow-name.ts';

/**
 * Every writer *and reader* must run this before interpolating `name` into a
 * path. The pattern admits no `/`, `.` or `..`, so a caller-supplied name can
 * never escape .whiphand/workflows or the global workflows dir — the desktop webview
 * reaches these functions over RPC (see @whiphand/agent) and its input is not
 * trusted. Exported for workspace.ts's `resolveWorkflowPath`, which joins a
 * name into the same two directories from the read side.
 */
export function assertValidWorkflowName(name: string): void {
  const problem = workflowNameProblem(name);
  if (problem !== null) throw new Error(`invalid workflow name '${name}' (${problem})`);
}

/**
 * The first workflow `whiphand init` ships, and the one `whiphand new-workflow`
 * scaffolds under any name: `packages/core/templates/feature.yaml` with its
 * header comment and `name:` renamed.
 */
export function workflowTemplate(name: string): string {
  return readTemplate('feature')
    .replace(/^# feature — /m, `# ${name} — `)
    .replace(/^name: feature$/m, `name: ${name}`);
}

/**
 * The second workflow `whiphand init` ships: two planning phases, each followed by
 * a live session where the agent grills the human about what was just
 * planned, then the classic implementation/review cycle behind a human gate.
 * Fixed content, unlike `workflowTemplate` — `whiphand new-workflow` does not offer
 * this shape, and nothing on the `@whiphand/agent` RPC surface needs it. The
 * text is `packages/core/templates/spec-driven.yaml`.
 */
export function specDrivenTemplate(): string {
  return readTemplate('spec-driven');
}

/**
 * The third workflow `whiphand init` ships: the same plan → implement/review
 * cycle → sign-off body as `workflowTemplate`, but on its own branch — it syncs
 * the base branch, cuts `feature/<run slug>`, and commits the signed-off work
 * with a message an agent writes from the diff. Fixed content, unlike
 * `workflowTemplate` — `whiphand new-workflow` does not offer this shape.
 * The text is `packages/core/templates/feature-development.yaml`.
 */
export function featureDevelopmentTemplate(): string {
  return readTemplate('feature-development');
}

/**
 * The fourth workflow `whiphand init` ships: `feature-development` with the
 * plan cut into stage files and the human-review loop replaced by a `kind:
 * stages` step, so a large feature is built, reviewed, accepted and
 * committed one stage at a time instead of as one giant sign-off at the end.
 * Fixed content, unlike `workflowTemplate` — `whiphand new-workflow` does not
 * offer this shape. The text is
 * `packages/core/templates/staged-feature-development.yaml`.
 *
 * The planner writes the stage files into the run folder
 * (`{{ run.dir }}/plans/NN-slug.md`), not the repository: they are never
 * committed to the branch or the PR, and go when `runs.max_retained` prunes the
 * run. `build.items` globs them by that absolute path, so a glob metacharacter
 * (`[`, `*`, `?`, `{`) in the workdir path would break the match.
 *
 * `execute` and `review`, both nested inside `do-review`'s loops, cannot list
 * `accept` in their own `inputs:` — a forward reference is only legal across
 * a loop that encloses the reader (the "previous iteration" reading), never
 * across a whole `stages` body, and `accept` sits at the body's own level,
 * outside every loop `execute`/`review` are nested in (see
 * `validateWorkflowSemantics`'s `sameBody` check). That reference is not
 * needed anyway: a rejection at `accept` reaches `execute` — the stage's
 * retry target, being the last `writes: true` agent step before the gate —
 * automatically, injected as findings when the stage retries (see
 * `runStage`/`withFindings` in engine/runner.ts). `review` has no such
 * channel, so its prompt asks it to judge the implementer's own report
 * instead of claiming to see the rejection note itself.
 */
export function stagedFeatureDevelopmentTemplate(): string {
  return readTemplate('staged-feature-development');
}

/**
 * The fifth workflow `whiphand init` ships: a research workflow, not a build.
 * It settles the question with the human, has a headless agent investigate and
 * write a sourced report, has a second agent check that report against the
 * brief and spot-check its sources, then puts the report in front of the human
 * to accept or send round again. Nothing in it writes to the repository, so it
 * has no branch, no test command and no commit. Fixed content, unlike
 * `workflowTemplate` — `whiphand new-workflow` does not offer this shape.
 * The text is `packages/core/templates/research.yaml`.
 *
 * The loops follow the other templates: an outer loop, `until: read`, wraps
 * the inner research/check cycle and the human gate. `read` has no `show_diff`
 * — there is no diff to show — so `validateWorkflowWarnings` says its
 * `capture: review` only takes an overall comment, which is all a report needs.
 * Web access is whatever the runner's tools give it; the prompt only says to
 * use them if there are any.
 */
export function researchTemplate(): string {
  return readTemplate('research');
}

/**
 * The sixth workflow `whiphand init` ships: fix a bug test-first. It branches
 * off trunk, settles the root cause, the regression test and the command that
 * runs just that test with the human, has an agent write only the test, and
 * then refuses to go on unless that test fails, so "fixed" later means a
 * failing test turned green rather than a claim. The fix runs in the usual
 * test-fix / review cycle behind a human sign-off, then commits. Fixed content,
 * unlike `workflowTemplate` — `whiphand new-workflow` does not offer this
 * shape. The text is `packages/core/templates/bugfix.yaml`.
 *
 * The diagnosed test command reaches the command steps as a file, not an
 * input: inputs are all resolved when the run starts (runner.ts refuses a
 * missing required one up front), so nothing can prompt for a `repro_command`
 * once the diagnosis exists. `reproduce` writes the command into
 * `<run dir>/repro.sh` and the command steps source it in a subshell,
 * `( . repro.sh )`, rather than run `sh repro.sh`. The shell a command step gets
 * is started by absolute path (shell.ts) and is not a login shell, so on Windows
 * Git's `usr\bin` is on PATH only if the user put it there: a second `sh`
 * looked up by name can exit 127, which the red gate would blame on the agent's
 * script. Sourcing looks nothing up, and an `exit N` in the script ends only the
 * subshell, with N. `if`/`$?` mean the same on Windows as on Linux, and a script
 * file, unlike a command read back out of markdown, needs no extraction,
 * quoting or CRLF handling.
 * `expect_exit` cannot express the red gate: it lists the codes that count as
 * success, and "any failure" is not a list — runners disagree on what they
 * exit with (1, 101, 2) and 126/127 mean the command never ran.
 */
export function bugfixTemplate(): string {
  return readTemplate('bugfix');
}

/** Where a scoped workflow file lives — a global write `mkdir -p`s its directory on demand, same as project. */
function workflowsDir(workdir: string, scope: Scope): string {
  return scope === 'global' ? globalWorkflowsDir() : join(workdir, '.whiphand', 'workflows');
}

async function writeWorkflowFile(
  workdir: string, name: string, content: string, scope: Scope,
): Promise<{ path: string }> {
  assertValidWorkflowName(name);
  const dir = workflowsDir(workdir, scope);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.yaml`);
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw Object.assign(new Error(`workflow '${name}' already exists at ${path}`), { code: 'EEXIST' });
    }
    throw e;
  }
  return { path };
}

export async function createWorkflow(
  workdir: string, name: string, scope: Scope = 'project',
): Promise<{ path: string }> {
  return writeWorkflowFile(workdir, name, workflowTemplate(name), scope);
}

export async function updateWorkflow(
  workdir: string, name: string, workflow: Workflow, scope: Scope = 'project',
): Promise<{ path: string }> {
  assertValidWorkflowName(name);
  const locked: Workflow = { ...workflow, name };
  const problems = validateWorkflowSemantics(locked);
  if (problems.length > 0) throw new WorkflowError(problems);
  const dir = workflowsDir(workdir, scope);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.yaml`);
  let existing: string | undefined;
  try {
    existing = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const content = existing === undefined ? stringifyYaml(locked) : mergeWorkflow(existing, locked);
  await writeFile(path, content, 'utf8');
  return { path };
}

/**
 * Hard-deletes one scoped workflow file. Touches only `scope`'s directory, so
 * deleting a project workflow that overrides a global one uncovers the global
 * one rather than removing it too. Tries `.yaml` then `.yml`, the two
 * extensions `listWorkflows` shows. `{ deleted: false }` means neither file was
 * there — already gone, which is what the caller wanted.
 */
export async function deleteWorkflow(
  workdir: string, name: string, scope: Scope = 'project',
): Promise<{ deleted: boolean }> {
  assertValidWorkflowName(name);
  const dir = workflowsDir(workdir, scope);
  for (const ext of ['yaml', 'yml']) {
    try {
      await unlink(join(dir, `${name}.${ext}`));
      return { deleted: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return { deleted: false };
}

/**
 * Copies one scoped workflow file onto a new name, in the same scope. Reads
 * and reparses the source rather than copying it byte-for-byte, so `to` lands
 * in the `name:` field too, not just the filename; `mergeWorkflow` then
 * rewrites only that field, keeping the source's comments and formatting.
 * The write goes through `writeWorkflowFile`'s `wx`-flag guard, so a target
 * that already exists throws EEXIST rather than being overwritten — the
 * caller's own existence check can be stale by the time this runs.
 */
export async function cloneWorkflow(
  workdir: string, from: string, to: string, scope: Scope = 'project',
): Promise<{ path: string }> {
  assertValidWorkflowName(from);
  assertValidWorkflowName(to);
  const dir = workflowsDir(workdir, scope);
  let raw: string | undefined;
  for (const ext of ['yaml', 'yml']) {
    try {
      raw = await readFile(join(dir, `${from}.${ext}`), 'utf8');
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  if (raw === undefined) throw new Error(`workflow '${from}' not found`);
  const parsed = parseWorkflow(raw);
  const content = mergeWorkflow(raw, { ...parsed, name: to });
  return writeWorkflowFile(workdir, to, content, scope);
}

export async function initWorkspace(workdir: string): Promise<{ created: string[] }> {
  const created: string[] = [];
  const configRel = join('.whiphand', 'config.yaml');
  await mkdir(join(workdir, '.whiphand'), { recursive: true });
  try {
    await writeFile(join(workdir, configRel), stringifyYaml(DEFAULT_CONFIG), { encoding: 'utf8', flag: 'wx' });
    created.push(configRel);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  for (const name of SHIPPED_TEMPLATES) {
    const rel = join('.whiphand', 'workflows', `${name}.yaml`);
    try {
      await writeWorkflowFile(workdir, name, readTemplate(name), 'project');
      created.push(rel);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  return { created };
}
