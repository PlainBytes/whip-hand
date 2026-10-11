# Benchmarks

`scripts/bench.mjs` records the numbers every phase of [the Rust migration](migration.md) has to beat. Results live in `scripts/bench/results/<platform>-<arch>.json`, under a label per milestone:

| Label | What it is |
|---|---|
| `pre-phase0` | The TypeScript stack as it stood before Phase 0's UI work. Historic. |
| `phase0` | After Phase 0's UI work. **This is the baseline Phases 1–4 are compared against.** |
| `phase2` | The CLI as a Rust binary (`crates/whiphand-cli`). `cli` and `sizes` only: nothing else changed. |
| `phase3` | The agent in Rust (`crates/whiphand-agent`), in-process in the desktop app; no sidecar. Every section. |

Phase 1 has no label: the Rust core library it adds is not on any user-facing path yet, so nothing here could move.

It is run by hand on a developer machine. Nothing in CI runs or gates on it, because shared runners are too noisy for a regression gate to mean anything.

## Running it

```sh
cargo build --release -p whiphand-cli -p whiphand-agent   # the binaries the dev rows drive
npm run package                                  # packaged CLI and installers (the packaged rows need them)
npx playwright install chromium                  # once, for the UI scenarios
node scripts/bench.mjs                           # everything: cli agent rpc sizes ui
node scripts/bench.mjs --only cli,rpc --runs 30  # a subset
node scripts/bench.mjs --save phase1             # record under a label
node scripts/bench.mjs --compare phase0          # markdown delta table against a label
```

The bench builds the web bundle itself (`npm run build:web -w desktop`), so the UI numbers always reflect the working tree. A packaged binary or installer that is missing is recorded as `null` with a note; it is never silently skipped.

Debugging aids:
- `WHIPHAND_BENCH_UI_ONLY=logs,diff` runs only the named UI scenarios.
- `WHIPHAND_BENCH_UI_REPEATS=1` sets the number of repeats per scenario.
- `WHIPHAND_BENCH_SHOTS=<dir>` saves a screenshot of every scenario page as it closes.
- `--headed` shows the browser.

## What is measured

Everything runs against a synthesized, seeded workspace (`scripts/bench/fixtures.mjs`), so every phase measures the same bytes:
- a finished run with a 50,000-line `run.log` and an artifacts tree of 20 folders × 300 files;
- 500 small finished runs;
- a git repo with one 6,000-line file, every other line changed in the working tree;
- `flood.yaml`: a command step that prints 50,000 lines, then an interactive step whose stub `claude` writes about 2 MB into the pty;
- `review.yaml`: a manual step with `show_diff: true`.

The agent always runs with its app state, config and remote-access config in a temp directory, so the bench never touches the real ones.

| Section | Metric |
|---|---|
| `cli` | Wall time of `--help`, `--version` and `run smoke.yaml --dry-run`, for the dev build and `dist/whiphand` (packaged). 2 warmups, then `--runs` samples. Through `phase0` the dev build was `node packages/cli/src/main.ts`; from `phase2` it is `target/release/whiphand`, the same binary the package copies. |
| `agent` | Spawn→`hello` startup time, and RSS when idle, after loading the large run (getRun plus paging through its whole log), and after `listRuns` on 500 runs. Through `phase0` this was the TS agent, dev (`node main.ts`) and packaged (the SEA sidecar); from `phase3` it is `target/release/whiphand-agent`, the stdio build of the agent the desktop app links in. There is no packaged agent to measure any more. |
| `rpc` | Stdio round trips against a warm dev agent: `hello` ×1000, `listRuns` (500 runs), `getRun`, a 2,000-line `readRunLog` tail, and a full backward page-through of the 50k-line log (`replayFullLog`, i.e. "Load earlier" until the start). |
| `sizes` | The packaged CLI (and, through `phase2`, the agent sidecar), this version's installers in `dist/`, and the web bundle: its total size, its JS size, and its gzipped JS size. |
| `ui` | Playwright and Chromium against the web build, served by a real agent's remote-access server. Each scenario runs 3 times and the median is recorded. |

