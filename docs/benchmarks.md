# Benchmarks

`scripts/bench.mjs` records the numbers every phase of [the Rust migration](migration.md) has to beat. Results live in `scripts/bench/results/<platform>-<arch>.json`, under a label per milestone:

| Label | What it is |
|---|---|
| `pre-phase0` | The TypeScript stack as it stood before Phase 0's UI work. Historic. |
| `phase0` | After Phase 0's UI work. **This is the baseline Phases 1–4 are compared against.** |

It is run by hand on a developer machine. Nothing in CI runs or gates on it, because shared runners are too noisy for a regression gate to mean anything.

## Running it

```sh
npm run package                                  # packaged CLI, agent and installers (the packaged rows need them)
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
| `cli` | Wall time of `--help`, `--version` and `run smoke.yaml --dry-run`, for `node packages/cli/src/main.ts` (dev) and `dist/whiphand` (packaged). 2 warmups, then `--runs` samples. |
| `agent` | Spawn→`hello` startup time, and RSS when idle, after loading the large run (getRun plus paging through its whole log), and after `listRuns` on 500 runs. Dev and packaged. |
| `rpc` | Stdio round trips against a warm dev agent: `hello` ×1000, `listRuns` (500 runs), `getRun`, a 2,000-line `readRunLog` tail, and a full backward page-through of the 50k-line log (`replayFullLog`, i.e. "Load earlier" until the start). |
| `sizes` | The packaged CLI and agent, this version's installers in `dist/`, and the web bundle: its total size, its JS size, and its gzipped JS size. |
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
5. Run `__whiphandPerf.rpc()` for the full webview→Tauri→sidecar round trips. These include the shell-plugin hop that Phase 3 removes.

## Results

<!-- results:start -->
_Filled in from `node scripts/bench.mjs --compare pre-phase0` once Phase 0 lands._
<!-- results:end -->
