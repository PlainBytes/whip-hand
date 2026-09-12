# Design: `whiphand` — a workflow runner for LLM CLIs

See `docs/research.md` for why this is being built rather than adopting Comanda or Archon.
This document is expected to change as implementation proceeds; treat it as current intent,
not a frozen record.

## Summary

`whiphand` executes **workflows**: an ordered list of steps against a working folder, each step
pinned to its own runner (`claude`, `copilot`, …), model, and tool policy. The canonical
workflow is *plan* interactively with Opus → *execute* headlessly with Copilot/GPT →
*review* headlessly with Haiku.

Decisions carried in from research and from direct discussion:

1. Node + TypeScript.
2. Plan-type steps are a **live interactive chat** in the terminal; execute/review steps
   run headless.
3. Plan and review steps are read-only; only execute steps may modify the working tree.
4. What happens after a review finds problems is **configurable per workspace**, not fixed
   by the tool.
5. A future frontend is planned as **Tauri**, not a web server or Electron app. This shapes
   the architecture from the start (see "The TTY seam" below) rather than being retrofitted.

## Why the two target CLIs make a thin adapter layer viable

All flags below were confirmed directly against `claude --help` and `copilot --help` on
the installed binaries (`claude` 2.1.252, `copilot` 1.0.60) — not taken from memory or
documentation that could be stale.

| Capability | `claude` | `copilot` |
|---|---|---|
| Interactive session, seeded with a prompt | `claude "<prompt>"` | `copilot` (interactive by default; a prompt can auto-execute) |
| Headless / non-interactive | `-p`, `--print` | `-p`, `--prompt <text>` |
| Model selection | `--model <alias\|full-id>` (e.g. `opus`, `claude-opus-5`) | `--model <id>` |
| Pin a specific session id | `--session-id <uuid>` (must be a valid UUID) | `--session-id <id>` |
| Resume a session | `-r, --resume [id]` | `-r, --resume[=id]` |
| Continue most recent | `-c, --continue` | `--continue` |
| Deny specific tools | `--disallowedTools <tools...>` | `--deny-tool[=tools...]` |
| Restrict to a tool allowlist | `--allowedTools <tools...>` | `--allow-tool[=tools...]`, `--available-tools[=tools...]` |
| Reasoning effort | `--effort low\|medium\|high\|xhigh\|max` | `--effort none\|low\|medium\|high\|xhigh\|max` |
| Extra working directories | `--add-dir <dirs...>` | `--add-dir <dir>`, `-C <dir>` |
| Structured output | `--output-format text\|json\|stream-json` (NDJSON needs `--verbose`) | `--output-format json --stream on` (JSONL, one object per line) |
| Transcript export | — (use resume harvest, below) | `--share[=path]`, `--share-gist` |

The two CLIs are close to isomorphic on exactly the primitives a workflow runner needs:
model selection, session identity, resumability, and tool policy. That symmetry is what
makes a thin, uniform adapter interface viable instead of one bespoke integration per CLI.

## Architecture

Three layers, split specifically so a future Tauri app can reuse everything except
terminal rendering:

```
packages/core     workflow schema + validation, run engine, adapter registry,
                  artifact store, JSON event stream. No terminal I/O, and it
                  never itself spawns an interactive step.
packages/cli      the `whiphand` binary. Renders core's events to the terminal, and
                  is the thing that owns the TTY for interactive steps.
apps/desktop      (future) Tauri. Consumes the same event stream as the CLI;
                  attaches the operator to interactive steps via its own PTY
                  widget instead of inherited stdio.
```

### The TTY seam

This is the one decision made specifically because a Tauri frontend is planned, not
because the CLI needs it today. A Tauri webview cannot inherit the CLI process's stdio the
way a child process can — it needs to own its own pseudo-terminal. If `core` spawned
interactive processes directly with `stdio: 'inherit'`, every future frontend would be
stuck re-implementing or fighting that assumption.

So `core` never spawns an interactive step itself. It resolves the step into a
`SpawnSpec` and hands it to whichever frontend is running:

```ts
type SpawnSpec = {
  argv: string[];          // e.g. ['claude', '--session-id', id, '--model', 'opus', prompt]
  cwd: string;
  env: Record<string, string>;
  interactive: boolean;    // true => the frontend must attach a TTY itself
  endSession?: {           // set by interactive() only: how this session can end itself
    markerPath: string;    // the file the model creates when the human agrees we're done
    quitSequence: string;  // what to write to the pty to ask the runner to quit
  };
  awaitState?: {           // set by interactive() only: how this session reports being blocked
    statePath: string;     // the file the runner's own hooks write
  };
};
```

The **frontend** decides how to attach the human: the `whiphand` CLI spawns with
`stdio: 'inherit'`; a Tauri app spawns into its own PTY widget in the webview. `core`
resumes control only after the frontend reports the interactive process has exited, then
proceeds to harvest (below). Getting this seam right now costs nothing extra; deferring it
until the Tauri app exists would mean rewriting the run engine's control flow later.

### Adapter interface

