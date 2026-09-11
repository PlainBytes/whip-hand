# Markdown Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a markdown artifact in `mc` read like it does on GitHub — tables, task lists, highlighted code, frontmatter, mermaid, working links and images — and keep updating while a run writes it.

**Architecture:** One `<Markdown>` component in `apps/desktop/src/markdown/`, rendering through `react-markdown` with a fixed remark/rehype pipeline and component overrides. Every capability it needs from the outside — resolving a relative path, navigating, loading image bytes, opening a URL — arrives as an optional prop, so the component imports nothing from Tauri and nothing from the app's stores, and a missing capability degrades to inert text. `FilePreview` (Files page + run Artifacts tab) and `ManualStepCard` are its only consumers.

**Tech Stack:** React 18, TypeScript, Vite, Vitest + @testing-library/react (jsdom), Fluent UI v9, `react-markdown` v10, remark/rehype (unified), `highlight.js`, `mermaid`, Tauri v2.

**Spec:** `docs/superpowers/specs/2026-09-06-markdown-rendering-design.md`

## Global Constraints

- **Node ≥ 24.** The repo runs TypeScript natively with no build step. Do not add a transpile step.
- **No `@tauri-apps/*` import anywhere vitest can reach.** `apps/desktop/vitest.config.ts` deliberately keeps the Tauri packages out of the test graph. Tauri APIs are reached only through `FileSystemPort` (`src/files/fs-port.ts`), `AgentClient`, or a function injected at `src/main.tsx`. A component importing a Tauri package is untestable and will fail review.
- **Never import `.css` from a component.** `vitest.config.ts` sets `css: false`. All styles live in `src/index.css` or a file it `@import`s.
- **Styling uses Fluent design tokens only** (`var(--colorNeutralForeground1)`, `var(--colorNeutralStroke2)`, …). No hard-coded colours, no light/dark stylesheet swap. Follow the existing hljs block at the bottom of `src/index.css`.
- **File paths in this app may use `/` or `\`.** Use `joinPath` / `parentPath` from `src/files/tree-model.ts` rather than string concatenation.
- **`TauriFileSystem` rejects any path containing a `..` segment** (`assertNoParentTraversal`). Every path handed to the `FileSystemPort` must already be normalized.
- **Tests are behavioural.** Assert what a user sees (roles, text, testids), not implementation details. Existing suites in `src/components/*.test.tsx` are the reference for style.
- **Commit after every task**, with a `feat(desktop):` / `test(desktop):` / `refactor(desktop):` prefix matching the existing log.
- **Run `npm test --workspace apps/desktop` before each commit.** The whole suite, not just the new file.

### Deviations from the spec

These three were found while writing the plan and the spec has been amended to match. They are called out here because the spec's earlier wording is what a reviewer may remember.

1. **No `urlTransform` override.** react-markdown's `defaultUrlTransform` returns any URL without a scheme unchanged, so relative hrefs already survive. Task 2 keeps a test pinning that, but adds no override.
2. **Find is a rehype plugin, not a `text` component override.** react-markdown's `components` map only accepts HTML tag names; text nodes render as bare strings, so there is no `text` key to override. Task 13/14 mark matches in the hast tree instead, which keeps the "never mutate React-owned DOM" property.
3. **The sanitize schema sets `clobber: []`.** `hast-util-sanitize` prefixes `id` attributes with `user-content-` but does not rewrite `href="#…"` fragments; GFM footnotes already emit that prefix, so the default double-prefixes the target and every footnote link dies. Disabling clobber accepts a small DOM-clobbering risk (an artifact could emit `<img id="…">` shadowing a global) in exchange for working in-page anchors. The renderer never looks anything up by `id`, which is what makes the trade acceptable.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/desktop/src/markdown/frontmatter.ts` | remark transform: leading YAML block → mdast table. Pure. |
| `apps/desktop/src/markdown/pipeline.ts` | The remark/rehype plugin arrays and the sanitize schema. No React. |
| `apps/desktop/src/markdown/types.ts` | The shared types (`DocResolution`, `FindState`, `MarkdownProps`). No imports of its own. |
| `apps/desktop/src/markdown/Markdown.tsx` | The component; assembles the component overrides. |
| `apps/desktop/src/markdown/CodeBlock.tsx` | Fenced code: highlighting, language chip, copy button. |
| `apps/desktop/src/markdown/Mermaid.tsx` | Lazy-loaded diagram renderer with a code-block fallback. |
| `apps/desktop/src/markdown/resolve.ts` | Pure path resolution for relative links/images. No React, no fs. |
| `apps/desktop/src/markdown/find.ts` | Match computation + the highlighting rehype plugin. Pure. |
| `apps/desktop/src/markdown/FindBar.tsx` | The find UI and its keyboard handling. |
| `apps/desktop/src/markdown/markdown.css` | Prose styles, `@import`ed by `index.css`. |
| `apps/desktop/src/lib/use-dark-theme.ts` | The dark-mode boolean, extracted from `App.tsx` so Mermaid can read it. |
| `apps/desktop/src/markdown/*.test.ts(x)` | One test file per module above. |

**Modified**

| File | Change |
|---|---|
| `apps/desktop/package.json` | New dependencies. |
| `apps/desktop/src/index.css` | `@import './markdown/markdown.css';` |
| `apps/desktop/src/components/FilePreview.tsx` | Renders `<Markdown>`; gains `docContext`, `live`, source toggle, own scroll container. |
| `apps/desktop/src/components/ManualStepCard.tsx` | Renders `<Markdown>` with `openExternal` only. |
| `apps/desktop/src/pages/FilesPage.tsx` | Supplies the workspace `docContext`; pane stops scrolling. |
| `apps/desktop/src/pages/RunDetailPage.tsx` | Supplies the artifact `docContext` and `live={isRunning}`; pane stops scrolling. |
| `apps/desktop/src/files/fs-port.ts` | Adds `watchFile`. |
| `apps/desktop/src/files/tauri-fs.ts` | Implements `watchFile` by watching the parent directory. |
| `apps/desktop/src/files/artifact-fs.ts` | Implements `watchFile` by polling. |
| `apps/desktop/src/files/fake-fs.ts` | Implements `watchFile` over the existing watcher registry. |
| `apps/desktop/src/files/use-file-tree.ts` | Adds `expand(path)` so a navigated file can be revealed. |
| `apps/desktop/src/main.tsx` | Injects `openExternal` from `@tauri-apps/plugin-shell`. |
| `apps/desktop/src/App.tsx` | Uses the extracted `useDarkTheme` hook. |

---

## Task 1: Frontmatter → table transform

A leading `---` YAML block currently renders as a stray `<h2>` followed by an `<hr>`. `remark-frontmatter` parses it into a `yaml` node, which `react-markdown` has no component key for and silently drops — so turning it into something visible needs this transform.

**Files:**
- Create: `apps/desktop/src/markdown/frontmatter.ts`
- Create: `apps/desktop/src/markdown/frontmatter.test.ts`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `remarkFrontmatterTable` — a unified plugin, `() => (tree: Root) => void`. Task 2 puts it in the remark array.

- [ ] **Step 1: Add the dependencies**

```bash
npm install --workspace apps/desktop \
  remark-gfm@^4 remark-frontmatter@^5 rehype-raw@^7 rehype-sanitize@^6 \
  rehype-slug@^6 rehype-autolink-headings@^7 unist-util-visit@^5 yaml@^2.6
npm install --workspace apps/desktop --save-dev @types/mdast@^4 @types/hast@^3
```

`unist-util-visit` is a runtime dependency (the find plugin in Task 13 imports it), not a dev one.

- [ ] **Step 2: Write the failing test**

```ts
// apps/desktop/src/markdown/frontmatter.test.ts
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import type { Root } from 'mdast';
import { remarkFrontmatterTable } from './frontmatter.ts';

function transform(markdown: string): Root {
  const processor = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkFrontmatterTable);
  return processor.runSync(processor.parse(markdown)) as Root;
}

describe('remarkFrontmatterTable', () => {
  it('turns a leading yaml block into a two-column table', () => {
    const tree = transform('---\nrun: oauth\nverdict: PASS\n---\n\n# Title\n');
    const table = tree.children[0];
    expect(table.type).toBe('table');
    // Header row plus one row per key.
    expect((table as any).children).toHaveLength(3);
    const firstValue = (table as any).children[1].children[1].children[0];
    expect(firstValue.value).toBe('oauth');
  });

  it('renders non-scalar values as compact JSON rather than [object Object]', () => {
    const tree = transform('---\nsteps: [plan, execute]\n---\n');
    const cell = (tree.children[0] as any).children[1].children[1].children[0];
    expect(cell.value).toBe('["plan","execute"]');
  });

  it('falls back to a code block when the yaml will not parse', () => {
    const tree = transform('---\n: : :\n---\n');
    expect(tree.children[0].type).toBe('code');
    expect((tree.children[0] as any).lang).toBe('yaml');
  });

  it('leaves an empty frontmatter block out of the document entirely', () => {
    const tree = transform('---\n---\n\nBody\n');
    expect(tree.children.map(n => n.type)).toEqual(['paragraph']);
  });

  it('ignores a yaml node that is not the first child', () => {
    // Nothing else produces a mid-document yaml node, but the guard keeps the
    // transform honest if some future plugin does.
    const tree = transform('# Title\n\n---\nrun: oauth\n---\n');
    expect(tree.children.some(n => n.type === 'table')).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npm test --workspace apps/desktop -- frontmatter`
Expected: FAIL — `Failed to resolve import "./frontmatter.ts"`.

- [ ] **Step 4: Implement the transform**

```ts
// apps/desktop/src/markdown/frontmatter.ts
/**
 * Renders a document's leading YAML frontmatter as a metadata table.
 *
 * `remark-frontmatter` parses the block into a `yaml` node, and react-markdown
 * has no component key for one — so without this transform the frontmatter is
 * silently dropped. mdast-util-to-hast already knows how to turn `table` nodes
 * into `<table>`, so emitting mdast here is enough; no rehype work is needed.
 */
import type { Root, RootContent, TableCell, TableRow } from 'mdast';
import { parse as parseYaml } from 'yaml';

function cell(value: string): TableCell {
  return { type: 'tableCell', children: [{ type: 'text', value }] };
}

function row(cells: string[]): TableRow {
  return { type: 'tableRow', children: cells.map(cell) };
}

