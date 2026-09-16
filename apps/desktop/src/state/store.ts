import { create } from 'zustand';
import type { ConnectionStatus, RunSummary } from '../agent/client.ts';
import type {
  ConfigGetResult,
  DoctorResult,
  JobStatus,
  ListModelsResult,
  ListWorkflowsResult,
  WhiphandEventNotificationParams,
  PtyDataParams,
  PtyExitParams,
  PtyAwaitParams,
  AwaitReason,
  PtyStartedParams,
  RunStateChangedParams,
  StepLogParams,
  ManualRequestParams,
  ManualResolvedParams,
  RemoteAccessChangedParams,
  JobScrollbackResult,
  JobSummary,
} from '../../../../packages/agent/src/protocol.ts';
import type { LoopRef, ManualRequest, StepKind, StepMode, StepProgress } from '../../../../packages/core/src/types.ts';
import { executionKey } from '../../../../packages/core/src/execution-key.ts';
import type { AppState as AppStateData } from '../../../../packages/agent/src/app-state.ts';
import type { LogRow } from '../../../../packages/core/src/log-rows.ts';
import { mergeUsage, progressActionText, summarizeEvent } from '../../../../packages/core/src/log-rows.ts';

/**
 * Workflows, the runs list, per-job live state, doctor results, config, the
 * workspace path and agent status all live here — see JobState below for the
 * per-job shape that the whiphandEvent/runStateChanged/stepLog/ptyStarted/
 * ptyExit notifications reduce into.
 */

export interface StepState {
  /** The declared step id. Not unique once loops repeat a step — see `key`. */
  id: string;
  /** Unique per *execution*: 'execute' at the top level, 'execute#2' in a loop. */
  key: string;
  kind?: StepKind;
  /** id of the enclosing loop, when this execution happened inside one. */
  loopId?: string;
  /** 1-based iteration this execution belongs to; absent outside a loop. */
  iteration?: number;
  /**
   * Loops enclosing `loopId` itself, outermost first — absent or empty
   * outside nested loops. Mirrors the manifest row's own field (see
   * packages/core/src/engine/manifest.ts); a loop's own row carries it too,
   * identified by *its* enclosing loop exactly as a leaf step's row is.
   */
  outerLoops?: LoopRef[];
  /**
   * The stage file this execution ran under, when `loopId` names a `stages`
   * frame rather than a plain loop. Mirrors the manifest row's own field.
   */
  stage?: string;
  /**
   * id of the enclosing `stages` step, on a row seeded from the declared plan
   * (manifest only — no event carries it). What lets a body row that has not
   * run yet, and so has no `stage`, still sit under its stages step.
   */
  stagesId?: string;
  /** On a `stages` step's own row: how many stage files it found. */
  total?: number;
  /** On a `stages` step's own row: how many stages it finished, once it is done. */
  completed?: number;
  /** On a `stages` step's own row: the attempt number of `currentStage`. */
  attempt?: number;
  /** On a `stages` step's own row: stage ids accepted so far, in order. */
  completedStages?: string[];
  /** On a `stages` step's own row: the stage file its body is running against. */
  currentStage?: { id: string; title: string; index: number };
  /** On a `stages` step's own row: `currentStage` ran out of retries and went to triage. */
  exhausted?: boolean;
  /**
   * On a `stages` step's own row, live only: every stage a `stages:item` has
   * named so far, by stage id. The manifest keeps only the current stage's
   * title, so this is how an earlier stage's group keeps its name while the
   * job is being watched — see run-tree.ts's stage labels.
   */
  seenStages?: Record<string, { index: number; total: number; title: string }>;
  /** On a loop's own row: how many iterations it has run so far. */
  iterations?: number;
  /**
   * On a loop's own row: the iteration budget, so the stepper can say "2 of 3".
   * Optional — a manifest written before the budget was recorded has none, and
   * the loop header simply drops the "of N" half.
   */
  maxIterations?: number;
  runner?: string;
  model?: string;
  mode?: StepMode;
  status: 'pending' | 'running' | 'done' | 'failed' | 'interrupted' | 'disabled';
  exitCode?: number;
  artifact?: string;
  verdict?: 'pass' | 'fail';
  startedAt?: string;
  endedAt?: string;
  /**
   * Summary of what a headless step is doing, folded from step:progress.
   * Mirrors the manifest's own progress field, so a step card reads the same
   * whether the run is live (events) or being reviewed later (manifest).
   */
  progress?: { turns?: number; costUsd?: number; premiumRequests?: number; lastAction?: string };
  /**
   * Which of the engine's two spawns this execution is on right now, from
   * step:spawn. Only interactive steps ever reach 'harvest' — the pass that
   * reads the session back and writes the artifact — and that is the whole
   * reason this is recorded: see lib/step-phase.ts. Cleared at step:done,
   * because a finished step is on no phase at all.
   */
  phase?: 'main' | 'harvest';
  /**
   * Set on a row the store had to guess into existence: an event for this
   * step/loop id arrived with no `currentExecution` mapping (or, failing
   * that, no prior execution of this id at all), so the row's `status` here
   * is not to be trusted — see `mergeSteps` in RunDetailPage.tsx, which
   * overlays every other live field but keeps the disk status for a row
   * marked `inferred`. Cleared by the next authoritative status event for the
   * same row (step:start, step:done, step:verdict, step:skipped, loop:start,
   * loop:done, or finalizeRunningSteps).
   */
  inferred?: boolean;
}

/** One line of a running headless step's transcript. */
export interface ActivityLine {
  stepId: string;
  text: string;
}

// executionKey is imported from packages/core/src/execution-key.ts
// (dependency-free, unlike engine/manifest.ts) and re-exported here so
// existing importers of this module (e.g. RunDetailPage.tsx) are unaffected.
export { executionKey };

