# Staged plans: one plan, many stages, a gate per stage

**Status:** design agreed 2026-09-08 (six grilling rounds); not yet implemented
**Date:** 2026-09-08

## Problem

`mc` handles a feature that fits in one plan. The canonical workflow plans once into
`plan.md`, then implements and reviews it in a cycle until the review passes
(`.mc/workflows/feature-development.yaml`).

That falls apart on a large feature. One `plan.md` for a fortnight of work is a document
no implementer step can hold, no reviewer step can check against a diff, and no human can
usefully approve — the sign-off at the end is over a change too big to read. What we want
instead is what a careful engineer does by hand: cut the work into stages, build one
stage, review it, accept it, commit it, then start the next one on top.

The engine cannot express that today, for one specific reason: **the step tree is static.**
`flattenSteps` (`packages/core/src/steps.ts:42`) expands the workflow once, up front, to
seed the run manifest and the desktop stepper. A `kind: loop` repeats a fixed body *until a
verdict passes*, bounded by `max_iterations` — a budget, not a list. Nothing can say "run
this body once per item in a set we won't know until the plan exists".

Three requirements shaped everything below:

- **A cycle must not require a plan step.** The stages may have been planned in an earlier
  run, by another tool, or by hand.
- **Context stays minimal.** Each stage gets a fresh agent with a clean context and only
  the information it needs. Not just a smaller diff to review — a smaller prompt to reason
  from.
- **Accepting is per stage**, where the change is still small enough to read.

## Decisions

1. **A second cycle kind, `stages`.** `loop` answers "how many times until it passes";
   `stages` answers "once per stage". Two narrow kinds read more clearly and carry less
   conditional logic than one kind with two modes. The step kind, the prose, the UI label
   and the template namespace all say the same word — `stage` — per this codebase's rule
   that one idea gets one name across core, RPC, CLI and UI.
2. **The plan lives in the repository, not the run directory.** `.mc/runs/` is gitignored
   and `pruneRuns` deletes it; a plan there is uncommitted and eventually destroyed. Stage
   files live at a path named by a workflow **input** (`plan_dir`), so the same directory
   serves a run that plans and a run that only builds.
3. **The stage list is re-read before every stage**, matched by stage id. A human editing
   a later stage mid-run — during triage, say — takes effect. This is what makes
   "re-planning mid-run" a thing a human just *does* in an editor rather than a feature.
4. **A stage is one clean agent context.** The implementer for stage N is a fresh headless
   session receiving the stage file and nothing else. Earlier stages are *committed*, so
   their work is visible in the tree and the git log at zero prompt cost.
5. **No new gate concept.** A gate per stage is a `kind: approval` step in the body.
6. **When retries run out, hand over to a human**: an interactive triage session, then the
   run stops — and can be resumed from that stage afterwards.
7. **Committing is a `command` step the author writes.** The engine never runs git on the
   author's behalf. What the engine adds is the missing seam: a command step's `inputs:`
   become `$MC_ARTIFACT_<ID>` environment variables.
8. **Frames become a stack.** The only change to existing machinery, and it is forced: a
   `loop` nested inside a `stages` must not write every stage's `iter-1/execute-report.md`
   to the same path.
9. **Sequential, one working tree.** No concurrency, no worktrees, no merge.

## Design

### The step

