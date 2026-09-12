/**
 * Single source of truth for all shared whiphand types.
 * Every other module imports from here; nothing here imports from elsewhere.
 */

export type StepMode = 'interactive' | 'headless';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type OnFindings = 'report' | 'loop' | 'interactive';

/**
 * Where a workflow definition or a config layer lives: this workspace's own
 * `.whiphand/`, or the user-level directory under resolveConfigHome() that every
 * workspace on the machine shares. One word, used identically across core,
 * the RPC protocol, the CLI (`--global`) and the UI (a "Global" badge) — no
 * second name for the same idea anywhere in the stack.
 */
export type Scope = 'project' | 'global';

/**
 * What a step *is*. `agent` is the original (and only) kind and stays the
 * default, so every workflow written before kinds existed parses unchanged.
 */
export type StepKind = 'agent' | 'command' | 'manual' | 'approval' | 'loop';

export interface WorkflowInput {
  required: boolean;
  prompt?: string;
  default?: string;
  /** Desktop New-run prefill hint only; the CLI never reads it. Absent means false. */
  remember?: boolean;
}

/** Fields shared by every step that produces an artifact and can be referenced. */
export interface StepCommon {
  id: string;
  /** ids of other steps whose artifacts feed this one, or the reserved ref `attachments`. */
  inputs?: string[];
  output?: string;          // artifact filename within the run dir
  /**
   * Turns this step into a pass/fail signal instead of a hard failure: an
   * agent's `VERDICT:` line, a command's exit code, a human's choice. A loop's
   * `until` names such a step.
   */
  verdict?: boolean;
  /**
   * Absent means enabled — every workflow written before this existed parses
   * unchanged. No schema default: a default would serialise `enabled: true`
   * onto every step in every file on first save.
   */
  enabled?: boolean;
}

/** An LLM runner invocation — the original `Step`. */
export interface AgentStep extends StepCommon {
  kind: 'agent';
  runner: string;
  model?: string;
  mode: StepMode;
  writes: boolean;
  prompt: string;
  output: string;           // required: an agent step must name its artifact
  allow_paths?: string[];
  effort?: EffortLevel;
}

/** A shell command. Deterministic, spends no tokens, needs no runner. */
export interface CommandStep extends StepCommon {
  kind: 'command';
  run: string;                       // shell line, templated
  shell?: string;                    // default '/bin/sh'
  cwd?: string;                      // relative to workdir; default workdir
  env?: Record<string, string>;
  timeout_ms?: number;
  /** Exit codes that count as success. Default [0]. */
  expect_exit?: number[];
}

export type ManualChoice = 'continue' | 'abort' | 'retry';

/**
 * A human checkpoint. `approval` is the same machinery under a clearer name.
 *
 * `capture: 'note'` asks for one free-text box, required to `continue`.
 * `capture: 'review'` asks for an overall comment plus, when `show_diff` is
 * also set, a comment per file — required to `retry`, which is how a human
 * sends work back to the agent instead of only shipping it or aborting.
 */
export interface ManualStep extends StepCommon {
  kind: 'manual' | 'approval';
  title: string;
  instructions: string;              // templated
  capture?: 'note' | 'review';
  /** Show the working tree's `git diff` alongside the instructions. */
  show_diff?: boolean;
  /** What `whiphand run --yes` picks when there is no human to ask. */
  default?: 'continue' | 'abort';
}

/** A cycle: run `steps` until the `until` step passes, or the budget runs out. */
export interface LoopStep {
  kind: 'loop';
  id: string;
  steps: Step[];
  /** Body step id whose verdict ends the loop. Must have `verdict: true`. */
  until: string;
  max_iterations?: number;           // default: config.loop.max_iterations
  on_exhausted?: OnFindings;         // default: the resolved on_findings value
  /** Disabling a loop takes its whole body with it — see StepCommon.enabled. */
  enabled?: boolean;
}

export type Step = AgentStep | CommandStep | ManualStep | LoopStep;

export interface Workflow {
  name: string;
  description?: string;
  inputs?: Record<string, WorkflowInput>;
  on_findings?: OnFindings;
  steps: Step[];
}

export interface SessionEndSpec {
  markerPath: string;    // absolute; its appearance means the human agreed we're done
  quitSequence: string;  // text written to the pty for a clean exit ('' = go straight to SIGTERM)
}

export interface AwaitStateSpec {
  /** absolute; the runner's hooks write an await-state body here, or remove it */
  statePath: string;
}

