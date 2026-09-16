import { readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type {
  AgentStep, AttachmentSource, CommandStep, Frame, Frontend, LoopFrame, LoopStep, ManualStep, WhiphandEvent,
  OnFindings, RunnerAdapter, Scope, Stage, StageFrame, StagesStep, Workflow, RunCtx, SpawnSpec, Step, WorkspaceConfig,
} from '../types.ts';
import { STAGE_REF } from '../types.ts';
import { AdapterRegistry, validateWorkflowRunners, validateWorkflowFrontend } from '../registry.ts';
import { WorkflowError, locateSteps, isForwardRef } from '../schema.ts';
import {
  collectLoops, flattenSteps, isAgentStep, isCommandStep, isContainerStep, isLoopStep, isManualStep, isStagesStep,
} from '../steps.ts';
import { disabledIds, droppedRefs, droppedRefSentence, pruneDisabled } from '../enabled.ts';
import { ATTACHMENTS_REF } from '../attachments.ts';
import { copyAttachments, recordOf, validateAttachments } from './attachments.ts';
import { artifactPath, assertArtifact, ArtifactError, ensureArtifactDir } from './artifacts.ts';
import { snapshotTree, diffSnapshots, headSha, pathsFromStatusLines, pathsOutside } from './git-guard.ts';
import { renderTemplate } from '../template.ts';
import { CORE_VERSION } from '../version.ts';
import { parseVerdict, verdictFromExit, verdictFromChoice, VERDICT_INSTRUCTION } from './verdict.ts';
import { createProgressParser, progressErrorMessage } from './progress.ts';
import { commandSpec, captureHeader, captureFooter } from './command.ts';
import { buildManualRequest, noteArtifact, reviewArtifact } from './manual.ts';
import { clearEndMarker } from './session-end.ts';
import { clearAwaitState } from './await-state.ts';
import { clearSessionCapture } from './session-capture.ts';
import { RunJournal, WORKFLOW_SNAPSHOT_NAME } from './manifest.ts';
import { executionKey, frameIdentity, isStageFrame, nearestLoop, nearestStage } from '../execution-key.ts';
import { pruneRuns } from './retention.ts';
import { DEFAULT_STAGE_RETRIES, discoverStages, nextStage, oddStageNames, StageError } from './stages.ts';
import { readRunName, runSlugFor, setRunName } from './run-name.ts';
import { autoNameRun } from './auto-name.ts';
import type { ResumePlan } from './resume.ts';
import { stageBudgetKey } from './resume.ts';

export interface RunOptions {
  workflow: Workflow;
  workdir: string;
  inputs: Record<string, string>;
  config: WorkspaceConfig;
  registry: AdapterRegistry;
  frontend: Frontend;
  /** Where `workflow` was resolved from — project or global. Recorded on the manifest; ignored on resume. */
  workflowSource?: Scope;
  dryRun?: boolean;
  /** Overrides every loop's own budget for this run (`whiphand run --max-iterations`). */
  maxIterations?: number;
  /** Overrides config.runs.max_retained for this run's post-completion prune. */
  maxRetainedRuns?: number | null;
  /**
   * Continue a stopped run instead of starting a new one. The caller passes
   * `plan.workflow` as `workflow` and `plan.inputs` as `inputs`, so input
   * resolution and workflow validation stay on exactly one path.
   */
  resume?: ResumePlan;
  /**
   * Optional display label for a fresh run. Normalized and written to the
   * run's `.name` marker before the first step, so `{{ run.name }}` and
   * `$WHIPHAND_RUN_SLUG` are available to step one. Ignored on a resume, which
   * keeps whatever name the run already has.
   */
  name?: string;
  /**
   * Files to copy into the run before step one, for any step whose `inputs:`
   * names `attachments`. Refused — before a run directory exists — when a
   * file is unusable or nothing reads them. A resume keeps the files it was
   * started with, so passing any alongside `resume` is an error.
   */
  attachments?: AttachmentSource[];
  // signal and onLine are optional trailing params on spawnHeadless so existing
  // implementations stay assignment-compatible. onLine is now handed every
  // stdout/stderr line from a headless spawn (a plain step, or an interactive
  // step's harvest phase): core decides whether a line is progress telemetry
  // (spec.progress is set and the line parses) or ordinary output — the
  // latter becomes a `step:log` event. A frontend that ignores onLine simply
  // loses the feed, exactly as it always could.
  spawnHeadless?: (
    spec: SpawnSpec,
    signal?: AbortSignal,
    onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
  ) => Promise<number>;
  signal?: AbortSignal;
}

export interface RunResult {
  ok: boolean;
  runId: string;
  runDir: string;
  artifacts: Record<string, string>;
  verdict?: 'pass' | 'fail';
  cancelled?: boolean;
}

/**
 * What one step produced. `null` means "carried on"; 'verdict-fail' is a
 * signal the caller decides what to do with (a loop iterates, an un-looped
 * verdict step consults on_findings); a RunResult stops the run outright.
 */
type StepOutcome = RunResult | 'verdict-fail' | null;

function resolveInputs(workflow: Workflow, given: Record<string, string>): Record<string, string> {
  const problems: string[] = [];
  const resolved: Record<string, string> = { ...given };
  for (const [key, def] of Object.entries(workflow.inputs ?? {})) {
    if (resolved[key] === undefined && def.default !== undefined) resolved[key] = def.default;
    if (resolved[key] === undefined && def.required) problems.push(`missing required input '${key}'`);
  }
  if (problems.length > 0) throw new WorkflowError(problems);
  return resolved;
}

/**
 * Writes a spawn's support files (opencode's guidance and plugin, today)
 * before the spawn, so adapters themselves stay pure — they only ever
 * describe what to write, never touch the filesystem. A no-op for every spec
 * without `files`, which is every claude/copilot spec and most opencode ones.
 */
async function writeSpecFiles(spec: SpawnSpec): Promise<void> {
  for (const file of spec.files ?? []) {
    await ensureArtifactDir(file.path);
    await writeFile(file.path, file.content, 'utf8');
  }
}

/** Steps passed to adapters get the verdict instruction appended when needed. */
function effectiveStep(step: AgentStep): AgentStep {
  if (!step.verdict) return step;
  return { ...step, prompt: `${step.prompt}\n\n${VERDICT_INSTRUCTION}` };
}

/**
 * The execution identity `step:start` and `step:skipped` carry, spread from
 * frameIdentity's tuple with every absent part left out — so a top-level
 * step's event stays exactly as it always was.
 */
function executionFields(idn: ReturnType<typeof frameIdentity>) {
  return {
    ...(idn.loopId === undefined ? {} : { loopId: idn.loopId, iteration: idn.iteration }),
    ...(idn.stage === undefined ? {} : { stage: idn.stage }),
    ...(idn.outerLoops.length === 0 ? {} : { outerLoops: idn.outerLoops }),
  };
}

/** Makes `target` hold exactly `source`'s entries, in place — other holders of `target` see the change. */
function replaceRecord<V>(target: Record<string, V>, source: Record<string, V>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

/** Index of the nearest step before `verdictIdx` with writes: true, or -1. */
function loopTargetIndex(steps: Step[], verdictIdx: number): number {
  for (let i = verdictIdx - 1; i >= 0; i--) {
    const s = steps[i];
    if (isAgentStep(s) && s.writes) return i;
  }
  return -1;
}

/**
 * Whether a step's outcome is a verdict. A manual or approval step directly
 * inside a stage carries one without `verdict: true`: the human's answer *is*
 * the stage's verdict, and `retry` has to reach runStage as a failure rather
 * than be read as `continue`. Stage frames only — inside a loop a non-`until`
 * verdict is ignored anyway, and `until` already requires `verdict: true`.
 */
function carriesVerdict(step: Step, frame: Frame | undefined): boolean {
  if (isContainerStep(step)) return false;
  return step.verdict === true || (isManualStep(step) && isStageFrame(frame));
}

/** A stages body in document order, containers' own bodies included, and where `id` sits in it. */
function bodyBefore(body: Step[], id: string): Step[] {
  const flat = flattenSteps(body).map(f => f.step);
  const idx = flat.findIndex(s => s.id === id);
  return idx === -1 ? [] : flat.slice(0, idx);
}

/** The last `writes: true` agent step before the gate — whom a rejection is addressed to, and whose session triage reopens. */
function stageRetryTarget(body: Step[], gateId: string): AgentStep | undefined {
  return bodyBefore(body, gateId).filter(isAgentStep).filter(s => s.writes).at(-1);
}

/** The last machine verdict step before the gate — the review whose findings a triage session is handed. */
function stageFindingsId(body: Step[], gateId: string): string | undefined {
  return bodyBefore(body, gateId)
    .filter(s => !isContainerStep(s) && !isManualStep(s) && s.verdict === true).at(-1)?.id;
}

/** What one attempt at a stage has learned that its gate must be told. */
interface StageAttemptNotes {
  /** Review cycles that ran out of iterations and handed their failure to the gate. */
  exhausted: Array<{ loopId: string; untilId: string; iterations: number }>;
  /** The tree as the stage (not this attempt) began, or null outside git (or on a dry run): no "no changes" note then. */
  entrySnapshot: string | null;
}

export async function runWorkflow(opts: RunOptions): Promise<RunResult> {
  const { workflow, config, registry, frontend } = opts;

  // The tree that will actually run: disabled steps and disabled loops' whole
  // bodies removed, references to disabled ids stripped from every survivor.
  // Computed first because every check and every walk below sees this, not
  // the declared `workflow` — a disabled step's runner does not need to be
  // installed, and a disabled manual step does not need a frontend that can
  // ask a human.
  const disabled = disabledIds(workflow.steps);
  const effective = pruneDisabled(workflow);
  // Built once per run, from the tree that actually runs: what `scopeInputs`
  // needs to tell a forward reference (this loop's previous iteration) from a
  // backward one (already ran this iteration, artifact just sitting in ctx).
  const stepLocations = locateSteps(effective.steps);

  if (effective.steps.length === 0) {
    throw new WorkflowError(['the workflow has no enabled steps']);
  }
  for (const loop of collectLoops(effective.steps)) {
    if (!loop.steps.some(s => s.id === loop.until)) {
      throw new WorkflowError(
        [`loop '${loop.id}': until step '${loop.until}' is disabled, so the loop can never end`]);
    }
  }

  const problems = [
    ...validateWorkflowRunners(effective, registry),
    ...(opts.dryRun ? [] : validateWorkflowFrontend(effective, frontend)),
  ];
  if (problems.length > 0) throw new WorkflowError(problems);
  const inputs = resolveInputs(workflow, opts.inputs);
  if (opts.resume !== undefined && (opts.attachments?.length ?? 0) > 0) {
    throw new WorkflowError(['a resumed run keeps the files it was started with; it cannot attach new ones']);
  }
  // Phase 1 of 2: every reason to refuse the files, decided before there is
  // a run directory to leave behind. Copying waits for the journal below.
  const attachments = opts.resume === undefined
    ? await validateAttachments(opts.attachments ?? [], effective, config.runs.max_attachment_mb)
    : [];

  const onFindings: OnFindings = workflow.on_findings ?? config.on_findings;
  if (onFindings === 'loop') {
    // Only top-level verdict steps fall back to on_findings; one inside an
    // explicit loop is governed by that loop instead.
    effective.steps.forEach((step, idx) => {
      if (!isContainerStep(step) && step.verdict && loopTargetIndex(effective.steps, idx) === -1) {
        throw new WorkflowError(
          [`on_findings 'loop' requires a writes:true step before verdict step '${step.id}'`]);
      }
    });
  }

  const workdir = resolve(opts.workdir);
  // Resuming is in place: same run id, same directory, same run.json. Minting
  // a new one would strand the artifacts the resume exists to reuse.
  const { runId, runDir } = opts.resume === undefined
    ? await createRunDirFor(workdir, config)
    : { runId: opts.resume.runId, runDir: opts.resume.runDir };
  // A fresh run records the name it was started with; a resume reads back
  // whatever the run is called now. Either way the value is then frozen for
  // this process — see RunCtx.runName for why.
  if (opts.resume === undefined && opts.name !== undefined) {
    await setRunName(runDir, opts.name);
  }
  let runName = await readRunName(runDir);
  // The workflow this run actually executed, defaults and all. A resume reads
  // this rather than the workspace file, which may have changed by then — and
  // does not rewrite it, since it is executing that very snapshot.
  if (opts.resume === undefined) {
    await writeFile(join(runDir, WORKFLOW_SNAPSHOT_NAME), stringifyYaml(workflow), 'utf8');
  }
  const ctx: RunCtx = {
    workdir, runId, runDir,
    ...(runName === undefined ? {} : { runName }),
    runSlug: runSlugFor(runId, runName),
    sessionIds: { ...(opts.resume?.sessionIds ?? {}) },
    artifacts: { ...(opts.resume?.artifacts ?? {}) },
    attempts: { ...(opts.resume?.attempts ?? {}) },
    // Not seeded from `opts.resume`: a resume rebuilds these as the replay
    // walk re-skips each done execution (see executeStep's alreadyDone path),
    // the same way it rebuilds ctx.loop rather than restoring it wholesale.
    verdicts: {},
    inputs,
    ...(opts.resume === undefined ? {} : { resumedStepIds: opts.resume.resumedStepIds }),
  };
  const attachmentPaths = opts.resume === undefined
    ? attachments.map(a => join(runDir, a.path))
    : opts.resume.attachments;
  if (attachmentPaths.length > 0) ctx.attachments = attachmentPaths;

  for (const { step } of flattenSteps(effective.steps)) {
    if (!isAgentStep(step) || step.mode !== 'interactive') continue;
    // A resumed run keeps the ids it already minted: re-minting would orphan
    // the very sessions the resume exists to continue.
    if (ctx.sessionIds[step.id] !== undefined) continue;
    if (registry.get(step.runner).capabilities.sessionIdInjection) {
      ctx.sessionIds[step.id] = randomUUID();
    }
  }

  // The journal seeds from the full declared tree, not `effective`: a
  // disabled step is still recorded (dimmed, badged, never started), so a
  // reader a month later can see it existed.
  const planned = flattenSteps(workflow.steps);
  const journal = opts.resume === undefined
    ? new RunJournal({
        runDir, runId, workflow: workflow.name, workdir, dryRun: !!opts.dryRun,
        workflowSource: opts.workflowSource,
        inputs, attachments: attachments.map(recordOf),
        sessionIds: ctx.sessionIds, steps: planned.map(({ step, loopId, stagesId }) => ({
          id: step.id,
          kind: step.kind,
          loopId,
          stagesId,
          runner: isAgentStep(step) ? step.runner : undefined,
          model: isAgentStep(step) ? step.model : undefined,
          mode: isAgentStep(step) ? step.mode : undefined,
          disabled: disabled.has(step.id) ? true : undefined,
        })),
      })
    : RunJournal.reopen(runDir, opts.resume.manifest);
  // Tee every WhiphandEvent to both the frontend and the run journal; every
  // emission site below (including error paths) must go through this.
  // journal.record runs first so the ordinal it assigns can ride along on the
  // same notification the frontend forwards live — "what you saw live" and
  // "what is in the file" then agree down to the same seq, not just the same
  // millisecond.
  // Set the instant run:done is emitted — the true last event on every path
  // (fail/cancelled/endWith all emit it last). Guards the fire-and-forget
  // run:env probe below: a run that fails or finishes before the probe
  // resolves must never have it land AFTER run:done.
  let runEnded = false;
  const emit = (e: WhiphandEvent) => {
    if (e.type === 'run:done') runEnded = true;
    const { seq, ts } = journal.record(e);
    frontend.onEvent(e, seq, ts);
  };
  // `run:env`'s runner probe is fire-and-forget (see runSteps) so it can never
  // delay step one; this is what lets the `finally` below wait for it to have
  // actually landed before the journal flushes, so a run that finishes faster
  // than a runner's own --version probe still keeps the line rather than
  // losing it to the process exiting first.
  let runEnvSettled: Promise<void> = Promise.resolve();

  try {
    // Phase 2 of 2. Inside the try, so a copy that fails (a full disk) ends
    // the run with run:error like any other failure; after the journal, so
    // that run is on record. A dry run records the list and copies nothing.
    if (!opts.dryRun) await copyAttachments(runDir, attachments);

    // Auto-naming, when it is on and nothing named the run already. Patched
    // onto the ctx in place rather than folded into its construction above,
    // because the adapter needs a ctx to build its spawn from — and it lands
    // before the first step, which is what makes {{ run.slug }} usable for a
    // worktree or a branch. A dry run spends nothing, so it skips this too.
    //
    // Inside the try, and after the journal: this can block for up to
    // SUGGEST_TIMEOUT_MS, and a run directory with no run.json in it reads
    // back as 'unknown' — which pruneRuns will happily delete. It is also the
    // one thing here that spawns a child process, so a throw from it has to
    // reach the terminal-event handler below like any other.
    if (opts.resume === undefined && runName === undefined && !opts.dryRun
      && config.runs.auto_name) {
      const suggested = await autoNameRun({
        ctx, workflow, registry, runner: config.defaults.runner,
        spawnHeadless: opts.spawnHeadless, signal: opts.signal,
      });
      if (suggested !== undefined) {
        ctx.runName = suggested;
        ctx.runSlug = runSlugFor(runId, suggested);
        runName = suggested;
      }
    }

    return await runSteps();
  } catch (e) {
    // Every ordinary failure path goes through fail()/cancelled(), which emit
    // terminal events. An unexpected throw (a runner binary that isn't there,
    // a PTY that won't start) would otherwise skip them entirely, leaving
    // run.json at 'running' with a live pid — a state no reader could ever
    // resolve. Write the same terminal pair here, then rethrow.
    emit({ type: 'run:error', message: (e as Error).message });
    emit({ type: 'run:done', runId, ok: false });
    throw e;
  } finally {
    journal.close();
    // Not inside RunJournal.record: that is synchronous by design and this is
    // not. A resume diffs this against the tree at resume time — comparing
    // against the tree at run *start* would flag every writes:true step's own
    // legitimate output. A dry run touched nothing worth recording.
    if (!opts.dryRun) {
      const stopped = await snapshotTree(workdir);
      if (stopped !== null) journal.noteStoppedTree(stopped);
    }
    // By this point run:done has always already been emitted (every path
    // through runSteps/the catch above ends with it), so runEnvSettled's own
    // `!runEnded` guard means this can no longer cause a late emission — it
    // only makes sure the background probe has actually finished (no
    // dangling subprocess reference) before the process that owns it exits.
    await runEnvSettled;
    await journal.flush();
    // Best-effort: a prune failure must not fail a run that otherwise succeeded.
    await pruneRuns(workdir, config, opts.maxRetainedRuns ?? config.runs.max_retained).catch(() => {});
  }

  async function runSteps(): Promise<RunResult> {
    const label = runName === undefined ? {} : { name: runName };
    emit(opts.resume === undefined
      ? {
          type: 'run:start', runId, workflow: workflow.name, source: opts.workflowSource, ...label,
          ...(attachments.length === 0
            ? {} : { attachments: attachments.map(({ name, size }) => ({ name, size })) }),
        }
      : {
          type: 'run:resume', runId, workflow: workflow.name, ...label,
          ...(opts.resume.restartAt === undefined ? {} : {
            from: opts.resume.restartAt.stepId,
            ...(opts.resume.restartAt.iteration === undefined
              ? {} : { iteration: opts.resume.restartAt.iteration }),
          }),
        });
    for (const sentence of droppedRefSentence(droppedRefs(workflow))) {
      emit({ type: 'guard:warning', message: sentence });
    }

    // One line naming what actually ran this: the highest-value single line
    // in the file for an issue report. Deliberately NOT awaited: probing a
    // runner's binary is a subprocess spawn with its own (multi-second)
    // timeout, and step one must never wait on it — a slow or wedged runner
    // binary would otherwise delay every run that names it, not just the
    // doctor page that already probes this on demand. Skipped on a dry run,
    // which spawns nothing and shouldn't have to probe anything to prove it.
    if (!opts.dryRun) {
      // Dropped, not queued, if the run already ended by the time this
      // resolves: emitting it after run:done would corrupt the one ordering
      // invariant every reader depends on (run:done is always last).
      runEnvSettled = buildRunEnv().then(env => { if (!runEnded) emit(env); }).catch(() => {});
    }

    let warnedNoGit = false;
    let verdict: 'pass' | 'fail' | undefined;

    const fail = (message: string, stepId?: string): RunResult => {
      emit({ type: 'run:error', stepId, message });
      emit({ type: 'run:done', runId, ok: false });
      return { ok: false, runId, runDir, artifacts: ctx.artifacts };
    };

    const cancelled = (): RunResult => {
      emit({ type: 'run:cancelled', runId });
      emit({ type: 'run:done', runId, ok: false });
      return { ok: false, runId, runDir, artifacts: ctx.artifacts, cancelled: true };
    };

    const endWith = (ok: boolean): RunResult => {
      emit({ type: 'run:done', runId, ok });
      return { ok, runId, runDir, artifacts: ctx.artifacts, verdict };
    };

    /**
     * `run:env`'s payload: what whiphand, node and the workflow's own runners
     * resolve to right now, plus the tree's HEAD and dirty state. Scoped to
     * the runners this workflow actually names (not every registered
     * adapter) — this fires once per run, and probing an adapter nobody uses
     * would just be a slower run:start for no reader's benefit.
     */
    async function buildRunEnv(): Promise<WhiphandEvent> {
      const runnerIds = [...new Set(
        planned.map(({ step }) => step).filter(isAgentStep).map(step => step.runner),
      )];
      const [sha, snapshot, runners] = await Promise.all([
        headSha(workdir),
        snapshotTree(workdir),
        Promise.all(runnerIds.map(async (id): Promise<{ id: string; installed: boolean; version?: string }> => {
          try {
            const detected = await registry.get(id).detect();
            return { id, installed: detected.installed, ...(detected.version === undefined ? {} : { version: detected.version }) };
          } catch {
            return { id, installed: false };
          }
        })),
      ]);
      return {
        type: 'run:env', runId,
        whiphandVersion: CORE_VERSION, nodeVersion: process.version, platform: process.platform,
        runners,
        ...(sha === null ? {} : { git: { sha, dirty: snapshot !== null && snapshot !== '' } }),
      };
    }

    /** Take a pre-step tree snapshot for every agent/command step — the read-only guard's own check, and step:tree-delta's, share it. */
    const guardBefore = async (step: Step): Promise<string | null> => {
      if (!isAgentStep(step) && !isCommandStep(step)) return null;
      const before = await snapshotTree(workdir);
      if (before === null && isAgentStep(step) && !step.writes && !warnedNoGit) {
        warnedNoGit = true;
        emit({
          type: 'guard:warning', stepId: step.id,
          message: 'not a git repository: read-only tree assertion disabled',
        });
      }
      return before;
    };

    /**
     * Shared post-step tail: git-guard check, artifact assertion, verdict record.
     * `verdictOverride` carries the pass/fail a command or manual step already
     * determined; agent steps read theirs out of the artifact.
     */
    const finishStep = async (
      step: AgentStep | CommandStep | ManualStep, before: string | null,
      verdictOverride?: 'pass' | 'fail',
    ): Promise<StepOutcome> => {
      if (before !== null) {
        const after = await snapshotTree(workdir);
        const changed = diffSnapshots(before, after ?? '');
        if (changed.length > 0) {
          emit({ type: 'step:tree-delta', stepId: step.id, files: pathsFromStatusLines(changed) });
        }
        if (isAgentStep(step) && !step.writes && changed.length > 0) {
          return fail(`read-only step '${step.id}' modified the tree: ${changed.join(', ')}`, step.id);
        }
        // The only thing that can still prove a `writes: true` step touched
        // nothing else. Inherits the guard's own blind spot: a file already
        // dirty before the step and modified again produces the same
        // porcelain line, so it never shows up in `changed` — this sees
        // status transitions, not content edits.
        if (isAgentStep(step) && step.writes && (step.allow_paths?.length ?? 0) > 0) {
          const globs = step.allow_paths!.map(g => renderTemplate(g, ctx));
          const outside = pathsOutside(pathsFromStatusLines(changed), globs);
          if (outside.length > 0) {
            return fail(`step '${step.id}' wrote outside allow_paths: ${outside.join(', ')}`, step.id);
          }
        }
      }

      const artifact = ctx.artifacts[step.id];
      if (artifact !== undefined) {
        try {
          await assertArtifact(artifact);
        } catch (e) {
          if (e instanceof ArtifactError) {
            emit({ type: 'step:artifact-missing', stepId: step.id, path: artifact, reason: e.reason });
          }
          return fail((e as Error).message, step.id);
        }
        const bytes = await stat(artifact).then(s => s.size).catch(() => undefined);
        emit({ type: 'step:artifact', stepId: step.id, path: artifact, ...(bytes === undefined ? {} : { bytes }) });
      }

      if (!carriesVerdict(step, ctx.frame)) return null;

      let v = verdictOverride;
      if (v === undefined) {
        if (artifact === undefined) return fail(`step '${step.id}' has no artifact to read a verdict from`, step.id);
        const text = await readFile(artifact, 'utf8');
        const parsed = parseVerdict(text);
        if (parsed === null) return fail(`step '${step.id}' artifact is missing a VERDICT line`, step.id);
        v = parsed;
      }
      // An implicit verdict (a gate inside a stage) is about that stage alone,
      // and runStage settles it; only an explicit one speaks for the run.
      if (step.verdict) verdict = v;
      ctx.verdicts[step.id] = v;
      emit({ type: 'step:verdict', stepId: step.id, verdict: v });
      return v === 'fail' ? 'verdict-fail' : null;
    };

    /** Findings-driven prompt/input injection for legacy on_findings re-runs. */
    const extraFindings = new Map<string, string[]>();
    /** Plain sentences for a step's prompt, injected beside its findings and scoped the same way. */
    const extraNotes = new Map<string, string[]>();
    let loopsUsed = 0;
    /** Per stage attempt, keyed by its frame: what executeLoop found out and executeManual tells the human. */
    const stageNotes = new WeakMap<StageFrame, StageAttemptNotes>();

    /**
     * Executions a resume may skip, consumed as they are used.
     *
     * Consume-once is what makes the `on_findings: loop` path correct: it
     * re-executes the same top-level step id — and so the same execution key —
     * a second time, and that execution has to really run rather than inherit
     * the first one's skip. Inside a loop each key is used exactly once per
     * replay, so consuming changes nothing there.
     */
    const skippable = new Map(opts.resume?.done ?? []);

    const withFindings = (step: AgentStep): AgentStep => {
      const findingIds = extraFindings.get(step.id) ?? [];
      const notes = extraNotes.get(step.id) ?? [];
      if (findingIds.length === 0 && notes.length === 0) return step;
      const note = [
        ...findingIds.map(id =>
          `A previous review found problems. Read the findings at ${ctx.artifacts[id]} and address every one of them.`),
        ...notes,
      ].join('\n');
      return {
        ...step,
        prompt: `${step.prompt}\n\n${note}`,
        ...(findingIds.length === 0 ? {} : { inputs: [...new Set([...(step.inputs ?? []), ...findingIds])] }),
      };
    };

    /**
     * Every headless spawn's line handler: a structured-progress spec's stdout
     * is parsed into `step:progress` and never becomes log output (unchanged
     * from before); every other line — both streams on an ordinary step, and
     * stderr even on a progress-format one — becomes a `step:log` event, which
     * RunJournal routes into run.log. This is the one place a frontend's
     * onLine forwarding turns into the merged audit feed.
     *
     * A progress stream's error event is the exception: it is logged as
     * stderr, and `failure()` appends the last one to the step's exit message,
     * since for opencode it is the only record of why the spawn failed.
     */
    const lineSink = (stepId: string, spec: SpawnSpec) => {
      // One parser per spawn: a format with its own running state (opencode's
      // turn/cost totals) must never carry it over into the next spawn — see
      // createProgressParser.
      const format = spec.progress?.format;
      const parse = format === undefined ? undefined : createProgressParser(format);
      let lastError: string | undefined;
      const onLine = (line: string, stream: 'stdout' | 'stderr'): void => {
        if (parse !== undefined && format !== undefined && stream === 'stdout') {
          const progress = parse(line);
          if (progress !== null) {
            emit({ type: 'step:progress', stepId, progress });
            return;
          }
          const error = progressErrorMessage(format, line);
          if (error !== undefined) {
            lastError = error;
            emit({ type: 'step:log', stepId, stream: 'stderr', line: error });
          }
          return;
        }
        emit({ type: 'step:log', stepId, stream, line });
      };
      const failure = (message: string): string => lastError === undefined ? message : `${message}: ${lastError}`;
      return { onLine, failure };
    };

    /** Records where a step's artifact went, both as "latest" and in the history. */
    const recordArtifact = (stepId: string, path: string): void => {
      ctx.artifacts[stepId] = path;
      (ctx.attempts[stepId] ??= []).push(path);
      // This execution hasn't produced a verdict yet — drop whatever an
      // earlier one left, so a step that starts again never carries a stale
      // PASS/FAIL into a prompt built before it finishes this time.
      delete ctx.verdicts[stepId];
    };

    // -----------------------------------------------------------------------
    // Per-kind execution
    // -----------------------------------------------------------------------

    async function executeAgent(step: AgentStep, frame?: Frame): Promise<StepOutcome> {
      const adapter = registry.get(step.runner);
      recordArtifact(step.id, artifactPath(runDir, step, frame));
      await ensureArtifactDir(ctx.artifacts[step.id]);

      let eff = effectiveStep(withFindings(scopeInputs(step, frame)));
      if (step.mode === 'headless') {
        // A headless step cannot know its run dir; name the artifact path explicitly.
        eff = {
          ...eff,
          prompt: `${eff.prompt}\n\nWrite your '${step.output}' artifact to: ${ctx.artifacts[step.id]}`,
        };
      }

      if (opts.dryRun) {
        const main = step.mode === 'interactive' ? adapter.interactive(eff, ctx) : adapter.headless(eff, ctx);
        emit({ type: 'step:spawn', stepId: step.id, spec: main, phase: 'main' });
        if (step.mode === 'interactive') {
          // A capture runner (opencode) only learns its session id from a real
          // spawn; a dry run never spawns one. Without a placeholder here,
          // adapter.harvest — which every capture adapter builds around
          // ctx.sessionIds[step.id] — throws, and dry-run would only work for
          // sessionIdInjection runners. Handed to harvest on a copy, never
          // written into ctx.sessionIds: RunJournal holds that object by
          // reference, so the placeholder would land in run.json, where resume
          // reads any recorded id as a real session to reattach to.
          const harvestCtx = adapter.capabilities.sessionIdCapture && ctx.sessionIds[step.id] === undefined
            ? { ...ctx, sessionIds: { ...ctx.sessionIds, [step.id]: '<captured at runtime>' } }
            : ctx;
          emit({ type: 'step:spawn', stepId: step.id, spec: adapter.harvest(eff, harvestCtx), phase: 'harvest' });
        }
        emit({ type: 'step:done', stepId: step.id, exitCode: 0 });
        return null;
      }

      const spawnHeadless = requireSpawn();
      const before = await guardBefore(step);

      if (step.mode === 'interactive') {
        const main = await prepareInteractiveSpawn(adapter, eff);
        emit({ type: 'step:spawn', stepId: step.id, spec: main, phase: 'main' });
        const sessionExit = await frontend.runInteractive(main, opts.signal, emit);
        // A sessionIdCapture runner (opencode) cannot be handed an id up
        // front — it mints its own, and this is where whiphand learns it.
        // Skipped only when this very spawn resumed an existing session (its
        // id came from the manifest, and no session.created fires for a
        // resumed root session to recapture from). Every other spawn is
        // fresh — including a loop's second-and-later iteration, which reuses
        // the same step id but opens a brand-new session each time — and must
        // be captured again: ctx.sessionIds[step.id] being set already just
        // means a *previous* iteration captured one, not this one.
        const captureFresh = adapter.capabilities.sessionIdCapture && ctx.resumedStepIds?.has(step.id) !== true;
        const recordCapture = async (): Promise<string | undefined> => {
          const captured = await adapter.captureSessionId!(eff, ctx);
          if (captured !== undefined) {
            ctx.sessionIds[step.id] = captured;
            emit({ type: 'step:session', stepId: step.id, sessionId: captured });
          }
          return captured;
        };
        if (opts.signal?.aborted || sessionExit !== 0) {
          // The conversation still exists: record it, or a resume opens a new
          // one and the human's whole session so far is silently gone.
          if (captureFresh) await recordCapture();
          if (opts.signal?.aborted) return cancelled();
          return fail(`interactive step '${step.id}' session exited with code ${sessionExit}`, step.id);
        }
        if (captureFresh) {
          const captured = await recordCapture();
          if (captured === undefined) {
            return fail(
              `could not determine the ${step.runner} session id for step '${step.id}'; `
              + 'the artifact cannot be harvested', step.id);
          }
        }
        const hSpec = adapter.harvest(eff, ctx);
        await writeSpecFiles(hSpec);
        emit({ type: 'step:spawn', stepId: step.id, spec: hSpec, phase: 'harvest' });
        const harvestSink = lineSink(step.id, hSpec);
        const harvestExit = await spawnHeadless(hSpec, opts.signal, harvestSink.onLine);
        if (opts.signal?.aborted) return cancelled();
        emit({ type: 'step:done', stepId: step.id, exitCode: harvestExit });
        if (harvestExit !== 0) {
          return fail(harvestSink.failure(`harvest for step '${step.id}' exited with code ${harvestExit}`), step.id);
        }
      } else {
        const spec = adapter.headless(eff, ctx);
        await writeSpecFiles(spec);
        emit({ type: 'step:spawn', stepId: step.id, spec, phase: 'main' });
        const sink = lineSink(step.id, spec);
        const exitCode = await spawnHeadless(spec, opts.signal, sink.onLine);
        if (opts.signal?.aborted) return cancelled();
        emit({ type: 'step:done', stepId: step.id, exitCode });
        if (exitCode !== 0) return fail(sink.failure(`step '${step.id}' exited with code ${exitCode}`), step.id);
      }

      return finishStep(step, before);
    }

    async function executeCommand(step: CommandStep, frame?: Frame): Promise<StepOutcome> {
      const capture = step.output === undefined
        ? undefined
        : artifactPath(runDir, { output: step.output }, frame);
      if (capture !== undefined) {
        recordArtifact(step.id, capture);
        await ensureArtifactDir(capture);
      }
      // Scoped exactly like an agent's: a forward reference into a loop that
      // hasn't gone round yet is dropped rather than exported as an artifact
      // env var pointing at a stale (or nonexistent) path.
      const spec = commandSpec(scopeInputs(step, frame), ctx, capture);

      if (opts.dryRun) {
        emit({ type: 'step:spawn', stepId: step.id, spec, phase: 'main' });
        emit({ type: 'step:done', stepId: step.id, exitCode: 0 });
        return null;
      }

      // The header goes down before the spawn so the artifact always says which
      // command produced it — and so a command that prints nothing still leaves
      // a non-empty artifact behind instead of failing assertArtifact.
      if (capture !== undefined) await writeFile(capture, captureHeader(step, spec.argv, frame));

      const spawnHeadless = requireSpawn();
      const before = await guardBefore(step);
      emit({ type: 'step:spawn', stepId: step.id, spec, phase: 'main' });
      const { exitCode, timedOut } = await runWithTimeout(step, spec, spawnHeadless, lineSink(step.id, spec).onLine);
      if (opts.signal?.aborted) return cancelled();
      emit({ type: 'step:done', stepId: step.id, exitCode });
      if (capture !== undefined) {
        await appendCapture(
          capture,
          timedOut ? `\n(timed out after ${step.timeout_ms}ms)\n` : captureFooter(exitCode));
      }
      if (timedOut) {
        // Whatever code a killed child reports is an artefact of how it died,
        // not a result; say what actually happened instead — 'exited 1' and
        // 'killed at the 10-minute mark' must never look the same in the log.
        emit({ type: 'step:timeout', stepId: step.id, timeoutMs: step.timeout_ms! });
        return fail(`command step '${step.id}' timed out after ${step.timeout_ms}ms`, step.id);
      }

      const v = verdictFromExit(exitCode, step.expect_exit);
      if (!step.verdict && v === 'fail') {
        return fail(`command step '${step.id}' exited with code ${exitCode}`, step.id);
      }
      return finishStep(step, before, v);
    }

    async function executeManual(step: ManualStep, frame?: Frame): Promise<StepOutcome> {
      const request = await buildManualRequest(scopeInputs(step, frame), ctx, await manualExtras(frame));

      if (opts.dryRun) {
        emit({ type: 'step:manual', stepId: step.id, request });
        emit({ type: 'step:manual-resolved', stepId: step.id, choice: request.defaultChoice });
        emit({ type: 'step:done', stepId: step.id, exitCode: 0 });
        // A dry run spawns nothing and asks no one, but a later step may still
        // reference this one's output — same as executeAgent registering a
        // path with nothing behind it yet, not a file this step actually wrote.
        if (step.output !== undefined) recordArtifact(step.id, artifactPath(runDir, { output: step.output }, frame));
        return null;
      }

      const ask = frontend.runManual;
      if (ask === undefined) {
        return fail(`step '${step.id}': this frontend cannot run ${step.kind} steps`, step.id);
      }

      emit({ type: 'step:manual', stepId: step.id, request });
      let answer;
      try {
        answer = await ask.call(frontend, request, opts.signal);
      } catch (e) {
        if (opts.signal?.aborted) return cancelled();
        return fail(`step '${step.id}': ${(e as Error).message}`, step.id);
      }
      if (opts.signal?.aborted) return cancelled();
      emit({ type: 'step:manual-resolved', stepId: step.id, choice: answer.choice });
      emit({ type: 'step:done', stepId: step.id, exitCode: answer.choice === 'abort' ? 1 : 0 });

      if (answer.choice === 'abort') {
        return fail(`${step.kind} step '${step.id}' was declined`, step.id);
      }

      if (step.output !== undefined) {
        const path = artifactPath(runDir, { output: step.output }, frame);
        recordArtifact(step.id, path);
        await ensureArtifactDir(path);
        const body = step.capture === 'review'
          ? reviewArtifact(step, request, answer)
          : step.capture === 'note'
            ? noteArtifact(step, request, answer.note ?? '')
            : `# ${request.title}\n\n${request.instructions}\n\n**Resolved:** ${answer.choice}\n`;
        await writeFile(path, body);
      }

      return finishStep(step, null, verdictFromChoice(answer.choice));
    }

    /**
     * What a gate inside a stage is told beyond its own instructions: every
     * review cycle that ran out (with its findings forced onto the rail), and
     * whether the stage has changed the tree at all — a stage with no diff is
     * a normal stage, so the human decides knowingly rather than it being
     * skipped.
     */
    async function manualExtras(frame: Frame | undefined): Promise<{ notes: string[]; forceInputs: string[] }> {
      const stage = nearestStage(frame);
      const known = stage === undefined ? undefined : stageNotes.get(stage);
      if (known === undefined) return { notes: [], forceInputs: [] };
      const notes = known.exhausted.map(x =>
        `The review cycle '${x.loopId}' never passed within ${x.iterations} iterations — its findings are attached.`);
      if (known.entrySnapshot !== null
        && diffSnapshots(known.entrySnapshot, await snapshotTree(workdir) ?? '').length === 0) {
        notes.push('This stage produced no changes.');
      }
      return { notes, forceInputs: known.exhausted.map(x => x.untilId) };
    }

    /**
     * Inside a loop, a step may reference a later sibling — meaning "that
     * step's artifact from the previous iteration". On the first iteration
     * there is no such artifact, so the reference is simply dropped rather
     * than failing prompt assembly.
     *
     * A forward reference into loop L means L's *previous* iteration, even
     * when L is nested inside an outer loop that has gone round again: L's
     * frame is found by walking up from `frame`, and if L is on its own first
     * iteration the reference is dropped there too — `ctx.artifacts[id]`
     * alone isn't enough, since it may still hold L's artifact from the
     * outer loop's previous round.
     *
     * `attachments` is dropped the same way, anywhere, when the run has no
     * files attached — a workflow that can use them must not need them.
     */
    function scopeInputs<T extends AgentStep | CommandStep | ManualStep>(step: T, frame?: Frame): T {
      if (step.inputs === undefined) return step;
      const kept = step.inputs.filter(id => {
        if (id === ATTACHMENTS_REF) return (ctx.attachments?.length ?? 0) > 0;
        if (frame !== undefined && isForwardRef(stepLocations, step.id, id)) {
          const loopId = stepLocations.get(id)?.parentLoopId;
          // A stage frame is never the loop this walk is hunting for — only a
          // loop's own body can name a `parentLoopId` — so it is always
          // skipped on the way up, same as any loop whose id doesn't match.
          let owner: Frame | undefined = frame;
          while (owner !== undefined && (isStageFrame(owner) || owner.id !== loopId)) owner = owner.parent;
          if (owner !== undefined && !isStageFrame(owner) && owner.iteration === 1) return false;
        }
        return frame === undefined || ctx.artifacts[id] !== undefined;
      });
      return kept.length === step.inputs.length ? step : { ...step, inputs: kept };
    }

    /**
     * Everything that must happen before an interactive session opens, for a
     * declared interactive step and a triage handoff alike, so the two cannot
     * drift. Leftovers from an earlier attempt would close the session the
     * instant it opened, make it open already looking blocked, or leave a
     * stale captured session id lying around for the capture fallback to trip
     * over; the spec's support files (opencode's guidance and plugin) must be
     * on disk before the runner starts reading them.
     */
    async function prepareInteractiveSpawn(adapter: RunnerAdapter, step: AgentStep): Promise<SpawnSpec> {
      await clearEndMarker(runDir, step.id);
      await clearAwaitState(runDir, step.id);
      if (adapter.capabilities.sessionIdCapture) await clearSessionCapture(runDir, step.id);
      const spec = adapter.interactive(step, ctx);
      await writeSpecFiles(spec);
      return spec;
    }

    function requireSpawn(): (
      spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
    ) => Promise<number> {
      const spawnHeadless = opts.spawnHeadless;
      if (!spawnHeadless) throw new Error('spawnHeadless is required for non-dry runs');
      return spawnHeadless;
    }

    async function executeStep(step: Step, frame?: Frame): Promise<StepOutcome> {
      const enclosing = ctx.frame;
      ctx.frame = frame;
      // ctx.loop is a projection of ctx.frame (the nearest LoopFrame in the
      // chain), kept in step with it so a consumer that only ever knew about
      // loops keeps seeing exactly what it always did.
      ctx.loop = nearestLoop(frame);
      try {
        if (isStagesStep(step)) return await executeStages(step);
        // Loops are never skipped as a unit, even when the manifest records
        // one as done: descending and skipping inside is what restores every
        // body artifact into ctx in the right order, and the replay costs no
        // spawns because each body step is skipped in turn.
        if (isLoopStep(step)) return await executeLoop(step);

        // frameIdentity is the single place that turns a frame into the
        // loopId/iteration/stage/outerLoops tuple every emit site below
        // speaks — a stage frame folds into it exactly like a loop would.
        const idn = frameIdentity(frame);
        const key = executionKey(step.id, idn.iteration, idn.outerLoops, idn.stage);
        const alreadyDone = skippable.get(key);
        if (alreadyDone !== undefined) {
          skippable.delete(key);
          if (alreadyDone.artifact !== undefined) recordArtifact(step.id, alreadyDone.artifact);
          // After recordArtifact, which just cleared it for this execution —
          // a replayed step's prompt label must see the verdict it actually
          // produced, exactly like a fresh execution's finishStep would set.
          if (alreadyDone.verdict !== undefined) ctx.verdicts[step.id] = alreadyDone.verdict;
          emit({ type: 'step:skipped', stepId: step.id, ...executionFields(idn) });
          if (!carriesVerdict(step, frame)) return null;
          // Restoring the verdict is not optional: it drives a loop's exit
          // check, the top-level on_findings jump and a stage's retry. Returning
          // null here would make a loop that originally failed twice replay as
          // passing, and a rejected stage replay as accepted. As in finishStep,
          // only an explicit verdict step speaks for the run.
          if (step.verdict) verdict = alreadyDone.verdict;
          return alreadyDone.verdict === 'fail' ? 'verdict-fail' : null;
        }

        emit({
          type: 'step:start', stepId: step.id, kind: step.kind,
          ...(isAgentStep(step) ? { runner: step.runner, model: step.model, mode: step.mode } : {}),
          ...executionFields(idn),
        });
        // The whole frame, not just its nearest loop: a step directly inside a
        // stage must write under that stage's directory, or every stage's
        // artifact would land on the same flat top-level path.
        if (isAgentStep(step)) return await executeAgent(step, frame);
        if (isCommandStep(step)) return await executeCommand(step, frame);
        return await executeManual(step, frame);
      } finally {
        ctx.frame = enclosing;
        ctx.loop = nearestLoop(enclosing);
      }
    }

    // -----------------------------------------------------------------------
    // Loops
    // -----------------------------------------------------------------------

    async function executeLoop(loop: LoopStep): Promise<StepOutcome> {
      // The frame this loop invocation runs under — set by executeStep just
      // before it dispatched here — is also this loop's own row identity:
      // which round of *its* enclosing loop or stage this is, if any.
      const outer = ctx.frame;
      const idn = frameIdentity(outer);
      const loopEvent = {
        ...(idn.loopId === undefined ? {} : { parentLoopId: idn.loopId, parentIteration: idn.iteration }),
        ...(idn.stage === undefined ? {} : { parentStage: idn.stage }),
        ...(idn.outerLoops.length === 0 ? {} : { outerLoops: idn.outerLoops }),
      };
      const grant = opts.resume?.loopBudgets[executionKey(loop.id, idn.iteration, idn.outerLoops, idn.stage)];
      const maxIterations =
        opts.maxIterations ?? grant?.budget ?? loop.max_iterations ?? config.loop.max_iterations;
      // opts.maxIterations is absolute, so it can be set below what this loop
      // already ran; without this, that instantly re-fails with nothing else
      // said, and it looks like resume itself is broken rather than the budget.
      if (grant !== undefined && maxIterations <= grant.completed) {
        emit({
          type: 'guard:warning',
          message: `loop '${loop.id}' has already completed ${grant.completed} iterations but this run `
            + `allows only ${maxIterations}, so it cannot pass`,
        });
      }
      emit({ type: 'loop:start', loopId: loop.id, maxIterations, ...loopEvent });

      let passed = false;
      let iteration = 0;

      for (iteration = 1; iteration <= maxIterations && !passed; iteration++) {
        if (opts.signal?.aborted) return cancelled();
        emit({ type: 'loop:iteration', loopId: loop.id, iteration, maxIterations, ...loopEvent });
        const frame: LoopFrame = { id: loop.id, iteration, maxIterations, parent: outer };

        for (const body of loop.steps) {
          if (opts.signal?.aborted) return cancelled();
          const outcome = await executeStep(body, frame);
          if (outcome !== null && outcome !== 'verdict-fail') return outcome;
          if (body.id === loop.until) {
            // The exit check decides the iteration: pass ends the loop right
            // here, fail abandons the rest of the body and goes round again.
            passed = outcome !== 'verdict-fail';
            break;
          }
        }
      }

      const iterations = passed ? iteration - 1 : maxIterations;
      emit({ type: 'loop:done', loopId: loop.id, iterations, passed, ...loopEvent });
      ctx.frame = outer;
      ctx.loop = nearestLoop(outer);
      if (passed) return null;

      // Inside a stage the human gate after this loop (schema.ts guarantees
      // one) decides instead: the run must not end before anyone has seen the
      // work. An author who explicitly chose on_exhausted: interactive still
      // gets triage.
      const stage = nearestStage(outer);
      if (stage !== undefined && loop.on_exhausted !== 'interactive') {
        stageNotes.get(stage)?.exhausted.push({ loopId: loop.id, untilId: loop.until, iterations: maxIterations });
        return 'verdict-fail';
      }

      const policy = loop.on_exhausted ?? onFindings;
      const untilStep = loop.steps.find(s => s.id === loop.until);
      if (policy === 'interactive') {
        if (untilStep !== undefined && isAgentStep(untilStep)) {
          const triage = await runTriage(untilStep);
          if (triage !== null) return triage;
        } else {
          // There is no session to resume for a command or a human answer, so
          // say why the handoff isn't happening rather than skipping silently.
          emit({
            type: 'guard:warning',
            message: `loop '${loop.id}': on_exhausted 'interactive' needs an agent step as 'until'; `
              + `'${loop.until}' is not one, so the findings just stand`,
          });
        }
      }
      // The loop is blamed, not the reviewer: that until-step's last iteration
      // really did complete, with a 'fail' verdict, and blame now demotes the
      // step it names (see RunJournal.finalizeRunningSteps). Blaming it would
      // wipe that verdict and re-run the iteration on the next resume. What
      // ran out was the loop's budget; the message still names the until-step.
      return fail(
        `loop '${loop.id}' did not pass '${loop.until}' within ${maxIterations} iterations`,
        loop.id);
    }

    // -----------------------------------------------------------------------
    // Stages
    // -----------------------------------------------------------------------

    /** The stages step's own execution key — what the resume plan's stage records are keyed by. */
    function stagesKey(stages: StagesStep, frame: Frame | undefined): string {
      const idn = frameIdentity(frame);
      return executionKey(stages.id, idn.iteration, idn.outerLoops, idn.stage);
    }

    /**
     * Ids of the stages a resumed run already accepted, which it must not run
     * again — skipped wholesale rather than replayed, since an accepted stage
     * can hold a loop that is `failed` for good.
     */
    function resumedCompletedStages(stages: StagesStep, frame: Frame | undefined): Set<string> {
      return new Set(opts.resume?.stagesCompleted[stagesKey(stages, frame)] ?? []);
    }

    // Never 'verdict-fail': a stages step has no artifact, so the top-level
    // on_findings: 'loop' jump would build "Read the findings at undefined".
    async function executeStages(stages: StagesStep): Promise<RunResult | null> {
      const outer = ctx.frame;
      const pattern = renderTemplate(stages.items, ctx);
      const completed = resumedCompletedStages(stages, outer);
      const maxAttempts = 1 + (stages.max_retries ?? DEFAULT_STAGE_RETRIES);
      let started = false;

      // Re-globbed before every stage, so a stage added or removed while an
      // earlier one ran is seen; `completed` (matched on stage.id) is what
      // keeps an edited, already-finished stage from running again.
      for (;;) {
        if (opts.signal?.aborted) return cancelled();
        let list: Stage[];
        try {
          list = await discoverStages(workdir, pattern);
        } catch (e) {
          // A bad plan directory is this step's failure; anything else is a bug.
          if (!(e instanceof StageError)) throw e;
          return fail(`stages step '${stages.id}': ${e.message}`, stages.id);
        }
        if (!started) {
          // Only the first pass: a list that empties later means the plan's
          // remaining stages were removed, which ends the step cleanly.
          if (list.length === 0) {
            return fail(`stages step '${stages.id}' matched no stage files (${pattern})`, stages.id);
          }
          const odd = new Set(oddStageNames(list));
          for (const stage of list.filter(s => odd.has(s.id))) {
            emit({
              type: 'guard:warning', stepId: stages.id,
              message: `stage file '${basename(stage.path)}' is not named NN-slug, `
                + 'so its position in the order is not obvious',
            });
          }
          emit({ type: 'stages:start', id: stages.id, total: list.length });
          started = true;
        }
        const stage = nextStage(list, completed);
        if (stage === undefined) break;
        const outcome = await runStage(stages, stage, maxAttempts, outer, completed);
        if (outcome !== null) return outcome;
      }
      emit({ type: 'stages:done', id: stages.id, completed: completed.size });
      return null;
    }

    /**
     * One stage file, start to accepted. Its body sees this stage's work plus
     * whatever existed before the stages step began — never an earlier
     * stage's artifacts, verdicts or findings, which is what makes each
     * stage's minimal context real.
     *
     * A gate answering `retry` runs the body again from the top, with the
     * rejection handed to the implementer, up to `maxAttempts`; after that the
     * stage goes to a triage session and the run stops.
     */
    async function runStage(
      stages: StagesStep, stage: Stage, maxAttempts: number, outer: Frame | undefined, completed: Set<string>,
    ): Promise<RunResult | null> {
      // The file was read once, for its title; if it is gone now, say so
      // rather than handing the body an empty stage.
      try {
        await assertArtifact(stage.path);
      } catch (e) {
        return fail(`stages step '${stages.id}': stage file '${basename(stage.path)}' `
          + `cannot be used: ${(e as Error).message}`, stages.id);
      }

      // A stage that went to triage is granted one attempt more than it used;
      // the grant replaces max_retries' count for this stage only.
      const resumeKey = stageBudgetKey(stagesKey(stages, outer), stage.id);
      const granted = opts.resume?.stageBudgets[resumeKey];
      const allowed = granted ?? maxAttempts;
      const interruptedAttempt = opts.resume?.stagesInterrupted[resumeKey];

      // Not ctx.attempts: that is an append-only audit list, never scoped.
      const saved = {
        artifacts: { ...ctx.artifacts }, verdicts: { ...ctx.verdicts },
        findings: new Map([...extraFindings]), notes: new Map([...extraNotes]), verdict,
      };
      const restore = (): void => {
        replaceRecord(ctx.artifacts, saved.artifacts);
        replaceRecord(ctx.verdicts, saved.verdicts);
        extraFindings.clear();
        for (const [id, ids] of saved.findings) extraFindings.set(id, ids);
        extraNotes.clear();
        for (const [id, notes] of saved.notes) extraNotes.set(id, notes);
        verdict = saved.verdict;
      };
      // Whoever writes to the tree in this body — the steps a note about the
      // tree's state is addressed to.
      const implementers = flattenSteps(stages.steps).map(f => f.step).filter(isAgentStep).filter(s => s.writes);
      const tellImplementers = (note: string): void => {
        for (const step of implementers) extraNotes.set(step.id, [...(extraNotes.get(step.id) ?? []), note]);
      };
      // Every id declared anywhere in the body — on a resumed run the resume
      // plan seeds the newest artifact per id across *all* stages.
      const bodyIds = flattenSteps(stages.steps).map(f => f.step.id);
      const scrub = (): void => {
        for (const id of bodyIds) {
          delete ctx.artifacts[id];
          delete ctx.verdicts[id];
        }
      };

      // Taken once, at stage entry, and shared by every attempt: a retry that
      // re-edits a file attempt 1 already changed leaves an identical porcelain
      // line, so an attempt-entry snapshot would call real work "no changes".
      const entrySnapshot = opts.dryRun ? null : await snapshotTree(workdir);
      // The gate that sent the last attempt back, and the note it wrote.
      let rejection: { gateId: string; path: string | undefined } | undefined;
      for (let attempt = 1; attempt <= allowed; attempt++) {
        if (attempt > 1) restore();
        scrub();
        // A pseudo-artifact, deliberately not recordArtifact: it has no
        // attempt history and no verdict of its own.
        ctx.artifacts[STAGE_REF] = stage.path;
        if (rejection !== undefined) {
          // Re-seeded after the restore, so the rejection lives exactly as
          // long as this stage: withFindings hands it to the implementer, and
          // the next restore clears it.
          const target = stageRetryTarget(stages.steps, rejection.gateId);
          ctx.verdicts[rejection.gateId] = 'fail';
          if (rejection.path !== undefined) {
            ctx.artifacts[rejection.gateId] = rejection.path;
            if (target !== undefined) extraFindings.set(target.id, [rejection.gateId]);
          }
        }
        // A resume re-runs a cut-short attempt from the top, against a tree
        // that already holds its partial edits: the engine never discards work
        // it was not asked to, so the implementer is told to reconcile it.
        if (attempt === interruptedAttempt) {
          tellImplementers('A previous attempt was interrupted; reconcile whatever it left in the tree.');
        }
        // Not when that granted attempt is the one being resumed after an
        // interruption: the triage was before it, and what the tree holds now
        // is that attempt's own partial work.
        if (granted !== undefined && attempt === granted && attempt !== interruptedAttempt) {
          tellImplementers(`A human has just been through the tree in a triage session after this stage was `
            + `rejected ${granted - 1} times; build on the tree as it is now.`);
        }
        emit({
          type: 'stages:item', id: stages.id, index: stage.index, total: stage.total,
          stageId: stage.id, title: stage.title, attempt, maxAttempts: allowed,
        });
        const frame: StageFrame = { kind: 'stages', id: stages.id, stage, attempt, maxAttempts: allowed, parent: outer };
        stageNotes.set(frame, { exhausted: [], entrySnapshot });

        let rejected = false;
        for (const body of stages.steps) {
          if (opts.signal?.aborted) return cancelled();
          const outcome = await executeStep(body, frame);
          if (outcome === 'verdict-fail') {
            // A gate answering retry sends the stage round again from the
            // top. An exhausted loop (its cycle recorded for the gate by
            // executeLoop) and any other failing verdict carry on to the next
            // body step, exactly as a loop treats a non-`until` verdict.
            if (isManualStep(body)) {
              rejection = { gateId: body.id, path: ctx.artifacts[body.id] };
              rejected = true;
              break;
            }
            continue;
          }
          if (outcome !== null) return outcome;
        }

        if (!rejected) {
          completed.add(stage.id);
          emit({ type: 'stages:accepted', id: stages.id, stageId: stage.id });
          // Acceptance is authoritative: this restores the run-level verdict
          // to what it was before the stage, so a review the human waved
          // through does not fail the run — but a failure from before the
          // stages step is not erased either.
          restore();
          return null;
        }
      }

      // Out of attempts: hand the stage to a human in a live session, then
      // stop. Marked first, so a triage that is itself cancelled still
      // leaves the record a resume grants its extra attempt against.
      const last = rejection!;
      emit({ type: 'stages:exhausted', id: stages.id, stageId: stage.id, attempts: allowed });
      const target = stageRetryTarget(stages.steps, last.gateId);
      if (target === undefined) {
        emit({
          type: 'guard:warning', stepId: stages.id,
          message: `stages step '${stages.id}': no writes: true agent step before '${last.gateId}', `
            + `so stage '${stage.id}' has no session to hand over to`,
        });
      } else {
        const findingsId = stageFindingsId(stages.steps, last.gateId);
        const findings = findingsId === undefined ? undefined : ctx.artifacts[findingsId];
        const prompt = [
          `Stage ${stage.index} of ${stage.total} ('${stage.title}') was rejected ${allowed} times, `
            + `so its retries have run out. The stage file is ${stage.path}.`,
          "A previous attempt's work is in the working tree.",
          ...(findings === undefined ? [] : [`The last review's findings are in ${findings}.`]),
          ...(last.path === undefined ? [] : [`The last rejection note is in ${last.path}.`]),
          'Read them and work with me to finish this stage.',
        ].join(' ');
        const triage = await runTriage(target, prompt);
        if (triage !== null) return triage;
      }
      return fail(`stages step '${stages.id}': stage ${stage.index} of ${stage.total} ('${stage.title}') `
        + `was rejected ${allowed} times`, stages.id);
    }

    /**
     * The `on_findings: interactive` handoff, shared by the legacy top-level
     * policy, a loop's on_exhausted and a stage whose retries ran out: a live
     * session seeded with the findings, or with `prompt` when the caller has
     * more to say than one findings file.
     */
    async function runTriage(
      source: Step,
      prompt = `The review found problems. The findings are in ${ctx.artifacts[source.id]}. `
        + 'Read them and work with me to resolve them.',
    ): Promise<RunResult | null> {
      if (!isAgentStep(source)) return null;
      const adapter = registry.get(source.runner);
      const triage: AgentStep = {
        ...source,
        id: `${source.id}-triage`,
        mode: 'interactive',
        writes: true,
        verdict: undefined,
        prompt,
      };
      if (adapter.capabilities.sessionIdInjection) {
        ctx.sessionIds[triage.id] = randomUUID();
      }
      // Triage goes through the same preparation as a declared interactive
      // step, so it inherits the guidance, the end-of-session spec and (for
      // opencode) the support files without asking for them.
      const triageSpec = await prepareInteractiveSpawn(adapter, triage);
      // Deliberately not a step: triage has no step:start/step:done lifecycle,
      // so it emits no step:spawn either — the journal would have no manifest
      // entry to hang one on (RunJournal's step:spawn branch only marks an
      // entry step:start already created; `sessionStarted` therefore has
      // nowhere to go, and resume never offers to reopen a triage session),
      // and a lone spawn line for a step that never started would only
      // confuse run.log readers and the desktop's step list. The exit code is
      // ignored for the same reason the handoff returns null on success:
      // either way the findings stand and both callers end the run as not ok,
      // so a non-zero session exit has no outcome left to change.
      await frontend.runInteractive(triageSpec, opts.signal, emit);
      if (opts.signal?.aborted) return cancelled();
      return null;
    }

    async function runWithTimeout(
      step: CommandStep, spec: SpawnSpec,
      spawnHeadless: (spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void) => Promise<number>,
      onLine: (line: string, stream: 'stdout' | 'stderr') => void,
    ): Promise<{ exitCode: number; timedOut: boolean }> {
      if (step.timeout_ms === undefined) {
        return { exitCode: await spawnHeadless(spec, opts.signal, onLine), timedOut: false };
      }
      const timeout = AbortSignal.timeout(step.timeout_ms);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const exitCode = await spawnHeadless(spec, signal, onLine);
      // The run's own cancellation wins: that is not this step timing out.
      return { exitCode, timedOut: timeout.aborted && !opts.signal?.aborted };
    }

    // -----------------------------------------------------------------------
    // The top-level walk, which alone can jump backwards for on_findings: loop
    // -----------------------------------------------------------------------

    let i = 0;
    while (i < effective.steps.length) {
      if (opts.signal?.aborted) return cancelled();
      const step = effective.steps[i];
      const outcome = await executeStep(step, undefined);

      if (outcome === 'verdict-fail') {
        if (onFindings === 'loop' && loopsUsed < config.loop.max_iterations) {
          loopsUsed += 1;
          const targetIdx = loopTargetIndex(effective.steps, i);
          const target = effective.steps[targetIdx];
          extraFindings.set(target.id, [...new Set([...(extraFindings.get(target.id) ?? []), step.id])]);
          // A step showing up three times in the log with no explanation is
          // worse than no log: name it as a review-driven retry, not a
          // mysterious re-run.
          emit({ type: 'step:retry', stepId: target.id, attempt: (ctx.attempts[target.id]?.length ?? 0) + 1 });
          i = targetIdx;
          continue;
        }
        if (onFindings === 'interactive') {
          const triage = await runTriage(step);
          if (triage !== null) return triage;
        }
        // report (and exhausted loop / finished interactive triage): findings stood.
        return endWith(false);
      }
      if (outcome !== null) return outcome;
      i += 1;
    }

    return endWith(verdict !== 'fail');
  }
}

async function createRunDirFor(workdir: string, config: WorkspaceConfig) {
  const { createRunDir } = await import('./artifacts.ts');
  return createRunDir(workdir, config.artifacts_dir);
}

async function appendCapture(path: string, text: string): Promise<void> {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, text);
}
