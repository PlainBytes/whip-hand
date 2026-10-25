# Review backlog

Findings from the 2026-09 codebase review that were not fixed in that pass, because the fix
is a real refactor (not a cheap/low-risk change) or would change documented behavior. Each
line: `severity · file:line · problem · proposed fix · effort (S/M/L)`.

Phase 3 of docs/migration.md (2026-10) removed `packages/core` and `packages/agent`; their
engine is now `crates/whiphand-core` and their agent `crates/whiphand-agent`, and each Rust
module's header names the TS file it ports. The findings below that name those TS files
have not been re-checked against the Rust code.

## Security leftovers from section 1

- **RESOLVED by the Windows plan (invariant 8) — `{{ }}` in `run:` now expands to a shell variable reference (`${WHIPHAND_X}`), never the value; see `docs/design.md` "Command steps and shell injection". The original finding follows.**
- **high · `packages/core/src/engine/command.ts:39,49` + `packages/core/src/template.ts:25`
  · a `kind: command` step's `run:` is rendered by `renderTemplate` (plain string
  substitution, no escaping) and then handed to `/bin/sh -c`/`cmd.exe` as one string, so a
  run input containing shell metacharacters (`; `, `` ` ``, `$(...)`, `&&`) referenced via
  `{{ inputs.* }}` in a `run:` line injects arbitrary shell syntax. Quoting the placeholder
  in the workflow's own YAML does not help — substitution happens before the shell parses
  the line, so a value like `' ; rm -rf ~ #` breaks out of any author-supplied quotes.
  Reachable from the CLI (`--input`/prompted input) and, if remote access is enabled, from
  `startRun`/`resumeRun`'s `inputs` RPC param (`handlers.ts:168`), which forwards them
  unsanitized. Documented for workflow authors in `docs/design.md`'s "Command steps and
  shell injection" section (added this pass) · proposed fix: shell-escape substituted values
  per resolved shell dialect (`/bin/sh`, `cmd.exe`, PowerShell) at the point `commandSpec`
  renders `run:`, or restrict interpolation into `run:` specifically to values passed as
  environment variables (the convention `command.ts` already uses for `run.name`/`run.slug`
  with `$WHIPHAND_RUN_*`). Nontrivial because `step.shell` is an operator-overridable
  arbitrary command, so a "supported dialects" allowlist is needed, and incorrect escaping is
  worse than none · effort: M.
- **med · `packages/agent/src/remote/server.ts:278` + `packages/agent/src/remote/config.ts:27-32`
  · the remote-access server always binds `0.0.0.0` (every interface); there is no
  host/bind-address field in `RemoteAccessConfig` to restrict it to a specific interface ·
  proposed fix: add an optional `host` field to the config schema (default `0.0.0.0`),
  thread it through `RemoteController`/`RemoteServer.start`, and expose it in
  `RemoteAccessCard.tsx`. Deferred because it touches the RPC protocol
  (`RemoteAccessState`/`remoteAccessSet` params), the controller, the server, and the
  settings UI — a real feature, not a one-line change · effort: M.
- **low · `apps/desktop/src-tauri/src/lib.rs:19-25` (`grant_workspace`) · a compromised
  webview can call `grant_workspace` directly with an arbitrary directory (not just the
  workspace the user opened) since Rust has no independent record of "the" workspace to
  check against; the function already refuses the filesystem root and unresolved symlinks,
  but not e.g. the user's home directory. This is a documented, accepted residual risk (see
  the function's own header), not an oversight · proposed fix: bind `grant_workspace` to a
  value the Rust side independently trusts (e.g. a workspace path set once at startup via a
  privileged channel), rather than trusting whatever the webview passes · effort: M.
- **low · agent/CLI process cleanup on crash · `packages/agent/src/main.ts`'s
  `uncaughtException`/`unhandledRejection` handlers (lines ~146-154) call `process.exit(1)`
  directly, skipping `shutdown()`'s job-abort-and-drain step that the SIGTERM/SIGINT path
  runs; a crash mid-run could leave a spawned child or PTY without a signal. Also, the
  agent's cross-process `cancelRun` (`handlers.ts:404`, kill-by-pid path) sends a single
  SIGTERM with no escalation and no process-group signal, so a standalone `whiphand run`'s
  own spawned grandchild (a command-step shell, or an agent CLI subprocess) is not
  guaranteed to die when its parent is killed this way — confirmed no `detached`/`setsid`
  usage anywhere in `packages/cli/src/tty.ts` or `packages/agent/src/spawn.ts` · proposed
  fix: run the CLI's own spawns in a dedicated process group (POSIX) so a single kill of the
  group reaches grandchildren, and mirror `shutdown()`'s abort in the crash handlers with a
  bounded timeout. Deferred: process-group semantics differ enough between POSIX and Windows
  that getting this right needs its own design pass, not a quick patch · effort: M.
  **Addressed by the Windows plan (invariant 6): every runner child is adopted into a per-run
  container — a process group on POSIX, a Job Object with kill-on-close on Windows — that cancel,
  timeout, lease loss and run end all kill, so a single abort now reaches grandchildren. A crash of the
  owning process is contained on Windows (the guard's parent-handle wait); on POSIX a SIGKILLed
  owner still leaves its groups behind, which the plan accepts.**

## Engine (`packages/core/src/engine/`)

- **med · `packages/core/src/engine/runner.ts` (902 lines) and `manifest.ts` (967 lines) ·
  both files mix several responsibilities (runner.ts: step dispatch, loop control, verdict
  handling, manual-step flow; manifest.ts: run listing, manifest read/write, retention
  helpers, rename/lock) in one file each · proposed fix: split by responsibility (e.g.
  `runner/loop.ts`, `runner/verdict.ts`; `manifest/list.ts`, `manifest/mutate.ts`) once a
  natural seam presents itself — not a mechanical split for its own sake · effort: L.
- **low · `packages/core/src/engine/run-log.ts:355-360` (`readRunLog`, offset mode) ·
  reads and fully parses the entire `run.log` file on every call (`readFile` + `split` +
  `filter`), even when only a small windowed slice is requested; the `fromEnd`/`beforeByte`
  tail modes already avoid this via `tailLines`, but the plain-offset path does not ·
  proposed fix: extend the same handle-based tail-reading approach to the offset path, or
  cache the parsed line count between calls for a run that isn't being actively written ·
  effort: S/M.
- **low · `packages/core/src/engine/retention.ts` (`pruneRuns`) · calls `listRuns`, which
  reads every run's manifest under the workspace to decide what to prune; fine at hundreds
  of runs, a straight linear scan that could get slow in a workspace with thousands ·
  proposed fix: track retained-run metadata (id, timestamp, locked) in a lighter index
  instead of re-reading every manifest, or cap the scan with an early exit once enough
  candidates are found · effort: M.
- **info · `packages/core/src/engine/diff.ts` · `workingDiffFiles` shells out to `git diff`
  through a throwaway index for every call; no caching between repeated calls (e.g. polling
  the review screen for a large working tree) — not measured as a real problem, just
  unverified at scale · effort: S (to measure), M (to fix if it is one).

## Agent (`packages/agent/`)

- **med · `packages/agent/src/protocol.ts` (869 lines) · one file holds every RPC method's
  params/result zod schema plus shared types; `handlers.ts` (719 lines) holds every
  handler's implementation. Both would benefit from splitting along the same boundary as
  `remote/methods.ts`'s partition (e.g. run-lifecycle / workflow-CRUD / config /
  remote-access groups) · effort: L.
- **low · `packages/agent/src/scrollback.ts` / `packages/agent/src/pty.ts` · per-job
  scrollback buffers grow for the life of a long-running interactive session; not verified
  whether there's an upper bound on buffer size for a session that runs for hours and
  produces heavy output · proposed fix: confirm there's a byte or line cap on the ring
  buffer (or add one) so a pathological session can't grow agent memory unbounded ·
  effort: S (to verify), S (to fix if uncapped).
- **info · `packages/agent/src/notify-hub.ts` · fans out every notification to stdio plus
  every connected remote client, and taps scrollback in the same call so buffer index and
  wire sequence can't drift — a good design, not a problem — but there's no back-pressure
  if a slow remote client can't keep up with a chatty run; likely fine given `ws`'s own
  internal buffering, not independently verified · effort: S (to verify).

## Desktop (`apps/desktop/`)

- **med · `apps/desktop/src/state/store.ts` (973 lines) · the single global zustand store
  backs most of the app; `RunDetailPage.tsx` alone calls `useAppStore(...)` 4 times. Worth a
  pass to confirm every selector is narrow (returns a primitive/small object, not a slice
  that changes on every unrelated store update) rather than assumed — re-render hotspots on
  a page this size are easy to introduce silently · effort: M (audit), S–M per fix found.
- **med · `apps/desktop/src/pages/RunDetailPage.tsx` (1727 lines), `FilePreview.tsx` (863
  lines), `NewRunDialog.tsx` (679 lines) · large components mixing data-fetching, RPC
  wiring, and presentation. `RunDetailPage.tsx` in particular is the largest source file in
  the app · proposed fix: split into a container plus focused presentational components
  (e.g. pull the review-screen and terminal-tab wiring out of `RunDetailPage.tsx` into their
  own hooks/components) · effort: L.
- **low · large-output rendering · logs and terminal output are not confirmed to be
  virtualized for very large runs (thousands of lines); `TerminalPanel.tsx` relies on
  xterm's own scrollback handling (likely fine), but the Logs tab's plain list rendering
  wasn't checked for a virtualization strategy · effort: S (to verify), M (to add
  virtualization if missing).