export interface SpawnSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;  // EXTRA env only; frontend merges process.env
  interactive: boolean;
  // Set only by adapters' interactive(): how this session can end itself.
  // Frontends that cannot watch for the marker (the CLI, which hands the child
  // the real tty) may ignore it — the human quits by hand as before.
  endSession?: SessionEndSpec;
  // Set only by adapters' interactive(), and only for runners that can report
  // it. Frontends that cannot watch the filesystem ignore it exactly as they
  // ignore endSession; the terminal-bell channel still works there.
  awaitState?: AwaitStateSpec;
  /**
   * The frontend tees the child's output to this file while still forwarding
   * it, so a command's output survives as a referenceable artifact. Frontends
   * that ignore it lose the artifact, so core asserts the file afterwards
   * rather than trusting it blindly.
   *
   * `streams` says which of them the *file* gets; both are forwarded either
   * way. It defaults to 'both', which is what a command step's `.log` artifact
   * wants — a failing command's diagnosis is usually on stderr. `suggestName`
   * sets 'stdout', because there the file is not an artifact for a human but
   * an answer read back verbatim as the run's name: a runner warning printed
   * before a perfectly good reply would otherwise end up in the name, and from
   * there in the branch and worktree names steps derive from `run.slug`.
   */
  capture?: { path: string; streams?: 'stdout' | 'both' };
  /**
   * Set only by adapters' headless(): the child was asked for structured
   * output, and its stdout is a progress stream rather than prose. Frontends
   * that honour it hand each stdout line to spawnHeadless's `onLine` instead
   * of forwarding it as log output; frontends that ignore it simply show no
   * progress, exactly as before.
   */
  progress?: { format: ProgressFormat };
}

export type ProgressFormat = 'claude-stream-json' | 'copilot-jsonl';

/**
 * What a headless step is doing right now, normalized across runners.
 * Parsed by engine/progress.ts from the runner's structured stdout.
 */
export type StepProgress =
  /** Assistant prose. Feeds the transcript only — too noisy for a summary. */
  | { kind: 'text'; text: string }
  /** A tool call. Feeds both the transcript and the step card's last action. */
  | { kind: 'tool'; tool: string; target?: string }
  /**
   * Counters for the summary. Every field is optional because the runners
   * report different things: claude gives turns and a dollar cost, copilot
   * gives turns and `premiumRequests` — it has no dollar figure to give, and
   * we do not invent one. Elapsed time is deliberately absent: core measures
   * it, so the timer works even for a runner that reports nothing at all.
   */
  | { kind: 'usage'; turns?: number; costUsd?: number; premiumRequests?: number };

/** Where we are inside a loop, when we are inside one. */
export interface LoopFrame {
  id: string;
  iteration: number;      // 1-based
  maxIterations: number;
}

export interface RunCtx {
  workdir: string;                       // absolute
  runId: string;
  runDir: string;                        // absolute
  /**
   * The run's display label, as of this process's start. Absent when unnamed.
   *
   * Frozen for the life of the process on purpose: a rename mid-run must not
   * change the slug a step already used to name a branch or a worktree, and
   * `{{ run.name }}` must never disagree with `{{ run.slug }}` inside one run.
   * A resumed run is a new process, so it picks up the current name.
   */
  runName?: string;
  /** Path/ref-safe form of runName, falling back to runId. Never empty. */
  runSlug: string;
  sessionIds: Record<string, string>;    // stepId -> minted uuid (claude only)
  /**
   * stepId -> latest artifact path. Inside a loop this is exactly what a
   * forward reference wants: the later step has not run again yet, so its
   * entry still holds the previous iteration's artifact.
   */
  artifacts: Record<string, string>;
  /** stepId -> every artifact path it has written this run, oldest first. */
  attempts: Record<string, string[]>;
  inputs: Record<string, string>;        // resolved workflow input values
  loop?: LoopFrame;
  /**
   * Steps whose recorded session should be resumed rather than minted afresh.
   * Set only on a resumed run; adapters that cannot resume a session ignore it
   * and behave exactly as they always have.
   */
  resumedStepIds?: ReadonlySet<string>;
  /**
   * Absolute paths of the files attached to this run, under
   * `<runDir>/attachments/`. Kept apart from `artifacts`, which maps one step
   * id to one path and which a resume rebuilds from executions — attachments
   * exist before step one and belong to no step.
   */
  attachments?: string[];
}