/** Scalars read as themselves; anything else as compact JSON, never "[object Object]". */
function display(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function remarkFrontmatterTable() {
  return (tree: Root): void => {
    const first = tree.children[0];
    // Only a *leading* block is frontmatter. A yaml node anywhere else is not
    // metadata about the document and is left alone.
    if (!first || first.type !== 'yaml') return;

    let parsed: unknown;
    try {
      parsed = parseYaml(first.value);
    } catch {
      // Showing the raw block beats swallowing it: whoever wrote the artifact
      // can see what failed to parse.
      const fallback: RootContent = { type: 'code', lang: 'yaml', value: first.value };
      tree.children[0] = fallback;
      return;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      tree.children.splice(0, 1);
      return;
    }

    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) {
      tree.children.splice(0, 1);
      return;
    }

    tree.children[0] = {
      type: 'table',
      align: [null, null],
      children: [row(['Key', 'Value']), ...entries.map(([key, value]) => row([key, display(value)]))],
    };
  };
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm test --workspace apps/desktop -- frontmatter`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json package-lock.json apps/desktop/src/markdown/
git commit -m "feat(desktop): render markdown frontmatter as a metadata table"
```

---

## Task 2: The pipeline and its sanitize schema

Artifacts are written by LLM CLI runners and `tauri.conf.json` sets `csp: null`, so this schema is the security boundary. Get the plugin order wrong and hostile markup renders.

**Files:**
- Create: `apps/desktop/src/markdown/pipeline.ts`
- Create: `apps/desktop/src/markdown/pipeline.test.tsx`

**Interfaces:**
- Consumes: `remarkFrontmatterTable` (Task 1).
- Produces: `REMARK_PLUGINS: PluggableList`, `REHYPE_PLUGINS: PluggableList`, `SANITIZE_SCHEMA: Schema`. Task 3 passes both arrays to `<ReactMarkdown>`; Task 14 appends the find plugin to a copy of `REHYPE_PLUGINS`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/markdown/pipeline.test.tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import { REHYPE_PLUGINS, REMARK_PLUGINS } from './pipeline.ts';

function html(markdown: string): string {
  const { container } = render(
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>{markdown}</ReactMarkdown>,
  );
  return container.innerHTML;
}

describe('markdown pipeline', () => {
  it('renders GFM tables', () => {
    expect(html('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>');
  });

  it('renders task lists as disabled checkboxes', () => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {'- [x] done\n- [ ] todo'}
      </ReactMarkdown>,
    );
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
  });

  it('renders strikethrough and autolinks', () => {
    expect(html('~~gone~~')).toContain('<del>');
    expect(html('see https://example.com now')).toContain('href="https://example.com"');
  });

  it('keeps a footnote link pointing at a target that exists', () => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {'Uses PKCE.[^1]\n\n[^1]: RFC 7636\n'}
      </ReactMarkdown>,
    );
    const link = container.querySelector('a[href^="#"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    // The whole point of clobber: [] — the anchor must resolve.
    expect(container.querySelector(link.getAttribute('href')!)).not.toBeNull();
  });

  it('gives headings a slug id', () => {
    expect(html('## The Approach')).toContain('id="the-approach"');
  });

  it('appends an anchor link to each heading', () => {
    const out = html('## The Approach');
    expect(out).toContain('href="#the-approach"');
    expect(out).toContain('mc-markdown-anchor');
  });

  it('links an in-page anchor to a heading that exists', () => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {'## The Approach\n\n[jump](#the-approach)'}
      </ReactMarkdown>,
    );
    expect(container.querySelector('#the-approach')).not.toBeNull();
  });

  it('keeps details/summary from raw HTML', () => {
    const out = html('<details><summary>More</summary>\n\nhidden\n\n</details>');
    expect(out).toContain('<details>');
    expect(out).toContain('<summary>');
  });

  it('strips a script tag from raw HTML', () => {
    // Sanitize must run AFTER raw. If it ran first the tag would survive as
    // text and rehype-raw would then parse it into a live element.
    const out = html('before<script>window.pwned = 1</script>after');
    expect(out).not.toContain('<script');
    expect(window).not.toHaveProperty('pwned');
  });

  it('strips event handlers and javascript: urls', () => {
    expect(html('<img src="x" onerror="window.pwned = 1">')).not.toContain('onerror');
    expect(html('[click](javascript:alert(1))')).not.toContain('javascript:');
  });

  it('strips an iframe', () => {
    expect(html('<iframe src="https://example.com"></iframe>')).not.toContain('<iframe');
  });

  it('leaves a relative href untouched', () => {
    // react-markdown's defaultUrlTransform only filters URLs that carry a
    // scheme, so relative targets already survive — no override needed. This
    // test exists so a future react-markdown upgrade cannot quietly break it.
    expect(html('[review](./review.md)')).toContain('href="./review.md"');
  });

  it('renders frontmatter as a table', () => {
    expect(html('---\nrun: oauth\n---\n\nBody')).toContain('<table>');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test --workspace apps/desktop -- pipeline`
Expected: FAIL — cannot resolve `./pipeline.ts`.

- [ ] **Step 3: Implement the pipeline**

```ts
// apps/desktop/src/markdown/pipeline.ts
/**
 * The remark/rehype stack, built once at module scope. Artifacts are written
 * by LLM CLI runners and tauri.conf.json sets `csp: null`, so the sanitize
 * schema below is the security boundary, not a formality.
 */
import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { remarkFrontmatterTable } from './frontmatter.ts';

export const SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'kbd', 'sub', 'sup', 'picture'],
  /*
   * hast-util-sanitize prefixes every `id` with `user-content-` but leaves
   * `href="#…"` fragments alone — and GFM footnotes already emit that prefix,
   * so the default double-prefixes the target and every in-page anchor dies.
   * Disabling it accepts a small DOM-clobbering risk in exchange for working
   * footnotes and heading anchors. Nothing in this app looks an artifact's
   * nodes up by id, which is what makes that trade safe here.
   */
  clobber: [],
};

export const REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  [remarkFrontmatter, ['yaml']],
  remarkFrontmatterTable,
];

/*
 * Order is load-bearing:
 *   rehypeRaw      parses raw HTML in the source into real nodes
 *   rehypeSanitize removes what we won't allow — must see those real nodes,
 *                  or hostile markup passes through as text and gets parsed
 *                  afterwards
 *   rehypeSlug     adds heading ids last, so they are ours rather than the
 *                  artifact author's
 */
export const REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
  rehypeSlug,
  // Runs after slug (it needs the ids) and after sanitize (so its own markup
  // isn't stripped). The anchor is hidden until the heading is hovered.
  [rehypeAutolinkHeadings, {
    behavior: 'append',
    properties: { className: 'mc-markdown-anchor', ariaLabel: 'Link to this section' },
    content: { type: 'text', value: '¶' },
  }],
];
```

`rehype-sanitize` types its options as `Options`; if that name isn't exported by the
installed version, import `Schema` from `hast-util-sanitize` instead — they are the same
shape.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test --workspace apps/desktop -- pipeline`
Expected: PASS, 13 tests.

If the footnote test fails, read the rendered `id` and `href` in the failure output before changing anything — that assertion is the canary for the `clobber` decision, and the fix is in the schema, not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/markdown/
git commit -m "feat(desktop): markdown pipeline with GFM, raw HTML and sanitization"
```

---

## Task 3: The Markdown component, its styles, and both call sites

**Files:**
- Create: `apps/desktop/src/markdown/types.ts`
- Create: `apps/desktop/src/markdown/Markdown.tsx`
- Create: `apps/desktop/src/markdown/markdown.css`
- Create: `apps/desktop/src/markdown/Markdown.test.tsx`
- Modify: `apps/desktop/src/index.css`
- Modify: `apps/desktop/src/components/FilePreview.tsx:299`
- Modify: `apps/desktop/src/components/ManualStepCard.tsx:72`

**Interfaces:**
- Consumes: `REMARK_PLUGINS`, `REHYPE_PLUGINS` (Task 2).
- Produces: `Markdown`, plus `MarkdownProps` / `DocResolution` / `FindState` from `types.ts`.
  These live in their own module rather than beside the component because `resolve.ts` and
  `MarkdownImage.tsx` both need `DocResolution` while `Markdown.tsx` imports *them* — a
  type-only cycle is erased at compile time, but the next person to need a value from one
  of those modules would create a real one. Tasks 4, 6, 7, 12, 14 each add one override inside this component; Tasks 8, 9, 11 wire the props from the pages.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/markdown/Markdown.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from './Markdown.tsx';

describe('Markdown', () => {
  it('renders markdown rather than its source', () => {
    render(<Markdown text={'# Title\n\nBody text.'} />);
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.queryByText('# Title')).not.toBeInTheDocument();
  });

  it('scopes its styles with a class so nothing else inherits them', () => {
    const { container } = render(<Markdown text="text" />);
    expect(container.querySelector('.mc-markdown')).not.toBeNull();
  });

  it('renders an empty document without crashing', () => {
    const { container } = render(<Markdown text="" />);
    expect(container.querySelector('.mc-markdown')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test --workspace apps/desktop -- Markdown`
Expected: FAIL — cannot resolve `./Markdown.tsx`.

- [ ] **Step 3: Implement the component**

```ts
// apps/desktop/src/markdown/types.ts
/** Shared types for the markdown renderer. Imports nothing, so nothing cycles. */

/** Where a relative href or src points, once the consumer has resolved it. */
export interface DocResolution {
  path: string;
  kind: 'link' | 'image';
}

/** Owned by the pane's find bar; the renderer only reads it. */
export interface FindState {
  query: string;
  /** Zero-based index of the match to scroll to and mark current. */
  activeIndex: number;
  /** Called after each render with the total number of matches. */
  onMatchCount: (total: number) => void;
}

export interface MarkdownProps {
  text: string;
  /** How a non-absolute href/src resolves. Returning null renders inert text. */
  resolve?: (target: string) => DocResolution | null;
  /** Follow an in-app link. Absent → links resolve but don't navigate. */
  onNavigate?: (path: string) => void;
  /** Load bytes for a relative image. Absent → images render as a placeholder. */
  loadImage?: (path: string) => Promise<Uint8Array>;
  /** Open an http(s) target. Absent → external links are inert. */
  openExternal?: (url: string) => void;
  /** Active find query; matches are highlighted, the current one scrolled to. */
  find?: FindState;
}
```

```tsx
// apps/desktop/src/markdown/Markdown.tsx
/**
 * The one markdown renderer in the app.
 *
 * Every capability it needs from outside — resolving a relative path,
 * navigating, loading image bytes, opening a URL — arrives as an optional
 * prop, so this component imports nothing from Tauri and nothing from the
 * app's stores, and a consumer that can't offer a capability gets inert text
 * instead of a broken affordance.
 */
import ReactMarkdown from 'react-markdown';
import { REHYPE_PLUGINS, REMARK_PLUGINS } from './pipeline.ts';
import type { MarkdownProps } from './types.ts';

export type { DocResolution, FindState, MarkdownProps } from './types.ts';

export function Markdown({ text }: MarkdownProps) {
  return (
    <div className="mc-markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
```

The unused props are deliberate: the contract lands in one place, and Tasks 4–14 fill it in. Add `/* eslint-disable @typescript-eslint/no-unused-vars */` only if the repo's lint actually complains — check before adding it.

- [ ] **Step 4: Write the styles**

```css
/* apps/desktop/src/markdown/markdown.css */
/*
 * GitHub-faithful prose, written entirely against Fluent's palette tokens so
 * it follows the app's light/dark theme with no stylesheet to swap — the same
 * reasoning as the hljs block in index.css.
 */
.mc-markdown {
  color: var(--colorNeutralForeground1);
  font-size: var(--fontSizeBase300);
  line-height: 1.6;
  overflow-wrap: break-word;
}

.mc-markdown > *:first-child { margin-top: 0; }
.mc-markdown > *:last-child { margin-bottom: 0; }

.mc-markdown h1,
.mc-markdown h2,
.mc-markdown h3,
.mc-markdown h4,
.mc-markdown h5,
.mc-markdown h6 {
  margin: 24px 0 16px;
  font-weight: var(--fontWeightSemibold);
  line-height: 1.25;
  /* Sticky page chrome must not cover a heading jumped to by anchor or find. */
  scroll-margin-top: 16px;
}

.mc-markdown h1 { font-size: var(--fontSizeHero700); }
.mc-markdown h2 { font-size: var(--fontSizeBase600); }
.mc-markdown h3 { font-size: var(--fontSizeBase500); }
.mc-markdown h4 { font-size: var(--fontSizeBase400); }
.mc-markdown h5,
.mc-markdown h6 { font-size: var(--fontSizeBase300); color: var(--colorNeutralForeground2); }

.mc-markdown h1,
.mc-markdown h2 {
  padding-bottom: 6px;
  border-bottom: 1px solid var(--colorNeutralStroke2);
}

.mc-markdown p,
.mc-markdown ul,
.mc-markdown ol,
.mc-markdown blockquote,
.mc-markdown pre,
.mc-markdown table { margin: 0 0 16px; }

.mc-markdown ul,
.mc-markdown ol { padding-left: 24px; }
.mc-markdown li + li { margin-top: 4px; }
.mc-markdown li > ul,
.mc-markdown li > ol { margin-bottom: 0; }

/* Task lists: aligned, and read-only — the file is the source of truth. */
.mc-markdown li:has(> input[type='checkbox']) { list-style: none; margin-left: -20px; }
.mc-markdown input[type='checkbox'] { margin-right: 6px; vertical-align: middle; }

.mc-markdown blockquote {
  padding: 0 16px;
  border-left: 3px solid var(--colorNeutralStroke1);
  color: var(--colorNeutralForeground2);
}

.mc-markdown a { color: var(--colorBrandForegroundLink); text-decoration: none; }
.mc-markdown a:hover { text-decoration: underline; }
/* An unresolvable target: visible, obviously not clickable. */
.mc-markdown a[data-inert='true'] {
  color: var(--colorNeutralForeground3);
  cursor: default;
  text-decoration: line-through;
}

.mc-markdown code {
  padding: 2px 5px;
  border-radius: var(--borderRadiusSmall);
  background: var(--colorNeutralBackground3);
  font-family: var(--fontFamilyMonospace);
  font-size: 0.9em;
}

.mc-markdown pre {
  padding: 12px;
  border: 1px solid var(--colorNeutralStroke2);
  border-radius: var(--borderRadiusMedium);
  background: var(--colorNeutralBackground2);
  overflow-x: auto;
}

.mc-markdown pre code { padding: 0; background: none; font-size: var(--fontSizeBase200); }

/* A wide table scrolls itself rather than scrolling the whole pane. */
.mc-markdown .mc-markdown-table-scroll { overflow-x: auto; margin-bottom: 16px; }
.mc-markdown table { border-collapse: collapse; margin-bottom: 0; }
.mc-markdown th,
.mc-markdown td { padding: 6px 13px; border: 1px solid var(--colorNeutralStroke2); text-align: left; }
.mc-markdown th { background: var(--colorNeutralBackground3); font-weight: var(--fontWeightSemibold); }

.mc-markdown hr {
  height: 1px;
  margin: 24px 0;
  border: 0;
  background: var(--colorNeutralStroke2);
}

.mc-markdown img { max-width: 100%; }

/* Heading anchors: present for the keyboard, out of the way for everyone else. */
.mc-markdown-anchor {
  margin-left: 8px;
  color: var(--colorNeutralForeground4);
  text-decoration: none;
  opacity: 0;
  transition: opacity 100ms ease;
}

.mc-markdown h1:hover .mc-markdown-anchor,
.mc-markdown h2:hover .mc-markdown-anchor,
.mc-markdown h3:hover .mc-markdown-anchor,
.mc-markdown h4:hover .mc-markdown-anchor,
.mc-markdown h5:hover .mc-markdown-anchor,
.mc-markdown h6:hover .mc-markdown-anchor,
.mc-markdown-anchor:focus-visible { opacity: 1; }

.mc-markdown .footnotes {
  margin-top: 24px;
  padding-top: 12px;
  border-top: 1px solid var(--colorNeutralStroke2);
  font-size: var(--fontSizeBase200);
  color: var(--colorNeutralForeground2);
}
```