```ts
interface RunnerAdapter {
  id: 'claude' | 'copilot' | string;
  capabilities: {
    sessionIdInjection: boolean;  // can we mint the session id ourselves?
    sessionResume: boolean;       // required for the interactive handoff
    toolDenial: boolean;
    shareTranscript: boolean;     // e.g. copilot --share, as a fallback capture
  };
  detect(): Promise<{ installed: boolean; version?: string }>;
  interactive(step: Step, ctx: RunCtx): SpawnSpec;
  headless(step: Step, ctx: RunCtx): SpawnSpec;
  harvest(step: Step, ctx: RunCtx): SpawnSpec;
  listModels?(): Promise<ModelList>;  // { source: 'live'|'fallback'|'unavailable'; models: ModelInfo[]; note?: string }
}
```

`listModels` feeds the workflow editor's Model field with suggestions and typo warnings.
Optional, and its absence *is* the capability check, same precedent as `suggestName?` (below):
a runner with no way to ask simply gets no picker, and the field stays free text with no
warnings.

The registry is a plain map keyed by adapter `id`, so adding `codex` or `gemini` later is
additive, not a change to the engine. A step that requests a capability its adapter
doesn't have (e.g. `mode: interactive` on an adapter without `sessionResume`) must fail at
**workflow validation time**, before any process spawns — not discovered mid-run.

### Headless step progress

A headless step's stdout is a pure side-channel — the model writes its artifact through
its own Write tool, and the verdict is read back out of that *file* — so `headless()`
switches both runners to structured output and sets `SpawnSpec.progress.format`. Whoever
spawns the process (the CLI, or the agent sidecar) hands raw lines back through
`spawnHeadless`'s optional `onLine`; only `packages/core/src/engine/progress.ts` parses
them, so neither frontend knows a runner's schema.

`parseProgressLine` is total: an unrecognized, malformed or empty line yields `null`.
These are third-party output schemas, far less stable than the flag table above, and a
runner changing its output must degrade what the UI shows rather than take a run down.
`parity/fixtures/progress/` holds a recorded run per runner, which is what turns that
drift into a failing test instead of a silently blank panel.

The normalized reports ride the `WhiphandEvent` stream as `step:progress`, so the CLI and the
desktop render from one source. `RunJournal` treats them as its one **ephemeral** event
class: their counters and last action fold into the in-memory manifest, but they are
neither appended to `events.ndjson` nor allowed to schedule a manifest write. A chatty
step would otherwise rewrite `run.json` hundreds of times and persist a whole transcript
as a side effect. `step:done` always follows, so a finished step's summary is durable.

In the desktop app these reports land on the **Terminal tab**, which is the single "what is
running right now" surface: the xterm while an interactive step holds a pty, and otherwise
the running headless step's feed. A dead session never outranks live work there — an
interactive step followed by headless ones is the ordinary workflow shape. The feed clears
at every `step:start`, so it only ever shows the step running now, and every line is
prefixed with the id of the step that wrote it. It is live-only: a run reopened or started
from `whiphand run` has no feed until the next line arrives, because the manifest keeps each
step's summary, not its transcript.

The tab carries **output only**. Which step is running, how long it has been going, what
phase it is in and what it has spent are facts *about* a step, so they live on that step's
pill in the stepper above — as does whether it is waiting on you. The rule is that no fact
on this screen is stated in two places: a status line over the feed repeated the pill's
clock and the feed's own last line, and read as a hang whenever the two disagreed.

## The interactive handoff

This is the part of the design that isn't just "call the CLI with different flags" — it's
the mechanism that makes a *live conversation* usable as a pipeline step.

**The problem:** a free-form interactive chat does not reliably produce a clean artifact
for the next step. Asking the operator to remember to paste or save the plan at the end is
not a design — it will be forgotten, and the workflow would silently pass an empty or stale
input to the execute step.

**The mechanism:** mint the session identity before the human ever sees it, hand over that
exact session for the live conversation, then harvest the outcome from the same session
headlessly, after the human has left:

1. `whiphand` generates a UUID for the step.
2. The frontend spawns the runner with a TTY attached and the session id pinned, with
   write tools already denied and the interactive guidance appended to the system prompt:
   ```
   claude --session-id <uuid> --model opus \
     --disallowedTools "Write Edit NotebookEdit" \
     --append-system-prompt "<interactive guidance>" \
     "<seeded prompt built from the workflow + prior step artifacts>"
   ```
3. The operator chats freely — refines the plan, asks questions, pushes back — and the
   session ends when they and the model agree the step's goal is met.
4. `whiphand` harvests, headless, with no human present, by resuming the *same* session:
   ```
   claude -p --resume <uuid> --model opus \
     "Write the plan we just agreed on to <output-path>. Output only the plan."
   ```
5. `whiphand` asserts the artifact file exists and is non-empty. If not, the step fails loudly —
   it does not silently pass an empty artifact downstream.

### Keeping the session in its lane, and getting it to end

Two things a seeded prompt alone does not achieve, both handled by the guidance appended
in step 2 (`engine/interactive-guidance.ts`, one shared text; claude takes it via
`--append-system-prompt`, copilot — which has no system-prompt flag — as a prompt prefix):

