import { appendFile, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type {
  RunAttachment, WhiphandEvent, Scope, StepKind, StepMode, StepProgress, WorkspaceConfig,
} from '../types.ts';
import { isEndMarkerName } from './session-end.ts';
import { isAwaitStateName } from './await-state.ts';
import { LOCK_MARKER_NAME, isRunLocked } from './run-lock.ts';
import { NAME_MARKER_NAME, SUGGEST_CAPTURE_NAME, readRunName, setRunName } from './run-name.ts';
import { RUN_LOG_NAME, DEFAULT_RUN_LOG_CAP_BYTES, summarizeEvent, formatLogLine } from './run-log.ts';

const manifestStepSchema = z.object({
  id: z.string().min(1),
  // Optional since v2: only agent steps have a runner and a mode. Manifests
  // written by v1 always carried both, so they still parse.
  kind: z.enum(['agent', 'command', 'manual', 'approval', 'loop']).default('agent'),
  runner: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  mode: z.enum(['interactive', 'headless']).optional(),
  /** id of the enclosing loop, when this execution happened inside one. */
  loopId: z.string().min(1).optional(),
  /** 1-based iteration this execution belongs to; absent outside a loop. */
  iteration: z.number().int().positive().optional(),
  /** On a loop's own entry: how many iterations it ended up running. */
  iterations: z.number().int().nonnegative().optional(),
  /**
   * On a loop's own entry: the iteration budget it was started with, so a
   * reader can say "2 of 3" rather than just "2". Optional, like `progress`,
   * so manifests written before it existed still parse.
   */
  maxIterations: z.number().int().positive().optional(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'interrupted', 'disabled']),
  exitCode: z.number().int().optional(),
  artifact: z.string().optional(),
  verdict: z.enum(['pass', 'fail']).optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  /**
   * This execution has started at least once, even though a resume has since
   * reset its status to 'pending'. Without it `status` alone cannot tell a step
   * that never ran from one whose failed attempt was cleared — which is the
   * signal planResume needs to decide there is an agent session to continue.
   * Optional, like `progress`, so older manifests still parse.
   */
  attempted: z.boolean().optional(),
  /**
   * An interactive session was really spawned for this execution, so the id in
   * `sessionIds` names a conversation that exists on disk.
   *
   * Distinct from `attempted`, and the distinction matters: `step:start` fires
   * before the prompt is built, so a step can be recorded as started and then
   * die before it ever spawns — a missing input artifact does exactly that.
   * Offering `--resume` an id no conversation ever claimed just fails the run
   * again. Sticky across resumes: once a conversation exists, it exists.
   */
  sessionStarted: z.boolean().optional(),
  /**
   * Summary of what a headless step did, folded from step:progress events.
   * Optional, so manifests written before progress existed still parse — the
   * same back-compat move heartbeatAt used. Duration is deliberately absent:
   * startedAt and endedAt already give it.
   */
  progress: z.object({
    turns: z.number().int().optional(),
    costUsd: z.number().optional(),
    premiumRequests: z.number().optional(),
    lastAction: z.string().optional(),
  }).optional(),
});

/**
 * v2 added step kinds, loops, and one entry per *execution* rather than per
 * declared step. v3 added `sessionStarted`, which is the first field whose
 * *absence* carries meaning — so it needs a version to be read against, or an
 * older run would look like one whose sessions never opened. Earlier manifests
 * still parse: the union is what keeps `listRuns` from going blind on runs
 * recorded before cycles existed.
 */
export const MANIFEST_VERSION = 3;

/**
 * The run's own copy of the workflow it executed. A resume reads this rather
 * than the workspace file, which may have changed since the run started — so
 * a resumed run is always the workflow that actually ran.
 */
export const WORKFLOW_SNAPSHOT_NAME = 'workflow.yaml';

/**
 * Identifies one *execution*. A loop runs the same step id many times, so an
 * id alone no longer addresses a row — this is the same `iteration ?? 1`
 * defaulting `beginStep` matches entries by, spelled once so that resume and
 * the desktop cannot drift apart on it.
 */
export function executionKey(stepId: string, iteration?: number): string {
  return iteration === undefined || iteration === 1 ? stepId : `${stepId}#${iteration}`;
}

const runManifestSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  runId: z.string().min(1),
  workflow: z.string().min(1),
  workdir: z.string().min(1),
  dryRun: z.boolean(),
  pid: z.number().int(),
  startedAt: z.string(),
  updatedAt: z.string(),
  // Liveness ping, refreshed on a timer while the run is in flight. Distinct
  // from updatedAt, which means "last event" — a long interactive step
  // legitimately produces no events for many minutes. Optional so manifests
  // written before heartbeats existed still parse.
  heartbeatAt: z.string().optional(),
  endedAt: z.string().optional(),
  /**
   * One ISO stamp per resume. Optional like `progress`, so manifests written
   * before resume existed still parse — no version bump.
   */
  resumedAt: z.array(z.string()).optional(),
  /**
   * `snapshotTree` digest of the working tree as this run stopped. Resume
   * diffs it against the tree at resume time to report drift. Absent when the
   * owning process was killed before it could record one.
   */
  stoppedTree: z.string().optional(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  ok: z.boolean().optional(),
  /**
   * Where the workflow this run started from was resolved from. Optional,
   * like `heartbeatAt`, so manifests written before global workflows existed
   * still parse. Used by the no-snapshot resume fallback to refuse resuming
   * against a same-named workflow that now resolves to a different scope.
   */
  workflowSource: z.enum(['project', 'global']).optional(),
  inputs: z.record(z.string(), z.string()),
  /**
   * The files attached when the run started, copied under `attachments/`.
   * Optional like `resumedAt`, so manifests written before attachments
   * existed still parse — no version bump. A resume reads them back from here
   * and never changes them.
   */
  attachments: z.array(z.object({
    name: z.string().min(1),
    /** Relative to the run directory, '/'-separated. */
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    /** The original absolute path, or 'pasted'. */
    source: z.string().min(1),
  })).optional(),
  sessionIds: z.record(z.string(), z.string()),
  steps: z.array(manifestStepSchema),
  /** Set while a manual/approval step is waiting on a human; cleared on answer. */
  manualPending: z.object({ stepId: z.string(), title: z.string() }).optional(),
  error: z.object({ stepId: z.string().optional(), message: z.string() }).optional(),
});

export type RunManifest = z.infer<typeof runManifestSchema>;
type ManifestStep = RunManifest['steps'][number];

/** How often a live run refreshes heartbeatAt on disk. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** How far heartbeatAt may fall behind before the run counts as abandoned. */
export const HEARTBEAT_STALE_MS = 60_000;

export const INTERRUPTED_MESSAGE =
  'Run was interrupted — the process that owned it exited without finishing.';

export interface RunJournalInit {
  runDir: string;
  runId: string;
  workflow: string;
  workdir: string;
  dryRun: boolean;
  /** Where `workflow` was resolved from; absent for a resumed run's reopen (it keeps the recorded value). */
  workflowSource?: Scope;
  inputs: Record<string, string>;
  /** Recorded as given; absent or empty records nothing. Ignored on reopen, which keeps the recorded list. */
  attachments?: RunAttachment[];
  sessionIds: Record<string, string>;
  steps: Array<{
    id: string; kind: StepKind; loopId?: string;
    runner?: string; model?: string; mode?: StepMode;
    /** Seeds this entry as `status: 'disabled'` instead of `'pending'`. */
    disabled?: boolean;
  }>;
  /** Override for tests; production uses HEARTBEAT_INTERVAL_MS. */
  heartbeatIntervalMs?: number;
  /** Override for tests; production uses DEFAULT_RUN_LOG_CAP_BYTES. 0 disables the cap. */
  runLogCapBytes?: number;
}

const TERMINAL_EVENTS = new Set<WhiphandEvent['type']>(['run:done', 'run:error', 'run:cancelled']);

/**
 * Reduces the run's WhiphandEvent stream into an on-disk RunManifest (run.json,
 * atomically written) plus a raw NDJSON event log (events.ndjson). Writes are
 * chained on an internal promise so they never interleave; record() itself
 * stays synchronous (fire-and-forget scheduling) since core calls
 * frontend.onEvent synchronously.
 *
 * While the run is in flight the journal also refreshes heartbeatAt on a timer.
 * That heartbeat is what lets a later reader tell an abandoned run (the process
 * was SIGKILLed, so no terminal event was ever written) from a live one whose
 * pid happens to have been reused — see readRunSummary.
 */
let journalSeq = 0;
const nextJournalSeq = (): number => (journalSeq += 1);

/**
 * Clears an entry the resume is about to run again. `beginStep` already wipes
 * these fields when the step's own `step:start` lands — this only moves that
 * moment earlier, to reopen, so a reader with no event stream (the CLI, the
 * desktop's manifest poll, another process) never sees a 'running' run whose
 * next step still reads 'failed' with the last attempt's exit code.
 *
 * Steps recorded as 'done' are left alone: planResume builds its skip set from
 * exactly those, so "everything not done" is precisely "everything that will
 * re-execute", and completed work keeps its artifact, verdict and timings.
 *
 * 'disabled' is left alone for the same reason 'done' is: it is a terminal
 * status a resume must not clobber. The runner re-prunes a disabled step on
 * every resume regardless, so rewriting it to 'pending' here would just leave
 * it stuck pending forever — worse, it would render as an ordinary pending
 * step (a hollow circle, no badge) until the run ends, and the "N of M"
 * progress count would shift across the resume of the very same run.
 */
