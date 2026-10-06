# Phase 3 plan: run the agent inside Tauri and remove the Node sidecar

Working plan for Phase 3 of [migration.md](migration.md). Branch:
`feature/phase3-agent-in-process`, one PR, each step one or more commits.

| Step | Status | Commit |
|---|---|---|
| 1. Port the missing core pieces | Done | `5d68411` |
| 2. `whiphand-protocol` crate and TS codegen | Done | `39c6f21` |
| 3. `whiphand-agent` crate | Done | `c331589` (3a), `46cd66b` (3b), `cbcceb2` (3c) |
| 4. The TS-vs-Rust agent gate | Done | `9ea4b13` |
| 5. Wire up the webview | Done | `93234c8` |
| 6. Move the webview's TS out of `packages/` | Done | `9eba24e` |
| 7. Delete and repackage | Done | `6aec366` |
| 8. CI and docs | Done | `b2b07bf` |

Steps 1 to 8 have been verified on Linux only. Windows and macOS CI have not
run them yet.

## Context

Phase 2 is merged (#21). The engine, store, process, adapters and doctor
live in `crates/whiphand-core`, and the Rust CLI has shipped. The desktop app
still spawns `packages/agent`, a Node SEA of about 100 MB that bundles
node-pty. It talks to the webview over stdio NDJSON, and that sidecar hop is
the root of the IPC latency and the resident-memory problem in
`migration.md`.

Phase 3 runs the same RPC protocol in-process in Tauri, backed by
`whiphand-core`. It moves the remote web server into Rust, then deletes
`packages/agent`, `packages/core` and the SEA/postject/node-pty packaging.
After this phase the only Node left is the Vite frontend build.

Decisions made:
- **Workflow validation in the webview:** `validateWorkflowDraft` stops
  running in TS. The editor calls a new `validateWorkflow` RPC backed by the
  Rust validator. The webview's other pure display helpers move into
  `apps/desktop`.
- **`mergeWorkflow` port:** it preserves comments, key order and scalar
  styles, but its output does not have to match TS byte for byte. Its goldens
  compare the workflow the text parses back to and the comments it keeps.
  Every other port keeps the byte-identical golden rule.
- **Delivery:** one branch and one PR, with the steps below as commits.
  Windows CI must pass, not just Linux.

## Architecture

```
webview ──invoke/Channel──▶ src-tauri (thin glue) ─┐
browser ──ws /ws──────────▶ axum (in-process) ─────┼─▶ whiphand-agent::Host (engine thread)
parity/bench ─stdio NDJSON▶ whiphand-agent bin ────┘        └─▶ whiphand-core
```

- **`crates/whiphand-protocol`.** Serde and ts-rs types for the envelope, all
  41 methods (the TS agent's 40 plus `validateWorkflow`), the 11
  notifications and the error codes. They generate
  `apps/desktop/src/shared/protocol.gen.ts`; `tests/codegen.rs` fails when it
  is stale, and `WHIPHAND_UPDATE_PROTOCOL=1` rewrites it. Core-owned shapes
  (workflow, event, manual request, config, run summary) cross as JSON values
  and are named through `apps/desktop/src/shared/core-types.ts`.
  `parity/protocol-types.ts` holds the generated types equal to
  `protocol.ts`'s zod types until the TS agent goes.
- **`crates/whiphand-agent`.** In the root workspace, testable without webkit.
  A library plus a `whiphand-agent` stdio binary, kept for parity and
  benchmarks and not shipped.
  - **Host.** Core's engine futures are `!Send`, so a `Host` owns one thread
    with a current-thread runtime and a `LocalSet`. Every client (webview,
    browser, stdio) connects with a sink and sends lines through a channel.
    Responses go to the client that asked; notifications go to every client
    through the scrollback, which records them and stamps `seq`.
  - **Dispatcher and params** (`rpc.rs`, `schema.rs`). Every method's params
    are validated with zod 4's issue wording, built on core's `zod.rs`.
    Remote clients see only the remote partition, and a remote `startRun`
    takes attachments only as uploaded bytes.
  - **Jobs** (`frontend.rs`, `runs.rs`, `job_handlers.rs`, `jobs.rs`).
    Core's `Frontend` for the agent: events, headless lines, manual steps,
    interactive terminals with the end marker, `endSession`, await state and
    the bell.
  - **Terminals** (`pty.rs`). `portable-pty` on POSIX. On Windows the agent
    talks to ConPTY directly, because `portable-pty` re-quotes every argument
    and that breaks the cmd.exe wrapper for `.cmd` shims. Compile-checked for
    `x86_64-pc-windows-msvc`, not yet run.
  - **Remote access** (`remote/`). axum in-process: Host and Origin checks,
    the token in `Sec-WebSocket-Protocol`, `/api/ping`, `/ws`, the built UI
    with traversal protection, `remote-access.json` written 0600, and close
    code 4001 on token rotation. Each socket is a `Remote` client of the
    host.
- **`apps/desktop/src-tauri`** stays outside the root workspace, so the
  `rust` CI job needs no webkit. It takes a path dependency on
  `whiphand-agent`.
  - `lib.rs` gains managed `Host` state and three commands:
    `agent_attach(on_line: Channel<String>)`, `agent_send(line)` and
    `agent_detach`.
  - Remote access starts with the host.
  - The web root comes from `resource_dir()/resources/web` through
    `HostConfig::web_root`.

## Steps

### 1. Port the missing core pieces (done)

Each piece has a golden suite generated from the TS side in
`parity/fixtures/core/`, through `parity/agent-core-probe.ts` and
`whiphand-core/src/parity_agent_core.rs`:
- `readRunLog` → `store/run_log.rs` (suite `store-run-log`)
- `workingDiffFiles` → `engine/diff.rs` (suite `diff`)
- `mergeWorkflow` → `workflow_write.rs` (suite `merge-workflow`, compared by
  meaning). It splices the original lines and re-emits changed entries; any
  merge that would not parse back to the edited workflow falls back to a full
  re-emit.
- update, delete and clone a workflow → `scaffold.rs` (suite `workflow-write`)
- `sameWorkspace`, `findWorkspaceKey` → `path_form.rs` (suite `workspaces`)
- model listing and the catalog → `adapters/models.rs` (suite `models`,
  parsers only)

Moved to step 3: full `workspaceConfigSchema` validation, since it is one
params schema among 41.

### 2. `whiphand-protocol` crate and TS codegen (done)

Also added `validateWorkflow` to the TS agent (schema, handler, test, remote
partition, `client.ts`), so the gate covers it.

### 3. `whiphand-agent` crate (done)

- **3a:** host, dispatcher, params schemas, app state, the handlers without
  jobs, and the stdio binary.
- **3b:** jobs, frontend, terminals, scrollback, sizes, the bell. Core
  change: `Frontend::run_interactive` takes an `emit` sink, as TS's did, so a
  session's own events (`session:await`, `step:pty-exit`, `session:ended`)
  are journaled. The CLI ignores it.
- **3c:** remote access.

Tests ported with each module, including the auth and traversal tables, six
real-PTY session tests and ten real-socket server tests.
`parity/agent-command.ts` lets `main.test.ts` and `behavior.test.ts` drive
the Rust binary through `WHIPHAND_PARITY_AGENT`. Against it they pass 24 of
24 and 11 of 11.

### 4. The TS-vs-Rust agent gate (done)

- `parity/agent-corpus.ts`: ten scenarios calling all 41 methods, valid and
  invalid. `parity/agent-transcript.ts` plays them one request at a time.
- `parity/agent.test.ts`: each scenario against the TS agent and the Rust
  binary in the same directory, compared live, so the comparison holds on
  every platform. Responses by step, notifications in order per method,
  terminal output as text. A static check keeps every method in the corpus.
- Normalized: timestamps, ids, pids, tokens, mtimes, the remote port and
  addresses, the JSON parser's wording, `nodeVersion`. `run:env` is compared
  by its distinct contents on its own: both engines emit it whenever a
  fire-and-forget probe answers, which shifts event ordinals and run.log
  offsets, and a run that ends first drops it.
- CI's parity job builds `whiphand-agent`.
- Recorded transcripts replaced the live comparison in step 7.

### 5. Wire up the webview (done)

As planned, with these details:
- `src-tauri/src/agent.rs` starts the `Host` in `setup`, so remote access is
  up before a window attaches, and shuts it down on `RunEvent::Exit` so runs
  write their final state. `agent_attach` takes two channels, `on_line` and
  `on_exit`. `on_exit` fires when the host drops the webview's sink, which
  happens when the engine thread exits. A reattach restarts a host whose
  thread has died (`Host::is_running`).
- `agent_send` takes a batch of lines. `InProcessTransport` keeps one invoke
  in flight and queues the rest, so `ptyInput` keystrokes cannot overtake
  each other. Lines sent during an attach wait for it.
- A handler panic now fails only its request, answered with -32000
  (`rpc::panicked`). src-tauri builds with the default `panic=unwind`.
- `capability-contract.test.ts` now pins the invoked commands against
  `generate_handler!`, the absence of shell spawn grants, and the bundle.
- `scripts/package/desktop.mjs` still builds the sidecar and the node-pty
  tree, which Tauri now ignores; step 7 deletes them.
- Checked on Linux: `tauri dev` starts, the engine thread runs, remote access
  listens and answers `hello`, and the webview's `setUiState` reached
  `app-state.json`. The full manual end-to-end list is still to do.

Planned:

- Link `whiphand-agent` into `apps/desktop/src-tauri`: managed `Host`,
  `agent_attach`, `agent_send`, `agent_detach`.
- Add `apps/desktop/src/agent/inprocess-transport.ts`, implementing
  `Transport` from `transport.ts` with `invoke` and a `Channel`.
  `AgentClient` is unchanged.
- Replace `TauriTransport` in `main.tsx` and delete `tauri-transport.ts`.
- Drop the `__AGENT_SPAWN_MODE__`, `__AGENT_ENTRY_PATH__` and
  `__WEB_DIST_PATH__` defines from `vite.config.ts` and `vite-env.d.ts`.
- Remove the `shell:allow-spawn`, `allow-stdin-write` and `allow-kill`
  permissions. Keep `shell:allow-open`, which `openUrl` and the updater use.
- Remove `externalBin` and the `resources/node-pty` resource from
  `tauri.conf.json`.

### 6. Move the webview's TS out of `packages/` (done)

As planned, with these details:
- The modules are copied, not moved: `packages/core` still serves the TS
  agent and the parity probes until step 7 deletes it. `degradations.ts`
  came along, since `types.ts` and `log-rows.ts` import it. Their headers
  now name the Rust module each mirrors. The webview imports nothing from
  `packages/core` or `packages/agent`, and `@whiphand/core` is gone from its
  dependencies.
- `core-types.ts` defines the webview's own `RunSummary`/`RunDetail` (loose,
  as `client.ts` had them), `ConfigKey` and `PartialConfig`, and re-exports
  the rest from `types.ts`. `client.ts` takes `MethodMap` and
  `NotificationMap` from `protocol.gen.ts`. `parity/protocol-types.ts` now
  checks that core's run shapes fill the loose ones. `EMPTY_APP_STATE` moved
  to `src/test/app-state.ts`, since only tests used it.
- `WorkflowEditor` validates through `validateWorkflow` at Save, then again
  250 ms after each edit, but only while problems are on screen. Its tests
  answer the RPC with `src/test/validation.ts`; the tests about problems use
  answers recorded from the Rust validator.
- `step-tree.test.ts` no longer runs core's TS validator. The "Reads from"
  offers are pinned in `parity/fixtures/desktop/reads-from.json`: the
  desktop test asserts `referenceableIds` produces them, and
  `whiphand-core/tests/reads_from.rs` asserts the validator accepts each one.
- `src/shared/core-goldens.test.ts` checks `segment` and `workflow-name`
  against the `segment` suite, and `log-rows` (and through it `format`)
  against `store-journal`'s run.log lines.
- `vite.config.ts` no longer widens `server.fs.allow` to the repo.

Planned:

- Move the pure modules the webview imports into `apps/desktop/src/shared/`:
  `steps`, `format`, `enabled`, `attachments`, `path-form` (`sameWorkspace`),
  `log-rows`, `execution-key`, `tool-groups`, `segment`, `workflow-name`,
  `types`, and `remote/wire.ts`. Replace the `core-types.ts` shim with them.
- Switch the protocol type imports (about 14 files) and `client.ts`'s method
  map to `protocol.gen.ts`.
- `WorkflowEditor.tsx` calls the `validateWorkflow` RPC, debounced, instead
  of `validateWorkflowDraft`.
- Desktop vitest checks the moved `log-rows`, `segment`, `workflow-name` and
  `format` against the checked-in core goldens, so they cannot drift from
  Rust.
- `vite.web.config.ts` `forbidTauri()` stays, because the web build still
  needs it.

### 7. Delete and repackage (done)

As planned, with these details:
- **The agent gate became a Rust-only regression check.** `parity/agent.test.ts`
  plays every scenario against `target/release/whiphand-agent` and compares
  with transcripts recorded in `parity/fixtures/agent/<posix|win32>/`
  (`PARITY_RECORD=1` rewrites them). They were recorded from the Rust agent
  while it still matched the TS one scenario for scenario. Windows has its own
  set because its answers differ in substance (cmd.exe command lines, session
  hook commands, ConPTY output). It is not recorded yet: the Windows leg fails
  until it is, and CI uploads the transcripts it produced (step 8).
- To make a transcript portable, scenarios run with their own `HOME`/
  `USERPROFILE` (a real `~/.opencode/bin` leaked into doctor), command steps
  run `node` from `PATH` rather than its absolute path (run logs echo the
  command line, so the path's length changed artifact sizes), and the release,
  platform and pid scope are normalized. `normalizeText` moved from the store
  probe to `parity/normalize.ts`.
- The static "every method" check reads the method list from
  `protocol.gen.ts`. `agent-command.ts` and `behavior.test.ts` drive the Rust
  agent only; `behavior.test.ts` takes `TOOL_GROUP_LABELS` and `DoctorRow`
  from the webview's shared modules and inlines core's default config.
- The core goldens are frozen. `crates/whiphand-core/tests/parity.rs` gained
  `WHIPHAND_UPDATE_GOLDEN=1` for a deliberate change (a template edit): it
  rewrites only the lines whose result changed, keeping the TS writer's key
  order everywhere else. The suites' template paths point at
  `crates/whiphand-core/templates`. Gone: every `*-probe.ts` and `*-corpus.ts`
  but the agent's, `core.test.ts`, `store-cross.test.ts`, `store-hold.ts`,
  `regenerate-core-golden.ts`, `protocol-types.ts`, the `store_probe`
  example, and `parity/fixtures/bin`. The recorded runner outputs in
  `fixtures/progress` and `fixtures/models` stay as the frozen suites'
  provenance.
- `scripts/lib/exec.mjs` is the launch half of `exec.ts`, types stripped
  (resolve, quote, the `.cmd` shim bypass, `spawnRunner`, `runSync`,
  `runInherited`), with its 27 launch-plan tests in `exec.test.mjs`. It is
  the invariants' only `child_process` importer. `scripts/lib/child.mjs` holds
  the NDJSON and teardown helpers the bench used from `smoke.mjs`, and
  `scripts/package/common.mjs` holds `repoRoot`, `distDir` and
  `runSignCommand` from `sea.mjs`.
- `platform-gates.json` is empty: every gate was in the TS packages.
  Invariant 5 now forbids any rename-with-retry in JS.
- `prepareDesktopBuild` only builds the web resource; it is synchronous now,
  and `WHIPHAND_PACKAGE` is gone from `desktop.mjs` (release.yml in step 8).
  `smoke.mjs` smokes the CLI only.
- Bench drives `target/release/whiphand-agent` (there is no packaged agent);
  `sizes.agentBytes` is gone, since the installer size covers it.
- Root `package.json` also dropped `esbuild` and `@types/ws`. `npm test` runs
  `scripts/*.test.mjs` and `scripts/lib/*.test.mjs`.
- `test-support` lost what only the TS packages used: `withStubBin`,
  `withUnreadableStubBin`, `withEnv` and the Windows pty-exit helper.

### 8. CI and docs (done)

As planned, with these details:
- `ci.yml`: the parity job passes `PARITY_DUMP` and, on failure, uploads the
  transcripts as `agent-transcripts-<os>`; `agent.test.ts` now writes the
  dump before it checks for a recording, so a platform without one still
  produces its first set. The `test` and `parity` jobs lost the
  `whiphand-job` builds, the parity job the node-pty build tools, and the
  `tauri` job's merge patch now drops only `resources`.
- `release.yml`: `WHIPHAND_PACKAGE` is gone and the step is "Build the web
  resource".
- `scripts/verify.sh` builds the release CLI and agent before
  `test:parity`, which drives them.
- README, `design.md` (the layer diagram and its file pointers) and
  `review-backlog.md` (a note that its TS file names predate the port) no
  longer point at `packages/`. `RunDetailPage.tsx`'s comments point at
  `journal.rs` and `handlers.rs`. The `.gitignore` lines for the sidecar
  binaries and the core corpus capture are gone.
- `npm run package` on Linux: the `.deb` holds the app binary, icons and the
  web resource only, with no `whiphand-agent` or node-pty. 13.3 MB against
  56.2 MB at phase0; the AppImage is 92.4 MB against 130.6 MB.
- Bench saved as `phase3`; results and the four UI rows that got worse are
  in `benchmarks.md`.

Planned:

- `ci.yml`: the parity job already builds `whiphand-agent`; it no longer
  needs node-pty build tools. The `test` job drops the Windows `whiphand-job`
  build. The `tauri` job's `cargo check` no longer needs
  `externalBin: null`.
- `release.yml`: `prepare-release.mjs` no longer builds a sidecar.
- `migration.md`: a Phase 3 "Done" section recording the deviations: the
  relaxed `mergeWorkflow`, the `validateWorkflow` RPC, direct ConPTY on
  Windows, the `emit` sink on `run_interactive`, frozen goldens, src-tauri
  outside the workspace, and the parse-error wording.
- `benchmarks.md`: re-run `scripts/bench.mjs` for RSS, installer size and RPC
  round-trip time against the Phase 0 numbers.

## Risks to watch

- **Flaky remote tests.** `tests/remote.rs`'s `free_port()` binds port 0,
  drops the listener, then the agent binds that port, so concurrent runs can
  collide. `rotating_the_token_closes_every_socket_with_4001` failed once in
  a full workspace run and did not reproduce in 100 isolated runs. Fix by
  binding port 0 in the agent and reading the bound port back.
- **Windows terminals.** The direct ConPTY code has only been compile-checked.
  Watch `.cmd` shims, which go through `plan_launch`'s cmd.exe command line,
  and kills: the first ends the process, later ones are ignored.
- **Hard-coded paths.** Fixtures with POSIX paths or `pid: 1` pass on Linux
  for the wrong reason. The agent regression check runs on Windows CI against
  its own recorded set.
- **Unrecorded Windows transcripts.** `parity/fixtures/agent/win32/` has to
  come from a Windows CI run's uploaded dump, and be reviewed before it is
  committed: nothing compared it with the TS agent.
- **Lost exit signal.** Handled in step 5 (`on_exit`, restart on reattach),
  covered by a host test for a clean exit. A real engine-thread panic has
  not been exercised.
- **Panics in handlers.** Handled in step 5: each request runs in its own
  task and a panic maps to -32000.
- **Blocking file I/O on the engine thread.** The handlers use synchronous
  fs calls; a heavy one (`listRecentRuns` over many workspaces) could delay
  terminal output. The bench found no case: every RPC row is faster than the
  TS agent's.
- **UI rows that got worse in the bench.** Reattach replay, `getJobScrollback`
  as the page sees it, and the diff render (see `benchmarks.md`): an ordering
  effect at page start, since the faster `listRuns` reply now arrives before
  the scrollback. The long tasks on the Runs page while a run floods are not
  explained yet. Check both in the desktop webview, which the bench does not
  drive.

## Verification

- `cargo fmt --check`, `cargo clippy --workspace -D warnings` and
  `cargo test --workspace`, including the codegen staleness check and the
  Windows compile check (`cargo check -p whiphand-agent --target
  x86_64-pc-windows-msvc --all-targets`).
- `npm run test:parity` (the agent regression check and `behavior.test.ts`
  against the Rust agent), `npm test`,
  `npm run typecheck`, `npm run test -w desktop` (with
  `NODE_OPTIONS=--no-experimental-webstorage`) and `npm run build -w desktop`.
- `npm run package`, then check that the installer no longer contains
  `whiphand-agent` or node-pty, and compare its size against
  `benchmarks.md`.
- CI on Windows, macOS (rust job) and Linux.
- Manual end to end with `npm run tauri -w desktop -- dev`: open a workspace
  and start a run; attach to an interactive step; end the session; resolve a
  manual step; view the diff; edit and save a workflow and confirm comments
  survive; resume a run created by the previous release; enable remote
  access and open it from a phone or browser; rotate the token and confirm
  the 4001 disconnect; auto-update from the previous release.