- **Scope.** Without it a runner reads the step prompt as an autonomous task and starts
  doing the *next* steps' work. The guidance branches on the step's `writes` flag: a
  read-only step is told to change nothing at all, including via the shell (tool denial
  alone doesn't cover `bash`); a writing step is told to propose and wait for a go-ahead.
  The run directory is explicitly carved out of that rule — harvest resumes this same
  session and asks it to write the artifact there.
- **Ending.** A runner in interactive mode is a REPL: it never exits on its own, so
  without a signal the operator has to quit it by hand, and a Ctrl-C exit code then fails
  the step. Instead the guidance tells the model to `touch` a marker
  (`<runDir>/.<stepId>.done`, `engine/session-end.ts`) once the human agrees the goal is
  met. The marker path rides on the `SpawnSpec`, so the path the model is told to create
  and the path the frontend watches are the same expression. A frontend that can watch the
  filesystem closes the session politely on sight — quit sequence, then SIGTERM, then
  SIGKILL — and reports exit 0, since the kill was on our own say-so. The desktop's
  **End session** button drives the identical path; the CLI, whose child owns the real
  TTY, still relies on the operator typing `/exit`.

### Knowing when the session is waiting for the human

A PTY existing does not mean anyone is waiting. Two channels answer that, and a
frontend that can watch the filesystem combines them (`agent/frontend.ts`):

- **The runner's own hooks (precise).** claude's inline `--settings` — the same
  object that already carries the marker's permission rule — installs four hooks
  that write `<runDir>/.<stepId>.await` (`engine/await-state.ts`): `Stop` →
  *your turn*, `PermissionRequest` → *needs permission*, `UserPromptSubmit`
  removes the file, and `Notification` dumps its raw payload, from which the
  agent maps `notification_type` (`idle_prompt` → *waiting for you*, claude's own
  judgement that the human has been silent about a minute). Verified against
  2.1.260: inline settings **merge** with the user's, so their hooks still run.
  Every hook command ends `; exit 0` — a `Stop` hook exiting nonzero blocks the
  agent from stopping, and a `PermissionRequest` one exiting 2 denies the tool.
- **The terminal bell (runner-agnostic).** A standalone BEL in the PTY stream
  means *wants attention*. This is copilot's only channel, since it has no hooks
  (and its `beep` setting is off by default — `whiphand doctor` says so). BEL is also
  the terminator of an OSC sequence, and claude emits OSC title and hyperlink
  sequences constantly, so `agent/bel.ts` tracks OSC state and counts only bells
  that stand alone.

Hooks always win: a bell must never downgrade a state we actually know. The
model is never told the await file exists — its value is being out-of-band.

Both CLIs installed on this machine support `--session-id` + `-r/--resume` + a headless
print mode, so this exact five-step mechanism is uniform across `claude` and `copilot`
without per-adapter special-casing. `copilot --share <path>` is documented here as a
fallback capture path if a resume-based harvest ever proves unreliable for that adapter.

## Read-only enforcement

A `writes: false` step (plan, review) gets two independent layers, because a prompt asking
the model not to edit files is a request, not a control:

1. **CLI-native tool denial** — `--disallowedTools "Write Edit NotebookEdit"` (claude) /
   `--deny-tool` plus a restricted `--available-tools` (copilot).
2. **Git working-tree assertion** — `whiphand` snapshots the working tree before the step runs;
   if anything changed outside the run's own artifact directory, the step fails and names
   what changed. This is the same idea as Archon's `mutates_checkout` field, implemented
   independently rather than adopted wholesale (see `docs/research.md`).

Layer 2 exists precisely because layer 1 can be bypassed by a model that ignores its tool
policy, or by a future adapter whose `toolDenial` capability turns out to be unreliable.

## Workflow format

A workflow lives at `.whiphand/workflows/<name>.yaml` inside the working folder. Every step declares a
`kind`; a step with no `kind` is an `agent` step, which is what every step used to be, so
workflows written before kinds existed keep working untouched.

### Step kinds

| Kind | What it is | Key fields |
|---|---|---|
| `agent` (default) | An LLM runner invocation | `runner`, `model`, `mode`, `writes`, `prompt`, `output` |
| `command` | A shell command — no runner, no tokens | `run`, `shell`, `cwd`, `env`, `timeout_ms`, `expect_exit` |
| `manual` | A human checkpoint | `title`, `instructions`, `capture`, `show_diff`, `default` |
| `approval` | The same machinery under a clearer name | as `manual` |
| `loop` | A cycle over its own `steps` | `steps`, `until`, `max_iterations`, `on_exhausted` |

Every kind except `loop` may carry `inputs` (artifacts of other steps, injected as paths,
or the reserved `attachments` — see "Attachments", below),
`output` (the artifact it writes — required for `agent`, optional elsewhere) and `verdict`.
Every kind, `loop` included, may also carry `enabled: false` (see "Disabling a step", below).

`enabled` belongs on a step, not on the workflow — putting it (or any other unknown key) at
the workflow root fails to parse with `workflow: '<key>' belongs on a step, not on the
workflow`, naming the key. This is a root-level allow-list (`name`, `description`, `inputs`,
`on_findings`, `steps`), separate from the per-step misplaced-field diagnostic that catches a
`run:` on a step that forgot `kind: command`: that one maps a field to the single step kind
that owns it, and `enabled` has no single owner — it is valid on every kind — so it cannot be
registered there and gets its own check instead.

A workflow's own `inputs:` map (as opposed to a step's) takes `required`, `prompt`, `default`,
and `remember`. `remember` is a desktop New-run prefill hint — the CLI never reads it — and
without it a new run starts that field blank every time, even if a previous run filled it in.