- [ ] **Step 5: Import the styles from `index.css`**

Add as the first line of `apps/desktop/src/index.css` (CSS `@import` must precede other rules):

```css
@import './markdown/markdown.css';
```

- [ ] **Step 6: Add the table scroll wrapper**

The `.mc-markdown-table-scroll` rule needs an element. In `Markdown.tsx`, pass a `components` override:

```tsx
import type { Components } from 'react-markdown';

const COMPONENTS: Components = {
  table: ({ node, ...props }) => (
    <div className="mc-markdown-table-scroll">
      <table {...props} />
    </div>
  ),
};
```

and pass `components={COMPONENTS}` to `<ReactMarkdown>`. Defined at module scope, not inline — an inline object is a new identity on every render and remounts the whole document.

- [ ] **Step 7: Run the test and confirm it passes**

Run: `npm test --workspace apps/desktop -- Markdown`
Expected: PASS, 3 tests.

- [ ] **Step 8: Swap both call sites onto it**

In `apps/desktop/src/components/FilePreview.tsx`, replace the `react-markdown` import with `import { Markdown } from '../markdown/Markdown.tsx';` and line 299's `<ReactMarkdown>{loaded.text ?? ''}</ReactMarkdown>` with:

```tsx
<Markdown text={loaded.text ?? ''} />
```

In `apps/desktop/src/components/ManualStepCard.tsx`, the same swap for line 72:

```tsx
<Markdown text={request.instructions} />
```

- [ ] **Step 9: Run the full suite**

Run: `npm test --workspace apps/desktop`
Expected: PASS. The existing `FilePreview.test.tsx` "renders markdown rather than its source" and `ManualStepCard.test.tsx` "instructions are markdown" assertions must still hold — they are the regression net for this swap.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/markdown/ apps/desktop/src/index.css apps/desktop/src/components/FilePreview.tsx apps/desktop/src/components/ManualStepCard.tsx
git commit -m "feat(desktop): one styled markdown renderer for both surfaces"
```

---

## Task 4: Fenced code — highlighting, language chip, copy button

**Files:**
- Create: `apps/desktop/src/markdown/CodeBlock.tsx`
- Create: `apps/desktop/src/markdown/CodeBlock.test.tsx`
- Modify: `apps/desktop/src/markdown/Markdown.tsx`
- Modify: `apps/desktop/src/markdown/markdown.css`

**Interfaces:**
- Consumes: `highlightCode(code, language)` from `../files/highlight.ts` (returns escaped HTML; safe to inject).
- Produces: `CodeBlock` — `({ language, code }: { language: string; code: string }) => JSX.Element`. Task 12 renders `<Mermaid>` instead of `<CodeBlock>` when `language === 'mermaid'`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/markdown/CodeBlock.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Markdown } from './Markdown.tsx';

function renderFence(markdown: string) {
  return render(<Markdown text={markdown} />);
}

describe('code blocks', () => {
  it('highlights a fenced block by its language', () => {
    const { container } = renderFence('```ts\nconst x = 1;\n```');
    const code = container.querySelector('code.hljs');
    expect(code?.textContent).toBe('const x = 1;\n');
    // highlight.js splits tokens into spans; unhighlighted text would have none.
    expect(code?.querySelector('.hljs-keyword')).not.toBeNull();
  });

  it('labels the block with its language', () => {
    renderFence('```python\nx = 1\n```');
    expect(screen.getByText('python')).toBeInTheDocument();
  });

  it('renders an unlabelled fence as plain escaped text', () => {
    const { container } = renderFence('```\n<not-html>\n```');
    expect(container.querySelector('code')?.textContent).toBe('<not-html>\n');
    expect(container.querySelector('not-html')).toBeNull();
  });

  it('leaves inline code alone', () => {
    const { container } = renderFence('use `npm test` here');
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('npm test');
  });

  it('copies the block to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderFence('```sh\nnpm test\n```');
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('npm test\n'));
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();
  });

  it('reports a clipboard failure instead of claiming success', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    renderFence('```sh\nnpm test\n```');
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(await screen.findByRole('button', { name: /copy failed/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test --workspace apps/desktop -- CodeBlock`
Expected: FAIL — no `code.hljs`, no language label, no copy button.

- [ ] **Step 3: Implement `CodeBlock`**

```tsx
// apps/desktop/src/markdown/CodeBlock.tsx
/**
 * A fenced code block: highlighted, labelled with its language, copyable.
 *
 * Reuses files/highlight.ts rather than a second highlighter — that module
 * registers a fixed language set against the same Fluent-token colours the
 * plain-text file preview already uses.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Tooltip } from '@fluentui/react-components';
import { Copy16Regular } from '@fluentui/react-icons';
import { highlightCode } from '../files/highlight.ts';

type CopyState = 'idle' | 'copied' | 'failed';

const LABEL: Record<CopyState, string> = {
  idle: 'Copy',
  copied: 'Copied',
  failed: 'Copy failed',
};

export function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  // Reset the label after a moment, and never leave a timer running past unmount.
  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(code);
        setCopyState('copied');
      } catch {
        // A webview can refuse clipboard access; say so rather than
        // showing "Copied" over a clipboard that never changed.
        setCopyState('failed');
      }
    })();
  }, [code]);

  return (
    <div className="mc-markdown-code">
      <div className="mc-markdown-code-bar">
        {language && <span className="mc-markdown-code-lang">{language}</span>}
        <Tooltip content={LABEL[copyState]} relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<Copy16Regular />}
            aria-label={LABEL[copyState]}
            onClick={copy}
          />
        </Tooltip>
      </div>
      <pre>
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: highlightCode(code, language) }}
        />
      </pre>
    </div>
  );
}
```

`dangerouslySetInnerHTML` is safe here and only here: `highlightCode` escapes everything it doesn't recognise as a token, and it is fed the fence's plain text, not HTML.

- [ ] **Step 4: Wire it into the component overrides**

In `Markdown.tsx`, extend `COMPONENTS`:

```tsx
const COMPONENTS: Components = {
  table: ({ node, ...props }) => (
    <div className="mc-markdown-table-scroll"><table {...props} /></div>
  ),
  // A fenced block arrives as <pre><code class="language-x">. Rendering our
  // own <pre> inside CodeBlock means the wrapper <pre> has to get out of the
  // way, or the block ends up nested two deep.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className ?? '');
    const isFence = className !== undefined || String(children).includes('\n');
    if (!isFence) return <code className={className} {...props}>{children}</code>;
    return <CodeBlock language={match?.[1] ?? ''} code={String(children)} />;
  },
};
```

- [ ] **Step 5: Add the styles**

Append to `markdown.css`:

```css
.mc-markdown-code {
  position: relative;
  margin-bottom: 16px;
}

.mc-markdown-code-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  position: absolute;
  top: 4px;
  right: 4px;
  opacity: 0;
  transition: opacity 100ms ease;
}

/* Keyboard users get the bar too — hover alone would strand them. */
.mc-markdown-code:hover .mc-markdown-code-bar,
.mc-markdown-code:focus-within .mc-markdown-code-bar { opacity: 1; }

.mc-markdown-code-lang {
  color: var(--colorNeutralForeground3);
  font-family: var(--fontFamilyMonospace);
  font-size: var(--fontSizeBase100);
  text-transform: lowercase;
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm test --workspace apps/desktop -- CodeBlock`
Expected: PASS, 6 tests.

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test --workspace apps/desktop
git add apps/desktop/src/markdown/
git commit -m "feat(desktop): highlighted, labelled, copyable code fences in markdown"
```

---

## Task 5: Path resolution

Pure functions, no React and no filesystem, so the rules that decide what a link may point at are testable on their own.

**Files:**
- Create: `apps/desktop/src/markdown/resolve.ts`
- Create: `apps/desktop/src/markdown/resolve.test.ts`

**Interfaces:**
- Consumes: `parentPath`, `joinPath` from `../files/tree-model.ts`.
- Produces:
  - `isExternal(target: string): boolean`
  - `resolveInWorkspace(baseDir: string, root: string, target: string): DocResolution | null`
  - `resolveInArtifacts(artifacts: ReadonlyArray<{ name: string; path: string }>, target: string): DocResolution | null`

  Task 8 passes these to `FilePreview` as the page's `resolve` callback.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/markdown/resolve.test.ts
import { describe, expect, it } from 'vitest';
import { isExternal, resolveInArtifacts, resolveInWorkspace } from './resolve.ts';

describe('isExternal', () => {
  it('recognises the schemes we hand to the browser', () => {
    expect(isExternal('https://example.com')).toBe(true);
    expect(isExternal('http://example.com')).toBe(true);
    expect(isExternal('mailto:a@b.c')).toBe(true);
  });

  it('does not treat a relative path or fragment as external', () => {
    expect(isExternal('./review.md')).toBe(false);
    expect(isExternal('docs/plan.md')).toBe(false);
    expect(isExternal('#section')).toBe(false);
  });
});

describe('resolveInWorkspace', () => {
  const root = '/ws';

  it('resolves a sibling path', () => {
    expect(resolveInWorkspace('/ws/docs', root, './review.md'))
      .toEqual({ path: '/ws/docs/review.md', kind: 'link' });
  });

  it('resolves a parent path and normalizes the .. away', () => {
    // TauriFileSystem rejects any path containing '..', so resolution must
    // produce a clean path, not one the port will refuse.
    expect(resolveInWorkspace('/ws/docs', root, '../src/auth.ts'))
      .toEqual({ path: '/ws/src/auth.ts', kind: 'link' });
  });

  it('refuses a path that escapes the workspace root', () => {
    expect(resolveInWorkspace('/ws/docs', root, '../../etc/passwd')).toBeNull();
  });

  it('treats a root-relative target as relative to the workspace, not the disk', () => {
    expect(resolveInWorkspace('/ws/docs', root, '/src/auth.ts'))
      .toEqual({ path: '/ws/src/auth.ts', kind: 'link' });
  });

  it('drops a query string and fragment before resolving', () => {
    expect(resolveInWorkspace('/ws', root, './plan.md#approach'))
      .toEqual({ path: '/ws/plan.md', kind: 'link' });
  });

  it('decodes percent-escapes so a spaced filename resolves', () => {
    expect(resolveInWorkspace('/ws', root, './my%20plan.md'))
      .toEqual({ path: '/ws/my plan.md', kind: 'link' });
  });

  it('returns null for an in-page fragment, which is not a file at all', () => {
    expect(resolveInWorkspace('/ws', root, '#approach')).toBeNull();
  });

  it('marks a known image extension as an image', () => {
    expect(resolveInWorkspace('/ws', root, './arch.png')?.kind).toBe('image');
  });

  it('works with Windows separators', () => {
    expect(resolveInWorkspace('C:\\ws\\docs', 'C:\\ws', '../plan.md'))
      .toEqual({ path: 'C:\\ws\\plan.md', kind: 'link' });
  });
});

describe('resolveInArtifacts', () => {
  const artifacts = [{ name: 'review.md', path: '/runs/r1/review.md' }];

  it('resolves a target that names an artifact of this run', () => {
    expect(resolveInArtifacts(artifacts, './review.md'))
      .toEqual({ path: '/runs/r1/review.md', kind: 'link' });
  });

  it('matches on the bare name too', () => {
    expect(resolveInArtifacts(artifacts, 'review.md')?.path).toBe('/runs/r1/review.md');
  });

  it('refuses anything that is not an artifact of this run', () => {
    expect(resolveInArtifacts(artifacts, '../../../etc/passwd')).toBeNull();
    expect(resolveInArtifacts(artifacts, './plan.md')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test --workspace apps/desktop -- resolve`
