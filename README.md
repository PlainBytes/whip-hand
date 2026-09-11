# Whiphand (`whiphand`)

<img src="apps/desktop/src-tauri/icons/source.png" alt="" width="96" align="right" />

`whiphand` runs **workflows** against a working folder: an ordered set of steps — an LLM CLI runner
(`claude`, `copilot`) with its own model and tool policy, a shell command, or a stop to ask
a human — which can be wrapped in a **cycle** that repeats until a check passes. The
canonical workflow plans a feature interactively with one model, then implements, tests and
reviews it in a loop until the review comes back clean.

## Install

Requires Node ≥ 24 (runs TypeScript natively — no build step) and at least one of
`claude` / `copilot` on PATH.

```bash
npm install
node packages/cli/src/main.ts --help    # or: npm link --workspace packages/cli && whiphand --help
```

## Quickstart

```bash
whiphand doctor                                                              # check the tools whiphand needs are installed
whiphand init                                                                # scaffold .whiphand/ (config + starter workflows) here
whiphand new-workflow review-pr                                              # scaffold .whiphand/workflows/review-pr.yaml
whiphand run examples/cycle.yaml --dry-run --input feature=demo              # print every argv, spend nothing
whiphand run examples/feature.yaml --input feature="oauth support"           # the real thing
whiphand run examples/cycle.yaml --input feature=x --max-iterations 5 --yes  # override the loop budget; don't ask
whiphand run feature --input feature="oauth support" --name "OAuth support"  # label the run
whiphand run feature --input feature="fix login" --attach ./bug.png --attach ./server.log  # hand files to the plan step
whiphand rename-run 20260907-141233-a3f1 "Something better"                  # relabel it later ('' clears)
```

Workflows live in `.whiphand/workflows/<name>.yaml` (so `whiphand run feature` works) or anywhere as a
path. Artifacts land in `.whiphand/runs/<run-id>/` as plain markdown. Workspace defaults live in
`.whiphand/config.yaml`.

## Checking your setup (`whiphand doctor`)

`whiphand doctor` reports what this machine has, in two groups — the same data the desktop's
Doctor page renders, so the two can never disagree:

```
AI harnesses
✔ claude 2.1.263
✔ copilot 1.0.83
  · copilot will not signal when it needs you; set "beep": true in ~/.copilot/config.json
○ codex not installed [detect only]

Support tools
✔ git 2.53.0
✔ node 24.16.0
○ fd not installed
```

`✔` installed · `✘` missing and required · `○` missing but optional. `[detect only]`
marks a harness whiphand can see but has no adapter for — it will not be offered as a
workflow's `runner:`.

### Adding your own tools

Doctor's built-in table lives in `packages/core/src/tools.ts`. To extend it on your own
machine, hand-write `doctor.yaml` beside your global `config.yaml`:

| Platform | Path |
|---|---|
| Linux | `~/.config/whiphand/doctor.yaml` |
| macOS | `~/Library/Application Support/whiphand/doctor.yaml` |
| Windows | `%APPDATA%\whiphand\doctor.yaml` |

(`WHIPHAND_CONFIG_HOME` overrides the directory.)

> Upgrading from before the rename? These directories used to be called
> `mission-control`, and briefly `whip-hand`. The first run of `whiphand` or of the
> desktop app moves either across —
> global workflows, `config.yaml` and the remote-access token come with them, so the
> browser links you have already handed out keep working. Setting any of
> `WHIPHAND_CONFIG_HOME`, `WHIPHAND_APP_STATE_FILE` or `WHIPHAND_REMOTE_CONFIG_FILE` suppresses the move.