export interface LogLine {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface JobState {
  jobId: string;
  /**
   * Absolute workspace path the job was started in, carried on its
   * notifications so a job from another workspace never drives this
   * workspace's window title or run rows. An *untagged* job counts as
   * belonging to no workspace: both writers (noteJobWorkspace at startRun,
   * and the notifications themselves) tag before any event can arrive, so
   * the only way to be untagged is to predate this field.
   */
  workdir?: string;
  runId?: string;
  /**
   * The run's display label, learned from run:start/run:resume. Kept on the
   * job so a notification can say "OAuth support" rather than a timestamp
   * without a round-trip to read the run's marker file.
   */
  runName?: string;
  /** Status as reported by the last runStateChanged notification seen, if any. */
  status?: JobStatus;
  /**
   * True when `status` was last set from a job summary snapshot
   * (applyJobSummaries) rather than a live runStateChanged notification. A
   * summary-sourced status can still be replaced by a fresher summary — the
   * whole point of re-fetching listJobs on reconnect is to learn a status
   * this client missed the live notification for — and so can a live
   * 'running', once a fresher summary reports the run actually ended: a job
   * never goes from terminal back to running. See applyJobSummaries.
   */
  statusFromSummary?: boolean;
  /** True once a run:done / run:error / run:cancelled whiphandEvent has been seen for this job. */
  finished: boolean;
  errorMessage?: string;
  /** Execution keys in the order they first appeared. */
  stepOrder: string[];
  /** Keyed by execution key, not step id. */
  steps: Record<string, StepState>;
  /**
   * stepId -> the execution key its later events (artifact, verdict, done)
   * belong to. Set by step:start, which is the only event carrying iteration.
   */
  currentExecution: Record<string, string>;
  /** Set while a manual/approval step is waiting on this human. */
  pendingManual?: ManualRequest;
  /**
   * Where the run is among a `stages` step's stage files, from the latest
   * `stages:item` — what the runs grid and the sidebar say instead of a raw
   * step count. Cleared by `stages:done`: once the stages step is over, the
   * run is no longer "in stage 7 of 7".
   */
  stageProgress?: { stagesId: string; index: number; total: number; title: string; attempt: number };
  /**
   * Every audit whiphandEvent this job has seen, in arrival order — the Logs
   * tab's audit spine. `step:log` is deliberately excluded (see applyWhiphandEvent):
   * this array is unbounded, and a chatty step's output would otherwise grow
   * it without limit for the life of the process.
   */
  events: WhiphandEventNotificationParams[];
  logTail: LogLine[];
  /**
   * `step:log` whiphandEvents only, as LogRow — the merged Logs tab's output
   * half. Capped like logTail, and for the same reason. Merging this with
   * `events` (mapped through core's log-rows.ts summarizeEvent) and sorting by
   * `seq` reproduces exactly what run.log holds on disk — see RunDetailPage.
   */
  logRows: LogRow[];
  /**
   * Live transcript of the step running now. Live-only by design: the run
   * manifest persists each step's summary, not its prose, so this is gone on
   * reload — which is why nothing but the feed itself depends on it. Capped
   * like logTail, and for the same reason, and cleared at every step:start so
   * it only ever shows the step running now; each line carries its own step id.
   */
  activityTail: ActivityLine[];
  /**
   * True once anything in this run has reported a line. Latched: activityTail
   * empties at every step:start, and without this the Terminal tab would fall
   * back to Logs in the gap between one step's last line and the next step's
   * first.
   */
  hasNarrated: boolean;
  ptyActive: boolean;
  ptyStepId?: string;
  ptyCols?: number;
  ptyRows?: number;
  /**
   * base64 ptyData chunks in arrival order, buffered here (not just handed
   * to a live subscriber) because TerminalPanel may not be mounted yet when
   * they arrive — AgentClientProvider's central subscription applies them
   * unconditionally, and the panel replays whatever's already here on mount
   * before continuing to track new arrivals. Reset on the next ptyStarted.
   * Capped by total size (see PTY_DATA_BUFFER_CAP_CHARS) by trimming from the
   * front — ptyDataBaseIndex/ptyDataTrimmed below record that so a panel
   * replaying this buffer (on mount, or catching up after a trim while
   * mounted) can tell which absolute chunk index buffer[0] now is, and
   * whether to show a "truncated" marker.
   */
  ptyDataBuffer: string[];
  /** Absolute index (into the untrimmed chunk sequence) that ptyDataBuffer[0] represents. Reset to 0 on the next ptyStarted. */
  ptyDataBaseIndex: number;
  /** True once ptyDataBuffer has been trimmed at least once for the current session (drives the panel's "earlier output truncated" marker). */
  ptyDataTrimmed: boolean;
  /** True once a ptyExit notification has been seen for the current PTY session. */
  ptyExited: boolean;
  ptyExitCode?: number;
  /** 'ended' when whiphand closed the session deliberately, so the UI can say so instead of reporting a meaningless exit 0. */
  ptyExitReason?: 'exit' | 'ended';
  /**
   * Set while the live interactive session is blocked on the human. Keyed by
   * step so a flag raised by an earlier step can never decorate the current one.
   * Cleared on ptyStarted and ptyExit.
   */
  awaiting?: { stepId: string; reason: AwaitReason };
}

const LOG_TAIL_CAP = 2000;
/** Same budget as logTail, and for the same reason — see JobState.logRows. */
const LOG_ROWS_CAP = LOG_TAIL_CAP;
/** The activity feed is prose and tool calls, so the same line budget suits it. */
const ACTIVITY_TAIL_CAP = LOG_TAIL_CAP;

// Cap on ptyDataBuffer's total size, approximated by summed base64 string
// length (no need to decode just to size it — base64 runs ~4/3 the size of
// the underlying bytes, so this is comfortably in the right ballpark).
// Unlike logTail's fixed line count, a byte-ish budget suits pty output
// better: chunk sizes vary wildly (a single keystroke vs. a full repaint).
const PTY_DATA_BUFFER_CAP_CHARS = 2_000_000; // ~2MB of base64 text per job

/**
 * Trims `buffer` from the front until its total size is back under the cap
 * (but never drops the newest chunk, even if that one chunk alone exceeds
 * the cap). Returns the new buffer, the new base index (advanced by however
 * many chunks were dropped), and whether anything was actually trimmed.
 */
function capPtyDataBuffer(buffer: string[], baseIndex: number): { buffer: string[]; baseIndex: number; trimmed: boolean } {
  let total = buffer.reduce((sum, chunk) => sum + chunk.length, 0);
  let start = 0;
  while (total > PTY_DATA_BUFFER_CAP_CHARS && start < buffer.length - 1) {
    total -= buffer[start].length;
    start += 1;
  }
  if (start === 0) return { buffer, baseIndex, trimmed: false };
  return { buffer: buffer.slice(start), baseIndex: baseIndex + start, trimmed: true };
}


/**
 * Splices a server-side transcript snapshot together with whatever this client
 * has already buffered from live notifications.
 *
 * Merging on ABSOLUTE indices, rather than replacing, is what makes attaching
 * mid-run a non-event: the socket starts delivering ptyData into the store the
 * moment it opens, the getJobScrollback response lands some milliseconds later
 * and is necessarily a little older, and the two windows have to be stitched
 * rather than one clobbering the other. Every chunk carries the `seq` the agent
 * assigned it, so "which absolute chunk is this" is never in doubt.
 *
 * Where the two ranges overlap, the LIVE buffer wins: it came from the same
 * stream, and preferring it keeps this function from depending on the snapshot
 * being a strict prefix.
 *
 * A gap between the ranges cannot be represented — the buffer is a flat array
 * with one base index — so the side holding the newer output is kept and the
 * result is marked trimmed, which is what draws the "earlier output truncated"
 * marker.
 */
export function mergeScrollback(
  existing: { buffer: string[]; baseIndex: number },
  snapshot: { chunks: string[]; baseIndex: number },
): { buffer: string[]; baseIndex: number; trimmed: boolean } {
  const exStart = existing.baseIndex;
  const exEnd = exStart + existing.buffer.length;
  const snStart = snapshot.baseIndex;
  const snEnd = snStart + snapshot.chunks.length;

  if (existing.buffer.length === 0) {
    return { buffer: [...snapshot.chunks], baseIndex: snStart, trimmed: snStart > 0 };
  }
  if (snapshot.chunks.length === 0) {
    return { buffer: existing.buffer, baseIndex: exStart, trimmed: exStart > 0 };
  }
  // Disjoint with a hole: keep whichever side ends later, and say so.
  if (snEnd < exStart) return { buffer: existing.buffer, baseIndex: exStart, trimmed: true };
  if (exEnd < snStart) return { buffer: [...snapshot.chunks], baseIndex: snStart, trimmed: true };

  const start = Math.min(exStart, snStart);
  const end = Math.max(exEnd, snEnd);
  const buffer: string[] = [];
  for (let i = start; i < end; i++) {
    buffer.push(
      i >= exStart && i < exEnd
        ? existing.buffer[i - exStart]!
        : snapshot.chunks[i - snStart]!,
    );
  }
  return { buffer, baseIndex: start, trimmed: start > 0 };
}

function emptyJob(jobId: string): JobState {
  return {
    jobId,
    finished: false,
    stepOrder: [],
    steps: {},
    currentExecution: {},
    events: [],
    logTail: [],
    logRows: [],
    activityTail: [],
  hasNarrated: false,
    ptyActive: false,
    ptyDataBuffer: [],
    ptyDataBaseIndex: 0,
    ptyDataTrimmed: false,
    ptyExited: false,
  };
}

/**
 * Upserts a step within a job, mirroring RunJournal's upsertStep in
 * packages/core/src/engine/manifest.ts: an event referencing a stepId never
 * seen before (e.g. the interactive on_findings loop's ptyStarted can arrive
 * for a synthetic 'triage' step with no prior step:start) creates a default
 * entry rather than throwing or being dropped.
 */
function upsertStep(
  job: JobState, stepId: string, patch: Partial<StepState>, iteration?: number, outerLoops?: LoopRef[],
  stage?: string,
): JobState {
  const key = executionKey(stepId, iteration, outerLoops, stage);
  const existing = job.steps[key];
  const step: StepState = existing
    ? { ...existing, ...patch }
    : { id: stepId, key, status: 'pending', ...patch };
  const stepOrder = existing ? job.stepOrder : [...job.stepOrder, key];
  return {
    ...job,
    stepOrder,
    steps: { ...job.steps, [key]: step },
    currentExecution: { ...job.currentExecution, [stepId]: key },
  };
}

/**
 * The execution `stepId`'s events should land on when `currentExecution` has
 * no mapping for it — the last matching key in `stepOrder`, mirroring core's
 * RunJournal.findStep ("the execution in flight, else the latest with that
 * id"). `undefined` when this id has no execution in the store at all yet, in
 * which case the caller has no choice but to guess a new one.
 */
function findLatestExecutionKey(job: JobState, stepId: string): string | undefined {
  for (let i = job.stepOrder.length - 1; i >= 0; i--) {
    const key = job.stepOrder[i];
    if (job.steps[key]?.id === stepId) return key;
  }
  return undefined;
}

/**
 * Patches whichever execution of `stepId` is currently in flight. Events after
 * step:start carry no iteration, so the mapping step:start recorded is the
 * only thing that knows which row they belong to.
 */
/**
 * Splits one progress report two ways: prose and tool calls go to the live
 * feed, counters and the last action onto the step's summary. Kept in lockstep
 * with RunJournal.foldProgress — prose is never a last action there either, so
 * a step that only talked shows no summary in the app or in the manifest.
 */
function applyProgress(job: JobState, stepId: string, progress: StepProgress): JobState {
  if (progress.kind === 'usage') {
    const key = job.currentExecution[stepId];
    const current = key === undefined ? undefined : job.steps[key]?.progress;
    return patchCurrent(job, stepId, { progress: mergeUsage(current ?? {}, progress) });
  }

  const text = progress.kind === 'tool' ? progressActionText(progress) : progress.text;
  const activityTail = [...job.activityTail, { stepId, text }];
  if (activityTail.length > ACTIVITY_TAIL_CAP) {
    activityTail.splice(0, activityTail.length - ACTIVITY_TAIL_CAP);
  }
  const withFeed = { ...job, activityTail, hasNarrated: true };
  if (progress.kind === 'text') return withFeed;

  const key = withFeed.currentExecution[stepId];
  const current = key === undefined ? undefined : withFeed.steps[key]?.progress;
  return patchCurrent(withFeed, stepId, { progress: { ...current, lastAction: text } });
}

/**
 * A step/loop id with no `currentExecution` mapping — this client never saw
 * (or has forgotten) that execution's own start event, most often because it
 * connected mid-step. Routes to the latest execution the store already knows
 * about instead of always guessing iteration 1 (F1), and marks whichever row
 * it lands on `inferred` (F2) so a merge downstream knows not to trust its
 * status over the disk's.
 */
function patchCurrent(job: JobState, stepId: string, patch: Partial<StepState>): JobState {
  const key = job.currentExecution[stepId];
  if (key !== undefined && job.steps[key] !== undefined) {
    return { ...job, steps: { ...job.steps, [key]: { ...job.steps[key], ...patch } } };
  }
  const fallbackKey = findLatestExecutionKey(job, stepId);
  if (fallbackKey === undefined) return upsertStep(job, stepId, { ...patch, inferred: true });
  return {
    ...job,
    steps: { ...job.steps, [fallbackKey]: { ...job.steps[fallbackKey], ...patch, inferred: true } },
    currentExecution: { ...job.currentExecution, [stepId]: fallbackKey },
  };
}

/**
 * Once the run is over no step can still be in flight. Without this a
 * cancelled or errored run leaves its last step spinning forever. Kept in
 * lockstep with RunJournal.finalizeRunningSteps in
 * packages/core/src/engine/manifest.ts, which does the same to run.json.
 */
function finalizeRunningSteps(job: JobState, ts: string, failedStepId?: string): JobState {
  // The blamed step failed outright, even when its own step:done already
  // reported a clean exit — a step's tail runs after its child exits, so
  // 'done' means "the process exited 0", not "the step succeeded". Same rule
  // as core, so the live view and the reloaded manifest agree.
  //
  // Deliberately not patchCurrent: that falls back to upsertStep when the key
  // is missing, inventing a phantom row for a run:error blaming a step that
  // never started.
  const blamedKey = failedStepId === undefined ? undefined : job.currentExecution[failedStepId];
  let steps = job.steps;
  if (blamedKey !== undefined && steps[blamedKey] !== undefined && steps[blamedKey].status !== 'failed') {
    steps = {
      ...steps,
      [blamedKey]: {
        ...steps[blamedKey],
        status: 'failed',
        endedAt: steps[blamedKey].endedAt ?? ts,
        inferred: undefined,
      },
    };
  }
  const stuck = job.stepOrder.filter(key => steps[key]?.status === 'running' && key !== blamedKey);
  if (stuck.length === 0) return steps === job.steps ? job : { ...job, steps };
  const next = { ...steps };
  for (const key of stuck) next[key] = { ...next[key], status: 'interrupted', endedAt: ts, inferred: undefined };
  return { ...job, steps: next };
}

/**
 * Reduces one whiphandEvent notification into the next JobState. Pure and
 * exported so applyEventReplay (see applyScrollbackSnapshot) can fold a whole
 * buffered stream through it without going through zustand's `set` once per
 * event — `applyWhiphandEvent` below is a thin wrapper over the same function.
 */
export function reduceJobEvent(job: JobState, params: WhiphandEventNotificationParams): JobState {
  const { event } = params;

  // The real agent includes runId on every whiphandEvent notification once the
  // run has one (not only on run:start) — pick it up from wherever it
  // first appears rather than requiring a run:start event specifically.
  // A resumed run emits run:resume instead of run:start, and carries the id
  // it is continuing — so it is just as good a place to learn the runId from.
  const runId = params.runId
    ?? (event.type === 'run:start' || event.type === 'run:resume' ? event.runId : undefined);
  if (runId && job.runId !== runId) job = { ...job, runId };
  // Only run:start/run:resume carry it, and a run is named before its first
  // step — so this lands before anything a notification could report on.
  if ((event.type === 'run:start' || event.type === 'run:resume')
    && event.name !== undefined && job.runName !== event.name) {
    job = { ...job, runName: event.name };
  }
  if (params.workdir && job.workdir !== params.workdir) job = { ...job, workdir: params.workdir };

  switch (event.type) {
    case 'run:start':
    case 'run:resume':
      break;
    case 'step:skipped':
      // Reused from an earlier attempt: it *is* done, it just did not run
      // again. Leaving it pending would misreport the run as further behind
      // than it is.
      job = upsertStep(job, event.stepId, {
        loopId: event.loopId,
        iteration: event.iteration,
        outerLoops: event.outerLoops,
        stage: event.stage,
        status: 'done',
        inferred: undefined,
      }, event.iteration, event.outerLoops, event.stage);
      break;
    case 'step:start':
      // A new step gets a clean feed: the tab narrates the step running now,
      // so lines from the step that just ended must not linger under it.
      // hasNarrated deliberately survives — see its declaration.
      job = { ...job, activityTail: [] };
      job = upsertStep(job, event.stepId, {
        kind: event.kind,
        loopId: event.loopId,
        iteration: event.iteration,
        outerLoops: event.outerLoops,
        stage: event.stage,
        runner: event.runner,
        model: event.model,
        mode: event.mode,
        status: 'running',
        startedAt: params.ts,
        endedAt: undefined,
        exitCode: undefined,
        artifact: undefined,
        verdict: undefined,
        phase: undefined,
        inferred: undefined,
      }, event.iteration, event.outerLoops, event.stage);
      break;
    case 'step:spawn':
      job = patchCurrent(job, event.stepId, { phase: event.phase });
      break;
    case 'step:artifact':
      job = patchCurrent(job, event.stepId, { artifact: event.path });
      break;
    case 'step:progress':
      job = applyProgress(job, event.stepId, event.progress);
      break;
    case 'step:verdict':
      // Kept in lockstep with RunJournal.record: a verdict only reaches here
      // from a step that completed, so a `verdict: true` command exiting
      // non-zero reads as done-with-a-FAIL rather than as a broken step.
      job = patchCurrent(job, event.stepId, { verdict: event.verdict, status: 'done', inferred: undefined });
      break;
    case 'step:done':
      job = patchCurrent(job, event.stepId, {
        status: event.exitCode === 0 ? 'done' : 'failed',
        exitCode: event.exitCode,
        endedAt: params.ts,
        phase: undefined,
        inferred: undefined,
      });
      break;
    case 'step:manual':
    case 'step:manual-resolved':
      // Informational here: the answerable channel is the manualRequest /
      // manualResolved notification pair, which also reports a question torn
      // down by cancellation — something no whiphandEvent ever describes.
      break;
    case 'loop:start':
      // Identified the same way a leaf step's row is: by its id plus which
      // round of *its* enclosing loop this is — so a round of an outer loop
      // gets a fresh row for the inner loop rather than reusing the previous
      // round's, once that one is already 'done'. See core's manifest.ts.
      // Inside a stages body the parent is a stage frame, and `parentStage`
      // is what keeps stage 2's loop row off stage 1's.
      job = upsertStep(job, event.loopId, {
        kind: 'loop', status: 'running', startedAt: params.ts, iterations: 0,
        maxIterations: event.maxIterations, endedAt: undefined, verdict: undefined,
        loopId: event.parentLoopId, iteration: event.parentIteration, outerLoops: event.outerLoops,
        stage: event.parentStage, inferred: undefined,
      }, event.parentIteration, event.outerLoops, event.parentStage);
      break;
    case 'loop:iteration':
      job = patchCurrent(job, event.loopId, {
        iterations: event.iteration, maxIterations: event.maxIterations,
      });
      break;
    case 'loop:done':
      job = patchCurrent(job, event.loopId, {
        status: event.passed ? 'done' : 'failed',
        iterations: event.iterations,
        verdict: event.passed ? 'pass' : 'fail',
        endedAt: params.ts,
        inferred: undefined,
      });
      break;
    // Kept in lockstep with RunJournal.record's stages cases. A stages step
    // never nests inside a loop (schema.ts refuses it), so its own row is
    // always keyed by its bare id.
    case 'stages:start':
      // No `completedStages` here: a resumed run's job starts empty while its
      // manifest row already lists what earlier attempts accepted, and
      // RunDetailPage's mergeSteps unions the two rather than letting either win.
      job = upsertStep(job, event.id, {
        kind: 'stages', status: 'running', startedAt: params.ts, endedAt: undefined, total: event.total,
        inferred: undefined,
      });
      break;
    case 'stages:item': {
      const key = job.currentExecution[event.id] ?? findLatestExecutionKey(job, event.id);
      const seen = key === undefined ? undefined : job.steps[key]?.seenStages;
      job = patchCurrent(job, event.id, {
        currentStage: { id: event.stageId, title: event.title, index: event.index },
        attempt: event.attempt, total: event.total,
        seenStages: { ...seen, [event.stageId]: { index: event.index, total: event.total, title: event.title } },
      });
      job = {
        ...job,
        stageProgress: {
          stagesId: event.id, index: event.index, total: event.total, title: event.title, attempt: event.attempt,
        },
      };
      break;
    }
    case 'stages:accepted': {
      const key = job.currentExecution[event.id] ?? findLatestExecutionKey(job, event.id);
      const row = key === undefined ? undefined : job.steps[key];
      if (key === undefined || row === undefined) break;
      const accepted = row.completedStages ?? [];
      const next: StepState = {
        ...row,
        ...(accepted.includes(event.stageId) ? {} : { completedStages: [...accepted, event.stageId] }),
        // The stage that went to triage has now been accepted — nothing is
        // exhausted any more. Set explicitly, so the overlay onto the manifest
        // row clears the disk's copy too until the next poll agrees.
        ...(row.currentStage?.id === event.stageId ? { exhausted: undefined } : {}),
      };
      job = { ...job, steps: { ...job.steps, [key]: next } };
      break;
    }
    case 'stages:exhausted':
      job = patchCurrent(job, event.id, { exhausted: true });
      break;
    case 'stages:done':
      job = patchCurrent(job, event.id, {
        status: 'done', completed: event.completed, endedAt: params.ts, inferred: undefined,
      });
      if (job.stageProgress?.stagesId === event.id) job = { ...job, stageProgress: undefined };
      break;
    case 'guard:warning':
      break;
    case 'step:log': {
      const rows = [...job.logRows, {
        seq: params.seq ?? 0, ts: params.ts, ...summarizeEvent(event),
      }];
      if (rows.length > LOG_ROWS_CAP) rows.splice(0, rows.length - LOG_ROWS_CAP);
      job = { ...job, logRows: rows };
      break;
    }
    case 'step:artifact-missing':
    case 'step:timeout':
    case 'step:retry':
    case 'session:await':
    case 'session:ended':
    case 'step:pty-exit':
    case 'run:env':
    case 'step:tree-delta':
      break; // no per-field state to fold; the Logs tab reads these straight out of `events`
    // A run that is over is not waiting on anybody — drop the card in each
    // terminal case rather than inside finalizeRunningSteps, which returns
    // early when no step is in flight. Mirrors RunJournal.record in core.
    case 'run:done':
      job = finalizeRunningSteps({ ...job, finished: true, pendingManual: undefined }, params.ts);
      break;
    case 'run:error':
      // The blamed step failed outright; anything else still in flight was
      // merely cut short.
      job = finalizeRunningSteps(
        { ...job, finished: true, pendingManual: undefined, errorMessage: event.message },
        params.ts, event.stepId);
      break;
    case 'run:cancelled':
      job = finalizeRunningSteps({ ...job, finished: true, pendingManual: undefined }, params.ts);
      break;
  }

  // step:log already landed in logRows above; keeping it out of this
  // unbounded array is what keeps a chatty step's output from growing it
  // forever — see JobState.events.
  if (event.type !== 'step:log') job = { ...job, events: [...job.events, params] };
  return job;
}

export interface AppState {
  workspacePath: string | null;
  setWorkspacePath: (path: string | null) => void;
  /**
   * Path a workspace switch is waiting to move to while the unsaved-edits
   * guard is up. Only here so App knows to mount the dialog; the promise it
   * settles lives in lib/workspace-switch.ts.
   */
  pendingWorkspaceSwitch: string | null;
  setPendingWorkspaceSwitch: (path: string | null) => void;