```yaml
name: staged-feature
inputs:
  feature:  { required: true, prompt: What are we building? }
  plan_dir: { required: true, remember: true, prompt: "Plan directory (e.g. docs/plans/oauth)" }

steps:
  - id: plan
    runner: claude
    model: opus
    mode: interactive
    writes: true
    allow_paths: ["{{ inputs.plan_dir }}/**"]
    output: plan.md
    prompt: |
      We are planning: {{ inputs.feature }}.
      Cut the work into stages small enough to review in one sitting. Write one file per
      stage into {{ inputs.plan_dir }}/, named NN-slug.md, each opening with a `# Title`
      heading. Write nothing outside that directory.

  - id: commit-plan
    kind: command
    run: git add -A -- "$MC_PLAN_DIR" && git commit -m "plan: $MC_RUN_NAME"
    expect_exit: [0, 1]
    env: { MC_PLAN_DIR: "{{ inputs.plan_dir }}" }
    output: commit-plan.log

  - id: build
    kind: stages
    items: "{{ inputs.plan_dir }}/*.md"
    max_retries: 2
    steps:
      - id: cycle
        kind: loop
        until: review
        max_iterations: 3
        steps:
          - id: execute
            runner: claude
            model: sonnet
            mode: headless
            writes: true
            inputs: [stage]              # the stage file, and nothing else
            output: execute-report.md
            prompt: |
              Implement stage {{ stage.index }} of {{ stage.total }}: {{ stage.title }}.
              Earlier stages are implemented and committed — read the tree or `git log`
              if you need them. Implement only this stage.

          - id: review
            runner: claude
            model: opus
            mode: headless
            writes: false
            verdict: true
            inputs: [stage, execute]
            output: review.md
            prompt: Review the working-tree diff against this stage only.

      - id: accept
        kind: approval
        title: "Stage {{ stage.index }}/{{ stage.total }}: {{ stage.title }}"
        instructions: Accept this stage before the next one starts.
        show_diff: true
        inputs: [stage, review]
        output: accept.md

      - id: commit
        kind: command
        inputs: [execute]
        run: git add -A && git commit -m "$MC_STAGE_TITLE" -m "$(cat "$MC_ARTIFACT_EXECUTE")"
        expect_exit: [0, 1]              # 1 is git's "nothing to commit"
        output: commit.log
```

Read top to bottom, that is the whole feature: plan into files, commit the plan, then for
each stage cycle until the review passes, ask a human, commit, move on.

### Stage discovery

`items` is a single templated glob string — no `from:`, no index file, no union to
validate. (Q7 left the choice between `items: { path: ... }` and the flat form open; the
flat form is written here because it is the smaller of the two and nothing else needs the
object.) Ordering is the sorted filename, hence the `01-schema.md` convention; a human
inserting a stage uses `03a-`, which sorts correctly and never renumbers a completed
stage. That matters because `stage.id` is what re-discovery matches on.

```ts
export interface Stage {
  index: number;     // 1-based, recomputed each pass
  total: number;
  id: string;        // filename slug, leading NN- ordinal stripped
  title: string;     // first markdown heading, falling back to id
  path: string;      // absolute
}
```

The list is re-globbed **before each stage**, and the current position found by matching
`stage.id` against the last completed one. Editing or adding a later stage takes effect;
editing a completed stage does not rewind; a stage disappearing ends the step cleanly
rather than erroring. An empty list on the first pass fails the step — a `stages` that
matched nothing is a broken plan, not a finished one.

### `stage` is a pseudo-artifact, not a new attachment mechanism

`buildPrompt` (`packages/core/src/template.ts`) turns `inputs: [plan]` into a line naming
`ctx.artifacts.plan`. So "attach this stage's file" is: seed `ctx.artifacts.stage =
stage.path` when the frame opens. `inputs: [stage]` then works with no change to prompt
assembly, to `manual.ts`'s artifact rail, or to the desktop review overlay — the stage file
appears as another rail entry beside the diff. **`stage` is a reserved step id**, rejected
by the schema so a workflow cannot shadow it.

`renderTemplate`'s placeholder regex gains `stage.(index|total|id|title)` alongside
`loop.*` and `run.*`. Referencing `stage.*` outside a `stages` step is a `TemplateError`.

### Per-stage scope is what makes minimal context real

`ctx.artifacts` is one flat `stepId → path` map for the whole run. Left alone, stage 2's
`execute` would resolve `inputs: [review]` to **stage 1's** review — the loop
forward-reference idiom leaking across stages — and `extraFindings`, which is never
cleared, would tell every later stage that "a previous review found problems" pointing at
stage 1's file.

So entering a stage snapshots `ctx.artifacts` and `extraFindings` and restores them on
exit. Body steps see this stage's work plus anything recorded before the `stages` step
began. Two saves and two restores in `executeStages`; without them the minimal-context
guarantee is not real.

There is deliberately **no `prev.*` escape hatch**. The committed tree is the shared state
between stages, and it is a better one: it cannot go stale and costs no tokens until the
agent asks.

### A frame stack

`RunCtx.loop?: LoopFrame` becomes `RunCtx.frames: Frame[]`, innermost last:

```ts
export type Frame =
  | { kind: 'loop';   id: string; iteration: number; maxIterations: number }
  | { kind: 'stages'; id: string; stage: Stage; attempt: number };
