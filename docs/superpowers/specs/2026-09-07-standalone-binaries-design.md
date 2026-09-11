# Standalone Ubuntu binaries for `mc` and the desktop app

**Status:** implemented
**Date:** 2026-09-07

## Problem

Every artifact this repo produces today runs only from a checkout. `mc` is
`packages/cli/src/main.ts` behind a `bin` entry, executed by the workspace's Node with
native type stripping; the desktop app is `npm run tauri dev`, whose webview spawns
`node <abs path>/packages/agent/src/main.ts` — a path baked in at build time by
`apps/desktop/vite.config.ts:14` and re-asserted as a regex in
`src-tauri/capabilities/default.json`. Neither survives being copied to another machine,
and `docs/design.md` records distribution packaging as deliberately out of scope.

The operator wants two things they can copy somewhere and run:

1. `mc` — a single file, no Node, no `npm install`, no repo.
2. The desktop app as a normal Ubuntu install (`.deb`) and as a portable `.AppImage`.

And an `npm run` entry point for each, so producing them is repeatable rather than a
remembered incantation.

## Non-goals

- **Cross-distro portability.** Decided: build natively. This machine is Ubuntu 26.04
  with glibc 2.43; everything produced here links against it and will not run on 24.04 or
  22.04. Widening that later means building in an older-glibc container, which changes
  only *where* these scripts run, not what they do.
- **Cross-compilation** to macOS or Windows. The scripts stay Linux-only until asked.
- **Signing, notarization, apt repositories, auto-update.** Out of scope.
- **Shipping the runner CLIs.** `claude` and `copilot` remain runtime prerequisites the
  operator installs; `mc doctor` already reports their absence, and that report is the
  contract. A standalone `mc` on a bare machine is expected to fail `doctor` loudly.

## What the codebase already gets right

The audit for this design found the bundling hazards absent, which is why this is a build
concern and not a refactor:

- No `import.meta.url`, `import.meta.dirname`, `__dirname`, `createRequire`, or runtime
  `require()` anywhere in `packages/*/src`.
- Nothing reads `package.json` at runtime; `mc --version` prints the `CORE_VERSION`
  constant (`packages/cli/src/program.ts:16`).
- The only two dynamic imports (`packages/core/src/engine/runner.ts:670`, `:675`) take
  static string literals, so a bundler resolves them statically.
- `node-pty` is imported in exactly one non-test file, `packages/agent/src/pty.ts:7`.
  Core never spawns interactive steps — the TTY seam — so the CLI's dependency graph is
  pure JavaScript: `zod`, `yaml`, `commander`.

That last point splits the work cleanly. The CLI binary is routine. The agent binary is
not, for one reason, addressed in its own section below.

## Architecture

Three build artifacts from one mechanism:

```
packages/cli/src/main.ts   --esbuild-->  cli.cjs   --SEA-->  dist/mc
packages/agent/src/main.ts --esbuild-->  agent.cjs --SEA-->  dist/mc-agent-x86_64-unknown-linux-gnu
                                                                    |
                                                       Tauri externalBin
                                                                    v
apps/desktop  --vite--> dist/  --tauri build-->  *.deb  +  *.AppImage
```

Both binaries are produced the same way — esbuild to a single CommonJS file, then Node's
Single Executable Application blob injected into a copy of the `node` binary. The desktop
bundle is produced by Tauri's own bundler; this design does not reimplement any part of
it, it only hands it a sidecar binary and corrects the two places that assume a repo
checkout.

New directory `scripts/package/`, holding the build scripts. Output to `dist/` at the
repo root, which `.gitignore` gains — it currently ignores only `apps/*/dist/`. The
generated `src-tauri/binaries/` is ignored too.

## Part 1 — Bundling

One esbuild invocation per entry point, with shared options:

```
platform: 'node', target: 'node24', format: 'cjs', bundle: true,
banner: { js: '#!/usr/bin/env node' }   // CLI only, harmless in a SEA
```

`format: 'cjs'` is not a preference. **Node's SEA main script must be CommonJS** — an ESM
main is rejected at build time. The source stays ESM-with-`.ts`-extensions exactly as it
is; esbuild resolves `./foo.ts` specifiers and converts. Nothing in `tsconfig.json`
changes, and `erasableSyntaxOnly` already guarantees the syntax esbuild can strip.

esbuild and postject join the repo as root `devDependencies` — pinned, not fetched by
`npx` at build time, so packaging works offline and reproducibly. They are the only new
dependencies this design adds, and neither is reachable from any shipped code path.

`packages/agent`'s bundle marks nothing external **except** the `node-pty` native addon
(Part 3). `packages/cli`'s bundle marks nothing external at all.

## Part 2 — Single Executable Application

Per binary:

1. Write a `sea-config.json` (`main`, `output`, `disableExperimentalSEAWarning: true`,
   `useCodeCache: true`, plus `assets` for the agent).
