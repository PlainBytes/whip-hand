# Restart a run from its failed step

**Status:** approved design, not yet implemented
**Date:** 2026-09-06

## Problem

A run that fails on step four throws away steps one to three. The most common cause is
not a bad workflow but a temporarily unavailable model — a rate limit, a 5xx, a dropped
network — and the only recovery today is `mc run` from the top, which re-spends every
token already spent and re-asks every question already answered.

Nothing about the engine makes this necessary. `runWorkflow` already records everything a
restart needs, it just has no way to read it back:

- `RunJournal` writes one manifest entry per **execution**, with `status`, `artifact`,
  `verdict`, `loopId` and `iteration` (`packages/core/src/engine/manifest.ts`).
- Artifacts are addressed deterministically — `<runDir>/<output>` at the top level,
  `<runDir>/<loopId>/iter-N/<output>` inside a loop (`engine/artifacts.ts`).
- `sessionIds` minted for interactive steps are persisted in the manifest.
- `readRunSummary` already repairs an abandoned run to `interrupted`, so "is this run
  still alive?" is an answered question.

The single blocker is that `runWorkflow` unconditionally calls `createRunDirFor`
(`runner.ts`), so every invocation is a new run.

## Decisions

Settled during brainstorming, recorded so the plan does not relitigate them:

1. **Manual resume only.** No automatic retry, no backoff, no classifying a failure as
   transient. The human decides when the model is back. Auto-retry is a later feature
   that would sit *on top* of this one; see Out of scope.
2. **Resume in place.** Same `runId`, same directory, same `run.json`. Completed steps
   keep their artifacts; the restarted step patches its existing manifest entry rather
   than appending a second one.
3. **`failed`, `interrupted` and `cancelled` all resume**, restarting at the first step
   that is not `done`. All three leave the same shape of half-finished run.
4. **Snapshot the workflow; warn on tree drift.** A resumed run executes the workflow
   that actually ran, not whatever the file says now. A changed working tree is reported
   and does not block.
5. **Reuse the agent session where the runner can.** In practice this means claude only;
   see "Interactive sessions".
6. **Mid-iteration loop restart.** A failure in iteration 2 keeps iteration 1 *and*
   whatever iteration 2 already produced, and restarts at the failed step.
7. **The retry overwrites its failed attempt's artifact.** No `.attempt-N` files.
8. **`mc run --resume <runId>`**, a flag on the existing command rather than a new one.

## Design

### What makes a run resumable

`resumable(summary)` is true when `status` is `failed`, `interrupted` or `cancelled`.
A `running` manifest is refused — `readRunSummary` has already downgraded genuinely
abandoned runs to `interrupted`, so anything still claiming `running` has a live owner,
and two processes writing one run directory would corrupt it.

The `.locked` marker means *exempt from retention pruning*, not *in use*. It must not
block a resume. These are two different ideas that happen to share a word, and conflating
them would make locking a run mean you can never restart it.

### Restart by skipping, not by jumping

This is the load-bearing decision; everything else follows from it.

The obvious implementation computes an address — "top-level index 3", or "loop `fix`,
iteration 2, body index 1" — and teaches the walk to start there. That means new
arithmetic for nested loops, for `on_findings: loop`'s backward jumps, and for restoring
the `ctx` a mid-loop start assumes.

Instead, `runWorkflow` takes an optional resume plan and **replays the walk from the
top**, skipping any execution the manifest already records as `done`. A skipped step
spawns nothing, touches no files, and restores its recorded artifact into `ctx`.

Mid-iteration restart then falls out with no address arithmetic anywhere: iterations 1..N-1
replay as all-skips, iteration N skips its finished body steps, and execution genuinely
resumes at the first step that is not done. Nested loops work by the same mechanism.

In `executeStep`, before the `step:start` emit:

```ts
const recorded = resume?.done.get(executionKey(step.id, frame?.iteration));
if (recorded !== undefined) {
  if (recorded.artifact !== undefined) recordArtifact(step.id, recorded.artifact);
  emit({ type: 'step:skipped', stepId: step.id, ...frameFields(frame) });
  if (!step.verdict) return null;
  verdict = recorded.verdict;
  return recorded.verdict === 'fail' ? 'verdict-fail' : null;
}
```

**Restoring the verdict is not optional.** A skipped `verdict: true` step drives a loop's
`passed` flag and the top-level `on_findings: loop` jump. If a skip returned `null`
unconditionally, a loop that originally failed twice would replay as passing on iteration
1 and the resumed run would take a different path than the one it is supposedly
continuing.