Expected: FAIL — cannot resolve `./resolve.ts`.

- [ ] **Step 3: Implement it**

```ts
// apps/desktop/src/markdown/resolve.ts
/**
 * What a relative link or image in a markdown document is allowed to point at.
 *
 * Pure on purpose: these are the rules that decide whether a document can
 * reach a file, and they should be testable without mounting anything.
 */
import { joinPath, parentPath } from '../files/tree-model.ts';
import type { DocResolution } from './types.ts';

const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);

/** True for anything carrying a scheme — those go to the system browser. */
export function isExternal(target: string): boolean {
  return EXTERNAL_SCHEME.test(target);
}

function separatorOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

function kindOf(path: string): 'link' | 'image' {
  const ext = path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext) ? 'image' : 'link';
}

/** Strips the query and fragment, and undoes percent-encoding. */
function cleanTarget(target: string): string {
  const withoutHash = target.split('#')[0].split('?')[0];
  try {
    return decodeURIComponent(withoutHash);
  } catch {
    // A stray '%' that isn't an escape — take it literally rather than throwing.
    return withoutHash;
  }
}

/**
 * Applies `.` and `..` segments textually. The result never contains a `..`,
 * which matters: TauriFileSystem.assertNoParentTraversal rejects any path that
 * does, so an unnormalized path would be refused by the port rather than
 * resolved.
 */
function normalize(path: string, sep: string): string {
  const [head, ...rest] = path.split(/[\\/]/);
  const out: string[] = [head];
  for (const segment of rest) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join(sep);
}

/**
 * Resolves against the open document's directory, refusing anything outside
 * the workspace. A leading '/' means the workspace root, not the disk root —
 * that is what an author writing `/docs/plan.md` in a repo means.
 */
export function resolveInWorkspace(baseDir: string, root: string, target: string): DocResolution | null {
  if (target.startsWith('#')) return null;
  const cleaned = cleanTarget(target);
  if (cleaned === '') return null;

  const sep = separatorOf(root);
  const startsAtRoot = cleaned.startsWith('/') || cleaned.startsWith('\\');
  const absolute = startsAtRoot
    ? joinPath(root, cleaned.replace(/^[\\/]+/, ''))
    : joinPath(baseDir, cleaned);
  const path = normalize(absolute, sep);

  const normalizedRoot = normalize(root, sep);
  if (path !== normalizedRoot && !path.startsWith(normalizedRoot + sep)) return null;

  return { path, kind: kindOf(path) };
}

/**
 * Resolves against a run's manifest by name. Anything that is not an artifact
 * of this run is refused — the same boundary ArtifactFileSystem.nameFor
 * enforces by throwing, surfaced here so the UI can render it as inert text.
 */
export function resolveInArtifacts(
  artifacts: ReadonlyArray<{ name: string; path: string }>,
  target: string,
): DocResolution | null {
  if (target.startsWith('#')) return null;
  const cleaned = cleanTarget(target).replace(/^\.\//, '');
  const artifact = artifacts.find(a => a.name === cleaned || a.path === cleaned);
  if (!artifact) return null;
  return { path: artifact.path, kind: kindOf(artifact.path) };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test --workspace apps/desktop -- resolve`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/markdown/
git commit -m "feat(desktop): path resolution rules for markdown links"
```

---

## Task 6: Links

**Files:**
- Modify: `apps/desktop/src/markdown/Markdown.tsx`
- Create: `apps/desktop/src/markdown/links.test.tsx`

**Interfaces:**
- Consumes: `resolve`, `onNavigate`, `openExternal` from `MarkdownProps`; `isExternal` (Task 5).
- Produces: the rendered `<a>` contract that Task 8 wires up — `data-inert="true"` on an unresolvable target, `↗` on an external one.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/markdown/links.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Markdown } from './Markdown.tsx';

describe('markdown links', () => {
  it('follows a resolvable relative link in-app', () => {
    const onNavigate = vi.fn();
    const resolve = vi.fn().mockReturnValue({ path: '/ws/review.md', kind: 'link' });
    render(<Markdown text="[review](./review.md)" resolve={resolve} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('link', { name: 'review' }));
    expect(resolve).toHaveBeenCalledWith('./review.md');
    expect(onNavigate).toHaveBeenCalledWith('/ws/review.md');
  });

  it('never lets a link navigate the webview itself', () => {
    // A real navigation would replace the whole app with the target file.
    const onNavigate = vi.fn();
    render(
      <Markdown
        text="[review](./review.md)"
        resolve={() => ({ path: '/ws/review.md', kind: 'link' })}
        onNavigate={onNavigate}
      />,
    );
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    screen.getByRole('link', { name: 'review' }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens an external link in the system browser', () => {
    const openExternal = vi.fn();
    render(<Markdown text="[rfc](https://example.com/x)" openExternal={openExternal} />);
    fireEvent.click(screen.getByRole('link', { name: /rfc/ }));
    expect(openExternal).toHaveBeenCalledWith('https://example.com/x');
  });

  it('marks an unresolvable target inert instead of offering a dead link', () => {
    render(<Markdown text="[gone](./missing.md)" resolve={() => null} onNavigate={vi.fn()} />);
    const link = screen.getByText('gone');
    expect(link).toHaveAttribute('data-inert', 'true');
    expect(link).not.toHaveAttribute('href');
  });

  it('is inert when the consumer offers no capabilities at all', () => {
    render(<Markdown text="[review](./review.md) and [rfc](https://example.com)" />);
    expect(screen.getByText('review')).toHaveAttribute('data-inert', 'true');
    expect(screen.getByText('rfc')).toHaveAttribute('data-inert', 'true');
  });

  it('leaves an in-page fragment as a real anchor', () => {
    render(<Markdown text={'## Approach\n\n[jump](#approach)'} resolve={() => null} onNavigate={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'jump' })).toHaveAttribute('href', '#approach');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test --workspace apps/desktop -- links`
Expected: FAIL — links render as plain anchors with no handlers.

- [ ] **Step 3: Implement the `a` override**

`COMPONENTS` now depends on props, so it must be built inside the component and memoized. Restructure `Markdown.tsx`:

```tsx
import { useMemo } from 'react';
import type { Components } from 'react-markdown';
import { isExternal } from './resolve.ts';

export function Markdown({ text, resolve, onNavigate, loadImage, openExternal, find }: MarkdownProps) {
  const components = useMemo<Components>(() => ({
    table: ({ node, ...props }) => (
      <div className="mc-markdown-table-scroll"><table {...props} /></div>
    ),
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children, ...props }) => {
      const match = /language-(\w+)/.exec(className ?? '');
      const isFence = className !== undefined || String(children).includes('\n');
      if (!isFence) return <code className={className} {...props}>{children}</code>;
      return <CodeBlock language={match?.[1] ?? ''} code={String(children)} />;
    },
    a: ({ href, children }) => {
      // An in-page fragment is not a file; let the browser handle it.
      if (href && href.startsWith('#')) return <a href={href}>{children}</a>;

      if (href && isExternal(href)) {
        if (!openExternal) return <span data-inert="true">{children}</span>;
        return (
          <a
            href={href}
            onClick={event => { event.preventDefault(); openExternal(href); }}
          >
            {children}
            <span aria-hidden="true"> ↗</span>
          </a>
        );
      }

      const target = href ? resolve?.(href) ?? null : null;
      if (!target || !onNavigate) return <span data-inert="true">{children}</span>;
      return (
        <a
          href={href}
          onClick={event => {
            // Without preventDefault the webview navigates away from the app
            // to the file itself, and there is no way back.
            event.preventDefault();
            onNavigate(target.path);
          }}
        >
          {children}
        </a>
      );
    },
  }), [resolve, onNavigate, loadImage, openExternal]);

  return (
    <div className="mc-markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
```

The `data-inert` element is a `<span>`, not an `<a>` — an anchor without an `href` is still announced as a link by screen readers, and there is nothing to follow.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test --workspace apps/desktop -- links`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/markdown/
git commit -m "feat(desktop): navigable and externally-opened markdown links"
```

---

## Task 7: Images

**Files:**
- Modify: `apps/desktop/src/markdown/Markdown.tsx`
- Create: `apps/desktop/src/markdown/MarkdownImage.tsx`
- Create: `apps/desktop/src/markdown/images.test.tsx`

**Interfaces:**
- Consumes: `resolve`, `loadImage` from `MarkdownProps`; `mimeTypeForPath` from `../files/file-kind.ts`.
- Produces: `MarkdownImage` — `({ src, alt, resolve, loadImage })`. Task 8 supplies `loadImage` from the page's `FileSystemPort`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/markdown/images.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Markdown } from './Markdown.tsx';

const PNG_BYTES = new TextEncoder().encode('fake-png-bytes');

