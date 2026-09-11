# Run Detail: sticky chrome and tabbed panels

**Status**: approved design, not yet implemented
**Date**: 2026-09-05
**Scope**: `apps/desktop`, `packages/agent`

## Goal

Give a running workflow — especially an interactive one — the vertical space it needs.
Today `RunDetailPage` is one long scrolling column: the terminal is a fixed 320 px box
somewhere in the middle of it, and the run's identity and step progress scroll away above
it exactly when you are watching the run.

After this change the page is a fixed-height frame. Run identity, step progress and any
pending human decision stay pinned; Terminal, Artifacts and Logs become horizontal tabs
sharing one large panel that fills whatever is left of the window.

## Constraints

- **One layout for every run**, live or historical. No separate view for finished runs.
- **The Artifacts tab reuses the Files zone.** `FileTree` and `FilePreview` are used as-is,
  not forked or reimplemented, so later improvements to the Files page reach artifacts for
  free and the two read consistently.
- **The artifact door stays narrow.** Artifact I/O keeps going through the agent rather than
  the webview's fs plugin (see *Why not the fs plugin* below).
- **Parity is unaffected.** `parity/surface.test.ts` maps CLI commands to UI elements. The
  new RPC has no CLI counterpart and needs no `uiActions` entry.

## Decisions

| Question | Decision |
|---|---|
| Page scrolling | Fixed-height flex column; the page never scrolls, the active panel does |
| Header | Moves into the existing `PageHeader` (sticky) |
| Long stepper | Keeps wrapping, gains a chevron that collapses it to the current step |
| Collapse state | Session-only, not persisted to disk |
| Tab set | Terminal, Artifacts, Logs |
| Default tab | Logs; `ptyStarted` auto-selects Terminal unless the user already chose a tab |
| Terminal with no PTY | Tab always present, showing an empty state |
| Inactive panels | Stay mounted, hidden with `display: none` |
| Manual decision card | Its own band above the tab bar, visible from every tab |
| Artifacts pane | `FileTree` + `FilePreview`, i.e. the Files zone |
| Artifact editing | Editable, via a new `writeArtifact` RPC |
| Binary artifacts | Out of scope; deferred with the rest of the binary work |

### Why not the fs plugin

`2026-09-04-file-explorer-design.md` routed the Files page through `@tauri-apps/plugin-fs`
rather than the agent, reasoning that widening `readArtifact` into a general workspace file
server "would put a desktop UI concern inside the engine's protocol". Artifacts are the
other side of that same line: they are the engine's own output, addressed by run id and
name, and `readArtifact` already exists precisely to serve them. Adding a symmetric
`writeArtifact` keeps that door narrow — it is still name-based lookup against one run's
directory listing, not a file server — so the earlier decision holds rather than being
reversed.

Reading artifacts off disk through the fs plugin would have been less work and would have
given `FilePreview` real `stat()` for free. It was rejected because it retires the realpath
containment and size cap in `handlers.ts` for the one view that has them.

## Layout