```yaml
name: cycle
inputs:
  feature: { required: true, prompt: "What are we building?" }

steps:
  - id: plan
    runner: claude
    model: opus
    mode: interactive
    writes: false
    output: plan.md
    prompt: |
      We are planning: {{ inputs.feature }}
      Work with me on a plan. Do not modify any files.

  - id: fix-cycle
    kind: loop
    until: review          # a body step with verdict: true
    max_iterations: 3
    steps:
      - id: execute
        runner: copilot
        mode: headless
        writes: true
        inputs: [plan, review]   # `review` is later => the previous iteration
        output: execute-report.md
        prompt: Implement the attached plan. This is attempt {{ loop.iteration }}.

      - id: tests
        kind: command
        run: npm test
        verdict: true            # a non-zero exit is a signal, not a crash
        output: tests.log

      - id: review
        runner: claude
        model: haiku
        mode: headless
        writes: false
        verdict: true
        inputs: [plan, execute, tests]
        output: findings.md
        prompt: Review the diff against the plan.

  - id: sign-off
    kind: approval
    title: "Ship {{ inputs.feature }}?"
    instructions: Check the diff and the findings before this goes out.
    show_diff: true
    inputs: [review]
```

`inputs: [plan]` on a step resolves to the referenced step's artifact path and injects it
into that step's prompt context. Artifacts land under `.whiphand/runs/<run-id>/<output>` as
plain markdown — diffable and committable, not an opaque log.

### Verdicts

`verdict: true` means **this step produces a pass/fail signal instead of failing the run**.
It is uniform across kinds, which is what lets a loop's `until` name any of them:

- an `agent` step's artifact must open with `VERDICT: PASS` or `VERDICT: FAIL`;
- a `command` step's exit code decides, measured against `expect_exit` (default `[0]`);
- a `manual`/`approval` step's answer decides — *continue* passes, *retry* fails.

A step that reports a verdict has done its job: a `verdict: true` command exiting 1 is
recorded as **done** with a FAIL, not as a broken step. Without `verdict: true`, a non-zero
exit fails the run as it always did.

### Attachments

Some things a step needs are awkward to pass as an input string: a screenshot, a log, a HAR
trace. The operator attaches them when the run starts — `whiphand run feature --attach
./bug.png --attach ./server.log`, or the New Run dialog's Attachments field (pick, drop, or
paste an image) — and a step receives them by naming the reserved ref `attachments` in its
`inputs:`:

```yaml
steps:
  - id: plan
    inputs: [attachments]      # every file attached to this run
```

- **Visible in the workflow, never injected.** Only a step that names `attachments` gets
  the files, as one line per file under the prompt's `## Input artifacts` heading
  (`- attachments/bug.png: /abs/…/attachments/bug.png`); a manual or approval step that
  names it offers each file on the review screen. A `command` step reaches them at
  `"$WHIPHAND_RUN_DIR/attachments"` — its `inputs:` is only the declaration there.
- **Refused if nothing reads them.** Attaching files to a run whose enabled steps never
  name `attachments` refuses to start, with a hint naming the fix. A workflow that *can*
  read attachments does not need them: with nothing attached the ref is simply dropped,
  the way a reference to a disabled step is.
- **Reserved.** `attachments` can be neither a step id nor a loop id — a loop id is a
  directory name under the run dir, and would collide with the attachment directory. It is
  exempt from the ordering checks, since the files exist before step one.
- **Always copied.** Before step one the files are copied into `<runDir>/attachments/`
  and recorded in `run.json` (`attachments: [{ name, path, size, source }]`, optional, so
  older manifests parse unchanged). A file keeps its basename, sanitized to
  `[A-Za-z0-9._-]` with no leading dot; pasted images become `pasted-N.<ext>`; duplicates
  get `-2`, `-3`, … before the extension, compared case-insensitively. The `run:start` event
  carries the final names, so the CLI's `📎` line and the dialog's chips show exactly what
  the steps will see. A dry run records the list and copies nothing.
- **Capped per file** by `runs.max_attachment_mb` (default 25). Everything that can refuse
  — a missing path, a directory, an unreadable or oversized file, a workflow that reads
  none of them — is decided before the run directory exists, so a refusal leaves no run
  behind. The CLI exits 2; the desktop shows the agent's error inline.
- **Resume sees exactly what the original run saw.** A resume re-reads the list from
  `run.json` and cannot add or change files. A recorded file that is missing from the run
  directory (a copy that failed on a full disk, a hand that deleted it) refuses the resume
  — start a fresh run instead. Retention deletes attachments with their run.