- **low · bundle size / lazy loading · `mermaid` (`Mermaid.tsx`) and `pdfjs-dist`
  (`load-pdfjs.ts`) are already dynamically imported, so they ship as separate lazy chunks.
  `highlight.js` is not: `apps/desktop/src/files/highlight.ts` statically imports
  `highlight.js/lib/core` plus ~30 individual language modules at the top level, so they are
  part of the main bundle for every load, including the LAN-served web build where bundle
  size is explicitly budgeted (`vite.web.config.ts`'s chunk-size-warning comment) · proposed
  fix: dynamic-import the highlight core + language set the same way `Mermaid.tsx` and
  `load-pdfjs.ts` already do, loading only when a code block or the CodeEditor actually
  needs to highlight something · effort: S/M.
- **low · `apps/desktop/src-tauri/src/notify.rs` · a notification click on GNOME Wayland may
  not raise the window.** The `notify` command raises the window with `set_focus` but passes
  no xdg-activation token, so focus-stealing prevention can show a "ready" prompt instead
  and the run's tab opens behind other windows · proposed fix: take the activation token
  the notification server hands back with the click and pass it to the window before
  focusing · effort: M.

## Tests

- **info · oversized test files · `RunDetailPage.test.tsx` (2226 lines), `manifest.test.ts`
  (1495), `runner.test.ts` (1417), `handlers.test.ts` (1012), `FilePreview.test.tsx` (1000)
  — sizes tracking their source files' own size/responsibility spread above, not
  independently a problem. Worth revisiting if/when the corresponding source file is split,
  so the test split follows the same seams · effort: L (only makes sense bundled with the
  source-file splits above).
- **info · tests that only assert on mocks · not audited in this pass (would need a
  file-by-file read of the suites above) — flagging as unverified rather than as a finding ·
  effort: M (audit).

## CLI, scripts, CI, dependencies

- **info · `scripts/package/*.mjs`** (`cli.mjs`, `common.mjs`, `desktop.mjs`,
  `prepare-release.mjs`, `reinstall.mjs`, `smoke.mjs`, `web-resource.mjs`; the sidecar's
  `agent.mjs`, `sea.mjs`, `guard.mjs` and `node-pty-resource.mjs` went in Phase 3) · a dead-script sweep was not completed this pass; a quick read
  suggests every script is wired into an npm script or another script's import, but this
  wasn't verified exhaustively · effort: S (to verify).
- **low · CI/`verify.sh` duplication · `.github/workflows/ci.yml`'s four jobs
  (`test`/`parity`/`desktop`/presumably a Rust check) and `scripts/verify.sh`'s single
  fail-fast chain run the same commands in two places by design (`verify.sh`'s own header
  says so, for a fast local-equivalent gate) — this is intentional duplication, not an
  oversight, but worth a comment cross-referencing the two so a future change to one is
  remembered for the other · effort: S.
- **none · `npm audit`** — 0 vulnerabilities at review time (2026-09-13).
- **none · unused dependencies** — a scan of every workspace's `package.json` against
  actual imports (including dynamic `import()`) found only one: `zod` in
  `apps/desktop/package.json`, which has been removed as part of this review. No others
  found, though the scan did not cover Rust/Cargo dependencies in `src-tauri`.

## Comments

- **info · the plan's comment-density list covered ~39 named files explicitly; a later pass
  did a repo-wide grep sweep for specific history-narration phrases (`used to`, `as before`,
  `unchanged from`, `Phase-`, `Task \d+`, `previously`) and fixed every real hit, but this is
  not the same as the plan's "after those, sweep the rest of the source files with the same
  rules" step** — finding *new* comment-density outliers beyond the original 39 files (the way
  that list was built in the first place) is still not done. A follow-up pass could re-run the
  same density measurement across the full tree and repeat the trim on whatever it finds ·
  effort: M.

