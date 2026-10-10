# TUI plan: `whiphand tui`, a terminal front end beside the desktop app

Working plan for the terminal UI track. It builds on the Rust backend that
[migration.md](migration.md) and [phase3-plan.md](phase3-plan.md) produced, and
follows the behaviour described in [design.md](design.md). Each phase below is
one feature branch and one PR into `main`, with each step one or more commits.

| Phase | Status | PR |
|---|---|---|
| 0. Groundwork | In progress | |
| 1. Read-only MVP | Not started | |
| 2. Driving runs | Not started | |
| 3. Workflows and settings | Not started | |
| 4. Hardening and release | Not started | |
| 5. Optional extras | Not started | |

## Context

Whiphand ships two front ends today: the Rust CLI (`crates/whiphand-cli`) and
the Tauri desktop app (`apps/desktop`), which links the agent
(`crates/whiphand-agent`) in-process. This track adds a third front end, a
terminal UI, for people who live in a terminal or work over SSH.

The two UIs serve different people:

| | Desktop app | TUI |
|---|---|---|
| Main users | QA, product and project people, anyone who prefers a window and a mouse | Developers and advanced users |
| Typical setting | Local machine, visual review | Terminal, tmux, SSH sessions, keyboard only |
| Strengths | File explorer, pdf/mermaid/image viewers, embedded terminal, remote control from a browser | Fast start, no display needed, hands off to `$EDITOR`, `$PAGER` and `git` |

The TUI does **not** replace the desktop app, and the desktop app is not
frozen: it keeps gaining features for its own users. The TUI is a separate
track that runs alongside main development.

Why the TUI is cheap now: after Phase 3 of the migration the backend is Rust
and UI-agnostic. The agent's `Host` (`crates/whiphand-agent/src/host.rs`) owns
the engine thread, jobs, PTYs, scrollback, await detection, app state and
concurrent runs. It exposes them as RPCs and notifications typed in
`crates/whiphand-protocol`. The TUI is one more in-process client of a `Host`,
exactly like the desktop's `apps/desktop/src-tauri/src/agent.rs`. Behaviour
therefore matches the desktop by construction, and the TUI never calls
`whiphand-core`'s engine directly.