### UI scenarios

All UI numbers come from the page's own probe, `apps/desktop/src/lib/perf-probe.ts`, which is enabled by setting `localStorage['whiphand.perf'] = '1'` before the app boots:
- frame stats are rAF deltas: p50, p95, max, and `over33`, the number of frames that missed two vsyncs;
- `longTaskMs` is the Long Tasks API total over the measured window;
- `rpc` is the request→response time per method, as `AgentClient.request` sees it.

- **logs**: open the large run's Logs tab. Records:
  - `firstRowMs`, the time to the first row;
  - `loadEarlierMs`, the median of 5 "Load earlier" round trips, each measured to the next painted frame;
  - `scroll`, a 5-second scripted scroll through everything loaded;
  - `domNodes` and `jsHeapBytes`.
- **fileTree**: open the large run's Artifacts tab, where every folder auto-expands. Records `settleMs` (time until the tree item count stops changing), `scroll` and `domNodes`.
- **live**: start `flood.yaml` and measure 4-second windows:
  - `runsPageDuringFlood` and `logsTabDuringFlood`, while the command step floods;
  - `terminalDuringPty`, while the pty step writes;
  - then reload, re-open the run, and record `reattachReplayMs`: the time from the click until xterm has parsed the replayed scrollback (the last `terminal:flushed` mark).
- **diff**: start `review.yaml` and open the parked run. Records `renderMs` (time until the diff rows stop changing), `scroll` and `domNodes`.
- **rpc**: every request any scenario page made, by method.

### Why Chromium stands in for the desktop webview

The desktop app renders in WebKitGTK on Linux and WebView2 on Windows. Only WebView2 can be automated (over CDP), and the bench has to be repeatable on the Linux machine the baselines come from. The web build is the same React code over a different transport (WebSocket in place of the Tauri shell plugin). So Chromium numbers track the UI's own cost faithfully, but they are not the desktop app's absolute numbers. The manual check below confirms that the trend holds in the real webview.

## Manual check in the Tauri app

1. Write the bench workspace: `node scripts/bench.mjs --fixtures-only /tmp/whiphand-bench`.
2. Start the app with `npm run tauri dev -w desktop` (or install the packaged build), then open `/tmp/whiphand-bench` as a workspace.
3. In the webview devtools, run `localStorage.setItem('whiphand.perf', '1')`, then reload.
4. For each of logs, file tree and live from the list above:
   - Before the interaction, run `__whiphandPerf.startFrames()`.
   - After it, run `__whiphandPerf.stopFrames()`. WebKitGTK has no Long Tasks API, so `longTaskMs` reads 0 there.
5. Run `__whiphandPerf.rpc()` for the full webview→Tauri→agent round trips. Since Phase 3 these are an `invoke` and a `Channel` into the in-process agent; before it they went through the shell plugin to the sidecar.

## Results

<!-- results:start -->
linux-x64: Ryzen 9 5900X, 24 threads, 32 GB, Node 24.21, Chromium 153 (Playwright 1.63). The full table is `node scripts/bench.mjs --compare pre-phase0` run against `phase0`. The headline rows:

| Metric | pre-phase0 | phase0 | Change |
|---|---:|---:|---:|
| Logs: first row | 1,821 ms | 109 ms | −94% |
| Logs: "Load earlier" (2,000 rows) | 1,621 ms | 75 ms | −95% |
| Logs: DOM nodes after 5 pages (12,000 rows) | 84,381 | 411 | −99.5% |
| Logs: JS heap | 624 MB | 60 MB | −90% |
| Logs: long tasks while scrolling | 1,027 ms | 0 | |
| File tree: settle (6,000 artifacts) | 2,454 ms | 530 ms | −78% |
| File tree: DOM nodes | 44,376 | 457 | −99% |
| Diff: DOM nodes (6,000-line file; before: first 2,000 rows only) | 8,279 | 489 | −94% |
| Runs page while a run floods: p50 frame | 167 ms | 16.7 ms | 6 → 60 fps |
| Runs page while a run floods: long tasks / 4 s | 3,724 ms | 0 | |
| Logs tab while a run floods: p95 frame | 117 ms | 16.8 ms | |
| Terminal while the pty writes 2 MB: frames > 33 ms | 6 | 0 | |
| Terminal reattach replay (2 MB) | 226 ms | 235 ms | unchanged |
| `readRunLog` as the page sees it: median | 551 ms | 26 ms | −95% |