Loop *nodes* are deliberately never skipped as a unit, even when the loop's own entry
says `done`. Descending and skipping inside is what restores every body artifact into
`ctx` in the right order; the replay costs no spawns, and the loop's recorded verdicts
make it terminate at the same iteration it did the first time.

`executionKey(id, iteration)` — `id` for iteration 1 or no loop, `id#N` beyond — is the
convention the desktop store already uses (`apps/desktop/src/state/store.ts`), and the
same `iteration ?? 1` defaulting `RunJournal.beginStep` matches entries by. Core has no
such helper today: `beginStep` compares the two fields directly. Resume should export one
from core rather than invent a third spelling, and the desktop's copy can later be
re-pointed at it — a tidy-up, not a prerequisite.

### `engine/resume.ts`

One new module, deliberately separate from `runner.ts`, which is already 595 lines:

```ts
export interface ResumePlan {
  runId: string;
  runDir: string;
  workflow: Workflow;                       // parsed from the run's snapshot
  inputs: Record<string, string>;
  sessionIds: Record<string, string>;
  artifacts: Record<string, string>;        // stepId -> latest, for forward references
  attempts: Record<string, string[]>;
  /** Executions the manifest records as done, keyed by executionKey. */
  done: Map<string, { artifact?: string; verdict?: 'pass' | 'fail' }>;
  /** Ids whose interactive session may be resumed rather than minted afresh. */
  resumedStepIds: Set<string>;
  /** First not-done execution — for the "resuming at 'execute'" line only. */
  restartAt: { stepId: string; iteration?: number } | undefined;
  warnings: string[];
}

export async function planResume(
  workdir: string, config: WorkspaceConfig, runId: string,
): Promise<ResumePlan>;   // throws ResumeError when the run cannot be resumed
```

`planResume` does all the reading and all the refusing; `runWorkflow` receives a plan it
can trust. That split is what makes the interesting logic testable against fixture run
directories without spawning anything.

`runWorkflow` gains `resume?: ResumePlan`. When present it skips `createRunDirFor`, seeds
`ctx` from the plan, and reopens the journal instead of constructing one.

### Reopening the journal

`RunJournal` gains a static `reopen(runDir, manifest)`: keep the recorded `steps` array
as-is, set `status` back to `running`, take the current `pid`, clear `endedAt`, `ok` and
`error`, restart the heartbeat, and append to the existing `events.ndjson`.

Because a restarted step patches its existing entry through `beginStep` (`failed` →
`running` → `done`), **no new manifest-entry semantics are needed** — which is exactly
what decision 7 implies. The manifest keeps reading as one entry per execution.

New optional manifest fields, all following the `progress` / `heartbeatAt` back-compat
precedent, with **no version bump**:

```ts
resumedAt: z.array(z.string()).optional(),   // one ISO stamp per resume
stoppedTree: z.string().optional(),          // tree digest when the run stopped
```

The workflow snapshot is a file, not a field — see below.

### The workflow snapshot

At run start, write the resolved workflow source to `<runDir>/workflow.yaml`. Resume
parses that, never the current file. Two consequences worth having beyond resume: a
finished run becomes self-describing, and the desktop can eventually show what a run
actually executed.

`isBookkeepingFile` in `manifest.ts` must exclude `workflow.yaml` from the artifact
listing, or it appears as a step output in the Artifacts tab.

Every run recorded before this ships has no snapshot. Those fall back to re-resolving the
workflow by `manifest.workflow` from the workspace, with a warning that the definition may
have changed since. A resume whose fallback also fails — the workflow was renamed or
deleted — is refused with that as the reason.

### Tree drift

The naive check is wrong in an instructive way. Comparing the tree now against the tree at
run *start* would flag every `writes: true` step's own legitimate output, so a resumed run
would always warn.

The correct comparison is **the tree when the run stopped versus the tree now**, using
`snapshotTree(workdir)` / `diffSnapshots` — already in the codebase for the read-only git
guard.

Where that snapshot is taken matters. The obvious home is `RunJournal.record`'s terminal
cases, next to `finalizeRunningSteps` — but `record()` is deliberately **synchronous**
(it fire-and-forget schedules onto an internal promise chain, because core calls
`frontend.onEvent` synchronously), and `snapshotTree` is async. So the snapshot is taken
in `runWorkflow`'s own `finally` block, which is already async and already the last thing
to touch the journal, and handed over through a new `journal.noteStoppedTree(digest)`
that sets the field and schedules one write.