function resetUnfinished(step: ManifestStep): ManifestStep {
  if (step.status === 'done' || step.status === 'disabled') return step;
  // Sticky across resumes: once the reset has erased the status that said so,
  // this flag is the only remaining evidence the step ever got as far as
  // opening an agent session.
  const attempted = step.status !== 'pending' || step.attempted === true;
  // startedAt goes too, or a pending step reads as one that has been running
  // since the previous attempt began. `iterations` is re-counted by loop:start.
  const { startedAt, endedAt, exitCode, artifact, verdict, progress, iterations, ...keep } = step;
  return { ...keep, status: 'pending', ...(attempted ? { attempted: true } : {}) };
}

export class RunJournal {
  readonly manifest: RunManifest;
  private readonly runDir: string;
  /**
   * Writes are tmp+rename, and the tmp name is per *instance*, not a shared
   * constant: one journal's writes are serialized on its own `chain`, but two
   * journals over the same run directory (a reopen alongside its original) are
   * not, and a shared name lets one's rename delete the other's half-written
   * file. planResume refuses a running run, so that pairing should not happen
   * in production — this makes it harmless rather than relying on that.
   */
  private readonly tmpName: string;
  private chain: Promise<void> = Promise.resolve();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Monotonic per-instance ordinal, assigned to every event that passes through `record()`. */
  private seq = 0;
  private readonly runLogCapBytes: number;
  /** How many bytes of run.log this instance has written so far, seeded from the file's own size on reopen — see seedRunLogBytes. */
  private runLogBytes = 0;
  /** Output lines dropped once the cap was reached; reported once, in a `log:truncated` line, at the run's terminal event. */
  private outputDropped = 0;

  /**
   * `existing` is the resume path: rather than seeding a fresh manifest, carry
   * on the one already on disk — its `steps` are the record a resumed run
   * continues, and reseeding them from the plan would erase the very history
   * resume exists to keep. What *is* cleared is each entry the resume will
   * re-execute (see `resetUnfinished`), which is not history but a stale
   * verdict on work about to happen again. Use `RunJournal.reopen` rather than
   * passing it directly.
   */
  constructor(init: RunJournalInit, existing?: RunManifest) {
    const now = new Date().toISOString();
    this.runDir = init.runDir;
    this.tmpName = `run.json.${process.pid}.${nextJournalSeq()}.tmp`;
    this.runLogCapBytes = init.runLogCapBytes ?? DEFAULT_RUN_LOG_CAP_BYTES;
    this.manifest = existing === undefined
      ? {
          version: MANIFEST_VERSION,
          runId: init.runId,
          workflow: init.workflow,
          workdir: init.workdir,
          dryRun: init.dryRun,
          pid: process.pid,
          startedAt: now,
          updatedAt: now,
          heartbeatAt: now,
          status: 'running',
          workflowSource: init.workflowSource,
          inputs: init.inputs,
          ...(init.attachments === undefined || init.attachments.length === 0
            ? {} : { attachments: init.attachments }),
          // Held by reference, not copied: runWorkflow mints interactive
          // session ids into this same object, so they have to be minted
          // before the journal is constructed or the eager write below
          // records an empty map.
          sessionIds: init.sessionIds,
          steps: init.steps.map(s => ({
            id: s.id, kind: s.kind, loopId: s.loopId, runner: s.runner, model: s.model,
            mode: s.mode, status: s.disabled ? 'disabled' as const : 'pending' as const,
          })),
        }
      : {
          ...existing,
          pid: process.pid,
          status: 'running',
          updatedAt: now,
          heartbeatAt: now,
          // A resumed run is not over, and no longer carries its last failure.
          endedAt: undefined,
          ok: undefined,
          error: undefined,
          manualPending: undefined,
          resumedAt: [...(existing.resumedAt ?? []), now],
          steps: existing.steps.map(resetUnfinished),
        };
    // Every run must read as 'running' on disk immediately, not once its first
    // event lands. A run directory with no run.json reads back as
    // `status: 'unknown'` (see readRunSummary), and 'unknown' is not what the
    // guards check: planResume refuses a *running* run so two resumes cannot
    // race, and pruneRuns skips a *running* run so retention cannot delete a
    // live one. Both guards are only as good as what a concurrent reader sees
    // in the window before the first write — and with auto-naming that window
    // is up to SUGGEST_TIMEOUT_MS wide, not a few microseconds.
    this.persist();
    // First on the chain, so it settles before any scheduled run.log append
    // runs: a reopened run's cap has to account for what a previous attempt
    // already wrote, or a few resumes could blow well past runLogCapBytes.
    this.chain = this.chain.then(() => this.seedRunLogBytes());
    this.startHeartbeat(init.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  }

  private async seedRunLogBytes(): Promise<void> {
    try {
      this.runLogBytes = (await stat(join(this.runDir, RUN_LOG_NAME))).size;
    } catch {
      this.runLogBytes = 0;
    }
  }

  /**
   * Continues a stopped run's journal. The manifest is the one `planResume`
   * read; a restarted step patches its own entry through `beginStep` rather
   * than appending a duplicate, which is what "the retry overwrites its failed
   * attempt" means on disk.
   */
  static reopen(
    runDir: string, manifest: RunManifest,
    opts: { heartbeatIntervalMs?: number; runLogCapBytes?: number } = {},
  ): RunJournal {
    return new RunJournal({
      runDir,
      runId: manifest.runId,
      workflow: manifest.workflow,
      workdir: manifest.workdir,
      dryRun: manifest.dryRun,
      inputs: manifest.inputs,
      sessionIds: manifest.sessionIds,
      // Ignored — `existing` supplies the steps.
      steps: [],
      ...(opts.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: opts.heartbeatIntervalMs }),
      ...(opts.runLogCapBytes === undefined ? {} : { runLogCapBytes: opts.runLogCapBytes }),
    }, manifest);
  }

