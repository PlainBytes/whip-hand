# Design: `whiphand` — a workflow runner for LLM CLIs

## Background

The requirement (2026-09-01): drive different LLM CLIs per workflow step — e.g. plan with
one model, execute with another, review with a third — in one working folder. Neither
`claude` nor `copilot` can drive another vendor's CLI as a subprocess, only models within
their own harness, so that gap needed something external to both. Comanda (Go) was rejected
for having no Copilot CLI provider; Archon (TypeScript) came closest — provider registry,
per-node tool/model policy, a git-mutation assertion for read-only nodes — but its
multi-turn chat is web-UI-only and its stack (Docker Compose, Postgres, a separate
auth-service) is far heavier than the problem warrants. `whiphand` borrows proven ideas from
Archon's schema rather than reinventing them: per-step tool allow/deny lists, a git
working-tree mutation assertion for read-only steps, and typed output artifacts addressable
by role (`plan`, `findings`, `report`) rather than by guessing a filename.

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

All flags below were confirmed directly against `claude --help` and `copilot --help` at
the time this table was written — not taken from memory or documentation that could be
stale. Re-check against a current install before relying on an exact flag spelling; `whiphand
doctor` reports the installed versions.

| Capability | `claude` | `copilot` | `opencode` |
|---|---|---|---|
| Interactive session, seeded with a prompt | `claude "<prompt>"` | `copilot` (interactive by default; a prompt can auto-execute) | `opencode --prompt "<p>"` (auto-submits on the home screen) |
| Headless / non-interactive | `-p`, `--print` | `-p`, `--prompt <text>` | `run [message..]` |
| Model selection | `--model <alias\|full-id>` (e.g. `opus`, `claude-opus-5`) | `--model <id>` | `-m provider/model` |
| Pin a specific session id | `--session-id <uuid>` (must be a valid UUID) | `--session-id <id>` (1.0.83+: mints, same as claude) | — (cannot be minted; see below) |
| Resume a session | `-r, --resume [id]` | `-r, --resume[=id]` | `-s, --session <id>` |
| Continue most recent | `-c, --continue` | `--continue` | `-c, --continue` |
| Deny specific tools | `--disallowedTools <tools...>` | `--deny-tool[=tools...]` | `permission` config, per pattern (`allow`/`ask`/`deny`) |
| Restrict to a tool allowlist | `--allowedTools <tools...>` | `--allow-tool[=tools...]`, `--available-tools[=tools...]` | `permission` config (same mechanism, no separate allowlist flag) |
| Reasoning effort | `--effort low\|medium\|high\|xhigh\|max` | `--effort none\|low\|medium\|high\|xhigh\|max` | `--variant <v>` (`run` only; the TUI has none — set via the agent config's own `variant` field instead) |
| Extra working directories | `--add-dir <dirs...>` | `--add-dir <dir>`, `-C <dir>` | `permission.external_directory`, per pattern |
| Structured output | `--output-format text\|json\|stream-json` (NDJSON needs `--verbose`) | `--output-format json --stream on` (JSONL, one object per line) | `run --format json` (NDJSON) |
| Transcript export | — (use resume harvest, below) | — (use resume harvest, below) | `opencode export <id>` (not used by whiphand) |

The two original CLIs are close to isomorphic on exactly the primitives a workflow runner
needs: model selection, session identity, resumability, and tool policy. That symmetry is
what made a thin, uniform adapter interface viable instead of one bespoke integration per
CLI. opencode breaks the "session identity" isomorphism — it cannot be handed an id, only
asked afterwards what id it picked — which is why the adapter interface has a second
capability for minting (`sessionIdCapture`, alongside `sessionIdInjection`; see "Adapter
interface" below) rather than assuming every runner can be pinned up front.

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
`SpawnSpec` (`packages/core/src/types.ts` — argv/cwd/env, an `interactive` flag, and the
optional `endSession`/`awaitState`/`capture`/`progress` extras the sections below explain)
and hands it to whichever frontend is running.

The **frontend** decides how to attach the human: the `whiphand` CLI spawns with
`stdio: 'inherit'`; a Tauri app spawns into its own PTY widget in the webview. `core`
resumes control only after the frontend reports the interactive process has exited, then
proceeds to harvest (below). Getting this seam right now costs nothing extra; deferring it
until the Tauri app exists would mean rewriting the run engine's control flow later.

### Adapter interface

`RunnerAdapter` (`packages/core/src/types.ts`) is `id`, a `capabilities` map
(`sessionIdInjection`, `sessionIdCapture`, `sessionResume`, `toolDenial`, `shareTranscript`),
`detect()`, and three `Step → SpawnSpec` builders (`interactive`, `headless`, `harvest`),
plus two optional methods: `suggestName?` (run auto-naming) and `listModels?` (feeds the
workflow editor's Model field with suggestions and typo warnings). Both are optional, and
the absence of either *is* the capability check — a runner with no way to answer simply
gets no picker, or never auto-names a run, and the field stays free text with no warnings.

`sessionIdInjection` and `sessionIdCapture` are two ways to reach the same place — an
interactive step's harvest needs *some* id to resume — for runners that mint an id
differently. claude and copilot take `sessionIdInjection`: whiphand generates a UUID before
the step ever spawns and hands it over. opencode cannot be handed one, so it takes
`sessionIdCapture` instead: the runner reports whatever id it picked, read back by an
optional `captureSessionId?(step, ctx)` once the interactive spawn has exited 0, and folded
into the run the same way an injected id is (`step:session`, mirroring `step:spawn`'s own
role for `sessionStarted`). `registry.ts`'s interactive-mode gate accepts either capability
paired with `sessionResume`, or `shareTranscript` on its own — a runner needs one resumable
identity mechanism or a transcript, not necessarily both kinds of identity.

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

**The capture variant (opencode).** opencode cannot be handed a session id in step 2 — there
is no flag and no API call that mints one — so steps 1–2 invert: opencode spawns with no
identity pinned at all, picks one on its own the moment its session opens, and whiphand
learns it only *after* the human leaves, from the same await-state plugin that answers "is
the human needed" (see "Knowing when the session is waiting for the human" below). Step 4's
resume then targets that learned id (`-s <id>`) exactly as claude's `--resume` and
copilot's `--resume=` do. An id that never gets learned — the plugin didn't run, or ran and
still couldn't tell — fails the step outright rather than attempting a harvest with nothing
to resume; a fallback (`opencode session list`, matched to exactly one candidate) covers the
plugin not running at all, but ambiguity is never guessed through.

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
  judgement that the human has been silent about a minute). Inline settings
  **merge** with the user's own, so their hooks still run alongside these.
  Every hook command ends `; exit 0` — a `Stop` hook exiting nonzero blocks the
  agent from stopping, and a `PermissionRequest` one exiting 2 denies the tool.
- **The terminal bell (runner-agnostic).** A standalone BEL in the PTY stream
  means *wants attention*. This is copilot's only channel, since it has no hooks
  (and its `beep` setting is off by default — `whiphand doctor` says so). BEL is also
  the terminator of an OSC sequence, and claude emits OSC title and hyperlink
  sequences constantly, so `agent/bel.ts` tracks OSC state and counts only bells
  that stand alone.
- **opencode's plugin (precise, and doing double duty).** opencode has no hooks, but it does
  have an in-process plugin API — a small generated `.mjs` module, delivered via
  `OPENCODE_CONFIG_CONTENT`'s `plugin: ["file://…"]` and written to disk by core before the
  spawn (`SpawnSpec.files`, since adapters themselves never touch the filesystem). It
  subscribes to opencode's own event stream and writes the same `.await` file claude's hooks
  write, using the same JSON body `parseAwaitState` already reads — no agent-side change
  needed for a third runner to report through this channel. `session.status: idle` on the
  *root* session → `turn`; `permission.asked`/`question.asked` → `permission`; the
  complementary events (`busy`, `*.replied`, `question.rejected`) clear it.
  This is also the channel that solves session-identity capture (see "The capture variant"
  above): the same plugin writes the session id to a second file the instant the root
  session is created, since a plugin has direct filesystem access no tool permission gates.
  Subagent sessions (`session.created` with a `parentID`) are tracked and always excluded —
  their own status chatter must never flap the root session's await-state. Every handler is
  wrapped in its own try/catch: a plugin fault must degrade to "no await-state reported",
  never take the human's live session down with it.

Hooks and the plugin both win over the bell: a bell must never downgrade a state we
actually know. The model is never told the await file (or, for opencode, the session-id
file) exists — both are populated out-of-band.

All three CLIs support a headless print mode and some way to resume a specific session, so
this mechanism is uniform across `claude`, `copilot` and `opencode`, modulo the mint-vs-capture
split above. copilot's own `--session-id` used to only resume; as of 1.0.83 it mints a new
session exactly like claude's flag of the same name ("or set the UUID for a new session"),
so copilot moved onto the identical injection+resume path claude already used — it no
longer needs `--share`'s transcript export as a fallback capture mechanism, and that flag
is not used anywhere in this codebase any more.

## Read-only enforcement

A `writes: false` step (plan, review) gets two independent layers, because a prompt asking
the model not to edit files is a request, not a control:

1. **CLI-native tool denial** — `--disallowedTools "Write Edit NotebookEdit"` (claude) /
   `--deny-tool` plus a restricted `--available-tools` (copilot) / opencode's `permission`
   config, which takes a different shape again: rather than a flag, the agent config sent
   through `OPENCODE_CONFIG_CONTENT` sets `edit: {"*": "deny"}` for a read-only step and
   `{"*": "allow"}` for a writing one. Bash stays allowed either way, same as claude and
   copilot — the guidance forbids shell writes, and layer 2 backs that up regardless of tool.
   Unlike the other two adapters, this permission map carries **no run-directory carve-out**:
   testing against the installed 1.17.13 binary found that a per-path `edit` override never
   matches a path outside the project root once a competing `"*"` rule is also present in
   the same map, regardless of whether the override is more specific — the opposite of the
   documented "last matching rule wins". A scoped exception for the run directory would
   therefore silently fail to unlock harvest's write whenever the run directory sits outside
   the project. opencode's `harvest()` sidesteps the whole problem the same way claude's
   `--allowedTools=Write` and copilot's `--allow-all-tools` harvest already do: unconditional
   trust for that one dedicated, single-purpose spawn, never a path-scoped rule.
2. **Git working-tree assertion** — `whiphand` snapshots the working tree before the step runs;
   if anything changed outside the run's own artifact directory, the step fails and names
   what changed. This is the same idea as Archon's `mutates_checkout` field (see "Background"
   above), implemented independently rather than adopted wholesale.

Layer 2 exists precisely because layer 1 can be bypassed by a model that ignores its tool
policy, or by a future adapter whose `toolDenial` capability turns out to be unreliable —
and, for opencode specifically, because a permission quirk on any given release could make
layer 1 quietly weaker than it looks without layer 2 to still catch the result.

## Workflow format

A workflow lives at `.whiphand/workflows/<name>.yaml` inside the working folder. Every step
declares a `kind`; a step with no `kind` defaults to `agent`.

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

### Command steps and shell injection

A `command` step's `run:` goes through a real shell (`command.ts`'s `SHELL_FLAGS` table —
`sh -c` on POSIX, `cmd.exe /d /s /c` on Windows by default; `shell:` names a different one
per step), and `{{ inputs.* }}` / `{{ run.* }}` template values are substituted into it as
plain text *before* the shell parses the line. A run input containing shell metacharacters
(`; | & $( ) \` "` …) can therefore inject arbitrary shell syntax — quoting the reference in
the workflow YAML does not help, since the substitution happens first, not the shell's own
parsing of the author's quotes.