describe('markdown images', () => {
  it('loads a relative image through the provided loader', async () => {
    const loadImage = vi.fn().mockResolvedValue(PNG_BYTES);
    render(
      <Markdown
        text="![diagram](./arch.png)"
        resolve={() => ({ path: '/ws/arch.png', kind: 'image' })}
        loadImage={loadImage}
      />,
    );
    await waitFor(() => expect(loadImage).toHaveBeenCalledWith('/ws/arch.png'));
    const img = await screen.findByAltText('diagram');
    expect(img.getAttribute('src')).toMatch(/^blob:/);
  });

  it('leaves an http image src alone rather than routing it through the loader', async () => {
    const loadImage = vi.fn();
    render(<Markdown text="![remote](https://example.com/a.png)" loadImage={loadImage} />);
    expect(await screen.findByAltText('remote')).toHaveAttribute('src', 'https://example.com/a.png');
    expect(loadImage).not.toHaveBeenCalled();
  });

  it('shows a placeholder when the image cannot be resolved', async () => {
    render(<Markdown text="![gone](./missing.png)" resolve={() => null} loadImage={vi.fn()} />);
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
  });

  it('shows a placeholder when the read fails', async () => {
    const loadImage = vi.fn().mockRejectedValue(new Error('permission denied'));
    render(
      <Markdown
        text="![diagram](./arch.png)"
        resolve={() => ({ path: '/ws/arch.png', kind: 'image' })}
        loadImage={loadImage}
      />,
    );
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
  });

  it('revokes its object URL on unmount', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { unmount } = render(
      <Markdown
        text="![diagram](./arch.png)"
        resolve={() => ({ path: '/ws/arch.png', kind: 'image' })}
        loadImage={vi.fn().mockResolvedValue(PNG_BYTES)}
      />,
    );
    await screen.findByAltText('diagram');
    unmount();
    expect(revoke).toHaveBeenCalled();
  });
});
```

`jsdom` implements `URL.createObjectURL` only in recent versions; if it is missing, add a stub to `src/test/setup.ts` rather than changing the assertion:

```ts
if (!URL.createObjectURL) {
  let n = 0;
  URL.createObjectURL = () => `blob:mc/${n++}`;
  URL.revokeObjectURL = () => {};
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test --workspace apps/desktop -- images`
Expected: FAIL — the `src` is still `./arch.png`.

- [ ] **Step 3: Implement `MarkdownImage`**

```tsx
// apps/desktop/src/markdown/MarkdownImage.tsx
/**
 * A relative image in a markdown document, read through the consumer's
 * FileSystemPort.
 *
 * An object URL rather than a base64 data: URI — no copy of the bytes as a
 * string, and it is revoked the moment the image goes away. The MIME type
 * matters: an <img> content-sniffs raster formats but refuses to render an
 * SVG that isn't typed image/svg+xml, which is the same trap FilePreview hit.
 */
import { useEffect, useState } from 'react';
import { mimeTypeForPath } from '../files/file-kind.ts';
import type { DocResolution } from './types.ts';

/** Bigger than this and the pane is better off saying so than decoding it. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface MarkdownImageProps {
  src: string;
  alt: string;
  resolve?: (target: string) => DocResolution | null;
  loadImage?: (path: string) => Promise<Uint8Array>;
}

export function MarkdownImage({ src, alt, resolve, loadImage }: MarkdownImageProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const target = resolve?.(src) ?? null;
  const path = target?.path ?? null;

  useEffect(() => {
    if (!path || !loadImage) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    setFailed(false);

    void (async () => {
      try {
        const bytes = await loadImage(path);
        if (cancelled) return;
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: mimeTypeForPath(path) }),
        );
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, loadImage]);

  if (failed) return <span className="mc-markdown-image-missing">Could not load {alt || src}</span>;
  if (!url) return <span className="mc-markdown-image-missing">Loading {alt || src}…</span>;
  return <img src={url} alt={alt} />;
}
```

- [ ] **Step 4: Wire the `img` override**

In the `components` memo:

```tsx
    img: ({ src, alt }) => {
      const source = typeof src === 'string' ? src : '';
      // Remote images already have a usable src; only relative ones need reading.
      if (isExternal(source)) return <img src={source} alt={alt ?? ''} />;
      return <MarkdownImage src={source} alt={alt ?? ''} resolve={resolve} loadImage={loadImage} />;
    },
```

- [ ] **Step 5: Add the placeholder style**

```css
.mc-markdown-image-missing {
  display: inline-block;
  padding: 4px 8px;
  border: 1px dashed var(--colorNeutralStroke2);
  border-radius: var(--borderRadiusSmall);
  color: var(--colorNeutralForeground3);
  font-size: var(--fontSizeBase200);
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm test --workspace apps/desktop -- images`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/markdown/ apps/desktop/src/test/setup.ts
git commit -m "feat(desktop): render relative images in markdown documents"
```

---

## Task 8: Wire the resolvers into the pages

**Files:**
- Modify: `apps/desktop/src/components/FilePreview.tsx`
- Modify: `apps/desktop/src/components/ManualStepCard.tsx`
- Modify: `apps/desktop/src/pages/FilesPage.tsx:292`
- Modify: `apps/desktop/src/pages/RunDetailPage.tsx:508`
- Modify: `apps/desktop/src/files/use-file-tree.ts`
- Modify: `apps/desktop/src/main.tsx`
- Modify: `apps/desktop/src/components/FilePreview.test.tsx`
- Modify: `apps/desktop/src/pages/FilesPage.test.tsx`

**Interfaces:**
- Consumes: `resolveInWorkspace`, `resolveInArtifacts` (Task 5); `FileSystemPort` (`useFileSystem()`).
- Produces:
  - `FilePreviewProps.docContext?: { resolve, onNavigate, openExternal }`
  - `FileTreeState.expand(path: string): void` — expands every ancestor of `path` without collapsing anything.

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/src/components/FilePreview.test.tsx`:

```tsx
  it('navigates to a relative link through the page', async () => {
    const onNavigate = vi.fn();
    const fs = fsWith({ '/ws/docs/plan.md': 'see [review](./review.md)', '/ws/docs/review.md': 'ok' });
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview
          path="/ws/docs/plan.md"
          onDirtyChange={() => {}}
          docContext={{
            resolve: target => resolveInWorkspace('/ws/docs', '/ws', target),
            onNavigate,
            openExternal: () => {},
          }}
        />
      </FileSystemProvider>,
    );
    fireEvent.click(await screen.findByRole('link', { name: 'review' }));
    expect(onNavigate).toHaveBeenCalledWith('/ws/docs/review.md');
  });

  it('renders a link with no document context as inert', async () => {
    const fs = fsWith({ '/ws/plan.md': 'see [review](./review.md)' });
    renderPreview(fs, '/ws/plan.md');
    expect(await screen.findByText('review')).toHaveAttribute('data-inert', 'true');
  });
```

Add to `apps/desktop/src/pages/FilesPage.test.tsx` (follow the file's existing render helper):

```tsx
  it('opens the file a markdown link points at, and reveals it in the tree', async () => {
    const fs = new FakeFileSystem();
    fs.setFile('/ws/plan.md', 'see [review](./docs/review.md)');
    fs.setFile('/ws/docs/review.md', '# Findings');
    renderFilesPage(fs, '/ws');

    fireEvent.click(await screen.findByText('plan.md'));
    fireEvent.click(await screen.findByRole('link', { name: 'review' }));

    expect(await screen.findByRole('heading', { name: 'Findings' })).toBeInTheDocument();
    // The tree expanded to show where the reader landed.
    expect(await screen.findByText('review.md')).toBeInTheDocument();
  });

  it('asks before following a link out of an unsaved edit', async () => {
    const fs = new FakeFileSystem();
    fs.setFile('/ws/plan.md', 'see [review](./review.md)');
    fs.setFile('/ws/review.md', '# Findings');
    renderFilesPage(fs, '/ws');

    fireEvent.click(await screen.findByText('plan.md'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('link', { name: 'review' }));

    expect(await screen.findByText(/unsaved/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test --workspace apps/desktop -- FilePreview FilesPage`
Expected: FAIL — `docContext` is not a prop; links are inert.

- [ ] **Step 3: Add `docContext` to `FilePreview`**

```tsx
export interface DocContext {
  resolve: (target: string) => DocResolution | null;
  onNavigate: (path: string) => void;
  openExternal?: (url: string) => void;
}

export interface FilePreviewProps {
  // …existing props…
  /**
   * How links and images in a markdown document resolve, supplied by the page
   * that owns the navigation model. Absent → the document renders, but its
   * links are inert.
   */
  docContext?: DocContext;
}
```

and at the render site:

```tsx
      ) : loaded.kind === 'markdown' ? (
        <Markdown
          text={loaded.text ?? ''}
          resolve={docContext?.resolve}
          onNavigate={docContext?.onNavigate}
          openExternal={docContext?.openExternal}
          loadImage={loadImage}
        />
      ) : (
```

with `loadImage` reading through the port already in scope:

```tsx
  // Identity-stable so MarkdownImage's effect doesn't re-fire on every render.
  const loadImage = useCallback((imagePath: string) => fs.readFile(imagePath), [fs]);
```

- [ ] **Step 4: Add `expand` to `useFileTree`**

In `apps/desktop/src/files/use-file-tree.ts`, alongside `toggle`:

```ts
  /**
   * Expands every ancestor of `path` so it becomes visible. Unlike `toggle`,
   * this never collapses: it is used to reveal a file the reader navigated to
   * from a markdown link, where collapsing would be the opposite of the intent.
   */
  const expand = useCallback((path: string) => {
    setExpanded(current => {
      const next = new Set(current);
      let dir = parentPath(path);
      for (;;) {
        next.add(dir);
        const up = parentPath(dir);
        if (up === dir) break;
        dir = up;
      }
      return [...next];
    });
  }, []);
```

Add `expand: (path: string) => void;` to `FileTreeState` and include it in the returned object at line 220. If `setExpanded` is not the actual state setter's name in that file, use whatever it is — do not rename it.

- [ ] **Step 5: Supply the workspace context in `FilesPage`**

```tsx
  const docContext = useMemo(() => (
    root && selectedPath
      ? {
          resolve: (target: string) => resolveInWorkspace(parentPath(selectedPath), root, target),
          onNavigate: (path: string) => { tree.expand(path); select(path); },
          openExternal,
        }
      : undefined
  ), [root, selectedPath, tree, openExternal]);
```

`select` already routes through the unsaved-edits guard, which is what makes the second new test pass — do not call `setSelectedPath` directly here.

Pass `docContext={docContext}` to `<FilePreview>` at line 292.

`openExternal` here comes from a context, created in the next step — `FilesPage` is rendered by `App.tsx`, which would otherwise have to thread a prop through every page that renders a document.

```tsx
// apps/desktop/src/lib/open-external.tsx
import { createContext, useContext, type ReactNode } from 'react';

/** No-op by default so tests and non-Tauri renders need no provider. */
const OpenExternalContext = createContext<(url: string) => void>(() => {});

export function OpenExternalProvider({ open, children }: { open: (url: string) => void; children: ReactNode }) {
  return <OpenExternalContext.Provider value={open}>{children}</OpenExternalContext.Provider>;
}

export function useOpenExternal(): (url: string) => void {
  return useContext(OpenExternalContext);
}
```

- [ ] **Step 6: Inject the real implementation in `main.tsx`**

```tsx
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { OpenExternalProvider } from './lib/open-external.tsx';

// …
  <AgentClientProvider client={client}>
    <FileSystemProvider fs={fileSystem}>
      <OpenExternalProvider open={url => { void openUrl(url); }}>
        <App notifier={createTauriNotifier()} />
      </OpenExternalProvider>
    </FileSystemProvider>
  </AgentClientProvider>,
```

Confirm `shell:allow-open` is in `apps/desktop/src-tauri/capabilities/*.json`. If it is not, add it — `plugin-shell` refuses the call otherwise, and the failure is silent in the UI.

- [ ] **Step 7: Supply the artifact context in `RunDetailPage`**

```tsx
  const artifactDocContext = useMemo(() => ({
    resolve: (target: string) => resolveInArtifacts(artifacts, target),
    onNavigate: setSelectedArtifactPath,
    openExternal,
  }), [artifacts, openExternal]);
```

Pass it to the `<FilePreview>` at line 508.

- [ ] **Step 8: Wire `ManualStepCard`**

```tsx
<Markdown text={request.instructions} openExternal={useOpenExternal()} />
```

Hooks cannot be called in JSX attributes — read it at the top of the component instead:

```tsx
  const openExternal = useOpenExternal();
```

- [ ] **Step 9: Run the full suite**

Run: `npm test --workspace apps/desktop`
Expected: PASS, including the four new tests.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): wire markdown links to file and artifact navigation"
```

---

## Task 9: The preview owns its scroll, and gains a source toggle

Both pages currently wrap `FilePreview` in `overflow: auto`, so the preview cannot control scroll position — which Task 11 needs — and a find bar would scroll away with the document. Moving the scroll container inside the preview fixes both and keeps the header in place.

**Files:**
- Modify: `apps/desktop/src/components/FilePreview.tsx`
- Modify: `apps/desktop/src/pages/FilesPage.tsx:291`
- Modify: `apps/desktop/src/pages/RunDetailPage.tsx:507`
- Modify: `apps/desktop/src/components/FilePreview.test.tsx`

**Interfaces:**
- Produces: `data-testid="preview-scroll"` on the scroll container — Task 11's scroll-preservation test and Task 14's find bar both target it.

- [ ] **Step 1: Write the failing test**

```tsx
  it('offers the source without entering edit mode', async () => {
    renderPreview(fsWith({ '/ws/a.md': '# Title' }), '/ws/a.md');
    fireEvent.click(await screen.findByRole('tab', { name: 'Source' }));
    // The raw text, highlighted as markdown — and no editable field.
    await waitFor(() => expect(screen.getByTestId('preview-source').textContent).toBe('# Title'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('goes back to the rendered document', async () => {
    renderPreview(fsWith({ '/ws/a.md': '# Title' }), '/ws/a.md');
    fireEvent.click(await screen.findByRole('tab', { name: 'Source' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument();
  });

  it('offers no source toggle for a non-markdown file', async () => {
    renderPreview(fsWith({ '/ws/a.yaml': 'name: x' }), '/ws/a.yaml');
    await screen.findByText('/ws/a.yaml');
    expect(screen.queryByRole('tab', { name: 'Source' })).not.toBeInTheDocument();
  });

  it('scrolls the document rather than the page', async () => {
    renderPreview(fsWith({ '/ws/a.md': '# Title' }), '/ws/a.md');
    expect(await screen.findByTestId('preview-scroll')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test --workspace apps/desktop -- FilePreview`
Expected: FAIL — no `tab` role, no `preview-scroll`.

- [ ] **Step 3: Add the view state and the toggle**

In `FilePreview`:

```tsx
type View = 'rendered' | 'source';

// Sticky for the session rather than per file: someone who wants to read
// source usually wants it for the next file too. Module scope, not state —
// it must survive the remount that a selection change causes.
let lastView: View = 'rendered';
```

```tsx
  const [view, setView] = useState<View>(lastView);
  const showToggle = loaded?.kind === 'markdown' && !editing;
```

In the header row, before the Edit button:

```tsx
        {showToggle && (
          <TabList
            size="small"
            selectedValue={view}
            onTabSelect={(_event, data) => {
              const next = data.value as View;
              lastView = next;
              setView(next);
            }}
          >
            <Tab value="rendered">Rendered</Tab>
            <Tab value="source">Source</Tab>
          </TabList>
        )}
```

- [ ] **Step 4: Move the scroll container inside**

Replace the body of the render with a fixed header and a scrolling body:

```tsx
      <div data-testid="preview-scroll" ref={scrollRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {editing ? (
          /* …existing Textarea… */
        ) : loaded.kind === 'markdown' && view === 'rendered' ? (
          <Markdown /* …props… */ />
        ) : (
          <pre style={{ margin: 0 }} data-testid="preview-source">
            <code
              className="hljs"
              dangerouslySetInnerHTML={{
                __html: highlightCode(loaded.text ?? '', languageForPath(loaded.path)),
              }}
            />
          </pre>
        )}
      </div>