  private startHeartbeat(intervalMs: number): void {
    this.heartbeat = setInterval(() => {
      this.manifest.heartbeatAt = new Date().toISOString();
      // A heartbeat is best-effort: its failure must not poison the write
      // chain that real events depend on.
      this.chain = this.chain.then(() => this.writeManifest().catch(() => {}));
    }, intervalMs);
    // Never hold the process open — a CLI run must still exit when it is done.
    this.heartbeat.unref?.();
  }

  /** Stops the heartbeat timer. Idempotent; safe to call after a terminal event. */
  close(): void {
    if (this.heartbeat === undefined) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /**
   * With loops a step id no longer identifies one execution, so `step:start`
   * resolves (and if need be appends) the entry this execution belongs to, and
   * every later event for that step patches whatever start last selected.
   * Iteration 1 reuses the seeded plan entry, so `steps[]` still reads as the
   * declared plan with the extra iterations appended after each step.
   */
  private readonly current = new Map<string, ManifestStep>();

  private beginStep(stepId: string, iteration: number | undefined, patch: Partial<ManifestStep>): void {
    const wanted = iteration ?? 1;
    let entry = this.manifest.steps.find(s => s.id === stepId && (s.iteration ?? 1) === wanted);
    if (entry === undefined) {
      entry = { id: stepId, kind: 'agent', status: 'pending' };
      // findLastIndex is newer than the desktop app's compile target, and this
      // module is shared with it.
      let lastSameId = -1;
      for (let i = this.manifest.steps.length - 1; i >= 0; i--) {
        if (this.manifest.steps[i].id === stepId) { lastSameId = i; break; }
      }
      if (lastSameId === -1) this.manifest.steps.push(entry);
      else this.manifest.steps.splice(lastSameId + 1, 0, entry);
    }
    Object.assign(entry, patch);
    this.current.set(stepId, entry);
  }

  /** The entry a step's events apply to: the one in flight, else its latest. */
  private findStep(stepId: string): ManifestStep | undefined {
    return this.current.get(stepId) ?? [...this.manifest.steps].reverse().find(s => s.id === stepId);
  }

  private upsertStep(stepId: string, patch: Partial<ManifestStep>): void {
    const existing = this.findStep(stepId);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      this.manifest.steps.push({ id: stepId, kind: 'agent', status: 'pending', ...patch });
    }
  }

  /**
   * Merges one progress report into the step's summary. Prose is skipped: it
   * belongs to the live transcript, and a step whose only progress was talking
   * has nothing worth persisting.
   */
  private foldProgress(stepId: string, progress: StepProgress): void {
    if (progress.kind === 'text') return;
    const entry = this.findStep(stepId);
    if (entry === undefined) return;
    const next = { ...entry.progress };
    if (progress.kind === 'tool') {
      next.lastAction = progress.target === undefined
        ? progress.tool
        : `${progress.tool} ${progress.target}`;
    } else {
      if (progress.turns !== undefined) next.turns = progress.turns;
      if (progress.costUsd !== undefined) next.costUsd = progress.costUsd;
      if (progress.premiumRequests !== undefined) next.premiumRequests = progress.premiumRequests;
    }
    entry.progress = next;
  }