  agentStatus: ConnectionStatus;
  setAgentStatus: (status: ConnectionStatus) => void;

  workflows: ListWorkflowsResult;
  setWorkflows: (workflows: ListWorkflowsResult) => void;

  runs: RunSummary[];
  setRuns: (runs: RunSummary[]) => void;

  doctorResult: DoctorResult | null;
  setDoctorResult: (result: DoctorResult | null) => void;

  /**
   * Beside `doctorResult`, and for the same reason: `listModels` takes no
   * workdir either (see the RPC's doc comment), so this is a machine/account
   * fact, not a workspace one, and it survives a workspace switch exactly as
   * `doctorResult` does. Fetched once by use-harness-catalog.ts on the
   * workflow editor's first mount.
   */
  modelCatalog: ListModelsResult | null;
  setModelCatalog: (result: ListModelsResult | null) => void;

  config: ConfigGetResult | null;
  setConfig: (config: ConfigGetResult | null) => void;

  jobs: Record<string, JobState>;
  /**
   * Tags a job with the workspace it was started in, at startRun, before any
   * notification for it can arrive. The notifications carry the same workdir;
   * this just closes the window between the two.
   */
  noteJobWorkspace: (jobId: string, workdir: string) => void;
  /**
   * Renaming a run writes a marker file, so nothing on the wire tells a live
   * job its label changed — `run:start` already went out with the old one.
   * The rename dialog calls this so the cached copy follows, including the
   * `undefined` that clearing a name produces: without it the stale name wins
   * the `manifest?.name ?? job?.runName` fallback forever.
   */
  setJobRunName: (jobId: string, runName: string | undefined) => void;
  applyWhiphandEvent: (params: WhiphandEventNotificationParams) => void;
  applyRunStateChanged: (params: RunStateChangedParams) => void;
  applyStepLog: (params: StepLogParams) => void;
  applyPtyStarted: (params: PtyStartedParams) => void;
  applyPtyData: (params: PtyDataParams) => void;
  applyPtyExit: (params: PtyExitParams) => void;
  applyPtyAwait: (params: PtyAwaitParams) => void;
  applyManualRequest: (params: ManualRequestParams) => void;
  applyManualResolved: (params: ManualResolvedParams) => void;

