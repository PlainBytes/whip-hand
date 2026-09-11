# Tauri Desktop UI for whiphand (whiphand) with CI Parity Checks

## Context

`whiphand` is a Node≥24/TypeScript workflow runner (npm workspaces `@whiphand/core` + `@whiphand/cli`, no
build step) that drives `claude`/`copilot` CLIs with per-step model/tool policy. The core
was designed for a Tauri frontend from day one: it never spawns interactive steps (the
"TTY seam" — `docs/design.md:50-90`), exposing everything through `RunOptions.frontend`
(`{ runInteractive, onEvent }`), `spawnHeadless`, `dryRun`, and the 9-variant `WhiphandEvent`
union in `packages/core/src/types.ts`.

Goal: a Tauri desktop app for **less-technical users** (Fluent UI React v9) exposing the
**same functionality as the CLI**, with **CI parity checks** so the surfaces can't drift.

Decisions made with the user:
- **Engine host**: Node sidecar (`@whiphand/agent`) imports `@whiphand/core` directly, speaks NDJSON
  (JSON-RPC-ish) over stdio to the Tauri shell → webview. Behavioral parity is structural
  (one engine), not tested-in.
- **Interactive steps**: embedded xterm.js terminal in the webview, PTY via node-pty in
  the sidecar. Harvest phase stays headless and unchanged.
- **Parity = surface + behavior**: static CLI-surface vs UI-action-registry check, plus
  behavioral tests comparing SpawnSpec streams through both paths.
