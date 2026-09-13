/**
 * Everything needed to restart a run from its first unfinished step.
 *
 * All the reading and all the refusing happen here, so `runWorkflow` receives
 * a plan it can trust and stays about executing steps. Kept out of runner.ts,
 * which is long enough already, and free of spawning so the interesting logic
 * is testable against fixture run directories.
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { LoopFrame, LoopRef, Scope, Workflow, WorkspaceConfig } from '../types.ts';
import { parseWorkflow, WorkflowError } from '../schema.ts';
import { collectLoops, findStep, isLeafStep, isLoopStep } from '../steps.ts';
import { resolveWorkflowPath } from '../workspace.ts';
import { artifactPath, assertArtifact } from './artifacts.ts';
import { executionKey } from '../execution-key.ts';
import { diffSnapshots, snapshotTree } from './git-guard.ts';
import { getRun, isSafeRunId, MANIFEST_VERSION, WORKFLOW_SNAPSHOT_NAME } from './manifest.ts';
import type { RunManifest } from './manifest.ts';

type ManifestStepLoopFields = { loopId?: string; iteration?: number; outerLoops?: LoopRef[] };

/**
 * A row's own identity string — the same one runner.ts computes for the
 * matching execution via `executionKey(id, frame?.iteration, ancestorLoops(frame))`.
 */
function rowKey(id: string, row: ManifestStepLoopFields): string {
  return executionKey(id, row.iteration, row.outerLoops);
}

/**
 * The `outerLoops` a body of *this* loop row would itself carry — its own
 * `(loopId, iteration)` prepended onto whatever is beyond that. Lets a body
 * row (`loopId`/`outerLoops`) be matched back to the loop incarnation
 * (`id`/`iteration`/`outerLoops`) it belongs to.
 */
function loopContext(row: { id: string } & ManifestStepLoopFields): LoopRef[] {
  return row.loopId === undefined ? [] : [...(row.outerLoops ?? []), { id: row.loopId, iteration: row.iteration ?? 1 }];
}

function incarnationKey(loopId: string, outerLoops: LoopRef[]): string {
  return `${loopId}::${JSON.stringify(outerLoops)}`;
}

/** Rebuilds the `LoopFrame` chain a row's `loopId`/`iteration`/`outerLoops` describe, for `artifactPath`. */
function frameOfRow(row: ManifestStepLoopFields & { maxIterations?: number }): LoopFrame | undefined {
  if (row.loopId === undefined) return undefined;
  let parent: LoopFrame | undefined;
  for (const l of row.outerLoops ?? []) parent = { id: l.id, iteration: l.iteration, maxIterations: 1, parent };
  return { id: row.loopId, iteration: row.iteration ?? 1, maxIterations: row.maxIterations ?? 1, parent };
}

/** True when any loop in the tree has another loop among its own body steps. */
function hasNestedLoops(steps: Workflow['steps']): boolean {
  return collectLoops(steps).some(loop => loop.steps.some(isLoopStep));
}

type ManifestStep = RunManifest['steps'][number];

export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeError';
  }
}

/** What a skipped execution has to tell the walk that replays it. */
export interface DoneExecution {
  artifact?: string;
  verdict?: 'pass' | 'fail';
}

/** The iteration budget a resume grants one loop, and how much of it is already spent. */
export interface LoopBudget { budget: number; completed: number }

export interface ResumeOptions {
  /** Extra iterations to grant. Absent = the default +1 on exhausted loops only. */
  extraIterations?: number;
}

