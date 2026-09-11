# File Explorer with Preview (desktop)

**Status**: approved design, not yet implemented
**Date**: 2026-09-04
**Scope**: `apps/desktop` only

## Goal

A VS Code-style file explorer in the Mission Control desktop app: a lazily-loaded tree of
the opened workspace on the left, a preview pane on the right. Preview is the friendly
default — markdown always renders, and an explicit **Edit** button reveals the raw source.
Any text file can be edited and saved in place; files and folders can be created, renamed
and deleted.

## Constraints

- **Desktop-only.** This is a UI feature, not part of the workflow engine. `packages/agent`,
  `packages/core`, `packages/cli` and `parity/` are not modified. The agent's RPC protocol
  gains no file methods — the file explorer must not couple to the agentic work.
- **TypeScript-first.** All feature logic lives in the webview. Rust is limited to plugin
  registration and one scope-granting command that performs no file I/O.
- **Parity is unaffected.** `parity/surface.test.ts` maps CLI commands to UI elements; a
  desktop-only page has no CLI counterpart and needs no `uiActions` entry.

## Decisions

| Question | Decision |
|---|---|
| Tree root | The whole opened workspace directory |
| Placement | A new top-level **Files** tab, alongside Runs / Workflows / Doctor / Settings |
| Editable files | Any text file, via a plain textarea (markdown included) |
| Preview richness | Markdown rendered, images inline, other text syntax-highlighted |
| Freshness | Noise hidden by default; a live filesystem watcher on expanded directories |
| File management | New file, New folder, Rename, Delete |
| File access | `@tauri-apps/plugin-fs` from the webview, scoped at runtime to the workspace |

### Why the fs plugin rather than the agent

The agent already exposes `readArtifact` — deliberately narrow: name-based lookup against a
run's own directory listing, realpath containment, 2 MB cap (`packages/agent/src/handlers.ts`).
Widening it into a general workspace file server would put a desktop UI concern inside the
engine's protocol. The fs plugin keeps the feature in the desktop app, and its scope is
enforced by the plugin rather than by our own path arithmetic.