This is a known, accepted risk rather than an oversight: safely escaping an arbitrary
template value across three shell dialects (POSIX `sh`, `cmd.exe`, PowerShell), plus an
operator-overridable `shell:`, is not a small fix, and getting the escaping subtly wrong
per-dialect would be worse than the current, well-understood behavior. Treat a `command`
step's inputs the way you would any other shell script: only interpolate values you already
trust into `run:`, and prefer reading untrusted ones from an environment variable (`env:`)
instead, since a shell only re-parses `$VAR` expansions, not the variable's contents. See
`docs/review-backlog.md` for the tracked follow-up.

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
  and recorded in `run.json` (`attachments: [{ name, path, size, source }]`, an optional
  field). A file keeps its basename, sanitized to
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

### Nested loops

A loop can contain another loop in its own `steps:` — every shipped workflow does this now,
wrapping an implement/review cycle in an outer loop that repeats until a human sign-off
approves it (see "Sending work back" below). That means the *same* `(stepId, iteration)` pair
recurs once per round of the outer loop, so identity needs a second axis:

- **An execution's identity is its full loop chain**, not just the innermost `(loopId,
  iteration)`. `LoopFrame` carries a `parent` link to the frame it is nested inside — absent
  for a top-level loop, which is what keeps a single-level frame identical to what it always
  was. `ancestorLoops` (`execution-key.ts`) walks that chain into `LoopRef[]` (`{ id,
  iteration }`, outermost first) for whatever is beyond the immediate loop.
- **Artifacts nest one directory per frame**, outermost first: a body step inside `fix-cycle`
  inside `human-review` writes to `<runDir>/human-review/iter-2/fix-cycle/iter-1/<output>`
  during round 2, not to the same `fix-cycle/iter-1/<output>` round 1 already used. A
  single-level loop's path is unchanged.
- **`executionKey`** folds the outer chain into the string key resume and the manifest match
  executions by: `human-review#2/execute#1`. With no outer loops the key is byte-identical to
  before nesting existed.
