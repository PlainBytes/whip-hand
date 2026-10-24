# Changelog

## Unreleased

### Warnings can be dismissed

- Every warning bar in the desktop app now has a close button. A dismissed warning stays hidden
  while its condition holds and comes back when the condition recurs or changes.
- The "Saving rewrites the config file" note on workspace settings stays dismissed across restarts.
- Errors, and the "agent down" banner, still cannot be dismissed.

### The TUI always asks before it quits

- Quitting the TUI by key now asks first even when no run is in progress. It used to exit at once, so
  a burst of `q` on the first screen could close it. With runs in progress the question still warns
  that they will be cancelled and can be resumed.
- A repeated `q` stops at the question; only `y` confirms.
- A signal or a dead host still quits without asking.
### Ctrl+Tab cycles run tabs

- Ctrl+Tab moves to the next tab of the current workspace on the Runs page, and Ctrl+Shift+Tab
  to the next tab across all workspaces (Ctrl, not Cmd, on macOS). Ctrl+PageUp/PageDown still work.

### Read-only steps always write their artifact, and worktree runs stay in the worktree

- A read-only claude step may now use Write and Edit on its own artifact and on nothing else. It
  used to need a shell heredoc, which a user's hook or policy could block. When that happened the
  step "succeeded" without its artifact and the run failed.
- A read-only opencode step in a worktree run can write its artifact in the run folder.
- An interactive step inside a loop or stage now has its artifact harvested to the path the engine
  checks (`<loop>/iter-N/…`), not to the top of the run folder.
- In a worktree run, a step that changes the main checkout instead of the worktree now fails and
  names the files, and agents are told which tree is theirs.
- "Expected artifact was not written" now names the artifact by its workspace-relative path.

### The terminal UI ships on its own

- Plain `whiphand` in a terminal opens the TUI. From a script or a pipe it prints the usage, as
  before.
- `whiphand desktop` starts the desktop app.
- **The desktop executable is now `whiphand-desktop`.** The desktop `.deb` and the Windows installer
  now also install the `whiphand` CLI beside it, and the Windows installer adds its folder to your
  PATH. Menu entries and shortcuts are updated by the upgrade.
- The Linux CLI is a static binary, so it runs on any distribution, an old SSH server's included,
  not only on the Ubuntu release that built it.
- New ways to get the CLI and TUI without the desktop app: a `whiphand-cli` `.deb` on each release,
  `install.sh` / `install.ps1` (they check the download against `SHA256SUMS`), and winget
  (`PlainBytes.Whiphand`).

### opencode steps work with OpenCode 2.0

- Interactive opencode steps report when the session is waiting for you again, and the session id is
  captured as soon as the session starts. The plugin was listening for OpenCode 1.x events that 2.0
  no longer sends, so it captured nothing, and harvest had to guess the session from
  `opencode session list`.
- The config whiphand passes opencode uses 2.0's own `agents`, `permissions` and `plugins` keys
  instead of the 1.x ones 2.0 still migrates.
- Headless opencode steps count every turn. opencode 2.0 usually leaves out the last turn's
  `step_finish`, so the count was one short. That turn's cost is still missing, because opencode never
  prints it.
- `whiphand doctor` asks for opencode 2.0.30 or newer. Older 2.0 releases ignore the instructions
  whiphand gives an interactive session, so the model is never told how to end the step, and up to
  2.0.18 the step's prompt sits in the input box unsent.
- Runners now see `$PWD` set to the folder they run in. opencode's `run` takes its project from
  `$PWD`, so `whiphand run -C <dir>` started elsewhere had opencode treat the step's own folder as
  outside the project and reject reading it. The "no provider credentials" note now says that opencode's
  free models still work without a login.

### Copilot steps are more reliable

- A copilot step that fails now says why. The reason copilot reports (an unavailable model, an exceeded
  quota, a missing login) is added to "exited with code 1", from its JSON stream or its `Error:` line.