  /**
   * Seeds a job from the agent's server-side transcript. Used when a client
   * attaches to a run that started before it connected — the desktop after a
   * webview reload, or a browser opened mid-run.
   */
  applyScrollbackSnapshot: (jobId: string, snapshot: JobScrollbackResult) => void;
  /**
   * Replays the agent's buffered whiphandEvent stream for a job (from
   * getJobScrollback's `events`, when the agent is new enough to send them)
   * into this client's own step/loop state. Fixes a client that attached
   * mid-step: without this, the first live event it sees for a step has no
   * `currentExecution` mapping to route by, because it never saw that step's
   * own step:start — see patchCurrent's fallback for what happens then.
   */
  applyEventReplay: (jobId: string, events: WhiphandEventNotificationParams[]) => void;
  /** Seeds jobs a client could not otherwise know about (see listJobs). */
  applyJobSummaries: (summaries: JobSummary[]) => void;

  /**
   * Last known state of the remote-access channel, or null before the first
   * remoteAccessGet. Lives in the store rather than in RemoteAccessCard's own
   * state so the sidebar indicator can show that this machine is listening
   * from anywhere in the app. Never carries the token — the notification that
   * feeds it deliberately omits it.
   */
  remoteAccess: RemoteAccessChangedParams | null;
  applyRemoteAccessChanged: (params: RemoteAccessChangedParams) => void;