## TUI on Windows (manual validation, 2026-10-17)

Found running `whiphand tui` from `main` (8bb3a6a, cross-built for
`x86_64-pc-windows-msvc`) in Windows Terminal and conhost on Windows 11 (build
26200) under QEMU; the run is recorded in `docs/tui-plan.md`, Phase 4.

- **RESOLVED — attach drops `ESC[?9001h` from the session's replay and live output (a split
  sequence included) and writes `?9001l`/`?1004l` on leave; focus reporting is still passed
  on (`update::attach::strip_modes`). The original finding follows.**
- **high · `crates/whiphand-tui/src/runtime/attach.rs` (`write`) +
  `crates/whiphand-tui/src/update/attach.rs` (`on_stdin`) · the detach key never
  fires under ConPTY.** A pseudoconsole's first output is `ESC[?9001h ESC[?1004h`
  (win32-input-mode, focus reporting); attach forwards it verbatim, the TUI's own
  console host takes it as the TUI asking for win32-input-mode, and from then on
  keys reach the attach reader as `ESC[Vk;Sc;Uc;Kd;Cs;Rc_` text. `Ctrl-]` is
  `ESC[221;27;29;1;8;1_`, never the byte `0x1d`, so `on_stdin` passes it to the
  session (it shows as `^]`) and so does the key after it. Seen in Windows
  Terminal and conhost, with the session's console holding only its own
  processes (not the TUI's) · proposed fix: drop `?9001h` (and `?1004h`) from the
  output attach forwards, replay included, and write `?9001l` on leave; a test
  feeds `on_stdin` the win32-input-mode form of `Ctrl-]` · effort: S.
- **RESOLVED — `.cargo/config.toml` links the CRT statically for `x86_64-pc-windows-msvc`, and
  the smoke test fails a Windows binary that imports `VCRUNTIME140.dll`. The original finding
  follows.**
- **high · release packaging (`scripts/package/cli.mjs`, no `.cargo/config.toml`)
  · the Windows CLI needs the VC++ runtime.** `whiphand-windows-x86_64.exe`
  (v0.5.0 too) imports `VCRUNTIME140.dll`; on a clean Windows 11 it exits
  `0xC0000135` with no message at all, even for `--version`. CI's runners have the
  runtime, so nothing there catches it · proposed fix: link the CRT statically for
  `x86_64-pc-windows-msvc` (`-C target-feature=+crt-static`), and check the
  release binary's imports in CI · effort: S.
- **RESOLVED — the TUI asks for 100, says "The ongoing runs could not be read." when the call
  fails, and a test runs `o` against a real agent. The original finding follows.**
- **med · `crates/whiphand-tui/src/update/mod.rs:38` · `o` (ongoing runs in every
  workspace) always fails, on every OS.** It asks `listRecentRuns` for
  `limit: 200`; the agent's schema caps it at 100
  (`crates/whiphand-agent/src/schema.rs:587`), so the call is refused and the view
  says "Nothing is running in any recent workspace" under the error · proposed
  fix: ask for 100, and say the list could not be read when the call fails ·
  effort: S.
- **RESOLVED — on Windows, keys already waiting behind a key are read in one go, and a burst
  with a line break and no chord is one paste (`runtime::paste::from_burst`), which goes into
  the field being edited whole or is dropped. The original finding follows.**
- **med · `crates/whiphand-tui` paste on Windows · the rest of a multi-line paste
  runs as keys.** The recorded gap is that a paste into a one-line prompt
  submits at its first line break; after that, the remaining lines reach the
  screen behind as commands (`second line` opened the ongoing view and the
  new-run form; `c` or `x` would cancel or delete) · proposed fix: while a
  prompt that a paste submitted is closing, drop key events that arrive within
  the same read, or treat a burst of key events containing Enter as a paste ·
  effort: M.
- **RESOLVED — the spawned step has the found shell's directory first on `PATH` (not one the
  step names in `shell:`); the smoke run's command is `uname`. The original finding follows.**
- **low · command steps on Windows run Git's `sh.exe` without `usr\bin` on PATH**
  (`crates/whiphand-core/src/process/shell.rs`), so `uname`, `seq`, `sleep` and the
  rest of Git's coreutils are "command not found" unless the user's PATH has them;
  `doctor` says command steps "run through …/usr/bin/sh.exe", which suggests they
  would · proposed fix: prepend the shell's own directory to the step's PATH, or
  say in `doctor` and the docs that only builtins are guaranteed · effort: S.
- **RESOLVED — the TUI sends its title again when it takes the screen back (when it sets one
  at all: notifications on). The original finding follows.**
- **low · attach leaves the session's title on the terminal.** After a session
  the tab or window keeps the session's title (`C:\WINDOWS\system32\cmd.exe`)
  instead of `whiphand` · proposed fix: set the TUI's title again on leave ·
  effort: S.