- **The manifest row schema** (`MANIFEST_VERSION` 4) adds `outerLoops` to a step's row —
  everything beyond the `loopId`/`iteration` pair it already carried, absent outside nested
  loops. A loop's own row carries the same three fields, identified by *its* enclosing loop
  exactly as a leaf step's row is: round 2 of an outer loop gets its own row for the inner
  loop, rather than overwriting round 1's already-`done` one.
- **A run recorded before version 4 is refused on resume if its workflow now has a loop
  nested inside another** — there is no way to tell one round's rows from another's without
  `outerLoops`, so `planResume` throws a `ResumeError` telling the operator to start a fresh
  run rather than best-effort resuming into a state it cannot verify. A single-level pre-v4
  run resumes exactly as it always did: nothing about its identity changed.

### Relationship to `on_findings`

`on_findings` (below) predates loops and still governs a `verdict` step that is **not**
inside one. A verdict step inside an explicit loop is governed by the loop, and
`on_findings` never fires for it; `on_exhausted` reuses the same vocabulary
(`report` / `interactive`) so there is one set of words, not two.

## Disabling a step

`enabled: false` parks a step without deleting it or its prompt. Absent means enabled —
there is no schema default, because a default would serialise `enabled: true` onto every
step in every file on first save.

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
type to `retry` are opposite rules. `capture: 'note'` maps to `requiredFor: ['continue']`.

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