/**
 * One file the operator attached when starting a run: a path on this machine,
 * or bytes that never had one (a pasted image). A `path` is always absolute.
 */
export type AttachmentSource = { path: string } | { name: string; bytes: Uint8Array };

/** How a run records one attachment in run.json and on its `run:start` event. */
export interface RunAttachment {
  /** Final file name, after sanitizing and deduplication. */
  name: string;
  /** Relative to the run directory, '/'-separated: `attachments/<name>`. */
  path: string;
  size: number;
  /** The original absolute path, or 'pasted' for bytes that had none. */
  source: string;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
  /** Things worth telling the user about this runner's setup, not errors. */
  notes?: string[];
}

/** One model a harness says it can run, as reported by `RunnerAdapter.listModels`. */
export interface ModelInfo {
  /** What a step's `model:` field takes. */
  id: string;
  /** Short human name, e.g. "Sonnet". Falls back to `id` when absent. */
  label?: string;
  description?: string;
  /** What `id` resolves to, when the harness names it (e.g. `sonnet` -> `claude-sonnet-5`). */
  resolves?: string;
}

/**
 * What `RunnerAdapter.listModels` answers: the models it currently knows about,
 * and how confident that list is.
 *
 * - `live` — asked the harness itself just now (or a merge of that with static
 *   aliases; live entries still win the merge).
 * - `fallback` — the harness could not be asked (not installed, logged out,
 *   timed out, malformed reply); these are static aliases only, but they are
 *   the harness's own well-known ids, so the editor still warns when a value
 *   matches none of them.
 * - `unavailable` — no list at all (a runner with no `listModels`, or one whose
 *   own probe found nothing usable); the editor behaves exactly as it did
 *   before this feature existed: free text, no warnings.
 */
export interface ModelList {
  source: 'live' | 'fallback' | 'unavailable';
  models: ModelInfo[];
  /** Shown beside the field, e.g. "couldn't query claude; showing built-in aliases". */
  note?: string;
}

export interface RunnerAdapter {
  id: string;
  capabilities: {
    sessionIdInjection: boolean;
    sessionResume: boolean;
    toolDenial: boolean;
    shareTranscript: boolean;
  };
  detect(): Promise<DetectResult>;
  interactive(step: AgentStep, ctx: RunCtx): SpawnSpec;
  headless(step: AgentStep, ctx: RunCtx): SpawnSpec;
  harvest(step: AgentStep, ctx: RunCtx): SpawnSpec;
  /**
   * One cheap, read-only question whose whole answer is its stdout, captured
   * to `capturePath` — the same `SpawnSpec.capture` plumbing command steps
   * already use, so no frontend needs to learn anything new.
   *
   * Optional, and its absence *is* the capability check: an adapter that does
   * not implement it simply never auto-names a run. Used only by run
   * auto-naming (`runs.auto_name`), which is why it takes a prompt rather than
   * a step — there is no step here, and no artifact to write.
   */
  suggestName?(prompt: string, ctx: RunCtx, capturePath: string): SpawnSpec;
  /**
   * What models this harness currently offers, for the workflow editor's
   * Model field. Optional, and its absence *is* the capability check — same
   * precedent as `suggestName?` — so a runner with no way to ask simply never
   * gets a picker; the field stays free text with no warnings. Must never
   * reject: any failure is a `ModelList` with `source: 'fallback'` or
   * `'unavailable'`, not a thrown error.
   */
  listModels?(): Promise<ModelList>;
}

export interface WorkspaceConfig {
  defaults: { runner: string };
  on_findings: OnFindings;
  loop: { max_iterations: number };
  artifacts_dir: string;                 // relative to workdir, default '.whiphand/runs'
  runs: {
    // null: inherit the app-level preference. 0: keep everything. n >= 1: keep n.
    max_retained: number | null;
    /**
     * Ask the default runner to name a run that was started without one.
     * Off by default: it is an extra (small) spawn and an extra (small) spend
     * before every run, and a run reads perfectly well as its id without it.
     */
    auto_name: boolean;
    /** Per-file cap, in megabytes, on what `whiphand run --attach` may copy into a run. */
    max_attachment_mb: number;
  };
}

/**
 * What core hands a frontend when a step needs a human. Everything the
 * frontend must render is already resolved here — core never reads a file or
 * a terminal on the frontend's behalf.
 */
