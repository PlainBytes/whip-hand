import { readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type {
  AgentStep, AttachmentSource, CommandStep, Frontend, LoopFrame, LoopStep, ManualStep, WhiphandEvent,
  OnFindings, Scope, Workflow, RunCtx, SpawnSpec, Step, WorkspaceConfig,
} from '../types.ts';
import { AdapterRegistry, validateWorkflowRunners, validateWorkflowFrontend } from '../registry.ts';
import { WorkflowError } from '../schema.ts';
import { collectLoops, flattenSteps, isAgentStep, isCommandStep, isLoopStep, isManualStep } from '../steps.ts';
import { disabledIds, droppedRefs, droppedRefSentence, pruneDisabled } from '../enabled.ts';
import { ATTACHMENTS_REF } from '../attachments.ts';
import { copyAttachments, recordOf, validateAttachments } from './attachments.ts';
import { artifactPath, assertArtifact, ArtifactError, ensureArtifactDir } from './artifacts.ts';
import { snapshotTree, diffSnapshots, headSha, pathsFromStatusLines } from './git-guard.ts';
import { CORE_VERSION } from '../version.ts';
import { parseVerdict, verdictFromExit, verdictFromChoice, VERDICT_INSTRUCTION } from './verdict.ts';
import { parseProgressLine } from './progress.ts';
import { commandSpec, captureHeader, captureFooter } from './command.ts';
import { buildManualRequest, noteArtifact, reviewArtifact } from './manual.ts';
import { clearEndMarker } from './session-end.ts';
import { clearAwaitState } from './await-state.ts';
import { RunJournal, WORKFLOW_SNAPSHOT_NAME, executionKey } from './manifest.ts';
import { pruneRuns } from './retention.ts';
import { readRunName, runSlugFor, setRunName } from './run-name.ts';
import { autoNameRun } from './auto-name.ts';
import type { ResumePlan } from './resume.ts';

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

/** Steps passed to adapters get the verdict instruction appended when needed. */
function effectiveStep(step: AgentStep): AgentStep {
  if (!step.verdict) return step;
  return { ...step, prompt: `${step.prompt}\n\n${VERDICT_INSTRUCTION}` };
}

/** Index of the nearest step before `verdictIdx` with writes: true, or -1. */
function loopTargetIndex(steps: Step[], verdictIdx: number): number {
  for (let i = verdictIdx - 1; i >= 0; i--) {
    const s = steps[i];
    if (isAgentStep(s) && s.writes) return i;
  }
  return -1;
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
      if (!isLoopStep(step) && step.verdict && loopTargetIndex(effective.steps, idx) === -1) {
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
        sessionIds: ctx.sessionIds, steps: planned.map(({ step, loopId }) => ({
          id: step.id,
          kind: step.kind,
          loopId,
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
    const seq = journal.record(e);
    frontend.onEvent(e, seq);
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

      if (!step.verdict) return null;

      let v = verdictOverride;
      if (v === undefined) {
        if (artifact === undefined) return fail(`step '${step.id}' has no artifact to read a verdict from`, step.id);
        const text = await readFile(artifact, 'utf8');
        const parsed = parseVerdict(text);
        if (parsed === null) return fail(`step '${step.id}' artifact is missing a VERDICT line`, step.id);
        v = parsed;
      }
      verdict = v;
      emit({ type: 'step:verdict', stepId: step.id, verdict: v });
      return v === 'fail' ? 'verdict-fail' : null;
    };

    /** Findings-driven prompt/input injection for legacy on_findings re-runs. */
    const extraFindings = new Map<string, string[]>();
    let loopsUsed = 0;

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
      const findingIds = extraFindings.get(step.id);
      if (!findingIds || findingIds.length === 0) return step;
      const note = findingIds
        .map(id => `A previous review found problems. Read the findings at ${ctx.artifacts[id]} and address every one of them.`)
        .join('\n');
      return {
        ...step,
        prompt: `${step.prompt}\n\n${note}`,
        inputs: [...new Set([...(step.inputs ?? []), ...findingIds])],
      };
    };

    /**
     * Every headless spawn's line handler: a structured-progress spec's stdout
     * is parsed into `step:progress` and never becomes log output (unchanged
     * from before); every other line — both streams on an ordinary step, and
     * stderr even on a progress-format one — becomes a `step:log` event, which
     * RunJournal routes into run.log. This is the one place a frontend's
     * onLine forwarding turns into the merged audit feed.
     */
    const lineSink = (stepId: string, spec: SpawnSpec) => (line: string, stream: 'stdout' | 'stderr'): void => {
      const format = spec.progress?.format;
      if (format !== undefined && stream === 'stdout') {
        const progress = parseProgressLine(format, line);
        if (progress !== null) emit({ type: 'step:progress', stepId, progress });
        return;
      }
      emit({ type: 'step:log', stepId, stream, line });
    };

    /** Records where a step's artifact went, both as "latest" and in the history. */
    const recordArtifact = (stepId: string, path: string): void => {
      ctx.artifacts[stepId] = path;
      (ctx.attempts[stepId] ??= []).push(path);
    };

    // -----------------------------------------------------------------------
    // Per-kind execution
    // -----------------------------------------------------------------------

    async function executeAgent(step: AgentStep, frame?: LoopFrame): Promise<StepOutcome> {
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
          emit({ type: 'step:spawn', stepId: step.id, spec: adapter.harvest(eff, ctx), phase: 'harvest' });
        }
        emit({ type: 'step:done', stepId: step.id, exitCode: 0 });
        return null;
      }

      const spawnHeadless = requireSpawn();
      const before = await guardBefore(step);

      if (step.mode === 'interactive') {
        // Leftovers from an earlier attempt would close this session the
        // instant it opened, or make it open already looking blocked.
        await clearEndMarker(runDir, step.id);
        await clearAwaitState(runDir, step.id);
        const main = adapter.interactive(eff, ctx);
        emit({ type: 'step:spawn', stepId: step.id, spec: main, phase: 'main' });
        const sessionExit = await frontend.runInteractive(main, opts.signal, emit);
        if (opts.signal?.aborted) return cancelled();
        if (sessionExit !== 0) {
          return fail(`interactive step '${step.id}' session exited with code ${sessionExit}`, step.id);
        }
        const hSpec = adapter.harvest(eff, ctx);
        emit({ type: 'step:spawn', stepId: step.id, spec: hSpec, phase: 'harvest' });
        const harvestExit = await spawnHeadless(hSpec, opts.signal, lineSink(step.id, hSpec));
        if (opts.signal?.aborted) return cancelled();
        emit({ type: 'step:done', stepId: step.id, exitCode: harvestExit });
        if (harvestExit !== 0) {
          return fail(`harvest for step '${step.id}' exited with code ${harvestExit}`, step.id);
        }
      } else {
        const spec = adapter.headless(eff, ctx);
        emit({ type: 'step:spawn', stepId: step.id, spec, phase: 'main' });
        const exitCode = await spawnHeadless(spec, opts.signal, lineSink(step.id, spec));
        if (opts.signal?.aborted) return cancelled();
        emit({ type: 'step:done', stepId: step.id, exitCode });
        if (exitCode !== 0) return fail(`step '${step.id}' exited with code ${exitCode}`, step.id);
      }

      return finishStep(step, before);
    }

    async function executeCommand(step: CommandStep, frame?: LoopFrame): Promise<StepOutcome> {
      const capture = step.output === undefined
        ? undefined
        : artifactPath(runDir, { output: step.output }, frame);
      if (capture !== undefined) {
        recordArtifact(step.id, capture);
        await ensureArtifactDir(capture);
      }
      const spec = commandSpec(step, ctx, capture);

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
      const { exitCode, timedOut } = await runWithTimeout(step, spec, spawnHeadless, lineSink(step.id, spec));
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

    async function executeManual(step: ManualStep, frame?: LoopFrame): Promise<StepOutcome> {
      const request = await buildManualRequest(scopeInputs(step, frame), ctx);

      if (opts.dryRun) {
        emit({ type: 'step:manual', stepId: step.id, request });
        emit({ type: 'step:manual-resolved', stepId: step.id, choice: request.defaultChoice });
        emit({ type: 'step:done', stepId: step.id, exitCode: 0 });
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
     * Inside a loop, a step may reference a later sibling — meaning "that
     * step's artifact from the previous iteration". On the first iteration
     * there is no such artifact, so the reference is simply dropped rather
     * than failing prompt assembly.
     *
     * `attachments` is dropped the same way, anywhere, when the run has no
     * files attached — a workflow that can use them must not need them.
     */
    function scopeInputs<T extends AgentStep | CommandStep | ManualStep>(step: T, frame?: LoopFrame): T {
      if (step.inputs === undefined) return step;
      const kept = step.inputs.filter(id => id === ATTACHMENTS_REF
        ? (ctx.attachments?.length ?? 0) > 0
        : frame === undefined || ctx.artifacts[id] !== undefined);
      return kept.length === step.inputs.length ? step : { ...step, inputs: kept };
    }

    function requireSpawn(): (
      spec: SpawnSpec, signal?: AbortSignal, onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
    ) => Promise<number> {
      const spawnHeadless = opts.spawnHeadless;
      if (!spawnHeadless) throw new Error('spawnHeadless is required for non-dry runs');
      return spawnHeadless;
    }

    async function executeStep(step: Step, frame?: LoopFrame): Promise<StepOutcome> {
      const enclosing = ctx.loop;
      ctx.loop = frame;
      try {
        // Loops are never skipped as a unit, even when the manifest records
        // one as done: descending and skipping inside is what restores every
        // body artifact into ctx in the right order, and the replay costs no
        // spawns because each body step is skipped in turn.
        if (isLoopStep(step)) return await executeLoop(step);

        const key = executionKey(step.id, frame?.iteration);
        const alreadyDone = skippable.get(key);
        if (alreadyDone !== undefined) {
          skippable.delete(key);
          if (alreadyDone.artifact !== undefined) recordArtifact(step.id, alreadyDone.artifact);
          emit({
            type: 'step:skipped', stepId: step.id,
            ...(frame === undefined ? {} : { loopId: frame.id, iteration: frame.iteration }),
          });
          if (!step.verdict) return null;
          // Restoring the verdict is not optional: it drives a loop's exit
          // check and the top-level on_findings jump. Returning null here would
          // make a loop that originally failed twice replay as passing.
          verdict = alreadyDone.verdict;
          return alreadyDone.verdict === 'fail' ? 'verdict-fail' : null;
        }

        emit({
          type: 'step:start', stepId: step.id, kind: step.kind,
          ...(isAgentStep(step) ? { runner: step.runner, model: step.model, mode: step.mode } : {}),
          ...(frame === undefined ? {} : { loopId: frame.id, iteration: frame.iteration }),
        });
        if (isAgentStep(step)) return await executeAgent(step, frame);
        if (isCommandStep(step)) return await executeCommand(step, frame);
        return await executeManual(step, frame);
      } finally {
        ctx.loop = enclosing;
      }
    }

    // -----------------------------------------------------------------------
    // Loops
    // -----------------------------------------------------------------------

    async function executeLoop(loop: LoopStep): Promise<StepOutcome> {
      const outer = ctx.loop;
      const grant = opts.resume?.loopBudgets[loop.id];
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
      emit({ type: 'loop:start', loopId: loop.id, maxIterations });

      let passed = false;
      let iteration = 0;

      for (iteration = 1; iteration <= maxIterations && !passed; iteration++) {
        if (opts.signal?.aborted) return cancelled();
        emit({ type: 'loop:iteration', loopId: loop.id, iteration, maxIterations });
        const frame: LoopFrame = { id: loop.id, iteration, maxIterations };

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
      emit({ type: 'loop:done', loopId: loop.id, iterations, passed });
      ctx.loop = outer;
      if (passed) return null;

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

    /**
     * The `on_findings: interactive` handoff, shared by the legacy top-level
     * policy and a loop's on_exhausted: a live session seeded with the findings.
     */
    async function runTriage(source: Step): Promise<RunResult | null> {
      if (!isAgentStep(source)) return null;
      const adapter = registry.get(source.runner);
      const triage: AgentStep = {
        ...source,
        id: `${source.id}-triage`,
        mode: 'interactive',
        writes: true,
        verdict: undefined,
        prompt:
          `The review found problems. The findings are in ${ctx.artifacts[source.id]}. ` +
          `Read them and work with me to resolve them.`,
      };
      if (adapter.capabilities.sessionIdInjection) {
        ctx.sessionIds[triage.id] = randomUUID();
      }
      await clearEndMarker(runDir, triage.id);
      await clearAwaitState(runDir, triage.id);
      // Triage goes through adapter.interactive too, so it inherits the
      // guidance and the end-of-session spec without asking for them.
      await frontend.runInteractive(adapter.interactive(triage, ctx), opts.signal, emit);
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