- Interactive copilot steps report when the session is waiting for you (your turn, a permission prompt,
  a question it asked), as claude and opencode steps already did. The report comes from hooks in a
  plugin mounted for that one session, and copilot's `beep` setting is no longer needed. The doctor
  note asking for it is gone.
- Harvest no longer passes the step's `--model` again. The resumed session keeps the model it ran with,
  so a model copilot replaced with a fallback during the session no longer fails the harvest.
- Run auto-naming with copilot gets the name alone. Before, copilot's narration of reading the prompt
  file ended up in the name.
- Headless and harvest spawns pass `--no-ask-user`, and effort is passed as the documented
  `--reasoning-effort`.

### A terminal UI: `whiphand tui`

- `whiphand tui [-C dir]` is a keyboard-only front end for terminals, tmux and SSH, beside the desktop
  app, on the same in-process agent. It is no longer marked experimental.
- Follow runs (step tree, log, events, artifacts, diff), start them from a form built from the
  workflow's inputs, and cancel, resume, rename, lock or delete them.
- Interactive steps: `t` hands the terminal to the step's session and `Ctrl-]` comes back while it
  keeps going. Settings picks the detach key and can attach a run started here by itself.
- Approvals and manual steps with the run's diff, a note and per-file comments.
- Workflows edited in `$EDITOR` and saved only once they validate; config, run retention, pruning and
  each runner's models in Settings.
- A run another whiphand process drives shows as foreign and read-only.
- A signal or a closed terminal puts the terminal back and stops runs the way quitting does, so they
  can be resumed. AltGr characters type on Windows, a paste goes into a field whole, and colours are
  brought down to 256 or 16 when the terminal shows no more.

### Worktrees start from the up-to-date base

- A run's worktree now starts from the base branch's fetched upstream by default. `worktree.sync: false`
  opts out and starts from the local base.
- The base branch is never checked out, so concurrent runs no longer fail with "already checked out".
- A failed or non-fast-forward sync falls back to the local base and records a `worktree-sync` degraded
  warning.
- Worktree folders are named `<run-id>-<slug>` (just `<run-id>` for an unnamed run).
- `develop` no longer has a `sync-base` step; the engine does the fetch, so `develop` can no longer
  `git reset --hard` your own checkout when it runs without a worktree.
- An existing workspace keeps its old `develop.yaml`, which still works, until you replace it
  (`whiphand init` writes templates to new workspaces only).

### Three starter workflows instead of six

- `whiphand init` now ships `iterate`, `develop` and `research` only. `feature`, `feature-development`,
  `spec-driven` and `bugfix` are no longer shipped.
- `iterate` is new: on the branch you are on, in your own checkout, it plans, implements, tests and reviews
  in a cycle, then commits on sign-off. It never switches or creates a branch, so it suits several small
  iterations on one branch. Changes already uncommitted when it starts end up in its commit; its first step,
  `baseline`, records them (`git status --porcelain`) so the review does not hold them against the run.
- `develop` is `staged-feature-development` renamed. Its push is now `eval "{{ inputs.push_command }}"`,
  default `git push -u origin HEAD`; leave the input blank to skip pushing.
- `iterate`'s planning step takes `--attach` files, like `develop` and `research`.
- `whiphand new-workflow` scaffolds from `iterate` instead of `feature`.
- `whiphand init` leaves existing workflow files alone. To switch an existing workspace over, delete the old
  files from `.whiphand/workflows/` and run `whiphand init`.

### Runs can execute in their own git worktree

- A workflow can declare `worktree:` (`true`, `false`, or `base` and `branch` templates). The engine then
  creates a worktree under `.whiphand/worktrees/<run-id>` on a new branch before step one, and every step
  runs there, so two runs of the same workflow no longer share a checkout. The run folder and its artifacts
  stay in the workspace; agents that need them are given `--add-dir`. Resuming returns to the same worktree
  and is refused if it is gone.