```yaml
tools:
  - id: bun                # a new id is appended to its group
    label: Bun
    group: support         # 'harness' or 'support'
    argv: [bun, --version]
    url: https://bun.sh

  - id: rtk                # an existing id REPLACES that built-in, in place
    label: rtk
    group: support
    argv: [rtk, --version]
    version_pattern: 'v?(\d+\.\d+\.\d+)'   # capture group 1 is the version
    optional: false        # missing is then an error, not a shrug
    aliases: [rtk-bin]     # other binary names to try, in order

hide: [cursor-agent, jq]   # drop built-ins you do not care about
```

Every key is validated and unknown ones are rejected, so a typo tells you rather than
silently doing nothing. Overriding a built-in changes its label, group, url and
`optional`, but detection for `claude` and `copilot` always goes through their adapters
— that is where their setup advice comes from.

It is a **separate file from `config.yaml` on purpose**: `config.yaml` is rewritten
wholesale whenever settings are saved, so anything unrecognized in it would be lost.
Nothing writes `doctor.yaml`.

## Run names

A run is identified by its minted id (`20260907-141233-a3f1`), which never changes. On top
of that it can carry a **name** — set with `--name`, in the desktop app's New run dialog,
or afterwards with `whiphand rename-run` and the Rename button — shown instead of the id in the
runs grid, the run page and OS notifications. Turn on `runs.auto_name` to have the default
runner suggest one for runs started without it.

Steps see the run's identity as `{{ run.name }}` / `{{ run.slug }}` / `{{ run.id }}` in
prompts, manual titles, and a command step's `run:` and `cwd:` — and as `$WHIPHAND_RUN_NAME` /
`$WHIPHAND_RUN_SLUG` / `$WHIPHAND_RUN_ID` in a command step's shell, which is the safer of the two for
a shell line. `run.slug` is git-ref safe, which is what makes per-run worktrees a
three-line `command` step:

```yaml
  - id: worktree
    kind: command
    run: git worktree add -b "whiphand/$WHIPHAND_RUN_SLUG" "../wt-$WHIPHAND_RUN_SLUG"
    output: worktree.log
```

See `docs/design.md` for the details, including why the name is a marker file rather than a
manifest field.

`whiphand init` ships three workflows: `feature` plans once, interactively, then implements and
reviews in a cycle — pick it when the shape of the change is already clear. `spec-driven`
adds a second planning phase and grills you on both, then stops at an approval gate before
any code is written — pick it for anything where getting the "what" or the "how" wrong is
expensive to discover downstream. `feature-development` does the same as `feature` but on
its own branch — it syncs your trunk, cuts `feature/<run slug>`, and commits the signed-off
work with a message it writes from the diff.

## Workflow format

See `docs/design.md` for the full reference. The short version:

```yaml
name: cycle
inputs:
  feature: { required: true }
steps:
  - id: plan          # live terminal chat; artifact harvested from the session afterwards
    runner: claude
    model: opus
    mode: interactive
    writes: false
    output: plan.md
    prompt: |
      We are planning: {{ inputs.feature }}. Work with me on a plan. Do not modify files.

  - id: fix-cycle     # repeat the body until `review` returns VERDICT: PASS
    kind: loop
    until: review
    max_iterations: 3
    steps:
      - id: execute   # headless; may write
        runner: copilot
        model: gpt-5.5
        mode: headless
        writes: true
        inputs: [plan, review]   # `review` is later in the body => previous iteration
        output: execute-report.md
        prompt: Implement the attached plan.

      - id: tests     # a shell command: no runner, no tokens
        kind: command
        run: npm test
        verdict: true            # non-zero exit sends the loop round again
        output: tests.log

      - id: review    # headless, read-only, must emit VERDICT: PASS|FAIL
        runner: claude
        model: haiku
        mode: headless
        writes: false
        verdict: true
        inputs: [plan, execute, tests]
        output: findings.md
        prompt: Review the diff against the plan.

  - id: sign-off      # stops and asks you, showing the diff
    kind: approval
    title: Ship it?
    instructions: Check the diff and the findings before this goes out.
    show_diff: true
    inputs: [review]
```