The cost is that the fs plugin's scope is static in `capabilities/` and can only be extended
at runtime from Rust — the dialog picker does **not** grant fs access to what the user picks
(https://v2.tauri.app/plugin/file-system/, tauri-apps/tauri#9195). A broad static scope such
as `$HOME/**` was rejected: it hands the webview read *and write* over the whole home
directory, the posture this repo already turned down when it routed artifact reads through
the agent. Twelve lines of Rust buy an OS-level containment guarantee instead.

## Architecture

### Rust shell (`apps/desktop/src-tauri`)

- `Cargo.toml`: add `tauri-plugin-fs = { version = "2", features = ["watch"] }`.
- `lib.rs`: register the plugin and add one command:

  ```rust
  #[tauri::command]
  fn grant_workspace(app: tauri::AppHandle, path: String) -> Result<(), String> {
      app.fs_scope().allow_directory(&path, true).map_err(|e| e.to_string())
  }
  ```

  No Rust code reads, writes or lists files. The exact `allow_directory` signature (whether
  it returns `Result`) is confirmed against the installed plugin version during
  implementation; the command's shape does not change either way.
- `capabilities/default.json`: add the fs permissions the feature uses (`fs:allow-read-dir`,
  `fs:allow-read-file`, `fs:allow-read-text-file`, `fs:allow-write-text-file`,
  `fs:allow-mkdir`, `fs:allow-rename`, `fs:allow-remove`, `fs:allow-stat`, `fs:allow-exists`,
  `fs:allow-watch`, `fs:allow-unwatch`)
  with an **empty static scope**, so a fresh install can reach nothing on disk until a
  workspace is opened.

### Grant timing

The grant happens lazily, from the Files page, on mount and whenever `workspacePath`
changes — memoized per path so it runs once per workspace per session. It is deliberately
not wired into `openWorkspace()` in `apps/desktop/src/lib/use-startup-restore.ts`: startup
restore sets `workspacePath` directly without going through that function, so a hook there
would miss the restored-workspace case. Granting from the page also means nothing is granted
at all until the user actually opens the Files tab.

### Module layout (all new, all under `apps/desktop/src`)

```
files/
  fs-port.ts      FileSystemPort interface
  tauri-fs.ts     plugin-backed implementation
  fake-fs.ts      in-memory implementation for tests
  tree-model.ts   pure: node shape, sort, noise filter, reconcile, validateName
  file-kind.ts    pure: bytes+path -> kind ('markdown'|'image'|'text'|'binary') + language id
components/
  FileTree.tsx
  FilePreview.tsx   dispatches on kind
  MarkdownView.tsx  preview <-> edit
pages/
  FilesPage.tsx
```

`FileSystemPort` methods: `ensureGranted`, `readDir`, `readFile` (bytes), `writeTextFile`,
`stat`, `exists`, `mkdir`, `rename`, `remove`, `watch`.

The port exists so the logic is testable: the fs plugin's JS API cannot run under
jsdom/vitest. This mirrors the existing `agent/transport.ts` + `agent/tauri-transport.ts`
split. `tree-model.ts` and `file-kind.ts` import no React and no Tauri.

### State

Tree and preview state live in `FilesPage` component state (a `Map<path, node>` plus the
selection and editor state), not in the global zustand store — nothing outside the page
consumes them. The "Show hidden files" toggle persists in `localStorage`; it is deliberately
not persisted through the agent's `setUiState`, which would mean extending the agent protocol.

## The tree

- Root is `workspacePath`. With no workspace open, the page shows the same empty state the
  other pages use.
- `readDir` runs for the root on mount and for each directory on expand. Never recursive.
- Node: `{ path, name, kind: 'dir' | 'file', childrenLoaded, children?, error? }`.
- Sort: directories first, then case-insensitive name comparison.
- A directory that fails to read (EACCES, vanished) renders with a warning icon and its
  message; it never breaks the tree.
- Directories with more than 1000 entries render the first 1000 plus an "…and N more" row.
- **Noise filter**: hidden by default are names beginning with `.`, plus `node_modules`,
  `target`, `dist`, `build`, `coverage`. **`.mc/` is always visible** despite the leading
  dot — it is the most relevant directory in the product. A "Show hidden files" toggle
  reveals the rest.
- **Watcher**: one non-recursive `watch()` per *expanded* directory, torn down on collapse,
  with an LRU cap of 32 concurrent watchers so deep browsing cannot exhaust inotify handles.
  Events coalesce per directory on a ~150 ms trailing debounce, then that one directory is
  re-read and reconciled: surviving children keep identity and expansion state, new ones
  appear, removed ones disappear, and the selection survives unless the selected file itself
  is gone. A run writing into `.mc/runs/<id>/` therefore updates live while being watched and
  costs nothing when collapsed.
- Interaction: Fluent UI v9 `Tree`/`TreeItem` for keyboard navigation and accessibility.
  Single click selects and previews — there is no editor-tab concept, so VS Code's
  preview-vs-pinned distinction does not apply. Right-click opens the operations menu.

## Preview and editing

Selecting a file `stat`s it first. Over **2 MB** it shows "Too large to preview (N MB)" and
reads nothing — the same cap the agent applies to artifacts. Otherwise a single `readFile`
returns bytes; a NUL byte within the first 8 KB means binary, shown as "Binary file — N KB"
with the path. Everything else decodes as UTF-8 and dispatches on extension.

- **Markdown** (`.md`, `.markdown`) renders through `react-markdown` (already a dependency,
  the same renderer as `RunDetailPage`). An **Edit** button swaps in a full-height textarea
  of the raw source with **Save** / **Cancel**; Ctrl/Cmd-S saves. A successful save returns
  to the rendered view.
- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`) render from
  an object URL, revoked on unmount — not a base64 data URI. No edit mode.
- **Other text** renders through highlight.js, language chosen from an extension map,
  falling back to plaintext. `highlightAuto` is never used: it is slow and guesses badly.
  The stylesheet swaps between `github` and `github-dark` off the same `dark` flag `App.tsx`
  already computes. Its Edit button opens the same plain textarea — **highlighting is
  preview-only; editing is unhighlighted.** A highlighted editor would require CodeMirror or
  Monaco, a far larger dependency than this feature justifies.

Two guards, because runs write into this tree while the user is looking at it:

- **Dirty guard**: selecting another file, switching tabs, or closing with unsaved edits
  raises a Fluent dialog — Discard / Keep editing.
- **Stale-write guard**: the mtime seen at open is kept as a baseline; Save re-`stat`s first
  and, if the mtime moved, offers Overwrite / Reload / Cancel rather than silently
  clobbering. The watcher additionally flags "changed on disk" inline during editing.

## File operations

Available from a right-click context menu on tree nodes and from a small toolbar above the
tree (discoverable without knowing to right-click).

- **New file** / **New folder**: name dialog; the target is the clicked directory, or the
  clicked file's parent. `exists()` is checked first so a collision is an inline dialog
  error, never an overwrite. A new file opens directly in edit mode.
- **Rename**: dialog prefilled with the current name. If the renamed file is the one open,
  the preview retargets rather than blanking.
- **Delete**: confirmation naming the target; for a directory the wording is explicit
  ("Delete folder `x` and everything inside it?") before a recursive remove. If the deleted
  node was open, the preview clears.

Name validation is one pure `validateName()` in `tree-model.ts` — non-empty, no path
separators, not `.` or `..`, no NUL — shared by all three dialogs. Traversal cannot escape
the granted scope regardless; rejecting it in the dialog produces a real error message
instead of an opaque plugin failure.

After every operation the affected directory is re-read directly rather than waiting on the
watcher, since a collapsed parent is not watched.

## Error handling

Every fs call is wrapped. Failures render as a Fluent `MessageBar` in the pane, or inline in
the dialog that caused them. `EACCES` on read is the realistic case and must never take down
the tree.

## Testing

- **Pure vitest, no DOM**: `tree-model` (sort order, noise filter including the `.mc`
  exception, reconcile preserving expansion and selection, `validateName`) and `file-kind`
  (extension → kind and language, NUL sniffing, size-cap decision).
- **Component tests against `fake-fs`**: expand → select a `.md` → rendered output;
  Edit → textarea → Save → back to rendered; the dirty guard; the stale-write guard (the
  fake bumps mtime under the editor); each context-menu operation; the hidden-files toggle.
- **`tauri-fs.ts` is deliberately thin and not covered by vitest** — it cannot run under
  jsdom. It is verified live, the same posture the repo takes with `TauriTransport`.
- `npm run verify` covers tsc, vitest and `cargo check` (which now compiles the new plugin
  and command).

### Manual verification (requires the live app)

1. Grant works on a freshly-picked workspace, and on a workspace restored at startup.
2. The tree live-updates while a run writes into `.mc/runs/`.
3. Editing and saving a markdown file, then a `.yaml` file.
4. Deleting the file currently open in the preview.
5. An unreadable directory renders its error without breaking the tree.

## Out of scope

- Syntax highlighting inside the editor (needs CodeMirror/Monaco).
- Multiple open editors, tabs, or split panes.
- Search across files, git status decorations, drag-and-drop moves.
- An always-on VS Code-style sidebar — the Files tab ships first; a docked sidebar can
  follow once the tree and preview components have proven themselves.
- Any file access from outside the opened workspace.
