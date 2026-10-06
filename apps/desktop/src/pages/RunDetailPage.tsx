import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  CounterBadge,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Menu,
  type MenuButtonProps,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  SplitButton,
  Spinner,
  Tab,
  TabList,
  Text,
  ToggleButton,
} from '@fluentui/react-components';
import {
  ArrowDown20Regular, ArrowLeft20Regular, Copy20Regular, Delete20Regular, DocumentFolder48Regular,
  LockClosed20Regular, LockOpen20Regular,
  PlayCircle20Regular, PlugDisconnected20Regular, PlugDisconnected48Regular, Prompt48Regular,
  Rename20Regular, Stop20Regular, Replay20Regular, TextBulletListSquare48Regular,
} from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useAppStore, executionKey, type JobState, type StepState } from '../state/store.ts';
import type { RunDetail as RunDetailResult } from '../agent/client.ts';
import { summarizeEvent, parseLogLine, type LogRow } from '../shared/log-rows.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { AttentionBadge } from '../components/AttentionBadge.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { AWAIT_LABEL } from '../lib/await-copy.ts';
import { TerminalPanel } from '../components/TerminalPanel.tsx';
import { RunStepper } from '../components/RunStepper.tsx';
import { PendingDecisionBar } from '../components/PendingDecisionBar.tsx';
import { DeleteRunDialog } from '../components/DeleteRunDialog.tsx';
import { ReviewOverlay } from '../review/ReviewOverlay.tsx';
import { fromManualRequest } from '../review/from-manual.ts';
import type { WorkingDiff } from '../diff/types.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { FileSystemProvider } from '../files/fs-context.tsx';
import { ArtifactFileSystem } from '../files/artifact-fs.ts';
import { joinPath, makeRootNode, type TreeNodes } from '../files/tree-model.ts';
import { FileTree } from '../components/FileTree.tsx';
import { ResizablePane } from '../components/ResizablePane.tsx';
import { FilePreview } from '../components/FilePreview.tsx';
import { RECESSED_SURFACE } from '../components/recessed-surface.ts';
import { resolveInArtifacts } from '../markdown/resolve.ts';
import { elapsedMs, formatElapsed, stageLabel } from '../shared/format.ts';
import { degradationLine } from '../shared/degradations.ts';
import { mergeDegradations } from '../lib/run-degradations.ts';
import { parsePositiveInt } from '../lib/parse-number.ts';
import { useOpenExternal } from '../lib/open-external.tsx';
import type { FileComment, ManualChoice, Scope } from '../shared/types.ts';
import { errorMessage } from '../lib/error-message.ts';
import { spacerHeights, useVirtualRows, VIRTUAL_SCROLLER_PROPS } from '../lib/use-virtual-rows.ts';

export interface RunDetailPageProps {
  /** The job whose live event stream to follow, when opened from a just-started run. */
  jobId?: string;
  /** A run selected from RunsPage — may or may not have a live job in the store. */
  runId?: string;
  onBack: () => void;
  /**
   * "Run again": re-opens New Run with this workflow pre-selected and these
   * inputs prefilled. `source` is the run's own `workflowSource` (undefined
   * for a manifest predating that field) — the caller needs it to scope the
   * ref so a global run doesn't preselect a same-named project workflow.
   */
  onRunAgain: (workflow: string, inputs: Record<string, string>, source?: Scope) => void;
  /**
   * The resume this page starts gets a job of its own, so the page has to be
   * re-pointed at it or it keeps rendering the attempt that failed. Same
   * re-targeting RunsPage does with `onStarted` for a freshly started run.
   */
  onResumed: (target: { jobId: string; runId: string }) => void;
}

/**
 * The job to follow for a run. Jobs are never evicted from the store, so after
 * a resume two of them carry the same runId — the attempt that failed and the
 * one continuing it — and taking the first match meant rendering the corpse.
 * Prefer whichever is still live: `planResume` refuses a run that is already
 * running, so at most one unfinished job per run can exist. Store order is
 * first-notification order and jobIds are random, so neither is a tiebreak.
 */
function findJobByRunId(jobs: Record<string, JobState>, runId: string): JobState | undefined {
  let finished: JobState | undefined;
  for (const job of Object.values(jobs)) {
    if (job.runId !== runId) continue;
    if (!job.finished) return job;
    finished = job;
  }
  return finished;
}

/** How often the manifest is re-read while a run is still going. */
const RUN_POLL_INTERVAL_MS = 2000;

/**
 * How often a stopped run is re-read. A resumable run can be restarted by
 * something this window never hears from — `whiphand run --resume` in a terminal, or
 * another app instance, each talking to its own agent — so the manifest is the
 * only channel that can report it. Slow, because nothing usually happens.
 */
const IDLE_POLL_INTERVAL_MS = 10_000;

/**
 * Statuses a run can be continued from. Mirrors core's own RESUMABLE set in
 * engine/resume.ts — the agent refuses anything else, so offering the button
 * more widely would only produce errors.
 */
const RESUMABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  'failed', 'interrupted', 'cancelled',
]);

/**
 * Statuses a step can no longer move on from. `disabled` belongs here too: a
 * disabled step never starts, so it must never be picked as the run's
 * "current step" fallback below.
 */
const TERMINAL_STEP_STATUSES: ReadonlySet<StepState['status']> = new Set([
  'done', 'failed', 'interrupted', 'disabled',
]);

/**
 * The manifest is seeded with the workflow's complete step list when the run
 * starts (crates/whiphand-core/src/store/journal.rs), so it — not the live job,
 * which only knows the steps it has seen events for — is the authoritative
 * ordering and the full picture of what is still to come. Overlay the live
 * job's fresher per-step state on top of it, then append anything the job
 * knows that the manifest doesn't: the interactive on_findings path invents a
 * synthetic '<id>-triage' step mid-run.
 *
 * The two used to be either/or, so a just-started run showed only the steps
 * that had already reported and a manifest-only run got no live updates at all.
 */
/** Statuses `mergeSteps`' finished-job guard treats as final on disk — never beaten by a stale live 'running'. */
const DISK_TERMINAL_STATUSES: ReadonlySet<StepState['status']> = new Set(['done', 'failed', 'interrupted']);

function mergeSteps(manifest: RunDetailResult | null, job: JobState | undefined): StepState[] {
  const raw = manifest?.steps;
  const base: Array<Omit<StepState, 'key'> & { iteration?: number }> =
    Array.isArray(raw) ? (raw as Array<Omit<StepState, 'key'> & { iteration?: number }>) : [];
  // A loop runs the same step id many times, so both sides key by execution —
  // including which round of any *enclosing* loop it ran under, once loops nest.
  const merged: StepState[] = base.map(step => {
    const key = executionKey(step.id, step.iteration, step.outerLoops, step.stage);
    const live = job?.steps[key];
    if (!live) return { ...step, key };
    // A row the store had to guess into existence (see StepState.inferred) is
    // not to be trusted for status: it either landed at the wrong execution's
    // key entirely, or is a freshly-invented row defaulted to 'pending' — both
    // would otherwise beat the disk's own, authoritative status. Every other
    // live field (progress, phase, artifact, ...) still overlays, so a
    // headless step's live activity keeps showing.
    //
    // Separately: a job the agent no longer tracks (evicted from its own
    // per-job history, or simply a stale reload) can carry a live 'running'
    // left over from a session that is long gone. Once the job itself is
    // finished, a disk row that already reached a terminal state is final —
    // the run cannot still be running that step.
    const staleFinished = job?.finished === true && DISK_TERMINAL_STATUSES.has(step.status)
      && live.status === 'running';
    const status = live.inferred === true || staleFinished ? step.status : live.status;
    // A resumed run's job only hears the stages it starts and accepts itself;
    // what earlier attempts recorded is on disk alone. Neither side is the
    // whole list, so both are merged (the live entry winning per stage).
    const completedStages = step.completedStages === undefined && live.completedStages === undefined
      ? {}
      : { completedStages: [...new Set([...(step.completedStages ?? []), ...(live.completedStages ?? [])])] };
    const startedStages = step.startedStages === undefined && live.startedStages === undefined
      ? {}
      : { startedStages: { ...step.startedStages, ...live.startedStages } };
    return { ...step, ...live, key, status, ...completedStages, ...startedStages };
  });
  const seen = new Set(merged.map(step => step.key));
  for (const key of job?.stepOrder ?? []) {
    if (!seen.has(key) && job?.steps[key]) merged.push(job.steps[key]);
  }
  return merged;
}

/**
 * The step the run is on — or, for a run that is over, the one it stopped on.
 * Returns -1 when every step reached a terminal state, which is the ordinary
 * successful case and needs no "current step" call-out.
 *
 * A running body step is preferred over its own running loop: the loop's row
 * always comes first in `steps` (it starts before its body does), so a plain
 * first-running-match would give the loop container the focus for the whole
 * time its body is actually doing the work. The loop only gets the focus
 * itself between iterations, when it is running but nothing inside it is yet.
 */