```

with `const scrollRef = useRef<HTMLDivElement>(null);` declared alongside the other refs. Note the existing `<pre style={{ overflow: 'auto' }}>` loses its own overflow — the new container handles it.

`languageForPath` returns `markdown` for a `.md` file, so the source view is highlighted as markdown with no special case.

- [ ] **Step 5: Stop the pages from scrolling**

`FilesPage.tsx:291`: `overflow: 'auto'` → `overflow: 'hidden'`, and add `display: 'flex'` so the preview can fill it.
`RunDetailPage.tsx:507`: the same change.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm test --workspace apps/desktop -- FilePreview`
Expected: PASS.

- [ ] **Step 7: Run the app and check it by eye**

Run: `npm run tauri dev --workspace apps/desktop`
Confirm: a long artifact scrolls inside the pane with the filename row staying put; no double scrollbar; the Files tree still scrolls independently.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): source view toggle and preview-owned scrolling"
```

---

## Task 10: `watchFile` on the filesystem port

**Files:**
- Modify: `apps/desktop/src/files/fs-port.ts`
- Modify: `apps/desktop/src/files/tauri-fs.ts`
- Modify: `apps/desktop/src/files/artifact-fs.ts`
- Modify: `apps/desktop/src/files/fake-fs.ts`
- Modify: `apps/desktop/src/files/artifact-fs.test.ts`

**Interfaces:**
- Produces: `FileSystemPort.watchFile(path: string, onChange: () => void): Promise<() => void>`. Task 11 is its only caller.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/files/artifact-fs.test.ts`:

```ts
  it('polls for changes to one artifact and reports them', async () => {
    vi.useFakeTimers();
    const client = fakeClient({ content: 'v1', size: 2, mtimeMs: 1 });
    const fs = new ArtifactFileSystem(client, '/ws', 'r1', [{ name: 'plan.md', path: '/runs/r1/plan.md' }]);
    const onChange = vi.fn();
    const stop = await fs.watchFile('/runs/r1/plan.md', onChange);

    await vi.advanceTimersByTimeAsync(3000);
    expect(onChange).not.toHaveBeenCalled();   // nothing changed yet

    client.setResponse({ content: 'v2', size: 2, mtimeMs: 2 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onChange).toHaveBeenCalledTimes(1);

    stop();
    client.setResponse({ content: 'v3', size: 2, mtimeMs: 3 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onChange).toHaveBeenCalledTimes(1);  // stopped means stopped
    vi.useRealTimers();
  });

  it('does not report a change for a path that is not an artifact', async () => {
    const fs = new ArtifactFileSystem(fakeClient({ content: '', size: 0, mtimeMs: 1 }), '/ws', 'r1', []);
    const stop = await fs.watchFile('/runs/r1/nope.md', vi.fn());
    expect(typeof stop).toBe('function');   // refuses quietly; never throws at a caller mid-render
  });
```

Match the file's existing `fakeClient` helper; add a `setResponse` to it if it doesn't have one.

Add to `apps/desktop/src/files/fake-fs.test.ts`:

```ts
  it('notifies a file watcher when that file is written', async () => {
    const fs = new FakeFileSystem();
    fs.setFile('/ws/a.md', 'v1');
    const onChange = vi.fn();
    await fs.watchFile('/ws/a.md', onChange);
    await fs.writeTextFile('/ws/a.md', 'v2');
    expect(onChange).toHaveBeenCalled();
  });

  it('does not notify a file watcher about a sibling', async () => {
    const fs = new FakeFileSystem();
    fs.setFile('/ws/a.md', 'v1');
    const onChange = vi.fn();
    await fs.watchFile('/ws/a.md', onChange);
    await fs.writeTextFile('/ws/b.md', 'v1');
    expect(onChange).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test --workspace apps/desktop -- fake-fs artifact-fs`
Expected: FAIL — `watchFile` is not a function.

- [ ] **Step 3: Declare it on the port**

```ts
  /**
   * Watches one file; resolves to an unwatch function. Separate from watch()
   * because the two backends answer it differently: a real filesystem watches
   * the containing directory, while the artifact adapter has no directories
   * and polls.
   */
  watchFile(path: string, onChange: () => void): Promise<() => void>;
```

- [ ] **Step 4: Implement in `TauriFileSystem`**

```ts
  async watchFile(path: string, onChange: () => void): Promise<() => void> {
    assertNoParentTraversal(path);
    /*
     * Watches the containing directory, not the file. A watch on the inode
     * dies when a writer replaces the file via write-to-temp-then-rename,
     * which is how CLI runners tend to write artifacts — and the watch would
     * go quiet with no error to notice.
     */
    return fsWatch(parentPath(path), events => {
      const touched = (Array.isArray(events) ? events : [events]) as Array<{ paths?: string[] }>;
      if (touched.some(event => event.paths?.some(p => p === path))) onChange();
    }, { recursive: false, delayMs: WATCH_DELAY_MS });
  }
```

Import `parentPath` from `./tree-model.ts`. Check the plugin's actual event payload shape against `@tauri-apps/plugin-fs` types before trusting `paths`; if the shape differs, filter on whatever field carries the path. If the payload carries no path at all, call `onChange()` for any event in the directory — a spurious re-read is harmless, since Task 11 compares mtimes before doing anything.

- [ ] **Step 5: Implement in `ArtifactFileSystem`**

```ts
  /**
   * Polls. This adapter has no directories to watch, and the run it belongs to
   * is frequently driven by another process — the same reason RunDetailPage
   * polls the manifest.
   */
  async watchFile(path: string, onChange: () => void): Promise<() => void> {
    if (!this.artifacts.some(a => a.path === path)) return () => {};
    let lastMtime: number | undefined = this.lastStatMtime.get(path);
    let stopped = false;

    const timer = setInterval(() => {
      void (async () => {
        if (stopped) return;
        try {
          const { mtimeMs } = await this.stat(path);
          if (lastMtime !== undefined && mtimeMs !== lastMtime) onChange();
          lastMtime = mtimeMs;
        } catch {
          // A run can delete or rewrite an artifact mid-flight; a failed poll
          // is not worth surfacing, and the next one may well succeed.
        }
      })();
    }, ARTIFACT_POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
```

with `const ARTIFACT_POLL_INTERVAL_MS = 2000;` at module scope.

- [ ] **Step 6: Implement in `FakeFileSystem`**

```ts
  private fileWatchers = new Map<string, Set<() => void>>();

  async watchFile(path: string, onChange: () => void): Promise<() => void> {
    const set = this.fileWatchers.get(path) ?? new Set();
    set.add(onChange);
    this.fileWatchers.set(path, set);
    return () => {
      set.delete(onChange);
      if (set.size === 0) this.fileWatchers.delete(path);
    };
  }
```

and extend the existing `notify` so a write reaches both kinds of watcher:

```ts
  private notify(path: string): void {
    for (const listener of this.watchers.get(parentPath(path)) ?? []) listener();
    for (const listener of this.fileWatchers.get(path) ?? []) listener();
  }
```

Add a matching helper for a change nothing wrote:

```ts
  /** Fires one file's watchers without a write — an external change. */
  emitFileChange(path: string): void {
    for (const listener of this.fileWatchers.get(path) ?? []) listener();
  }
```

`watcherCount()` should count both maps, or its existing assertions will understate the total.

- [ ] **Step 7: Run and confirm the tests pass**

