# Markdown: a first-class document surface

**Status**: approved design, not yet implemented
**Date**: 2026-09-06
**Amended**: 2026-09-06, while writing `docs/superpowers/plans/2026-09-06-markdown-rendering.md` —
three implementation claims turned out to be wrong (the `urlTransform` override, the find
mechanism, and the sanitizer's id handling). Corrected in place.
**Scope**: `apps/desktop`

## Goal

Markdown is the document `mc` works in. A run writes `plan.md`, `review.md`, a verdict, a
report; the Files page and the Artifacts tab are where a person reads them. Today both
render with a bare `<ReactMarkdown>{text}</ReactMarkdown>` — no plugins, no styling. A
table renders as a run of pipes, a task list as literal `- [ ]`, a fenced code block as
unhighlighted grey text, YAML frontmatter as a stray heading followed by a horizontal
rule.

After this change, reading a markdown artifact in `mc` looks like reading it on GitHub,
and an artifact being written by a running step updates under you as it grows.

## Constraints

- **GitHub-faithful, not a bespoke reader.** No table of contents, no reading-width cap,
  no document chrome the source didn't ask for. Full-width pane, familiar rendering.
- **One renderer, both surfaces.** `FilePreview` (Files page + Artifacts tab) and
  `ManualStepCard` share a single `<Markdown>` component. No second viewer.
- **No Tauri in the component.** Every capability — navigation, image bytes, opening a
  URL — arrives as a prop, matching how `fs-port.ts` and `agent/transport.ts` already
  separate ports from components. `apps/desktop/vitest.config.ts` deliberately keeps
  `@tauri-apps/*` out of the test graph; a component importing it would be untestable.
- **The artifact door stays narrow.** Artifact reads keep going through the agent's RPCs
  via `ArtifactFileSystem`, never the webview's fs plugin.
- **Artifacts are untrusted input.** They are written by LLM CLI runners, and
  `tauri.conf.json` sets `csp: null`. The sanitizer schema is the security boundary.

## Decisions

| Question | Decision |
|---|---|
| Reading model | Faithful GitHub-style render; full width, no TOC |
| Renderer | `react-markdown` with component overrides (not HTML injection) |
| Mermaid | Rendered, lazy-loaded chunk, `securityLevel: 'strict'` |
| YAML frontmatter | Rendered as a metadata table |
| Footnotes, heading anchors | Both rendered |
| Raw inline HTML | Allowed, through `rehype-raw` + `rehype-sanitize` |
| Relative links | Navigate in-app; unresolvable targets render inert |
| Relative images | Loaded through the `FileSystemPort` |
| External links | Open in the system browser via `plugin-shell` |
| Live refresh | Yes, via a new `watchFile` port method |
| Source view | A read-only `Rendered \| Source` toggle, separate from Edit |
| Find in document | In-renderer via a rehype plugin, Ctrl/Cmd-F scoped to the pane |
| Task-list checkboxes | Rendered, disabled — toggling would mean writing the file |
| Reading-width cap | None, even on a wide window |

### Why not compile to HTML and inject it

A `renderMarkdown(text) → string` util with `dangerouslySetInnerHTML` renders faster and
tests as string-in/string-out. It was rejected: every interactive affordance here — copy
buttons, mermaid, find-match highlighting, live re-render — becomes post-render DOM
surgery, and relative-image resolution is asynchronous, which a synchronous string render
cannot express. The React-component seam is what makes each of these an override instead
of a patch.

## Module layout

```
apps/desktop/src/markdown/
  Markdown.tsx        the component
  pipeline.ts         remark/rehype plugin arrays + sanitize schema
  frontmatter.ts      the yaml → table remark transform (pure)
  CodeBlock.tsx       hljs + language chip + copy button
  Mermaid.tsx         lazy-loaded diagram renderer
  find.ts             match computation over the parsed tree
  markdown.css        prose styles, written on Fluent tokens
```

New runtime dependencies: `remark-gfm`, `remark-frontmatter`, `rehype-raw`,
`rehype-sanitize`, `rehype-slug`, `yaml` (v2, already used by `@wp/core`; added to
`apps/desktop` directly rather than reached through the workspace), and `mermaid` in a
lazy chunk. Highlighting reuses the existing `files/highlight.ts` registry.

## Pipeline

Plugin arrays are built once at module scope, never per render.

**remark**: `remark-gfm` → `remark-frontmatter(['yaml'])` → local `remarkFrontmatterTable`.

The local transform is required, not decorative: `remark-frontmatter` produces a `yaml`
node that `react-markdown` has no component key for and silently drops, so "render
frontmatter as a table" has nowhere else to live. It parses with `yaml` v2 and emits an
mdast table of key/value rows. Malformed frontmatter falls back to a plain code block
rather than throwing. Only a *leading* frontmatter block is transformed.

**rehype**: `rehype-raw` → `rehype-sanitize(schema)` → `rehype-slug` →
`rehype-autolink-headings`.

The order is load-bearing. `rehype-raw` parses raw HTML into real nodes; if sanitization
ran before it, hostile markup would pass through as text and be parsed afterwards. A test
pins the ordering with a `<script>` payload.

Slug and autolink run *after* sanitize, so heading ids and their anchors are ours rather
than the artifact author's, and the schema needs no `id` allowance for them.

**Sanitize schema**, extending `defaultSchema`: adds `details`, `summary`, `kbd`, `sub`,
`sup`, `picture`. `script`, `style`, `iframe`, `object`, every `on*` handler, and
`javascript:` / `data:` URLs stay stripped. Our own wrappers get their classes in React,
after sanitization, so no attribute allowances are needed for them.

The schema also sets **`clobber: []`**. `hast-util-sanitize` prefixes every `id` with
`user-content-` but does not rewrite `href="#…"` fragments — and GFM footnotes already
emit that prefix, so the default double-prefixes the target and every in-page anchor
dies. Disabling it accepts a small DOM-clobbering risk (an artifact could emit
`<img id="…">` shadowing a global) in exchange for working footnotes and heading
anchors. Nothing in this app looks an artifact's nodes up by id, which is what makes the
trade acceptable.

`react-markdown`'s `defaultUrlTransform` returns any URL without a scheme unchanged, so
the relative hrefs this design depends on already survive and no override is needed. A
test pins that, because a future upgrade could quietly change it.

## Component API

```ts
interface MarkdownProps {
  text: string;
  /** How a non-absolute href/src resolves. Returning null renders inert text. */
  resolve?: (target: string) => { path: string; kind: 'link' | 'image' } | null;
  /** Follow an in-app link. Absent → links resolve but don't navigate. */
  onNavigate?: (path: string) => void;
  /** Load bytes for a relative image. Absent → images render as a placeholder. */
  loadImage?: (path: string) => Promise<Uint8Array>;
  /** Open an http(s) target. Absent → external links are inert. */
  openExternal?: (url: string) => void;
  /** Active find query; matches are highlighted, the current one scrolled to. */
  find?: FindState;
}

/** Owned by the pane's find bar; the renderer only reads it. */
interface FindState {
  query: string;
  /** Zero-based index of the match to scroll to and mark current. */
  activeIndex: number;
  /** Called after a render pass with the total match count, for "2/5". */
  onMatchCount: (total: number) => void;
}
```

Every capability is optional and degrades to inert text rather than a broken affordance.
`ManualStepCard` passes only `openExternal`. `FilePreview` passes all four, from a
`docContext` prop supplied by the page that owns the navigation model.

## Link and image resolution

**Files page.** Resolves against the open file's directory, normalizes, and rejects any
path escaping the workspace root. Navigation calls the page's existing selection path, so
the unsaved-edits guard still intercepts before the preview retargets.

**Artifacts tab.** Resolves against the run manifest by name. Anything that is not an
artifact of this run returns `null` and renders inert — surfacing in the UI the refusal
`ArtifactFileSystem.nameFor` already makes by throwing.

**Images.** Read through the `FileSystemPort`, decoded to an object URL typed by
`mimeTypeForPath`, revoked on unmount — the handling `FilePreview` already uses for
whole-file image previews, and the reason SVGs render at all. Per-image size and
concurrent-load caps keep a document full of images from stalling the pane.

**External.** `openExternal` is injected at `main.tsx` from `@tauri-apps/plugin-shell`,
like every other Tauri binding, and the link carries an `↗` affordance.

## Live refresh

`FileSystemPort` gains one method:

```ts
watchFile(path: string, onChange: () => void): Promise<() => void>;
```

- **`TauriFileSystem`** watches the containing *directory* and filters to the path.
  Watching the file inode directly breaks under write-to-temp-then-rename, which is how
  CLI runners tend to write artifacts.
- **`ArtifactFileSystem`** polls the run's artifacts and fires when an mtime moves. It has
  no directories; polling is already how `RunDetailPage` tracks a run driven by another
  process.
- **`FakeFileSystem`** delegates to its existing watcher registry, so tests drive refresh
  synchronously.

`FilePreview` takes `live?: boolean`, subscribes while true, and coalesces bursts on a
~150 ms debounce. Three guards:

1. **Never clobber an edit.** With a dirty draft, a disk change shows a "changed on disk —
   Reload" `MessageBar` instead of re-reading. The existing save-time conflict dialog stays
   as the last line of defence.
2. **Hold scroll.** `scrollTop` is captured before the swap and restored after — unless the
   reader is within ~40 px of the bottom, where it sticks to the bottom so a document being
   appended to follows itself.
3. **Only when it can change.** `RunDetailPage` passes `live={isRunning}`; a finished run
   costs nothing. The Files page watches whenever a file is open.

## Find in document

The query is passed *into* the renderer as `find`, and a rehype plugin splits matching
text nodes into `<mark>` elements before React ever sees the tree. Wrapping `<mark>`
around text nodes after render is the obvious implementation and a real hazard: React
reconciles over the mutated tree and can throw. (A `text` component override would be the
neater expression of the same idea, but react-markdown's `components` map only accepts
HTML tag names — text nodes render as bare strings.)

The match count is read back after render by counting the marks in the container — DOM
reading, not writing — so the count and the highlights can never disagree. Ctrl/Cmd-F is a
window-level shortcut (the webview's native find is unavailable, and a handler on the
preview pane only fires once focus is already inside it — clicking a file in the tree and
then pressing Ctrl-F, which is the realistic sequence, would do nothing). It stands down
while the reader is typing in an input or the editor's `Textarea`, and opens the bar only
where a markdown document is actually open. Escape closes, Enter / Shift-Enter step, and
the current match is scrolled into view with a `scroll-margin-top` so sticky chrome cannot
cover it.

Source view is **not** highlighted. It renders `highlightCode(text, 'markdown')` through
`dangerouslySetInnerHTML`, so marking a match there would mean splicing `<mark>` into a
generated HTML string whose tokens are already wrapped in hljs `<span>`s — any match
crossing a token boundary would have to be split across those spans, and a mis-split would
corrupt the markup rather than just miss a match. What Source does instead is honest about
it: it counts occurrences by scanning the text it is displaying (fenced code included,
because that code really is on screen there) and reports a plain tally — "2 matches", not
"1/2" — with next/previous disabled, because there is nothing marked to step to.

## Source toggle

A `Rendered | Source` control in the preview header, distinct from `Edit`. Source is
read-only and reuses `highlightCode(text, 'markdown')`. Today the only way to see the
source is to click Edit, which risks an accidental save. The choice persists for the
session and defaults to Rendered.

## Styling

`markdown.css`, scoped under `.mc-markdown`, written entirely against Fluent tokens so it
follows the app's theme with no stylesheet swap and survives `css: false` under vitest —
the reasoning that already governs the hljs block in `index.css`.

Bordered `h1`/`h2`; blockquote with a left rule; tables with a filled header row inside an
`overflow-x: auto` wrapper so a wide table never scrolls the pane; inline code as a tinted
chip; fenced blocks bordered, carrying a language chip and a copy button on hover;
`img { max-width: 100% }`; heading anchors revealed on hover.

## Testing

**Unit** — frontmatter transform (valid, malformed, non-leading, empty); sanitize schema
(`<script>`, `onerror=`, `javascript:` href stripped; `<details>` kept); plugin ordering;
relative hrefs surviving `urlTransform`; footnote and heading anchors resolving to a
target that exists; path resolution (escape rejected, non-artifact
→ `null`); the find matcher (counts, case-insensitivity, overlap).

**Component** — GFM tables, task lists, strikethrough, footnotes render; a fence gets its
language chip and copy button (clipboard mocked); link clicks route to `onNavigate` vs
`openExternal`; images load through `FakeFileSystem` and revoke their object URL on
unmount; with every capability absent, content is inert rather than broken.

**Integration** — a relative link moves the Files tree selection and still trips the dirty
guard; a link to a non-artifact stays inert in the Artifacts tab; live refresh driven
through `FakeFileSystem`'s external-change helpers asserts re-render, held scroll, and no
clobber while editing.

Mermaid is never loaded under `jsdom`: the lazy import is guarded and stubbed. A fence
that fails to parse falls back to a code block, and that fallback is tested.

## Sequencing

Each phase stands on its own.

1. Pipeline, sanitization, frontmatter, prose CSS — both surfaces at once
2. Code fences: highlighting, language chip, copy button
3. Links and images, with the two resolvers
4. Source toggle
5. `watchFile` and live refresh
6. Mermaid, lazy
7. Find in document

## Out of scope

- Toggling task-list checkboxes (it means writing the file)
- Side-by-side or live-preview editing; the editor stays a `Textarea`
- Math / KaTeX
- Virtualizing very long documents — the 2 MB `MAX_PREVIEW_BYTES` cap stands
- Highlighting and stepping find matches in Source view — a follow-up. It needs the
  highlighter to emit a structure that can be marked (or a mark-aware second pass over the
  hljs output), which is a bigger change than the find bar itself; Source counts honestly
  in the meantime