export interface ResumePlan {
  runId: string;
  runDir: string;
  /** The manifest to reopen, exactly as read. */
  manifest: RunManifest;
  /** Parsed from the run's own snapshot, or from the workspace as a fallback. */
  workflow: Workflow;
  inputs: Record<string, string>;
  sessionIds: Record<string, string>;
  /** stepId -> newest completed artifact, for forward references. */
  artifacts: Record<string, string>;
  /** stepId -> every completed artifact, oldest first. */
  attempts: Record<string, string[]>;
  /** Executions the manifest records as done, keyed by `executionKey`. */
  done: Map<string, DoneExecution>;
  /** Ids whose interactive session may be resumed rather than minted afresh. */
  resumedStepIds: Set<string>;
  /**
   * Absolute paths of the files attached when the run started, from the
   * manifest. Exactly what the original run saw: a resume cannot add or
   * change them, just as it cannot change the inputs.
   */
  attachments: string[];
  /** First not-done execution. Display only — the mechanism is skip-based. */
  restartAt: { stepId: string; iteration?: number } | undefined;
  /** loopId -> the budget this resume allows it, and what it has already run. */
  loopBudgets: Record<string, LoopBudget>;
  warnings: string[];
}

/** A run in any of these states is half-finished and can be continued. */
const RESUMABLE = new Set(['failed', 'interrupted', 'cancelled']);

/**
 * The iteration budget each unfinished loop gets on this resume, plus the
 * warnings that explain any change. Computed as its own pre-pass so both the
 * done/restartAt walk below and the runner afterwards can just look values up
 * rather than re-deriving them.
 */
function computeLoopBudgets(
  detail: RunManifest, workflow: Workflow, config: WorkspaceConfig,
  opts: ResumeOptions | undefined, warnings: string[],
): Record<string, LoopBudget> {
  const extra = opts?.extraIterations ?? 1;
  const explicit = opts?.extraIterations !== undefined;
  const declared = new Map(collectLoops(workflow.steps).map(loop => [loop.id, loop]));
  const budgets: Record<string, LoopBudget> = {};
  let anyEligible = false;

  for (const step of detail.steps) {
    if (step.kind !== 'loop' || step.status === 'done') continue;
    anyEligible = true;
    const base = step.maxIterations ?? declared.get(step.id)?.max_iterations ?? config.loop.max_iterations;
    const completed = step.iterations ?? 0;
    // The default +1 only rescues an exhausted ('failed') loop; an explicit
    // count is a deliberate ask and applies to every loop not yet passed,
    // exhausted or merely interrupted mid-run.
    const bump = step.status === 'failed' || explicit ? extra : 0;
    const budget = base + bump;
    budgets[rowKey(step.id, step)] = { budget, completed };
    if (bump > 0) {
      warnings.push(`loop '${step.id}' ran out of iterations at ${completed}; this resume allows ${budget}`);
    }
  }

  if (explicit && !anyEligible) {
    warnings.push('no loop in this run has iterations left to raise, so the extra iterations had no effect');
  }

  return budgets;
}

