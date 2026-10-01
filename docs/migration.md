# Migration: moving whiphand to a single Rust stack

## Motivation

Whiphand currently uses three runtimes:
- **Node/TS**, about 20k LOC of source:
  - `packages/core`: schema, run engine, adapters, artifact store
  - `packages/cli`: commander
  - `packages/agent`: sidecar built on node-pty and ws, speaking a stdio/ws RPC defined in `protocol.ts`
  - The CLI and agent ship as Node SEA binaries through postject.
- **Tauri 2 (Rust)**: a roughly 70-line shell (`apps/desktop/src-tauri/src/lib.rs`), plus `crates/job-guard`, a separate binary for Windows Job Objects.
- **React/Fluent webview**, about 20k LOC: uses xterm, mermaid, pdf.js and highlight.js.

What prompted this:
- **Performance problems:** CLI startup, desktop UI jank, memory and binary size, and engine and I/O throughput.
- **Languages considered:** Rust, Go and C#/.NET.
- **Migration style:** incremental.
- **Whether the UI must also use the same language:** undecided, so this document lays out that trade-off below.

Much of the current cost comes from the architecture itself:
- Every desktop action goes webview → Tauri IPC → stdio JSON RPC → Node sidecar → disk, then back.
- Two runtimes stay resident (the webview plus a full Node process).
- The binaries embed Node, which puts them around 100 MB.
- Each CLI invocation boots V8 and loads TS modules.

## Alternatives compared

| | **Rust** (recommended) | **Go** | **C# / .NET** |
|---|---|---|---|
| CLI startup / size | ~1–5 ms, 5–15 MB | ~5–10 ms, 10–20 MB | NativeAOT ~20–50 ms, 15–40 MB |
| PTY on Win/mac/Linux | `portable-pty` (wezterm, ConPTY-proven) | `creack/pty` has no Windows; ConPTY via third-party libs | Pty.Net / hand-rolled ConPTY; thin ecosystem |
| Process guard (Job Objects) | in-process via `windows-sys`, so `job-guard` merges into core | `x/sys/windows`, fine | P/Invoke, fine |
| Desktop shell | **keep Tauri**, drop the Node sidecar, engine runs in-process | Wails (webview): the whole shell is rewritten | Avalonia (native): the whole UI is rewritten |
| UI in the same language? | optional later: Leptos/Dioxus (Rust→WASM in the same webview, JS interop keeps xterm/mermaid/pdf.js) | only via Fyne/Gio, which means losing xterm/mermaid/pdf.js | yes (Avalonia), but no mature terminal, mermaid or PDF controls |
| Reuse of existing work | Tauri shell, job-guard, updater and signing pipeline all kept | none | none |
| Main cost | learning curve, compile times | weaker Windows PTY story, and it is a second rewrite of the desktop shell | largest rewrite (all 20k UI LOC); heavy web features have to be rebuilt |

Also considered and rejected:
- **Stay on TS with Bun/Deno `compile`:** gives faster startup but keeps the sidecar hop and the memory profile, and keeps the JS+Rust mix.
- **Electron:** would be all JS, but it is heavier in memory and size, which works against every reported problem.

**Recommendation: Rust.** It is the only option that keeps the existing Tauri, updater and signing investment. It also removes the Node sidecar hop, which is the root of the IPC latency and memory problems. It has the most proven cross-platform PTY library. With Rust, the "one language" question for the UI can be decided later instead of up front.

## UI decision (deferred to a checkpoint, not up front)

Changing the backend language will not fix UI jank by itself. The jank comes from the webview rendering long logs, event lists, diffs and file trees. That is fixed with virtualization and smaller IPC payloads, which the Rust backend makes possible because it can send pre-aggregated rows. The plan:
1. Keep React through the backend migration. The webview stays the only JS.
2. At the Phase 4 checkpoint, choose between:
   - **(a)** keeping React, or
   - **(b)** porting the UI incrementally to **Leptos**. Leptos is Rust compiled to WASM and runs in the same Tauri webview, and xterm, mermaid and pdf.js keep working as JS islands.
   A native Rust UI (Slint, egui, Iced, GPUI) is *not* recommended, because the terminal, mermaid, PDF and diff views would have to be rebuilt from scratch.

## Remote access, with the React UI and with Leptos

**Today:**
1. The agent's plain HTTP server (`packages/agent/src/remote/server.ts`) serves the prebuilt SPA (`dist-web`, from `vite.web.config.ts`) from disk, with no auth (`static.ts`).
2. The page opens a WebSocket that carries the same JSON-line protocol as the stdio sidecar.
3. The token travels in the `whiphand.token.*` subprotocol. Origin and Host checks guard against DNS rebinding (`auth.ts`), and close code 4001 means the token was revoked.
4. In the UI, only the `Transport` changes: `ws-transport.ts` replaces `tauri-transport.ts`, and `forbidTauri()` stubs out the `@tauri-apps` imports.

**After Phase 3, React UI unchanged:** the model stays the same and only the server side moves into Rust. An axum and tokio-tungstenite server runs inside the Tauri process and serves the same `dist-web` bundle and the same wire format. It uses the same token, Origin/Host checks and 4001 close code, ported one-to-one from `auth.ts`, with its table tests ported too.