Run: `npm test --workspace apps/desktop -- fake-fs artifact-fs`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/files/
git commit -m "feat(desktop): watchFile on the filesystem port, polled for artifacts"
```

---

## Task 11: Live refresh

**Files:**
- Modify: `apps/desktop/src/components/FilePreview.tsx`
- Modify: `apps/desktop/src/pages/FilesPage.tsx`
- Modify: `apps/desktop/src/pages/RunDetailPage.tsx`
- Modify: `apps/desktop/src/components/FilePreview.test.tsx`

**Interfaces:**
- Consumes: `watchFile` (Task 10), `data-testid="preview-scroll"` (Task 9).
- Produces: `FilePreviewProps.live?: boolean`.

- [ ] **Step 1: Write the failing tests**

```tsx
  it('re-renders when the open file changes on disk', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/plan.md" onDirtyChange={() => {}} live />
      </FileSystemProvider>,
    );
    await screen.findByRole('heading', { name: 'Draft' });

    fs.setFileSilently('/ws/plan.md', '# Draft\n\n## Testing');
    fs.emitFileChange('/ws/plan.md');

    expect(await screen.findByRole('heading', { name: 'Testing' })).toBeInTheDocument();
  });

  it('does not watch when live is off', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    renderPreview(fs, '/ws/plan.md');
    await screen.findByRole('heading', { name: 'Draft' });
    expect(fs.watcherCount()).toBe(0);
  });

  it('stops watching when the file is closed', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    const { unmount } = render(
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/plan.md" onDirtyChange={() => {}} live />
      </FileSystemProvider>,
    );
    await screen.findByRole('heading', { name: 'Draft' });
    unmount();
    await waitFor(() => expect(fs.watcherCount()).toBe(0));
  });

  it('offers to reload rather than discarding an unsaved edit', async () => {
    const fs = fsWith({ '/ws/plan.md': 'original' });
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/plan.md" onDirtyChange={() => {}} live />
      </FileSystemProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });

    fs.setFileSilently('/ws/plan.md', 'theirs');
    fs.emitFileChange('/ws/plan.md');

    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    // The draft survived: the refresh did not overwrite it.
    expect(screen.getByRole('textbox')).toHaveValue('mine');

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('theirs'));
  });

  it('holds the reader's scroll position across a refresh', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/plan.md" onDirtyChange={() => {}} live />
      </FileSystemProvider>,
    );
    const scroller = await screen.findByTestId('preview-scroll');
    // jsdom has no layout, so drive the values the component reads.
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true });
    scroller.scrollTop = 300;

    fs.setFileSilently('/ws/plan.md', '# Draft\n\nmore');
    fs.emitFileChange('/ws/plan.md');

    await screen.findByText('more');
    expect(scroller.scrollTop).toBe(300);
  });

  it('follows the end of a document it was already reading the end of', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/plan.md" onDirtyChange={() => {}} live />
      </FileSystemProvider>,
    );
    const scroller = await screen.findByTestId('preview-scroll');
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true });
    scroller.scrollTop = 800;  // pinned to the bottom

    fs.setFileSilently('/ws/plan.md', '# Draft\n\nmore');
    fs.emitFileChange('/ws/plan.md');

    await screen.findByText('more');
    expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test --workspace apps/desktop -- FilePreview`
Expected: FAIL — `live` is not a prop.

- [ ] **Step 3: Implement the watch**

In `FilePreview`, after the existing load effect:

```tsx
  /** How close to the bottom still counts as "reading the end". */
  const STICK_TO_BOTTOM_PX = 40;

  const [diskChanged, setDiskChanged] = useState(false);

  const reload = useCallback(async () => {
    if (!path) return;
    const scroller = scrollRef.current;
    const wasAtBottom = scroller
      ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= STICK_TO_BOTTOM_PX
      : false;
    const previousTop = scroller?.scrollTop ?? 0;

    try {
      const info = await fs.stat(path);
      if (info.size > MAX_PREVIEW_BYTES) return;
      const bytes = await fs.readFile(path);
      const kind = detectKind(path, bytes);
      if (kind === 'binary' || kind === 'image') return;
      const text = new TextDecoder().decode(bytes);
      setLoaded(current => (
        current && current.path === path
          ? { ...current, text, size: info.size, mtimeMs: info.mtimeMs }
          : current
      ));
      setDiskChanged(false);
    } catch {
      // A file being rewritten can vanish for an instant. Keep showing what we
      // have; the next event will bring the new contents.
      return;
    }

    // After React has painted the new text, not before.
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTop = wasAtBottom ? el.scrollHeight - el.clientHeight : previousTop;
    });
  }, [fs, path]);

  // Read through a ref: `reload` closes over `dirty`, and re-subscribing the
  // watcher on every keystroke would tear down and rebuild an inotify handle
  // (or a poll) each time.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!live || !path) return;
    let stop: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const unwatch = await fs.watchFile(path, () => {
        // Never overwrite an edit in progress — say so and let the reader decide.
        if (dirtyRef.current) setDiskChanged(true);
        else void reloadRef.current();
      });
      if (cancelled) unwatch();
      else stop = unwatch;
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [fs, path, live]);
```

Reset `setDiskChanged(false)` in the existing path-change effect alongside the other resets.

- [ ] **Step 4: Render the notice**

Above the editor, beside the existing `saveError` bar:

```tsx
      {diskChanged && (
        <MessageBar intent="warning">
          <MessageBarBody>
            This file changed on disk while you were editing it.
          </MessageBarBody>
          <MessageBarActions>
            <Button
              size="small"
              onClick={() => {
                setEditing(false);
                setDiskChanged(false);
                void reload();
              }}
            >
              Reload
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}
```

Import `MessageBarActions` from `@fluentui/react-components`.

- [ ] **Step 5: Turn it on in both pages**

`FilesPage.tsx`: `live` on the `<FilePreview>` — a file open in the Files pane should follow whatever writes it.
`RunDetailPage.tsx`: `live={isRunning}` — a finished run has nothing to poll for, and `isRunning` is already computed on that page.

- [ ] **Step 6: Run and confirm the tests pass**

Run: `npm test --workspace apps/desktop -- FilePreview`
Expected: PASS, 6 new tests.

If the scroll assertions fail because `requestAnimationFrame` hasn't run, wrap the assertion in `waitFor` rather than removing the `requestAnimationFrame` — the paint ordering is the point.

- [ ] **Step 7: Verify against a real run**

Run: `npm run tauri dev --workspace apps/desktop`, start a workflow that writes an artifact, open that artifact in the Artifacts tab while the step runs.
Confirm: the document grows without jumping to the top, and stops polling when the run finishes.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): markdown preview follows a file as a run writes it"
```

---

## Task 12: Mermaid diagrams

**Files:**
- Create: `apps/desktop/src/markdown/Mermaid.tsx`
- Create: `apps/desktop/src/markdown/Mermaid.test.tsx`
- Create: `apps/desktop/src/lib/use-dark-theme.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/markdown/Markdown.tsx`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: `CodeBlock` (Task 4) as the fallback.
- Produces: `Mermaid` — `({ code }: { code: string })`, and `useDarkTheme(): boolean`.

- [ ] **Step 1: Add the dependency**

```bash
npm install --workspace apps/desktop mermaid@^11
```

- [ ] **Step 2: Extract the dark-mode hook**

`App.tsx` computes `dark` at lines 26–43. Move it verbatim into `apps/desktop/src/lib/use-dark-theme.ts`:

```ts
/**
 * Whether the app is currently rendering dark. Extracted from App.tsx so
 * anything that has to match the theme by value rather than by CSS token —
 * mermaid, which renders an SVG with baked-in colours — can read the same
 * answer the FluentProvider does.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../state/store.ts';

export function useDarkTheme(): boolean {
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const [prefersDark, setPrefersDark] = useState(
    () => supported && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    if (!supported) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [supported]);

  const themePref = useAppStore(state => state.appState?.theme ?? 'system');
  return themePref === 'system' ? prefersDark : themePref === 'dark';
}
```

Replace the equivalent code in `App.tsx` with `const dark = useDarkTheme();`. Copy the real lines from `App.tsx` rather than trusting the sketch above — the store selector and `supported` guard must match exactly.

- [ ] **Step 3: Write the failing test**

```tsx
// apps/desktop/src/markdown/Mermaid.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Markdown } from './Markdown.tsx';

// mermaid is never loaded for real under jsdom: it needs layout APIs jsdom
// doesn't implement, and the point of the lazy import is that a document
// without a diagram never pays for it.
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="diagram"></svg>' }),
  },
}));

describe('mermaid fences', () => {
  it('renders a diagram', async () => {
    render(<Markdown text={'```mermaid\ngraph LR\n  a --> b\n```'} />);
    expect(await screen.findByTestId('diagram')).toBeInTheDocument();
  });

  it('falls back to a code block when the diagram will not parse', async () => {
    const mermaid = (await import('mermaid')).default;
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('Parse error'));
    const { container } = render(<Markdown text={'```mermaid\nnot a diagram\n```'} />);
    await waitFor(() => expect(container.querySelector('code')?.textContent).toContain('not a diagram'));
    expect(screen.getByText(/could not render this diagram/i)).toBeInTheDocument();
  });

  it('does not touch mermaid for a document with no diagram', async () => {
    const mermaid = (await import('mermaid')).default;
    vi.mocked(mermaid.render).mockClear();
    render(<Markdown text={'```ts\nconst x = 1;\n```'} />);
    expect(mermaid.render).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run and confirm failure**

Run: `npm test --workspace apps/desktop -- Mermaid`
Expected: FAIL — the fence renders as a code block.

- [ ] **Step 5: Implement `Mermaid`**

```tsx
// apps/desktop/src/markdown/Mermaid.tsx
/**
 * A ```mermaid fence, rendered as a diagram.
 *
 * mermaid is imported lazily: it is by far the heaviest dependency in the
 * app, and most documents contain no diagram at all. A diagram that fails to
 * parse falls back to the source — an artifact with a typo in it should still
 * show you what it says.
 */
import { useEffect, useId, useState } from 'react';
import { useDarkTheme } from '../lib/use-dark-theme.ts';
import { CodeBlock } from './CodeBlock.tsx';

export function Mermaid({ code }: { code: string }) {
  const dark = useDarkTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // mermaid.render needs a DOM id unique per diagram; useId gives a stable one.
  const id = `mermaid-${useId().replace(/[:]/g, '')}`;

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          // Diagram text comes from an LLM-written artifact: no click handlers,
          // no raw HTML in labels.
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
        });
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => { cancelled = true; };
  }, [code, dark, id]);

  if (failed) {
    return (
      <div>
        <div className="mc-markdown-diagram-error">Could not render this diagram.</div>
        <CodeBlock language="mermaid" code={code} />
      </div>
    );
  }
  if (!svg) return <CodeBlock language="mermaid" code={code} />;
  // The SVG is mermaid's own output, built from text it parsed itself under
  // securityLevel: 'strict' — not artifact markup passed through.
  return <div className="mc-markdown-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
```

Rendering `CodeBlock` while loading means a diagram-heavy document shows its source immediately and upgrades in place, rather than flashing empty.

- [ ] **Step 6: Route the fence**

In the `code` override in `Markdown.tsx`, before constructing `CodeBlock`:

```tsx
      const language = match?.[1] ?? '';
      if (language === 'mermaid') return <Mermaid code={String(children)} />;
      return <CodeBlock language={language} code={String(children)} />;
```

- [ ] **Step 7: Add the styles**

```css
.mc-markdown-diagram {
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid var(--colorNeutralStroke2);
  border-radius: var(--borderRadiusMedium);
  background: var(--colorNeutralBackground1);
  overflow-x: auto;
}

.mc-markdown-diagram svg { max-width: 100%; height: auto; }

.mc-markdown-diagram-error {
  margin-bottom: 4px;
  color: var(--colorPaletteRedForeground1);
  font-size: var(--fontSizeBase200);
}
```

- [ ] **Step 8: Run and confirm the tests pass**

Run: `npm test --workspace apps/desktop -- Mermaid`
Expected: PASS, 3 tests.

- [ ] **Step 9: Confirm the chunk is lazy**

Run: `npm run build --workspace apps/desktop`
Expected: mermaid appears in its own chunk, not in the entry bundle. If Vite has inlined it, the `await import('mermaid')` has been hoisted somewhere — find the static import and remove it.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src apps/desktop/package.json package-lock.json
git commit -m "feat(desktop): render mermaid diagrams in markdown, lazily"
```

---

## Task 13: The find matcher

**Files:**
- Create: `apps/desktop/src/markdown/find.ts`
- Create: `apps/desktop/src/markdown/find.test.ts`

**Interfaces:**
- Consumes: `unist-util-visit`.
- Produces: `rehypeFindHighlight` — `(options: { query: string; activeIndex: number }) => (tree: HastRoot) => void`. Task 14 appends it to the rehype plugin list.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/markdown/find.test.ts
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { rehypeFindHighlight } from './find.ts';

function highlight(html: string, query: string, activeIndex = 0): string {
  return unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeFindHighlight, { query, activeIndex })
    .use(rehypeStringify)
    .processSync(html)
    .toString();
}

describe('rehypeFindHighlight', () => {
  it('marks every match', () => {
    const out = highlight('<p>PKCE and more PKCE</p>', 'pkce');
    expect(out.match(/<mark/g)).toHaveLength(2);
  });

  it('matches case-insensitively without changing the text', () => {
    const out = highlight('<p>Pkce</p>', 'pkce');
    expect(out).toContain('>Pkce</mark>');
  });

  it('numbers matches in document order', () => {
    const out = highlight('<p>a</p><p>a</p>', 'a');
    expect(out).toContain('data-find-index="0"');
    expect(out).toContain('data-find-index="1"');
  });

  it('flags the active match and only that one', () => {
    const out = highlight('<p>a a a</p>', 'a', 1);
    expect(out.match(/data-find-active="true"/g)).toHaveLength(1);
    expect(out).toContain('data-find-index="1" data-find-active="true"');
  });

  it('leaves the tree alone for an empty query', () => {
    expect(highlight('<p>text</p>', '')).toBe('<p>text</p>');
  });

  it('does not match inside a script or style element', () => {
    // rehype-parse keeps their contents as text nodes; marking them would
    // corrupt the element.
    expect(highlight('<style>.a { color: red }</style>', 'color')).not.toContain('<mark');
  });

  it('treats regex metacharacters in the query as literal text', () => {
    expect(highlight('<p>cost is $5.00</p>', '$5.00')).toContain('<mark');
    expect(highlight('<p>plain</p>', '.*')).not.toContain('<mark');
  });

  it('splits a text node into before/match/after rather than dropping context', () => {
    expect(highlight('<p>xxPKCExx</p>', 'pkce')).toBe(
      '<p>xx<mark data-find-index="0" data-find-active="true">PKCE</mark>xx</p>',
    );
  });
});
```

`rehype-parse` and `rehype-stringify` are needed only by this test:

```bash
npm install --workspace apps/desktop --save-dev unified@^11 rehype-parse@^9 rehype-stringify@^10
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test --workspace apps/desktop -- find`
Expected: FAIL — cannot resolve `./find.ts`.

- [ ] **Step 3: Implement the plugin**

```ts
// apps/desktop/src/markdown/find.ts
/**
 * Highlights find matches by splitting text nodes in the hast tree, before
 * React ever renders it.
 *
 * The obvious implementation — walking the rendered DOM and wrapping matches
 * in <mark> — mutates nodes React owns, and React can throw when it next
 * reconciles over them. Doing it in the tree sidesteps that entirely; the
 * marks are ordinary React children.
 */