2. `node --experimental-sea-config <config>` → a `.blob`.
3. `cp $(command -v node) dist/<name>` — a copy of *this* machine's Node 24.16.0, which
   `process.config.variables.node_shared === false` confirms is a static build and
   therefore injectable.
4. `postject dist/<name> NODE_SEA_BLOB <blob> --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`

No code signing step exists on Linux. Expect ~110 MB per binary; that is the Node runtime,
not the application.

### Top-level await must go

**Discovered during implementation; this is a required source change, not a build flag.**
CommonJS has no top-level await, and both entry points used one. esbuild refuses the
bundle outright, so:

- `packages/cli/src/main.ts` becomes `parseAsync(...).catch(...)`. The catch is not
  decoration — it replaces what the unhandled-rejection path used to do for free, and
  keeps the same user-visible outcome (stack on stderr, exit 1).
- `packages/agent/src/main.ts` moves its startup into an `async function main()`. The
  await it contains is load-bearing — the retention migration must complete before the
  dispatcher exists and stdin is read, or a `configGet` racing startup has a real window —
  so the readline setup and its `close` handler move inside `main()` with it. The ordering
  the top-level await enforced implicitly is now structural. Signal and process handlers
  stay at the top level; they depend on nothing awaited.

`packages/agent/src/main.test.ts` spawns the real entry point, so the agent restructure is
covered by tests that already existed.

### argv needs no correction

An earlier draft of this design asserted that a SEA has no script path in `process.argv`,
so commander's default `from: 'node'` slice of two would swallow the subcommand. **That is
wrong**, and a probe SEA settled it:

```
$ ./probe-bin run build.yaml --flag
argv: ["/abs/path/probe-bin", "./probe-bin", "run", "build.yaml", "--flag"]
```

Node supplies both leading entries — resolved executable, then argv0 as invoked — exactly
as it does for `node script.js`. Commander is already correct, and `mc run --dry-run` in
the smoke tests is what keeps it honest, `run` being precisely the token a broken argv path
would eat. The normalization written against the wrong assumption was deleted rather than
kept as a harmless no-op.

## Part 3 — `node-pty` inside a single file

This is the one part that is not mechanical, and the only place the plan should expect
surprises.

`node-pty` is a JavaScript wrapper around `build/Release/pty.node`, a compiled addon. A
SEA cannot `dlopen` a file that exists only inside itself: the loader needs a real path on
a real filesystem. Three options were considered.

**Chosen: embed as an SEA asset, extract once, `process.dlopen` it.** The addon is
declared in `sea-config.json`'s `assets`, retrieved at startup with
`sea.getRawAsset('pty.node')`, written to
`~/.cache/mission-control/pty-<sha256-prefix>.node` if not already there, and loaded. An
esbuild plugin rewrites node-pty's `require` of the `.node` file to this shim, leaving
node-pty's own JavaScript bundled normally. Content-addressed by hash so a rebuilt agent
never reuses a stale addon, and so two versions can coexist.

*Rejected — ship `pty.node` beside the binary.* Loses the single-file property for the
standalone case, and inside a Tauri bundle the sidecar and the resource directory are not
siblings, so it needs a second, different lookup anyway.

*Rejected — leave the agent unbundled (node + `node_modules` in a directory).* Tauri's
`externalBin` ships one executable file, so this needs a wrapper script and a resource
tree; it trades a contained problem for a diffuse one.