export async function planResume(
  workdir: string, config: WorkspaceConfig, runId: string, opts?: ResumeOptions,
): Promise<ResumePlan> {
  if (!isSafeRunId(runId)) throw new ResumeError(`'${runId}' is not a valid run id`);
  const detail = await getRun(workdir, config, runId);
  if (detail === null) throw new ResumeError(`no run '${runId}' under ${config.artifacts_dir}`);
  if (detail.status === 'unknown') {
    throw new ResumeError(`run '${runId}' has no readable run.json, so there is nothing to resume`);
  }
  if (!RESUMABLE.has(detail.status)) {
    // 'running' lands here too. readRunSummary has already downgraded genuinely
    // abandoned runs to 'interrupted', so anything still claiming to run has a
    // live owner — and two processes writing one run directory would corrupt it.
    throw new ResumeError(
      `run '${runId}' is ${detail.status}; only failed, interrupted or cancelled runs can be resumed`);
  }

  const warnings: string[] = [];
  const workflow = await loadWorkflow(detail, workdir, warnings);

  if (detail.version < MANIFEST_VERSION && hasNestedLoops(workflow.steps)) {
    throw new ResumeError(
      `run '${runId}' was recorded before whiphand tracked nested-loop rounds separately (manifest `
      + `v${detail.version}), and workflow '${workflow.name}' now has a loop nested inside another loop; `
      + 'resuming it could not tell one round\'s work from another\'s — start a fresh run instead');
  }

  await healOrphanedDone(detail, workflow, warnings);
  const loopBudgets = computeLoopBudgets(detail, workflow, config, opts, warnings);

  const done = new Map<string, DoneExecution>();
  const artifacts: Record<string, string> = {};
  const attempts: Record<string, string[]> = {};
  const resumedStepIds = new Set<string>();
  let restartAt: ResumePlan['restartAt'];

  // A loop interrupted mid-iteration already has a not-done body row — that
  // row is precisely where the ordinary scan below lands, and it must win
  // over the loop-row refinement: the recorded iteration is not finished, so
  // jumping ahead to "the next one" would skip re-running what it left undone.
  // Only once every recorded body execution is done is there truly nothing
  // for the plain scan to find, which is what the refinement exists for.
  // Keyed by incarnation (loop id + the round it's running under), not bare
  // id, so an outer round's own unfinished body never masks a sibling round
  // of the very same inner loop that already finished.
  const loopsWithUnfinishedBody = new Set(
    detail.steps.filter(s => s.loopId !== undefined && s.status !== 'done')
      .map(s => incarnationKey(s.loopId!, s.outerLoops ?? [])));

  for (const step of detail.steps) {
    if (step.status === 'done') {
      done.set(rowKey(step.id, step), {
        ...(step.artifact === undefined ? {} : { artifact: step.artifact }),
        ...(step.verdict === undefined ? {} : { verdict: step.verdict }),
      });
      // Only completed work is restored: a half-written artifact from the
      // attempt that failed must never become a forward reference.
      if (step.artifact !== undefined) {
        artifacts[step.id] = step.artifact;
        (attempts[step.id] ??= []).push(step.artifact);
      }
      continue;
    }
    // A loop's own entry is not a step anyone restarts at — its body is. But
    // when this resume grants it more room than it has used, the loop is
    // exactly where execution is headed next, so name that rather than
    // falling through to whatever pending step follows it.
    if (restartAt === undefined) {
      if (step.kind === 'loop') {
        const grant = loopBudgets[rowKey(step.id, step)];
        if (grant !== undefined && grant.budget > grant.completed
          && !loopsWithUnfinishedBody.has(incarnationKey(step.id, loopContext(step)))) {
          const declaredLoop = findStep(workflow.steps, step.id);
          const firstBody = declaredLoop !== undefined && isLoopStep(declaredLoop)
            ? declaredLoop.steps[0] : undefined;
          if (firstBody !== undefined) {
            restartAt = { stepId: firstBody.id, iteration: grant.completed + 1 };
          }
        }
      } else {
        restartAt = {
          stepId: step.id,
          ...(step.iteration === undefined ? {} : { iteration: step.iteration }),
        };
      }
    }
    // Ids are minted for every interactive step up front, so having one says
    // nothing about whether a conversation was ever opened under it — and
    // `claude --resume` on an id no conversation claimed exits 1 and fails the
    // run. From v3 the manifest records the spawn itself; older runs have no
    // such record, and guessing 'no' for them would hand `--session-id` an id
    // that is already taken, so they keep the original "it got as far as
    // starting" heuristic.
    const opened = detail.version >= 3
      ? step.sessionStarted === true
      : step.status !== 'pending' || step.attempted === true;
    if (opened && detail.sessionIds[step.id] !== undefined) {
      resumedStepIds.add(step.id);
    }
  }

  const attachments = await recordedAttachments(detail);
  warnings.push(...await treeWarnings(detail, workdir));

  return {
    runId,
    runDir: detail.runDir,
    manifest: detail,
    workflow,
    inputs: detail.inputs,
    sessionIds: detail.sessionIds,
    artifacts,
    attempts,
    done,
    resumedStepIds,
    attachments,
    restartAt,
    loopBudgets,
    warnings,
  };
}

