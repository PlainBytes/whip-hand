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
import type { ManualRequest, StepKind, StepMode, StepProgress } from '../../../../packages/core/src/types.ts';
import type { AppState as AppStateData } from '../../../../packages/agent/src/app-state.ts';
import type { LogRow } from '../lib/log-rows.ts';
import { summarizeEvent } from '../lib/log-rows.ts';

/**
 * Task 8 scope: workflows, runs list, per-job live state, doctor results,
 * config live here too — see JobState below for the per-job shape that the
 * whiphandEvent/runStateChanged/stepLog/ptyStarted/ptyExit notifications reduce
 * into. Task 7's workspace path + agent status stay as they were.
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
}

/** One line of a running headless step's transcript. */
export interface ActivityLine {
  stepId: string;
  text: string;
}

/**
 * A loop runs the same step id many times, so a step id no longer identifies a
 * row. Executions are keyed by id+iteration — the same split core's RunJournal
 * makes in packages/core/src/engine/manifest.ts, and for the same reason.
 */
export function executionKey(stepId: string, iteration?: number): string {
  return iteration === undefined || iteration === 1 ? stepId : `${stepId}#${iteration}`;
}

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
   * `events` (mapped through log-rows.ts's summarizeEvent) and sorting by
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
  job: JobState, stepId: string, patch: Partial<StepState>, iteration?: number,
): JobState {
  const key = executionKey(stepId, iteration);
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
    const next = { ...current };
    if (progress.turns !== undefined) next.turns = progress.turns;
    if (progress.costUsd !== undefined) next.costUsd = progress.costUsd;
    if (progress.premiumRequests !== undefined) next.premiumRequests = progress.premiumRequests;
    return patchCurrent(job, stepId, { progress: next });
  }

  const text = progress.kind === 'tool'
    ? `${progress.tool}${progress.target === undefined ? '' : ` ${progress.target}`}`
    : progress.text;
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

function patchCurrent(job: JobState, stepId: string, patch: Partial<StepState>): JobState {
  const key = job.currentExecution[stepId];
  if (key === undefined || job.steps[key] === undefined) return upsertStep(job, stepId, patch);
  return { ...job, steps: { ...job.steps, [key]: { ...job.steps[key], ...patch } } };
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
      },
    };
  }
  const stuck = job.stepOrder.filter(key => steps[key]?.status === 'running' && key !== blamedKey);
  if (stuck.length === 0) return steps === job.steps ? job : { ...job, steps };
  const next = { ...steps };
  for (const key of stuck) next[key] = { ...next[key], status: 'interrupted', endedAt: ts };
  return { ...job, steps: next };
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
    const { jobId, event } = params;
    let job = state.jobs[jobId] ?? emptyJob(jobId);

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
          status: 'done',
        }, event.iteration);
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
        }, event.iteration);
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
        job = patchCurrent(job, event.stepId, { verdict: event.verdict, status: 'done' });
        break;
      case 'step:done':
        job = patchCurrent(job, event.stepId, {
          status: event.exitCode === 0 ? 'done' : 'failed',
          exitCode: event.exitCode,
          endedAt: params.ts,
          phase: undefined,
        });
        break;
      case 'step:manual':
      case 'step:manual-resolved':
        // Informational here: the answerable channel is the manualRequest /
        // manualResolved notification pair, which also reports a question torn
        // down by cancellation — something no whiphandEvent ever describes.
        break;
      case 'loop:start':
        job = upsertStep(job, event.loopId, {
          kind: 'loop', status: 'running', startedAt: params.ts, iterations: 0,
          maxIterations: event.maxIterations, endedAt: undefined, verdict: undefined,
        });
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
        });
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
    return { jobs: { ...state.jobs, [jobId]: job } };
  }),

  applyRunStateChanged: params => set(state => {
    const job = state.jobs[params.jobId] ?? emptyJob(params.jobId);
    const updatedJob: JobState = {
      ...job,
      status: params.status,
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

  applyJobSummaries: summaries => set(state => {
    const jobs = { ...state.jobs };
    for (const summary of summaries) {
      const job = jobs[summary.jobId] ?? emptyJob(summary.jobId);
      jobs[summary.jobId] = {
        ...job,
        finished: summary.status !== 'running',
        runId: job.runId ?? summary.runId,
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