**With Leptos, same architecture and a different bundle:**
- **Client-side rendering only.** The UI compiles to WASM, and `trunk build` produces `index.html` plus `.wasm` and a small JS glue file. It is the same kind of static bundle the server already serves.
- **No Leptos SSR or server functions.** Those would add a second API alongside the RPC protocol and break the "one protocol, two transports" design.
- **The transport seam becomes a Rust trait in the UI crate, with two implementations:**
  - `TauriTransport`, through wasm-bindgen to Tauri `invoke` and `Channel`
  - `WsTransport`, through `web-sys`/`gloo-net` WebSocket, with the same reconnect backoff and 4001 handling
- **Two builds of one crate** using Cargo features (`desktop` and `web`) replace the two Vite configs. The `web` build does not compile Tauri-only features such as the dialog, fs, notification and updater plugins, so `forbidTauri()` goes away.
- **Main benefit:** a shared `whiphand-protocol` crate, holding the serde request, response and event types, compiles into both the server and the WASM client. That removes the drift risk between `protocol.ts` and `handlers.ts`, because a protocol change becomes a compile error on both sides.
- **Costs to watch:**
  - The WASM bundle is about 1–3 MB before compression. On a LAN that is fine, but serve it brotli-compressed and run `wasm-opt`.
  - The first load on phones is slower than today's JS.
  - xterm, mermaid and pdf.js remain JS assets in both builds.
  - The file-upload limitation for remote runs (`MAX_FRAME_BYTES`, staged uploads) is unchanged, since that is a protocol matter and not a UI one.

## Incremental migration (Rust)

The main safety net is the existing contract surface:
- the agent RPC in `packages/agent/src/protocol.ts`
- the on-disk format (`.whiphand/runs/<id>/run.json`, `events.ndjson`, the workflow YAML)
- the `parity/` goldens

Each phase ships on its own, and the TS and Rust implementations must produce identical goldens before the TS side is deleted.

**Phase 0: Baselines (about 1 week, stays in TS)**
- Measure:
  - CLI cold start (`whiphand --help`, `run --dry-run`)
  - agent RSS and installer sizes
  - UI frame times and replay time for a large run (thousands of events, long PTY scrollback)
  - RPC round-trip latency
- Store these as a benchmark script under `scripts/` so every later phase has to beat them.
- Quick UI wins that survive every later option: list/log virtualization, and debounced event fan-out in `apps/desktop/src/agent/client.ts`.

**Phase 1: Rust core library, `crates/whiphand-core`**
- Build out the Rust workspace at the repo root and move `job-guard` under it.
- Port the workflow schema and validation (`packages/core/src/schema.ts`, `template.ts`, `config.ts`, `workspace.ts`) using serde, serde_yaml and hand-written validation. Error messages must match the zod ones wherever goldens assert them.
- Extend `parity/` so a single fixture set runs against both implementations (`parity/golden-scenario.ts`, `extract-cli-surface.ts`).

**Phase 2: Engine and CLI in Rust, `crates/whiphand-cli`**
- Port:
  - the run engine (`packages/core/src/engine/`)
  - the adapters (`adapters/`: claude, copilot, opencode)
  - the artifact and event store (`events.ts`, `durable-fs.ts`, `event-paths.ts`)
  - `exec.ts` and `shell.ts`, on tokio
- Build the CLI with clap, mirroring the commander surface exactly. The `parity` CLI-surface extraction verifies the match.
- Ship the Rust `whiphand` binary in place of the Node SEA CLI (`scripts/package/cli.mjs` → cargo build). Old run directories must still resume.

**Phase 3: Agent in-process in Tauri (removes the sidecar)**
- Implement the `protocol.ts` RPC as Tauri commands and channels backed by `whiphand-core`.
- Swap in the webview's transport: add a new transport alongside `tauri-transport.ts`, keeping the `transport.ts` interface so the UI stays unchanged.
- Replacements:
  - node-pty → `portable-pty`
  - `scrollback.ts`, `await-state.ts` and `session-end.ts` → ported
  - job-guard → linked in-process as a library
- Remote web mode (`packages/agent/src/remote`, ws) → axum plus tokio-tungstenite in the same process, with the `ws-transport.ts` wire format unchanged. Port `auth.ts` along with its table tests, and keep `static.ts`'s no-auth-for-static-files rule.
- Extract a `whiphand-protocol` crate holding the serde types for `protocol.ts`. It is what a later Leptos client would share.
- Delete `packages/agent`, `packages/core` and `packages/cli`, along with postject, node-pty packaging and the SEA scripts. The only Node left is the frontend build (Vite).

**Phase 4: UI checkpoint**
- Re-measure against the Phase 0 baselines.
- Decide React versus Leptos (see above). If Leptos, port page by page behind the unchanged transport interface.

## Verification

- **Every phase:**
  - The parity goldens (`npm run test:parity`, then a cargo equivalent) must be identical between the TS and Rust implementations.
  - Run the full test suites.
  - CI must pass on Windows, macOS and Linux. A Linux-only pass does not clear a branch, and hard-coded POSIX paths or `pid: 1` fixtures need special care.
- **Performance:** the Phase 0 benchmark script is re-run and compared after each phase.
- **End to end:**
  - `whiphand doctor`, `init`, and `run examples/cycle.yaml --dry-run`, then a real run and a `--resume` of a run created by the old TS build.
  - The desktop app: open a workspace, start a run, attach to an interactive step in the terminal, review the output, and confirm auto-update from the previous release.