- `{{ run.workdir }}` / `$WHIPHAND_WORKDIR` is the directory steps run in: the worktree, or the workspace
  when the run has none.
- `whiphand run --worktree` and `--no-worktree`, and a switch in the desktop's New Run dialog, override the
  workflow's setting for one run.
- A run's diff is read from its own worktree, so the review screen shows that run's changes.
- Deleting a run, and pruning, remove its worktree. A worktree with uncommitted or untracked changes is not
  removed: delete refuses and pruning skips it. Branches are never deleted.
- `whiphand worktree remove <run-id> [--force]` removes a run's worktree by hand and keeps the run.

### The shipped branching workflows run in a worktree

- `feature-development`, `staged-feature-development` and `bugfix` now declare a worktree on `feature/<run slug>`
  (`fix/<run slug>` for `bugfix`) and no longer have a `branch` step. `sync-base` fetches the base and resets the
  fresh branch to it (`git fetch origin <base> && git reset --hard FETCH_HEAD`) instead of checking out the
  base in your working folder, so your checkout is left alone.
- `whiphand init` writes these to new workspaces only. An existing workspace keeps its copies, which still
  check out and branch in the working folder; delete one and run `whiphand init` to get the new version.

### A `bugfix` workflow that proves the bug before fixing it

- `whiphand init` now ships `bugfix`, which fixes a bug test-first. It syncs your trunk and cuts `fix/<run slug>`,
  then you and the agent settle the diagnosis in a live chat: the root cause, where the regression test goes, and
  the exact command that runs just that test. A headless agent writes only that test and the command, and the
  run stops with a clear message unless the test fails. A test that passes before the fix does not reproduce the
  bug, and a command that could not run does not count as a failure.
- Only then does the fix start. It runs in the usual cycle of fix, tests and review, then your sign-off, then a
  commit. The tests step runs the regression test first and your test command after it, so a blank test command
  still checks the fix against the test that proves the bug. The review fails a fix that masks the symptom
  instead of removing the root cause, a regression test that was weakened, and unrelated changes.
- It asks what is broken (steps, expected against actual), the branch to start from, and a test command that is
  remembered like the other workflows'. The agent hands the test command to the workflow as a file, `repro.sh` in
  the run folder, so it must be POSIX `sh`, the same shell command steps use on Windows. The steps source it in a
  subshell rather than run `sh repro.sh`, so they need no `sh` on the Windows PATH.

### A real `research` workflow

- `whiphand init` now ships `research`, which answers a question instead of building something. You settle the
  question with the agent in a live chat first (the precise questions, what is in and out of scope, which sources
  count, what the answer must contain). A headless agent then writes a report with an answer, evidence, confidence
  and gaps, and open questions, tying every claim to a `file:line` or a URL. A second agent checks the report
  against your question and spot-checks its sources, and the two go round up to three times until the check passes.
  You then read the report and either accept it or send it round again with a comment.
- It replaces the old `research.yaml` stub in this repo, which asked "What are we building?" and ran only a plan.
  An existing `.whiphand/workflows/research.yaml` in your own project is left alone; delete it and run `whiphand init` to get
  the new one. It has no test command and never changes your files. Web access depends on the tools your runner has.
- Running it prints a warning that the `read` step's review has no diff to comment on. That is expected here.

### An agent step that commits now fails the run

- A workflow's agents are told not to commit, and in one run four of five stages were committed by the executor
  anyway — so the reviewers looked at "the commit" instead of the working tree, and the commit-message step found
  nothing staged. whiphand now compares `HEAD` before and after every agent step and fails the step if it moved,
  naming the step and both commits. Nothing is reverted; you decide what to do with the commit.
- `allow_commits: true` on an agent step lets that one step commit (it is a switch on the step in the workflow editor
  too). `command` steps are never checked. It is an error on any other kind of step. The shipped workflows need no
  change.
### Shift+Enter and Alt+Enter add a new line in the terminal