- **The remote channel takes bytes only.** Over the LAN WebSocket, `startRun` accepts
  base64 attachments and refuses `path` ones, so "copy any file the agent can read into a
  run, then `readArtifact` it" is not a one-call read of the host's disk. There is no
  remote upload UI yet, and the whole `startRun` request must fit the WebSocket's 1 MB
  frame cap (`MAX_FRAME_BYTES`), so a remote run can carry only about 750 KB of files in
  total. A bigger frame closes the connection (code 1009) rather than returning an RPC
  error. Raising the cap would not fix it, because there is no per-run total, so a real
  remote upload needs the staged-upload follow-up.

Attached images render in the desktop's Artifacts tab (and the review screen) because
`readArtifact` takes `encoding: 'base64'` — capped at the larger of 2 MB and
`runs.max_attachment_mb`, where the default `utf8` stays at 2 MB — and the viewer polls the
content-free `statArtifact` rather than re-reading the file. Both are additive: an older
desktop keeps working against a newer agent; a newer desktop against an older agent gets
MethodNotFound for `statArtifact`. They ship as one bundle, so that pairing should not occur.

Whether a runner can actually *look at* an image it is pointed to is the runner's business:

| Runner | Image attachments |
|---|---|
| `claude` | Expected to work: its `Read` tool views PNG/JPEG. Not yet confirmed on a real headless run. |
| `copilot` | Unverified. |

## Cycles

`execute → review → execute → review, until the findings are resolved` is the loop the tool
exists to run, so it is a construct in the workflow rather than a policy in the config:

```yaml
- id: fix-cycle
  kind: loop
  until: review
  max_iterations: 3        # default: config.loop.max_iterations
  on_exhausted: report     # report | interactive; default: the resolved on_findings
  steps: [...]
```

Three rules carry the weight, and all three are deliberate:

- **`until` exits immediately.** When the `until` step finishes with a passing verdict the
  iteration ends there and the loop exits — any remaining body steps are skipped. Put the
  exit check last if you want the whole body to run every time.
- **A forward reference inside a loop body means "the previous iteration".** Referencing a
  *later* body step resolves to its artifact from the iteration before, and is simply
  dropped on the first pass, when there is none. That is how findings feed back into the
  next attempt — visibly, in the workflow, rather than by prose the engine injects.
- **Each iteration keeps its own artifacts.** A body step writes to
  `<runDir>/<loopId>/iter-<n>/<output>`, so iteration 3 cannot erase what iteration 1
  produced, and `run.json` records one entry per *execution*. `inputs: [execute]` still
  resolves to the newest.

`--max-iterations` on `whiphand run` (and the matching field in the desktop's New Run dialog)
overrides every loop's budget for one run, without editing the workflow.

**Resuming an exhausted loop.** A loop that runs out of iterations fails the run the normal
way, but the run stays resumable: `whiphand run --resume <id>` grants every loop the manifest
records as exhausted (its own row `failed`, from `loop:done` with `passed: false`) one more
iteration by default, or `--extra-iterations <n>` to grant `n` (applied to every loop not yet
passed, not only exhausted ones, and warning if none is eligible). The *recorded* budget —
the loop row's own `maxIterations`, which `loop:start` rewrites on every resume — wins over
the workflow's declared `max_iterations` or the config default, so a config edit between runs
cannot silently change the allowance, and each grant becomes the next resume's base. An
absolute `--max-iterations` still overrides everything, including a grant; setting it at or
below what the loop already ran emits a `guard:warning` explaining the otherwise-baffling
instant re-failure, rather than failing silently.

### Relationship to `on_findings`

`on_findings` (below) predates loops and still governs a `verdict` step that is **not**
inside one. A verdict step inside an explicit loop is governed by the loop, and
`on_findings` never fires for it; `on_exhausted` reuses the same vocabulary
(`report` / `interactive`) so there is one set of words, not two.

## Disabling a step

`enabled: false` parks a step without deleting it or its prompt. Absent means enabled, so
every workflow written before this existed parses unchanged — there is no schema default,
because a default would serialise `enabled: true` onto every step in every file on first
save.

- **A disabled step never starts**: no session, no artifact, no tokens spent. It is still
  recorded in the run's manifest with a distinct `disabled` status (not `skipped`, which
  means *done*), so a reader can see it existed and did not run.
- **Disabling a loop disables its whole body.** Nothing inside it runs; the body steps keep
  whatever `enabled` value they already had, so re-enabling the loop restores exactly the
  arrangement it was left in.
- **A loop's `until` step can never be disabled** — not while the loop is enabled, not while
  the loop itself is disabled. This is unconditional, which is what keeps "disable the loop,
  disable its `until` step, re-enable the loop" from producing a loop with no exit check.
- **References to a disabled step are dropped, not left dangling.** A step whose `inputs:`
  names a disabled id runs without that input rather than crashing; static validation (id
  uniqueness, reference direction, loop wiring) still evaluates the workflow as declared,
  ignoring `enabled` entirely, so toggling a step can never make a valid file invalid.
  `command` steps are the one exception on the reading side: their `inputs:` is a runtime
  no-op, so a disabled id never needs to be dropped from one.
- **A workflow with no enabled steps fails at run start**, from both `whiphand run` and the
  desktop app, before a run directory is even created.