  /**
   * Once the run is over no step can still be in flight. Without this a
   * cancelled or errored run leaves its last step at 'running' on disk
   * forever, and every reader renders a spinner that never resolves.
   * `failedStepId` is the step the run:error blames — it failed outright;
   * anything else that was mid-flight was merely cut short.
   *
   * Blame is authoritative over the step's own last event, including a
   * 'done' one. A step's tail — the read-only guard, the artifact assertion,
   * the verdict parse (see finishStep in runner.ts) — all run *after* its
   * child has exited, so `step:done` records 'done' before any of them can
   * refuse. A row reading 'done' means "the process exited 0", not "the step
   * succeeded". Leaving it alone is what makes a run unresumable for good:
   * resetUnfinished and planResume both treat 'done' as final, so the step
   * can never be re-run and its missing artifact never reappears.
   *
   * No separate step:failed event: fail() emits run:error and run:done in the
   * same breath and returns a terminal result, so the stepId on run:error is
   * the whole signal — a second event would carry nothing extra.
   */
  private finalizeRunningSteps(now: string, failedStepId?: string): void {
    // The execution in flight, else the latest with that id: a loop runs the
    // same id many times, and only the current one is the one that failed.
    const blamed = failedStepId === undefined ? undefined : this.findStep(failedStepId);
    if (blamed !== undefined && blamed.status !== 'failed') {
      blamed.status = 'failed';
      // Keep the real end time when step:done already recorded one; only a
      // step that never got that far needs one invented here.
      blamed.endedAt ??= now;
    }
    for (const step of this.manifest.steps) {
      if (step.status !== 'running' || step === blamed) continue;
      step.status = 'interrupted';
      step.endedAt = now;
    }
  }

  /**
   * Returns the ordinal this event was assigned, so the caller (runner.ts's
   * `emit`) can hand the same number to `frontend.onEvent` — live and on-disk
   * readers then agree on order down to the same integer, not just the same
   * millisecond. Monotonic per process attempt; a resume's journal starts its
   * own instance and its own count, same as events.ndjson already restarting
   * mid-file across a resume.
   */
  record(event: WhiphandEvent): number {
    const now = new Date().toISOString();
    const seq = (this.seq += 1);
    this.manifest.updatedAt = now;
    switch (event.type) {
      case 'run:start':
        break; // manifest already seeded at construction
      case 'run:resume':
        break; // manifest already reopened by RunJournal.reopen
      case 'step:skipped':
        // The entry it names is already 'done'. Only events.ndjson records the
        // fact that this execution was reused rather than re-run.
        break;
      case 'step:start':
        this.beginStep(event.stepId, event.iteration, {
          kind: event.kind, runner: event.runner, model: event.model, mode: event.mode,
          loopId: event.loopId, iteration: event.iteration,
          status: 'running', startedAt: now, endedAt: undefined, exitCode: undefined,
          artifact: undefined, verdict: undefined,
        });
        break;
      case 'step:spawn':
        // The moment the conversation is created — and the only honest signal
        // that there is one to resume later. Harvest reuses the session the
        // main phase opened, so it says nothing new.
        if (event.phase === 'main' && this.findStep(event.stepId)?.mode === 'interactive') {
          this.upsertStep(event.stepId, { sessionStarted: true });
        }
        break; // updatedAt only
      case 'step:artifact':
        this.upsertStep(event.stepId, { artifact: event.path });
        break;
      case 'step:progress':
        // The fold still feeds the manifest step summary and run.json — see
        // foldProgress. The event itself reaches schedule() below, which
        // routes it to run.log only (same as step:log): a chatty step can
        // emit hundreds of these, and events.ndjson plus a structuredClone
        // rewrite of run.json per line, while the desktop polls that same
        // file, is exactly the cost step:log already avoids the same way.
        this.foldProgress(event.stepId, event.progress);
        break;
      case 'step:artifact-missing':
      case 'step:timeout':
      case 'step:retry':
      case 'step:log':
      case 'session:await':
      case 'session:ended':
      case 'step:pty-exit':
      case 'run:env':
      case 'step:tree-delta':
        break; // updatedAt (and, for step:log, run.log) only — nothing folded into the manifest
      case 'step:verdict':
        // A verdict is only ever emitted for a step that ran to completion —
        // core fails the run before this point otherwise. So the step is done,
        // whatever its exit code was: a `verdict: true` command that exits 1 is
        // reporting a result, not failing. exitCode stays recorded either way.
        this.upsertStep(event.stepId, { verdict: event.verdict, status: 'done' });
        break;
      case 'step:done':
        this.upsertStep(event.stepId, {
          status: event.exitCode === 0 ? 'done' : 'failed',
          exitCode: event.exitCode,
          endedAt: now,
        });
        break;
      case 'step:manual':
        this.manifest.manualPending = { stepId: event.stepId, title: event.request.title };
        break;
      case 'step:manual-resolved':
        this.manifest.manualPending = undefined;
        break;
      case 'loop:start':
        this.upsertStep(event.loopId, {
          kind: 'loop', status: 'running', startedAt: now, iterations: 0,
          maxIterations: event.maxIterations, endedAt: undefined, verdict: undefined,
        });
        break;
      case 'loop:iteration':
        this.upsertStep(event.loopId, {
          iterations: event.iteration, maxIterations: event.maxIterations,
        });
        break;
      case 'loop:done':
        this.current.delete(event.loopId);
        this.upsertStep(event.loopId, {
          status: event.passed ? 'done' : 'failed',
          iterations: event.iterations,
          verdict: event.passed ? 'pass' : 'fail',
          endedAt: now,
        });
        break;
      case 'guard:warning':
        break; // updatedAt only
      case 'run:done':
        // A cancelled run's status is final; the run:done ok:false that
        // follows must not demote it back to 'failed'.
        if (this.manifest.status !== 'cancelled') {
          this.manifest.status = event.ok ? 'succeeded' : 'failed';
        }
        this.manifest.ok = event.ok;
        this.manifest.endedAt = now;
        this.manifest.manualPending = undefined;
        this.finalizeRunningSteps(now);
        break;
      case 'run:error':
        this.manifest.status = 'failed';
        this.manifest.manualPending = undefined;
        this.manifest.error = { stepId: event.stepId, message: event.message };
        this.finalizeRunningSteps(now, event.stepId);
        break;
      case 'run:cancelled':
        this.manifest.status = 'cancelled';
        this.manifest.endedAt = now;
        this.manifest.manualPending = undefined;
        this.finalizeRunningSteps(now);
        break;
    }
    if (TERMINAL_EVENTS.has(event.type)) this.close();
    this.schedule(event, now, seq);
    return seq;
  }