**Step kinds.** `agent` (the default, and what every step used to be — workflows written
before kinds existed still work), `command`, `manual`, `approval`, and `loop`.

**Verdicts.** `verdict: true` makes a step report pass/fail instead of failing the run: an
agent's `VERDICT:` line, a command's exit code, or a human's answer. That is what a loop's
`until` watches.

**Cycles.** A `kind: loop` step repeats its body until the `until` step passes, bounded by
`max_iterations`. Each iteration keeps its own artifacts under
`.whiphand/runs/<run-id>/<loop-id>/iter-<n>/`, so nothing overwrites the previous attempt.
Inside a loop body, referencing a *later* step means "that step's artifact from the
previous iteration" — which is how review findings feed back into the next attempt.

**Human steps.** `manual` and `approval` stop the run and ask. On a terminal `whiphand` prompts
you; without one it fails naming the step, unless you pass `--yes` to take the step's
default.

The desktop app gives the decision the whole page: a review screen listing what to look at
down one side and showing it large on the other, with the choices along the bottom. With
`show_diff: true` you get the working tree file by file, side by side — including files the
run just created, which the terminal's `git diff HEAD` never showed. Each `inputs:` entry
becomes its own rail entry, so `inputs: [review, plan]` puts the findings and the plan a
click away from the button you are about to press.