- **A hand-authored file can still disable a loop's `until` step directly** (bypassing the
  editor's guard). The runner catches this at run start too — a loop whose `until` step is
  disabled can never end, so the run fails immediately rather than burning its iteration
  budget first.

## Human steps

`manual` and `approval` steps stop the run and ask. Core never touches a terminal, so —
exactly as with an interactive session — it builds the question and hands it to the
frontend through `Frontend.runManual`:

- the **CLI** renders it on stderr (so `--json` stdout stays pure NDJSON) and reads the
  answer from the tty. Without a tty it **fails, naming the step**: `whiphand run --yes` is the
  explicit opt-in to taking the step's `default` instead, and it says out loud when it did.
- the **desktop** opens a **review screen** over the run page and answers it with the
  `resolveManual` RPC. A cancelled run tears down the parked question rather than leaving
  the job waiting on a human who will never come.

A workflow containing manual steps run by a frontend that cannot ask fails at **validation
time**, before anything spawns — the same rule every other capability mismatch follows.

`capture: note` asks for free text and writes it as the step's artifact, so a later step can
read it. `show_diff: true` puts the working tree's diff in front of whoever is deciding.

### Sending work back (`capture: review`)

A `manual`/`approval` step's `capture` field is `'note' | 'review'`, built into a
`CaptureSpec` (`{ kind, label, requiredFor, perFile }`) that core hands the frontend —
`requiredFor` names the choices that cannot be answered without text, because that is
per-choice, not a single boolean: a note you must type to `continue` and a comment you must
type to `retry` are opposite rules. `capture: 'note'` maps to `requiredFor: ['continue']`,
unchanged from before `CaptureSpec` existed.

`capture: 'review'` is `requiredFor: ['retry']` and `perFile: true`: the frontend offers one
overall comment plus a comment per file in the diff, and `retry` cannot be answered without
at least one of them. `retry` is only offered inside a `kind: loop`, so this is only useful
there — put the step's own id at the loop's `until:` and add it to the loop's `execute`
step's `inputs:` (dropped by `scopeInputs` on the first iteration, same as any forward
reference) so the next attempt reads what was asked for. Approving still `continue`s the run
past the step exactly as `capture: note` always has; retrying writes the same artifact and
sends a failing verdict round the loop, the same as any other `until` step.

The answer's `comments: FileComment[]` (`{ path, body }`) rides alongside `note` on
`ManualResponse`; a manual step's own artifact renders them as one markdown section per file,
backticked so a path can never parse as markdown, with the choice in the subtitle
(`_approval step 'sign-off' — changes requested_` vs `— approved`) — the agent reading this on
the next iteration needs to know whether it was sent back or waved through with notes,
which `capture: note`'s artifact never said. Blank comments are dropped before writing.

Two non-fatal diagnostics (`validateWorkflowWarnings`, alongside but separate from
`validateWorkflowSemantics`'s fatal problems) catch a `capture: review` step that still runs
but only uselessly: outside a loop, where `retry` is never offered and it degrades to
approve-with-notes; and without `show_diff: true`, where there are no files to comment on
and it degrades to an overall comment only. `whiphand run` prints them to stderr with the
same `⚠` prefix a resumed run's own warnings use.

### The desktop's review screen

The run is *blocked* at this point, so the decision gets the whole page rather than a card
competing with the header, the stepper and the tabs. The screen takes a left rail of things
to review and one large pane to read them in, with the choices pinned along the bottom:

- **Changes** — the working tree file by file, side by side, when the step set `show_diff`.
  Fed by the `getWorkingDiff` RPC over `workingDiffFiles` (`engine/diff.ts`), *not* by the
  `context.diff` string the CLI prints: that one is capped at 400 lines and omits untracked
  files entirely, so a file the run just created never reached the person approving it.
- **Each declared input** — `inputs: [review, plan]` becomes one rail entry per artifact,
  rendered full height by the same viewer the Artifacts tab uses. This is what makes signing
  off a plan need no new machinery: a step with `inputs: [plan]` and no `show_diff` is
  already a plan-review screen.

Under `capture: 'review'`, a footer below the diff pane offers a comment on whichever file is
open — collapsed to a one-line toggle by default (the header comment is explicit that
vertical space belongs to the change set, so a permanently-parked textarea would spend the
wrong budget), auto-expanded for a file that already has one. `DiffFileList` dots the rail row
for every path with a draft, which is the only way to see what you have already said without
clicking through every file. The decision bar's textarea is relabelled from `capture.label`
("Feedback" rather than "Note") and its disabled rule reads `capture.requiredFor.includes`
the choice being clicked, rather than a hardcoded `continue`; next to the button that sends a
`retry`, a plain count — *3 file comments* — since that click is consequential and the
comments themselves are off-screen at the moment it is made. `retry` itself reads **"Request
changes"** under this capture kind (`CHOICE_LABEL` in `from-manual.ts` becomes a function of
the capture kind): "Retry" describes what the loop does, "Request changes" describes what the
human does, and this screen belongs to the human.