  private async writeManifest(): Promise<void> {
    await writeManifestAtomic(this.runDir, this.manifest, this.tmpName);
  }

  /**
   * `step:log` and `step:progress` — the merged output feed — go to run.log
   * only, and skip the manifest entirely: `step:log` folds nothing into it,
   * and `step:progress`'s fold already happened in record() (foldProgress),
   * so paying for a `structuredClone` plus an atomic rewrite on what are by
   * far the highest-frequency events in the system would be pure waste.
   * Every other event goes to events.ndjson, run.log and a manifest rewrite.
   */
  private schedule(event: WhiphandEvent, ts: string, seq: number): void {
    if (event.type === 'step:log' || event.type === 'step:progress') {
      if (this.manifest.dryRun) return; // same "bookkeeping only" contract as below
      const logLine = formatLogLine({ seq, ts, ...summarizeEvent(event) });
      this.chain = this.chain.then(() => this.appendRunLog(logLine, true));
      return;
    }
    const line = `${JSON.stringify({ ts, seq, event })}\n`;
    const logLine = formatLogLine({ seq, ts, ...summarizeEvent(event) });
    // Snapshotted synchronously, before joining the chain, so writes land on
    // disk in call order and a later one can never persist an earlier state.
    const snapshot = structuredClone(this.manifest);
    const isTerminal = TERMINAL_EVENTS.has(event.type);
    // A dry run spawns nothing and writes no step output, so run.log would be
    // nothing but the audit spine — and the existing dry-run contract is
    // "bookkeeping only" (events.ndjson, run.json, the workflow snapshot).
    const skipRunLog = this.manifest.dryRun;
    this.chain = this.chain.then(async () => {
      await appendFile(join(this.runDir, 'events.ndjson'), line, 'utf8');
      if (!skipRunLog) {
        await this.appendRunLog(logLine, false);
        if (isTerminal && this.outputDropped > 0) {
          await this.appendRunLog(
            formatLogLine({
              seq, ts,
              kind: 'log:truncated',
              text: `${this.outputDropped} output line(s) dropped once run.log reached its `
                + `${this.runLogCapBytes}-byte cap; audit entries were unaffected`,
            }),
            false,
          );
        }
      }
      await writeManifestAtomic(this.runDir, snapshot, this.tmpName);
    });
  }

  /**
   * Applies the per-run byte cap (0 disables it): audit entries always land,
   * but an output line stops landing once the cap is hit — dropping the
   * merged feed rather than rotating the file, which would break "one file
   * you can open". The drop itself is only noted once the run ends (see
   * schedule's terminal-event handling), with an accurate total — a note
   * written the instant the cap trips could only ever guess how many more
   * lines would follow.
   */
  private async appendRunLog(line: string, isOutputLine: boolean): Promise<void> {
    const bytes = Buffer.byteLength(line, 'utf8');
    const overCap = this.runLogCapBytes > 0 && this.runLogBytes + bytes > this.runLogCapBytes;
    if (overCap && isOutputLine) {
      this.outputDropped += 1;
      return;
    }
    this.runLogBytes += bytes;
    await appendFile(join(this.runDir, RUN_LOG_NAME), line, 'utf8');
  }

  /**
   * Records the working tree as the run stopped, for a later resume to diff
   * against. Deliberately not folded into `record()`: taking the snapshot is
   * async and `record()` is synchronous by design, so the caller
   * (`runWorkflow`'s finally) does the awaiting and hands over the digest.
   */
  noteStoppedTree(digest: string): void {
    this.manifest.stoppedTree = digest;
    this.persist();
  }