- In an interactive session's terminal, Shift+Enter and Alt+Enter now insert a newline in the CLI's prompt instead
  of submitting it. Enter still submits. The same applies in the web build.

### The run's step strip is smaller and stays put

- On a run with several stages, each stage now collapses to a single line showing its step count, elapsed time and
  spend, and opens on click. The stage that is running stays open by itself and follows the run along, until you
  open or close one yourself.
- The strip has a height limit: with many stages open it scrolls instead of pushing the Terminal, Artifacts and Logs
  panel off the screen. The chevron still hides it completely.
- Resizing the window no longer rearranges the strip. Steps that do not fit scroll sideways instead of wrapping onto
  new rows.

### Doctor says when an installed tool is not logged in, or not set up

- `whiphand doctor` and the desktop's Doctor page add a note under `claude`, `copilot`, `opencode` and `gh` when the
  tool is installed but has nothing to authenticate with, naming the fix (for example
  ``not logged in — run `claude` and use /login``). The row stays `✔`: the binary is there.
- The checks are local and never interactive — an env var, a credentials file, or a subcommand that stays on the
  machine — so being offline never reads as logged out. When a check times out, cannot read its file or gets an
  answer it does not recognise, there is no note. The claude check is skipped on macOS, where the login lives in the
  Keychain.
- Two more notes for an install that is present but not doing its job. The rtk row says when claude is installed
  and no user-level Claude Code settings file has a hook that calls rtk (``run `rtk init -g` to set it up``). A
  harness older than the oldest version its adapter was verified against (claude 2.1.260, copilot 1.0.83, opencode
  1.17.13) says so, and that it should be updated. Neither changes the row's `✔`, and an unreadable settings file
  or an unparseable version gives no note.

### Doctor checks for tools that make agents more effective

- The support group gains six optional rows: `gh` (PRs, issues and CI logs without scraping the web),
  `ast-grep` (structural search and rewrite), `yq` (jq for YAML), `uv` (fast Python environments, `uvx`),
  Universal Ctags (a symbol index) and `scc` (a size and language map; `tokei` answers for it). A machine
  without them shows `○`, never `✘`.
- `whiphand doctor` wall time is unchanged at ~0.6s: the new probes run in parallel and the slowest existing
  one, opencode, still sets the pace.

### Doctor lists only harnesses whiphand can drive

- The `[detect only]` marker and badge are gone from `whiphand doctor` and the desktop's Doctor page: every row in
  the "AI harnesses" group is a registered runner, so any of them can be a workflow's `runner:`. `codex`, `gemini`
  and `cursor-agent`, which had no adapter, no longer appear.
- The harness group is built from the adapter registry. `doctor.yaml` may override a harness entry's label, url
  and `optional`, but a `group: harness` entry for an id with no registered adapter is rejected.
### `{{ run.dir }}`, and unknown placeholders are refused

- `{{ run.dir }}` names the run directory, the same absolute, forward-slash path as `$WHIPHAND_RUN_DIR`, so a
  planning step can write stage files there and a `stages` step can glob them (`items: "{{ run.dir }}/plans/*.md"`).
- A `{{ run.* }}`, `{{ stage.* }}` or `{{ loop.* }}` with a field that does not exist is now a parse-time error
  naming the step and field. It used to stay in the text as written, so a stages glob over it failed only after
  the steps before it had run.

### Windows: one way to do paths and processes

**Breaking changes**

1. **The Windows default shell is no longer `cmd.exe`.** Command steps run through one POSIX shell on every
   OS: `/bin/sh` on POSIX, and on Windows the `sh.exe`/`bash.exe` that ships with Git for Windows, found by
   deriving it from the `git` on `PATH` (never a bare `bash` lookup — `C:\Windows\System32\bash.exe` is the WSL
   launcher and is rejected by name). Workflows that implicitly assumed `cmd` must be rewritten for `/bin/sh`.
   With no POSIX shell present, `whiphand doctor` is red and command steps refuse to run, naming the fix;
   agent steps still work.