export interface ManualRequest {
  stepId: string;
  kind: 'manual' | 'approval';
  title: string;
  instructions: string;                  // templated, ready to render
  choices: ManualChoice[];               // 'retry' only appears inside a loop
  capture?: CaptureSpec;
  context: {
    artifacts: Array<{ id: string; path: string }>;
    diff?: string;                       // present when show_diff, bounded
  };
  /** What a non-interactive frontend should pick under `--yes`. */
  defaultChoice: 'continue' | 'abort';
  loop?: LoopFrame;
}

/** What core hands a frontend so it knows how to ask for, and require, text. */
export interface CaptureSpec {
  kind: 'note' | 'review';
  label: string;                       // 'Note' | 'Feedback'
  /** Choices that cannot be answered without it. */
  requiredFor: ManualChoice[];         // note: ['continue']; review: ['retry']
  /** Whether the frontend should offer per-file comments. */
  perFile: boolean;                    // note: false; review: true
}

/** One comment left against a single file in a `capture: 'review'` answer. */
export interface FileComment { path: string; body: string }

export interface ManualResponse {
  choice: ManualChoice;
  note?: string;                       // the overall comment
  comments?: FileComment[];            // per-file, in the order left
}

export type WhiphandEvent =
  /**
   * `source` is present whenever the workflow was resolved from a ref
   * (absent for `on_findings: interactive`'s triage sessions, which have no
   * ref of their own) — CLI's run-start line is where it surfaces, "no
   * mention" for the common project case and "(global)" only when it isn't,
   * so a global-heavy setup doesn't get a warning line on every run.
   */
  | {
      type: 'run:start'; runId: string; workflow: string; source?: Scope; name?: string;
      /** The files attached to this run, by final name. Absent when there are none. */
      attachments?: Array<{ name: string; size: number }>;
    }
  /**
   * A stopped run is being continued from its first unfinished step. Replaces
   * `run:start` rather than joining it: a second `run:start` would read as a
   * second run to every consumer. `from` names the step it restarts at.
   */
  | {
      type: 'run:resume'; runId: string; workflow: string; from?: string; name?: string;
      /** Which iteration of `from`'s loop this resume is about to run, when `from` is a loop body step. */
      iteration?: number;
    }
  | {
      type: 'step:start'; stepId: string; kind: StepKind; runner?: string;
      model?: string; mode?: StepMode; loopId?: string; iteration?: number;
    }
  /**
   * This execution completed in an earlier attempt, so a resumed run did not
   * run it again. Its artifact is restored; nothing was spawned.
   */
  | { type: 'step:skipped'; stepId: string; loopId?: string; iteration?: number }
  | { type: 'step:spawn'; stepId: string; spec: SpawnSpec; phase: 'main' | 'harvest' }
  | { type: 'step:artifact'; stepId: string; path: string }
  /**
   * A headless step reported what it is doing. Ephemeral: RunJournal folds the
   * counters into the manifest but neither logs it to events.ndjson nor lets it
   * schedule a manifest write — see the note on RunJournal.schedule.
   */
  | { type: 'step:progress'; stepId: string; progress: StepProgress }
  | { type: 'step:verdict'; stepId: string; verdict: 'pass' | 'fail' }
  | { type: 'step:done'; stepId: string; exitCode: number }
  | { type: 'step:manual'; stepId: string; request: ManualRequest }
  | { type: 'step:manual-resolved'; stepId: string; choice: ManualChoice }
  | { type: 'loop:start'; loopId: string; maxIterations: number }
  | { type: 'loop:iteration'; loopId: string; iteration: number; maxIterations: number }
  | { type: 'loop:done'; loopId: string; iterations: number; passed: boolean }
  | { type: 'guard:warning'; message: string }
  | { type: 'run:done'; runId: string; ok: boolean }
  | { type: 'run:error'; stepId?: string; message: string }
  | { type: 'run:cancelled'; runId: string };

export interface Frontend {
  // resolves with exit code; signal is an optional trailing param so existing
  // implementations stay assignment-compatible
  runInteractive(spec: SpawnSpec, signal?: AbortSignal): Promise<number>;
  /**
   * Asks the human. Optional for the same assignment-compatibility reason:
   * a frontend without it simply cannot run workflows that contain manual
   * steps, and validateWorkflowFrontend says so before anything spawns.
   */
  runManual?(request: ManualRequest, signal?: AbortSignal): Promise<ManualResponse>;
  onEvent(event: WhiphandEvent): void;
}
