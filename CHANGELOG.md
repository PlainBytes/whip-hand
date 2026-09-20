# Changelog

## Unreleased

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