`ReviewOverlay` is kept mounted, hidden with `display: none`, while the human backs out to the
`PendingDecisionBar` — the same pattern the run page's own tabs use, and for the same reason:
unmounting would throw away a typed note or a dozen per-file comments the same way it used to
throw away the terminal's xterm buffer.

It is rendered *instead of* the page body, not floating over it — one Fluent Modalizer at a
time is a hard rule here (see the run page's own dialogs), and a full-bleed dialog would
also stack with the artifact viewer's save-conflict dialog inside it. Backing out leaves a
bar saying the run is still waiting, because a blocking question must never be reachable
only from behind a tab; Escape deliberately does nothing.

`workingDiffFiles` reads the tree through a **throwaway index** (`GIT_INDEX_FILE` at a temp
path, `read-tree` then `add -A`), which is what lets one pass cover tracked edits, renames,
binaries and untracked files alike without touching the real index.

## Run names

A run is minted as `YYYYMMDD-HHmmss-xxxx` and that id never changes: `listRuns` sorts by
it, retention prunes oldest-first by it, and it is a path segment. On top of that a run
carries an optional **name** — a human label shown wherever the id used to be shown alone:

```bash
whiphand run feature --input feature="oauth support" --name "OAuth support"
whiphand rename-run 20260907-141233-a3f1 "Something better"   # '' clears it
```

The name lives in a `.name` marker file beside `run.json`, not in the manifest — the same
reason the lock marker is a file. `RunJournal` holds the manifest in memory and rewrites it
on every event, so renaming a *running* run through `run.json` would be clobbered by the
next event; a marker file is atomic, needs no manifest version bump, and survives copying
the run directory. `listRuns`/`getRun` overlay it onto every summary exactly as they
overlay `locked`.

Names are labels, not identifiers: they need not be unique, and `--resume` still takes the
id.

### The name as a variable

A run's identity reaches its steps two ways, because prose and shell lines have different
hazards:

| | prompts, manual titles/instructions, `run:`, `cwd:` | a `command` step's shell |
|---|---|---|
| the name | `{{ run.name }}` | `$WHIPHAND_RUN_NAME` (unset when unnamed) |
| the slug | `{{ run.slug }}` | `$WHIPHAND_RUN_SLUG` |
| the id | `{{ run.id }}` | `$WHIPHAND_RUN_ID` |

`run.slug` is the name lowercased to `[a-z0-9-]`, capped at 48 characters — the same shape
`WORKFLOW_NAME_RE` validates, which is already git-ref safe. An unnamed run (or one whose
name slugifies to nothing) reads as its id in all six, so a workflow never has to branch on
whether a name exists.

**Prefer the env vars in a shell line.** A name is arbitrary human text, and interpolating
it into a `sh -c` string is a quoting hazard the slug only partly mitigates:

```yaml
  - id: worktree
    kind: command
    run: git worktree add -b "whiphand/$WHIPHAND_RUN_SLUG" "../wt-$WHIPHAND_RUN_SLUG"
    output: worktree.log

  - id: tests
    kind: command
    cwd: ../wt-{{ run.slug }}     # cwd is templated, like run:
    run: npm test
    output: tests.log
```

That is the whole of `whiphand`'s worktree story: the variable, and your own `command` step.
Per-step worktree isolation stays out of scope (see below) — there is no git-write layer
here, and every step's `cwd` still flows from the one `workdir`.

Both values are **frozen for the life of the process**. A rename mid-run must not change
the slug a step already used to name a branch, and `{{ run.name }}` must never disagree
with `{{ run.slug }}` inside one run. A resumed run is a new process, so it picks up
whatever the run is called then.

### Naming a run automatically

`runs.auto_name` (off by default) asks the workspace's default runner for a 2-5 word name
when a run is started without one. It happens before the first step — deliberately, since
a name minted at the end could not feed a worktree or a branch — through an optional
`suggestName` adapter method whose reply is captured with the same `SpawnSpec.capture`
plumbing command steps use. Its absence on an adapter *is* the capability check.

It is best-effort in every direction: a runner that cannot answer, a failed spawn, a
20-second timeout, or a reply with nothing usable in it all leave the run unnamed. It never
fails or meaningfully delays a run, and a dry run skips it entirely.

## Workspace configuration

`.whiphand/config.yaml` holds machine/workspace-level settings, kept separate from portable
workflows so a workflow can be shared across workspaces with different policies:

```yaml
defaults:
  runner: claude
on_findings: report        # report | loop | interactive
loop:
  max_iterations: 3
artifacts_dir: .whiphand/runs
runs:
  max_retained: null
  auto_name: false
  max_attachment_mb: 25    # per-file cap on --attach / the New Run dialog's attachments
```

`on_findings` governs what happens when a review step reports problems — deliberately a
per-workspace choice rather than something the tool hardcodes:

- **`report`** (default) — write the findings artifact and end the run. No follow-up
  action is taken automatically; the operator decides what to do next. No risk of runaway
  spend.
- **`loop`** — feed the findings back into the `execute` step for another pass, bounded by
  `max_iterations`. Requires the reviewer to emit a structured pass/fail signal `whiphand` can
  act on, not just prose. Predates `kind: loop` and is inferred rather than declared (it
  rewinds to the nearest earlier `writes: true` step); prefer an explicit loop, which says
  in the workflow what this only implies.
- **`interactive`** — hand the operator a live session with the findings preloaded, using
  the same mint-then-resume-harvest mechanism as the plan step.

A workflow may set its own `on_findings`, overriding the workspace default for that workflow
specifically.

## Build order

Ordered so the largest share of correctness is verifiable before any tokens are spent:

1. **Workflow schema + validator** (`packages/core/src/schema.ts`, Zod) — including the
   adapter-capability check (an `interactive` step requires `sessionResume`).
2. **Adapter argv builders** (`packages/core/src/adapters/{claude,copilot}.ts`) — pure
   functions, `Step → SpawnSpec`, no process spawning. This is where TDD applies most
   directly, since the whole surface is deterministic input/output.
3. **`whiphand doctor`** — detects installed runners and their versions. Smallest useful
   end-to-end slice; exercises `detect()` on every adapter.
4. **`whiphand run --dry-run`** — resolves a full workflow and prints every step's resolved argv
   without spawning anything. Validates steps 1–3 together at zero token cost.
5. **Headless engine** — runs non-interactive steps for real: artifact store, git
   working-tree assertion.
6. **Interactive handoff** — TTY spawn in the CLI frontend, plus the resume-based harvest.
7. **`on_findings` modes** — `report` first (it's the default and simplest), then `loop`,
   then `interactive`.

Steps 1–4 spend no LLM tokens at all and are where most of the tool's correctness lives;
they should be fully covered before step 5 touches a real runner.

## Verification strategy

- **Unit tests on argv builders** — assert exact argv for every runner × mode ×
  tool-policy combination, including that `writes: false` always emits the denial flags
  for that adapter.
- **`whiphand doctor`** — confirms `claude` 2.1.252 and `copilot` 1.0.60 are both detected on
  this machine.
- **`whiphand run --dry-run`** on the sample three-step workflow above — every step's argv is
  correct, no spend occurs.
- **Git-assertion test** — a `writes: false` step that touches a file must fail the run
  with a named cause.
- **End-to-end** — a throwaway repo with one deliberate, findable defect; run the
  plan/execute/review workflow against it; confirm `plan.md`, `execute-report.md`, and
  `findings.md` all land, the resulting diff is real, and the plan step left the tree
  untouched.

## Out of scope

DAG or parallel steps, `codex`/`gemini` adapters, per-step git worktree isolation, and
spend ceilings/telemetry (`max_spend_usd` — cycles are bounded by `max_iterations` only).
These are plausible follow-ups, not commitments.

Command steps go through a resolved shell (`command.ts`'s `SHELL_FLAGS` table — `sh -c` on
POSIX, `cmd.exe /d /s /c` on Windows by default); `shell:` names a different one per step.

## Release rollback (R6)

Every rollback below assumes the updater is actually configured. The signing key and the
GitHub owner are operator steps, done once on an operator's machine — README's "Releases and
auto-update" has the procedure, and `node scripts/version.mjs --check-release` (run by
`release.yml`'s `guard` job) is what stops a tag from shipping before they are. That gate
matters here specifically: a release built with the placeholder `pubkey` installs perfectly
well and *then* cannot update, so the failure surfaces only when the next release fails to
reach anyone — at which point none of the rollback below can help, because the broken copies
are no longer listening.

`.github/workflows/release.yml` publishes one GitHub Release per `vX.Y.Z` tag, carrying the
CLI binaries, the Linux/Windows bundles, and `latest.json` — the file every installed
copy's Tauri updater polls via `releases/latest/download/latest.json`. That URL always
resolves to whatever GitHub currently considers the repository's *latest* release, so
un-shipping a bad one is a release-metadata operation, not a rebuild:

- **Mark the bad release a prerelease** (`gh release edit vX.Y.Z --prerelease`), or
  **delete it** (`gh release delete vX.Y.Z --yes`). Either way GitHub stops considering it
  "latest", and the URL falls back to the most recent release before it — whose own
  `latest.json`, uploaded when *it* was current, still points at itself, so already-updated
  clients see no further prompt.
- This does not un-install the bad version from a machine that already updated — it only
  stops the version from reaching anyone else. Whether a given install already has it has to
  be answered separately (`whiphand --version`, or the app's own version string).
- Do this **before** debugging the underlying break. Every minute the bad release stays
  "latest" is another running copy's updater offering it.

Two matrix legs (`ubuntu-24.04`, `windows-latest`) both write to the same release — the one
draft `release.yml`'s `create-release` job makes before either starts, which tauri-action
reaches by `releaseId` rather than by tag, because GitHub allows several drafts per tag and a
per-leg `gh release create --draft` would quietly make a second. Both also write that
release's `latest.json` — see the `build` job's `max-parallel: 1`, which exists
specifically so the second leg's read of the current manifest happens after the first leg's
write, not concurrently with it (confirmed by reading `tauri-action`'s
`upload-version-json.ts`: it downloads any existing `latest.json` asset, seeds its
`platforms` map from that, and only overwrites the keys for its own artifacts before
re-uploading — a merge on read, not a blind overwrite, but still a race if two legs read
before either writes).