**The pattern every shipped workflow uses.** An outer loop, `until: sign-off`, wraps the
inner implement/review cycle and the sign-off step itself:

```yaml
- id: human-review
  kind: loop
  until: sign-off
  max_iterations: 5
  steps:
    - id: fix-cycle
      kind: loop
      until: review
      steps:
        - id: execute
          inputs: [plan, review, sign-off]   # sign-off: the previous ROUND's feedback
          # ...
        - id: review
          verdict: true
          inputs: [plan, execute, sign-off]  # FAIL unless every request was addressed
          # ...
    - id: sign-off
      kind: approval
      verdict: true
      capture: review
      show_diff: true
      inputs: [review]
      output: feedback.md
```

Both `execute` and `review` read `sign-off` as a forward reference to a *later sibling of the
outer loop* — dropped on the run's very first pass, when there is nothing yet to read, exactly
like a forward reference to a later sibling of their own inner loop. Requesting changes sends
`fix-cycle` round again with that feedback attached to both steps; `review` reading it too is
what makes the FAIL-unless-addressed instruction more than a suggestion — an attempt that
ignored the human's request fails the inner loop's own exit check, not just the outer one's.
Only the newest round's feedback carries forward: round 3 sees round 2's, not round 1's,
though round 1's stays on disk under its own round directory (see "Nested loops" above).
`human-review` can itself run out of rounds after enough `retry`s, the same as any other
loop — it stays resumable, and a resume grants one more round by default.

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
unmounting would throw away a typed note or a dozen per-file comments, exactly as it would
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
carries an optional **name** — a human label shown in the runs grid, the run page and OS
notifications, in place of the raw id:

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