```
┌──────────────────────────────────────────────────────────┐
│ ← Runs   Run 20260905-1432   ●running   your turn        │ PageHeader
│          Step 3 of 7 · execute       [End session] [✕]   │  (sticky)
├──────────────────────────────────────────────────────────┤
│ ①seed ─ ②plan ─ ③execute ─ ④review                    ⌃ │ stepper strip
│ ─ ⑤report ─ ⑥verify ─ ⑦publish                          │ (collapsible)
├──────────────────────────────────────────────────────────┤
│ ⚠ Approve the plan?                        [Yes]  [No]   │ only when parked
├──────────────────────────────────────────────────────────┤
│  [ Terminal • ]  [ Artifacts 3 ]  [ Logs ]               │ TabList
├──────────────────────────────────────────────────────────┤
│                                                          │
│                 active panel — flex: 1                   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

`RunDetailPage` becomes `height: 100%; display: flex; flex-direction: column; min-height: 0`
— the same shape `FilesPage` already uses inside `App.tsx`'s scrolling `<main>`. Header,
stepper, manual band and tab bar are `flexShrink: 0`; the panel is `flex: 1; min-height: 0`
and owns its own scrolling.

### Header

The current header row moves inside `PageHeader`, which already solves the scrollport
clipping problem (`SCROLLPORT_PADDING`). Two lines: back button, run id, status badge and
awaiting badge on top; step progress and the End session / Cancel run / Run again actions
below. Content is unchanged — only its container and stickiness are new.

### Stepper strip

`RunStepper` keeps its wrapping pill row. It gains one control: a chevron that collapses the
strip to the current step alone, for workflows long enough that the pills eat the space this
change is meant to free. Collapse state is component state, deliberately not persisted —
it is a per-sitting reaction to one workflow's length, not a preference.

The focus-step detail leaves its `Card` and becomes a compact line inside the strip. Full
details stay one click away in the step popover, which already shows the same fields via
`StepDetails`.

### Manual decision band

`ManualStepCard` renders between the stepper and the tab bar whenever the run is parked on a
human. It is outside the tabs on purpose: the run is blocked until it is answered, so it must
not be possible to hide it behind an inactive tab. It disappears once resolved.

### Tabs

A Fluent `TabList`. Logs is the initial selection. When `ptyStarted` arrives, the selection
moves to Terminal — but only if the user has not yet chosen a tab themselves; an explicit
choice is never overridden. A dot on the Terminal tab marks a session awaiting the user, and
Artifacts carries a count.

All three panels stay mounted, with inactive ones hidden by `display: none`. Unmounting the
terminal would tear down xterm and force a buffer replay on every tab switch — and anything
trimmed past the store's cap would be gone for good.

### Terminal panel

`TerminalPanel` drops its hard-coded `height: 320` and fills the panel. Its existing
`ResizeObserver` → `ptyResize` wiring handles the refit already; two things need care:

- The `ResizeObserver` must ignore zero-size callbacks. A hidden panel measures 0×0, and
  fitting to that would report a nonsense size to the PTY.
- Becoming visible again needs an explicit refit, since no resize fires on an
  un-hidden element that never changed size.

### Artifacts panel

The Files zone, reused literally:

- **`FileTree`** takes `root`, `nodes`, `expanded`, `selectedPath`, `onToggle`, `onSelect`,
  and its row actions are `Partial` — passing none renders no create/rename/delete buttons.
  The `TreeNodes` map is built from the manifest's artifact list via the existing
  `makeRootNode` / `applyDirListing` helpers, with synthesized `DirEntry` values. The tree is
  built from the manifest, never from a directory listing, so it lists exactly what the agent
  vouches for.
- **`FilePreview`** is used unchanged, wrapped in a `FileSystemProvider` holding the new
  `ArtifactFileSystem`. Artifacts pick up markdown rendering, syntax highlighting, size
  limits and the external-change conflict dialog — all of which the current
  `<ReactMarkdown>`-only viewer lacks.

Artifacts are editable. `FilePreview`'s existing Edit / Save / Cancel flow applies, with its
controls rendered inside the panel rather than a `PageFooter`.

## Agent protocol (`packages/agent`)

### `readArtifact` gains two fields

`readArtifactResult` goes from `{ content }` to `{ content, size, mtimeMs }`. Purely
additive. `FilePreview` needs both to detect external changes before saving.

No version-skew handling: the agent is spawned as a Tauri sidecar from the same build as the
desktop app, so the two always match.

### New `writeArtifact`

```
params:  { workdir, runId, name, content, expectedMtimeMs? }
result:  { mtimeMs }
```

The path-resolution half of `readArtifact` (`handlers.ts:233-269` — listing lookup, realpath
containment, size cap) is extracted into a shared helper that both handlers call. This is the
point of the refactor: two independently-written copies of a containment check drift, and the
one that drifts is the one nobody is reading.

`writeArtifact` additionally:

- applies `MAX_ARTIFACT_BYTES` to the incoming content, not just to what it reads;
- rejects when `expectedMtimeMs` is given and does not match what is on disk.

`FilePreview` already re-stats before saving and raises its conflict dialog on a mismatch, so
the adapter gets conflict detection just by implementing `stat()` and `writeTextFile()`.
`expectedMtimeMs` closes the TOCTOU gap between that stat and the write.

### `ArtifactFileSystem` (new, `apps/desktop/src/files/artifact-fs.ts`)

Implements `FileSystemPort` over the two RPCs:

| Method | Behaviour |
|---|---|
| `readFile` | `readArtifact`, content encoded to `Uint8Array` |
| `stat` | `readArtifact`'s `size` / `mtimeMs`; `isDirectory: false` |
| `writeTextFile` | `writeArtifact` |
| `exists` | true when the name is in the manifest listing |
| `ensureGranted` | no-op — the agent, not a scope, is the boundary |
| `readDir`, `mkdir`, `rename`, `remove`, `watch` | reject |

The rejecting methods are unreachable from this panel: the tree comes from the manifest and
is rendered without row actions, so nothing offers to create, rename or delete. They reject
rather than no-op so a future caller finds out immediately.

## Known race

Editing an artifact of a still-running run can collide with the engine writing that same
file. The mtime guard turns that into a visible conflict rather than silent loss, which is
the floor this design commits to. Locking artifacts of running steps is deliberately not
attempted — the run's own write would then be the thing that fails.

## Testing

Agent (`node --test`):

- `protocol.test.ts` — the extended `readArtifact` result and `writeArtifact` schemas.
- `handlers.test.ts` — for `writeArtifact`: unknown name rejected; a symlink inside the run
  dir pointing outside it rejected; oversized content rejected; stale `expectedMtimeMs`
  rejected; a good write returning the new mtime. The containment cases mirror the existing
  `readArtifact` tests, against the shared helper.

Desktop (vitest):

- `artifact-fs.test.ts` — each port method maps to the right RPC; the unsupported methods
  reject.
- `RunDetailPage.test.tsx` — the existing 20 tests, updated where the layout moved things:
  the artifact test's `getByRole('button', { name: 'review.md' })` becomes a `treeitem`, and
  the artifact and log assertions select their tab first. Plus new coverage for tab
  switching, the auto-select-on-`ptyStarted` rule and its "not if the user chose" exception,
  and stepper collapse.

### Manual verification (requires the live app)

Sticky behaviour, the terminal actually filling the window, and the hidden-panel refit are
all layout facts jsdom cannot check. Verify against a real interactive run: start one, resize
the window, switch tabs and back, and confirm the PTY's reported size tracks the panel.

## Out of scope

- Binary and image artifacts. `readArtifact` returns text; non-text artifacts land in
  `FilePreview`'s existing unsupported state. Deferred deliberately — widening both RPCs to
  carry base64 is its own change.
- Deleting or renaming artifacts.
- Any change to the Files page.
- Persisting tab or collapse state across sessions.