A run whose process was killed never reached that `finally` and has no `stoppedTree`. Say
so and skip the check rather than pretending the tree is unchanged.

Warnings are surfaced and the resume proceeds, per decision 4.

### Interactive sessions

Two facts constrain this more than the decision implies:

- **copilot cannot participate.** It declares `sessionIdInjection: false` — `--session-id`
  *resumes* on copilot and cannot mint — so mc never records a session id for a copilot
  step. There is nothing to resume, and it falls back to a fresh session automatically.
  Its `sessionResume: true` capability is about a flag mc does not currently drive.
- **claude's `interactive()` mints.** It passes `--session-id <uuid>`, which creates;
  resuming the same conversation needs `--resume <uuid>`, as `harvest()` already does
  (`adapters/claude.ts`). The adapter must therefore be *told* the step is a retry.

So `RunCtx` gains one optional field:

```ts
/** Steps whose recorded session should be resumed rather than minted afresh. */
resumedStepIds?: ReadonlySet<string>;
```

claude's `interactive()` switches `--session-id` to `--resume` for a step in that set that
has a recorded id. Every other adapter ignores the field and behaves exactly as today,
which is the whole reason it is on `RunCtx` rather than a new adapter method.

If the recorded session no longer exists on disk the step fails, and the run stays
resumable. The escape hatch is `mc run --resume <id> --fresh-session`, which empties
`resumedStepIds` — a flag rather than fallback logic that tries to distinguish "session
gone" from "model unavailable" by exit code.

### Events

Two additive `McEvent` members, with their Zod mirrors in `packages/core/src/events.ts`:

```ts
| { type: 'run:resume'; runId: string; workflow: string; from?: string }
| { type: 'step:skipped'; stepId: string; loopId?: string; iteration?: number }
```

`run:resume` replaces `run:start` for a resumed run rather than joining it: a second
`run:start` would read as a second run to every consumer.

That distinction has a concrete consequence in the agent. `runJobInBackground` populates
`runIdBox.current` from `run:start` so that every `mcEvent` notification carries a
`runId`; it must do the same for `run:resume`, or the desktop cannot correlate a resumed
run's events with the run it is displaying.

`step:skipped` is what stops a resumed run from looking like it did nothing for its first
three steps. `RunJournal` appends it to `events.ndjson` for the audit trail and patches
nothing — the entry it refers to is already `done`.

### Surfaces

**CLI** — `mc run --resume <runId>`, with the workflow ref becoming optional. Passing both
a workflow ref and `--resume` is an error: the snapshot decides what runs, so a ref could
only ever contradict it. `--dry-run --resume` is likewise refused, since a dry run mints
no artifacts and so cannot honour the skip set. `--yes`, `--json` and `--max-iterations`
all carry over unchanged; `--max-iterations` applies to the iterations still to come.

`renderEvent` gains a `run:resume` header and a dim `(reused)` line for `step:skipped`, in
the existing house style.

**Agent** — `resumeRun { workdir, runId }` → `{ jobId }`, reusing the whole existing job
machinery: `runJobInBackground` branches to `planResume` + `runWorkflow({ resume })`
instead of resolving a workflow path. It deliberately does **not** call `rememberRun`;
that records workflow + inputs for the New Run dialog's prefill, and a resume introduces
neither.

**Desktop** — a **Resume** button on `RunDetailPage`, beside "Run again", shown when the
run is resumable. The store handles the two new events: `step:skipped` marks a step
reused. The stepper needs no structural change — a skipped step is just a step that is
already `done`.

## Testing

Follows the existing per-package split.

- **core**
  - `planResume` against fixture run directories: a top-level failure, a failure in
    iteration 2 of a loop, an `interrupted` run, a `cancelled` run, a run with no
    workflow snapshot (falls back, warns), a `succeeded` run (refused), a live `running`
    run (refused), and a run whose snapshot is unparseable (refused, with the reason).
  - Skip semantics in `runner.ts`: a resumed run spawns nothing for done steps; a skipped
    `verdict: fail` step still drives its loop round again; a skipped `verdict: pass`
    step still ends its loop; a resumed loop terminates at the same iteration it did
    originally.
  - Mid-iteration restart: iteration 1's and iteration 2's completed artifacts survive,
    and only the failed step onwards re-runs.
  - `RunJournal.reopen`: status returns to `running`, `error` clears, the restarted
    step's entry is patched rather than duplicated, `events.ndjson` is appended to, and a
    manifest carrying neither `resumedAt` nor `stoppedTree` still parses.
  - The workflow snapshot is written at run start and excluded from `getRun`'s artifacts.
  - `claude.interactive()` emits `--resume` for a step in `resumedStepIds` and
    `--session-id` otherwise; `copilot.interactive()` is unaffected by the field.