/**
 * The run's attached files, each checked to still be in its run directory. A
 * missing one is a refusal rather than a silent drop: the steps still to run
 * were promised those files, and the copy that failed — or the hand that
 * deleted one — is not something a resume can repair. A fresh run can.
 */
async function recordedAttachments(detail: RunManifest & { runDir: string }): Promise<string[]> {
  const paths: string[] = [];
  for (const attachment of detail.attachments ?? []) {
    const path = join(detail.runDir, attachment.path);
    const st = await stat(path).catch(() => null);
    if (st === null || !st.isFile()) {
      throw new ResumeError(
        `run '${detail.runId}' was started with the attachment '${attachment.name}', which is no longer `
        + `in its run directory (${attachment.path}); start a fresh run instead`);
    }
    paths.push(path);
  }
  return paths;
}

/**
 * Repairs rows the manifest calls 'done' that never recorded the artifact their
 * step declares.
 *
 * Such a row is not trustworthy. `step:done` lands before the artifact
 * assertion, so 'done' can mean "the process exited 0 and then the step
 * failed" — the state RunJournal.finalizeRunningSteps now stops producing, but
 * which runs written before that fix still carry. Trusting it either wedges
 * every future resume in `no artifact recorded for step 'x'`, or — quieter and
 * worse — lets the run finish green having never produced the artifact at all.
 *
 * The file system is the better witness. Adopt what the step really left
 * behind; re-run it when there is nothing to adopt. Either way the run becomes
 * resumable, which is the invariant that matters: a run that failed can always
 * be continued once its underlying problem is fixed.
 *
 * `detail` is mutated deliberately. It is a freshly parsed manifest, and it is
 * the very object RunJournal.reopen continues, so routing the repair through
 * the row is what carries it into resetUnfinished and onto disk — a second
 * resume then finds nothing left to heal.
 */
async function healOrphanedDone(
  detail: RunManifest & { runDir: string }, workflow: Workflow, warnings: string[],
): Promise<void> {
  // A dry run emits step:done and never step:artifact by construction, so
  // done-without-artifact is its normal shape rather than damage.
  if (detail.dryRun) return;

  // Only the newest execution of each id: a loop runs the same step many
  // times, and only the newest flows forward into ctx.artifacts. An older
  // iteration's gap can never wedge a run, and re-running one would rewrite
  // the history that makes a cycle reviewable.
  const newest = new Map<string, ManifestStep>();
  for (const step of detail.steps) newest.set(step.id, step);

  for (const step of newest.values()) {
    if (step.status !== 'done' || step.artifact !== undefined) continue;
    const declared = findStep(workflow.steps, step.id);
    // An unknown id, a loop's own row, or a step that never promised an
    // artifact (an approval, a command with no capture) owes nothing.
    if (declared === undefined || !isLeafStep(declared)) continue;
    const output = declared.output;
    if (output === undefined) continue;

    const expected = artifactPath(detail.runDir, { output }, frameOfRow(step));

    if (await adoptable(expected, step.startedAt)) {
      step.artifact = expected;
      warnings.push(
        `step '${step.id}' finished without recording its artifact; adopting the `
        + `'${basename(expected)}' it left in the run directory`);
      continue;
    }
    // 'failed', not 'pending': resetUnfinished derives the sticky `attempted`
    // flag from "status !== 'pending'", and that flag is what lets an
    // interactive step reopen its recorded session instead of starting cold.
    step.status = 'failed';
    warnings.push(
      `step '${step.id}' is recorded done but never recorded its '${basename(expected)}' `
      + 'artifact, and none is there to adopt, so it will run again');
  }
}