function findCurrentStepIndex(steps: StepState[]): number {
  // A `stages` step is a container exactly like a loop: its row is running
  // for the whole time a stage's body does the work.
  const runningBody = steps.findIndex(step => step.status === 'running' && step.kind !== 'loop' && step.kind !== 'stages');
  if (runningBody !== -1) return runningBody;
  const running = steps.findIndex(step => step.status === 'running');
  if (running !== -1) return running;
  const stopped = steps.findIndex(step => step.status === 'interrupted' || step.status === 'failed');
  if (stopped !== -1) return stopped;
  return steps.findIndex(step => !TERMINAL_STEP_STATUSES.has(step.status));
}

/**
 * Where a stopped run stopped among its stages, for the run-error bar:
 * `stopped at stage 3 of 7 · Add API routes after 3 rejections`. Read off the
 * stages row that is not done yet and names a current stage — a run that
 * failed *after* its stages step finished says nothing about stages.
 *
 * The rejection count is that row's `attempt`: a stage is only handed to
 * triage once every attempt it had was rejected (core's `stages:exhausted`),
 * so the attempt it reached is how many rejections there were. Without
 * `exhausted` the run stopped mid-attempt for some other reason, and has no
 * count to give.
 */
function stageStopSentence(steps: StepState[]): string | undefined {
  const stages = steps.find(step => step.kind === 'stages' && step.status !== 'done'
    && step.status !== 'disabled' && step.currentStage !== undefined);
  const current = stages?.currentStage;
  if (stages === undefined || current === undefined) return undefined;
  const at = stageLabel(current.index, stages.total ?? current.index, current.title);
  if (stages.exhausted !== true || stages.attempt === undefined) return `stopped at ${at}`;
  return `stopped at ${at} after ${stages.attempt} rejection${stages.attempt === 1 ? '' : 's'}`;
}

/**
 * The step the stepper marks as where the run is. That's the current step
 * while there is one; for a run that ended cleanly there isn't, so fall back
 * to the last step rather than leaving the whole row unmarked on the screen
 * you most often land on.
 */
function findFocusStepIndex(steps: StepState[]): number {
  const current = findCurrentStepIndex(steps);
  if (current !== -1) return current;
  return steps.length - 1;
}

type RunTab = 'terminal' | 'artifacts' | 'logs';

/** Kinds the "Errors only" chip keeps, beyond any row on the stderr stream. */
const ERROR_LOG_KINDS: ReadonlySet<string> = new Set(['run:error', 'step:timeout', 'step:artifact-missing']);

/**
 * How many of a finished run's `run.log` rows to fetch per tail read: the
 * initial "open on the end" fetch, and each subsequent "Load earlier" page.
 */
const TAIL_LOG_PAGE_SIZE = 2000;

/** Kinds whose text is real transcript content (tool calls, assistant prose), not a structured audit event. */
function isContentLogRow(row: LogRow): boolean {
  return row.stream !== undefined || row.kind.startsWith('step:progress:');
}

function plainLogLine(row: LogRow): string {
  return `${row.ts}  ${row.kind}  ${row.stepId ?? '-'}  ${row.text}`;
}

/**
 * Identity for de-duplicating a fetched row against a live one. Not `seq`
 * alone: `seq` is monotonic per `RunJournal` instance
 * (`crates/whiphand-core/src/store/journal.rs`), not per run, so a resumed attempt
 * restarts it at 1 while `run.log` keeps appending to the same file. A
 * fetched row from the attempt before the resume and a live row from the
 * attempt after it can share a `seq` while being different rows entirely —
 * comparing on `seq` alone either drops the resumed attempt's rows (too
 * strict) or would collide two unrelated rows (too loose). `ts`/`kind`/`text`
 * together make the pair unambiguous without assuming anything about how
 * `seq` behaves across a resume.
 */
function logRowKey(row: LogRow): string {
  return `${row.seq} ${row.ts} ${row.kind} ${row.text}`;
}

