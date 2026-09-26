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
clock and the feed's own last line, and read as a hang whenever the two disagreed. The rule
is per scope: a pill owns one step's facts, and a stage row owns the rollup over its stage
(step count, elapsed time, spend), and neither restates the other.

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

In the desktop terminal, **Shift+Enter** and **Alt+Enter** insert a newline in the runner's
prompt and **Enter** submits. Both combos send the same bytes, ESC CR (`\x1b\r`) — xterm
already sends that for Alt+Enter, and `TerminalPanel` remaps Shift+Enter to it, since xterm
otherwise sends a bare CR that the runner cannot tell from Enter. One sequence serves every
runner; there are no per-adapter overrides.

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

**HEAD is guarded the same way, for every agent step.** Layer 2 only sees the working tree, and
an agent that commits leaves the tree clean: the reviewers after it then review "the commit"
rather than the working tree, and the commit-message step finds an empty index. Prompt wording
alone did not stop it (in one run 4 of 5 stages were committed by the executor itself), so the
engine also records `git rev-parse HEAD` before each agent step and compares it after the step
— after the harvest, for an interactive one, where the tree check runs. If HEAD moved, the step
fails, naming the step and both commits. `allow_commits: true` on an agent step opts out, for
an agent that is meant to commit; the workflow's own `command` steps are never checked, because
committing is what they are for. Nothing is reverted: the failure is loud and the human decides.
A repository with no commits yet counts (its first commit is a move from "no commits"); a
workspace that is not a repository is skipped silently, and git failing where the tree guard's
snapshot worked is a `run:degraded` `git-guard` record, as everywhere else. Each step compares
against HEAD *as it began*, so a resumed run never trips over a commit the interrupted attempt
made — that commit is the human's to have noticed.

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
| `stages` | Runs its own `steps` once per file in a directory | `items`, `steps`, `max_retries` |

Every kind except `loop` and `stages` may carry `inputs` (artifacts of other steps, injected
as paths, or the reserved `attachments` — see "Attachments", below),
`output` (the artifact it writes — required for `agent`, optional elsewhere) and `verdict`.
Every kind, `loop` and `stages` included, may also carry `enabled: false` (see "Disabling a
step", below). See "Stages", below, for `kind: stages` in full.

`enabled` belongs on a step, not on the workflow — putting it (or any other unknown key) at
the workflow root fails to parse with `workflow: '<key>' belongs on a step, not on the
workflow`, naming the key. This is a root-level allow-list (`name`, `description`, `inputs`,
`on_findings`, `steps`), separate from the per-step misplaced-field diagnostic that catches a
`run:` on a step that forgot `kind: command`: that one maps a field to the single step kind
that owns it, and `enabled` has no single owner — it is valid on every kind — so it cannot be
registered there and gets its own check instead.

A workflow's own `inputs:` map (as opposed to a step's) takes `required`, `prompt`, `default`,
`remember`, and `multiline`. `remember` is a desktop New-run prefill hint — the CLI never reads
it — and without it a new run starts that field blank every time, even if a previous run filled
it in. `multiline` is also a desktop New-run display hint the CLI ignores: `multiline: false`
shows the field as a one-line box instead of the default growing text area.

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
      - id: test-fix        # repeats until the tests pass, before 'review' ever runs
        kind: loop
        until: tests
        max_iterations: 3
        steps:
          - id: execute
            runner: copilot
            mode: headless
            writes: true
            inputs: [plan, tests]   # `tests` is later in THIS loop => its previous iteration
            output: execute-report.md
            prompt: Implement the attached plan. This is attempt {{ loop.iteration }}.

          - id: tests
            kind: command
            run: npm test
            verdict: true            # a non-zero exit sends test-fix round again, not a crash
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

A downstream step's `## Input artifacts` line is labelled with that verdict, when the input
names a step that has one: `- tests: /…/tests.log (VERDICT: FAIL)`. Both PASS and FAIL are
labelled, so a prompt never has to guess whether an attached log is the one that just failed;
`attachments/*` entries, which name a file rather than a step, are never labelled.