  appState: AppStateData | null;
  setAppState: (state: AppStateData | null) => void;
  patchAppState: (patch: Partial<AppStateData>) => void;
  restoreDone: boolean;
  setRestoreDone: () => void;
  page: string;
  setPage: (page: string) => void;
  rememberInputsLocal: (workspace: string, workflow: string, inputs: Record<string, string>) => void;

  /**
   * Set by RunDetailPage's "Run again" button, consumed by NewRunPage on
   * mount to pre-select the workflow and override its inputs — cleared once applied.
   */
  pendingRunAgain: { workflow: string; inputs: Record<string, string> } | null;
  setPendingRunAgain: (v: { workflow: string; inputs: Record<string, string> } | null) => void;

  /**
   * True while the Files page holds an unsaved draft. It lives here rather
   * than in FilesPage because leaving the Files tab unmounts that page —
   * App.tsx has to be able to see the draft before it destroys it, and this
   * store is how every other cross-page concern is carried. FilesPage owns
   * the flag: it sets it from FilePreview's dirty reports and clears it on
   * unmount, so an unmount mid-edit can never leave it stuck true and wedge
   * tab switching for the rest of the session.
   */
  filesDirty: boolean;
  setFilesDirty: (value: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  workspacePath: null,
  pendingWorkspaceSwitch: null,
  setPendingWorkspaceSwitch: path => set({ pendingWorkspaceSwitch: path }),
  setWorkspacePath: path => set(state => {
    // openWorkspace re-adopts the agent's canonical path even when reopening
    // the workspace already open (a Welcome card, an Activity row in this
    // workspace) — without this, every such click would blank the page and
    // refetch for nothing.
    if (state.workspacePath === path) return {};
    // Clear rather than key by workspace: every consumer already refetches on
    // a workspacePath change, so keying would only retain every visited
    // workspace's data forever while keeping stale-but-plausible rows on
    // screen — the exact failure this is fixing. `doctorResult` and
    // `modelCatalog` survive (neither RPC takes a workdir), and so do `jobs`
    // (cross-workspace awareness needs them) and `filesDirty` (the guard has
    // to run *before* the switch; clearing it here would silently bypass it).
    return {
      workspacePath: path,
      runs: [],
      workflows: [],
      config: null,
      pendingRunAgain: null,
    };
  }),

  agentStatus: 'connecting',
  setAgentStatus: status => set({ agentStatus: status }),

  workflows: [],
  setWorkflows: workflows => set({ workflows }),

  runs: [],
  setRuns: runs => set({ runs }),

  doctorResult: null,
  setDoctorResult: doctorResult => set({ doctorResult }),

  modelCatalog: null,
  setModelCatalog: modelCatalog => set({ modelCatalog }),

  config: null,
  setConfig: config => set({ config }),

  jobs: {},

  noteJobWorkspace: (jobId, workdir) => set(state => {
    const job = state.jobs[jobId] ?? emptyJob(jobId);
    if (job.workdir === workdir) return {};
    return { jobs: { ...state.jobs, [jobId]: { ...job, workdir } } };
  }),

  setJobRunName: (jobId, runName) => set(state => {
    const job = state.jobs[jobId] ?? emptyJob(jobId);
    if (job.runName === runName) return {};
    const next = { ...job };
    if (runName === undefined) delete next.runName;
    else next.runName = runName;
    return { jobs: { ...state.jobs, [jobId]: next } };
  }),

  applyWhiphandEvent: params => set(state => {
    const job = state.jobs[params.jobId] ?? emptyJob(params.jobId);
    return { jobs: { ...state.jobs, [params.jobId]: reduceJobEvent(job, params) } };
  }),

  applyRunStateChanged: params => set(state => {
    const job = state.jobs[params.jobId] ?? emptyJob(params.jobId);
    const updatedJob: JobState = {
      ...job,
      status: params.status,
      statusFromSummary: false,
      runId: params.runId ?? job.runId,
      workdir: params.workdir ?? job.workdir,
    };
    // Run ids are a timestamp plus two random bytes, so two workspaces can
    // collide within the same second. Only patch the visible run list when
    // the notification is for the workspace it belongs to.
    const forThisWorkspace = params.workdir === undefined || params.workdir === state.workspacePath;
    const runs = params.runId && forThisWorkspace
      ? state.runs.map(r => (r.runId === params.runId ? { ...r, status: params.status } : r))
      : state.runs;
    return { jobs: { ...state.jobs, [params.jobId]: updatedJob }, runs };
  }),

  applyManualRequest: params => set(state => {
    const job = state.jobs[params.jobId] ?? emptyJob(params.jobId);
    return {
      jobs: {
        ...state.jobs,
        [params.jobId]: {
          ...job,
          runId: params.runId ?? job.runId,
          pendingManual: params.request,
        },
      },
    };
  }),

  applyManualResolved: params => set(state => {
    const job = state.jobs[params.jobId];
    // Keyed by step so a late resolve for an earlier step cannot dismiss the
    // card the human is looking at now.
    if (!job || job.pendingManual?.stepId !== params.stepId) return {};
    return { jobs: { ...state.jobs, [params.jobId]: { ...job, pendingManual: undefined } } };
  }),

  applyStepLog: params => set(state => {
    const job = state.jobs[params.jobId] ?? emptyJob(params.jobId);
    const logTail = [...job.logTail, { stream: params.stream, line: params.line }];
    if (logTail.length > LOG_TAIL_CAP) logTail.splice(0, logTail.length - LOG_TAIL_CAP);
    return { jobs: { ...state.jobs, [params.jobId]: { ...job, logTail } } };
  }),

  applyPtyStarted: params => set(state => {
    const job = state.jobs[params.jobId] ?? emptyJob(params.jobId);
    return {
      jobs: {
        ...state.jobs,
        [params.jobId]: {
          ...job,
          ptyActive: true,
          ptyStepId: params.stepId,
          ptyCols: params.cols,
          ptyRows: params.rows,
          // Fresh session: whatever a prior session buffered/reported no longer applies.
          ptyDataBuffer: [],
          ptyDataBaseIndex: 0,
          ptyDataTrimmed: false,
          ptyExited: false,
          ptyExitCode: undefined,
          ptyExitReason: undefined,
          awaiting: undefined,
        },
      },
    };
  }),

  applyPtyData: params => set(state => {
    const job = state.jobs[params.jobId] ?? emptyJob(params.jobId);
    // A non-zero seq on the FIRST chunk we ever see means output was produced
    // before this client was listening — an attach partway through a run.
    // Filing it at index 0 would misalign every later replay, so the buffer
    // starts at the chunk's real absolute position and says it is incomplete.
    const joiningLate = job.ptyDataBuffer.length === 0
      && typeof params.seq === 'number' && params.seq > 0;
    const startIndex = joiningLate ? params.seq! : job.ptyDataBaseIndex;
    const { buffer, baseIndex, trimmed } = capPtyDataBuffer([...job.ptyDataBuffer, params.data], startIndex);
    return {
      jobs: {
        ...state.jobs,
        [params.jobId]: {
          ...job,
          ptyDataBuffer: buffer,
          ptyDataBaseIndex: baseIndex,
          ptyDataTrimmed: job.ptyDataTrimmed || trimmed || joiningLate,
        },
      },
    };
  }),

  applyPtyAwait: params => set(state => {
    const job = state.jobs[params.jobId] ?? emptyJob(params.jobId);
    return {
      jobs: {
        ...state.jobs,
        [params.jobId]: {
          ...job,
          awaiting: params.awaiting && params.reason
            ? { stepId: params.stepId, reason: params.reason }
            : undefined,
        },
      },
    };
  }),

  applyPtyExit: params => set(state => {
    const job = state.jobs[params.jobId] ?? emptyJob(params.jobId);
    return {
      jobs: {
        ...state.jobs,
        [params.jobId]: {
          ...job,
          ptyActive: false,
          ptyExited: true,
          ptyExitCode: params.exitCode,
          ptyExitReason: params.reason,
          awaiting: undefined,
        },
      },
    };
  }),

  applyScrollbackSnapshot: (jobId, snapshot) => set(state => {
    const job = state.jobs[jobId] ?? emptyJob(jobId);
    const next: JobState = { ...job };

    if (snapshot.pty) {
      const merged = mergeScrollback(
        { buffer: job.ptyDataBuffer, baseIndex: job.ptyDataBaseIndex },
        { chunks: snapshot.pty.chunks, baseIndex: snapshot.pty.baseIndex },
      );
      next.ptyDataBuffer = merged.buffer;
      next.ptyDataBaseIndex = merged.baseIndex;
      next.ptyDataTrimmed = merged.trimmed;
      next.ptyStepId = job.ptyStepId ?? snapshot.pty.stepId;
      next.ptyCols = job.ptyCols ?? snapshot.pty.cols;
      next.ptyRows = job.ptyRows ?? snapshot.pty.rows;
      // Live notifications are always more current than a snapshot, so an
      // exit already seen here is never un-set by one that predates it.
      if (!job.ptyExited && snapshot.pty.exited) {
        next.ptyExited = true;
        next.ptyExitCode = snapshot.pty.exitCode;
        next.ptyExitReason = snapshot.pty.exitReason;
        next.ptyActive = false;
      } else if (!snapshot.pty.exited && !job.ptyExited) {
        next.ptyActive = true;
        next.awaiting = job.awaiting ?? snapshot.pty.awaiting;
      }
    }

    // Log lines carry no base index in this store, so there is nothing to
    // splice them on; seeding only an empty tail keeps live output — which is
    // strictly newer — from being duplicated or reordered.
    if (job.logTail.length === 0 && snapshot.logs.lines.length > 0) {
      next.logTail = snapshot.logs.lines.slice(-LOG_TAIL_CAP);
    }

    return { jobs: { ...state.jobs, [jobId]: next } };
  }),

  applyEventReplay: (jobId, events) => set(state => {
    const current = state.jobs[jobId] ?? emptyJob(jobId);

    // Fold from a blank slate that keeps identity and every pty/log/events/
    // logRows field as they are — reduceJobEvent reads some of these
    // (activityTail, currentExecution) but the fold's own copies of
    // `events`/`logRows` are discarded below (F8), never written back.
    let fold: JobState = {
      ...emptyJob(jobId),
      workdir: current.workdir, runId: current.runId, runName: current.runName,
      events: current.events, logTail: current.logTail, logRows: current.logRows,
      ptyActive: current.ptyActive, ptyStepId: current.ptyStepId,
      ptyCols: current.ptyCols, ptyRows: current.ptyRows,
      ptyDataBuffer: current.ptyDataBuffer, ptyDataBaseIndex: current.ptyDataBaseIndex,
      ptyDataTrimmed: current.ptyDataTrimmed, ptyExited: current.ptyExited,
      ptyExitCode: current.ptyExitCode, ptyExitReason: current.ptyExitReason,
      awaiting: current.awaiting,
    };
    for (const event of events) fold = reduceJobEvent(fold, event);

    // Idempotent on repeated reconnects: a live event this job already
    // processed with a seq past the end of what was just replayed (the same
    // attempt raced ahead of the getJobScrollback round trip) would otherwise
    // be lost — the fold above started from a blank slate and knows nothing
    // about it. Re-running it on top of the fold brings the result current
    // again without ever touching `current.events` itself.
    //
    // The bound must come from the last *seq'd* replayed event, not simply
    // `events.at(-1)`: a handler-direct run:error (see scrollback.ts's
    // mergeBySeq) has no seq and can legitimately be the last thing replayed
    // (runJobInBackground's catch sends it after the journal's own, seq'd
    // run:error/run:done). Using `events.at(-1)?.seq` there reads as
    // "nothing was replayed" and re-applies every live event this job ever
    // held — including the step:start the replay itself just finalized past —
    // right back on top of the fold.
    const lastReplayedSeq = events.findLast(e => e.seq !== undefined)?.seq;
    // A seq-less live event (a handler-direct run:error or guard:warning) can
    // never be proven to fall after lastReplayedSeq numerically, so it is
    // kept unless the replay already contains an equivalent one (same event
    // type and ts) — that would mean this exact event is what the replay
    // itself just folded in, and re-applying it a second time is what caused
    // the bug above for a run:error specifically.
    const replayedSeqless = new Set(
      events.filter(e => e.seq === undefined).map(e => `${e.event.type}:${e.ts}`),
    );
    const racedAhead = current.events.filter(e => (
      e.seq !== undefined
        ? lastReplayedSeq === undefined || e.seq > lastReplayedSeq
        : !replayedSeqless.has(`${e.event.type}:${e.ts}`)
    ));
    for (const event of racedAhead) fold = reduceJobEvent(fold, event);

    const next: JobState = {
      ...current,
      steps: fold.steps,
      stepOrder: fold.stepOrder,
      currentExecution: fold.currentExecution,
      finished: fold.finished,
      errorMessage: fold.errorMessage,
      activityTail: fold.activityTail,
      hasNarrated: current.hasNarrated || fold.hasNarrated,
      // Only cleared when the fold says the run actually ended — reduceJobEvent
      // never sets pendingManual itself either way, so this is the one field
      // the fold can only ever clear, never (re)populate.
      pendingManual: fold.finished ? undefined : current.pendingManual,
    };
    return { jobs: { ...state.jobs, [jobId]: next } };
  }),

  applyJobSummaries: summaries => set(state => {
    const jobs = { ...state.jobs };
    for (const summary of summaries) {
      const job = jobs[summary.jobId] ?? emptyJob(summary.jobId);
      // A live status is normally never overwritten: applyRunStateChanged (a
      // live runStateChanged notification) already knows more than this
      // snapshot can — see JobState.status. But a live 'running' is exactly
      // as stale as a summary-set one once a disconnect gap crosses the run's
      // actual end: frontend.ts only ever sends a live runStateChanged with
      // status 'running' (at run:start), so a client that watched the run
      // start live and then went dark for the rest of it is stuck exactly
      // like one that only ever saw 'running' from a summary. A job never
      // goes from a terminal status back to 'running' — a resume is a new
      // job — so once a fresher summary reports the run actually ended, it
      // must be able to replace a stale live 'running' too, not only one an
      // earlier summary itself set.
      const staleLiveRunning = job.status === 'running' && summary.status !== 'running';
      const statusIsLive = job.status !== undefined && !job.statusFromSummary && !staleLiveRunning;
      jobs[summary.jobId] = {
        ...job,
        finished: summary.status !== 'running',
        status: statusIsLive ? job.status : summary.status,
        statusFromSummary: statusIsLive ? job.statusFromSummary : true,
        runId: job.runId ?? summary.runId,
        runName: job.runName ?? summary.name,
        ptyActive: job.ptyActive || summary.pty !== null,
        ptyStepId: job.ptyStepId ?? summary.pty?.stepId,
        ptyCols: job.ptyCols ?? summary.pty?.cols,
        ptyRows: job.ptyRows ?? summary.pty?.rows,
        pendingManual: job.pendingManual ?? summary.pendingManual,
      };
    }
    return { jobs };
  }),

  remoteAccess: null,
  applyRemoteAccessChanged: params => set({ remoteAccess: params }),

  appState: null,
  setAppState: appState => set({ appState }),
  patchAppState: patch => set(state => ({
    appState: state.appState ? { ...state.appState, ...patch } : state.appState,
  })),
  restoreDone: false,
  setRestoreDone: () => set({ restoreDone: true }),
  page: 'runs',
  setPage: page => set({ page }),
  rememberInputsLocal: (workspace, workflow, inputs) => set(state => {
    if (!state.appState) return state;
    const memory = state.appState.workspaces[workspace] ?? { lastInputs: {} };
    return {
      appState: {
        ...state.appState,
        workspaces: {
          ...state.appState.workspaces,
          [workspace]: {
            ...memory,
            lastWorkflow: workflow,
            lastInputs: { ...memory.lastInputs, [workflow]: { ...inputs } },
          },
        },
      },
    };
  }),

  pendingRunAgain: null,
  setPendingRunAgain: pendingRunAgain => set({ pendingRunAgain }),

  filesDirty: false,
  setFilesDirty: filesDirty => set({ filesDirty }),
}));