- **cli** — `--resume` with a workflow ref is rejected; `--resume --dry-run` is rejected;
  `renderEvent` output for both new events.
- **agent** — `resumeRun` returns a jobId and drives a run; `mcEvent` notifications for a
  resumed run carry a `runId` (the `run:resume` / `runIdBox` coupling above); `resumeRun`
  against a non-resumable run fails cleanly rather than throwing.
- **desktop** — store reducers for `run:resume` and `step:skipped`; the Resume button
  appears only for a resumable run and calls `resumeRun`.

## Sequencing

Each step is shippable on its own, and the first two are useful even if the rest slipped.

1. **Workflow snapshot.** Write `workflow.yaml` at run start; exclude it from the
   artifact listing. No behaviour change, and it is the thing resume cannot be correct
   without.
2. **Manifest additions.** `resumedAt`, `stoppedTree`, `journal.noteStoppedTree`, and
   taking the snapshot in `runWorkflow`'s `finally`. Still no behaviour change.
3. **`engine/resume.ts`.** `planResume`, `ResumeError`, and its fixture tests. Nothing
   calls it yet.
4. **`RunJournal.reopen`.**
5. **Runner.** `resume?: ResumePlan`, the skip predicate, the two new events. This is the
   step that makes resume work, and the one whose loop and verdict tests matter most.
6. **Adapter session resume.** `RunCtx.resumedStepIds` and claude's `--resume` branch.
7. **CLI.** `--resume`, `--fresh-session`, the two renderer cases.
8. **Agent.** `resumeRun` plus the `runIdBox` fix.
9. **Desktop.** Store reducers and the Resume button.

## Risks

- **Replaying `on_findings: loop`.** The legacy top-level jump path keeps state the
  manifest does not record — `extraFindings` and `loopsUsed` — and rebuilds it during
  replay purely from restored verdicts. This is the most likely place for a resumed run
  to diverge from the run it continues, and it needs its own test at every branch.
- **A partially-modified tree.** A `writes: true` step that edited three files and then
  failed re-runs against those edits. Warn-only is a deliberate choice (decision 4);
  solving it properly needs snapshot-and-revert, which is a much larger feature.
- **Non-idempotent command steps.** A `command` step that ran `git commit` or `npm
  publish` before a later step failed will run again on resume. mc cannot know which
  commands are safe to repeat. Document it; do not guess.
- **A vanished session.** Covered by `--fresh-session`, but it is a second thing to try
  rather than something that heals itself.
- **Concurrent resume.** Two windows resuming one run would both write its `run.json`.
  The `running`-status refusal closes the ordinary case; the residual race between two
  simultaneous `planResume` calls is not closed, and is worth a follow-up if resume ever
  becomes something automation drives.

## Out of scope

- **Automatic retry with backoff.** Decision 1. It belongs *inside* a step rather than
  around a run, and this design is what would give it somewhere to fall back to. It also
  needs failure classification — telling a rate limit from a bad prompt — which is its
  own research problem against two third-party CLIs.
- **Resuming from an arbitrary earlier step** (`--from <stepId>`). The plan already
  computes `restartAt`; letting a human override it is a small addition once the skip
  machinery exists, and a distraction before that.
- **The new-run-inheriting model.** Considered and rejected in favour of resuming in
  place (decision 2).
- **Reverting the working tree** to its state when the run stopped.
- **Resuming a `succeeded` run** to re-run its last step. That is "Run again" with extra
  steps.

## Follow-on

The `maxIterations` field being added on the `run-step-display` branch records a loop's
iteration budget in the manifest. Once that lands, a resumed loop should prefer the
recorded budget over re-deriving it from config, so that a config change between the
original run and the resume cannot silently change how many iterations the run is allowed.
Not a dependency — resume works without it — but the two should be reconciled rather than
left to drift.