### Command steps and shell injection

A `command` step's `run:` goes through **one POSIX shell dialect on every OS**: `/bin/sh` on
POSIX, and on Windows the `sh.exe` (or `bash.exe`) that Git for Windows brings, discovered
by *derivation from the resolved `git`* (`<git>\..\..\usr\bin\sh.exe`, `bin\sh.exe`, then
`bash.exe` in the same places, then `%PROGRAMFILES%\Git`) — never a bare `PATH` lookup for
`bash`, which on a machine with WSL finds `C:\Windows\System32\bash.exe`, a launcher that
runs the command inside the WSL filesystem where the workspace and every path we pass mean
nothing (that path is rejected by name even when found). `whiphand doctor` reports the shell it
resolved. With none present, doctor is red and command steps refuse to run, naming the
remediation; agent steps still work. Write command steps for `/bin/sh`: Git's `sh.exe` is bash in
POSIX mode and accepts most bashisms, so on Windows it will not catch a bashism, but the Linux
legs (dash) will.

**Values are data, never syntax.** `{{ }}` in a `run:` line does **not** expand to the value: it
expands to a *variable reference* — `{{ run.name }}` becomes `${WHIPHAND_RUN_NAME}`,
`{{ inputs.base }}` becomes `${WHIPHAND_INPUT_BASE}` — and the shell substitutes it, where it is
data. Parameter expansion never re-parses a value, so a run named `; rm -rf ~` or an input of
`$(touch pwned)` is inert in every context. The reference is unquoted, so as a bare word it
splits and globs like any unquoted shell variable: **quote it the way you would any shell
variable** (`"{{ inputs.base }}"`). Everything else a step declares — `cwd`, `env` values, an
agent prompt — is data we read, not a shell line, so those still get the value itself.

A `{{ run.* }}`, `{{ stage.* }}` or `{{ loop.* }}` naming a field not in the table below is refused
when the workflow is parsed, naming the step and field. It would otherwise stay in the text as
written: a stages glob over it matches nothing, and a prompt hands the agent a literal `{{ … }}`.
Braces outside those three namespaces are not placeholders and stay legal in any field.

Every placeholder has one environment binding, from one table:

| Placeholder | Variable | Exported |
|---|---|---|
| `run.id` / `run.slug` | `WHIPHAND_RUN_ID` / `WHIPHAND_RUN_SLUG` | always |
| `run.name` | `WHIPHAND_RUN_NAME` (an unnamed run's name *is* its id, so it refers to `WHIPHAND_RUN_ID`) | when named |
| `run.dir` | `WHIPHAND_RUN_DIR` — the run folder, absolute with forward slashes | always |
| `stage.index` / `total` / `id` / `title` | `WHIPHAND_STAGE_*` | inside a stages step |
| `loop.iteration` / `loop.max_iterations` | `WHIPHAND_LOOP_ITERATION` / `WHIPHAND_LOOP_MAX_ITERATIONS` | inside a loop |
| `inputs.<key>` | `WHIPHAND_INPUT_<KEY>` (upper-cased, `-` → `_`) | **only when the step references it** |

An input is exported only when the step's `run`, `env` or `cwd` names it, so "exported equals
referenced" holds by construction. A referenced input over the platform's environment limit
(128 KiB per variable on Linux, 32,767 characters on Windows) fails the step *before* spawn,
naming the input and its size. Two input keys that map to one variable (`a-b` and `a_b`), and two
`inputs:` step ids that map to one `WHIPHAND_ARTIFACT_*` name, are rejected at parse time.

**Three breaking changes**, in the changelog and the README:

1. On Windows the default shell is no longer `cmd.exe`. A workflow that implicitly assumed `cmd`
   must be rewritten for `/bin/sh`.
2. `{{ }}` inside single quotes in `run:` stops expanding: `run: echo '{{ run.name }}'` prints
   `${WHIPHAND_RUN_NAME}` literally. Quote it as you would any shell variable.
3. An explicit `shell:` of `cmd`, `cmd.exe`, `powershell`, `powershell.exe`, `pwsh` or `pwsh.exe`
   is rejected at parse time. Any other explicit shell gets `-c` — the author's own choice, which
   we neither reason about nor test.

**Decision: a whole-command input is run with an explicit `eval`, written by the author.** The
reference renderer never re-parses a value, which is what makes `{{ run.name }}` inert — and it is
also why a workflow whose input *is* a command (the shipped templates' `test_command`, typically
`cd app && npm test`) cannot use the bare reference: `${WHIPHAND_INPUT_TEST_COMMAND}` word-splits
into a command named `cd` with `&&` as an argument. The shipped templates, `whiphand init`'s
scaffolds and this repo's own workflows therefore say so in the `run:` line:
`run: eval "{{ inputs.test_command }}"`.

- **No new capability.** Before this change the input was spliced into the shell line as text, which
  was already code execution; `eval` preserves that, and the difference is that it now happens only
  where the author wrote the word, on an input the author named.
- **The rule for authors:** `eval` an input only when its whole purpose is to be a command someone
  typed. Never `eval` a run name, a stage title, or any free text that arrives from a plan file or
  another step — those stay plain references, which is the invariant-8 guarantee.
- **Considered and not built:** an input flag (`code: true`) that makes the renderer emit the `eval`
  itself, and `sh -c "$WHIPHAND_INPUT_X"`. Both move the trust decision out of the `run:` line the
  author is reading and into schema metadata, and both need a schema addition the plan did not agree
  to. If the explicit `eval` proves too easy to misuse, the flag is the follow-up.
- A blank `test_command` runs `eval ""`, which exits 0 — the templates' comments say so.

A `command` step also reaches its own `inputs:` this way rather than through `{{ }}`
templating: each entry with a recorded artifact is exported as
`$WHIPHAND_ARTIFACT_<ID>` (the id upper-cased, non-alphanumeric characters turned to `_` —
`commit-message` becomes `WHIPHAND_ARTIFACT_COMMIT_MESSAGE`), holding that artifact's path.
An id with nothing recorded yet (a dropped forward reference, a disabled step) exports
nothing, rather than a variable holding the empty string — a distinction a shell script can
tell apart with `${VAR:+...}` but a lie an always-present empty variable could not tell at
all. `attachments` entries are skipped: a command already reaches them at
`"$WHIPHAND_RUN_DIR/attachments"`.

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
- **A reference to a later step in loop L's body means "L's previous iteration".** It
  resolves to nothing on L's first iteration — including when L is nested inside an outer
  loop that has gone round again, so L itself is starting over: the reference is dropped
  there too, even though the outer loop's previous round may have left an artifact from L's
  last run sitting in the run's context. On any later iteration, it is simply dropped when
  there is none — for instance a body step after `until` that a passing or failing iteration
  skipped never leaves an artifact behind, so a sibling's forward reference to it stays
  dropped on every iteration, not just the first. That is how findings feed back into the
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
- **A forward reference into a nested loop still means that loop's own previous iteration**,
  not whatever the outer loop's previous round left behind. `test-fix` inside `fix-cycle`
  (the shape every shipped workflow uses to gate `review` on a passing test run) is the case
  this matters for: on round 2 of `fix-cycle`, `test-fix` starts over at iteration 1, and
  `execute`'s reference to `tests` must resolve to nothing there, even though `ctx.artifacts`
  still holds round 1's *passing* `tests.log`. `scopeInputs` resolves this by finding the
  referenced step's enclosing loop's frame — walking a step's own frame outward via `parent`
  when the reference reaches past it — and checking *that* frame's iteration, not just
  whether an artifact happens to be sitting in `ctx.artifacts` already.

### Relationship to `on_findings`

`on_findings` (below) predates loops and still governs a `verdict` step that is **not**
inside one. A verdict step inside an explicit loop is governed by the loop, and
`on_findings` never fires for it; `on_exhausted` reuses the same vocabulary
(`report` / `interactive`) so there is one set of words, not two.

## Stages

`kind: stages` is what a plan too large to review as one diff needs: instead of running its
`steps` body once over one input, like a loop does, it runs that body once per file in a
directory — build stage 1, get it reviewed and accepted, commit it, then move to stage 2 —
so no single review has to hold the whole feature in its head at once.

```yaml
- id: build
  kind: stages
  items: "{{ run.dir }}/plans/*.md"     # templated glob, re-evaluated before every stage
  max_retries: 2                        # default: 2 (so 3 attempts total); non-negative
  steps: [...]
```

**Discovering stages.** `items` is globbed against the run's workdir (`discoverStages`,
`engine/stages.ts`) — or absolutely, as the shipped workflow's `{{ run.dir }}/plans/*.md` is —
and sorted by path with plain `<`, not locale collation — which
would sort `03a-api` after `04-ui` and defeat the point of a letter-suffixed file landing
between two numbered ones. The list is re-globbed before every stage, not just once at the
start:

- **A stage's id is its whole basename minus extension** (`03a-api.md` → `03a-api`), never
  the slug with the leading number stripped — stripping it would collide `01-api` and
  `03a-api` on `api`, and the runner picks the next stage as "the first id not yet
  completed", so the second file would silently never run. The price is that renaming or
  renumbering an already-completed stage file makes it run again under its new id — a
  visible surprise, not a silent skip.
- **A stage's title is its file's first `# heading`**, else its id — most plans open with
  one, and falling back keeps a heading-less file usable instead of blocking the run over it.
- **Re-globbing before every stage** means a file added mid-run gets picked up, and a pending
  file deleted mid-run simply stops appearing (the run moves on to whatever is next) — but an
  id already recorded as completed is never re-run just because its file is now gone. Only
  the *first* glob matters for "no stages at all": it fails the step, naming the pattern,
  if it matches nothing; a later glob emptying out (every remaining stage removed) ends the
  step cleanly instead.
- A stage id containing `@`, `#`, `/` or `\` is refused outright — those would corrupt the
  execution key or a path segment. An id that does not read as `NN-slug` (optionally `NN`
  plus one trailing letter) only gets a `guard:warning`: the convention is what keeps
  ordering obvious, but a stray file that breaks it is not worth stopping the run over.

**Inside a stage.** A step declared in a `stages` step's own body can read the stage
currently running:

| | prompts, manual titles/instructions | a `command` step's shell |
|---|---|---|
| the title | `{{ stage.title }}` | `$WHIPHAND_STAGE_TITLE` |
| the id | `{{ stage.id }}` | `$WHIPHAND_STAGE_ID` |
| the 1-based position | `{{ stage.index }}` | `$WHIPHAND_STAGE_INDEX` |
| how many stages in total | `{{ stage.total }}` | `$WHIPHAND_STAGE_TOTAL` |
| the stage file's path | — | `$WHIPHAND_STAGE_PATH` |

`inputs: [stage]` attaches the stage file itself, the same as any other artifact reference —
real only inside a `stages` body, exactly as `loop.*` is only real inside a loop, so a reader
outside one is refused at validation time rather than left to fail at render time. `stage` is
also a reserved step id, but only in a workflow that actually has a `stages` step: one with
none (every pre-`stages` shipped template) may still declare a real step named `stage`, and
`inputs: [stage]` there keeps resolving to it exactly as before.

**Per-stage scope.** A stage's artifacts, verdicts and findings are cleared between stages —
the next one sees only what existed before the `stages` step began, plus its own work, never
an earlier stage's. A step outside the `stages` step can never read one declared inside its
body (naming it in `inputs:` is refused at validation time: "whose artifacts do not outlive a
stage"), and each stage's own artifacts land under
`<runDir>/<stagesId>/<stageId>/attempt-<n>/<output>` — one directory per attempt, so a
rejected attempt's work is never overwritten by the retry that follows it.

**`allow_paths`.** A `writes: true` agent step may restrict what it is allowed to have
touched: once it returns, any changed path that matches none of `allow_paths`'s globs fails
the step, naming the file. The shipped `staged-feature-development` workflow's planning step
uses `allow_paths: ["{{ run.dir }}/**"]`, and stays `writes: true` because a `writes: false`
step has its write tools denied outright, so the planner could not write its stage files. The
git guard ignores every path with a `.whiphand` segment, so writes into the run folder never
appear as changes, and the effective rule is "any change to the repository fails the step".

**Where the stage files live.** The shipped workflow's planner writes them to
`<runDir>/plans/NN-slug.md`, not to the repository (`{{ run.dir }}` is the absolute run folder,
the same value as `$WHIPHAND_RUN_DIR`). They are not committed to the branch or the PR — there is
no `plan_dir` input and no `commit-plan` step — and they are deleted with the run when
`runs.max_retained` prunes it. A resume reuses the same run folder, so they survive one. Because
the glob is absolute, a glob metacharacter (`[`, `*`, `?`, `{`) in the workdir path would break
it; that limit is documented, not worked around.

**Gating a stage.** The schema requires every enabled step with `verdict: true` in a
`stages` body — at any depth, including a loop's `until` and a verdict step nested two loops
deep — to be followed, later in document order, by an enabled `manual` or `approval` step
placed directly in the stages body, not inside any loop. The error names the verdict step, the
stages step, and the gate to add. Without one, a failing verdict inside a stage would be carried
past to the end of the body and restored away when the stage was accepted: the run would end
ok without anyone having seen the failure. So a gate only inside the loop, a gate inside a
later loop, a disabled gate, and a verdict step (say a `tests` command) placed after the last
gate are all refused at parse time, and the runner never needs to invent a gate.

Only a gate directly in the body carries the stage's verdict. It needs no `verdict: true`:
*continue* passes and *retry* fails, exactly like a loop's `until` step, because accepting or
rejecting a stage already says which. A gate inside a loop in the body is an ordinary step of
that loop, and its `retry` does not re-run the stage. `retry` at a body-level gate re-runs the
stage from the top. The rejection note is injected as findings into the stage's retry target,
the last `writes: true` agent step before the gate, by the same mechanism a top-level
`on_findings: loop` re-run uses. This can happen up to `max_retries` times (default 2, so 3
attempts total). Once they run out, the stage opens a live triage session seeded with the last
rejection and the run stops, resumable at that stage with one more attempt.

**A loop that runs out inside a stage** does not fail the run. It ends the attempt's work at
that point: the loop and every loop enclosing it inside the stages body stop there, at
whatever round they were in, so an outer review loop does not go round again spending its
budget before a human sees anything. The stage carries on to its next body-level step, which
the rule above guarantees includes a gate. The gate is told once per loop that ran out
("The review cycle 'test-fix' never passed within 3 iterations — its findings are attached."),
and that loop's `until` artifact is put in front of the human even if the gate did not list
it. A loop that sets its own `on_exhausted: interactive` still opens triage and stops the run,
as it does outside a stage. Outside a `stages` step, loop exhaustion is unchanged.

A gate also says "This stage produced no changes." when the tree is exactly as it was when
the stage began, so the human accepts an empty stage knowingly rather than having it skipped.
The claim rests on the same assumption as the diff above: an implementer that commits its own
work leaves an unchanged tree, and the note then says "no changes" about a stage that did the
whole job.
A resumed run leaves that note off for any stage it re-enters: the process can only snapshot
the tree after the earlier process's edits, so an unchanged tree since then proves nothing.
A stage the resume reaches for the first time still gets the note.

**Accepting a stage is authoritative**: it restores the run's own verdict to whatever it was
before the stage started, so a review the human waved through does not also fail the run. A
genuine failure from before the `stages` step began is not erased by it either.

**A stage with no diff is a normal stage.** A stage whose work turned out to need no change
to the tree — a no-op refactor stage, a stage that was already satisfied by earlier work —
still goes through `accept` like any other: the diff the gate shows is simply empty, and
accepting it says "correct, move on" rather than "here is a change". The shipped workflow's
per-stage `commit` step accounts for this: a bare `git commit` would exit 1 ("nothing to
commit") and fail the run right there, so it checks the index first (`git diff --cached
--quiet && echo … || git commit -F …`) and exits 0 without committing when there is nothing
staged. A real commit failure — a rejecting hook, a bad message file — still exits non-zero
and fails the run loudly, exactly as every later stage's assumption that history is clean
requires; nothing here blanket-forgives a failing commit the way `expect_exit: [0, 1]` would.

**The shipped staged workflow runs unchanged on every OS.** Its per-stage
`commit` step is a POSIX shell line (`$VAR`, `&&`/`||` beside quoted arguments), and command
steps run through a POSIX shell everywhere now — see "Command steps and shell injection" — so the
templates are identical bytes on Linux, macOS and Windows, and the tests that execute them run on
every CI leg.

**Nesting.** A `stages` step cannot sit inside a loop, and cannot sit inside another `stages`
step. A loop's `until` can never name a `stages` step either — `until` needs a non-container
step with a verdict to watch, and a `stages` step is a container. All three are refused at
validation time, before the run ever starts.

**Unattended runs.** `whiphand run --yes` (and `--resume --yes`) refuses a workflow with a
gate inside a `stages` step that carries no explicit `default: continue` or
`default: abort` — the ordinary default of taking `continue` would otherwise let an
unattended run wave through every stage unread, the exact thing `stages` exists to prevent.
A gate outside any `stages` step is unaffected; `--yes` has always been allowed to answer it.

**Resuming.** A resumed run skips every stage already accepted and restarts the one that was
left unfinished, resuming at whichever attempt was in progress. If that attempt was
interrupted (the process died mid-attempt) rather than rejected at the gate, its implementer
is told a previous attempt was interrupted and to reconcile whatever it left in the tree,
rather than starting from a clean slate that is a lie. A stage that went all the way to a
triage session after exhausting `max_retries` is granted one attempt beyond what it used,
replacing `max_retries`' count for that stage only. Attempts that are already over (an accepted stage, an attempt a
gate already rejected, a stage handed to triage) are only replayed to restore their verdicts.
Their loops replay at exactly the budget and rounds the manifest recorded, whatever
`--max-iterations` or `--extra-iterations` say, so a resume never spawns an implementer inside
work a human has already answered.

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

That diff is the working tree **against `HEAD`**, so a workflow that gates on one has to tell
its implementing agent to leave the work uncommitted — an agent that commits as it goes leaves
a clean tree and a human approving a blank screen. Nothing in the engine enforces it: a commit
*removes* porcelain lines rather than adding them, so the write-guard's snapshot cannot see one
either. Every shipped template says it in its `execute` prompt, and scaffold.test.ts pins that.

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
        - id: test-fix          # repeats until the tests pass, before 'review' ever runs
          kind: loop
          until: tests
          steps:
            - id: execute
              inputs: [plan, tests, review, sign-off]  # sign-off: the previous ROUND's feedback
              # ...
            - id: tests
              kind: command
              verdict: true
              output: tests.log
              # ...
        - id: review
          verdict: true
          inputs: [plan, execute, tests, sign-off]  # FAIL unless every request was addressed
          # ...
    - id: sign-off
      kind: approval
      verdict: true
      capture: review
      show_diff: true
      inputs: [review]
      output: feedback.md
```

`execute` sits one loop deeper than `review` — inside `test-fix`, which `fix-cycle` wraps — so
it reads three forward references, one per enclosing loop: `tests` (its own loop, `test-fix`),
`review` (one loop out, `fix-cycle`) and `sign-off` (two loops out, `human-review`). Each is
dropped exactly when *that* reference's own loop is on its first iteration, whether or not an
outer loop has gone round before — see "Nested loops" above. `review` reads `sign-off` the same
way, one loop out from its own `fix-cycle`. Requesting changes sends `fix-cycle` round again
with that feedback attached to both `execute` and `review`; `review` reading it too is
what makes the FAIL-unless-addressed instruction more than a suggestion — an attempt that
ignored the human's request fails the inner loop's own exit check, not just the outer one's.
Only the newest round's feedback carries forward: round 3 sees round 2's, not round 1's,
though round 1's stays on disk under its own round directory (see "Nested loops" above).
`human-review` can itself run out of rounds after enough `retry`s, the same as any other
loop — it stays resumable, and a resume grants one more round by default.

### The research workflow

`whiphand init` also ships `research`, which answers a question instead of building anything, so
it has no branch, no `test_command` and no commit. It is the same two-loop pattern with a report
where the diff would be:

```yaml
- id: frame                # interactive, read-only: settle the brief with the human
  output: brief.md
- id: human-review
  kind: loop
  until: read
  steps:
    - id: investigate
      kind: loop
      until: check
      max_iterations: 3
      steps:
        - id: research     # headless, read-only: writes report.md
          inputs: [frame, check, read]
        - id: check        # headless, read-only, verdict: true
          inputs: [frame, research, read]
    - id: read             # approval, capture: review, shows the report
      verdict: true
      inputs: [research]
```

`frame` opens by asking for files or docs to read first, then settles the precise question, what
is in and out of scope, which sources count, and what the answer must contain. Its artifact is
`brief.md`. `research` writes `report.md` with four sections — `## Answer`, `## Evidence` (each
claim tied to a `file:line` or a URL), `## Confidence and gaps` and `## Open questions` — and may
make no claim without a source. Web access is whatever tools the runner gives the step; the
prompt only says to use them if there are any. `check` fails the report when it does not answer
the brief's questions, when a claim has no source, or when a source it spot-checks does not say
what the report claims, and sends `research` round again with its findings. `read` shows the
report; approving ends the run, and requesting changes sends `investigate` round again with the
comment attached to both `research` and `check`.

`read` has no `show_diff`, since nothing in the working tree changes, so `capture: review` takes
an overall comment and no per-file ones, and `validateWorkflowWarnings` says so. That is the
intended shape here, not a mistake to fix.

### The bugfix workflow

`whiphand init` also ships `bugfix`, which fixes a bug test-first so that "fixed" is evidence and
not a claim. It is `feature-development` with a diagnosis in place of the plan, and a red gate
between writing the test and touching any code:

```yaml
- id: sync-base / branch    # git checkout <base> && pull; then git checkout -b fix/<run slug>
- id: diagnose              # interactive, read-only, opus: writes diagnosis.md
- id: reproduce             # headless, writes: the regression test and repro.sh, no fix
  inputs: [diagnose]
- id: confirm-red           # command: repro.sh must FAIL, or the run fails
- id: human-review
  kind: loop
  until: sign-off
  steps:
    - id: fix-cycle
      kind: loop
      until: review
      max_iterations: 3
      steps:
        - id: test-fix
          kind: loop
          until: tests
          steps:
            - id: execute   # inputs: [diagnose, reproduce, tests, review, sign-off]
            - id: tests     # command, verdict: ( . repro.sh ) && eval "<test_command>"
        - id: review        # verdict: root cause, regression test intact, no unrelated change
    - id: sign-off
- id: stage / commit-message / commit
```

`diagnose` opens like every plan step, by asking for files to read first, and asks for logs and
stack traces too. Its artifact, `diagnosis.md`, has five sections: `## Symptom`, `## Root cause`,
`## Regression test` (the file, and what it asserts), `## Test command` (one line, just that test)
and `## Fix outline`. `reproduce` writes only the test. It puts the command that runs it in
`<run dir>/repro.sh` and reports, under `## How it fails`, the failure it saw and why that is the
bug's symptom and not a mistake in the test.

**How the command reaches the gate.** The command is diagnosed after the run has started, and
inputs are all collected before it does (a missing required one is refused up front), so a second
input `repro_command` has no point at which to be asked. Instead `reproduce` writes the command
into `repro.sh` in the run folder, and the command steps source it in a subshell, `( . repro.sh )`,
rather than run `sh repro.sh`. Command steps already run under a POSIX shell on every OS (see
"Command steps and shell injection"), so the `if`/`$?` around it mean the same on Windows, through
Git's `sh.exe`, as on Linux. That shell is started by absolute path and is not a login shell, so on
Windows a second `sh` looked up by name resolves only if the user has Git's `usr\bin` on their
PATH, and when it does not it exits 127, which the red gate would report as the agent's script
failing to run the test. Sourcing looks nothing up, and an `exit N` in the script ends only the
subshell, with N, so the 0 / 126 / 127 / other handling below is unchanged. A script file needs no
extracting from markdown, no requoting into a `run:` line and no CRLF handling, which reading the
command out of the diagnosis's `## Test command` section would.

**The red gate.** `confirm-red` runs `repro.sh` and inverts the result by hand. `expect_exit` lists
the exit codes that count as success, and "any failure" is not a list: runners disagree on what a
failing test exits with (1, 2, 101), so there is no short list to write. The gate opens on any
non-zero code except 126 and 127, which mean the test never ran and so prove nothing about the bug.
A missing `repro.sh` is checked for by name, because sourcing a file that is not there is a
shell-dependent error, and 2 is a plausible failing-test code. A test that passes fails the run with `the regression test passed,
so it does not reproduce the bug` in the step's log, before any fix is attempted. The gate cannot
tell a test that fails for the bug's reason from one that fails for another; that is what
`reproduce`'s `## How it fails` and the review are for.

**The fix cycle.** The shape is `feature-development`'s. `tests` sources `repro.sh` first, then the
`test_command`, so the fix is checked against the regression test even when the test command is
blank or does not pick the new test up, and the suite runs only once that test is green. `execute`
is told to fix the root cause, to leave the regression test alone (it may strengthen it, never
weaken, skip or delete it), and to change nothing the fix does not need. `review` fails a fix that
masks the symptom (a special case for the failing input, a swallowed error, a widened tolerance, a
retry), a regression test weaker than the diagnosis and the `reproduce` report say it is, and
changes outside the diagnosis. The test and the fix are one uncommitted diff, so `review` compares
the test against those two descriptions and not against a snapshot of the test as first written.

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
| the run directory | `{{ run.dir }}` | `$WHIPHAND_RUN_DIR` |

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

**The run's step strip.** The strip above the tabs on the run screen follows five rules, so
that a run with many stages fits on screen and looks the same at any window size:

- **Nothing in it wraps.** A row of step pills scrolls sideways instead, so the layout does
  not depend on window width.
- **The top level stacks into bands.** Consecutive ordinary steps share a band; a `stages`
  step takes a full-width block of its own between bands.
- **Each stage is one collapsible row.** Closed, a stage is a single line carrying its
  rollup; open, it shows its steps. A stage starts open only if it holds the focused step,
  is running, or has failed.
- **The strip is capped and scrolls.** It is limited to a clamp of the frame's height
  (`clamp(140px, 38%, 460px)`), so expanded stages cannot squeeze the tabs panel away. The
  cap is CSS, not a measurement: the page's `<main>` is its only scroller and the run frame
  fills it, so the percentage resolves with no JavaScript. The collapse chevron remains the
  way to hide the strip entirely.
- **The open stage follows the run until the reader touches it.** The first explicit open
  or close latches the following off for that run, and from then on stages neither fold nor
  steal focus as the run moves on. Reopening a run starts following again.

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