Both values are **frozen for the life of the process**. A rename mid-run must not change a
slug a step has already put into a branch name, and `{{ run.name }}` must never disagree
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

## Desktop app architecture

Three principles hold the desktop shell to the same guarantees as the CLI:

1. **The workspace stays the source of truth.** Everything authoritative already lives in
   the workspace (`.whiphand/config.yaml`, `.whiphand/workflows/`, `.whiphand/runs/<id>/run.json` +
   `events.ndjson`). The desktop's own app-state store holds only *convenience* data —
   pointers, preferences, history. Deleting it must lose zero work and break nothing.
2. **The agent owns all disk I/O.** App-state persistence goes through `@whiphand/agent` RPCs,
   same as `readArtifact`. The webview gets no fs capability of its own beyond the Files
   tab's explicitly-granted scope (see the desktop webview security notes in
   `docs/review-backlog.md` if present, or `apps/desktop/src-tauri/src/lib.rs`).
3. **CLI/UI parity holds.** `@whiphand/core` is never given a UI-only code path, and no
   desktop feature does something the CLI cannot — see `parity/`.

**Workspace-scoped navigation.** The sidebar is organized by scope, since mixing the two
was the actual confusion:

- **Top** — the workspace switcher: colour dot, name, path. Pinned workspaces sort first;
  Ctrl/Cmd+K opens a filter-as-you-type switcher. The colour is an FNV-1a hash of the
  absolute path, so two workspaces named the same are still tellable apart.
- **Upper block** — pages that act on the open workspace: Runs, Workflows, Files, Settings.
  Disabled, not hidden, when no workspace is open.
- **Lower block** — pages that outlive any workspace: Activity, Doctor, Preferences. These
  work with no workspace open.

`nav.ts`'s `requiresWorkspace` column is the single source for which pages are gated.
Switching workspace clears the previous one's cached runs, workflows and config rather than
leaving them on screen until each page refetches, and every job is tagged with the
workspace it started in, so a run in one workspace never drives another's window title, run
rows, or notifications. One workspace is active at a time — there are no workspace tabs and
no second window — but the Activity page, sidebar job badges, and notifications all carry
cross-workspace *awareness*, and pinning plus Ctrl+K make switching cheap enough that
simultaneity is rarely what was actually wanted.

## Out of scope

DAG or parallel steps, `codex`/`gemini` adapters, per-step git worktree isolation, and
spend ceilings/telemetry (`max_spend_usd` — cycles are bounded by `max_iterations` only).
These are plausible follow-ups, not commitments.

## Releases

Releases are started by hand from GitHub Actions:

1. **Bump the version** in a PR and merge it: `npm run bump -- 0.1.4` writes the version
   everywhere it lives, `package-lock.json` included.
2. **Run the release workflow.** On GitHub, go to **Actions → Release → Run workflow**, keep
   the branch on `main`, enter the version (`0.1.4`), and run it.
3. **Wait for the build** (about 10–15 minutes). `.github/workflows/release.yml` checks that
   the version matches the code, then builds Linux and Windows into a draft release: the CLI
   binaries, the desktop bundles, `latest.json` for Tauri's updater, and a `SHA256SUMS` file.
   It publishes the release as `v0.1.4` only once everything is uploaded, with notes
   generated from the merged PRs. You can edit the title and notes afterwards.

Releases in this repo are **immutable**: once published, their files can't be changed, and a
version can't be released twice, even after deleting the release. A mistake ships as a new
patch version. If the build fails partway, nothing is published and the draft stays hidden:
re-run the failed jobs from the run page, or run the workflow again with the same version,
which reuses the draft.

Only the `.AppImage` and the Windows NSIS installer self-update. The `.deb` prompts with a
link to the release page instead, since Tauri's updater cannot install into a `.deb`.

### The updater signing key

Set up once for this repo. The steps below are kept for a fork or a change of owner, and
neither can be done by CI:

1. **Generate the key**, on your own machine:

   ```bash
   npx @tauri-apps/cli signer generate -w ~/.tauri/whiphand-updater.key
   ```

   Back the private key up somewhere outside GitHub before going further: Tauri's updater
   only accepts a manifest signed by the key matching the `pubkey` compiled into the
   installed app. If the private key is lost, every copy already out there is permanently
   unable to auto-update — there is no recovery path short of every user reinstalling by
   hand.