import { visit } from 'unist-util-visit';
import type { Element, Root, Text } from 'hast';

/** Their contents are text nodes but not prose; marking them corrupts the element. */
const OPAQUE = new Set(['script', 'style', 'textarea', 'title']);

function markElement(value: string, index: number, active: boolean): Element {
  return {
    type: 'element',
    tagName: 'mark',
    properties: {
      'data-find-index': String(index),
      ...(active ? { 'data-find-active': 'true' } : {}),
    },
    children: [{ type: 'text', value }],
  };
}

export function rehypeFindHighlight(options: { query: string; activeIndex: number }) {
  const { query, activeIndex } = options;

  return (tree: Root): void => {
    if (query === '') return;
    const needle = query.toLowerCase();
    let counter = 0;

    visit(tree, 'text', (node: Text, index, parent) => {
      if (index === undefined || !parent) return;
      if (parent.type === 'element' && OPAQUE.has(parent.tagName)) return;

      const haystack = node.value.toLowerCase();
      if (!haystack.includes(needle)) return;

      const parts: Array<Text | Element> = [];
      let cursor = 0;
      for (;;) {
        // indexOf, not a RegExp: a query is literal text, and a user typing
        // ".*" means those two characters.
        const at = haystack.indexOf(needle, cursor);
        if (at === -1) break;
        if (at > cursor) parts.push({ type: 'text', value: node.value.slice(cursor, at) });
        parts.push(markElement(node.value.slice(at, at + needle.length), counter, counter === activeIndex));
        counter += 1;
        cursor = at + needle.length;
      }
      if (cursor < node.value.length) parts.push({ type: 'text', value: node.value.slice(cursor) });

      parent.children.splice(index, 1, ...parts);
      // Skip past what we just inserted; visiting our own <mark> text would loop.
      return index + parts.length;
    });
  };
}
```

- [ ] **Step 4: Run and confirm the tests pass**

Run: `npm test --workspace apps/desktop -- find`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/markdown/ apps/desktop/package.json package-lock.json
git commit -m "feat(desktop): find-match highlighting for rendered markdown"
```

---

## Task 14: The find bar

**Files:**
- Create: `apps/desktop/src/markdown/FindBar.tsx`
- Create: `apps/desktop/src/markdown/FindBar.test.tsx`
- Modify: `apps/desktop/src/markdown/Markdown.tsx`
- Modify: `apps/desktop/src/components/FilePreview.tsx`
- Modify: `apps/desktop/src/markdown/markdown.css`

**Interfaces:**
- Consumes: `rehypeFindHighlight` (Task 13); `FindState` (Task 3); `data-testid="preview-scroll"` (Task 9).
- Produces: `FindBar` — `({ total, activeIndex, query, onQueryChange, onStep, onClose })`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/markdown/FindBar.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileSystemProvider } from '../files/fs-context.tsx';
import { FakeFileSystem } from '../files/fake-fs.ts';
import { FilePreview } from '../components/FilePreview.tsx';

function renderDoc(text: string) {
  const fs = new FakeFileSystem();
  fs.setFile('/ws/plan.md', text);
  return render(
    <FileSystemProvider fs={fs}>
      <FilePreview path="/ws/plan.md" onDirtyChange={() => {}} />
    </FileSystemProvider>,
  );
}

function openFind(container: HTMLElement) {
  fireEvent.keyDown(container.querySelector('[data-testid="preview-scroll"]')!, { key: 'f', ctrlKey: true });
}

describe('find in document', () => {
  it('opens on ctrl+f and counts the matches', async () => {
    const { container } = renderDoc('We use PKCE. PKCE is good. PKCE again.');
    await screen.findByText(/We use/);
    openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'PKCE' } });
    expect(await screen.findByText('1/3')).toBeInTheDocument();
  });

  it('highlights every match', async () => {
    const { container } = renderDoc('PKCE and PKCE');
    await screen.findByText(/PKCE/);
    openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'PKCE' } });
    await waitFor(() => expect(container.querySelectorAll('mark[data-find-index]')).toHaveLength(2));
  });

  it('steps forward and wraps around', async () => {
    const { container } = renderDoc('a a');
    await screen.findByText(/a a/);
    openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'a' } });
    await screen.findByText('1/2');
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('2/2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('1/2')).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    const { container } = renderDoc('nothing here');
    await screen.findByText(/nothing here/);
    openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'zzz' } });
    expect(await screen.findByText('0/0')).toBeInTheDocument();
  });

  it('closes on escape and clears the highlights', async () => {
    const { container } = renderDoc('PKCE');
    await screen.findByText('PKCE');
    openFind(container);
    const box = await screen.findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'PKCE' } });
    await waitFor(() => expect(container.querySelector('mark')).not.toBeNull());
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(container.querySelector('mark')).toBeNull());
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('searches the source view too', async () => {
    const { container } = renderDoc('# PKCE heading');
    fireEvent.click(await screen.findByRole('tab', { name: 'Source' }));
    openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'PKCE' } });
    expect(await screen.findByText('1/1')).toBeInTheDocument();
  });
});
```

The last test requires the source view to be searchable. The rendered path goes through the rehype plugin; the source path does not, so `FilePreview` must apply the same marking to the highlighted source. Reuse `rehypeFindHighlight` by running the highlighted HTML through a tiny unified pass, or — simpler and with no second pipeline — skip marking in source view and assert only the count from a plain `indexOf` scan. **Pick the second**: implement the count from the source string, and leave `<mark>` to the rendered view. Adjust the test to assert `1/1` without asserting a `<mark>`, which is what is written above.

- [ ] **Step 2: Run and confirm failure**

Run: `npm test --workspace apps/desktop -- FindBar`
Expected: FAIL — no searchbox.

- [ ] **Step 3: Implement `FindBar`**

```tsx
// apps/desktop/src/markdown/FindBar.tsx
/**
 * Find within the open document. The webview's own find is unavailable in a
 * Tauri window, so a long plan is otherwise unsearchable without reading it
 * top to bottom.
 */
import { useEffect, useRef } from 'react';
import { Button, Input, Text } from '@fluentui/react-components';
import { ChevronDown16Regular, ChevronUp16Regular, Dismiss16Regular } from '@fluentui/react-icons';

export interface FindBarProps {
  query: string;
  total: number;
  activeIndex: number;
  onQueryChange: (query: string) => void;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
}

export function FindBar({ query, total, activeIndex, onQueryChange, onStep, onClose }: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div className="mc-markdown-findbar">
      <Input
        ref={inputRef}
        type="search"
        role="searchbox"
        size="small"
        value={query}
        placeholder="Find in document"
        onChange={(_event, data) => onQueryChange(data.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); onClose(); }
          if (event.key === 'Enter') { event.preventDefault(); onStep(event.shiftKey ? -1 : 1); }
        }}
      />
      <Text size={200}>{total === 0 ? '0/0' : `${activeIndex + 1}/${total}`}</Text>
      <Button appearance="subtle" size="small" icon={<ChevronUp16Regular />} aria-label="Previous match"
        disabled={total === 0} onClick={() => onStep(-1)} />
      <Button appearance="subtle" size="small" icon={<ChevronDown16Regular />} aria-label="Next match"
        disabled={total === 0} onClick={() => onStep(1)} />
      <Button appearance="subtle" size="small" icon={<Dismiss16Regular />} aria-label="Close find"
        onClick={onClose} />
    </div>
  );
}
```

`role="searchbox"` may need to go on Fluent's `input` slot rather than the root — check what `Input` forwards, and use `input={{ role: 'searchbox' }}` if the root swallows it.

- [ ] **Step 4: Apply the plugin in `Markdown`**

The rehype list now depends on the query, so it is built per render rather than at module scope:

```tsx
  const rehypePlugins = useMemo<PluggableList>(() => (
    find && find.query
      ? [...REHYPE_PLUGINS, [rehypeFindHighlight, { query: find.query, activeIndex: find.activeIndex }]]
      : REHYPE_PLUGINS
  ), [find?.query, find?.activeIndex]);
```

Report the count and scroll to the active match after render — reading the DOM, never writing to it:

```tsx
  const containerRef = useRef<HTMLDivElement>(null);
  const onMatchCount = find?.onMatchCount;
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onMatchCount) return;
    onMatchCount(container.querySelectorAll('mark[data-find-index]').length);
    const active = container.querySelector('mark[data-find-active="true"]');
    // jsdom doesn't implement scrollIntoView; this is a real-browser nicety,
    // the same guard RunDetailPage uses for scrollTo.
    if (active && typeof (active as HTMLElement).scrollIntoView === 'function') {
      (active as HTMLElement).scrollIntoView({ block: 'center' });
    }
  }, [text, find?.query, find?.activeIndex, onMatchCount]);
```

and put `ref={containerRef}` on the `.mc-markdown` div.

- [ ] **Step 5: Own the find state in `FilePreview`**

```tsx
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findTotal, setFindTotal] = useState(0);
  const [findIndex, setFindIndex] = useState(0);

  // A new query starts from the first match, not wherever the last one ended.
  useEffect(() => { setFindIndex(0); }, [findQuery]);

  const step = useCallback((delta: 1 | -1) => {
    setFindIndex(current => (findTotal === 0 ? 0 : (current + delta + findTotal) % findTotal));
  }, [findTotal]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
  }, []);

  // Source view is a single highlighted string with no hast tree to mark, so
  // its count comes from a plain scan. Rendered view counts real <mark>s.
  const sourceMatches = useMemo(() => {
    if (view !== 'source' || findQuery === '') return 0;
    const haystack = (loaded?.text ?? '').toLowerCase();
    const needle = findQuery.toLowerCase();
    let total = 0;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) total += 1;
    return total;
  }, [view, findQuery, loaded?.text]);

  useEffect(() => {
    if (view === 'source') setFindTotal(sourceMatches);
  }, [view, sourceMatches]);
```

Open it from a `keydown` on the scroll container:

```tsx
      <div
        data-testid="preview-scroll"
        ref={scrollRef}
        tabIndex={-1}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
            event.preventDefault();
            setFindOpen(true);
          }
        }}
        style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
      >
```

and render the bar above it, inside the fixed header area so it does not scroll away:

```tsx
      {findOpen && loaded.kind === 'markdown' && !editing && (
        <FindBar
          query={findQuery}
          total={findTotal}
          activeIndex={findIndex}
          onQueryChange={setFindQuery}
          onStep={step}
          onClose={closeFind}
        />
      )}
```

Pass the state down:

```tsx
          find={findOpen ? { query: findQuery, activeIndex: findIndex, onMatchCount: setFindTotal } : undefined}
```

`onMatchCount` is `setFindTotal` — a stable setter identity, so the effect in `Markdown` doesn't re-fire on every render.

- [ ] **Step 6: Add the styles**

```css
.mc-markdown-findbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.mc-markdown mark {
  padding: 0 1px;
  border-radius: 2px;
  background: var(--colorPaletteYellowBackground2);
  color: var(--colorNeutralForeground1);
}

.mc-markdown mark[data-find-active='true'] {
  background: var(--colorPaletteDarkOrangeBackground2);
  /* The current match must be findable at a glance among the others. */
  outline: 1px solid var(--colorPaletteDarkOrangeBorderActive);
}
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npm test --workspace apps/desktop -- FindBar`
Expected: PASS, 6 tests.

- [ ] **Step 8: Run the whole suite and the build**

```bash
npm test --workspace apps/desktop
npm run build --workspace apps/desktop
```

Both must pass. `npm run build` runs `tsc -noEmit` first, so this is also the type check for everything above.

- [ ] **Step 9: Verify by hand**

Run: `npm run tauri dev --workspace apps/desktop`. Open a long markdown artifact and check: Ctrl/Cmd-F opens the bar, typing counts matches, Enter steps and scrolls, Escape clears, and the Source tab counts matches too.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): find in the open markdown document"
```

---

## Final verification

- [ ] `npm test --workspace apps/desktop` — full suite green
- [ ] `npm run build --workspace apps/desktop` — types and bundle clean, mermaid in its own chunk
- [ ] `npm test` at the repo root — nothing else in the workspace regressed
- [ ] Open `docs/design.md` in the Files page: headings, tables, fenced code and links all render
- [ ] Open a run's artifact while the run is live: it follows the writer
- [ ] Toggle the app between light and dark with a markdown document open: every colour follows, no hard-coded values