export function RunDetailPage({ jobId, runId, onBack, onRunAgain, onResumed }: RunDetailPageProps) {
  const client = useAgentClient();
  const workspacePath = useAppStore(state => state.workspacePath);
  const boundJob = useAppStore(state => {
    // A page opened on a just-started run is pinned to that job — but once it
    // has finished, a resume of the same run lives in a different job, and this
    // page is the one that started it. Fall through to the run so it follows.
    const pinned = jobId === undefined ? undefined : state.jobs[jobId];
    if (pinned !== undefined && !pinned.finished) return pinned;
    const forRun = runId ?? pinned?.runId;
    return (forRun === undefined ? undefined : findJobByRunId(state.jobs, forRun)) ?? pinned;
  });
  const setJobRunName = useAppStore(state => state.setJobRunName);
  const noteJobWorkspace = useAppStore(state => state.noteJobWorkspace);

  const [manifest, setManifest] = useState<RunDetailResult | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /**
   * Per-sitting reaction to one workflow's length, not a preference — so it
   * lives here and is deliberately not persisted.
   */
  const [stepsCollapsed, setStepsCollapsed] = useState(false);
  /**
   * null means "the user hasn't chosen" — which is what lets a starting
   * session pull the view to the terminal without ever overriding a
   * deliberate choice.
   */
  const [chosenTab, setChosenTab] = useState<RunTab | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [endingSession, setEndingSession] = useState(false);
  const [locking, setLocking] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [extraIterationsOpen, setExtraIterationsOpen] = useState(false);
  const [extraIterationsRaw, setExtraIterationsRaw] = useState('1');
  const [renameError, setRenameError] = useState<string | null>(null);
  /**
   * Whether the review screen is up. Auto-opened when a decision arrives (the
   * run is hard-blocked, which is the moment that deserves the screen), but a
   * deliberate close is remembered for that question — reopening on the next
   * poll would make the Back button useless.
   */
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewDismissed, setReviewDismissed] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkingDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffToken, setDiffToken] = useState(0);
  const [selectedArtifactPath, setSelectedArtifactPath] = useState<string | null>(null);
  const [artifactsExpanded, setArtifactsExpanded] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);
  const activityRef = useRef<HTMLDivElement | null>(null);
  const stepRefs = useRef<Record<string, HTMLElement | null>>({});

  /**
   * A finished job sitting over a run.json that says 'running' again is a
   * resume this window did not start and will never be notified about. Every
   * field on that job — its step states, its error, its finished flag —
   * describes the attempt that already ended, so none of it may be rendered.
   * `readRunSummary` repairs a genuinely abandoned 'running' manifest to
   * 'interrupted' before returning it, so this cannot misfire on a dead run.
   */
  const staleJob = boundJob !== undefined && boundJob.finished && manifest?.status === 'running';
  const job = staleJob ? undefined : boundJob;

  // Deliberately off `boundJob`: the run id is how this page finds anything at
  // all, and a page opened by jobId alone would lose its run when the guard
  // fires. The *job* id does follow the guard — Cancel then falls through to
  // the { workdir, runId } branch, which reaches the owning process by pid,
  // the only thing that can stop a run this window does not own.
  const effectiveJobId = staleJob ? undefined : jobId ?? job?.jobId;
  const effectiveRunId = runId ?? boundJob?.runId;
  // The manifest is authoritative once loaded; the job's copy covers the gap
  // before the first poll lands for a run started from this window.
  const runName = manifest?.name ?? job?.runName;
  const jobStatus = job?.status;
  const jobFinished = job?.finished;

  // With no live job the manifest is the only source of truth. Core repairs an
  // abandoned run to 'interrupted' when it reads it, so a run whose owner died
  // no longer reports itself as running here.
  const isRunning = job ? !job.finished : manifest?.status === 'running';

  // Only a stopped run can be continued, and only from a status core accepts.
  const canResume = !isRunning
    && typeof manifest?.status === 'string'
    && RESUMABLE_RUN_STATUSES.has(manifest.status);

  /**
   * The re-read cadence, or null for "nothing will change this". A primitive,
   * so the polling effect does not re-subscribe on every new manifest object.
   */
  const pollMs = isRunning ? RUN_POLL_INTERVAL_MS : canResume ? IDLE_POLL_INTERVAL_MS : null;

  /**
   * The clock every live duration on this page is measured against — the run's
   * own total and each running step's. One interval for the whole page rather
   * than one per pill, and it only runs while there is something to count.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  useEffect(() => {
    if (!effectiveRunId || !workspacePath) return;
    let cancelled = false;

    function load(): void {
      client
        .request('getRun', { workdir: workspacePath!, runId: effectiveRunId! })
        .then(result => {
          if (cancelled) return;
          // Deleted from the grid, or pruned, while this page was open: there
          // is nothing left to show, so fall back rather than sitting on a
          // null manifest forever.
          if (result === null) {
            onBack();
            return;
          }
          setManifest(result);
          setManifestError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setManifestError(errorMessage(err));
        });
    }

    load();
    // A run driven by another process (whiphand run in a terminal, or a previous app
    // instance) produces no notifications here, so without polling the page
    // stayed frozen at whatever it saw on first load. A run that has ended for
    // good stops it; one that is merely stopped keeps a slow beat, because it
    // can still be resumed from outside this window.
    if (pollMs === null) return () => { cancelled = true; };
    const interval = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // Also re-fetch when the live job's status/finished flips, to pick up artifacts that land as the run progresses.
  }, [client, workspacePath, effectiveRunId, jobStatus, jobFinished, pollMs, onBack]);

  useEffect(() => {
    // jsdom (vitest) doesn't implement scrollTo; auto-scroll is a real-browser-only nicety.
    const el = activityRef.current;
    if (!el || typeof el.scrollTo !== 'function') return;
    el.scrollTo({ top: el.scrollHeight });
    // The Logs tab's own scroller follows `followLogs` instead — see the
    // effect keyed on the last filtered row's identity below, which can
    // release "follow" when a human scrolls up mid-investigation; this one can't.
  }, [job?.activityTail.length]);

  const steps: StepState[] = useMemo(() => mergeSteps(manifest, job), [job, manifest]);
  const currentStepIndex = useMemo(() => findCurrentStepIndex(steps), [steps]);
  const currentStep = currentStepIndex === -1 ? undefined : steps[currentStepIndex];
  const focusStepIndex = useMemo(() => findFocusStepIndex(steps), [steps]);
  const focusStep = focusStepIndex === -1 ? undefined : steps[focusStepIndex];

  /**
   * How long the run has been going. A run still live counts against the page
   * clock; one that ended is frozen at its own span. A run that never wrote
   * endedAt — abandoned before core could repair it — is bounded by the last
   * sign of life we have, or its duration would grow on every poll forever.
   */
  const runElapsed = useMemo(() => {
    const startedAt = typeof manifest?.startedAt === 'string' ? manifest.startedAt : undefined;
    const lastSeen = [manifest?.endedAt, manifest?.heartbeatAt, manifest?.updatedAt]
      .find((v): v is string => typeof v === 'string');
    const end = isRunning || lastSeen === undefined ? now : Date.parse(lastSeen);
    const ms = elapsedMs(startedAt, end);
    return ms === null ? null : formatElapsed(ms);
  }, [manifest?.startedAt, manifest?.endedAt, manifest?.heartbeatAt, manifest?.updatedAt, isRunning, now]);

  // The run's own error, whichever side reported it. The manifest's copy was
  // never surfaced before, which is where the interrupted reason lands.
  const manifestRunError = (manifest?.error as { message?: string } | undefined)?.message;
  const runErrorMessage = job?.errorMessage ?? manifestRunError;
  // Invariant 7: what the run lost and carried on without, live and on disk.
  const degradations = useMemo(
    () => mergeDegradations(manifest?.degradations, job?.degradations), [manifest?.degradations, job?.degradations],
  );
  // Only once the run is over: a live run in triage has not stopped anywhere yet.
  const stageStop = useMemo(
    () => (isRunning ? undefined : stageStopSentence(steps)), [isRunning, steps],
  );

  useEffect(() => {
    // jsdom (vitest) doesn't implement scrollIntoView; this is a real-browser nicety.
    const el = currentStep ? stepRefs.current[currentStep.key] : null;
    if (!el || typeof el.scrollIntoView !== 'function') return;
    // Pill rows scroll sideways, so the current step may be off-screen on either axis.
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentStep?.key]);

  // Keep the terminal mounted (read-only once ptyExit lands) until the
  // step it belongs to actually completes — a step:done can lag behind
  // ptyExit by however long the harvest phase takes — then collapse it to a
  // static note so the page doesn't keep an idle terminal around forever.
  // ptyStarted reports a step *id*, but job.steps is keyed by execution — an
  // interactive step re-run inside a loop is 'plan#2' from iteration 2 on.
  // currentExecution is the mapping that exists to answer exactly this;
  // without it the lookup missed and a dead terminal stayed pinned open.
  //
  // Looked up from the MERGED `steps` (disk + live), not `job.steps` alone
  // (F4): attaching after the pty already exited, before any live step:done
  // for it, leaves `job.steps` with nothing but a guessed/absent row, while
  // the manifest on disk already knows the step finished. Falls back to the
  // latest execution of the pty's step id when even the merged view has
  // nothing at the resolved key.
  const ptyStepKey = job?.ptyStepId === undefined
    ? undefined
    : job.currentExecution[job.ptyStepId] ?? job.ptyStepId;
  const ptyStep = ptyStepKey === undefined
    ? undefined
    : steps.find(s => s.key === ptyStepKey)
      ?? [...steps].reverse().find(s => s.id === job?.ptyStepId);
  const ptyStepDone = ptyStep?.status === 'done' || ptyStep?.status === 'failed';
  const showTerminal = !!job && !!effectiveJobId && (job.ptyActive || (job.ptyExited && !ptyStepDone));
  const showSessionEndedNote = !!job && job.ptyExited && ptyStepDone;

  /**
   * Whether a headless step is running right now. A headless step talks
   * through a progress stream instead of a pty, but it is no less "the session
   * running right now", so this tab holds its feed — and keeps holding it in
   * the gap where step:start has emptied the feed and the first line has not
   * arrived, rather than dropping to "no live session".
   *
   * Found by searching the executions rather than reusing `currentStep`, which
   * is the *first* running row and inside a loop is the loop itself — a
   * container reports nothing, so deriving from it made the tab claim there was
   * no live session for every workflow whose headless steps live in a loop.
   * Command and manual steps are excluded for the same reason: they have no
   * progress stream. The interactive step is excluded because the terminal
   * speaks for it.
   */
  const hasHeadlessStep = useMemo(() => steps.some(step => (
    step.status === 'running'
    && (step.kind ?? 'agent') === 'agent'
    && step.mode !== 'interactive'
    && step.id !== job?.ptyStepId
  )), [steps, job?.ptyStepId]);
  const activityTail = job?.activityTail ?? [];

  // Keyed on ptyStepId, not on the live ptyActive flag: once a session has
  // existed the terminal stays the sensible landing tab, and the view doesn't
  // jump back to Logs the moment the pty exits. A headless step that has
  // started reporting pulls the view the same way, for the same reason — and
  // like the pty it never overrides a tab the user picked.
  const hadSession = job?.ptyStepId !== undefined;
  // hasNarrated, not the feed's length: the feed empties at every step:start,
  // and the view must not bounce back to Logs in the gap that leaves.
  const hasLiveOutput = hadSession || job?.hasNarrated === true;
  const activeTab: RunTab = chosenTab ?? (hasLiveOutput ? 'terminal' : 'logs');

  // ---------------------------------------------------------------------
  // Logs tab: one merged, seq-ordered feed of the run's audit trail and its
  // output, from whichever source this page actually has. A job this window
  // started or is still watching already carries everything live; a run
  // opened cold (no job — reopened later, or started from a terminal) reads
  // the same rows back from run.log through readRunLog. Same LogRow shape
  // either way, so the rendering below never has to know which source it got.
  // ---------------------------------------------------------------------
  const auditLogRows: LogRow[] = useMemo(
    () => (job?.events ?? []).map(p => ({ seq: p.seq ?? 0, ts: p.ts, ...summarizeEvent(p.event) })),
    [job?.events],
  );
  const liveLogRows: LogRow[] = useMemo(() => {
    const merged = [...auditLogRows, ...(job?.logRows ?? [])];
    merged.sort((a, b) => a.seq - b.seq);
    return merged;
  }, [auditLogRows, job?.logRows]);

  // A job this window actually watched live carries rows, richer than a
  // re-read of the file could be (it has the manifest-independent audit trail
  // as it happened). But `listJobs` on every reconnect (use-job-attach.ts) and
  // applyJobSummaries seed an *empty* JobState for every job the agent still
  // has registered — finished jobs are never evicted from its map — so a job
  // object existing is not proof this page holds its rows. Gate on rows
  // actually being present instead; the read path covers a run this window
  // never watched, whether or not a (rowless) job entry exists for it.
  const jobHasLiveRows = job !== undefined && ((job.events?.length ?? 0) > 0 || (job.logRows?.length ?? 0) > 0);
  // Read only at the moment the fetch effect actually fires, not as a reactive
  // dependency: a reconnect to a *running* run starts with jobHasLiveRows
  // false (triggering the fetch below) and can flip true mid-flight the
  // instant the run's next event arrives. If that flip were a dependency, the
  // effect would tear down and cancel its own in-flight request, so the fetch
  // it just started would never resolve and its history would be lost.
  const jobHasLiveRowsRef = useRef(jobHasLiveRows);
  useEffect(() => { jobHasLiveRowsRef.current = jobHasLiveRows; }, [jobHasLiveRows]);

  const [finishedLogRows, setFinishedLogRows] = useState<LogRow[] | null>(null);
  /** Byte offset in run.log the currently-loaded window starts at — what a "Load earlier" fetch pages backward from. */
  const [finishedLogStartByte, setFinishedLogStartByte] = useState(0);
  /** True once the loaded window reaches byte 0 of run.log — nothing earlier to load. */
  const [finishedAtStart, setFinishedAtStart] = useState(true);
  const [finishedLogError, setFinishedLogError] = useState<string | null>(null);
  const [loadingEarlierLogs, setLoadingEarlierLogs] = useState(false);
  /** Set by handleLoadEarlier just before it prepends rows; consumed by the scroll-restore layout effect below. */
  const pendingLogPrependRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  useEffect(() => {
    if (jobHasLiveRowsRef.current || activeTab !== 'logs' || !workspacePath || !effectiveRunId) return;
    let cancelled = false;
    client
      .request('readRunLog', { workdir: workspacePath, runId: effectiveRunId, fromEnd: true, limit: TAIL_LOG_PAGE_SIZE })
      .then(result => {
        if (cancelled) return;
        const parsed = result.lines.map(parseLogLine).filter((r): r is LogRow => r !== null);
        setFinishedLogRows(parsed);
        setFinishedLogStartByte(result.startByte ?? 0);
        setFinishedAtStart(result.atStart ?? true);
        setFinishedLogError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFinishedLogError(errorMessage(err));
      });
    return () => { cancelled = true; };
  }, [client, workspacePath, effectiveRunId, activeTab]);

  /**
   * Pages backward from the currently-loaded window's start byte and prepends
   * the result. Snapshots the scroller's height/position first so the layout
   * effect below can hold the viewport in place once the DOM grows at the top
   * — otherwise the browser keeps `scrollTop` fixed and the prepend yanks
   * whatever the human was reading downward, off-screen.
   */
  async function handleLoadEarlier(): Promise<void> {
    if (finishedAtStart || loadingEarlierLogs || !workspacePath || !effectiveRunId) return;
    setLoadingEarlierLogs(true);
    const el = logRef.current;
    if (el) pendingLogPrependRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    try {
      const result = await client.request('readRunLog', {
        workdir: workspacePath, runId: effectiveRunId, beforeByte: finishedLogStartByte, limit: TAIL_LOG_PAGE_SIZE,
      });
      const parsed = result.lines.map(parseLogLine).filter((r): r is LogRow => r !== null);
      setFinishedLogRows(current => [...parsed, ...(current ?? [])]);
      setFinishedLogStartByte(result.startByte ?? 0);
      setFinishedAtStart(result.atStart ?? true);
      setFinishedLogError(null);
    } catch (err) {
      pendingLogPrependRef.current = null;
      setFinishedLogError(errorMessage(err));
    } finally {
      setLoadingEarlierLogs(false);
    }
  }

  useLayoutEffect(() => {
    const pending = pendingLogPrependRef.current;
    if (!pending) return;
    pendingLogPrependRef.current = null;
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = pending.scrollTop + (el.scrollHeight - pending.scrollHeight);
  }, [finishedLogRows]);

  // Merge rather than switch: a reconnect to a still-running run fetches its
  // pre-reconnect history via readRunLog (above) while the live feed carries
  // only what arrives from here on. Choosing one source over the other loses
  // whichever side is discarded — the fetched rows once a live row arrives
  // (this is what iteration 2's B1-residual regression was), or the live tail
  // if we stuck with the fetch forever.
  //
  // De-duplicate on identity (logRowKey), not on "seq past the fetched max":
  // a resumed run rebinds this page to a new job whose journal — and so
  // whose `seq` — restarts at 1 (manifest.ts's `RunJournal` numbers events
  // per instance, not per run), while `run.log` keeps appending to the same
  // file. A high-water mark taken from the attempt fetched before the resume
  // would then reject every one of the resumed attempt's rows, freezing the
  // pane on the dead attempt while the new one runs (B1-residual-2). Keying
  // on the row's own content instead makes the merge correct whether or not
  // `seq` happens to be comparable across the two sources.
  const logRows = useMemo(() => {
    if (finishedLogRows === null) return liveLogRows;
    if (liveLogRows.length === 0) return finishedLogRows;
    const fetchedKeys = new Set(finishedLogRows.map(logRowKey));
    const newLiveRows = liveLogRows.filter(r => !fetchedKeys.has(logRowKey(r)));
    return newLiveRows.length === 0 ? finishedLogRows : [...finishedLogRows, ...newLiveRows];
  }, [finishedLogRows, liveLogRows]);
  const logRunPredatesRunLog = finishedLogRows !== null
    && finishedLogRows.length === 0 && finishedAtStart;

  const [logView, setLogView] = useState<'all' | 'audit' | 'errors'>('all');
  const [logStepFilter, setLogStepFilter] = useState('');
  const [logFind, setLogFind] = useState('');
  const [followLogs, setFollowLogs] = useState(true);

  const logStepIds = useMemo(
    () => [...new Set(logRows.map(r => r.stepId).filter((s): s is string => s !== undefined))],
    [logRows],
  );

  const filteredLogRows = useMemo(() => {
    const find = logFind.trim().toLowerCase();
    return logRows.filter(row => {
      if (logView === 'audit' && isContentLogRow(row)) return false;
      if (logView === 'errors' && row.stream !== 'stderr' && !ERROR_LOG_KINDS.has(row.kind)) return false;
      if (logStepFilter && row.stepId !== logStepFilter) return false;
      if (find && !row.text.toLowerCase().includes(find)) return false;
      return true;
    });
  }, [logRows, logView, logStepFilter, logFind]);

  const logFiltersActive = logView !== 'all' || logStepFilter !== '' || logFind.trim() !== '';

  function handleClearLogFilters(): void {
    setLogView('all');
    setLogStepFilter('');
    setLogFind('');
  }

  // Keyed on the last filtered row's own identity, not `filteredLogRows.length`:
  // a "Load earlier" prepend also changes the length (and would yank the view
  // to the bottom mid-investigation) but never changes the last row, so it
  // leaves this effect's dependency untouched — only a genuinely new row at
  // the tail re-triggers the scroll.
  const lastFilteredLogRowKey = filteredLogRows.length === 0
    ? null : logRowKey(filteredLogRows[filteredLogRows.length - 1]);

  /**
   * Row identities for the virtualizer's size cache, which must follow a row
   * when "Load earlier" shifts every index. logRowKey alone can repeat (see
   * the row's React key below), so a repeat gets its occurrence appended.
   */
  const filteredLogRowKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return filteredLogRows.map(row => {
      const key = logRowKey(row);
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return n === 0 ? key : `${key}#${n}`;
    });
  }, [filteredLogRows]);
  /** "Load earlier" rides at the top of the list as its first virtual row. */
  const showLoadEarlier = finishedLogRows !== null && !finishedAtStart;
  const logHeaderRows = showLoadEarlier && filteredLogRows.length > 0 ? 1 : 0;
  const logVirtual = useVirtualRows({
    count: filteredLogRows.length === 0 ? 0 : logHeaderRows + filteredLogRows.length,
    scrollRef: logRef,
    estimateSize: 18,
    getItemKey: index => (index < logHeaderRows ? 'load-earlier' : filteredLogRowKeys[index - logHeaderRows]),
  });

  function scrollLogsToEnd(): void {
    const count = logVirtual.options.count;
    if (count > 0) logVirtual.scrollToIndex(count - 1, { align: 'end' });
  }

  useEffect(() => {
    if (!followLogs) return;
    const el = logRef.current;
    if (!el || typeof el.scrollTo !== 'function') return;
    scrollLogsToEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the last row's identity, see above
  }, [lastFilteredLogRowKey, followLogs]);

  /** Releases "follow" the moment a human scrolls away from the bottom, so a live feed doesn't fight an investigation mid-scroll. */
  function handleLogScroll(): void {
    const el = logRef.current;
    if (!el) return;
    setFollowLogs(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }

  function loadEarlierRow() {
    return (
      <div style={{ textAlign: 'center', padding: '4px 0' }}>
        <Button
          size="small"
          appearance="subtle"
          disabled={loadingEarlierLogs}
          onClick={() => void handleLoadEarlier()}
          data-testid="log-load-earlier"
        >
          {loadingEarlierLogs ? 'Loading…' : 'Load earlier'}
        </Button>
      </div>
    );
  }

  async function handleCopyLog(): Promise<void> {
    await navigator.clipboard.writeText(filteredLogRows.map(plainLogLine).join('\n'));
  }

  async function handleCopyLogPath(): Promise<void> {
    if (!runDir) return;
    await navigator.clipboard.writeText(`${runDir}/run.log`);
  }

  /**
   * Ends only the live interactive session — the step then harvests and the run
   * carries on. No confirmation: unlike Cancel run this is the intended way for
   * an interactive step to finish, and the model normally does it itself.
   */
  async function handleEndSession(): Promise<void> {
    if (!effectiveJobId) return;
    setEndingSession(true);
    try {
      await client.request('endSession', { jobId: effectiveJobId });
    } finally {
      setEndingSession(false);
    }
  }

  /**
   * Continues this run from its first unfinished step. `freshSession` is the
   * escape hatch for an interactive step whose recorded agent session no
   * longer exists — resuming it would fail every time otherwise.
   */
  async function handleResume(freshSession = false, extraIterations?: number): Promise<void> {
    if (!workspacePath || !effectiveRunId) return;
    setResuming(true);
    try {
      const { jobId: resumedJobId } = await client.request('resumeRun', {
        workdir: workspacePath,
        runId: effectiveRunId,
        ...(freshSession ? { freshSession: true } : {}),
        ...(extraIterations === undefined ? {} : { extraIterations }),
      });
      // Tag the job before any of its notifications can land, the way
      // NewRunDialog does — otherwise the store has no entry for it for a
      // beat, the page falls back to the stale manifest, and Resume flashes
      // back on. The run id goes along so the manifest poll never unsubscribes
      // across the swap.
      noteJobWorkspace(resumedJobId, workspacePath);
      onResumed({ jobId: resumedJobId, runId: effectiveRunId });
    } finally {
      setResuming(false);
    }
  }

  async function handleConfirmCancel(): Promise<void> {
    setConfirmOpen(false);
    setCancelling(true);
    try {
      const params = effectiveJobId
        ? { jobId: effectiveJobId }
        : workspacePath && effectiveRunId
          ? { workdir: workspacePath, runId: effectiveRunId }
          : null;
      if (params) await client.request('cancelRun', params);
    } finally {
      setCancelling(false);
    }
  }

  async function handleConfirmRename(): Promise<void> {
    if (!workspacePath || !effectiveRunId) return;
    setRenaming(true);
    setRenameError(null);
    try {
      // An empty box clears the name — the same thing `whiphand rename-run <id> ''`
      // does, so there is no separate "clear" control to get wrong.
      const result = await client.request('renameRun', {
        workdir: workspacePath, runId: effectiveRunId,
        name: renameDraft.trim() === '' ? null : renameDraft,
      });
      setManifest(current => (current ? { ...current, name: result.name } : current));
      // The job's cached label has to follow too, `undefined` included: it is
      // the fallback when the manifest has no name, so leaving it stale is how
      // clearing a name appears not to work at all. See store.setJobRunName.
      if (effectiveJobId) setJobRunName(effectiveJobId, result.name);
      setRenameOpen(false);
    } catch (err) {
      setRenameError(errorMessage(err));
    } finally {
      setRenaming(false);
    }
  }

  async function handleConfirmExtraIterations(): Promise<void> {
    const extraIterations = parsePositiveInt(extraIterationsRaw);
    if (extraIterations === undefined) return;
    setExtraIterationsOpen(false);
    await handleResume(false, extraIterations);
  }

  async function handleToggleLock(): Promise<void> {
    if (!workspacePath || !effectiveRunId) return;
    setLocking(true);
    try {
      const result = await client.request('setRunLocked', {
        workdir: workspacePath, runId: effectiveRunId, locked: !manifest?.locked,
      });
      setManifest(current => (current ? { ...current, locked: result.locked } : current));
    } finally {
      setLocking(false);
    }
  }

  /**
   * Keyed on the list's *contents*, not on `manifest`. getRun is re-polled
   * every RUN_POLL_INTERVAL_MS while a run is live and hands back a fresh
   * object every tick, so a manifest-keyed memo gave this array a new
   * identity roughly twice every three seconds even when the run had produced
   * nothing new. That identity flows into both artifactDocContext and
   * artifactFs, which are two of the things Markdown keys its `components`
   * map on: the `img` override became a new component *type* on every poll,
   * so every image in an open artifact unmounted, revoked its object URL and
   * re-read its bytes over RPC — precisely while the run producing those
   * artifacts is still going, which is when they are most likely to be open.
   *
   * The signature names the two fields that actually matter (they are the
   * whole of an artifact ref, and what the resolver and the port address by),
   * so a genuinely new, renamed or removed artifact still changes identity
   * and still reaches the tree.
   */
  const artifactsSignature = (manifest?.artifacts ?? [])
    .map(a => `${a.name}\u0000${a.path}`)
    .join('\u0001');
  // Deliberately keyed on the signature rather than on `manifest.artifacts`
  // itself: the signature stands in for the manifest here. Guarded by
  // RunDetailPage.test.tsx, "does not re-read an open artifact's image when
  // polling brings back the same artifact list" (and its complement, "still shows an
  // artifact that only appears in a later poll").
  const artifacts = useMemo(() => manifest?.artifacts ?? [], [artifactsSignature]);
  const runDir = manifest?.runDir ?? '';

  /**
   * The real shape of the run directory. An artifact's manifest `name` is its
   * path relative to the run dir, '/'-separated — a loop writes
   * 'do-review/iter-2/review.md' — so the flat list is really a tree, and
   * flattening it into one row per artifact both hid that structure and left
   * two iterations of the same step showing as two identical labels.
   *
   * Built by hand rather than through applyDirListing, which is shaped for a
   * directory listing arriving one level at a time. Two rules keep it honest:
   * a file node is keyed by the manifest's own `path` (ArtifactFileSystem
   * looks artifacts up *by path*, so those must agree by construction, not by
   * coincidence), and a folder's key is grown one segment at a time with
   * joinPath — passing a whole relative name to joinPath would splice a '/'
   * into a Windows path. Folder keys address no file: nothing ever
   * reads one, they only have to be unique and stable.
   */
  const artifactNodes: TreeNodes = useMemo(() => {
    if (!runDir) return {};
    const nodes = makeRootNode(runDir);
    nodes[runDir] = { ...nodes[runDir], name: 'Artifacts', childrenLoaded: true, children: [] };

    for (const artifact of artifacts) {
      const segments = artifact.name.split('/').filter(Boolean);
      const fileName = segments.pop();
      if (fileName === undefined) continue;

      let parent = runDir;
      for (const segment of segments) {
        const dirPath = joinPath(parent, segment);
        if (!nodes[dirPath]) {
          nodes[dirPath] = {
            path: dirPath, name: segment, kind: 'dir', childrenLoaded: true, children: [],
          };
          nodes[parent].children!.push(dirPath);
        }
        parent = dirPath;
      }

      nodes[artifact.path] = {
        path: artifact.path, name: fileName, kind: 'file', childrenLoaded: true,
      };
      nodes[parent].children!.push(artifact.path);
    }

    // Folders first, then by name — the order FilesPage lists a directory in.
    for (const node of Object.values(nodes)) {
      node.children?.sort((a, b) => {
        const left = nodes[a], right = nodes[b];
        if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      });
    }
    return nodes;
  }, [artifacts, runDir]);

  /** A folder row is selectable, like it is in FilesPage; it just has nothing to preview. */
  const selectedArtifactNode = selectedArtifactPath === null ? undefined : artifactNodes[selectedArtifactPath];

  /**
   * Reads and writes go through the agent's artifact RPCs — never straight off
   * disk from the webview — so the viewer can't reach arbitrary files: the
   * server only serves a name that getRun's own directory listing for this run
   * already vouches for (see crates/whiphand-agent/src/handlers.rs).
   */
  const artifactFs = useMemo(
    () => new ArtifactFileSystem(client, workspacePath ?? '', effectiveRunId ?? '', artifacts),
    [client, workspacePath, effectiveRunId, artifacts],
  );

  /**
   * The parked decision, as the generic review model. Nothing downstream of
   * here knows it came from a manual step.
   */
  const reviewRequest = useMemo(
    () => (job?.pendingManual ? fromManualRequest(job.pendingManual, workspacePath ?? job.workdir) : undefined),
    [job?.pendingManual, job?.workdir, workspacePath],
  );
  const reviewKey = reviewRequest?.key;
  /** The step the answer has to name. The review model deliberately doesn't carry it. */
  const pendingStepId = job?.pendingManual?.stepId;

  /**
   * A decision arriving takes the screen. Once, though: `reviewDismissed`
   * records the question the human deliberately backed out of, so a poll
   * landing a moment later doesn't drag them straight back in. A *different*
   * question — the next loop iteration, a later step — opens again, because
   * its key differs.
   *
   * The dismissal is cleared when the question goes away, not kept: it applies
   * to that asking, not to the step for the rest of the run. A resume re-runs
   * the same step under the same key, and that is a fresh question.
   */
  useEffect(() => {
    if (reviewKey === undefined) {
      setReviewOpen(false);
      setReviewDismissed(null);
      return;
    }
    if (reviewDismissed === reviewKey) return;
    setReviewOpen(true);
  }, [reviewKey, reviewDismissed]);

  /**
   * The working tree, read when the review opens and on an explicit Refresh —
   * never polled. The page already runs two cadences (the live manifest poll
   * and the slower resumable one); a third, re-shelling out to git twice a
   * second behind a screen nobody is looking at, would be pure cost. While a
   * run is blocked on a human nothing else is writing anyway.
   */
  const wantsDiff = reviewOpen && reviewRequest?.sources.some(s => s.kind === 'diff') === true;
  useEffect(() => {
    if (!wantsDiff || !workspacePath) return;
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    client
      .request('getWorkingDiff', { workdir: workspacePath })
      .then(result => {
        if (cancelled) return;
        setDiff(result);
        setDiffLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDiffError(errorMessage(err));
        setDiffLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, workspacePath, wantsDiff, reviewKey, diffToken]);

  /**
   * A markdown artifact links to its siblings by name. resolveInArtifacts
   * refuses anything the manifest doesn't list — the same boundary
   * ArtifactFileSystem enforces by throwing, surfaced here as inert text
   * rather than a link that fails when clicked.
   */
  const openExternal = useOpenExternal();
  const artifactDocContext = useMemo(() => ({
    resolve: (target: string) => resolveInArtifacts(artifacts, target),
    onNavigate: setSelectedArtifactPath,
    openExternal,
  }), [artifacts, openExternal]);

  /**
   * A run's output is what you opened the tab for, so every folder in it
   * starts open — but only the first time it appears. Tracking what has
   * already been auto-expanded is what lets a folder the user collapsed stay
   * collapsed when the next poll brings back the same tree.
   */
  const autoExpandedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = Object.values(artifactNodes)
      .filter(node => node.kind === 'dir' && !autoExpandedRef.current.has(node.path))
      .map(node => node.path);
    if (fresh.length === 0) return;
    for (const path of fresh) autoExpandedRef.current.add(path);
    setArtifactsExpanded(current => [...current, ...fresh.filter(path => !current.includes(path))]);
  }, [artifactNodes]);

  if (!effectiveJobId && !effectiveRunId) {
    return (
      <EmptyState icon={<TextBulletListSquare48Regular />}>
        No run selected. Pick one from Runs to see how it went.
      </EmptyState>
    );
  }

  return (
    <div
      data-testid="run-detail-frame"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <PageHeader>
        {/*
          One row: title, status and actions all fit on a line, and this is the
          screen where every pixel above the fold belongs to the run itself.
        */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Button
            appearance="secondary"
            icon={<ArrowLeft20Regular />}
            // Icon-only, so the label has to come from aria-label instead.
            aria-label="Back to runs"
            title="Back to runs"
            onClick={onBack}
          />
          {/*
            The name leads and the id follows, dimmed: the name is what a
            human recognizes, but the id is what `--resume` and `whiphand
            rename-run` take, so it stays on screen rather than in a tooltip.
          */}
          <Text weight="semibold" size={500}>
            {runName ?? `Run ${effectiveRunId ?? effectiveJobId}`}
          </Text>
          {runName !== undefined && effectiveRunId && (
            <Text
              data-testid="run-detail-id"
              style={{ fontFamily: 'monospace', color: 'var(--colorNeutralForeground3)' }}
            >
              {effectiveRunId}
            </Text>
          )}
          {/*
            No awaiting badge here. What is waiting is a fact about one step,
            so it belongs to that step's pill — which is always the focus pill,
            and so survives a collapsed stepper. The dot on the Terminal tab
            below points at where to go; a third copy in the header only
            widened a row this screen wants kept to one line.
          */}
          {(job?.status ?? manifest?.status) && <StatusBadge status={job?.status ?? (manifest?.status as string)} />}
          {runElapsed !== null && (
            <Text data-testid="run-elapsed" style={{ color: 'var(--colorNeutralForeground3)' }}>
              {runElapsed}
            </Text>
          )}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            {job?.ptyActive && effectiveJobId && (
              <Button
                appearance="secondary"
                disabled={endingSession}
                icon={endingSession ? <Spinner size="tiny" /> : <PlugDisconnected20Regular />}
                title="Finish this interactive step and collect its artifact. The run continues."
                onClick={() => void handleEndSession()}
              >
                {endingSession ? 'Ending…' : 'End session'}
              </Button>
            )}
            {isRunning && (
              <Dialog open={confirmOpen} onOpenChange={(_e, data) => setConfirmOpen(data.open)}>
                <DialogTrigger disableButtonEnhancement>
                  <Button
                    appearance="secondary"
                    disabled={cancelling}
                    icon={cancelling ? <Spinner size="tiny" /> : <Stop20Regular />}
                    title="Cancel this run"
                  >
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                  </Button>
                </DialogTrigger>
                <DialogSurface>
                  <DialogBody>
                    <DialogTitle>Cancel this run?</DialogTitle>
                    <DialogContent>This stops the run in progress. It cannot be resumed.</DialogContent>
                    <DialogActions>
                      <Button appearance="secondary" onClick={() => setConfirmOpen(false)}>
                        Keep running
                      </Button>
                      <Button appearance="primary" onClick={() => void handleConfirmCancel()}>
                        Confirm cancel
                      </Button>
                    </DialogActions>
                  </DialogBody>
                </DialogSurface>
              </Dialog>
            )}
            {canResume && (
              <Menu positioning="below-end">
                <MenuTrigger disableButtonEnhancement>
                  {(triggerProps: MenuButtonProps) => (
                    <SplitButton
                      appearance="primary"
                      disabled={resuming}
                      menuButton={{ ...triggerProps, 'aria-label': 'More resume options' }}
                      primaryActionButton={{
                        onClick: () => void handleResume(),
                        title: 'Continue this run from its first unfinished step',
                      }}
                      icon={resuming ? <Spinner size="tiny" /> : <PlayCircle20Regular />}
                    >
                      {resuming ? 'Resuming…' : 'Resume'}
                    </SplitButton>
                  )}
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem onClick={() => void handleResume(true)}>
                      Resume with a fresh session
                    </MenuItem>
                    <MenuItem onClick={() => {
                      setExtraIterationsRaw('1');
                      setExtraIterationsOpen(true);
                    }}
                    >
                      Resume with more iterations…
                    </MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            )}
            {canResume && (
              <Dialog
                open={extraIterationsOpen}
                onOpenChange={(_e, data) => { if (!resuming) setExtraIterationsOpen(data.open); }}
              >
                <DialogSurface>
                  <DialogBody>
                    <DialogTitle>Resume with more iterations</DialogTitle>
                    <DialogContent>
                      <Field
                        label="Extra iterations"
                        hint="Granted to every loop this run recorded as exhausted."
                        validationState={parsePositiveInt(extraIterationsRaw) === undefined ? 'error' : 'none'}
                        validationMessage={
                          parsePositiveInt(extraIterationsRaw) === undefined
                            ? 'Must be a positive whole number.'
                            : undefined
                        }
                      >
                        <Input
                          data-testid="resume-extra-iterations-input"
                          value={extraIterationsRaw}
                          disabled={resuming}
                          onChange={(_e, data) => setExtraIterationsRaw(data.value)}
                        />
                      </Field>
                    </DialogContent>
                    <DialogActions>
                      <Button disabled={resuming} onClick={() => setExtraIterationsOpen(false)}>Cancel</Button>
                      <Button
                        appearance="primary"
                        disabled={resuming || parsePositiveInt(extraIterationsRaw) === undefined}
                        onClick={() => void handleConfirmExtraIterations()}
                      >
                        {resuming ? <Spinner size="tiny" /> : 'Resume'}
                      </Button>
                    </DialogActions>
                  </DialogBody>
                </DialogSurface>
              </Dialog>
            )}
            {!isRunning && typeof manifest?.workflow === 'string' && (
              <Button
                appearance="secondary"
                icon={<Replay20Regular />}
                onClick={() => onRunAgain(
                  manifest.workflow as string,
                  (manifest.inputs ?? {}) as Record<string, string>,
                  manifest.workflowSource as Scope | undefined,
                )}
              >
                Run again
              </Button>
            )}
            {effectiveRunId && (
              <Dialog
                open={renameOpen}
                onOpenChange={(_e, data) => {
                  if (data.open) {
                    setRenameDraft(runName ?? '');
                    setRenameError(null);
                  }
                  if (!renaming) setRenameOpen(data.open);
                }}
              >
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary" icon={<Rename20Regular />}>
                    Rename
                  </Button>
                </DialogTrigger>
                <DialogSurface>
                  <DialogBody>
                    <DialogTitle>Name this run</DialogTitle>
                    <DialogContent>
                      <Field
                        label="Name"
                        hint="Shown instead of the run id. Leave blank to clear it."
                        validationState={renameError ? 'error' : 'none'}
                        validationMessage={renameError ?? undefined}
                      >
                        <Input
                          data-testid="run-rename-input"
                          value={renameDraft}
                          disabled={renaming}
                          onChange={(_e, data) => setRenameDraft(data.value)}
                        />
                      </Field>
                    </DialogContent>
                    <DialogActions>
                      <Button disabled={renaming} onClick={() => setRenameOpen(false)}>Cancel</Button>
                      <Button
                        appearance="primary"
                        disabled={renaming}
                        onClick={() => void handleConfirmRename()}
                      >
                        {renaming ? <Spinner size="tiny" /> : 'Save'}
                      </Button>
                    </DialogActions>
                  </DialogBody>
                </DialogSurface>
              </Dialog>
            )}
            {effectiveRunId && (
              <ToggleButton
                appearance="secondary"
                checked={!!manifest?.locked}
                disabled={locking}
                icon={locking ? <Spinner size="tiny" /> : manifest?.locked ? <LockClosed20Regular /> : <LockOpen20Regular />}
                onClick={() => void handleToggleLock()}
              >
                {manifest?.locked ? 'Locked' : 'Lock'}
              </ToggleButton>
            )}
            {effectiveRunId && (
              <Button appearance="secondary" icon={<Delete20Regular />} onClick={() => setDeleteOpen(true)}>
                Delete
              </Button>
            )}
            {deleteOpen && workspacePath && effectiveRunId && (
              <DeleteRunDialog
                workdir={workspacePath}
                runId={effectiveRunId}
                name={runName}
                onDeleted={() => {
                  setDeleteOpen(false);
                  onBack();
                }}
                onDismiss={() => setDeleteOpen(false)}
              />
            )}
          </div>
        </div>
      </PageHeader>

      {/*
        Loud on purpose, and the same MessageBar the settings pages use: a run
        that failed says so once, here, and a line of ordinary text was easy to
        scroll straight past.
      */}
      {(manifestError || runErrorMessage) && (
        <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 }}>
          {manifestError && (
            <MessageBar intent="error" data-testid="run-detail-error">
              <MessageBarBody>Could not load run details: {manifestError}</MessageBarBody>
            </MessageBar>
          )}
          {runErrorMessage && (
            <MessageBar intent="error" data-testid="run-error">
              <MessageBarBody>
                {stageStop !== undefined && (
                  <div data-testid="run-error-stage">Run {stageStop}.</div>
                )}
                Run error: {runErrorMessage}
              </MessageBarBody>
            </MessageBar>
          )}
        </div>
      )}

      {/* Shown, not just logged: a capability that degraded is part of the run's summary. */}
      {degradations.length > 0 && (
        <div style={{ flexShrink: 0, paddingTop: 8 }}>
          <MessageBar intent="warning" data-testid="run-degraded">
            <MessageBarBody>
              <MessageBarTitle>Degraded</MessageBarTitle>
              {degradations.map(d => (
                <div key={`${d.capability}:${d.stepId ?? ''}`} data-testid="run-degradation">{degradationLine(d)}</div>
              ))}
            </MessageBarBody>
          </MessageBar>
        </div>
      )}

      {/*
        Capped so a run with many expanded stages cannot squeeze the tabs panel
        away. A percentage max-height resolves because the frame above has a
        definite height; no measurement is needed. The collapse chevron stays
        as the way to hide the strip entirely.
      */}
      <div
        data-testid="run-stepper-strip"
        style={{
          flexShrink: 0,
          maxHeight: 'clamp(140px, 38%, 460px)',
          overflowY: 'auto',
          paddingTop: 8,
          paddingBottom: 8,
        }}
      >
        <RunStepper
          // Remounting on a different run is what resets the stages' follow-the-run latch.
          key={effectiveRunId ?? jobId}
          steps={steps}
          focusStepId={focusStep?.id}
          collapsed={stepsCollapsed}
          onToggleCollapse={() => setStepsCollapsed(current => !current)}
          awaiting={
            job?.awaiting
              ? { stepId: job.awaiting.stepId, label: AWAIT_LABEL[job.awaiting.reason] }
              : undefined
          }
          nodeRef={(key, el) => { stepRefs.current[key] = el; }}
          now={now}
        />
      </div>

      {reviewRequest && effectiveJobId && !reviewOpen && (
        // The run is blocked until this is answered, so backing out of the
        // review must still leave the question on screen — never only behind
        // a tab.
        <div style={{ flexShrink: 0, paddingBottom: 8 }}>
          <PendingDecisionBar
            badge={reviewRequest.badge}
            title={reviewRequest.title}
            onOpen={() => { setReviewDismissed(null); setReviewOpen(true); }}
          />
        </div>
      )}

      {reviewRequest && effectiveJobId && pendingStepId !== undefined && (
        /*
          Takes the tabs' place rather than floating over them. A Fluent Dialog
          would be a fourth Modalizer on top of the three this page already
          keeps mounted-but-closed (cancel, rename, delete), which is the
          tabster race App.tsx documents — and it would stack again with
          FilePreview's own save-conflict dialog inside this pane.
          PageHeader above stays put: a reviewer has to be able to see which
          run they are signing off.

          Hidden with display:none rather than unmounted when the human backs
          out — the same pattern the tabs below use, and for the same reason:
          a review can arrive mid-edit, and closing it must not discard a
          typed note or a dozen per-file comments the way losing this pane
          used to.
        */
        <div style={{ display: reviewOpen ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <ReviewOverlay
            request={reviewRequest}
            diff={diff}
            diffLoading={diffLoading}
            diffError={diffError}
            onRefreshDiff={() => setDiffToken(token => token + 1)}
            onClose={() => { setReviewDismissed(reviewRequest.key); setReviewOpen(false); }}
            fs={artifactFs}
            docContext={artifactDocContext}
            onResolve={async (choice: ManualChoice, note?: string, comments?: FileComment[]) => {
              const result = await client.request('resolveManual', {
                jobId: effectiveJobId,
                stepId: pendingStepId,
                choice,
                ...(note === undefined ? {} : { note }),
                ...(comments === undefined ? {} : { comments }),
              });
              // The agent says no when nothing is waiting any more — the run was
              // cancelled, or another window answered first. Say so rather than
              // leaving a screen that looks live but no longer is.
              if (!result.ok) throw new Error('This step is no longer waiting for an answer.');
            }}
          />
        </div>
      )}

      {/*
        Hidden, not unmounted. The review can arrive while an artifact is open
        in edit mode, and unmounting the pane would throw away edits the user
        never chose to abandon — the terminal's xterm buffer with it. This is
        the same reason the panels below use display:none rather than a
        conditional, and `display: none` is out of the tab order and out of the
        accessibility tree, so nothing behind the review is reachable anyway.
      */}
      <div
        style={{
          display: reviewOpen ? 'none' : 'flex',
          flexDirection: 'column', flex: 1, minHeight: 0,
        }}
      >
      <TabList
        selectedValue={activeTab}
        onTabSelect={(_e, data) => setChosenTab(data.value as RunTab)}
        style={{ flexShrink: 0 }}
      >
        <Tab value="terminal">
          Terminal
          {/* Where the attention actually is. A badge, not a character spliced
              into the label: the Artifacts tab beside it already carries a
              CounterBadge, and a bullet in a string has no accessible name. */}
          {job?.awaiting && job.awaiting.stepId === job.ptyStepId && (
            <AttentionBadge
              compact
              label={AWAIT_LABEL[job.awaiting.reason]}
              data-testid="tab-awaiting"
            />
          )}
        </Tab>
        <Tab value="artifacts">
          Artifacts
          {/* A bare number next to a word could be anything; a counter badge says "how many". */}
          {artifacts.length > 0 && (
            <CounterBadge
              appearance="filled"
              color="informative"
              size="small"
              count={artifacts.length}
              style={{ marginInlineStart: 6 }}
            />
          )}
        </Tab>
        <Tab value="logs">Logs</Tab>
      </TabList>

      <div style={{ flex: 1, minHeight: 0, paddingTop: 8 }}>
        <div
          data-testid="run-panel-terminal"
          style={{
            display: activeTab === 'terminal' ? 'flex' : 'none',
            flexDirection: 'column', height: '100%', minHeight: 0,
          }}
        >
          {showTerminal && effectiveJobId ? (
            <TerminalPanel
              // Keyed on the pty step (not just jobId): a later interactive step
              // in the same job starts a fresh PTY session (store resets
              // ptyDataBuffer/ptyExited on the new ptyStarted) — a remount here
              // gives it a fresh terminal + write-count tracking too, instead of
              // reusing one whose internal buffer bookkeeping is for the last session.
              key={job?.ptyStepId ?? effectiveJobId}
              jobId={effectiveJobId}
              cols={job?.ptyCols}
              rows={job?.ptyRows}
              onResize={(cols, rows) => void client.request('ptyResize', { jobId: effectiveJobId, cols, rows })}
            />
          ) : hasHeadlessStep || activityTail.length > 0 ? (
            // A headless step has no pty, but it is still the session running
            // right now — so this tab narrates it rather than saying there is
            // nothing here.
            //
            // Ahead of the session-ended note deliberately: ptyExited latches
            // until the *next* ptyStarted, so an interactive step followed by
            // headless ones (both project workflows) left the note owning this
            // tab for the whole rest of the run, with the feed below it
            // unreachable. A run that is still working outranks a note about a
            // session that already finished.
            <div
              ref={activityRef}
              data-testid="activity-feed"
              style={{
                ...RECESSED_SURFACE,
                flex: 1, minHeight: 0, overflow: 'auto', fontFamily: 'var(--fontFamilyMonospace)', fontSize: 12,
                // Only while empty: the placeholder centres itself in the pane,
                // which it can only do if the pane is a flex container. Lines
                // want the ordinary block flow back the moment there are any.
                ...(activityTail.length === 0 ? { display: 'flex' } : {}),
              }}
            >
              {activityTail.length === 0 ? (
                // A step reports nothing between step:start (which clears the
                // feed) and its first tool call, and that gap can be long. An
                // empty box reads as a failed render; this says the same thing
                // the box does, without restating the step's id or its clock —
                // those are on its pill.
                <EmptyState>No output yet.</EmptyState>
              ) : activityTail.map((entry, idx) => (
                <div key={idx}>
                  <span style={{ color: 'var(--colorNeutralForeground3)' }}>{entry.stepId}</span>
                  {' '}
                  {entry.text}
                </div>
              ))}
            </div>
          ) : (
            // Nothing live to show — but still the same panel, rather than a
            // lone sentence floating in a blank tab. Both placeholders are the
            // pane's own state, so they get the pane's own surface: the same
            // one the Artifacts tab's empty state sits on.
            <div
              data-testid={showSessionEndedNote ? 'pty-session-ended-note' : 'terminal-empty'}
              style={{ ...RECESSED_SURFACE, flex: 1, minHeight: 0, display: 'flex' }}
            >
              {showSessionEndedNote ? (
                <EmptyState icon={<PlugDisconnected48Regular />}>
                  Interactive session ended. Its work is in the run's artifacts and logs.
                </EmptyState>
              ) : (
                <EmptyState icon={<Prompt48Regular />}>No live session.</EmptyState>
              )}
            </div>
          )}
        </div>

        <div
          data-testid="run-panel-artifacts"
          style={{ display: activeTab === 'artifacts' ? 'flex' : 'none', height: '100%', minHeight: 0 }}
        >
          {artifacts.length === 0 ? (
            <div style={{ ...RECESSED_SURFACE, flex: 1, minHeight: 0, display: 'flex' }}>
              <EmptyState icon={<DocumentFolder48Regular />}>
                No artifacts yet. Steps write theirs as they finish.
              </EmptyState>
            </div>
          ) : (
            <FileSystemProvider fs={artifactFs}>
              {/* Laid out like FilesPage's browser: both use ResizablePane,
                  each with its own saved width. The preview's own surface is
                  the only boundary. */}
              <div style={{ display: 'flex', width: '100%', minHeight: 0 }}>
                <ResizablePane storageKey="whiphand.run.artifactsTreeWidth">
                  <FileTree
                    root={runDir}
                    nodes={artifactNodes}
                    expanded={artifactsExpanded}
                    selectedPath={selectedArtifactPath}
                    onToggle={path => setArtifactsExpanded(current => (
                      current.includes(path) ? current.filter(p => p !== path) : [...current, path]
                    ))}
                    onSelect={setSelectedArtifactPath}
                  />
                </ResizablePane>
                <div
                  style={{
                    // The same recessed surface the log tail and the activity
                    // feed sit on: all of it is this run's output.
                    ...RECESSED_SURFACE,
                    flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden',
                  }}
                >
                  <FilePreview
                    path={selectedArtifactNode?.kind === 'dir' ? null : selectedArtifactPath}
                    onDirtyChange={() => {}}
                    docContext={artifactDocContext}
                    // Only while the run can still write: a finished run's
                    // artifacts are settled, and watching them would cost a
                    // handle (or a poll) for a file that will never change.
                    live={isRunning}
                  />
                </div>
              </div>
            </FileSystemProvider>
          )}
        </div>

        <div
          data-testid="run-panel-logs"
          style={{ display: activeTab === 'logs' ? 'flex' : 'none', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8 }}
        >
          {/*
            The run audit: every important action, plus the merged output feed,
            in one chronological view — always backed by run.log on disk (see
            crates/whiphand-core/src/store/journal.rs), live or read back afterwards.
          */}
          <div
            role="group"
            aria-label="Log view"
            style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, flexShrink: 0 }}
          >
            <ToggleButton
              size="small"
              appearance={logView === 'all' ? 'primary' : 'subtle'}
              aria-pressed={logView === 'all'}
              checked={logView === 'all'}
              onClick={() => setLogView('all')}
              data-testid="log-filter-all"
            >
              All
            </ToggleButton>
            <ToggleButton
              size="small"
              appearance={logView === 'audit' ? 'primary' : 'subtle'}
              aria-pressed={logView === 'audit'}
              checked={logView === 'audit'}
              onClick={() => setLogView('audit')}
              data-testid="log-filter-audit-only"
            >
              Audit only
            </ToggleButton>
            <ToggleButton
              size="small"
              appearance={logView === 'errors' ? 'primary' : 'subtle'}
              aria-pressed={logView === 'errors'}
              checked={logView === 'errors'}
              onClick={() => setLogView('errors')}
              data-testid="log-filter-errors-only"
            >
              Errors only
            </ToggleButton>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {logStepIds.length > 0 && (
              <select
                aria-label="Filter by step"
                data-testid="log-filter-step"
                value={logStepFilter}
                onChange={e => setLogStepFilter(e.target.value)}
                style={{ height: 32, borderRadius: 4 }}
              >
                <option value="">All steps</option>
                {logStepIds.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
            )}
            <Input
              size="small"
              placeholder="Find…"
              value={logFind}
              onChange={(_e, data) => setLogFind(data.value)}
              data-testid="log-find-input"
              style={{ minWidth: 160 }}
            />
            <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }} data-testid="log-filter-count">
              {filteredLogRows.length.toLocaleString()} of {logRows.length.toLocaleString()} rows
            </Text>
            {logFiltersActive && (
              <Button size="small" appearance="subtle" onClick={handleClearLogFilters} data-testid="log-filter-clear">
                Clear filters
              </Button>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <Button size="small" icon={<Copy20Regular />} onClick={() => void handleCopyLog()}>
                Copy log
              </Button>
              <Button
                size="small"
                disabled={!runDir}
                title={runDir ? `${runDir}/run.log` : undefined}
                onClick={() => void handleCopyLogPath()}
              >
                Copy log path
              </Button>
            </div>
          </div>

          {finishedLogError && (
            <MessageBar intent="error" data-testid="log-read-error">
              <MessageBarBody>Could not read run.log: {finishedLogError}</MessageBarBody>
            </MessageBar>
          )}

          <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
            <div
              ref={logRef}
              data-testid="log-tail"
              {...VIRTUAL_SCROLLER_PROPS}
              onScroll={handleLogScroll}
              style={{
                ...RECESSED_SURFACE,
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                fontFamily: 'var(--fontFamilyMonospace)',
                fontSize: 12,
                ...(logRows.length === 0 ? { display: 'flex' } : {}),
              }}
            >
              {showLoadEarlier && logHeaderRows === 0 && loadEarlierRow()}
              {logRows.length === 0 ? (
                // logRunPredatesRunLog is checked here, not before the
                // logRows.length check, because a merged live row can arrive
                // after a fetch that found the file empty (a fresh reconnect
                // to a running, not-yet-logged run) — that row must render,
                // not be shadowed by the "predates run.log" message.
                logRunPredatesRunLog ? (
                  // The bug this feature fixes must not be replaced by a silent
                  // one: a run from before run.log existed says so, plainly,
                  // rather than rendering an unexplained blank pane.
                  <EmptyState>This run predates the persisted log — nothing was recorded to run.log.</EmptyState>
                ) : (
                  <EmptyState>No log entries yet.</EmptyState>
                )
              ) : filteredLogRows.length === 0 ? (
                <EmptyState>No entries match the current filters.</EmptyState>
              ) : (
                <>
                  <div style={{ height: spacerHeights(logVirtual).before }} />
                  {logVirtual.getVirtualItems().map(item => {
                    if (item.index < logHeaderRows) {
                      return (
                        <div key={item.key} data-index={item.index} ref={logVirtual.measureElement}>
                          {loadEarlierRow()}
                        </div>
                      );
                    }
                    const index = item.index - logHeaderRows;
                    const row = filteredLogRows[index];
                    return (
                      <div
                        // Not unique on its own: a resumed run's journal restarts `seq`
                        // at 1 in the new RunJournal instance while appending to the
                        // same run.log, and `log:truncated` reuses its terminal
                        // event's seq — so a file can hold duplicate seqs. The key
                        // carries an occurrence count for that (filteredLogRowKeys).
                        key={item.key}
                        data-index={item.index}
                        ref={logVirtual.measureElement}
                        data-testid="log-row"
                        data-kind={row.kind}
                        style={{
                          display: 'flex', gap: 8,
                          color: row.stream === 'stderr'
                            ? 'var(--colorPaletteRedForeground1)'
                            : row.stream !== undefined ? 'var(--colorNeutralForeground3)' : undefined,
                          fontWeight: row.stream !== undefined ? undefined : 600,
                        }}
                      >
                        <span style={{ color: 'var(--colorNeutralForeground3)', fontWeight: 400, flexShrink: 0 }}>
                          {row.ts.slice(11, 23)}
                        </span>
                        <span style={{ color: 'var(--colorNeutralForeground3)', fontWeight: 400, flexShrink: 0, width: 90 }}>
                          {row.stepId ?? ''}
                        </span>
                        <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{row.text}</span>
                      </div>
                    );
                  })}
                  <div style={{ height: spacerHeights(logVirtual).after }} />
                </>
              )}
            </div>
            {!followLogs && (
              <Button
                size="small"
                shape="circular"
                icon={<ArrowDown20Regular />}
                data-testid="log-jump-to-latest"
                onClick={() => { setFollowLogs(true); scrollLogsToEnd(); }}
                style={{ position: 'absolute', bottom: 12, right: 12 }}
              >
                Jump to latest
              </Button>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