2. **Put the key into the repo and the CI secrets.** The *public* key is committed in
   `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json`. The private key
   and its password are repository secrets named `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, which `release.yml` passes to `tauri-action`.
   `node scripts/version.mjs --check-release` confirms the committed key is no longer the
   `REPLACE_WITH_OPERATOR_GENERATED_PUBKEY` placeholder.

The release URLs are already resolved, in the two places they are written — the
`plugins.updater.endpoints` entry in `tauri.conf.json`, and `RELEASE_PAGE_URL` in
`apps/desktop/src/lib/updater.ts`. Both point at `PlainBytes/whip-hand`. If the repo moves
to another owner, update both by hand: GitHub redirects the old slug, so nothing breaks the
day of the move and nothing tells you the values are stale either. The endpoint is the one
already-installed copies poll, so letting it rot is how a release quietly stops reaching
anyone; the `RELEASE_PAGE_URL` is the link a `.deb` user is sent to, so a stale one 404s for
exactly the people who cannot self-update.

`createUpdaterArtifacts` is passed by `release.yml` rather than set in `tauri.conf.json` on
purpose: set globally it would make every `tauri build` demand the signing key, including
local `npm run package` and CI's own packaging job, neither of which should need it just to
prove the bundle still builds.

### Rolling back a bad release (R6)

Every rollback below assumes the updater is actually configured — see "The updater signing
key" above. That matters here specifically: a release built with the placeholder pubkey
installs perfectly well and *then* cannot update, so the failure surfaces only when the next
release fails to reach anyone — at which point none of the rollback below can help, because
the broken copies are no longer listening.

`.github/workflows/release.yml` uploads the CLI binaries, the Linux/Windows bundles, and
`latest.json` into each release — the file every installed copy's Tauri updater polls via
`releases/latest/download/latest.json`. That URL always resolves to whatever GitHub
currently considers the repository's *latest* release, so un-shipping a bad one is a
release-metadata operation, not a rebuild:

- On the bad release's page, **Edit** it and tick **Set as a pre-release**. The repo's
  releases are immutable, but GitHub still allows changing the pre-release and "latest"
  flags, the title and the notes. **Deleting** the release works too, but it permanently
  retires that tag name. Either way GitHub stops considering it "latest", and the URL falls
  back to the most recent full release before it — whose own `latest.json`, uploaded when
  *it* was current, still points at itself, so already-updated clients see no further prompt.
- This does not un-install the bad version from a machine that already updated — it only
  stops the version from reaching anyone else. Whether a given install already has it has to
  be answered separately (`whiphand --version`, or the app's own version string).
- Do this **before** debugging the underlying break. Every minute the bad release stays
  "latest" is another running copy's updater offering it. The fix then ships as a new patch
  version, not as a re-publish of the bad one.

The workflow builds into a **draft** and publishes it last, and immutable releases are why.
Once a release is published, GitHub rejects any further asset upload
(`HTTP 422: Cannot upload assets to an immutable release`), so a flow that publishes first
and builds after cannot work. Drafts are still writable. The `prepare` job creates the draft,
or reuses one an earlier failed run left for the same version, and refuses a version that is
already published or whose tag already exists, since a tag from a deleted immutable release
can never be reused. `publish` attaches `SHA256SUMS` and only then flips `draft` to false. A
build that fails partway therefore leaves a hidden draft, not a half-populated public
release, and never reaches the updater.

Two matrix legs (`ubuntu-24.04`, `windows-latest`) both upload into that draft, addressed
by the id `prepare` outputs rather than by tag. Both also write its `latest.json`
— see the `build` job's `max-parallel: 1`, which exists specifically so the second leg's
read of the current manifest happens after the first leg's write, not concurrently with it
(confirmed by reading `tauri-action`'s `upload-version-json.ts`: it downloads any existing
`latest.json` asset, seeds its `platforms` map from that, and only overwrites the keys for
its own artifacts before re-uploading — a merge on read, not a blind overwrite, but still a
race if two legs read before either writes).