- **V1 scope**: full CLI parity (run + input forms, doctor, config editing, live run
  status). **Platforms**: Linux-only CI (repo's first CI). **UX**: friendly forms over
  the same domain model — concepts stay 1:1 with the CLI, no raw YAML needed.

Gaps found in exploration that the UI requires fixing: no persisted run state (status
lives only in the in-process event stream), no cancel/kill path (`tty.ts` discards child
handles), three CLI-local helpers that belong in core.

## Target layout

```
packages/core/     @whiphand/core (enhanced: helpers, manifest, cancellation)
packages/cli/      @whiphand/cli (refactored: buildProgram(), --json)
packages/agent/    @whiphand/agent — NEW Node sidecar (NDJSON rpc, node-pty)
apps/desktop/      NEW Tauri app: src/ (vite + React + Fluent UI v9), src-tauri/ (minimal Rust)
parity/            NEW parity fixtures + surface extractor + tests
.github/workflows/ci.yml   NEW first CI
```

Root `package.json` workspaces → `["packages/*", "apps/*"]`. `apps/desktop` gets its own
tsconfig (JSX/DOM); everything else stays no-build.

## 1. Core enhancements (`packages/core`)

**Move helpers into core** — new `src/workspace.ts`: `resolveWorkflowPath` (from
`cli/src/commands/run.ts:27`), `parseInputPairs` (run.ts:17), new `listWorkflows(workdir)`
(scan `.whiphand/workflows/*.yaml`, per-file errors returned not thrown). `defaultRegistry()`
(run.ts:10) moves to `src/registry.ts`. Export from `src/index.ts`; CLI imports them.

**Run persistence — in-core tee** (not a wrapper: `runDir` is created inside `runWorkflow`
at `engine/runner.ts:76`, and in-core means the CLI gets persistence with zero wiring).
New `src/engine/manifest.ts`:
- Zod `RunManifest`: `{ version, runId, workflow, workdir, dryRun, pid, startedAt,
  updatedAt, endedAt?, status: running|succeeded|failed|cancelled, ok?, inputs,
  sessionIds, steps: [{id, runner, model?, mode, status, exitCode?, artifact?, verdict?,
  startedAt?, endedAt?}], error? }`.
- `RunJournal.record(event)` reduces events into `<runDir>/run.json` (atomic tmp+rename,
  serialized writes, `flush()` before return); also appends `<runDir>/events.ndjson` so
  the UI can tail/replay runs it didn't start.
- `listRuns(workdir, config)`: scan `<artifacts_dir>/*/run.json`; manifest-less dirs →
  `{status:'unknown'}`; a `running` manifest whose owner is gone (dead `pid`, or a
  `heartbeatAt` more than 60s stale — the latter catches pid reuse) is repaired in place to
  `interrupted`: `endedAt` set, in-flight steps → `interrupted`, error reason recorded. The
  repair is written back, so it happens once and is immune to later pid reuse; a failed
  write still returns the repaired view. `getRun(...)`: manifest + artifact listing.
- Wire-in at `runner.ts:59`: `emit = (e) => { frontend.onEvent(e); journal.record(e) }`.
  Dry runs get manifests too (`dryRun: true`); UI filters them by default.

**Cancellation — AbortSignal, optional everywhere**: `RunOptions.signal?`;
`Frontend.runInteractive(spec, signal?)` and `spawnHeadless(spec, signal?)` gain optional
trailing params (assignment-compatible — the 52 existing tests need no changes). Check
abort at loop top and after each spawn. New `WhiphandEvent` variant `run:cancelled` +
`RunResult.cancelled?`. CLI `tty.ts` passes signal to `spawn(..., {signal})` — CLI gains
cancel for free. Cross-process kill: agent falls back to SIGTERM on manifest `pid`
(best-effort, documented).

**Small additive**: use already-parsed `WorkflowInput.prompt` as form labels; add optional
`description?` to workflow schema for the browser.

## 2. `@whiphand/agent` sidecar (`packages/agent`)

Deps: `@whiphand/core`, `node-pty`. Runs under system Node ≥24 like the CLI. `src/main.ts`
(readline over stdin, one JSON msg/line on stdout, **all logs to stderr**),
`src/protocol.ts` (zod schemas for every message; request `{id, method, params}` /
response `{id, result|error}` / notification `{method, params}`), `src/rpc.ts`
(dispatcher), `src/jobs.ts` (`Map<jobId, {runId?, controller, pty?, workdir}>`),
`src/pty.ts`. Colocated `*.test.ts`.

Methods: `hello` (handshake/version), `listWorkflows`, `getWorkflow`, `doctor`, `configGet`,
`configSet` (validate with core zod, write `.whiphand/config.yaml`; YAML comments lost —
warned), `startRun` (`{workdir, workflow, inputs, dryRun}` → `{jobId}` immediately; runId
arrives via notification), `cancelRun` (jobId abort, or workdir+runId pid fallback),
`endSession` (closes only the job's live interactive session, so the step harvests and the
run carries on), `listRuns`, `getRun`, `ptyInput`, `ptyResize`.

Notifications: `whiphandEvent`, `runStateChanged`, `ptyStarted`, `ptyData` (base64),
`ptyExit`, `ptyAwait` (the live session became blocked on the human, or went back
to working), `stepLog` (piped headless stdout/stderr lines — better than CLI's inherit).

Frontend seam impl: `runInteractive` → `pty.spawn(spec.argv[0], argv.slice(1),
{cwd, env: {...process.env, ...spec.env}})`, data → `ptyData`, resolve exit code on
`onExit`, abort → `pty.kill()`; core then proceeds to harvest via `spawnHeadless`
unchanged (`runner.ts:201-206`). `spawnHeadless` → piped spawn, lines → `stepLog`,
SIGTERM then SIGKILL after 5s on abort. Concurrent jobs supported; UI warns when a
non-dry run is already running in the same workspace (engine has no lock).

## 3. Tauri shell (`apps/desktop/src-tauri`)

**Spawn system `node` via `tauri-plugin-shell`, not `externalBin`, for v1** — the sidecar
is raw .ts; a self-contained binary (esbuild bundle → Node SEA → externalBin) is the
packaging-hardening path, deferred. Rust stays the generated template +
`tauri_plugin_shell::init()` + `tauri_plugin_dialog::init()` (workspace folder picker);
no custom commands. Sidecar spawned from frontend TS via the shell plugin JS API
(`Command.create('node', [<repo>/packages/agent/src/main.ts])`), scoped in
`capabilities/default.json`. Supervision in the frontend client: on exit → Fluent
MessageBar + auto-restart w/ backoff, pending requests rejected. `tauri.conf.json`:
vite devUrl 61337, agent path injected via vite define for dev.

## 4. React frontend (`apps/desktop/src`)

Stack: vite + React 18 + `@fluentui/react-components` v9 + `@xterm/xterm` +
`@xterm/addon-fit` + zustand (one small store) + react-markdown. Domain types imported
directly from `@whiphand/core` `types.ts` (pure types, no runtime imports; vite
`server.fs.allow` for workspace paths) and `packages/agent/src/protocol.ts` — one model,
zero duplication.

- `agent/client.ts` — AgentClient: id-correlated req/resp, notification emitter,
  restart supervision; `Transport` interface with TauriTransport + MockTransport (tests).
- `state/store.ts`; `parity/ui-actions.ts` (see §5); `components/Sidebar.tsx`
  (the workspace switcher plus a scope-grouped nav list — shipped as a plain `<nav>` of
  buttons rather than the planned TabList: `role="tab"` promises a tabpanel this app
  never had, and Fluent Nav is still preview; the page table lives in `nav.ts`),
  `TerminalPanel.tsx` (xterm+fit; onData→ptyInput, ResizeObserver→ptyResize,
  ptyData→write), `StatusBadge.tsx`.
- Pages: **RunsPage** (DataGrid over listRuns + live runStateChanged; interrupted/dry-run
  filters; polls listRuns while visible so CLI-started runs show up), **RunDetailPage**
  (step cards w/ status/exit/verdict badges merged from the manifest's full step list and
  the live job, `Step N of M` progress with the current card highlighted, markdown artifact
  viewer, live stepLog tail, TerminalPanel when ptyStarted active, Cancel button; polls
  getRun while the run is live so runs it didn't start still advance), **NewRunPage** (workflow dropdown →
  form generated from `WorkflowInput` entries: label = `input.prompt ?? key`, required
  flag, default prefilled; dry-run Switch; Start → navigate to detail), **WorkflowsPage**
  (step table, parse errors inline), **DoctorPage** (card per adapter, refresh),
  **SettingsPage** (config form: runner dropdown from doctor, on_findings dropdown,
  max_iterations SpinButton, artifacts_dir input; comment-loss warning).

## 5. Parity checks (`parity/`)

**Surface**: extract `buildProgram(): Command` into `packages/cli/src/program.ts`
(main.ts currently parses at import time and can't be introspected).
`parity/extract-cli-surface.ts` walks commands/options → canonical JSON.
`apps/desktop/src/parity/ui-actions.ts` — pure-data typed registry mapping every CLI
command+flag to a UI action id (`'--dry-run': 'newRun:dryRunSwitch'`, machine-only flags
marked `exempt:<reason>`; no React imports so it runs under `node --test`).
`parity/surface.test.ts` diffs both ways and fails with a message telling you exactly
what to add to ui-actions.ts.

**Behavior**: add `whiphand run --json` (NDJSON WhiphandEvent per line — the lever making CLI output
machine-comparable, exempt-mapped). `parity/fixtures/workspace/` (config + workflow with
interactive+headless+verdict steps and inputs incl. a default);
`parity/fixtures/bin/` stub `claude`/`copilot` scripts (fixed versions, PATH-prefixed →
deterministic doctor in CI). `parity/behavior.test.ts`:
- Dry-run parity: drive agent `startRun {dryRun:true}` over stdio vs
  `whiphand run parity --dry-run --json`, normalize volatile fields (runId, paths, UUIDs),
  assert deep-equal `step:spawn` SpawnSpec sequences.
- Doctor parity: agent `doctor` vs `whiphand doctor` under stub PATH.
Root script `test:parity` = `node --test "parity/**/*.test.ts"` (own CI job; spawns
processes so kept out of default `npm test` glob).

**UI tests (pragmatic v1)**: vitest + @testing-library/react + MockTransport — NewRun
form generation, run-detail status transitions from a scripted event stream, cancel
wiring, settings round-trip. tauri-driver/WebdriverIO deferred (immature on Linux).

## 6. CI — `.github/workflows/ci.yml` (Linux)

**The repo is not pushed anywhere yet** — the workflow file is authored and committed
locally, ready to activate when a remote exists. Until then every gate runs locally.

Four jobs: **test** (setup-node 24 + npm cache, `npm ci`, `npm run typecheck`,
`npm test`), **parity** (`npm run test:parity`; build-essential+python3 in case node-pty
prebuilds miss), **desktop** (tsc app config, vite build, vitest run), **tauri**
(webkit2gtk-4.1/gtk3/appindicator/rsvg apt deps, stable Rust + Swatinem/rust-cache,
`cargo check` — full `tauri build` moves to a tag-triggered workflow later).
Local equivalent: a root script `verify` = typecheck + test + test:parity + desktop
vitest/build + cargo check, mirroring the four jobs 1:1.

## 7. Build order (each task gated on `npm test && npm run typecheck`)

0. Save this plan as `docs/desktop-ui-plan.md` (repo convention next to `design.md` /
   `implementation-plan.md`) and commit locally. **No push.**
1. Core: move helpers + `listWorkflows` + tests.
2. Core: run manifest + journal tee + `listRuns`/`getRun` + events.ndjson (reuse
   fakeRunner/collector patterns from `runner.test.ts`).
3. Core: cancellation (signal, `run:cancelled`, tty passthrough, renderEvent line).
4. CLI: `buildProgram()` extraction + `--json` (∥ with 2–3). Manual gate: `--dry-run
   --json` on an examples-style fixture.
5. Agent: protocol + rpc + non-PTY methods; tests drive it over stdio as a child.
6. Agent: node-pty runInteractive + stepLog headless spawn (stub interactive program
   e.g. `cat` in tests; manual real-run smoke).
7. Desktop scaffold (∥ after 5): create-tauri-app, vite+React+Fluent, AgentClient +
   TauriTransport + supervision. Gate: `tauri dev` shows Doctor with live data.
8. Desktop pages + store. Gate: vitest green; manual UI dry-run matches CLI dry-run.
9. Terminal panel: xterm↔pty, interactive e2e (mint → chat → harvest → artifact).
10. Parity suite (needs 4+5; ∥ with 7–9). Gate: `npm run test:parity`.
11. CI workflow file + root `verify` script. Gate: `npm run verify` green locally
    (workflow activates automatically once the repo is pushed later).

## 8. Risks

- **node-pty × Node 24 ABI**: prebuilds may lag → source build (fine on Linux/CI with
  build-essential); pin version, land the CI parity job early to catch it.
- **Distribution packaging** (deferred): system-node spawn requires end-user Node ≥24;
  hardening path = esbuild bundle → Node SEA → `externalBin` (node-pty's native .node
  must ship alongside).
- **webkitgtk/Wayland quirks**: README troubleshooting note
  (`WEBKIT_DISABLE_COMPOSITING_MODE=1`, `WEBKIT_DISABLE_DMABUF_RENDERER=1`).
- **configSet loses YAML comments** — v1 limitation, warned in Settings.
- **Cross-process cancel is best-effort** (SIGTERM to manifest pid).
- **Concurrent runs in one workdir**: engine has no lock; v1 allows but UI warns.

## Verification

- Unit/integration: `npm test && npm run typecheck` after every task (52 existing tests
  must stay green — cancellation params are optional-trailing specifically for this).
- Parity: `npm run test:parity` proves surface completeness and SpawnSpec-identical
  dry-run behavior through both paths.
- End-to-end (manual, once): `tauri dev` → Doctor shows real adapters → New Run on a
  scratch-repo workflow → watch live steps → interactive step opens embedded terminal →
  chat → exit → harvest writes artifact → verdict badge; Cancel a running step; confirm
  a CLI-started `whiphand run` appears in the Runs list via its manifest.
- Full local gate: `npm run verify` (mirrors all four CI jobs). No pushing — CI runs
  for real only once the repo gets a remote.