Agreed scope cuts:
- **No file explorer** (FilesPage and the pdf, mermaid and image viewers).
- **No remote control** (the agent's axum/ws server and token management).

## Track rules: living beside the desktop app

These rules exist so the TUI never slows desktop work down.

1. **Desktop work is never blocked by the TUI.** No desktop feature needs a TUI
   counterpart before it merges. Feature parity is not a goal.
2. **Shared behaviour lives in the shared crates.** Anything both UIs need goes
   into `whiphand-core`, `whiphand-agent` or `whiphand-protocol`. The TUI never
   forks behaviour and never ports logic from the webview's TypeScript; when it
   needs something that only exists in TS today, that logic moves to Rust first.
3. **Protocol growth is desktop-driven.** The TUI has a coverage test (see
   [Agent client](#3-agent-client)) that fails when the protocol gains a method
   the TUI does not know about. A desktop PR fixes it by adding the method to
   the TUI's `DESKTOP_ONLY` list, a one-line change. The TUI track picks it up
   later if it is useful in a terminal.
4. **TUI-motivated changes to shared crates keep the desktop identical.** The
   two known ones are the `remote` feature gate and the `AppStateStore`
   read-modify-write (both Phase 0). The desktop enables `remote` explicitly and
   its tests must pass unchanged.
5. **Gaps are written down.** `docs/design.md` gets a "Frontends" section with a
   short desktop-only list (file explorer, remote control, embedded terminal
   until Phase 5) so nobody files a parity bug by accident.

Only Phase 0 is expected to touch shared crates. Phases 1 to 5 add code under
`crates/whiphand-tui` and a few lines in `crates/whiphand-cli`. If a later phase
needs a shared-crate change, it is called out in that phase's PR description.

## Branching and delivery

- Each phase is a `feature/tui-phaseN-<topic>` branch off the current `main`,
  one PR, sub-steps as commits. Rebase on `main` before opening the PR.
- A local Linux run never clears a branch: CI must be green on Windows, macOS
  and Linux. Watch for tests that pass on Linux for the wrong reason (POSIX
  paths, `pid: 1`).
- Releases keep going through the existing Actions workflow. The `tui`
  subcommand ships in the `whiphand` binary from Phase 0 but is marked
  experimental in `--help` and the README until Phase 4.

---

## 1. Decisions

| Topic | Decision | Why |
|---|---|---|
| Packaging | `whiphand tui [-C dir]` subcommand of the existing `whiphand` binary. Code lives in a new library crate `crates/whiphand-tui` | One artifact and the existing CLI release path. The crate split keeps the clap surface (pinned by `parity/fixtures/cli-surface.json`) small |
| Backend | `whiphand_agent::Host::start` plus `connect(ClientKind::Desktop, sink)` | Same jobs, PTY, scrollback and await code the desktop uses |
| Remote | Cargo feature `remote` on `whiphand-agent`, on by default. Tauri and the stdio bin keep it. The TUI depends with `default-features = false`, **and** starts its `Host` with `HostConfig { remote: false, .. }` | `Host::run` calls `remote.apply_config()` at start; with a shared `remote-access.json` the TUI would otherwise try to bind the desktop's port. Cargo unifies features across a workspace build, so the feature alone does not keep remote out of a `cargo build`/`cargo test --workspace` TUI; the runtime switch does. The feature keeps axum out of a `cargo build -p whiphand-cli` release binary |
| Toolkit | `ratatui` 0.29 + `crossterm` 0.28 (`event-stream` feature) | Works on the Windows console/ConPTY, macOS and Linux. `TestBackend` gives snapshot tests |
| Async | One current-thread tokio runtime on the UI thread. The `Host` keeps its own engine thread | `Host` is `Send`; the engine's `!Send` futures never touch the UI thread |
| Interactive steps | **Attach mode**: leave the alt-screen and pass the job's PTY straight through to the real terminal. Detach key `Ctrl-]` | Real terminal fidelity with no emulation. The agent owns the PTY, so the run continues while detached |
| Embedded PTY pane | Deferred to Phase 5 (`vt100` + `tui-term`) | Needed only for a side-by-side log and session |
| Workflow editing | `$VISUAL`/`$EDITOR` round trip, then `validateWorkflow` | No YAML editor inside the TUI |
| Artifacts | Markdown rendered as styled text (`pulldown-cmark` to ratatui `Text`); `o` opens `$PAGER` | Mermaid and pdf left with the file explorer |
| Diff | `getWorkingDiff` (files with `patch`) rendered in a pane; `D` hands off to `git diff` / `$GIT_PAGER` | Covers `show_diff` approvals and send-back comments |
| Shared logic | Reuse `whiphand_core::log_rows`, `path_form`, `segment`, `execution_key` and the CLI's `render.rs` | One implementation, already golden-tested |

## 2. Crate layout

```
crates/whiphand-tui/
  Cargo.toml          whiphand-agent (default-features = false), whiphand-protocol, whiphand-core,
                      ratatui, crossterm{event-stream}, tokio, futures-util, base64,
                      pulldown-cmark, unicode-width, serde_json
  src/
    lib.rs            pub fn run(opts: TuiOptions) -> ExitCode
    client/
      mod.rs          AgentClient: typed request/response over Host::connect
      wire.rs         envelope parse: Response{id, result|error} | Notification{method, params}
      notify.rs       enum Notification { WhiphandEvent, RunStateChanged, PtyStarted, PtyData,
                      PtyExit, PtyAwait, StepLog, ManualRequest, ManualResolved,
                      AppStateChanged }   (remoteAccessChanged ignored)
    model/
      mod.rs          Model: workspaces, runs, jobs, workflows, ui (route stack, focus, toasts)
      jobs.rs         JobState: status, steps, log rows, pty ring, await, pending manual
      scrollback.rs   seq splice, a Rust port of the mergeScrollback / appendPty semantics in
                      apps/desktop/src/state/store.ts (the one piece of client logic not in core)
      runs.rs         run table rows from listRuns plus a live overlay from jobs; "foreign" runs
    update.rs         fn update(&mut Model, Msg) -> Vec<Cmd>   (pure, unit-tested)
    msg.rs            Msg: Key, Resize, Tick, Agent(Notification), Reply(ReqId, Result), External(Exit)
    cmd.rs            Cmd: Rpc(Request), Attach(job), Suspend(ExternalProgram), Notify(..), Quit
    runtime/
      event_loop.rs   select! over terminal events, agent channel, replies, tick; render when dirty
      terminal.rs     TerminalGuard (raw mode, alt-screen, mouse, bracketed paste), panic hook
      stderr.rs       redirect fd 2 / STD_ERROR_HANDLE to a log file while the TUI owns the screen
      attach.rs       passthrough session (section 5)
      external.rs     suspend, run $EDITOR / $PAGER / git, resume
      notify.rs       BEL, OSC 9 / OSC 777, title (OSC 0); tmux passthrough wrapping
    view/
      layout.rs, theme.rs, keymap.rs, widgets/{table,tree,log,markdown,diff,form,toast,help}.rs
      screens/{workspaces,runs,run_detail,approval,diff,artifact,workflows,new_run,doctor,settings}.rs
  tests/              snapshot and integration tests (section 9)
```

Rendering is a pure function `fn view(&Model, &mut Frame)`. Only `runtime/`
does I/O. This Elm-style split (Model, Msg, update, Cmd, view) is what makes the
TUI testable without a terminal.

## 3. Agent client

```rust
pub struct AgentClient {
    client: whiphand_agent::Client,          // dropping it disconnects
    next_id: u64,
    pending: HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>,  // UI thread only
}
impl AgentClient {
    pub fn connect(host: &Host) -> (Self, mpsc::UnboundedReceiver<Inbound>);
    pub fn call<M: Method>(&mut self, params: M::Params)
        -> impl Future<Output = Result<M::Result, RpcError>>;
}
```

- `Method` is a small trait implemented per protocol method (name plus the
  `Params`/`Result` types from `whiphand-protocol`).
- **Coverage test:** the set of `Method` impls plus `DESKTOP_ONLY` must equal
  `whiphand_protocol::METHODS`. `DESKTOP_ONLY` starts with the `remoteAccess*`
  methods. A new protocol method fails this test until it is handled or listed
  (see track rule 3).
- The `Sink` closure runs on the engine thread and only does `tx.send(line)`;
  parsing happens on the UI thread. Requests are serialised with `serde_json`
  straight into `Client::send`, so `ptyInput` keystrokes keep their order (the
  same rule `agent_send` documents in the desktop).
- Startup: `hello`, then check `protocol_version == PROTOCOL_VERSION`. It is the
  same binary, but the check is cheap.
- Host death (`Host::is_running() == false`, sink dropped): show a fatal banner
  and offer a restart, as the desktop's reattach in `agent.rs` does. Never
  continue silently.
- Shutdown: when quitting with running jobs, confirm first ("2 runs in progress
  will be cancelled; they can be resumed"), then call `Host::shutdown()`, which
  grants the 3 s grace period for final state.

## 4. Event loop and rendering

```
loop {
  select! {
    ev = term_events.next()   => msg(Key | Mouse | Paste | Resize)
    line = agent_rx.recv()    => msg(Agent(parse(line)))  // drained in a batch, up to N per turn
    _ = tick.tick()           => msg(Tick)                 // 100 ms: timers, toasts, coalesced redraw
  }
  for cmd in update(&mut model, msg) { dispatch(cmd) }
  if model.dirty && since_last_draw >= 16ms { terminal.draw(|f| view(&model, f)); }
}
```

- **Throughput:** `ptyData` and `stepLog` bursts are drained in batches and
  coalesced into one redraw per frame, mirroring the 100 ms window in
  `apps/desktop/src/agent/agent-context.tsx`. `ptyData` for jobs nobody is
  viewing is only appended to the ring, never rendered.
- **Bounded memory:** per-job log rows are capped at the same 2 000 lines as
  `LOG_SCROLLBACK_CAP_LINES` in `crates/whiphand-agent/src/scrollback.rs`. The PTY
  ring is capped at 2 MB decoded. Older output is fetched again with
  `readRunLog` on demand.
- **Virtualised lists:** every list and log widget renders only the visible
  window.
- **Resize:** recompute the layout; when attached, forward `ptyResize`.
- **Unicode and colour:** widths via `unicode-width`. ANSI in log lines is mapped
  to styles (`ansi-to-tui`) or stripped, since agents' progress lines carry
  colour.

## 5. Attach mode (the interactive handoff)

State machine: `Ui → Attaching → Attached → Detaching → Ui`.

1. **Enter** on an interactive step with a live PTY (`ptyStarted` seen, or
   `listJobs` shows it).
2. Leave the alt-screen, keep raw mode, disable mouse capture, clear the screen,
   set the title.
3. Send `ptyResize{cols, rows}` with the real terminal size. The agent's PTY was
   sized for whoever attached last; `pty_sizes.rs` tracks it.
4. Replay: write the model's PTY ring for the job (already seq-spliced with
   `getJobScrollback` on first view) raw to stdout, then stream later `ptyData`
   (base64-decoded) straight to stdout. Full-screen harnesses (claude, copilot,
   opencode) repaint after the resize, so a partial replay is only cosmetic.
5. Input: crossterm's `EventStream` is paused, and a dedicated reader thread
   forwards raw stdin bytes, batched per tick into one `ptyInput{data: base64}`.
   - `Ctrl-]` (0x1d, configurable) detaches; `Ctrl-] Ctrl-]` sends a literal 0x1d.
   - On Windows, read via `ReadConsoleInputW` with
     `ENABLE_VIRTUAL_TERMINAL_INPUT`, so arrow keys arrive as VT sequences, which
     is what ConPTY expects.
6. `ptyExit` for the job: print a one-line footer ("session ended, exit 0,
   returning"), wait for a key or 1 s, and return to the run's detail screen.
7. While attached, other jobs' `ptyAwait` and `manualRequest` only ring BEL and
   set the title. The model keeps updating in the background, so returning is
   instant.
8. `Ctrl-] e` sends `endSession`, the polite-quit path the agent implements.

Optional setting `attach.auto = true`: a run started from this TUI attaches
automatically when its interactive step starts, which gives a CLI-like flow.

## 6. Screens and the RPCs behind them

| Screen | Content and actions | RPCs and notifications |
|---|---|---|
| Workspaces | Recent and pinned; open a path (`-C`, else the cwd if it has `.whiphand/`, else this screen); `init` if missing | `getAppState`, `touchRecentWorkspace`, `setWorkspacePinned`, `initWorkspace`, `appStateChanged` |
| Runs (home) | Name/id, workflow, status, current step, elapsed, a "waiting" badge; filter `/`; ongoing toggle | `listRuns`, `listRecentRuns`, `listJobs`, `runStateChanged`, `ptyAwait`, `manualRequest` |
| Run detail | Left: step tree (stages, cycles, iterations via the `execution_key` logic). Right tabs: Log, Events, Artifacts, Diff. Actions: cancel, resume (with extra iterations), rename, lock, delete, end session, attach | `getRun`, `readRunLog`, `getJobScrollback`, `stepLog`, `whiphandEvent`, `cancelRun`, `resumeRun`, `renameRun`, `setRunLocked`, `deleteRun`, `endSession`, `pty*` |
| Approval / manual | Full screen: prompt, diff (if `show_diff`), choices; send-back comment editor (multi-line, per-file comments for `capture: review`) | `manualRequest`, `resolveManual{choice, note, comments}`, `manualResolved`, `getWorkingDiff` |
| Diff | File list (status, +/-) and patch hunks; comment on a line for send-back | `getWorkingDiff` |
| Artifact | Markdown render; `e` edits in `$EDITOR`, then `writeArtifact` | `readArtifact`, `statArtifact`, `writeArtifact` |
| Workflows | List (source scope, shadowed); new, clone, delete; edit in `$EDITOR`; validate; run | `listWorkflows`, `getWorkflow`, `createWorkflow`, `cloneWorkflow`, `deleteWorkflow`, `updateWorkflow`, `validateWorkflow` |
| New run | Form generated from the workflow's inputs; name; attachments (path input with completion); model overrides; prefilled from `lastInputs` in app state | `getWorkflow`, `listModels`, `startRun` |
| Doctor | Harness and support tool groups, reusing the CLI's `render.rs` text | `doctor` |
| Settings | Workspace config, run retention, prune, path of the TUI log | `configGet`, `configSet`, `pruneRuns`, `setUiState` |

Desktop-only by design: `remoteAccessGet`, `remoteAccessSet`,
`remoteAccessRotateToken` and the `remoteAccessChanged` notification.

### Key bindings

One table in `keymap.rs`. The `?` overlay and the docs are generated from it.

- **Global:** `?` help, `q`/`Esc` back, `Q` quit, `:` command palette, `g w`
  workspaces, `g r` runs, `g f` workflows, `g d` doctor, `g s` settings,
  `Tab`/`Shift-Tab` panes.
- **Runs and detail:** `/` filter, `n` new run, `Enter` open/attach, `c` cancel,
  `r` resume, `R` rename, `L` lock, `x` delete, `e` edit, `o` pager, `D` external
  diff, `a` approve, `b` send back, `1`-`4` tabs.
- **Attach:** `Ctrl-]` detach, `Ctrl-] e` end session.

## 7. Terminal hygiene

- **stderr:** the agent and core write diagnostics with `eprintln!` (6 call
  sites), which would corrupt the screen. On start, redirect fd 2 (`dup2` on
  Unix, `SetStdHandle(STD_ERROR_HANDLE)` on Windows) to
  `<app-data>/whiphand/tui.log` and restore it on exit. Settings shows the path.
- **Child stdio:** headless steps already use `Out::Piped` and
  `StdinFrom::Null|File` (`crates/whiphand-agent/src/frontend.rs`), and
  interactive steps run in the agent's PTY, so no child inherits the TUI's
  terminal. Add a test asserting that no spawn path uses `Out::Inherit` or
  `StdinFrom::Inherit` under the agent frontend.
- **Restore guarantee:** `TerminalGuard` drop, the panic hook, a
  SIGINT/SIGTERM/SIGHUP handler and the Windows console ctrl handler all restore
  raw mode, the alt-screen, the cursor and mouse capture before a panic message
  prints.
- **Ctrl-C in the UI** is a key (raw mode). It maps to a "cancel focused run?"
  confirmation, not to process exit.
- **External programs:** `external.rs` leaves raw mode and the alt-screen, runs
  the program with inherited stdio, waits, re-enters, and forces a full redraw.
- **tmux/screen:** notifications are wrapped in tmux DCS passthrough when
  `$TMUX` is set. Colours degrade to 256/16 based on `COLORTERM` and terminfo.
  `NO_COLOR` is respected.

## 8. Running beside the desktop app (two processes, one machine)

Developers will often have the desktop app and the TUI open at once. What
changes for that:

1. **App state is cached once per process.** `AppStateStore`
   (`crates/whiphand-agent/src/app_state.rs`) loads `app-state.json` once and
   writes its in-memory copy on every `mutate`, so the desktop and the TUI would
   overwrite each other's recents, pins and `lastInputs`.
   **Change:** `mutate` re-reads the file before applying `f`
   (read-modify-write; the atomic write already exists), and `get` reloads when
   the file's mtime changed. Both front ends benefit. Covered by a
   two-stores-one-file unit test. `appStateChanged` only reaches clients of the
   same `Host`, so each UI refreshes on focus or tick when the mtime moves.
2. **Remote server port clash.** Solved by building the TUI's agent without the
   `remote` feature (section 1). The `remote` module, `RemoteController`,
   `ClientKind::Remote` handling and the three `remoteAccess*` handlers go behind
   `#[cfg(feature = "remote")]` and `HostConfig.remote`; without either, those
   methods answer `METHOD_NOT_FOUND`. The desktop is unaffected.
3. **Runs driven by the other process ("foreign runs").** Run directories are
   already safe across processes (journal lease, fence and stale-lease repair in
   `crates/whiphand-core/src/store/`, covered by the parity store tests). Live
   notifications and the PTY belong to the process that started the run. The
   TUI marks a `running` run with no local job as *foreign*: read-only, refreshed
   by polling `getRun` + `readRunLog` every second while on screen. Cancel,
   attach and approve are disabled with the reason shown ("owned by another
   whiphand process"). Manual steps of a foreign run are answered where the run
   was started.
4. **Same workspace, same time** is allowed. Starting a second run in one
   workspace behaves as it does today for two desktop windows, or the CLI plus
   the desktop.

Note for Phase 2: `cancelRun` by `runId` (no `jobId`) is the agent's path for
a run another process owns, and SIGTERMs the pid in the run's manifest; for a
desktop-started run that pid is the desktop itself. Keeping cancel disabled on
foreign runs is therefore required, not just tidy.

Out of scope for this track: controlling foreign runs across processes, which
would need an owner-side IPC channel. If the desktop users ask for it, it
becomes its own shared-crate project that both UIs use.

## 9. Testing

- **Unit (pure):** `update()` transitions for every `Msg`; scrollback seq
  splicing, porting the cases from
  `apps/desktop/src/state/merge-scrollback.test.ts` and `attach.test.ts`; the
  keymap table has no conflicts; the `Method` coverage test.
- **Snapshot:** each screen rendered on ratatui's `TestBackend` at 80×24 and
  200×50, light and dark, compared with committed `.snap` files (`insta`).
- **Integration:** a real `Host` in a tempdir (`WHIPHAND_APP_STATE_FILE` pointed
  into it) drives `examples/cycle.yaml --dry-run` through `AgentClient`; Msgs are
  fed into `update`, and the model and rendered frames are asserted. The attach
  test uses a fake interactive harness script, reusing the agent's PTY test
  fixtures and the Windows exit helper.
- **Cross-process:** two `Host`s on one app-state file and one workspace.
  Recents are not lost; a foreign run is detected and rendered read-only.
- **CI:** all of the above run inside the existing `cargo test --workspace` job on
  Windows, macOS and Linux; no display is needed.
- **Manual matrix (Phase 4):** Windows Terminal, conhost, macOS Terminal and
  iTerm2, GNOME Terminal, kitty, alacritty, tmux, SSH; a real `feature` workflow
  end to end; the desktop open on the same workspace at the same time.

## 10. Phases

Every phase ends with the checks in [Verification](#13-verification).

### Phase 0: Groundwork (about 1 week). Touches shared crates.

- `whiphand-agent`: the `remote` feature gate; Tauri enables it explicitly.
- `whiphand-agent`: `AppStateStore` read-modify-write and mtime reload.
- `crates/whiphand-tui` skeleton: `AgentClient`, `Method` trait and coverage
  test, event loop, `TerminalGuard`, stderr redirect.
- `whiphand tui` subcommand (experimental); regenerate `cli-surface.json`.
- Runs list with live status.

Exit: a dry run started in the desktop shows up as foreign; one started in the
TUI updates live; the desktop's test suite passes unchanged.

### Phase 1: Read-only MVP (about 2 weeks)

Workspaces, runs, run detail (tree, log, events, artifacts, diff), doctor, help
overlay, notifications, foreign-run polling.

Exit: every screen has snapshots; a real run can be followed end to end.

### Phase 2: Driving runs (about 2 weeks)

New-run form; cancel, resume, rename, lock, delete; approvals and manual steps
including send-back comments; attach mode; end session.

Exit: a `feature` workflow runs start to finish from the TUI alone, including
attach, detach and reattach to the plan step, and a sign-off with diff and
send-back.

### Phase 3: Workflows and settings (1 to 2 weeks)

Workflow CRUD, `$EDITOR` editing and validation, `init`, config, prune, models.

### Phase 4: Hardening and release (1 to 2 weeks)

Manual matrix, Windows input edge cases, resize storms, `NO_COLOR`. Docs: a
"Terminal UI" section in the README, a "Frontends" section in `docs/design.md`
(the TTY seam's three hosts: CLI inherit, desktop xterm, TUI attach, plus the
desktop-only list), CHANGELOG, benchmarks. Drop the experimental marker.

### Phase 5: Optional

Embedded PTY pane (`vt100` + `tui-term`), mouse-driven review, several attached
sessions in splits.

Total to a released TUI: about 7 to 9 weeks of focused work; Phase 5 is extra.
Because this is a side track, calendar time depends on how much capacity
desktop work leaves.

## 11. Critical files

- New: `crates/whiphand-tui/**`; the root `Cargo.toml` (workspace member).
- `crates/whiphand-cli/src/cli.rs`, `commands.rs`, `Cargo.toml`: the `tui`
  subcommand and dependency. `parity/fixtures/cli-surface.json`, regenerated with
  `WHIPHAND_UPDATE_SURFACE=1`.
- Phase 0 only, shared: `crates/whiphand-agent/Cargo.toml`, `src/lib.rs`,
  `src/host.rs` (`Agent.remote`, `Msg::RemoteStatusChanged`,
  `HostConfig.remote_config_path` / `web_root`), `src/handlers.rs`
  (`remoteAccess*`), `src/remote/**` for the feature gate;
  `crates/whiphand-agent/src/app_state.rs` for read-modify-write;
  `apps/desktop/src-tauri/Cargo.toml` to enable `remote` explicitly.
- Reused: `crates/whiphand-protocol/src/lib.rs` (types, `METHODS`,
  `NOTIFICATIONS`, `PROTOCOL_VERSION`), `crates/whiphand-core/src/log_rows.rs`,
  `path_form.rs`, `segment.rs`, `execution_key.rs`,
  `crates/whiphand-cli/src/render.rs`.
- Reference only (behaviour to mirror): `apps/desktop/src/state/store.ts`
  (`mergeScrollback`, PTY append), `apps/desktop/src/agent/agent-context.tsx`
  (throttling), `apps/desktop/src/pages/RunDetailPage.tsx` (`mergeSteps`, tab
  contents).

## 12. Risks

1. **Windows console input and output** in attach mode (VT input, ConPTY repaint
   timing). Mitigation: crossterm plus explicit `ENABLE_VIRTUAL_TERMINAL_INPUT`,
   Windows CI, the manual matrix.
2. **Foreign runs are read-only.** Users may expect to approve a desktop-started
   run from the TUI. Clear messaging now; owner-side IPC is a later feature.
3. **Run lifetime.** Closing the terminal stops the in-process `Host`, the same
   as quitting the desktop. Mitigation: quit confirmation, tmux guidance,
   `resumeRun`.
4. **A third UI to maintain, while the desktop keeps moving.** Mitigation: the
   track rules above. The coverage test makes every protocol change visible
   without blocking desktop PRs, and gaps are recorded rather than chased.
5. **Drift from `main`.** Mitigation: one short-lived branch per phase, rebased
   on `main` before each PR; no long-lived TUI branch.
6. **Binary size.** ratatui, crossterm and pulldown-cmark add about 1 to 1.5 MB;
   dropping axum from the CLI path offsets part of it. Recorded in
   `docs/benchmarks.md`.

## 13. Verification

Per phase:

- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`, `npm run test:parity`, and `npm run verify` (the
  desktop is unaffected).
- CI green on Windows, macOS and Linux.
- `whiphand tui -C <workspace>`: start `examples/cycle.yaml --dry-run` and watch
  it; from Phase 2, a real `feature` run with attach, detach and reattach to the
  plan step, and a sign-off with diff and send-back.
- Desktop and TUI open on one workspace: recents survive both, and a desktop run
  shows as foreign.
- Startup time and RSS of `whiphand tui` recorded in `docs/benchmarks.md`.