2. **`{{ }}` in a `run:` line expands to a shell variable reference, not the value.** `{{ run.name }}` becomes
   `${WHIPHAND_RUN_NAME}`; the shell substitutes it, so a value is data and never syntax. Consequently a
   placeholder inside single quotes no longer expands (`echo '{{ run.name }}'` prints `${WHIPHAND_RUN_NAME}`).
   Quote it the way you would any shell variable. The shipped templates' whole-command input now reads
   `run: eval "{{ inputs.test_command }}"` — the author's explicit statement that this input is a command they
   typed (it was already run as code before, spliced in as text). `eval` only an input whose whole purpose is to
   be a command, never a run name or stage title. See `docs/design.md`, "Command steps and shell injection".
3. **An explicit `shell:` of `cmd`, `cmd.exe`, `powershell`, `powershell.exe`, `pwsh` or `pwsh.exe` is rejected
   at parse time.**

**Also changed**

- Names that become a file or directory name (workflow name, step/loop/stage id, a step's `output`, attachment
  names, the desktop's New file / Rename) are rejected on every platform if Windows would reject them: `\ / : * ? " < > |`,
  control characters, reserved device names, a trailing dot or space. A step's `output` is a *relative path*.
- New environment variables for command steps: `WHIPHAND_INPUT_<KEY>` (only for inputs the step references),
  `WHIPHAND_LOOP_ITERATION`, `WHIPHAND_LOOP_MAX_ITERATIONS`. Paths in the environment are absolute with `/`.
- Prompts leave the command line: an agent prompt is written to `.whiphand/runs/<id>/.<step>.prompt` and reaches
  the runner on stdin (`claude -p`) or through a one-line pointer (other runners); Claude's settings are passed by
  path. `--dry-run` prints each prompt file's content.
- Every path a model sees is workspace-relative with `/`; `run.json` paths are run-directory-relative, so a moved
  run directory still resumes (absolute paths from older runs are still read).
- Artifacts are LF on every platform; live terminal and pty output is untouched.
- Cancel, timeout and crash end the whole process tree (a process group on POSIX, a Windows Job Object per run
  through the embedded `whiphand-job.exe` guard). A cancelled or timed-out step now settles at once in the
  desktop as well as the CLI. Processes a step deliberately left running do not survive the run.
- Run liveness is a heartbeat lease (renewed every 30 s, stale at 5 min) instead of a PID probe; a run whose owner
  died is marked crashed (`interruptedReason: lease-expired`) by the next process that reads the store. A host
  suspended for more than five minutes loses its run on wake. The pid can only cut the lease short, never extend
  it: when the owner provably no longer exists (ESRCH, probed only from the same PID space, recorded as `pidScope`
  in `run.json`), the run is marked crashed at once (`interruptedReason: owner-exited`). So quitting the desktop
  mid-run and reopening it shows the run interrupted right away, not as running with no updates for five minutes.
- Losses that used to be silent are now visible: `run:degraded` events, `degradations[]` in `run.json`, and a summary in
  the CLI. A `writes: false` step (or one with `allow_paths`) fails when git is unavailable, instead of losing its
  write-guard silently; a failed post-step tree snapshot always fails the step.
- `C:\Proj` and `c:\proj` are one workspace. A typed UNC workspace is refused; a workspace too deep for Windows'
  260-character limit warns when opened.
- Atomic state writes (app state, remote-access config, `run.json`) use unique temp names and retry through a
  scanner holding the file; pruning old runs can no longer fail a run.
- `whiphand doctor` gains a POSIX-shell row (and, on Windows, git-launcher and token-file-mode notes). Given a
  working folder (`-C <dir>`, default the current one; the desktop passes the open workspace) it also reports what
  is wrong with *that folder*, only when something is: git refusing its repository (dubious ownership, with the
  `git config --global --add safe.directory` remediation) and, on Windows, too little headroom under the
  260-character path limit.
