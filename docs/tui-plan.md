# TUI plan: `whiphand tui`, a terminal front end beside the desktop app

Working plan for the terminal UI track. It builds on the Rust backend that
[migration.md](migration.md) and [phase3-plan.md](phase3-plan.md) produced, and
follows the behaviour described in [design.md](design.md). Each phase below is
one feature branch and one PR into `main`, with each step one or more commits.

| Phase | Status | PR |
|---|---|---|
| 0. Groundwork | Done | [#27](https://github.com/PlainBytes/whip-hand/pull/27) |
| 1. Read-only MVP | Done | [#29](https://github.com/PlainBytes/whip-hand/pull/29) |
| 2. Driving runs | Done | [#33](https://github.com/PlainBytes/whip-hand/pull/33) |
| 3. Workflows and settings | Done | [#40](https://github.com/PlainBytes/whip-hand/pull/40) |
| 4. Hardening and release | Done | [#42](https://github.com/PlainBytes/whip-hand/pull/42) |
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
   known ones are the `remote` feature gate and the `AppStateStore`
   read-modify-write (both Phase 0), the additive `log_rows::parse_log_line`
   and `run_tree` module in `whiphand-core` (Phase 1), and the optional `tui`
   key in app state (Phase 3). The desktop enables `remote` explicitly and its
   tests must pass unchanged.
5. **Gaps are written down.** `docs/design.md` gets a "Frontends" section with a
   short desktop-only list (file explorer, remote control, embedded terminal
   until Phase 5) so nobody files a parity bug by accident.

Phase 0 was expected to be the only phase touching shared crates. Phase 1 also
did, under rule 2: the run tree and the `run.log` reader existed only in the
desktop's TypeScript, so they moved to `whiphand-core` (additive, with their TS
tests ported; the desktop keeps its TS until it chooses to switch). Phase 2
did not: what it needed from core was already there. Phase 3 made one
additive change, the TUI's preferences in app state (`AppState.tui`, accepted
by `setUiState`; absent until the TUI saves one). Other phases add code
under `crates/whiphand-tui` and a few lines in `crates/whiphand-cli`. Any shared-crate change is called out in that phase's PR
description.

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
| Run detail data | The manifest (`getRun`) is the step tree's only source, re-read on step boundaries (coalesced 250 ms) and on `runStateChanged`. The log is `LogRow`s: live `whiphandEvent`s plus `getJobScrollback` for a local run, `run.log` via `readRunLog` + `parse_log_line` otherwise, merged on row identity | The journal writes the manifest live, so there is no live step reducer to port (`reduceJobEvent` stays in TS). Identity, not `seq`, because a resumed run's journal restarts `seq` while `run.log` keeps appending |
| Diff | `getWorkingDiff` (files with `patch`) rendered in a pane; `D` hands off to `git diff` / `$GIT_PAGER` | Covers `show_diff` approvals and send-back comments. An approval shows the run's working diff, as the desktop's review does; the request's `context.diff` only says that one is wanted |
| Send-back comments | Per file (`FileComment { path, body }`), on the approval screen | The protocol has no line numbers |
| Shared logic | Reuse `whiphand_core::log_rows` (with `parse_log_line`), `run_tree`, `path_form`, `execution_key`, `format` and `doctor::tools::doctor_report` | One implementation, already golden-tested. `run_tree` and `parse_log_line` were ported from the desktop's TS in Phase 1 |

## 2. Crate layout

```
crates/whiphand-tui/
  Cargo.toml          whiphand-agent (default-features = false), whiphand-protocol, whiphand-core,
                      ratatui, crossterm{event-stream}, tokio, futures-util, serde_json,
                      pulldown-cmark, ansi-to-tui
  src/
    lib.rs            pub fn run(opts: TuiOptions) -> i32; picks the start workspace
    client/
      mod.rs          AgentClient, the Method trait, IMPLEMENTED / LATER / DESKTOP_ONLY
      wire.rs         envelope parse: Response{id, result|error} | Notification{method, params}
      notify.rs       enum Notification (remoteAccessChanged ignored)
    model/
      mod.rs          Model: route stack, workspace, runs, jobs (with their live log rows),
                      per-screen state, toasts
      runs.rs         run table rows from listRuns plus a live overlay from jobs; "foreign" runs;
                      the / filter and the ongoing view
      detail.rs       RunDetail: manifest, run_tree, collapsed nodes, tabs, log, artifacts, diff
      log.rs          LogEntry / LogBuf: live and run.log rows merged on identity, paged back by byte
      input.rs        the text input: dialogs, form fields, notes and comments
      new_run.rs      the workflow picker and its form; startRun's params
      manual.rs       a ManualRequest and the screen answering it
      pty.rs          a job's PTY ring; merge_scrollback (the desktop's mergeScrollback)
    update/
      mod.rs          fn update(&mut Model, Msg) -> Vec<Cmd>   (pure, unit-tested)
      detail.rs       the run detail screen: open, refetch, foreign polling, its keys
      actions.rs      cancel, resume, rename, lock, delete, end session; the dialogs
      new_run.rs      the new-run screen
      manual.rs       the manual / approval screen
      attach.rs       attach mode's state machine (pure; the runtime swaps the screen)
      tests.rs
    msg.rs            Msg: Key, Resize, Tick, Agent(Notification), Reply(Then, Result), External, Edited,
                      Stdin, PtySize, AttachFailed, HostGone
    cmd.rs            Cmd: Rpc(Call), Suspend(External), Notify(Notice), Quit, Attach, Detach, Stdout;
                      Then (what a reply is for)
    runtime/
      event_loop.rs   select! over terminal events, agent lines, the tick and the frame deadline
      terminal.rs     TerminalGuard (raw mode, alt-screen), panic hook
      stderr.rs       redirect fd 2 / STD_ERROR_HANDLE to a log file while the TUI owns the screen
      external.rs     suspend, run $PAGER / git, resume
      notify.rs       BEL, OSC 9, title (OSC 0); tmux passthrough wrapping
      attach.rs       passthrough session (section 5): screen swap, raw stdin reader
    view/
      mod.rs          header, screen, footer, help overlay; NO_COLOR strips colour after drawing
      keymap.rs       the one binding table: dispatch, the ? overlay and footer hints
      theme.rs        colours and glyphs
      widgets/{tree,log,markdown,diff,help}.rs
      screens/{workspaces,runs,detail,doctor,new_run,manual}.rs
  tests/              runs.rs and attach.rs (real Hosts, harness in common/), snapshots.rs (TestBackend + insta)
```

The PTY ring and the `mergeScrollback` port (`apps/desktop/src/state/store.ts`)
live in `model/pty.rs`. The port stays in the TUI: it is client buffer logic
with no other Rust consumer, not behaviour the two UIs share.

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
- Shutdown: quitting by key always confirms first. With running jobs the question
  warns ("2 runs in progress will be cancelled; they can be resumed"); with none
  it is a plain "Quit whiphand?". Only `y` confirms. A signal or a dead host quits
  without asking. Then call `Host::shutdown()`, which
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

- **Frame deadline:** a change held back by the 16 ms frame limit is drawn when
  the frame ends: the loop also wakes on that deadline, not only on the next
  tick (fixed in Phase 1; before, it waited up to 100 ms).
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

1. **Enter** on the step whose session is live, or **`t`** anywhere on the
   run's detail (a live session: `ptyStarted` seen, or seeded by
   `getJobScrollback` when the detail opened).
2. Leave the alt-screen, keep raw mode, clear the screen. (The TUI never turns
   mouse capture on.)
3. Send `ptyResize{cols, rows}` with the real terminal size. The agent's PTY was
   sized for whoever attached last; `pty_sizes.rs` tracks it.
4. Replay: write the model's PTY ring for the job (already seq-spliced with
   `getJobScrollback` on first view) raw to stdout, then stream later `ptyData`
   (base64-decoded) straight to stdout. Full-screen harnesses (claude, copilot,
   opencode) repaint after the resize, so a partial replay is only cosmetic.
5. Input: crossterm's `EventStream` is dropped, and a reader thread forwards
   raw stdin bytes, one `ptyInput{data: base64}` per read. It wakes every
   50 ms (`poll` on fd 0) to check it should go on, so after a detach nothing
   is left blocked on stdin to steal a key from crossterm. No resize events
   arrive meanwhile, so the size is polled on the tick.
   - `Ctrl-]` (0x1d, configurable) detaches; `Ctrl-] Ctrl-]` sends a literal 0x1d.
   - On Windows, `WaitForSingleObject` on the console handle, then
     `ReadConsoleInputW` with `ENABLE_VIRTUAL_TERMINAL_INPUT`, so arrow keys
     arrive as VT sequences, which is what ConPTY expects.
6. `ptyExit` for the job: print a one-line footer ("session ended, exit 0,
   returning"), wait for a key or 1 s, and return to the run's detail screen.
7. While attached, other jobs' `ptyAwait` and `manualRequest` only ring BEL and
   set the title. The model keeps updating in the background, so returning is
   instant.
8. `Ctrl-] e` sends `endSession`, the polite-quit path the agent implements.

Setting `attachAuto` (Phase 3, Settings → Terminal UI): a run started from
this TUI attaches automatically when its interactive step starts, which gives
a CLI-like flow. The detach key is set there too: `Ctrl-]` (the default),
`Ctrl-\`, `Ctrl-^` or `Ctrl-_`. Both live under `tui` in app state.

## 6. Screens and the RPCs behind them

| Screen | Content and actions | RPCs and notifications |
|---|---|---|
| Workspaces | Recent and pinned; open a path (`-C`, else the cwd if it has `.whiphand/`, else this screen); `init` if missing | `getAppState`, `touchRecentWorkspace`, `setWorkspacePinned`, `initWorkspace`, `appStateChanged` |
| Runs (home) | Name/id, workflow, status, current step, elapsed, a "waiting" badge; filter `/`; ongoing toggle | `listRuns`, `listRecentRuns`, `listJobs`, `runStateChanged`, `ptyAwait`, `manualRequest` |
| Run detail | Left: step tree (stages, cycles, iterations via the `execution_key` logic). Right tabs: Log, Events, Artifacts, Diff. Actions: cancel, resume (with extra iterations), rename, lock, delete, end session, attach | `getRun`, `readRunLog`, `getJobScrollback`, `stepLog`, `whiphandEvent`, `cancelRun`, `resumeRun`, `renameRun`, `setRunLocked`, `deleteRun`, `endSession`, `pty*` |
| Approval / manual | Full screen: instructions, artifacts, the run's diff (if `show_diff`), choices; a note, and per-file comments for `capture: review` | `manualRequest`, `resolveManual{choice, note, comments}`, `manualResolved`, `getWorkingDiff` |
| Diff | File list (status, +/-) and patch hunks | `getWorkingDiff` |
| Artifact | Markdown render; `e` edits in `$EDITOR`, then `writeArtifact` | `readArtifact`, `statArtifact`, `writeArtifact` |
| Workflows | List (source scope, shadowed); new, clone, delete; edit in `$EDITOR`; validate; run | `listWorkflows`, `getWorkflow`, `createWorkflow`, `cloneWorkflow`, `deleteWorkflow`, `updateWorkflow`, `validateWorkflow` |
| New run | Workflow picker, then a form generated from its inputs; name; max iterations; attachments (paths, one per line); dry run; worktree; prefilled from `lastInputs` in app state. No model overrides: `startRun` has none | `listWorkflows` (it carries each workflow), `getAppState`, `startRun` |
| Doctor | Harness and support tool groups: core's `doctor_report` text, the same as `whiphand doctor` prints | `doctor` |
| Settings | Workspace and global config, run retention, prune, the TUI's own preferences (`attachAuto`, detach key), path of the TUI log, each runner's models | `configGet`, `configSet`, `pruneRuns`, `setUiState`, `listModels` |

Desktop-only by design: `remoteAccessGet`, `remoteAccessSet`,
`remoteAccessRotateToken` and the `remoteAccessChanged` notification.

### Key bindings

One table in `view/keymap.rs`. Dispatch, the `?` overlay and the footer hints
are drawn from it, and a unit test rejects a key bound twice where it applies.
Keys arrive with the phase that adds their action. Phase 1 bound: `?`,
`q`/`Esc`, `Q`, `g w|r|d`, `j`/`k`, page keys, `Home`, `G`/`End`, `Enter`; runs
`/` and `o` (ongoing); workspaces `p` (pin); run detail `Tab`, `1`-`4`, `h`/`l`
(collapse, expand), `o` (pager), `D`. Phase 2 moved the detail's errors only
to `f`, every step's rows to `A` and the diff reload to `Ctrl-r`, freeing `e`,
`a` and `r`, and added: `Ctrl-c` (cancel the run in focus, else quit; both
ask); runs and detail `c` cancel, `r` resume, `R` rename, `L` lock, `x`
delete, `m` the step waiting on you; runs `n` new run; detail `t` attach, `E`
end session; new run `s` start; the manual screen `a` continue, `b` send back,
`X` abort, `i` the note. Phase 3 added `g f` and `g s`; workflows `r` run,
`e` edit, `n`/`N` new (project, global), `c` clone, `x` delete, `o` pager,
`i` set up the workspace, `Ctrl-r` reload; settings `Tab` panes, `Enter`
change, `u` use the global value, `P` prune now, `Ctrl-r` reload; workspaces
`a` open a folder by path; detail `e` edit the open artifact. The `?` overlay
scrolls with the movement keys. The plan's full set:

- **Global:** `?` help, `q`/`Esc` back, `Q` quit, `:` command palette, `g w`
  workspaces, `g r` runs, `g f` workflows, `g d` doctor, `g s` settings,
  `Tab`/`Shift-Tab` panes.
- **Runs and detail:** `/` filter, `n` new run, `Enter` open/attach, `t`
  attach, `c` cancel, `r` resume, `R` rename, `L` lock, `x` delete, `m` answer,
  `e` edit, `o` pager, `D` external diff, `1`-`4` tabs.
- **Manual:** `a` approve, `b` send back, `X` abort, `i` note.
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
  confirmation, not to process exit; with no live run in focus it asks the
  quit question instead (which is asked whether or not any run is live).
- **External programs:** `external.rs` leaves raw mode and the alt-screen, gives
  stderr back to the terminal, runs the program with inherited stdio, waits,
  re-enters, redirects stderr again and forces a full redraw. crossterm's
  `EventStream` is dropped for the duration so its reader does not race the
  program for stdin. Agent lines queue in the channel meanwhile. Only absolute
  paths reach the pager, after `--`.
- **tmux/screen:** notifications are wrapped in tmux DCS passthrough when
  `$TMUX` is set. Colours degrade to 256/16 based on `COLORTERM` and `TERM`
  (Phase 4: RGB to the nearest of 256 on a `*-256color` terminal, to the
  nearest named colour elsewhere; Windows Terminal and the console are 24-bit).
  `NO_COLOR` is respected.
- **Paste:** bracketed paste is on while the TUI owns the screen, off while a
  program has it, and set the way the session last asked while attached
  (Phase 4).

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

`cancelRun` by `runId` (no `jobId`) is the agent's path for a run another
process owns, and SIGTERMs the pid in the run's manifest; for a
desktop-started run that pid is the desktop itself. The TUI therefore only
cancels by `jobId`, and cancel, end session, attach and answering stay
disabled on foreign runs, with the reason shown.

Out of scope for this track: controlling foreign runs across processes, which
would need an owner-side IPC channel. If the desktop users ask for it, it
becomes its own shared-crate project that both UIs use.

## 9. Testing

- **Unit (pure):** `update()` transitions for every `Msg`; scrollback seq
  splicing, porting the cases from
  `apps/desktop/src/state/merge-scrollback.test.ts` and `attach.test.ts`; the
  keymap table has no conflicts; the `Method` coverage test.
- **Snapshot:** each screen rendered on ratatui's `TestBackend` at 80×24 and
  200×50, compared with committed `.snap` files (`insta`). The snapshots are
  text, so they do not see colour: light and dark variants are not worth
  having until a styled snapshot format is (Phase 4).
- **Integration:** a real `Host` in a tempdir (`WHIPHAND_APP_STATE_FILE` pointed
  into it) drives `examples/cycle.yaml --dry-run` through `AgentClient`; Msgs are
  fed into `update`, and the model and rendered frames are asserted. A dry run
  writes no `run.log`, so the test that reads a run back cold uses a real run
  of command steps. The attach test drives a real interactive step against a
  stub `claude` on `PATH` (a `sh` script, so it runs on Unix only; the
  Windows reader is type-checked and clippy-clean for
  `x86_64-pc-windows-msvc`, not run).
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

**Delivered** (branch `feature/tui-phase1-read-only`):

- Shared, additive (track rule 2): `whiphand_core::log_rows::parse_log_line`
  (the inverse of `format_log_line`) and `whiphand_core::run_tree`
  (`build_run_tree`, `stage_rollup`, `current_step_index`, `focus_step_index`,
  `stage_stop_sentence`), with the cases of `run-tree.test.ts` and
  `stage-rollup.test.ts` ported. No parity fixture ties them to the TS: the
  parity harness drives binaries, not pure TS functions.
- Screens: workspaces (recents, pins; the start screen when there is no
  workspace), runs (`/` filter, `o` ongoing across workspaces), run detail
  (tree with collapsible loops and stages, stage rollups; Log, Events,
  Artifacts with markdown, Diff), doctor, the `?` overlay.
- Foreign runs: the detail polls `getRun` and `readRunLog` every second and
  says it is read-only. A foreign run's end is noticed from the list poll.
- Notifications: BEL, OSC 9 and the window title for a local run that waits or
  ends, and for a foreign run that ends; tmux passthrough;
  `WHIPHAND_TUI_NOTIFY=off|bell`. `NO_COLOR` is honoured.
- Hand-offs: `o` to `$PAGER`, `D` to `git diff` in the run's worktree.
- Fixed on the way: the frame-deadline wake-up (section 4). Startup to a
  populated runs list went from 104 ms to 20 ms ([benchmarks](benchmarks.md)).

Followed end to end: a real run of command steps from the CLI, watched in
`whiphand tui` driven through a pseudo-terminal (tree, log with ANSI colour,
diff, doctor, workspaces, help, the `git diff` hand-off and back). The
integration tests follow a local run live and compare its log with a cold
read of `run.log`; they match row for row.

Not done, and why:

- In daily use every run is foreign until Phase 2 adds `startRun`. The live
  path (`getJobScrollback`, `whiphandEvent`) is built and covered by the
  integration tests, but people will mostly see the polled path for now.
- A foreign run's waiting state (`ptyAwait`, `manualRequest`) cannot be seen:
  those notifications go to the owning process.
- The help overlay does not scroll; at 80×24 its last lines are cut.
- No path input on the workspaces screen; `-C` or a recent workspace opens one.
  `initWorkspace` stays in Phase 3.

Verification notes: `npm run test:parity` needs fresh release binaries
(`cargo build --release -p whiphand-agent -p whiphand-cli`); stale ones fail
the workflow and init scenarios. Under Node 25 the desktop's vitest suite fails
26 tests on `localStorage.clear is not a function` (Node's own global
`localStorage` shadows jsdom's); this branch does not touch `apps/`.

### Phase 2: Driving runs (about 2 weeks)

New-run form; cancel, resume, rename, lock, delete; approvals and manual steps
including send-back comments; attach mode; end session.

Exit: a `feature` workflow runs start to finish from the TUI alone, including
attach, detach and reattach to the plan step, and a sign-off with diff and
send-back.

**Delivered** (branch `feature/tui-phase2-driving-runs`):

- No shared-crate changes. The new-run form reads each workflow from
  `listWorkflows`, whose JSON `whiphand_core::schema::parse_workflow` reads
  back unchanged, so `consumes_attachments`, `dropped_refs` and the step
  helpers are core's own.
- Keys: the detail's errors only, every step and diff reload moved to `f`, `A`
  and `Ctrl-r` (section 6). `Ctrl-c` asks to cancel the run in focus, else to
  quit.
- Run actions from the runs list or the detail: cancel, resume (plain, with a
  fresh session, with more iterations), rename, lock, delete; end session from
  the detail. What cannot be undone asks first in the footer; what does not
  apply says why. A resumed run is local from then on and followed live.
- New run: a workflow picker (the one this workspace ran last first; one
  that does not parse says so), then a form generated from its inputs,
  prefilled as the desktop does; name, max iterations (with a loop),
  attachments (when a step reads them), dry run, worktree; a warning when
  another run is going in the workspace, and for disabled steps. `Ctrl-e`
  edits a field in `$VISUAL`/`$EDITOR`. Once the job knows its run id, the
  run's detail opens.
- Manual and approval steps: a full screen with the instructions (or the
  focused file's patch), the note, the context's artifacts (paged), the run's
  working diff and per-file comments; `a`, `b` and `X` (asks first). It opens
  over its run's detail when that run is on screen or was just started here;
  otherwise it notifies and `m` opens it.
- Attach mode as section 5 describes, on a 2 MB PTY ring per job, spliced with
  `getJobScrollback` by the `mergeScrollback` port.
- Fixed on the way: a resumed run has two jobs here, and took the status of
  whichever id sorted first; a run now has one job at a time.

Followed end to end: in `whiphand tui` driven through a pseudo-terminal with a
stub `claude` on `PATH`, a run started from the form, attached, detached,
reattached, typed to, and came back when the session ended. That run found a
panic the tests could not: `select!` builds a disabled branch's future, and
the key branch unwrapped the event stream. The integration tests start runs
from the form, drive cancel, resume, rename, lock and delete against a real
host, send a sign-off back with feedback and a file comment (both land in
the step's `feedback.md`) and approve the second round, and attach to a real
interactive step.

Not done, and why:

- The exit check with real harnesses (`claude`, `copilot`) on a `feature`
  workflow has not been run: it needs signed-in harnesses. Everything it
  covers was run against the stub instead. The sign-off check uses the
  `feature-development` template: `examples/feature.yaml` has no approval step.
- Windows attach input is type-checked and clippy-clean, not run: CI has no
  console to attach. (Run by hand on 2026-10-17, Phase 4: typing reaches the
  session, but detach never fires.) Keys without a character (arrows, F-keys) are turned
  into VT sequences by a table that is unit-tested on every platform. The
  attach test is Unix-only (its stub is `sh`).
- tmux and SSH were not tried (Phase 4's manual matrix).
- `attach.auto` waits for settings (Phase 3); `Ctrl-]` is not configurable yet.
- No path completion or pasted images for attachments, and no model
  overrides: `startRun` has no field for them.
- `e` (edit an artifact, `writeArtifact`) is free now and lands with Phase 3.
- The help overlay still does not scroll, and the detail's footer hints are
  cut at 80 columns; Phase 2's keys make both longer.

Verification notes: as in Phase 1, `npm run verify` fails the desktop's 26
tests on Node 25's own `localStorage`; this branch does not touch `apps/`.

### Phase 3: Workflows and settings (1 to 2 weeks)

Workflow CRUD, `$EDITOR` editing and validation, `init`, config, prune, models.

**Delivered** (branch `feature/tui-phase3-workflows-settings`):

- Shared, additive (track rule 4): `AppState.tui` (`TuiPreferences`:
  `attachAuto`, `detachKey`) in `whiphand-protocol`, its schema in the agent,
  and `"tui"` among the keys `setUiState` takes. It has no default, so a state
  the TUI never touched keeps its shape and the parity fixtures are unchanged;
  `protocol.gen.ts` gains the types only. The detach keys are named
  (`ctrl-backslash`), not spelled: ts-rs does not escape a backslash.
- The client knows every protocol method: the twelve Phase 3 ones are
  implemented, and `getWorkflow` (`listWorkflows` carries each workflow) and
  the desktop's draft and tab methods are `DESKTOP_ONLY`. `LATER` is gone.
- Workflows (`g f`): the list (project, global, shadowed, does not parse) and
  a preview of the one selected (description, inputs, steps with runner and
  model). `e` hands a copy of the file to `$EDITOR`; the text comes back
  through core's `parse_yaml` (a YAML error is said at once), then
  `validateWorkflow`, and only a draft that passes reaches `updateWorkflow`.
  One that does not is kept, with its problems by step and field, so the next
  `e` goes on from it; `Esc` drops it. `updateWorkflow` merges onto the file,
  so its existing comments survive; comments added in the editor do not, and
  the screen says so. `n`/`N` create and open the new file in the editor, `c`
  clones, `x` deletes (saying when a global workflow takes the deleted one's
  place), `r` opens the new-run form on the workflow, `i` sets the workspace
  up (offered when it has no workflows of its own, as the desktop does).
- Settings (`g s`): the workspace's and the global config, row by row, with
  where each value comes from. A change saves at once (`configSet` with the
  whole config, then both layers read again). The retention override stays
  explicit (`explicitKeys`), as the desktop's checkbox keeps it; lowering it
  prunes; `u` drops a workspace override; `P` prunes now. The Terminal UI pane
  holds `attachAuto`, the detach key and the log's path; the Models pane lists
  `listModels` per runner (live, built-in list, unavailable).
- `attachAuto` attaches a run started from this TUI when its interactive
  step starts, unless a session or a question is already up. The detach key is
  the one Settings picked, for detach, its double and `… e`.
- Workspaces: `a` opens a folder by its path (relative to where the TUI
  started, `~` for home); the agent refuses one that is not a directory before
  the TUI leaves the workspace it is on.
- Run detail: `e` edits the open text artifact in `$EDITOR` and saves it with
  `writeArtifact` and the mtime it was read at. If the run wrote the file
  meanwhile, the save is refused, the file is shown as it is now, and the edit
  is kept for the next `e`.
- The `?` overlay scrolls.

Followed end to end: in `whiphand tui` driven through a pseudo-terminal with
a stand-in `$EDITOR` and a stub `claude` on `PATH`: an empty folder set up
with `i`, a workflow created, a broken draft refused (the file untouched), the
fix saved and run; `attachAuto` and `Ctrl-\` set in Settings, a run that
attached by itself, detached with `Ctrl-\`, reattached with `t` and ended;
its artifact edited with `e`; the models of the installed harnesses listed.
The integration tests set a workspace up, edit a workflow with a comment
(refused, then saved with the comment kept), clone, delete and create one
against a real host; write a workspace's run limit and prune three runs to
it; and read preferences one host saved from a second host on the same app
state.

Not done, and why:

- No `:` command palette: nothing in Phase 3 needed one.
- Workflows are edited as text only: the desktop's form editor (step rail,
  harness and model pickers) has no terminal counterpart. The Models pane is
  the reference for model ids.
- `Ctrl-]` cannot be any key: Settings offers the four control keys that do
  not clash with a shell or an editor.
- The detail's footer hints are still cut at 80 columns (Phase 4).

Verification notes: `npm run verify`'s steps all pass, including the
desktop's vitest suite (1,551 tests) that Phases 1 and 2 saw fail on Node 25.

### Phase 4: Hardening and release (1 to 2 weeks)

Manual matrix, Windows input edge cases, resize storms, `NO_COLOR`. Docs: a
"Terminal UI" section in the README, a "Frontends" section in `docs/design.md`
(the TTY seam's three hosts: CLI inherit, desktop xterm, TUI attach, plus the
desktop-only list), CHANGELOG, benchmarks. Drop the experimental marker.

**Delivered** (branch `feature/tui-phase4-hardening`):

- No shared-crate changes. One test is added to `whiphand-agent`: a source
  check over the agent and core (their tests and the parity harness aside)
  that nothing they start inherits the terminal, and that no `SpawnOptions`
  leaves a stream to its default, which is `Inherit` (section 7).
- Signals: SIGTERM, SIGHUP and SIGINT on Unix, and the console closing,
  Ctrl-Break and shutdown on Windows, quit without asking. The terminal is
  put back and `Host::shutdown()` gives runs their grace period, so a run
  ends `cancelled` with its step `interrupted`, ready to resume, instead of
  staying `running` with a stale lease. On Windows tokio's handler holds the
  console open until the process exits, within the system's 5 s.
- Windows keyboard: AltGr arrives as Ctrl and Alt together, and inputs and the
  key table dropped it as a chord, so `@`, `\` and `{` could not be typed on
  Hungarian or German layouts (no Windows path in "open folder"). A printable
  character with both held is now text.
- Paste: bracketed paste (section 7). A paste goes into the field being
  edited in one piece; a one-line prompt gets its line breaks as spaces, so
  a paste never submits it; anywhere else a paste is dropped rather than
  read as keys. Attaching sets paste mode the way the session last asked
  for it in its output (assumed on when the ring was trimmed past it).
- Colour depth (section 7). The theme keeps to the 16 named colours; agents'
  256-colour and RGB log lines are brought down after the frame is drawn.
- The footer's hints fit the width: hints that do not fit are left out, in
  table order, with `…`, and `? help` and `q back` always show. They were
  cut at 80 columns, and at 200 on the busier screens.
- Every snapshot model is also drawn at every size up to 30×8 and at very
  wide or very tall ones; none panicked.
- Docs: README "Terminal UI", design.md "Frontends", CHANGELOG, benchmarks.
  `--help` and the header no longer say experimental.

Followed end to end, on Linux, in `whiphand tui` driven through a
pseudo-terminal: a run of command steps started from the form, then
`kill -TERM`, `-HUP` and `-INT` in turn (the terminal came back in canonical
mode with echo, off the alternate screen and with bracketed paste off; the
run was cancelled with its step interrupted); a two-line paste into the
rename prompt (one line, not submitted early; the run renamed) and a stray
paste on the detail (no key fired); a coloured log line under
`TERM=xterm`, `xterm-256color` and `COLORTERM=truecolor` (no 24-bit
sequences without the last; indices under 16 with the first); 400 random
resizes from 1×1 to 220×60 in a burst (still drawing, still answering keys).

Manual matrix, for the PR's reviewer to tick before merging (Linux was run
here; tmux and SSH need a tmux install and a key in `authorized_keys`, which
this machine does not have):

- [ ] Windows Terminal: start and follow a run; attach, detach, reattach;
  AltGr `@` and `\` in "open folder"; paste; resize; close the window with a
  run going (it shows `cancelled` next time). Run on 2026-10-17 (below):
  everything passes except detach, which never fires, and paste.
- [ ] conhost: the same. Run on 2026-10-17: the same results.
- [ ] macOS Terminal (256 colours): the same, and a coloured agent log.
- [ ] iTerm2: the same.
- [ ] tmux: notifications (bell, title) and a detach key that tmux does not
  take.
- [ ] SSH: the same as a local terminal; closing the connection stops runs as
  quitting does.
- [ ] The desktop open on the same workspace: recents survive both, and a
  desktop run shows as foreign.

Not done, and why:

- Styled snapshots (light and dark): the snapshots are still text. The colour
  mapping is unit-tested instead.
- On Windows the console delivers a paste as keys, not as one event. Keys
  that are waiting at once, with a line break among them, are taken as one
  paste; a paste slow enough to arrive in pieces is still keys.

Windows, run on 2026-10-17 from `main` (8bb3a6a), cross-built with
`cargo xwin` for `x86_64-pc-windows-msvc`, on Windows 11 (build 26200) in a
QEMU VM (WinBoat), with Git for Windows and a stub `claude.cmd` (the attach
test's stub, ported to cmd). Keys were sent through QEMU's monitor, so they
arrive as hardware scancodes, AltGr as the right Alt key; screenshots were
taken the same way. In Windows Terminal and in conhost:

- Pass: start, help, a run started from the form and followed to the end, its
  step tree and log; colours (named, 256 and RGB lines); line editing in an
  attached session (Backspace, Home, End, arrows) and the TUI coming back when
  the session ends, the artifact harvested through the `.cmd` stub; AltGr
  `@`, `\` and `{` on the Hungarian layout in "open folder"; Ctrl-Break and
  closing the tab or window with a run going (the run is `cancelled`, its
  step interrupted). Checked in Windows Terminal only: maximize, snap and
  quarter-snap redraws; no `whiphand`, `sh` or `ping` left after the close;
  `r` resumes the cancelled run to the end; `Q` puts the console back with
  echo on; the bell when a run ends.
- Fail: detach. A pseudoconsole asks for win32-input-mode (`ESC[?9001h`) in
  its first output, attach passes that to the real console, and keys then
  reach the attach reader as `ESC[…_` sequences, so `Ctrl-]` is never the byte
  `0x1d` and goes to the session with the key after it. Detach, reattach,
  `Ctrl-] Ctrl-]` and `Ctrl-] e` are blocked on it.
- Fail: a two-line paste renamed the run to its first line, then ran the
  second as keys.
- Found on the way, not Windows-specific: `o` (ongoing runs) is refused by the
  agent (`limit` 200 over its 100); the Windows CLI needs the VC++ runtime and
  exits silently without it.

Each is in `docs/review-backlog.md` ("TUI on Windows").

Run again the same day from `fix/tui-windows-backlog`, same VM, with a stub
`claude.cmd` that opens `cmd /k`, so a session stays up until it is told to
exit. In Windows Terminal and in conhost:

- Pass: detach (`Ctrl-]` then a key), the tab or window titled `whiphand`
  again after it; reattach, with the replay; a two-line paste into the rename
  prompt goes in whole (its line break as a space) and submits nothing; a
  paste onto the runs screen is dropped. Checked in Windows Terminal only:
  `Ctrl-] Ctrl-]` sends one `^]`; `Ctrl-] e` ends the session and the TUI
  comes back; `o` lists, with no error; `uname -s; seq 3` in a command step.
- Not run: the binary on a Windows without the VC++ runtime (the VM has it).
  `whiphand.exe` links `libcmt` and imports no `VCRUNTIME140.dll`, which the
  Windows smoke test now checks.
- In conhost, Ctrl+V reaches the TUI as a key, not a paste; conhost pastes
  on a right-click, which works.
- A signal that arrives while `$PAGER` or `$EDITOR` has the terminal is
  handled when the program exits: the TUI waits for it synchronously.
- crossterm writes the 16 named colours as `38;5;n`. A terminal that knows
  only the 8/16-colour SGR codes would need a backend of its own; none in the
  matrix is one.
- No `:` command palette, as in Phase 3.

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
- Phase 1, shared and additive: `crates/whiphand-core/src/log_rows.rs`
  (`parse_log_line`), `crates/whiphand-core/src/run_tree.rs`.
- Reused: `crates/whiphand-protocol/src/lib.rs` (types, `METHODS`,
  `NOTIFICATIONS`, `PROTOCOL_VERSION`), `crates/whiphand-core/src/log_rows.rs`,
  `run_tree.rs`, `path_form.rs`, `execution_key.rs`, `format.rs`,
  `doctor/tools.rs` (`doctor_report`).
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
   as quitting the desktop. Mitigation: quit confirmation (asked every time), tmux guidance,
   `resumeRun`.
4. **A third UI to maintain, while the desktop keeps moving.** Mitigation: the
   track rules above. The coverage test makes every protocol change visible
   without blocking desktop PRs, and gaps are recorded rather than chased.
5. **Drift from `main`.** Mitigation: one short-lived branch per phase, rebased
   on `main` before each PR; no long-lived TUI branch.
6. **Binary size.** ratatui, crossterm and pulldown-cmark add about 1 to 1.5 MB;
   dropping axum from the CLI path offsets part of it. Recorded in
   `docs/benchmarks.md`: +1.05 MB in Phase 0, +0.56 MB in Phase 1, +0.61 MB in
   Phase 2, +0.57 MB in Phase 3, +0.01 MB in Phase 4.

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