Notes on reading the table:
- `readRunLog`'s server time did not change (`rpc.replayFullLog` is level). The page-side drop is the main thread no longer being blocked when the response arrives.
- Reattach replay is dominated by xterm parsing 2 MB. Slicing the decode keeps it from being one long task but does not shorten it.

The CLI, agent, RPC and size rows did not move: Phase 0 changed only the UI. They are the starting point Phases 1–3 are measured against.

### Phase 2: the Rust CLI

`node scripts/bench.mjs --only cli,sizes --compare phase0`, same machine, medians (p95 within 10% of each):

| Metric | phase0 | phase2 | Change |
|---|---:|---:|---:|
| Packaged `--version` | 51.1 ms | 3.0 ms | −94% |
| Packaged `--help` | 53.6 ms | 3.1 ms | −94% |
| Packaged `run smoke.yaml --dry-run` | 74.1 ms | 6.1 ms | −92% |
| Dev `--version` (`node main.ts` → `target/release`) | 177.9 ms | 3.1 ms | −98% |
| Dev `run smoke.yaml --dry-run` | 202.8 ms | 6.0 ms | −97% |
| CLI binary | 128.6 MB | 3.4 MB | −97% |

The agent and the installers are unchanged by Phase 2: the desktop still runs the TS agent until Phase 3.

### Phase 3: the agent in Rust, in-process

`node scripts/bench.mjs --compare phase0`, same machine, Node 24.21, medians. The phase0 agent rows are the packaged SEA sidecar, which is what the app shipped:

| Metric | phase0 | phase3 | Change |
|---|---:|---:|---:|
| Agent startup (spawn → `hello`) | 60.3 ms | 3.0 ms | −95% |
| Agent RSS, idle | 88.8 MB | 5.6 MB | −94% |
| Agent RSS, after the large run | 175.7 MB | 12.1 MB | −93% |
| Agent RSS, after `listRuns` (500 runs) | 180.1 MB | 12.1 MB | −93% |
| `listRuns` (500 runs) | 75.3 ms | 10.0 ms | −87% |
| `getRun` (large run) | 22.5 ms | 15.7 ms | −30% |
| `readRunLog` tail (2,000 lines) | 18.0 ms | 6.9 ms | −61% |
| Full backward page-through of the 50k-line log | 470 ms | 176 ms | −63% |
| `.deb` | 56.2 MB | 13.3 MB | −76% |
| `.AppImage` | 130.6 MB | 92.4 MB | −29% |
| Logs: first row | 109 ms | 100 ms | −8% |
| Logs: JS heap | 60 MB | 45 MB | −26% |
| `listRuns` as the page sees it | 115 ms | 13 ms | −89% |
| `getWorkingDiff` as the page sees it | 38 ms | 17 ms | −55% |

The RPC rows are stdio round trips, so they measure the agent itself. The desktop app no longer pays the agent's startup at all, since the agent starts with the app. Its RSS is now part of the app's own.

Four UI rows got worse:

| Metric | phase0 | `main` before Phase 3 | phase3 |
|---|---:|---:|---:|
| Terminal reattach replay (2 MB) | 235 ms | 237 ms | 401 ms |
| `getJobScrollback` as the page sees it | 124 ms | 129 ms | 484 ms |
| Diff: render (6,000-line file) | 713 ms | 737 ms | 1,196 ms |
| Runs page while a run floods: long tasks / 4 s | 0 | 0 | 318 ms |