/**
 * Whether the artifact a row failed to record is really in the run directory,
 * and demonstrably came from *this* execution. The timestamp test is not
 * belt-and-braces: nothing deletes artifacts between attempts, so a bare
 * existence check would happily resurrect attempt 1's file for an attempt 2
 * that genuinely produced nothing.
 *
 * `assertArtifact` is the same test the runner itself would have applied a
 * beat later, which is what makes adopting a repair rather than a guess.
 */
async function adoptable(path: string, startedAt: string | undefined): Promise<boolean> {
  if (startedAt === undefined) return false;
  const began = Date.parse(startedAt);
  if (Number.isNaN(began)) return false;
  const stats = await stat(path).catch(() => null);
  // A second of slack, for filesystems with coarse timestamps.
  if (stats === null || stats.mtimeMs + 1000 < began) return false;
  return assertArtifact(path).then(() => true, () => false);
}

/**
 * The workflow the run executed. The run's own snapshot is authoritative; a run
 * recorded before snapshots existed falls back to the workspace file, which may
 * since have changed — hence the warning. A snapshot that exists but no longer
 * parses is an error rather than a fallback: quietly running a *different*
 * workflow than the one recorded is the one outcome worth refusing outright.
 */
async function loadWorkflow(
  manifest: RunManifest & { runDir: string }, workdir: string, warnings: string[],
): Promise<Workflow> {
  let snapshot: string | undefined;
  try {
    snapshot = await readFile(join(manifest.runDir, WORKFLOW_SNAPSHOT_NAME), 'utf8');
  } catch {
    // No snapshot: an older run. Fall through to the workspace file.
  }
  if (snapshot !== undefined) {
    try {
      return parseWorkflow(snapshot);
    } catch (e) {
      throw new ResumeError(
        `run '${manifest.runId}' has a workflow snapshot that no longer parses: `
        + `${e instanceof WorkflowError ? e.message : (e as Error).message}`);
    }
  }

  warnings.push(
    `no workflow snapshot in this run, so '${manifest.workflow}' was re-read from the workspace; `
    + 'its definition may have changed since the run started');
  let resolved: { path: string; source: Scope };
  try {
    resolved = await resolveWorkflowPath(manifest.workflow, workdir);
  } catch (e) {
    throw new ResumeError(
      `run '${manifest.runId}' has no workflow snapshot and workflow '${manifest.workflow}' `
      + `could not be read: ${(e as Error).message}`);
  }
  // A run started from a global 'feature' must not be silently resumed
  // against a project 'feature' that appeared afterwards (or vice versa) —
  // same name, different definition. Only checked here: the snapshot path
  // above is immune by construction, since it's the run's own recorded copy.
  if (manifest.workflowSource !== undefined && manifest.workflowSource !== resolved.source) {
    throw new ResumeError(
      `run '${manifest.runId}' started from the ${manifest.workflowSource} workflow '${manifest.workflow}', `
      + `but it now resolves to a ${resolved.source} one; refusing to resume against a different definition`);
  }
  try {
    return parseWorkflow(await readFile(resolved.path, 'utf8'));
  } catch (e) {
    throw new ResumeError(
      `run '${manifest.runId}' has no workflow snapshot and workflow '${manifest.workflow}' `
      + `could not be read: ${(e as Error).message}`);
  }
}

/** What changed in the working tree since the run stopped, as warnings. */
async function treeWarnings(manifest: RunManifest, workdir: string): Promise<string[]> {
  if (manifest.stoppedTree === undefined) {
    return ['no working tree snapshot was recorded when this run stopped, '
      + 'so changes to the working tree since then cannot be reported'];
  }
  const now = await snapshotTree(workdir);
  // Not a git repository: the guard is already off for this workspace, and
  // there is nothing honest to compare against.
  if (now === null) return [];
  const changed = diffSnapshots(manifest.stoppedTree, now);
  if (changed.length === 0) return [];
  const shown = changed.slice(0, 10).join(', ');
  return [
    `${changed.length} file(s) changed since this run stopped: ${shown}`
    + (changed.length > 10 ? ', …' : ''),
  ];
}