/** A job blocked on the human — an interactive session waiting for a turn, or a manual/approval step waiting for an answer. */
export function isWaitingJob(job: JobState): boolean {
  return job.awaiting !== undefined || job.pendingManual !== undefined;
}

/**
 * Jobs blocked on the human right now. A finished job's flag is stale by
 * definition — a sidecar that died mid-session never sent its ptyExit — so
 * filtering here keeps that harmless without JobState needing timestamps.
 */
export function waitingJobs(jobs: Record<string, JobState>): JobState[] {
  return Object.values(jobs).filter(job => !job.finished && isWaitingJob(job));
}

/**
 * Live jobs for the sidebar's "Ongoing runs" section: everything not yet
 * finished, waiting-on-the-human ones first. `Array.prototype.sort` is
 * stable, so within each of those two groups the order stays arrival order —
 * `Object.values`' own insertion order — rather than churning under the
 * cursor on every store update.
 */
export function ongoingJobs(jobs: Record<string, JobState>): JobState[] {
  return Object.values(jobs)
    .filter(job => !job.finished)
    .sort((a, b) => Number(isWaitingJob(b)) - Number(isWaitingJob(a)));
}

/**
 * runId -> where a live run is among its stages, for the run grids: a job
 * hears `stages:item` the moment a stage starts, well before the grid's next
 * manifest poll. Only unfinished jobs — a finished job's copy is stale, and
 * the manifest is authoritative for it. `workdir`, when given, keeps another
 * workspace's run from decorating this one's rows, as in `waitingRunIds`.
 */
export function liveStageProgress(
  jobs: Record<string, JobState>, workdir?: string,
): Map<string, { index: number; total: number }> {
  const progress = new Map<string, { index: number; total: number }>();
  for (const job of Object.values(jobs)) {
    if (job.finished || job.runId === undefined || job.stageProgress === undefined) continue;
    if (workdir !== undefined && job.workdir !== workdir) continue;
    progress.set(job.runId, { index: job.stageProgress.index, total: job.stageProgress.total });
  }
  return progress;
}

/** runIds of runs blocked on the human — the runs list renders disk rows keyed by runId. */
/** `workdir`, when given, keeps another workspace's waiting run from decorating this one's rows. */
export function waitingRunIds(jobs: Record<string, JobState>, workdir?: string): Set<string> {
  const ids = new Set<string>();
  for (const job of waitingJobs(jobs)) {
    if (workdir !== undefined && job.workdir !== workdir) continue;
    if (job.runId) ids.add(job.runId);
  }
  return ids;
}