The `main` column is a run of the UI section on the last commit before Phase 3, with the TS agent. It matches phase0, so these rows moved with Phase 3. What was checked:
- The agent is not slower at any of these. Over stdio, over the WebSocket from Node, and over a WebSocket opened inside Chromium on its own, `getJobScrollback` takes the same time from both agents (about 12 ms from Node and 74 ms from Chromium, for 2.2 MB), and `getWorkingDiff` is faster in Rust. Both agents send the same notifications, and neither sends anything while idle.
- The first three rows are an ordering effect at page start. A page that opens while a job exists asks for `listRuns` and that job's scrollback together. The TS agent answered the scrollback first; the Rust agent answers `listRuns` first, because it is now 10 ms, so the page renders 500 runs before it gets to the 2 MB scrollback. That work then lands inside the measured windows instead of before them. The diff scenario runs right after the live one, whose job is still listed: run on its own, its render takes 660 ms against the TS agent's 737 ms.
- The long tasks while a run floods are not explained yet. Frame times are unchanged (p50 16.7 ms, p95 16.8 ms, one frame over 33 ms).

These are Chromium against the web build. The desktop webview gets the same messages through a `Channel` rather than a WebSocket; the manual check above has not been redone for Phase 3.

### TUI Phase 0: `whiphand tui`

`cargo build --release -p whiphand-cli` on Linux x86_64, before and after the
TUI crate (docs/tui-plan.md, Phase 0).

| Metric | `main` before TUI Phase 0 | TUI Phase 0 | Change |
|---|---:|---:|---:|
| CLI binary | 3.46 MB | 4.51 MB | +1.05 MB |

ratatui, crossterm and the in-process agent account for the growth. The agent
is linked without its `remote` feature, so axum is not in the binary. Startup
time and RSS of `whiphand tui` are not measured yet: the harness drives
programs over stdio, and the TUI needs a terminal.

### TUI Phase 1: the read-only screens

`cargo build --release -p whiphand-cli` on Linux x86_64 (Ryzen 9 5900X),
`main` at the Phase 0 merge against the Phase 1 branch (docs/tui-plan.md,
Phase 1).

| Metric | `main` after TUI Phase 0 | TUI Phase 1 | Change |
|---|---:|---:|---:|
| CLI binary | 4.48 MB | 5.04 MB | +0.56 MB |
| `whiphand tui`: spawn to the populated runs list | 104 ms | 20 ms | -84 ms |
| `whiphand tui`: peak RSS (VmHWM) | 7.2 MB | 8.0 MB | +0.8 MB |

pulldown-cmark, ansi-to-tui (with nom) and the new screens account for the
growth. Startup is measured by driving the release binary in a 120×30
pseudo-terminal from a script (median of 7, one finished run in the
workspace): the time from spawn until the runs list is on screen, then
`VmHWM` from `/proc` half a second later. The first frame ("Loading…") is up
2 ms after spawn on both. The 104 ms on `main` was a bug, fixed in Phase 1: a
change held back by the 16 ms frame limit was only drawn at the next 100 ms
tick.

### TUI Phase 2: driving runs

`cargo build --release -p whiphand-cli` on Linux x86_64 (Ryzen 9 5900X),
`main` at 7c66492 (after the Phase 1 merge) against the Phase 2 branch
(docs/tui-plan.md, Phase 2). Measured as for Phase 1.

| Metric | `main` after TUI Phase 1 | TUI Phase 2 | Change |
|---|---:|---:|---:|
| CLI binary | 5.07 MB | 5.68 MB | +0.61 MB |
| `whiphand tui`: spawn to the populated runs list | 21 ms | 21 ms | 0 |
| `whiphand tui`: peak RSS (VmHWM) | 7.8 MB | 8.1 MB | +0.3 MB |

The new screens and attach mode account for the growth. Startup is
unchanged: nothing new runs before the runs list is up.
<!-- results:end -->