**This was the first task, and it was a spike.** It passed: a throwaway SEA embedding
`pty.node` spawned `bash`, read `hello-from-pty` off the pty and observed exit code 7,
with the addon extracted to the cache path as designed. The fallback (ship the addon
beside the binary, look it up via Tauri's `resource_dir`) was not needed.

## Part 4 — Teaching the desktop app it has no repo

Two files assume a checkout, and one gains a build-time switch.

**`apps/desktop/vite.config.ts`** — today it defines `__AGENT_ENTRY_PATH__` as an absolute
dev-machine path. It gains a second define, `__AGENT_SPAWN_MODE__`, which is `'node'`
during `tauri dev` and `'sidecar'` when `MC_PACKAGE=1` is set by the packaging script. The
absolute path stays, and stays meaningless in the packaged build.

**`apps/desktop/src/agent/tauri-transport.ts`** — `start()` branches on that constant:

```ts
const command = __AGENT_SPAWN_MODE__ === 'sidecar'
  ? Command.sidecar('binaries/mc-agent', [], { env: {} })
  : Command.create('run-agent-sidecar', [__AGENT_ENTRY_PATH__], { env: {} });
```

Everything below the spawn — the newline framing, the stdout/stderr split, the close and
error handlers — is untouched. The sidecar speaks the identical NDJSON protocol on the
identical stdio, because it is the same `main.ts`.

**`src-tauri/capabilities/default.json`** — gains a second scope entry alongside the
existing path-validated `node` one:

```json
{ "name": "binaries/mc-agent", "sidecar": true, "args": [] }
```

Both entries ship in both builds, but the dev one is unreachable rather than merely
inert. `__AGENT_SPAWN_MODE__` is a compile-time constant, so vite folds the branch away:
the packaged `index-*.js` was checked and contains **no** occurrence of
`run-agent-sidecar` and **no** repo path. What remains in the capability manifest is a
permission no shipped code can exercise, against a `node` binary and a
`packages/agent/src/main.ts` that do not exist on an installed machine.

Tightening it further — a release-only capability file merged via `tauri build --config` —
is a follow-on, not done now; it would remove a manifest entry, not an attack path.

**`src-tauri/tauri.conf.json`** — `bundle.externalBin: ["binaries/mc-agent"]`. Tauri
appends the target triple, so the packaging script must produce
`src-tauri/binaries/mc-agent-x86_64-unknown-linux-gnu`. `bundle.targets` becomes
`["deb", "appimage"]` rather than `"all"`, so a missing rpm toolchain cannot fail the
build.

The `.AppImage` is the portable artifact — one file, marked executable, runnable from
anywhere. The `.deb` is the install.

## Part 5 — Scripts

`scripts/package/` contains `build-sea.mjs` (the shared bundle → blob → postject
pipeline, parameterized by entry point), `cli.mjs`, `agent.mjs`, and `desktop.mjs`. Node
scripts rather than bash, because they compute paths, hash the addon, and shell out to
esbuild's API — the same reasoning `scripts/verify.sh` uses in reverse.

Root `package.json`:

```json
"package:cli":     "node scripts/package/cli.mjs",
"package:agent":   "node scripts/package/agent.mjs",
"package:desktop": "node scripts/package/desktop.mjs",
"package":         "npm run package:cli && npm run package:desktop"
```

`package:desktop` depends on `package:agent` and invokes it first — copying the result to
`src-tauri/binaries/` with the triple suffix — then runs `tauri build` with `MC_PACKAGE=1`
in the environment. It resolves the triple from `rustc -vV` rather than hardcoding
`x86_64-unknown-linux-gnu`, so an arm64 machine is not a silent failure.

Final artifacts land in `dist/`:

```
dist/mc
dist/mission-control_0.1.0_amd64.deb
dist/Mission Control_0.1.0_amd64.AppImage
```

## Testing

The unit-testable surface here is thin and the operational surface is thick, so the
verification is mostly smoke tests that the packaging scripts run themselves and fail on:

- **`mc --version`** prints `CORE_VERSION` — proves the SEA boots.
- **`mc run --dry-run <fixture>`** against `scripts/package/fixtures/smoke.yaml`, in a
  temp workspace, resolves an agent step and a command step and exits 0 — proves the
  bundle carries core, zod and yaml, that inputs interpolate, and that argv survives.
- **`mc doctor`** reports on the runner CLIs rather than crashing (a non-zero exit when
  one is missing is a valid outcome, and the assertion allows it).
- **agent binary**: write one NDJSON request to its stdin, assert one well-formed
  response on stdout, and — the point of Part 3 — a request that opens a pty.
These live in `scripts/package/smoke.mjs` and run automatically at the end of each
packaging script, so a broken binary cannot be produced silently.

`scripts/verify.sh` is **not** extended. A ~4-minute packaging run does not belong in the
gate that guards every commit; packaging is verified when packaging is run.

What cannot be verified here remains the standing limitation recorded in
`docs/design.md`: the desktop app has never been executed against a real webview on this
machine, because VS Code's snap glibc breaks the Tauri binary's dynamic linking. **A
packaged `.deb` or `.AppImage` sidesteps that specific problem** — it carries no snap
environment — so the first genuine end-to-end run of the desktop app may well be an
installed one, launched by the operator from a normal terminal.

## Risks

- **SEA is experimental.** The `--experimental-sea-config` flag and the postject fuse are
  stable in practice across Node 20–24, but a Node upgrade could move them. Mitigated by
  pinning nothing and failing loudly: the smoke tests catch a broken binary immediately.
- **Part 3 may not hold.** Covered above; it is the first task and it is a spike.
- **`useCodeCache: true`** is a startup optimization that has historically interacted
  badly with some bundles. If the blob build complains, drop it — it costs startup
  milliseconds, nothing else.
- **Binary size.** ~110 MB each, ~220 MB before the desktop bundle compresses. Expected,
  not fixable without abandoning SEA.

## Follow-ons, deliberately not done

- Release-only capability file, dropping the dev `node` spawn scope from shipped bundles.
- An older-glibc container build for Ubuntu 22.04/24.04 reach.
- `mc` shell completions and a man page in the `.deb`.
- Auto-update, signing, an apt repo.