```

`ctx.loop` survives as a derived getter over the innermost `loop` frame, so
`{{ loop.iteration }}`, `ManualRequest.loop` and every existing `LoopFrame` consumer keep
working unchanged.

`artifactPath` joins one directory segment per frame instead of taking a single optional
one — loop frames give `<id>/iter-<n>` exactly as today, stage frames give
`<id>/<NN>-<stage.id>` plus `/retry-<n>` on a second attempt — so the example writes
`.mc/runs/<run>/build/02-api/cycle/iter-1/execute-report.md`. Without the stack every
stage's cycle collides on `cycle/iter-1/`.

`executionKey(stepId, iteration)` generalizes to `executionKey(stepId, frameKey?)` over
the same segments, preserving today's "iteration 1 is the bare step id" rule. That is what
keeps **resume** working: the manifest already records one entry per execution and
`skippable` is already keyed by execution.

**Nesting.** Two sibling `stages` steps are legal. `stages` inside `stages`, and `stages`
inside a `loop`, are rejected at schema level — the first has no use case and multiplies
frame depth and artifact volume; the second re-runs an entire staged plan on a failing
verdict, which is an author mistake best discovered from an error rather than a bill.

### Retry, exhaustion, and the handover

The nested `loop` handles the machine's retries: a failing review sends the stage round
again, bounded by `max_iterations`, as today.

`stages` handles the human's. A `verdict-fail` reaching the `stages` step from its body —
in practice a rejected gate, since `retry` maps to a failing verdict through
`verdictFromChoice` — redoes the same stage from the top, up to `max_retries` (default 2,
no config key, and **not** overridden by `--max-iterations`, which means "how hard should
the machine try", not "how many times may I be told no"). The rejection note is injected
through the existing `extraFindings` path (`runner.ts:334`), scoped to the stage.

**An exhausted review cycle inside a `stages` step reaches the gate** rather than ending
the run. Today `executeLoop` calls `fail()` on exhaustion, which would kill the run before
the human ever sees the work. Inside a `stages` frame it returns `'verdict-fail'` upward
instead, the gate's instructions say the review never passed, and `review` is forced onto
the artifact rail even if the author did not list it — so a human can accept, retry or
abort with the diff in front of them. `on_exhausted: interactive` becomes the escape hatch
an author *chooses*. Outside a `stages` step, `loop` behaviour is unchanged.

When `max_retries` runs out, `runTriage` opens a live session seeded with the stage file,
the findings and the rejection note, and the run stops. `runTriage` currently requires an
agent step as its source and warns otherwise; here the trigger is a rejected gate, so it
builds the session from the nearest preceding `writes: true` agent step in the body, which
`loopTargetIndex` (`runner.ts:99`) already finds. **A run that ended in triage is
resumable from that stage** — the human has just spent a session fixing exactly that.

`abort` at a gate still fails the run immediately, unchanged.

### Manual steps carry verdicts implicitly

`finishStep` returns early when `!step.verdict` (`runner.ts:304`), so a human choosing
`retry` at a gate that did not set `verdict: true` is silently swallowed and read as
`continue`. A manual step's answer *is* a verdict, and `verdictFromChoice` already maps
`retry → fail`.

So **manual and approval steps inside any frame are implicitly verdict-bearing.** The
blast radius is small: a passing verdict from a mid-body step only matters if that step is
the loop's `until`, and `until` already requires `verdict: true` at schema level. `retry`
is the case that actually changes, and today it is broken.

### Verdicts and how a run ends

`verdict` is a single mutable value overwritten by the last verdict step, so a stage-3
review that failed but was accepted would leave the run reading `failed`. **The human's
acceptance is authoritative**: accepting a stage clears the failing verdict, and a run
whose every stage was accepted ends `ok`. The record of what actually happened lives in
the manifest and the artifacts, not in a trailing boolean.

### `--yes` must be declared, not assumed

`defaultChoice` is `continue`, so `mc run --yes` would auto-accept every stage — turning a
staged workflow into "implement all seven stages unattended", the exact thing this feature
exists to prevent, at full token cost. A workflow with a gate inside a `stages` step is
**refused at validation time** unless that gate writes `default: continue` explicitly. CI
and scripted runs still work; they opt in per gate.

### `allow_paths` becomes real

`allow_paths` is declared in `types.ts:55`, validated in `schema.ts:42` and editable in the
desktop's `StepCard.tsx:300` — and read by nothing. It is a field the UI invites you to
fill in that does nothing.

The plan moving into the repo forces the planner to `writes: true`, losing the one thing
we could previously *prove* about a planning step: that it changed nothing. So
`allow_paths` is implemented, as a post-step assertion reusing the machinery that already
runs for every read-only step — `snapshotTree`/`diffSnapshots` produce the changed-path
list, enforcement is a glob match over it and a `fail()` naming the offending file.

### Command steps gain `inputs` and stage environment

`inputs` is already on `StepCommon` and already filtered by `scopeInputs`, but
`commandSpec` never reads it. It now exports each one as an environment variable —
`inputs: [execute]` → `MC_ARTIFACT_EXECUTE=<path>`, id uppercased with non-alphanumerics
folded to `_` — beside the `MC_RUN_*` variables it already sets. Inside a stage frame it
also sets `MC_STAGE_ID`, `MC_STAGE_TITLE`, `MC_STAGE_INDEX`, `MC_STAGE_TOTAL` and
`MC_STAGE_PATH`.

Environment rather than interpolation, for the reason `commandSpec` already gives about
run names: a title is arbitrary human text and pasting it into a `sh -c` string is a
quoting hazard.

A command step's own `env:` values become templated too — `run:` and `cwd:` already are,
and the `commit-plan` step above needs `MC_PLAN_DIR: "{{ inputs.plan_dir }}"` to reach a
shell line safely. Two lines in `commandSpec`, and it removes the last reason to
interpolate a path into a shell string.

**A failing `commit` step fails the run**, loudly and at the right place: the error names
the stage and says the work is accepted but uncommitted, so a human can commit by hand and
resume. It is never papered over with `|| true` — a silent non-commit is the worst
outcome, because every later stage's clean-context guarantee assumes the previous stage is
in the history.

### Edge cases with settled answers

- **A stage with no diff** is a normal stage — the gate's instructions say "this stage
  produced no changes" so the human decides knowingly, and `commit` exits 1 into
  `expect_exit`. The gate is never skipped silently.
- **An interrupted stage** re-runs from scratch on resume, against a tree containing its
  own partial edits. The implementer's prompt says a previous attempt was interrupted and
  it should reconcile. The engine does not discard work it was not asked to discard, and
  per-stage commits keep the blast radius to one stage.

### Events, manifest, surfaces

```ts
| { type: 'stages:start'; id: string; total: number }
| { type: 'stages:item'; id: string; index: number; total: number; stageId: string; title: string; attempt: number }
| { type: 'stages:done'; id: string; completed: number }
```

The manifest's per-execution entries gain an optional `stage: { id, title, index }`
alongside `iteration`, and `version` gains `3` (v1/v2 still parse). `RunJournal.recordStep`
already appends an entry per execution and `RunStepper` already folds repeats into one
card with an expandable history, so the stepper work is largely labelling — the `stages`
group renders like a loop group reading `stage 2 of 7 · Add API routes`.

Full UI is part of this feature, not a follow-on:

- **Stepper**: stage groups named by stage, not "iteration".
- **Gate**: stage title, the stage file on the rail, and the "review never passed" / "no
  changes" notes where they apply.
- **Notifications**: body reads `Stage 3 of 7: Add API routes`, run name as the suffix it
  already carries; title stays stable so OS grouping still works.
- **Runs grid / Activity**: a run inside a `stages` step reports progress in stages, not
  raw step counts. `stages:item` already carries `index`/`total`.
- **Triage**: the existing xterm handoff, and a run that ended in triage reads "stopped at
  stage 3 after 2 rejections" on the run page rather than a bare `failed`.
- **Parity**: the suite proves CLI and desktop agree on stage progression.

## Testing

- `engine/stages.test.ts` — discovery, ordering, `03a-` insertion, slug and title
  extraction, re-read matching by id, added/removed/edited later stages, empty list.
- `runner.stages.test.ts` — one stage; several; a rejected stage retried then accepted;
  retries exhausted reaching triage; an exhausted inner loop reaching the gate; `abort`;
  cancellation mid-stage; per-stage artifact and findings scope.
- `artifacts.test.ts` — the frame stack, including a loop nested in a `stages` step not
  colliding across stages.
- `command.test.ts` — `MC_ARTIFACT_*` and `MC_STAGE_*`, including id folding.
- `git-guard.test.ts` — `allow_paths` enforcement, including a violation naming the file.
- `schema.test.ts` — reserved `stage` id; rejected nestings; `--yes` refusal.
- `resume.test.ts` — interrupted at stage 3 resumes at stage 3; resume after triage.
- `parity/` — desktop and CLI report the same stage progression.

## Build order

1. **Frame stack** — types, `artifactPath`, `executionKey`, the `ctx.loop` getter. No
   behaviour change; the existing suite must pass untouched.
2. **Command step `inputs` → env.**
3. **`allow_paths` enforcement.**
4. **Discovery, `stage.*` templating, the `stage` pseudo-artifact, reserved id.**
5. **`executeStages`** — scoped artifacts and findings, retries, the exhausted-loop change.
6. **Implicit manual verdicts + `--yes` validation refusal.**
7. **Events, manifest v3, resume including resume-after-triage.**
8. **CLI renderer.**
9. **Desktop** — stepper, gate copy, notifications, runs-grid progress, triage state.
10. **Parity.**
11. **Shipped `staged-feature` workflow, `mc init`, README, `docs/design.md`.**
12. **One real end-to-end run** against a genuine multi-stage change.

Steps 1–3 are independently mergeable and independently useful. Step 5 is the riskiest and
lands only once the frame stack has proven itself against the existing loop tests. The
real run is last because it is the only check that can fail for reasons none of the others
can see.

## Definition of done

`npm run verify` green (root typecheck/tests, parity, desktop tests and build,
`cargo check`); every test above; README and `docs/design.md` updated with the format
reference and the cycle/stage vocabulary; and the real end-to-end run.

## Out of scope

- **Parallel stages.** The `Stage` model and per-stage artifact directories leave room for
  it without a format break, but it needs a worktree per stage and a merge, and it is not
  wanted.
- **Dependency graphs between stages.** An ordered list, not a DAG.
- **Cross-stage artifact references (`prev.*`).** The committed tree is the shared state.
- **Engine-owned commits.** The engine never runs git on the author's behalf.
- **A workspace config key for `max_retries`.** Per-workflow only.