**Sending work back.** `capture: review` (in place of `capture: note`) turns that same screen
into a place to leave feedback: one box for the whole change set, plus a comment under each
file in the diff. Put the step inside a `kind: loop` with `until:` pointing at it and `retry`
becomes available alongside `continue`/`abort` — approving ships, retrying writes the
comments to the step's `output` and sends the run round the loop again, so the next
`execute` (add it to that step's `inputs:`) reads exactly what needs to change. Outside a
loop, or without `show_diff: true`, the step still runs — `whiphand run` warns on stderr,
since each is a step that degrades rather than one that is wrong.

**Attachments.** `--attach <path>` (repeatable) copies a file into the run before step
one — a screenshot, a log, a HAR trace — and a step receives every attached file by naming
the reserved ref in its inputs: `inputs: [attachments]`. Relative paths resolve against
your shell's directory, not `-C`. Attaching files to a workflow where no enabled step reads
`attachments` is refused with the fix, as is a missing, unreadable or oversized file
(`runs.max_attachment_mb`, 25 by default) — all before a run directory exists, exit 2. With
nothing attached the ref is simply dropped, so a workflow that *can* read attachments never
needs them. A `command` step finds them in `"$WHIPHAND_RUN_DIR/attachments"`. In the
desktop's New run dialog, add files with the picker, drop them on the dialog, or paste an
image. The workflows in `examples/` read attachments on their plan step.

## When the review fails (`on_findings`)

For a `verdict` step that is **not** inside a `kind: loop`. Configured in
`.whiphand/config.yaml` (workflows may override):

- `report` (default) — write the findings, end the run.
- `loop` — re-run the last writing step with the findings injected, up to
  `loop.max_iterations` times. This is the older, inferred form of a cycle; an explicit
  `kind: loop` says the same thing in the workflow, per cycle.
- `interactive` — drop you into a live session with the findings preloaded.

A verdict step *inside* a loop is governed by that loop instead; its `on_exhausted` takes
the same `report` / `interactive` values for what happens when the budget runs out.

## Desktop app

`apps/desktop` is a Tauri + Fluent UI shell over the same `@whiphand/core` engine the CLI
uses — workflows, runs, and cancellation behave identically in both; the desktop app
just adds a GUI (workflow picker, live run view, xterm-backed interactive handoff, and a
Files tab: a tree of the opened workspace with rendered-markdown preview and in-place
editing).

The sidebar is grouped by scope: a workspace switcher on top, then the pages that act
on the open workspace (Runs, Workflows, Files, Settings), then the ones that don't
(Activity, Doctor, Preferences). Activity lists runs across every recent workspace;
workspaces can be pinned, and Ctrl/Cmd+K switches between them.

The Files tab reaches the filesystem through Tauri's fs plugin, whose scope
starts empty and is extended at runtime to directories you explicitly open, pick in a
folder dialog, or drop on the window; the agent's RPC surface has no file methods.

Prerequisites: Node ≥ 24, a Rust toolchain (`cargo`), and on Linux the webkit2gtk
dev packages (`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
librsvg2-dev`).

```bash
npm run tauri dev -w desktop   # launch the desktop app in dev mode
npm run verify                 # local CI-equivalent gate — see below
```

`npm run verify` runs the same checks as CI in one fail-fast chain: root
typecheck/tests, the CLI/desktop parity suite (`npm run test:parity` — verifies the
desktop app's surface and behavior match the CLI, see `parity/`), the desktop app's
own tests and build, and finally `cargo check` against `apps/desktop/src-tauri`. If
`cargo` isn't installed, that last step is skipped with a warning instead of failing.

**Wayland troubleshooting**: if the desktop window opens with a blank webview under
Wayland/webkitgtk, set `WEBKIT_DISABLE_COMPOSITING_MODE=1` and
`WEBKIT_DISABLE_DMABUF_RENDERER=1` in the environment before launching.

### Remote access (browser, LAN only)

The desktop app can serve the same UI to a browser on another computer on your
network, so you can watch a run, read its logs and diff, answer an approval, or
start and cancel work from a laptop in another room. Turn it on in
**Preferences → Remote access**, then open the URL it shows (or scan the QR code).

> **Read this before turning it on.**
>
> - **Anyone with the link can run commands on the host machine.** That is what
>   Whiphand does: `startRun` executes a workflow, `ptyInput` types into a live
>   session, and the browser can edit workflow YAML — which *is* the list of commands
>   to run. Treat the link exactly as you would an open terminal on that machine.
> - **The connection is plain HTTP, with no TLS.** The token and everything the run
>   prints cross the network in the clear. Anyone who can capture your network traffic
>   — shared Wi-Fi without client isolation, a compromised device on the LAN — gets the
>   token, and with it the machine.
>
> Use it on a network you control. It is off by default and stays off until you
> explicitly enable it.

How it works: the agent sidecar the desktop app already runs also listens on a TCP
port (61338 by default), serving the browser bundle over HTTP and the same NDJSON
JSON-RPC protocol over a WebSocket. Access is gated on a 256-bit token carried in the
URL fragment — never sent to the server, so it stays out of access logs — and stored
per-origin in the browser. Because a WebSocket upgrade is not subject to CORS, the
agent additionally validates the `Host` and `Origin` headers on every request, which
is what stops a DNS-rebinding attack from a page you visit elsewhere. Rotating the
token disconnects every device using the old link.

Two differences from the desktop app:

- **No Files tab.** Browsing the workspace reads the local disk directly, which a
  browser on another machine cannot do. Run artifacts and diffs still work, because
  those go through the agent's RPC rather than the filesystem.
- **No folder picker.** Recent workspaces are one click away; anything else is opened
  by typing its path.

Runs already in progress replay in full when a browser attaches — the agent keeps a
per-job transcript of terminal and log output, so checking in halfway through a run
shows what already happened rather than an empty pane.

## Standalone binaries

Both artifacts can be built as self-contained executables that need no repo, no
`npm install`, and no Node on the target machine.

```bash
npm run package:cli       # dist/whiphand (dist/whiphand.exe on Windows) — the CLI as one file
npm run package:desktop   # dist/*.deb + dist/*.AppImage on Linux, an NSIS installer on Windows
npm run package           # both
```

`dist/whiphand` is an esbuild bundle injected into a copy of this machine's Node binary
(a [single executable application](https://nodejs.org/api/single-executable-applications.html)),
so it is ~120 MB — that is the Node runtime, not the app. Copy it anywhere on PATH and
run `whiphand` as usual. `claude` / `copilot` are still runtime prerequisites; `whiphand doctor`
reports them, along with everything else this machine needs.

`npm run package:desktop` builds the `@whiphand/agent` sidecar the same way, hands it to
Tauri's bundler as an `externalBin`, and produces a `.deb` to install and an
`.AppImage` to run from anywhere. Each packaging script finishes by smoke-testing what
it built (`scripts/package/smoke.mjs`), so a broken binary is not produced silently.

**These are built natively and link this machine's glibc**, so they run on the Ubuntu
release that built them, not on older ones. Building for wider reach means building in
an older-glibc container. Design notes:
`docs/superpowers/specs/2026-09-07-standalone-binaries-design.md`.

**Releases and auto-update.** Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`,
which publishes a GitHub Release carrying the CLI and desktop artifacts for both platforms,
`latest.json` for Tauri's updater, and a `SHA256SUMS` file covering every asset. The release
notes are generated by GitHub from the commits since the previous tag. Only the `.AppImage`
and the Windows NSIS installer self-update; the `.deb` prompts with a link to the release
page instead, since Tauri's updater cannot install into a `.deb`.

**Before the first release, an operator has to do two things.** Neither can be done by CI
or from inside this repo, and `release.yml`'s `guard` job (`node scripts/version.mjs
--check-release`) refuses to build a tag while the first is outstanding.

1. **Generate the updater signing key**, on your own machine:

   ```bash
   npx @tauri-apps/cli signer generate -w ~/.tauri/whiphand-updater.key
   ```

   > **Back the private key up somewhere outside GitHub before going further.** Tauri's
   > updater only accepts a manifest signed by the key matching the `pubkey` compiled into
   > the installed app. If the private key is lost, every copy already out there is
   > permanently unable to auto-update — there is no recovery path short of every user
   > reinstalling by hand.

2. **Put the key into the repo and the CI secrets.** The *public* key is committed: paste it
   into `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json`, replacing
   `REPLACE_WITH_OPERATOR_GENERATED_PUBKEY`. The private key and its password become
   repository secrets named `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, which `release.yml` passes to `tauri-action`.

The release URLs are already resolved, in the two places they are written — the
`plugins.updater.endpoints` entry in `tauri.conf.json`, and `RELEASE_PAGE_URL` in
`apps/desktop/src/lib/updater.ts`. Both point at `PlainBytes/whip-hand`. **If the repo
moves to another owner, update both by hand.** GitHub redirects the old slug, so nothing
breaks the day of the move and nothing tells you the values are stale either. The endpoint
is the one already-installed copies poll, so letting it rot is how a release quietly stops
reaching anyone; the `RELEASE_PAGE_URL` is the link a `.deb` user is sent to, so a stale one
404s for exactly the people who cannot self-update.

`createUpdaterArtifacts` is passed by `release.yml` rather than set in `tauri.conf.json` on
purpose: set globally it would make every `tauri build` demand the signing key, including
local `npm run package` and CI's own packaging job, neither of which should need it just to
prove the bundle still builds.

**Windows downloads are unsigned.** There is no code-signing certificate yet — the seam for
one exists (`WHIPHAND_SIGN_COMMAND` for `whiphand.exe`, Tauri's `bundle.windows.signCommand` for the
installer) but is unset. Expect Windows SmartScreen's "Windows protected your PC" prompt on
first run, and don't be surprised if antivirus software flags either binary: a ~110 MB
`postject`-modified `node.exe` and an installer with no publisher signature are both shapes
heuristic scanners dislike. Neither is a defect in the build; both go away once a real
certificate is in place.

## Docs

- `docs/research.md` — why this exists and why we didn't adopt Comanda/Archon.
- `docs/design.md` — architecture: the TTY seam, adapters, the interactive harvest.
- `docs/implementation-plan.md` — the task-by-task build plan this was built from.