  /** Schedules one atomic write of the manifest as it stands right now. */
  private persist(): void {
    const snapshot = structuredClone(this.manifest);
    this.chain = this.chain.then(() => writeManifestAtomic(this.runDir, snapshot, this.tmpName));
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

/**
 * POSIX rename(2) replaces the target atomically however many others are
 * renaming onto it. Windows does not: MoveFileEx fails outright when the
 * target is held for even a moment — by another journal's rename over the same
 * run dir, which the per-instance tmpName above already accounts for, or by a
 * virus scanner or search indexer that opened run.json to read it. All of
 * those clear in milliseconds, and a lost manifest write does not, so retry
 * briefly before giving up. Inert on POSIX, where none of these arise.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 20;
const RENAME_RETRY_MS = 10;

/** Exported for its own test — nothing else should need to substitute `op`. */
export async function renameReplacing(
  from: string, to: string, op: (f: string, t: string) => Promise<void> = rename,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await op(from, to);
      return;
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      await delay(RENAME_RETRY_MS);
    }
  }
}

/** tmp+rename so a reader never observes a half-written manifest. */
async function writeManifestAtomic(
  runDir: string, manifest: RunManifest, tmpName: string,
): Promise<void> {
  const tmpPath = join(runDir, tmpName);
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  await renameReplacing(tmpPath, join(runDir, 'run.json'));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface RunSummaryKnown extends RunManifest {
  runDir: string;
  locked: boolean;
  /**
   * The run's display label, from the `.name` marker rather than run.json —
   * see run-name.ts for why it lives beside the manifest instead of in it.
   * Absent for a run that was never named.
   */
  name?: string;
}

export interface RunSummaryUnknown {
  runId: string;
  runDir: string;
  status: 'unknown';
  locked: boolean;
  name?: string;
  /**
   * When the run directory itself was last touched. 'unknown' covers two very
   * different things — a run in the few filesystem operations before its first
   * manifest write, and a directory whose run.json is missing or corrupt — and
   * this is what separates them, so retention can skip the first and still
   * collect the second. See pruneRuns.
   */
  mtimeMs: number;
}

export type RunSummary = RunSummaryKnown | RunSummaryUnknown;

export type RunDetail = RunSummary & { artifacts: Array<{ name: string; path: string }> };

/**
 * A manifest still claiming 'running' is abandoned when the process that owned
 * it is gone. Two independent arms, because neither alone is sufficient:
 *  - a dead pid catches the ordinary crash/SIGKILL;
 *  - a stalled heartbeat catches a recycled pid (which makes a dead run look
 *    alive) and a run whose owner is still up but stopped driving it.
 * The heartbeat arm only applies when heartbeatAt is present, so manifests
 * written before heartbeats existed fall back to the pid check alone.
 */
function isAbandoned(manifest: RunManifest, now: number): boolean {
  if (manifest.status !== 'running') return false;
  if (!isAlive(manifest.pid)) return true;
  if (manifest.heartbeatAt === undefined) return false;
  return now - Date.parse(manifest.heartbeatAt) > HEARTBEAT_STALE_MS;
}

/**
 * Finalizes an abandoned manifest: the run and whatever step was in flight
 * become 'interrupted', steps that never started stay pending, and the run
 * gets an end time so its duration stops growing on every poll.
 */
function repairAbandoned(manifest: RunManifest): RunManifest {
  const endedAt = manifest.heartbeatAt ?? manifest.updatedAt;
  const interruptedStep = manifest.steps.find(s => s.status === 'running');
  return {
    ...manifest,
    status: 'interrupted',
    endedAt,
    ok: false,
    steps: manifest.steps.map(s =>
      s.status === 'running' ? { ...s, status: 'interrupted' as const, endedAt } : s),
    error: manifest.error ?? { stepId: interruptedStep?.id, message: INTERRUPTED_MESSAGE },
  };
}

async function readRunSummary(runDir: string, dirName: string, mtimeMs = 0): Promise<RunSummary> {
  const locked = await isRunLocked(runDir);
  // Overlaid onto the manifest exactly as `locked` is: both are marker files,
  // and neither is something run.json could carry safely while a run is live.
  const named = await readRunName(runDir);
  const name = named === undefined ? {} : { name: named };
  let raw: string;
  try {
    raw = await readFile(join(runDir, 'run.json'), 'utf8');
  } catch {
    return { runId: dirName, runDir, status: 'unknown', locked, mtimeMs, ...name };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { runId: dirName, runDir, status: 'unknown', locked, mtimeMs, ...name };
  }
  const parsed = runManifestSchema.safeParse(json);
  if (!parsed.success) {
    return { runId: dirName, runDir, status: 'unknown', locked, mtimeMs, ...name };
  }
  const manifest = parsed.data;
  if (!isAbandoned(manifest, Date.now())) return { ...manifest, runDir, locked, ...name };

  const repaired = repairAbandoned(manifest);
  // Write the repair back so the state is final: readers stop re-deriving it,
  // and a later pid reuse can't resurrect the run. Idempotent — the repaired
  // status is terminal, so a subsequent read never reaches here. Best-effort:
  // an unwritable run dir must not break listRuns, so the caller still gets
  // the repaired view either way. A distinct tmp name keeps this from ever
  // colliding with a live journal's own run.json.tmp.
  const tmpName = `run.json.repair.${process.pid}.tmp`;
  try {
    await writeManifestAtomic(runDir, repaired, tmpName);
  } catch {
    await unlink(join(runDir, tmpName)).catch(() => {});
  }
  return { ...repaired, runDir, locked, ...name };
}

export async function listRuns(workdir: string, config: WorkspaceConfig): Promise<RunSummary[]> {
  const dir = join(workdir, config.artifacts_dir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const summaries: RunSummary[] = [];
  for (const entry of entries) {
    const runDir = join(dir, entry);
    const st = await stat(runDir).catch(() => null);
    if (!st || !st.isDirectory()) continue;
    summaries.push(await readRunSummary(runDir, entry, st.mtimeMs));
  }
  summaries.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
  return summaries;
}

/**
 * A runId is only ever used as a single path segment joined under the
 * artifacts dir. Reject anything that could escape that segment (`..`,
 * embedded separators, absolute paths, or empty) before it ever reaches
 * `join` — a client-supplied runId must never be able to point `getRun` (or
 * any caller built on it, e.g. the agent's readArtifact/cancelRun) at an
 * arbitrary directory.
 */
export function isSafeRunId(runId: string): boolean {
  return runId.length > 0 && runId !== '.' && runId !== '..' && basename(runId) === runId;
}

/**
 * Files the run dir keeps for its own bookkeeping — never a step's output.
 * Session markers and await state are left on disk as a record of how the
 * session went; the runner's pre-clean is what keeps a re-run honest.
 *
 * Every one of them lives at the top of the run dir, and only there is a name
 * a bookkeeping name: an attached `run.json` under `attachments/`, or a loop
 * step whose output is `events.ndjson`, is an ordinary file and must be listed.
 */
function isBookkeepingFile(name: string): boolean {
  return name === 'run.json' || name === 'events.ndjson' || name === RUN_LOG_NAME || name.endsWith('.tmp')
    || name === LOCK_MARKER_NAME || name === NAME_MARKER_NAME
    || name === SUGGEST_CAPTURE_NAME
    || name === WORKFLOW_SNAPSHOT_NAME
    || isEndMarkerName(name) || isAwaitStateName(name);
}

export async function getRun(
  workdir: string, config: WorkspaceConfig, runId: string,
): Promise<RunDetail | null> {
  if (!isSafeRunId(runId)) return null;
  const runDir = join(workdir, config.artifacts_dir, runId);
  const st = await stat(runDir).catch(() => null);
  if (!st || !st.isDirectory()) return null;

  const summary = await readRunSummary(runDir, runId, st.mtimeMs);
  const artifacts = await listArtifacts(runDir);
  return { ...summary, artifacts };
}

export interface RenameRunResult {
  renamed: boolean;
  /** The stored name after the call; absent when the run has none. */
  name?: string;
}

/**
 * Sets or clears one run's display label. Lives here rather than in
 * run-name.ts so it can go through `isSafeRunId` — the guard every id-based
 * lookup passes through — without run-name.ts having to import this module
 * back. `null` (or a name that normalizes to nothing) clears it.
 *
 * Renaming a *running* run is allowed on purpose: the marker file is exactly
 * what makes that safe, and a long run is the one you most want to label.
 */
export async function renameRun(
  workdir: string, config: WorkspaceConfig, runId: string, name: string | null,
): Promise<RenameRunResult> {
  if (!isSafeRunId(runId)) return { renamed: false };
  const runDir = join(workdir, config.artifacts_dir, runId);
  const st = await stat(runDir).catch(() => null);
  if (!st || !st.isDirectory()) return { renamed: false };
  await setRunName(runDir, name);
  const stored = await readRunName(runDir);
  return stored === undefined ? { renamed: true } : { renamed: true, name: stored };
}

/**
 * Every artifact under the run dir, including the per-iteration subdirectories
 * a loop writes. Names stay relative to the run dir ('fix/iter-2/report.md'),
 * which is what readArtifact resolves against — so the loop's history is
 * reachable, not just its last pass.
 */
async function listArtifacts(runDir: string): Promise<Array<{ name: string; path: string }>> {
  const out: Array<{ name: string; path: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (dir === runDir && isBookkeepingFile(entry.name)) continue;
      out.push({ name: relative(runDir, full).split(sep).join('/'), path: full });
    }
  };
  await walk(runDir);
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
