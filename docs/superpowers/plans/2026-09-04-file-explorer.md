# File Explorer with Preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code-style **Files** tab to the Mission Control desktop app — a lazily-loaded tree of the opened workspace beside a preview pane where markdown renders by default and an Edit button reveals the raw source.

**Architecture:** Everything lives in `apps/desktop`. Filesystem access goes through `@tauri-apps/plugin-fs` from the webview, scoped at runtime to the opened workspace by one Rust command that performs no file I/O. All logic sits behind a `FileSystemPort` interface so it can be tested against an in-memory fake under vitest; only the thin `tauri-fs.ts` adapter needs a live Tauri runtime.

**Tech Stack:** TypeScript, React 18, Fluent UI v9, vitest + @testing-library/react, `@tauri-apps/plugin-fs`, `react-markdown` (already a dependency), `highlight.js` (new), Tauri 2 / Rust.

**Spec:** `docs/superpowers/specs/2026-09-04-file-explorer-design.md`

## Global Constraints

- **Only `apps/desktop/**` (plus `README.md` and these docs) may be modified.** `packages/agent`, `packages/core`, `packages/cli` and `parity/` must be left untouched — the file explorer must not couple to the agentic work.
- **No `@tauri-apps/*` import may be reachable from any module vitest loads.** The desktop vitest config is deliberately standalone to keep Tauri out of tests. `tauri-fs.ts` is imported by `main.tsx` and nothing else.
- Node ≥ 24. TypeScript strict; root `tsc --noEmit` must pass.
- Fluent UI v9 components with inline `style` props, matching the existing pages. No CSS-in-JS library, no component framework additions beyond `highlight.js`.
- Files carry a header comment explaining *why* they exist, in the style of the existing `apps/desktop/src` files.
- Full gate is `npm run verify` (root typecheck → package tests → parity → desktop vitest → desktop build → `cargo check`). Per-file test runs use `npm run test -w desktop -- <path>`.
- Commit after every task.

**Deliberate deviations from the spec** (three, each with its reason):

1. *Highlight theming.* The spec proposes swapping `highlight.js`'s `github` / `github-dark` stylesheets by theme. The desktop vitest config sets `css: false`, and importing plugin CSS through Vite's `?inline` query is fragile there. Task 6 instead adds ~20 lines of `hljs` token CSS to `index.css` written against Fluent's own colour tokens, which follows the theme automatically and needs no swap.
2. *Context menu.* The spec puts the file operations on a right-click menu **and** a toolbar. Task 9 ships the toolbar as the operating surface and makes right-click select the node, without a Fluent `Menu` popover. Every operation is reachable and tested; the popover can follow. If you want the popover in v1, say so before Task 9 — it is a contained addition, not a redesign.
3. *Watcher debounce.* The spec describes a ~150 ms trailing debounce in the tree. It lives in the adapter instead, as the fs plugin's own `delayMs` (Task 4) — one coalescing window rather than two stacked ones. `FakeFileSystem` fires watchers synchronously so tests stay deterministic.

---

### Task 1: File-kind detection (pure module)

**Files:**
- Create: `apps/desktop/src/files/file-kind.ts`
- Test: `apps/desktop/src/files/file-kind.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_PREVIEW_BYTES: number`, `type FileKind = 'markdown' | 'image' | 'text' | 'binary'`, `extensionOf(path: string): string`, `isBinary(bytes: Uint8Array): boolean`, `detectKind(path: string, bytes: Uint8Array): FileKind`, `languageForPath(path: string): string`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/files/file-kind.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectKind, extensionOf, isBinary, languageForPath, MAX_PREVIEW_BYTES } from './file-kind.ts';

const text = (s: string) => new TextEncoder().encode(s);

describe('extensionOf', () => {
  it('lowercases the extension and ignores directories in the path', () => {
    expect(extensionOf('/ws/docs/README.MD')).toBe('md');
    expect(extensionOf('/ws/no-extension')).toBe('');
    expect(extensionOf('/ws/.gitignore')).toBe('');
  });
});

describe('isBinary', () => {
  it('is true when a NUL byte appears in the first 8KB', () => {
    expect(isBinary(new Uint8Array([0x68, 0x00, 0x69]))).toBe(true);
  });

  it('is false for plain UTF-8 text, including multibyte characters', () => {
    expect(isBinary(text('hello — árvíztűrő'))).toBe(false);
  });

  it('ignores a NUL that appears only after the first 8KB', () => {
    const bytes = new Uint8Array(9000);
    bytes.fill(0x61);
    bytes[8500] = 0x00;
    expect(isBinary(bytes)).toBe(false);
  });
});

describe('detectKind', () => {
  it('treats .md and .markdown as markdown', () => {
    expect(detectKind('/ws/a.md', text('# hi'))).toBe('markdown');
    expect(detectKind('/ws/a.markdown', text('# hi'))).toBe('markdown');
  });

  it('treats known image extensions as images without sniffing their bytes', () => {
    expect(detectKind('/ws/a.png', new Uint8Array([0x89, 0x50, 0x00, 0x00]))).toBe('image');
    expect(detectKind('/ws/a.svg', text('<svg />'))).toBe('image');
  });

  it('treats NUL-containing non-image files as binary', () => {
    expect(detectKind('/ws/a.bin', new Uint8Array([0x01, 0x00, 0x02]))).toBe('binary');
  });

  it('treats everything else decodable as text', () => {
    expect(detectKind('/ws/workflow.yaml', text('name: x'))).toBe('text');
    expect(detectKind('/ws/LICENSE', text('MIT'))).toBe('text');
  });
});

describe('languageForPath', () => {
  it('maps known extensions to highlight.js language ids', () => {
    expect(languageForPath('/ws/a.ts')).toBe('typescript');
    expect(languageForPath('/ws/a.yaml')).toBe('yaml');
    expect(languageForPath('/ws/a.yml')).toBe('yaml');
    expect(languageForPath('/ws/a.rs')).toBe('rust');
  });

  it('falls back to plaintext for unknown extensions', () => {
    expect(languageForPath('/ws/LICENSE')).toBe('plaintext');
  });
});

describe('MAX_PREVIEW_BYTES', () => {
  it('matches the 2MB cap the agent applies to artifacts', () => {
    expect(MAX_PREVIEW_BYTES).toBe(2 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w desktop -- src/files/file-kind.test.ts`
Expected: FAIL — `Failed to resolve import "./file-kind.ts"`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/files/file-kind.ts`:

```ts
/**
 * Decides how a file should be previewed, from its path and its first bytes.
 *
 * Pure and React-free on purpose: this is the logic worth testing, and the
 * Files page's rendering shouldn't have to be mounted to test it.
 */

/**
 * Files above this size are never read at all — the preview reports the size
 * instead. Mirrors MAX_ARTIFACT_BYTES in packages/agent/src/handlers.ts so a
 * file the agent refuses to hand over isn't happily slurped by the webview.
 */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** How many leading bytes are sniffed for NULs when classifying a file. */
const SNIFF_BYTES = 8 * 1024;

export type FileKind = 'markdown' | 'image' | 'text' | 'binary';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);

/**
 * highlight.js language ids, deliberately a fixed map rather than
 * hljs.highlightAuto(): auto-detection is slow on large files and guesses
 * badly on short ones (a 3-line YAML file routinely comes back as Perl).
 */
const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  rs: 'rust', py: 'python', go: 'go', java: 'java', rb: 'ruby', php: 'php',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  css: 'css', scss: 'scss', html: 'xml', xml: 'xml', svg: 'xml',
  sql: 'sql', diff: 'diff', patch: 'diff', dockerfile: 'dockerfile',
  md: 'markdown', markdown: 'markdown',
};

/** Lowercased extension without the dot; '' when there isn't one (dotfiles included). */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return ''; // -1: no dot; 0: a dotfile like .gitignore
  return name.slice(dot + 1).toLowerCase();
}

/**
 * A NUL byte in the first 8KB is the same heuristic `grep` and `git` use: no
 * valid UTF-8 text contains one, and every common binary format has one early.
 */
export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

export function detectKind(path: string, bytes: Uint8Array): FileKind {
  const ext = extensionOf(path);
  // Images are decided by extension alone — sniffing would classify every PNG
  // as 'binary' and there'd be nothing left to render them with.
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (isBinary(bytes)) return 'binary';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  return 'text';
}

export function languageForPath(path: string): string {
  return LANGUAGES[extensionOf(path)] ?? 'plaintext';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w desktop -- src/files/file-kind.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/files/file-kind.ts apps/desktop/src/files/file-kind.test.ts
git commit -m "feat(desktop): classify files for preview by path and leading bytes"
```

---

### Task 2: Tree model (pure module)

**Files:**
- Create: `apps/desktop/src/files/tree-model.ts`
- Test: `apps/desktop/src/files/tree-model.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface DirEntry { name: string; isDirectory: boolean }`, `interface TreeNode { path: string; name: string; kind: 'dir' | 'file'; childrenLoaded: boolean; children?: string[]; truncated?: number; error?: string }`, `type TreeNodes = Record<string, TreeNode>`, `MAX_DIR_ENTRIES: number`, `joinPath(parent: string, name: string): string`, `parentPath(path: string): string`, `isHidden(name: string): boolean`, `applyDirListing(nodes: TreeNodes, dirPath: string, entries: DirEntry[], showHidden: boolean): TreeNodes`, `applyDirError(nodes: TreeNodes, dirPath: string, message: string): TreeNodes`, `makeRootNode(rootPath: string): TreeNodes`, `validateName(name: string): string | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/files/tree-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  applyDirError,
  applyDirListing,
  isHidden,
  joinPath,
  makeRootNode,
  MAX_DIR_ENTRIES,
  parentPath,
  validateName,
  type DirEntry,
  type TreeNodes,
} from './tree-model.ts';

const dir = (name: string): DirEntry => ({ name, isDirectory: true });
const file = (name: string): DirEntry => ({ name, isDirectory: false });

function rootWith(entries: DirEntry[], showHidden = false): TreeNodes {
  return applyDirListing(makeRootNode('/ws'), '/ws', entries, showHidden);
}

describe('joinPath / parentPath', () => {
  it('joins with the separator the parent already uses', () => {
    expect(joinPath('/ws', 'a.md')).toBe('/ws/a.md');
    expect(joinPath('C:\\ws', 'a.md')).toBe('C:\\ws\\a.md');
  });

  it('does not double the separator when the parent ends with one', () => {
    expect(joinPath('/ws/', 'a.md')).toBe('/ws/a.md');
  });

  it('returns the containing directory', () => {
    expect(parentPath('/ws/docs/a.md')).toBe('/ws/docs');
    expect(parentPath('C:\\ws\\a.md')).toBe('C:\\ws');
  });
});

describe('isHidden', () => {
  it('hides dotfiles and known heavy directories', () => {
    expect(isHidden('.git')).toBe(true);
    expect(isHidden('.env')).toBe(true);
    expect(isHidden('node_modules')).toBe(true);
    expect(isHidden('target')).toBe(true);
  });

  it('never hides .mc — it is the most relevant directory in the product', () => {
    expect(isHidden('.mc')).toBe(false);
  });

  it('does not hide ordinary names', () => {
    expect(isHidden('README.md')).toBe(false);
  });
});

describe('applyDirListing', () => {
  it('creates child nodes with directories first, then case-insensitive by name', () => {
    const nodes = rootWith([file('b.md'), dir('zeta'), file('A.md'), dir('alpha')]);
    expect(nodes['/ws'].children).toEqual(['/ws/alpha', '/ws/zeta', '/ws/A.md', '/ws/b.md']);
    expect(nodes['/ws'].childrenLoaded).toBe(true);
    expect(nodes['/ws/alpha'].kind).toBe('dir');
    expect(nodes['/ws/A.md'].kind).toBe('file');
  });

  it('filters hidden entries but keeps .mc when showHidden is false', () => {
    const nodes = rootWith([dir('.git'), dir('.mc'), dir('node_modules'), file('README.md')]);
    expect(nodes['/ws'].children).toEqual(['/ws/.mc', '/ws/README.md']);
  });

  it('keeps every entry when showHidden is true', () => {
    const nodes = rootWith([dir('.git'), dir('node_modules'), file('README.md')], true);
    expect(nodes['/ws'].children).toEqual(['/ws/.git', '/ws/node_modules', '/ws/README.md']);
  });

  it('preserves an already-loaded child subtree across a re-listing', () => {
    let nodes = rootWith([dir('docs')]);
    nodes = applyDirListing(nodes, '/ws/docs', [file('a.md')], false);
    nodes = applyDirListing(nodes, '/ws', [dir('docs'), file('new.md')], false);
    expect(nodes['/ws/docs'].childrenLoaded).toBe(true);
    expect(nodes['/ws/docs'].children).toEqual(['/ws/docs/a.md']);
    expect(nodes['/ws/docs/a.md']).toBeDefined();
  });

  it('drops a vanished child and every descendant it had', () => {
    let nodes = rootWith([dir('docs')]);
    nodes = applyDirListing(nodes, '/ws/docs', [file('a.md')], false);
    nodes = applyDirListing(nodes, '/ws', [], false);
    expect(nodes['/ws/docs']).toBeUndefined();
    expect(nodes['/ws/docs/a.md']).toBeUndefined();
    expect(nodes['/ws'].children).toEqual([]);
  });

  it('caps a huge directory and records how many were dropped', () => {
    const many = Array.from({ length: MAX_DIR_ENTRIES + 5 }, (_, i) => file(`f${String(i).padStart(5, '0')}.txt`));
    const nodes = rootWith(many);
    expect(nodes['/ws'].children).toHaveLength(MAX_DIR_ENTRIES);
    expect(nodes['/ws'].truncated).toBe(5);
  });

  it('clears a previous error when the directory becomes readable again', () => {
    let nodes = applyDirError(makeRootNode('/ws'), '/ws', 'permission denied');
    expect(nodes['/ws'].error).toBe('permission denied');
    nodes = applyDirListing(nodes, '/ws', [file('a.md')], false);
    expect(nodes['/ws'].error).toBeUndefined();
  });
});

describe('validateName', () => {
  it('accepts an ordinary file name', () => {
    expect(validateName('notes.md')).toBeNull();
  });

  it('rejects empty, dot, dot-dot, separators and NUL', () => {
    expect(validateName('')).toMatch(/name is required/i);
    expect(validateName('   ')).toMatch(/name is required/i);
    expect(validateName('.')).toMatch(/cannot be/i);
    expect(validateName('..')).toMatch(/cannot be/i);
    expect(validateName('a/b')).toMatch(/cannot contain/i);
    expect(validateName('a\\b')).toMatch(/cannot contain/i);
    expect(validateName('a\0b')).toMatch(/cannot contain/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w desktop -- src/files/tree-model.test.ts`
Expected: FAIL — `Failed to resolve import "./tree-model.ts"`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/files/tree-model.ts`:

```ts
/**
 * The Files tree as plain data: a flat path -> node map plus the pure
 * transformations the page applies to it.
 *
 * Flat rather than nested so a directory re-listing (from an expand, a
 * refresh, or a watcher event) touches one entry instead of rebuilding a
 * nested structure, and so React sees stable node identities for everything
 * that survived — which is what keeps expansion state and selection alive
 * across a refresh.
 */

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface TreeNode {
  path: string;
  name: string;
  kind: 'dir' | 'file';
  /** True once this directory's children have been listed at least once. */
  childrenLoaded: boolean;
  /** Child paths in display order; undefined until listed. */
  children?: string[];
  /** How many entries were dropped by the MAX_DIR_ENTRIES cap, if any. */
  truncated?: number;
  /** Why this directory couldn't be listed (EACCES, vanished, …). */
  error?: string;
}

export type TreeNodes = Record<string, TreeNode>;

/**
 * Rendering a directory with tens of thousands of entries locks up the
 * webview, and no one browses that list anyway — show a prefix and say how
 * many were left out.
 */
export const MAX_DIR_ENTRIES = 1000;

/**
 * Directories that are almost always noise in a workspace. `.mc` is
 * deliberately absent from the dotfile rule below — see isHidden.
 */
const NOISE_DIRS = new Set(['node_modules', 'target', 'dist', 'build', 'coverage']);

/** Never hidden despite the leading dot: it holds the workflows and runs. */
const ALWAYS_VISIBLE = new Set(['.mc']);

function separatorOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

export function joinPath(parent: string, name: string): string {
  const sep = separatorOf(parent);
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

export function parentPath(path: string): string {
  const sep = separatorOf(path);
  const index = path.lastIndexOf(sep);
  return index <= 0 ? path : path.slice(0, index);
}

export function isHidden(name: string): boolean {
  if (ALWAYS_VISIBLE.has(name)) return false;
  return name.startsWith('.') || NOISE_DIRS.has(name);
}

export function makeRootNode(rootPath: string): TreeNodes {
  return {
    [rootPath]: {
      path: rootPath,
      name: rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath,
      kind: 'dir',
      childrenLoaded: false,
    },
  };
}

/** Removes `path` and everything beneath it from the map. */
function pruneSubtree(nodes: TreeNodes, path: string): void {
  const node = nodes[path];
  if (!node) return;
  for (const child of node.children ?? []) pruneSubtree(nodes, child);
  delete nodes[path];
}

/**
 * Folds one directory listing into the map: filters, sorts, caps, adds nodes
 * for new children, keeps existing child nodes by identity (so their own
 * loaded children and expansion survive) and prunes the ones that are gone.
 */
export function applyDirListing(
  nodes: TreeNodes, dirPath: string, entries: DirEntry[], showHidden: boolean,
): TreeNodes {
  const next: TreeNodes = { ...nodes };
  const visible = showHidden ? entries.slice() : entries.filter(e => !isHidden(e.name));
  visible.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const kept = visible.slice(0, MAX_DIR_ENTRIES);
  const children = kept.map(entry => joinPath(dirPath, entry.name));
  const childSet = new Set(children);

  for (const previous of next[dirPath]?.children ?? []) {
    if (!childSet.has(previous)) pruneSubtree(next, previous);
  }

  kept.forEach((entry, index) => {
    const path = children[index];
    if (next[path]) return; // survives: keep its identity and loaded children
    next[path] = {
      path,
      name: entry.name,
      kind: entry.isDirectory ? 'dir' : 'file',
      childrenLoaded: false,
    };
  });

  const previousNode = next[dirPath];
  next[dirPath] = {
    ...(previousNode ?? { path: dirPath, name: dirPath, kind: 'dir' as const }),
    childrenLoaded: true,
    children,
    truncated: visible.length > MAX_DIR_ENTRIES ? visible.length - MAX_DIR_ENTRIES : undefined,
    error: undefined,
  };
  return next;
}

/** Records why a directory couldn't be listed, without losing the node itself. */
export function applyDirError(nodes: TreeNodes, dirPath: string, message: string): TreeNodes {
  const previous = nodes[dirPath];
  if (!previous) return nodes;
  return { ...nodes, [dirPath]: { ...previous, childrenLoaded: true, error: message } };
}

/**
 * Shared by the New file / New folder / Rename dialogs. Traversal can't
 * escape the granted scope anyway (the fs plugin stops it), but rejecting it
 * here produces a sentence a user can act on instead of a plugin error.
 */
export function validateName(name: string): string | null {
  if (name.trim().length === 0) return 'A name is required.';
  if (name === '.' || name === '..') return 'The name cannot be "." or "..".';
  if (/[/\\\0]/.test(name)) return 'The name cannot contain slashes or NUL characters.';
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w desktop -- src/files/tree-model.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/files/tree-model.ts apps/desktop/src/files/tree-model.test.ts
git commit -m "feat(desktop): tree model for the file explorer"
```

---

### Task 3: Filesystem port and in-memory fake

**Files:**
- Create: `apps/desktop/src/files/fs-port.ts`
- Create: `apps/desktop/src/files/fake-fs.ts`
- Test: `apps/desktop/src/files/fake-fs.test.ts`

**Interfaces:**
- Consumes: `DirEntry`, `joinPath`, `parentPath` from Task 2.
- Produces: `interface FileStat { size: number; mtimeMs: number; isDirectory: boolean }`, `interface FileSystemPort` (methods `ensureGranted`, `readDir`, `readFile`, `writeTextFile`, `stat`, `exists`, `mkdir`, `rename`, `remove`, `watch`), and `class FakeFileSystem implements FileSystemPort` with test helpers `setFile(path, contents)`, `setDir(path)`, `setError(path, message)`, `grantedRoots: string[]`, `watcherCount(): number`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/files/fake-fs.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { FakeFileSystem } from './fake-fs.ts';

function ws(): FakeFileSystem {
  const fs = new FakeFileSystem();
  fs.setFile('/ws/README.md', '# hi');
  fs.setFile('/ws/docs/design.md', '# design');
  fs.setDir('/ws/empty');
  return fs;
}

describe('FakeFileSystem', () => {
  it('lists only direct children, marking directories', async () => {
    expect(await ws().readDir('/ws')).toEqual([
      { name: 'README.md', isDirectory: false },
      { name: 'docs', isDirectory: true },
      { name: 'empty', isDirectory: true },
    ]);
  });

  it('round-trips file contents as bytes', async () => {
    const bytes = await ws().readFile('/ws/README.md');
    expect(new TextDecoder().decode(bytes)).toBe('# hi');
  });

  it('rejects reads of paths that do not exist', async () => {
    await expect(ws().readFile('/ws/nope.md')).rejects.toThrow(/no such file/i);
  });

  it('surfaces injected errors, so EACCES paths can be exercised', async () => {
    const fs = ws();
    fs.setError('/ws/secret', 'permission denied');
    await expect(fs.readDir('/ws/secret')).rejects.toThrow('permission denied');
  });

  it('advances mtime on write so the stale-write guard can be tested', async () => {
    const fs = ws();
    const before = await fs.stat('/ws/README.md');
    await fs.writeTextFile('/ws/README.md', '# changed');
    const after = await fs.stat('/ws/README.md');
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
    expect(new TextDecoder().decode(await fs.readFile('/ws/README.md'))).toBe('# changed');
  });

  it('notifies a directory watcher when a child changes, and stops after unwatch', async () => {
    const fs = ws();
    const onChange = vi.fn();
    const unwatch = await fs.watch('/ws', onChange);
    await fs.writeTextFile('/ws/new.md', 'x');
    expect(onChange).toHaveBeenCalledTimes(1);
    unwatch();
    expect(fs.watcherCount()).toBe(0);
    await fs.writeTextFile('/ws/other.md', 'x');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('removes a directory recursively and renames a whole subtree', async () => {
    const fs = ws();
    await fs.rename('/ws/docs', '/ws/documents');
    expect(await fs.exists('/ws/documents/design.md')).toBe(true);
    expect(await fs.exists('/ws/docs/design.md')).toBe(false);
    await fs.remove('/ws/documents', { recursive: true });
    expect(await fs.exists('/ws/documents')).toBe(false);
  });

  it('records granted roots', async () => {
    const fs = ws();
    await fs.ensureGranted('/ws');
    expect(fs.grantedRoots).toEqual(['/ws']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w desktop -- src/files/fake-fs.test.ts`
Expected: FAIL — `Failed to resolve import "./fake-fs.ts"`.

- [ ] **Step 3: Write the port interface**

Create `apps/desktop/src/files/fs-port.ts`:

```ts
/**
 * The filesystem seam for the Files page.
 *
 * Exists for the same reason agent/transport.ts does: production supplies a
 * @tauri-apps/plugin-fs implementation, tests supply an in-memory one, and no
 * component ever imports a Tauri module directly. That matters concretely —
 * apps/desktop/vitest.config.ts deliberately keeps @tauri-apps out of the
 * test graph, so a component importing the plugin would be untestable.
 */
import type { DirEntry } from './tree-model.ts';

export interface FileStat {
  size: number;
  /** Epoch milliseconds; 0 when the platform didn't report one. */
  mtimeMs: number;
  isDirectory: boolean;
}

export interface FileSystemPort {
  /**
   * Grants this process access to `root` and everything under it. Idempotent —
   * implementations memoize per root. Must be awaited before any other call
   * for paths inside that root.
   */
  ensureGranted(root: string): Promise<void>;
  readDir(path: string): Promise<DirEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeTextFile(path: string, contents: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Watches one directory non-recursively; resolves to an unwatch function. */
  watch(path: string, onChange: () => void): Promise<() => void>;
}
```

- [ ] **Step 4: Write the fake**

Create `apps/desktop/src/files/fake-fs.ts`:

```ts
/**
 * In-memory FileSystemPort for tests: a flat path -> contents map with
 * directories implied by their children, plus knobs the component tests need
 * (injected errors for EACCES paths, monotonic mtimes for the stale-write
 * guard, synchronous watcher delivery so tests don't have to wait on a
 * debounce).
 */
import type { FileStat, FileSystemPort } from './fs-port.ts';
import { parentPath, type DirEntry } from './tree-model.ts';

interface Entry {
  contents: string;
  mtimeMs: number;
}

export class FakeFileSystem implements FileSystemPort {
  private files = new Map<string, Entry>();
  private dirs = new Set<string>();
  private errors = new Map<string, string>();
  private watchers = new Map<string, Set<() => void>>();
  private clock = 1_000;

  readonly grantedRoots: string[] = [];

  /** Adds every ancestor directory of `path`, up to the filesystem root. */
  private addAncestors(path: string): void {
    let dir = parentPath(path);
    for (;;) {
      this.dirs.add(dir);
      const up = parentPath(dir);
      if (up === dir) break;
      dir = up;
    }
  }

  setFile(path: string, contents: string): void {
    this.files.set(path, { contents, mtimeMs: this.clock++ });
    this.addAncestors(path);
  }

  setDir(path: string): void {
    this.dirs.add(path);
    this.addAncestors(path);
  }

  /** Makes every operation on `path` reject with `message` (EACCES, etc.). */
  setError(path: string, message: string): void {
    this.errors.set(path, message);
  }

  watcherCount(): number {
    let total = 0;
    for (const set of this.watchers.values()) total += set.size;
    return total;
  }

  private check(path: string): void {
    const message = this.errors.get(path);
    if (message) throw new Error(message);
  }

  private notify(path: string): void {
    for (const listener of this.watchers.get(parentPath(path)) ?? []) listener();
  }

  async ensureGranted(root: string): Promise<void> {
    if (!this.grantedRoots.includes(root)) this.grantedRoots.push(root);
  }

  async readDir(path: string): Promise<DirEntry[]> {
    this.check(path);
    if (!this.dirs.has(path)) throw new Error(`no such directory: ${path}`);
    const names = new Map<string, boolean>();
    for (const filePath of this.files.keys()) {
      if (parentPath(filePath) === path) names.set(filePath.slice(path.length + 1), false);
    }
    for (const dirPath of this.dirs) {
      if (dirPath !== path && parentPath(dirPath) === path) names.set(dirPath.slice(path.length + 1), true);
    }
    return [...names.entries()]
      .map(([name, isDirectory]) => ({ name, isDirectory }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.check(path);
    const entry = this.files.get(path);
    if (!entry) throw new Error(`no such file: ${path}`);
    return new TextEncoder().encode(entry.contents);
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    this.check(path);
    this.setFile(path, contents);
    this.notify(path);
  }

  async stat(path: string): Promise<FileStat> {
    this.check(path);
    const entry = this.files.get(path);
    if (entry) {
      return { size: new TextEncoder().encode(entry.contents).length, mtimeMs: entry.mtimeMs, isDirectory: false };
    }
    if (this.dirs.has(path)) return { size: 0, mtimeMs: 0, isDirectory: true };
    throw new Error(`no such file: ${path}`);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.check(path);
    this.setDir(path);
    this.notify(path);
  }

  async rename(from: string, to: string): Promise<void> {
    this.check(from);
    for (const [path, entry] of [...this.files]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.files.delete(path);
        this.files.set(to + path.slice(from.length), entry);
      }
    }
    for (const path of [...this.dirs]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.dirs.delete(path);
        this.dirs.add(to + path.slice(from.length));
      }
    }
    this.notify(from);
    this.notify(to);
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.check(path);
    const recursive = options?.recursive ?? false;
    for (const filePath of [...this.files.keys()]) {
      if (filePath === path || (recursive && filePath.startsWith(`${path}/`))) this.files.delete(filePath);
    }
    for (const dirPath of [...this.dirs]) {
      if (dirPath === path || (recursive && dirPath.startsWith(`${path}/`))) this.dirs.delete(dirPath);
    }
    this.notify(path);
  }

  async watch(path: string, onChange: () => void): Promise<() => void> {
    const set = this.watchers.get(path) ?? new Set();
    set.add(onChange);
    this.watchers.set(path, set);
    return () => {
      set.delete(onChange);
      if (set.size === 0) this.watchers.delete(path);
    };
  }

  /** Fires a directory's watchers without any write — an external change. */
  emitChange(dirPath: string): void {
    for (const listener of this.watchers.get(dirPath) ?? []) listener();
  }

  /** Writes without notifying, to simulate a change the watcher missed. */
  setFileSilently(path: string, contents: string): void {
    this.setFile(path, contents);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w desktop -- src/files/fake-fs.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/files/fs-port.ts apps/desktop/src/files/fake-fs.ts apps/desktop/src/files/fake-fs.test.ts
git commit -m "feat(desktop): filesystem port and in-memory fake for the file explorer"
```

---

### Task 4: Tauri fs plugin, workspace scope grant, and the real adapter

**Files:**
- Modify: `apps/desktop/package.json` (add `@tauri-apps/plugin-fs`)
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`
- Create: `apps/desktop/src/files/tauri-fs.ts`

**Interfaces:**
- Consumes: `FileSystemPort`, `FileStat` (Task 3), `DirEntry` (Task 2).
- Produces: `class TauriFileSystem implements FileSystemPort` — the only module in the app that imports `@tauri-apps/plugin-fs`, imported only by `main.tsx`.

This task has no vitest coverage by design: the plugin cannot run under jsdom. It is verified by `cargo check`, `tsc`, and the manual checklist in Task 11.

- [ ] **Step 1: Add the JS dependency**

```bash
npm install @tauri-apps/plugin-fs --workspace desktop
```

- [ ] **Step 2: Add the Rust dependency**

In `apps/desktop/src-tauri/Cargo.toml`, under `[dependencies]`, after `tauri-plugin-dialog`:

```toml
tauri-plugin-fs = { version = "2", features = ["watch"] }
```

- [ ] **Step 3: Register the plugin and add the scope-granting command**

Replace the contents of `apps/desktop/src-tauri/src/lib.rs`:

```rust
// Minimal Tauri 2 app. The webview talks to the @wp/agent sidecar over stdio
// via the shell plugin (see src/agent/tauri-transport.ts); the dialog plugin
// backs the workspace folder picker; the notification plugin backs F6 desktop
// notifications (see src/lib/notifier.ts and src/components/NotificationBridge.tsx).
//
// Run artifacts are still read through the agent's readArtifact RPC, not the
// filesystem plugin — that path stays as it was. The fs plugin exists solely
// for the Files page (src/files/), and ships with an EMPTY scope: the webview
// can reach nothing on disk until the user opens a workspace and the Files
// page calls grant_workspace for it. No Rust code here reads, writes or lists
// files; the plugin enforces containment to the granted directory.
use tauri_plugin_fs::FsExt;

#[tauri::command]
fn grant_workspace(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.fs_scope()
        .allow_directory(&path, true)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![grant_workspace])
        .run(tauri::generate_context!())
        .expect("error while running Mission Control desktop app");
}
```

If `cargo check` reports that `allow_directory` returns `()` rather than a `Result` in the installed plugin version, drop the `.map_err(...)` line and keep the command returning `Result<(), String>` with `Ok(())` — the JS side's error handling is unchanged either way.

- [ ] **Step 4: Add the fs permissions with an empty scope**

In `apps/desktop/src-tauri/capabilities/default.json`, add to the `permissions` array after `"notification:default"`:

```json
    "fs:allow-read-dir",
    "fs:allow-read-file",
    "fs:allow-read-text-file",
    "fs:allow-write-text-file",
    "fs:allow-mkdir",
    "fs:allow-rename",
    "fs:allow-remove",
    "fs:allow-stat",
    "fs:allow-exists",
    "fs:allow-watch",
    "fs:allow-unwatch"
```

Do **not** add an `fs:scope` entry: the static scope stays empty and every reachable path arrives at runtime through `grant_workspace`.

- [ ] **Step 5: Write the adapter**

Create `apps/desktop/src/files/tauri-fs.ts`:

```ts
/**
 * FileSystemPort backed by @tauri-apps/plugin-fs.
 *
 * The ONLY module in the app that imports the fs plugin, and it is imported
 * only from main.tsx — apps/desktop/vitest.config.ts keeps @tauri-apps out of
 * the test graph, so anything vitest loads must go through FileSystemPort
 * instead. Kept deliberately thin (no logic beyond shape translation) because
 * it is the one piece that can't be covered by the unit tests.
 */
import { invoke } from '@tauri-apps/api/core';
import {
  exists as fsExists,
  mkdir as fsMkdir,
  readDir as fsReadDir,
  readFile as fsReadFile,
  remove as fsRemove,
  rename as fsRename,
  stat as fsStat,
  watch as fsWatch,
  writeTextFile as fsWriteTextFile,
} from '@tauri-apps/plugin-fs';
import type { FileStat, FileSystemPort } from './fs-port.ts';
import type { DirEntry } from './tree-model.ts';

/**
 * Coalescing window handed to the plugin's watcher. The tree also debounces
 * its own re-listing; this just keeps a burst of inotify events from crossing
 * the IPC boundary one at a time.
 */
const WATCH_DELAY_MS = 150;

export class TauriFileSystem implements FileSystemPort {
  private granted = new Set<string>();

  async ensureGranted(root: string): Promise<void> {
    if (this.granted.has(root)) return;
    await invoke('grant_workspace', { path: root });
    this.granted.add(root);
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const entries = await fsReadDir(path);
    return entries.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory }));
  }

  async readFile(path: string): Promise<Uint8Array> {
    return fsReadFile(path);
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    await fsWriteTextFile(path, contents);
  }

  async stat(path: string): Promise<FileStat> {
    const info = await fsStat(path);
    return {
      size: info.size,
      mtimeMs: info.mtime ? info.mtime.getTime() : 0,
      isDirectory: info.isDirectory,
    };
  }

  async exists(path: string): Promise<boolean> {
    return fsExists(path);
  }

  async mkdir(path: string): Promise<void> {
    await fsMkdir(path);
  }

  async rename(from: string, to: string): Promise<void> {
    await fsRename(from, to);
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    await fsRemove(path, { recursive: options?.recursive ?? false });
  }

  async watch(path: string, onChange: () => void): Promise<() => void> {
    return fsWatch(path, () => onChange(), { recursive: false, delayMs: WATCH_DELAY_MS });
  }
}
```

- [ ] **Step 6: Verify it compiles, both languages**

Run: `npm run build -w desktop`
Expected: PASS (tsc then vite build).

Run: `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS. A signature mismatch on `allow_directory` is the one likely failure — fix per Step 3's note.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/package.json apps/desktop/src-tauri apps/desktop/src/files/tauri-fs.ts package-lock.json
git commit -m "feat(desktop): fs plugin scoped to the opened workspace at runtime"
```

---

### Task 5: Filesystem context + the tree hook and component

**Files:**
- Create: `apps/desktop/src/files/fs-context.tsx`
- Create: `apps/desktop/src/files/use-file-tree.ts`
- Create: `apps/desktop/src/components/FileTree.tsx`
- Test: `apps/desktop/src/components/FileTree.test.tsx`

**Interfaces:**
- Consumes: `FileSystemPort` (Task 3), `TreeNodes`, `applyDirListing`, `applyDirError`, `makeRootNode` (Task 2).
- Produces:
  - `FileSystemProvider({ fs, children })`, `useFileSystem(): FileSystemPort`
  - `useFileTree(root: string | null): { nodes: TreeNodes; expanded: string[]; toggle(path: string): void; refreshDir(path: string): Promise<void>; showHidden: boolean; setShowHidden(value: boolean): void }`
  - `FileTree({ root, nodes, expanded, selectedPath, onToggle, onSelect, showHidden, onShowHiddenChange })`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/FileTree.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FakeFileSystem } from '../files/fake-fs.ts';
import { FileSystemProvider } from '../files/fs-context.tsx';
import { useFileTree } from '../files/use-file-tree.ts';
import { FileTree } from './FileTree.tsx';

function Harness({ root }: { root: string }) {
  const tree = useFileTree(root);
  return (
    <FileTree
      root={root}
      nodes={tree.nodes}
      expanded={tree.expanded}
      selectedPath={null}
      onToggle={tree.toggle}
      onSelect={() => {}}
      showHidden={tree.showHidden}
      onShowHiddenChange={tree.setShowHidden}
    />
  );
}

function renderTree(fs: FakeFileSystem, root = '/ws') {
  render(
    <FileSystemProvider fs={fs}>
      <Harness root={root} />
    </FileSystemProvider>,
  );
}

function workspace(): FakeFileSystem {
  const fs = new FakeFileSystem();
  fs.setFile('/ws/README.md', '# hi');
  fs.setFile('/ws/docs/design.md', '# design');
  fs.setFile('/ws/.mc/workflows/feature.yaml', 'name: feature');
  fs.setFile('/ws/.env', 'SECRET=1');
  fs.setFile('/ws/node_modules/left-pad/index.js', 'x');
  return fs;
}

describe('FileTree', () => {
  it('grants the workspace root before listing it', async () => {
    const fs = workspace();
    renderTree(fs);
    await waitFor(() => expect(fs.grantedRoots).toEqual(['/ws']));
  });

  it('lists the root, hiding noise but keeping .mc', async () => {
    renderTree(workspace());
    expect(await screen.findByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('.mc')).toBeInTheDocument();
    expect(screen.queryByText('.env')).not.toBeInTheDocument();
    expect(screen.queryByText('node_modules')).not.toBeInTheDocument();
  });

  it('loads a directory lazily, only when it is expanded', async () => {
    renderTree(workspace());
    await screen.findByText('docs');
    expect(screen.queryByText('design.md')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('docs'));
    expect(await screen.findByText('design.md')).toBeInTheDocument();
  });

  it('reveals hidden entries when the toggle is switched on', async () => {
    renderTree(workspace());
    await screen.findByText('README.md');
    fireEvent.click(screen.getByRole('switch', { name: /hidden/i }));
    expect(await screen.findByText('.env')).toBeInTheDocument();
    expect(screen.getByText('node_modules')).toBeInTheDocument();
  });

  it('shows an unreadable directory as an error instead of breaking the tree', async () => {
    const fs = workspace();
    fs.setDir('/ws/secret');
    fs.setError('/ws/secret', 'permission denied');
    renderTree(fs);
    fireEvent.click(await screen.findByText('secret'));
    expect(await screen.findByText(/permission denied/i)).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w desktop -- src/components/FileTree.test.tsx`
Expected: FAIL — `Failed to resolve import "../files/fs-context.tsx"`.

- [ ] **Step 3: Write the context**

Create `apps/desktop/src/files/fs-context.tsx`:

```tsx
/**
 * Provides the one FileSystemPort instance to the Files page, mirroring
 * agent-context.tsx: production (main.tsx) supplies TauriFileSystem, tests
 * supply FakeFileSystem, and no component constructs either itself.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { FileSystemPort } from './fs-port.ts';

const FileSystemContext = createContext<FileSystemPort | null>(null);

export function FileSystemProvider({ fs, children }: { fs: FileSystemPort; children: ReactNode }) {
  return <FileSystemContext.Provider value={fs}>{children}</FileSystemContext.Provider>;
}

export function useFileSystem(): FileSystemPort {
  const fs = useContext(FileSystemContext);
  if (!fs) throw new Error('useFileSystem() must be used within a FileSystemProvider');
  return fs;
}
```

- [ ] **Step 4: Write the tree hook**

Create `apps/desktop/src/files/use-file-tree.ts`:

```ts
/**
 * Owns the Files page's tree state: what's listed, what's expanded, and the
 * lazy directory reads that fill it in.
 *
 * State lives here rather than in the zustand store because nothing outside
 * this page consumes it. `showHidden` persists in localStorage rather than
 * through the agent's setUiState RPC, which would mean extending the agent
 * protocol for a desktop-only preference.
 */
import { useCallback, useEffect, useState } from 'react';
import { useFileSystem } from './fs-context.tsx';
import {
  applyDirError, applyDirListing, makeRootNode, type TreeNodes,
} from './tree-model.ts';

const SHOW_HIDDEN_KEY = 'mc.files.showHidden';

function readShowHidden(): boolean {
  try {
    return localStorage.getItem(SHOW_HIDDEN_KEY) === 'true';
  } catch {
    return false; // private mode / storage disabled: the default is fine
  }
}

export interface FileTreeState {
  nodes: TreeNodes;
  expanded: string[];
  toggle: (path: string) => void;
  refreshDir: (path: string) => Promise<void>;
  showHidden: boolean;
  setShowHidden: (value: boolean) => void;
}

export function useFileTree(root: string | null): FileTreeState {
  const fs = useFileSystem();
  const [nodes, setNodes] = useState<TreeNodes>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [showHidden, setShowHiddenState] = useState(readShowHidden);

  const listDir = useCallback(async (dirPath: string, hidden: boolean) => {
    try {
      const entries = await fs.readDir(dirPath);
      setNodes(current => applyDirListing(current, dirPath, entries, hidden));
    } catch (e) {
      setNodes(current => applyDirError(current, dirPath, e instanceof Error ? e.message : String(e)));
    }
  }, [fs]);

  // Root changes (or first mount): grant access, then list it. The grant is
  // deliberately here rather than in openWorkspace() — startup restore sets
  // workspacePath without going through that function, and doing it here also
  // means nothing is granted until the user actually opens the Files tab.
  useEffect(() => {
    if (!root) {
      setNodes({});
      setExpanded([]);
      return;
    }
    let cancelled = false;
    setNodes(makeRootNode(root));
    setExpanded([root]);
    void (async () => {
      try {
        await fs.ensureGranted(root);
      } catch (e) {
        if (!cancelled) {
          setNodes(current => applyDirError(current, root, e instanceof Error ? e.message : String(e)));
        }
        return;
      }
      if (!cancelled) await listDir(root, showHidden);
    })();
    return () => {
      cancelled = true;
    };
    // showHidden is handled by its own effect below; re-running this one on a
    // toggle would collapse the whole tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, fs, listDir]);

  const refreshDir = useCallback(async (dirPath: string) => {
    await listDir(dirPath, showHidden);
  }, [listDir, showHidden]);

  const toggle = useCallback((path: string) => {
    setExpanded(current => {
      if (current.includes(path)) return current.filter(p => p !== path);
      void listDir(path, showHidden);
      return [...current, path];
    });
  }, [listDir, showHidden]);

  const setShowHidden = useCallback((value: boolean) => {
    setShowHiddenState(value);
    try {
      localStorage.setItem(SHOW_HIDDEN_KEY, String(value));
    } catch {
      // storage disabled: the toggle still works for this session
    }
  }, []);

  // Re-list every currently-expanded directory when the filter flips, so the
  // change is visible without collapsing and re-expanding by hand.
  const [appliedHidden, setAppliedHidden] = useState(showHidden);
  useEffect(() => {
    if (appliedHidden === showHidden) return;
    setAppliedHidden(showHidden);
    for (const path of expanded) void listDir(path, showHidden);
  }, [showHidden, appliedHidden, expanded, listDir]);

  return { nodes, expanded, toggle, refreshDir, showHidden, setShowHidden };
}
```

- [ ] **Step 5: Write the tree component**

Create `apps/desktop/src/components/FileTree.tsx`:

```tsx
/**
 * Presentational tree for the Files page: renders the flat node map from
 * use-file-tree as a Fluent v9 Tree (which brings keyboard navigation and
 * the treeitem/aria wiring with it). Owns no data — the page passes state
 * down so the same nodes drive the preview pane and the operations menu.
 */
import { Fragment } from 'react';
import { Switch, Text, Tree, TreeItem, TreeItemLayout } from '@fluentui/react-components';
import { Document20Regular, Folder20Regular } from '@fluentui/react-icons';
import type { TreeNodes } from '../files/tree-model.ts';

export interface FileTreeProps {
  root: string;
  nodes: TreeNodes;
  expanded: string[];
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  showHidden: boolean;
  onShowHiddenChange: (value: boolean) => void;
}

function NodeRows({
  paths, nodes, selectedPath, onToggle, onSelect,
}: {
  paths: string[];
  nodes: TreeNodes;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {paths.map(path => {
        const node = nodes[path];
        if (!node) return null;
        if (node.kind === 'file') {
          return (
            <TreeItem key={path} itemType="leaf" value={path}>
              <TreeItemLayout
                iconBefore={<Document20Regular />}
                onClick={() => onSelect(path)}
                style={{
                  background: selectedPath === path ? 'var(--colorNeutralBackground1Selected)' : undefined,
                }}
              >
                {node.name}
              </TreeItemLayout>
            </TreeItem>
          );
        }
        return (
          <TreeItem key={path} itemType="branch" value={path}>
            <TreeItemLayout iconBefore={<Folder20Regular />} onClick={() => onSelect(path)}>
              {node.name}
            </TreeItemLayout>
            <Tree>
              {node.error ? (
                <TreeItem itemType="leaf" value={`${path}::error`}>
                  <TreeItemLayout>
                    <Text size={200}>Could not open this folder: {node.error}</Text>
                  </TreeItemLayout>
                </TreeItem>
              ) : (
                <Fragment>
                  <NodeRows
                    paths={node.children ?? []}
                    nodes={nodes}
                    selectedPath={selectedPath}
                    onToggle={onToggle}
                    onSelect={onSelect}
                  />
                  {node.truncated ? (
                    <TreeItem itemType="leaf" value={`${path}::truncated`}>
                      <TreeItemLayout>
                        <Text size={200}>…and {node.truncated} more</Text>
                      </TreeItemLayout>
                    </TreeItem>
                  ) : null}
                </Fragment>
              )}
            </Tree>
          </TreeItem>
        );
      })}
    </>
  );
}

export function FileTree(props: FileTreeProps) {
  const { root, nodes, expanded, selectedPath, onToggle, onSelect, showHidden, onShowHiddenChange } = props;
  const rootNode = nodes[root];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '0 8px 8px' }}>
        <Switch
          checked={showHidden}
          onChange={(_event, data) => onShowHiddenChange(data.checked)}
          label="Show hidden files"
        />
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <Tree
          aria-label="Workspace files"
          openItems={expanded}
          onOpenChange={(_event, data) => onToggle(data.value as string)}
        >
          {rootNode?.error ? (
            <Text size={200}>Could not open this folder: {rootNode.error}</Text>
          ) : (
            <NodeRows
              paths={rootNode?.children ?? []}
              nodes={nodes}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          )}
        </Tree>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test -w desktop -- src/components/FileTree.test.tsx`
Expected: PASS, 5 tests.

If Fluent's `Tree` proves awkward under jsdom (for instance `onOpenChange` not firing from a click on `TreeItemLayout`), adapt the test to click the item's expand button (`screen.getByRole('treeitem', { name: /docs/ })` then `fireEvent.click`) rather than changing the component's structure — the accessible tree markup is the point.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/files/fs-context.tsx apps/desktop/src/files/use-file-tree.ts apps/desktop/src/components/FileTree.tsx apps/desktop/src/components/FileTree.test.tsx
git commit -m "feat(desktop): lazy workspace file tree"
```

---

### Task 6: Read-only preview pane

**Files:**
- Modify: `apps/desktop/package.json` (add `highlight.js`)
- Create: `apps/desktop/src/files/highlight.ts`
- Create: `apps/desktop/src/components/FilePreview.tsx`
- Modify: `apps/desktop/src/index.css` (hljs token colours)
- Test: `apps/desktop/src/components/FilePreview.test.tsx`

**Interfaces:**
- Consumes: `useFileSystem` (Task 5), `detectKind`, `languageForPath`, `MAX_PREVIEW_BYTES` (Task 1).
- Produces: `highlightCode(code: string, language: string): string` (returns HTML), `FilePreview({ path, onDirtyChange })` — `onDirtyChange` is accepted now and used in Task 7; this task renders read-only.

- [ ] **Step 1: Add the dependency**

```bash
npm install highlight.js --workspace desktop
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/components/FilePreview.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FakeFileSystem } from '../files/fake-fs.ts';
import { FileSystemProvider } from '../files/fs-context.tsx';
import { FilePreview } from './FilePreview.tsx';

function renderPreview(fs: FakeFileSystem, path: string) {
  return render(
    <FileSystemProvider fs={fs}>
      <FilePreview path={path} onDirtyChange={() => {}} />
    </FileSystemProvider>,
  );
}

function fsWith(files: Record<string, string>): FakeFileSystem {
  const fs = new FakeFileSystem();
  for (const [path, contents] of Object.entries(files)) fs.setFile(path, contents);
  return fs;
}

describe('FilePreview', () => {
  it('renders markdown rather than its source', async () => {
    renderPreview(fsWith({ '/ws/a.md': '# Title\n\nBody text.' }), '/ws/a.md');
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('Body text.')).toBeInTheDocument();
    expect(screen.queryByText('# Title')).not.toBeInTheDocument();
  });

  it('renders other text files as code', async () => {
    // Asserted on textContent, not findByText: highlight.js splits the line
    // into <span>s, so no single text node holds the whole string.
    const { container } = renderPreview(fsWith({ '/ws/workflow.yaml': 'name: feature' }), '/ws/workflow.yaml');
    await waitFor(() => expect(container.querySelector('code.hljs')?.textContent).toBe('name: feature'));
  });

  it('reports binary files instead of rendering them', async () => {
    const fs = fsWith({});
    fs.setFile('/ws/blob.bin', 'ab\0cd');
    renderPreview(fs, '/ws/blob.bin');
    expect(await screen.findByText(/binary file/i)).toBeInTheDocument();
  });

  it('refuses to read a file over the preview cap', async () => {
    const fs = fsWith({ '/ws/huge.log': 'x'.repeat(2 * 1024 * 1024 + 1) });
    renderPreview(fs, '/ws/huge.log');
    expect(await screen.findByText(/too large to preview/i)).toBeInTheDocument();
  });

  it('surfaces a read failure without crashing', async () => {
    const fs = fsWith({ '/ws/secret.md': 'x' });
    fs.setError('/ws/secret.md', 'permission denied');
    renderPreview(fs, '/ws/secret.md');
    expect(await screen.findByText(/permission denied/i)).toBeInTheDocument();
  });

  it('shows an empty state when no file is selected', () => {
    render(
      <FileSystemProvider fs={fsWith({})}>
        <FilePreview path={null} onDirtyChange={() => {}} />
      </FileSystemProvider>,
    );
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -w desktop -- src/components/FilePreview.test.tsx`
Expected: FAIL — `Failed to resolve import "./FilePreview.tsx"`.

- [ ] **Step 4: Write the highlighter wrapper**

Create `apps/desktop/src/files/highlight.ts`:

```ts
/**
 * highlight.js with an explicit language registry.
 *
 * Uses the /lib/core entry and registers a fixed set rather than importing
 * the full bundle (every language highlight.js ships) — the app only ever
 * asks for languages file-kind.ts can name.
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json,
  markdown, php, python, ruby, rust, scss, sql, typescript, xml, yaml,
};

for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string
  ));
}

/**
 * Returns HTML. Safe to inject: highlight.js escapes the source it wraps, and
 * the fallback path escapes it here. Unregistered languages (including
 * 'plaintext') fall through to plain escaped text rather than throwing.
 */
export function highlightCode(code: string, language: string): string {
  if (!hljs.getLanguage(language)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
```

- [ ] **Step 5: Write the preview component**

Create `apps/desktop/src/components/FilePreview.tsx`:

```tsx
/**
 * The Files page's right-hand pane: reads the selected file once and renders
 * it by kind. Markdown renders rather than showing its source — that's the
 * point of the feature; the raw text is one Edit click away (Task 7).
 */
import { useEffect, useState } from 'react';
import { MessageBar, MessageBarBody, Spinner, Text } from '@fluentui/react-components';
import ReactMarkdown from 'react-markdown';
import { useFileSystem } from '../files/fs-context.tsx';
import { detectKind, languageForPath, MAX_PREVIEW_BYTES, type FileKind } from '../files/file-kind.ts';
import { highlightCode } from '../files/highlight.ts';

interface Loaded {
  path: string;
  kind: FileKind;
  /** Decoded text for markdown/text; undefined for image and binary. */
  text?: string;
  /** Object URL for images; revoked when the preview moves on. */
  imageUrl?: string;
  size: number;
  mtimeMs: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FilePreviewProps {
  path: string | null;
  onDirtyChange: (dirty: boolean) => void;
}

export function FilePreview({ path }: FilePreviewProps) {
  const fs = useFileSystem();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tooLarge, setTooLarge] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoaded(null);
    setTooLarge(null);
    setError(null);
    if (!path) return;

    let cancelled = false;
    let objectUrl: string | undefined;
    setLoading(true);

    void (async () => {
      try {
        const info = await fs.stat(path);
        if (info.size > MAX_PREVIEW_BYTES) {
          if (!cancelled) setTooLarge(info.size);
          return;
        }
        const bytes = await fs.readFile(path);
        if (cancelled) return;
        const kind = detectKind(path, bytes);
        if (kind === 'image') {
          // An object URL rather than a base64 data: URI — no copy of the
          // bytes as a string, and it's revoked the moment we move on.
          objectUrl = URL.createObjectURL(new Blob([bytes]));
          setLoaded({ path, kind, imageUrl: objectUrl, size: info.size, mtimeMs: info.mtimeMs });
          return;
        }
        const text = kind === 'binary' ? undefined : new TextDecoder().decode(bytes);
        setLoaded({ path, kind, text, size: info.size, mtimeMs: info.mtimeMs });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, fs]);

  if (!path) return <Text>Select a file to preview it.</Text>;
  if (error) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>Could not open this file: {error}</MessageBarBody>
      </MessageBar>
    );
  }
  if (tooLarge !== null) return <Text>Too large to preview ({formatSize(tooLarge)}).</Text>;
  if (loading || !loaded) return <Spinner size="tiny" label="Opening…" />;

  if (loaded.kind === 'binary') {
    return <Text>Binary file — {formatSize(loaded.size)}. {loaded.path}</Text>;
  }
  if (loaded.kind === 'image') {
    return <img src={loaded.imageUrl} alt={loaded.path} style={{ maxWidth: '100%' }} />;
  }
  if (loaded.kind === 'markdown') {
    return <ReactMarkdown>{loaded.text ?? ''}</ReactMarkdown>;
  }
  return (
    <pre style={{ margin: 0, overflow: 'auto' }}>
      <code
        className="hljs"
        // highlightCode escapes everything it doesn't itself emit; see highlight.ts.
        dangerouslySetInnerHTML={{ __html: highlightCode(loaded.text ?? '', languageForPath(loaded.path)) }}
      />
    </pre>
  );
}
```

- [ ] **Step 6: Add theme-following highlight colours**

Append to `apps/desktop/src/index.css`:

```css
/*
 * highlight.js token colours written against Fluent's own palette tokens, so
 * they follow the app's light/dark theme with no stylesheet to swap. (The
 * shipped github/github-dark stylesheets would need a runtime swap and don't
 * survive vitest's `css: false` config.)
 */
.hljs { color: var(--colorNeutralForeground1); background: transparent; }
.hljs-comment, .hljs-quote { color: var(--colorNeutralForeground3); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type { color: var(--colorPaletteBerryForeground2); }
.hljs-string, .hljs-attr, .hljs-symbol, .hljs-bullet { color: var(--colorPaletteGreenForeground2); }
.hljs-number, .hljs-meta { color: var(--colorPaletteMarigoldForeground2); }
.hljs-title, .hljs-section, .hljs-name { color: var(--colorBrandForeground1); }
.hljs-variable, .hljs-template-variable, .hljs-attribute { color: var(--colorPaletteRedForeground2); }
.hljs-addition { color: var(--colorPaletteGreenForeground2); }
.hljs-deletion { color: var(--colorPaletteRedForeground2); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test -w desktop -- src/components/FilePreview.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/package.json apps/desktop/src/files/highlight.ts apps/desktop/src/components/FilePreview.tsx apps/desktop/src/components/FilePreview.test.tsx apps/desktop/src/index.css package-lock.json
git commit -m "feat(desktop): file preview pane with rendered markdown, images and highlighted code"
```

---

### Task 7: Editing, with the dirty and stale-write guards

**Files:**
- Modify: `apps/desktop/src/components/FilePreview.tsx`
- Test: `apps/desktop/src/components/FilePreview.test.tsx` (extend)

**Interfaces:**
- Consumes: everything from Task 6.
- Produces: `FilePreview` gains an internal edit mode and calls `onDirtyChange(dirty)` whenever unsaved-edit state changes. Its props gain `startInEditMode?: boolean` (used by Task 9's New file flow) and `reloadToken?: number` (bumped by the page to force a re-read after an external change).

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/components/FilePreview.test.tsx` (add `fireEvent` and `vi` to the existing imports; `waitFor` is already there):

```tsx
describe('FilePreview editing', () => {
  it('edits markdown as raw source and returns to the rendered view after saving', async () => {
    const fs = fsWith({ '/ws/a.md': '# Title' });
    renderPreview(fs, '/ws/a.md');
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveValue('# Title');
    fireEvent.change(textarea, { target: { value: '# Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByRole('heading', { name: 'Renamed' })).toBeInTheDocument();
    expect(new TextDecoder().decode(await fs.readFile('/ws/a.md'))).toBe('# Renamed');
  });

  it('discards edits on cancel', async () => {
    const fs = fsWith({ '/ws/a.md': '# Title' });
    renderPreview(fs, '/ws/a.md');
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'throw away' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(new TextDecoder().decode(await fs.readFile('/ws/a.md'))).toBe('# Title');
  });

  it('edits non-markdown text files too', async () => {
    const fs = fsWith({ '/ws/workflow.yaml': 'name: feature' });
    renderPreview(fs, '/ws/workflow.yaml');
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'name: changed' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(async () => {
      expect(new TextDecoder().decode(await fs.readFile('/ws/workflow.yaml'))).toBe('name: changed');
    });
  });

  it('reports dirty state to the page while there are unsaved edits', async () => {
    const fs = fsWith({ '/ws/a.md': '# Title' });
    const onDirtyChange = vi.fn();
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/a.md" onDirtyChange={onDirtyChange} />
      </FileSystemProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'changed' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it('refuses to save silently over a file that changed on disk', async () => {
    const fs = fsWith({ '/ws/a.md': '# Title' });
    renderPreview(fs, '/ws/a.md');
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });

    fs.setFileSilently('/ws/a.md', 'theirs'); // a run wrote to it underneath us
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    expect(new TextDecoder().decode(await fs.readFile('/ws/a.md'))).toBe('theirs');

    fireEvent.click(screen.getByRole('button', { name: /overwrite/i }));
    await waitFor(async () => {
      expect(new TextDecoder().decode(await fs.readFile('/ws/a.md'))).toBe('mine');
    });
  });

  it('reloads the on-disk version when asked to', async () => {
    const fs = fsWith({ '/ws/a.md': '# Title' });
    renderPreview(fs, '/ws/a.md');
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });
    fs.setFileSilently('/ws/a.md', '# Theirs');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /reload/i }));
    expect(await screen.findByRole('heading', { name: 'Theirs' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w desktop -- src/components/FilePreview.test.tsx`
Expected: FAIL — the previous tests pass, the new ones fail on `Unable to find an accessible element with the role "button" and name /edit/i`.

- [ ] **Step 3: Add edit mode to FilePreview**

Modify `apps/desktop/src/components/FilePreview.tsx`. Extend the imports:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  MessageBar, MessageBarBody, Spinner, Text, Textarea,
} from '@fluentui/react-components';
```

Extend the props:

```tsx
export interface FilePreviewProps {
  path: string | null;
  onDirtyChange: (dirty: boolean) => void;
  /** New-file flow: open straight in edit mode, since there's nothing to render. */
  startInEditMode?: boolean;
  /** Bumped by the page to force a re-read (external change, post-rename). */
  reloadToken?: number;
}
```

Update the component signature to destructure the new props:

```tsx
export function FilePreview({ path, onDirtyChange, startInEditMode, reloadToken }: FilePreviewProps) {
```

Add this state next to the existing state, inside the component:

```tsx
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ diskText: string; diskMtimeMs: number } | null>(null);
  const dirty = editing && loaded !== null && draft !== (loaded.text ?? '');
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  useEffect(() => {
    onDirtyChangeRef.current(dirty);
  }, [dirty]);
```

Reset edit state whenever the file changes — add to the existing load effect, right after `setError(null)`:

```tsx
    setEditing(false);
    setDraft('');
    setSaveError(null);
    setConflict(null);
```

…and add `reloadToken` to that effect's dependency array: `}, [path, fs, reloadToken]);`

Then, after the load effect, open in edit mode for a brand-new file:

```tsx
  useEffect(() => {
    if (startInEditMode && loaded && !editing) {
      setEditing(true);
      setDraft(loaded.text ?? '');
    }
    // Only when a fresh load lands — re-entering edit mode after the user
    // cancels would trap them in the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, startInEditMode]);
```

Add the save logic:

```tsx
  const applySave = useCallback(async (contents: string) => {
    if (!path) return;
    try {
      await fs.writeTextFile(path, contents);
      const info = await fs.stat(path);
      setLoaded(current => (current ? { ...current, text: contents, size: info.size, mtimeMs: info.mtimeMs } : current));
      setEditing(false);
      setConflict(null);
      setSaveError(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }, [fs, path]);

  const save = useCallback(async () => {
    if (!path || !loaded) return;
    // Stale-write guard: something else (a run, an editor) may have written
    // this file since it was opened. Never clobber that silently.
    try {
      const info = await fs.stat(path);
      if (info.mtimeMs !== loaded.mtimeMs) {
        const bytes = await fs.readFile(path);
        setConflict({ diskText: new TextDecoder().decode(bytes), diskMtimeMs: info.mtimeMs });
        return;
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      return;
    }
    await applySave(draft);
  }, [applySave, draft, fs, loaded, path]);
```

Replace the render for `markdown` and `text` kinds with a shared shell carrying the toolbar, the editor, the conflict dialog and the save error. Keep the `binary`, `image`, `tooLarge`, `error` and empty branches exactly as they are:

```tsx
  const editable = loaded.kind === 'markdown' || loaded.kind === 'text';
  if (!editable) {
    if (loaded.kind === 'binary') return <Text>Binary file — {formatSize(loaded.size)}. {loaded.path}</Text>;
    return <img src={loaded.imageUrl} alt={loaded.path} style={{ maxWidth: '100%' }} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Text weight="semibold">{loaded.path}</Text>
        <div style={{ flex: 1 }} />
        {editing ? (
          <>
            <Button appearance="primary" onClick={() => void save()}>Save</Button>
            <Button onClick={() => { setEditing(false); setSaveError(null); }}>Cancel</Button>
          </>
        ) : (
          <Button onClick={() => { setEditing(true); setDraft(loaded.text ?? ''); }}>Edit</Button>
        )}
      </div>

      {saveError && (
        <MessageBar intent="error">
          <MessageBarBody>Could not save this file: {saveError}</MessageBarBody>
        </MessageBar>
      )}

      {editing ? (
        <Textarea
          value={draft}
          onChange={(_event, data) => setDraft(data.value)}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 's') {
              event.preventDefault();
              void save();
            }
          }}
          resize="none"
          style={{ flex: 1, minHeight: 0 }}
          textarea={{ style: { fontFamily: 'var(--fontFamilyMonospace)', minHeight: '50vh' } }}
        />
      ) : loaded.kind === 'markdown' ? (
        <ReactMarkdown>{loaded.text ?? ''}</ReactMarkdown>
      ) : (
        <pre style={{ margin: 0, overflow: 'auto' }}>
          <code
            className="hljs"
            dangerouslySetInnerHTML={{ __html: highlightCode(loaded.text ?? '', languageForPath(loaded.path)) }}
          />
        </pre>
      )}

      <Dialog open={conflict !== null} onOpenChange={(_event, data) => { if (!data.open) setConflict(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>This file changed on disk</DialogTitle>
            <DialogContent>
              Something else wrote to this file after you opened it — a run, or another editor.
              Overwrite it with your version, or reload theirs and lose your edits?
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => void applySave(draft)}>Overwrite</Button>
              <Button
                onClick={() => {
                  if (!conflict) return;
                  setLoaded(current => (
                    current ? { ...current, text: conflict.diskText, mtimeMs: conflict.diskMtimeMs } : current
                  ));
                  setDraft(conflict.diskText);
                  setEditing(false);
                  setConflict(null);
                }}
              >
                Reload
              </Button>
              <Button onClick={() => setConflict(null)}>Cancel</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w desktop -- src/components/FilePreview.test.tsx`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/FilePreview.tsx apps/desktop/src/components/FilePreview.test.tsx
git commit -m "feat(desktop): edit and save files from the preview pane, guarding stale writes"
```

---

### Task 8: The Files page — composition and the dirty guard

**Files:**
- Create: `apps/desktop/src/pages/FilesPage.tsx`
- Test: `apps/desktop/src/pages/FilesPage.test.tsx`

**Interfaces:**
- Consumes: `useFileTree`, `FileTree` (Task 5), `FilePreview` (Tasks 6-7), `useAppStore` (`workspacePath`).
- Produces: `FilesPage()` — no props; reads `workspacePath` from the store.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/pages/FilesPage.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FakeFileSystem } from '../files/fake-fs.ts';
import { FileSystemProvider } from '../files/fs-context.tsx';
import { useAppStore } from '../state/store.ts';
import { FilesPage } from './FilesPage.tsx';

function workspace(): FakeFileSystem {
  const fs = new FakeFileSystem();
  fs.setFile('/ws/README.md', '# Readme');
  fs.setFile('/ws/notes.md', '# Notes');
  fs.setFile('/ws/docs/design.md', '# Design');
  return fs;
}

function renderFilesPage(fs: FakeFileSystem) {
  useAppStore.setState({ workspacePath: '/ws' });
  render(
    <FileSystemProvider fs={fs}>
      <FilesPage />
    </FileSystemProvider>,
  );
}

describe('FilesPage', () => {
  afterEach(() => useAppStore.setState({ workspacePath: null }));

  it('previews the file clicked in the tree', async () => {
    renderFilesPage(workspace());
    fireEvent.click(await screen.findByText('README.md'));
    expect(await screen.findByRole('heading', { name: 'Readme' })).toBeInTheDocument();
  });

  it('switches preview when another file is clicked', async () => {
    renderFilesPage(workspace());
    fireEvent.click(await screen.findByText('README.md'));
    await screen.findByRole('heading', { name: 'Readme' });
    fireEvent.click(screen.getByText('notes.md'));
    expect(await screen.findByRole('heading', { name: 'Notes' })).toBeInTheDocument();
  });

  it('warns before leaving a file with unsaved edits, and stays put when told to', async () => {
    renderFilesPage(workspace());
    fireEvent.click(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved' } });

    fireEvent.click(screen.getByText('notes.md'));
    expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /keep editing/i }));
    expect(screen.getByRole('textbox')).toHaveValue('unsaved');
  });

  it('moves on and drops the edits when discard is confirmed', async () => {
    renderFilesPage(workspace());
    fireEvent.click(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved' } });
    fireEvent.click(screen.getByText('notes.md'));
    fireEvent.click(await screen.findByRole('button', { name: /discard/i }));
    expect(await screen.findByRole('heading', { name: 'Notes' })).toBeInTheDocument();
  });

  it('tells the user to open a workspace when there is none', async () => {
    useAppStore.setState({ workspacePath: null });
    render(
      <FileSystemProvider fs={workspace()}>
        <FilesPage />
      </FileSystemProvider>,
    );
    await waitFor(() => expect(screen.getByText(/open a workspace/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w desktop -- src/pages/FilesPage.test.tsx`
Expected: FAIL — `Failed to resolve import "./FilesPage.tsx"`.

- [ ] **Step 3: Write the page**

Create `apps/desktop/src/pages/FilesPage.tsx`:

```tsx
/**
 * The Files tab: workspace tree on the left, preview on the right.
 *
 * Owns the pieces that span both panes — which file is selected, and the
 * unsaved-edits guard that has to intercept a selection change before the
 * preview swaps out from under the editor.
 */
import { useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Text,
} from '@fluentui/react-components';
import { useAppStore } from '../state/store.ts';
import { useFileTree } from '../files/use-file-tree.ts';
import { FileTree } from '../components/FileTree.tsx';
import { FilePreview } from '../components/FilePreview.tsx';
import { PageHeader } from '../components/PageHeader.tsx';

export function FilesPage() {
  const workspacePath = useAppStore(state => state.workspacePath);
  const tree = useFileTree(workspacePath);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  /** Selection the dirty guard is holding until the user decides. */
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  if (!workspacePath) return <Text>Open a workspace to browse its files.</Text>;

  function select(path: string): void {
    const node = tree.nodes[path];
    if (node?.kind === 'dir') return; // directories expand; they don't preview
    if (dirty && path !== selectedPath) {
      setPendingPath(path);
      return;
    }
    setSelectedPath(path);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader>
        <Text weight="semibold" size={500}>Files</Text>
        <Text size={200}>{workspacePath}</Text>
      </PageHeader>

      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0, paddingTop: 8 }}>
        <div
          style={{
            width: 280,
            flexShrink: 0,
            borderRight: '1px solid var(--colorNeutralStroke2)',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <FileTree
            root={workspacePath}
            nodes={tree.nodes}
            expanded={tree.expanded}
            selectedPath={selectedPath}
            onToggle={tree.toggle}
            onSelect={select}
            showHidden={tree.showHidden}
            onShowHiddenChange={tree.setShowHidden}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          <FilePreview path={selectedPath} onDirtyChange={setDirty} />
        </div>
      </div>

      <Dialog open={pendingPath !== null} onOpenChange={(_event, data) => { if (!data.open) setPendingPath(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>You have unsaved changes</DialogTitle>
            <DialogContent>Opening another file will discard the edits you haven't saved.</DialogContent>
            <DialogActions>
              <Button
                appearance="primary"
                onClick={() => {
                  setSelectedPath(pendingPath);
                  setDirty(false);
                  setPendingPath(null);
                }}
              >
                Discard changes
              </Button>
              <Button onClick={() => setPendingPath(null)}>Keep editing</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w desktop -- src/pages/FilesPage.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/pages/FilesPage.tsx apps/desktop/src/pages/FilesPage.test.tsx
git commit -m "feat(desktop): Files page composing the tree and preview with an unsaved-edits guard"
```

---

### Task 9: File operations — new file, new folder, rename, delete

**Files:**
- Create: `apps/desktop/src/components/FileOpsDialog.tsx`
- Modify: `apps/desktop/src/pages/FilesPage.tsx`
- Modify: `apps/desktop/src/components/FileTree.tsx` (context menu)
- Test: `apps/desktop/src/pages/FilesPage.test.tsx` (extend)

**Interfaces:**
- Consumes: `validateName`, `joinPath`, `parentPath` (Task 2), `useFileSystem` (Task 5), `tree.refreshDir` (Task 5).
- Produces: `FileOpsDialog({ open, mode, initialName, onSubmit, onCancel, busy, error })` where `mode` is `'newFile' | 'newFolder' | 'rename'`; `FileTree` gains an optional `onContextMenu(path: string)` prop.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/pages/FilesPage.test.tsx` (add `within` to the `@testing-library/react` import):

```tsx
describe('FilesPage file operations', () => {
  it('creates a new file in the selected folder and opens it for editing', async () => {
    const fs = workspace();
    renderFilesPage(fs);
    fireEvent.click(await screen.findByText('docs'));
    fireEvent.click(screen.getByRole('button', { name: /new file/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: 'todo.md' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(fs.exists('/ws/docs/todo.md')).resolves.toBe(true));
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
  });

  it('refuses a name that already exists', async () => {
    renderFilesPage(workspace());
    await screen.findByText('README.md');
    fireEvent.click(screen.getByRole('button', { name: /new file/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: 'README.md' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it('refuses a name containing a path separator', async () => {
    renderFilesPage(workspace());
    await screen.findByText('README.md');
    fireEvent.click(screen.getByRole('button', { name: /new file/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: '../escape.md' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByText(/cannot contain/i)).toBeInTheDocument();
  });

  it('creates a new folder', async () => {
    const fs = workspace();
    renderFilesPage(fs);
    await screen.findByText('README.md');
    fireEvent.click(screen.getByRole('button', { name: /new folder/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: 'ideas' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByText('ideas')).toBeInTheDocument();
  });

  it('renames the selected file and keeps previewing it under its new name', async () => {
    const fs = workspace();
    renderFilesPage(fs);
    fireEvent.click(await screen.findByText('README.md'));
    await screen.findByRole('heading', { name: 'Readme' });
    fireEvent.click(screen.getByRole('button', { name: /rename/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: 'GUIDE.md' } });
    // Scoped to the dialog: the toolbar has a "Rename" button too, so an
    // unscoped query matches two elements and throws.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^rename$/i }));

    expect(await screen.findByText('GUIDE.md')).toBeInTheDocument();
    await waitFor(() => expect(fs.exists('/ws/README.md')).resolves.toBe(false));
  });

  it('deletes the selected file after confirmation and clears the preview', async () => {
    const fs = workspace();
    renderFilesPage(fs);
    fireEvent.click(await screen.findByText('notes.md'));
    await screen.findByRole('heading', { name: 'Notes' });
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(fs.exists('/ws/notes.md')).resolves.toBe(false));
    expect(await screen.findByText(/select a file/i)).toBeInTheDocument();
  });

  it('spells out that deleting a folder takes its contents with it', async () => {
    renderFilesPage(workspace());
    fireEvent.click(await screen.findByText('docs'));
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(await screen.findByText(/everything inside it/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w desktop -- src/pages/FilesPage.test.tsx`
Expected: FAIL — no "New file" button exists yet.

- [ ] **Step 3: Write the name dialog**

Create `apps/desktop/src/components/FileOpsDialog.tsx`:

```tsx
/**
 * The one name-entry dialog behind New file, New folder and Rename.
 *
 * Shared so the name rules (tree-model's validateName) and the "already
 * exists" check are stated once — three near-identical dialogs would drift.
 */
import { useEffect, useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input,
} from '@fluentui/react-components';

export type FileOpsMode = 'newFile' | 'newFolder' | 'rename';

const TITLES: Record<FileOpsMode, string> = {
  newFile: 'New file',
  newFolder: 'New folder',
  rename: 'Rename',
};

const SUBMIT_LABELS: Record<FileOpsMode, string> = {
  newFile: 'Create',
  newFolder: 'Create',
  rename: 'Rename',
};

export interface FileOpsDialogProps {
  open: boolean;
  mode: FileOpsMode;
  /** Prefill — the current name for a rename, '' for a creation. */
  initialName: string;
  /** Where the new or renamed entry will live, shown so the target is unambiguous. */
  targetDir: string;
  error: string | null;
  busy: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export function FileOpsDialog(props: FileOpsDialogProps) {
  const { open, mode, initialName, targetDir, error, busy, onSubmit, onCancel } = props;
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  return (
    <Dialog open={open} onOpenChange={(_event, data) => { if (!data.open) onCancel(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{TITLES[mode]}</DialogTitle>
          <DialogContent>
            <Field label="Name" hint={`in ${targetDir}`} validationState={error ? 'error' : 'none'} validationMessage={error ?? undefined}>
              <Input
                value={name}
                onChange={(_event, data) => setName(data.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !busy) onSubmit(name);
                }}
              />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={busy} onClick={() => onSubmit(name)}>
              {SUBMIT_LABELS[mode]}
            </Button>
            <Button onClick={onCancel}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
```

- [ ] **Step 4: Add the operations to FilesPage**

In `apps/desktop/src/pages/FilesPage.tsx`, extend the imports:

```tsx
import { useFileSystem } from '../files/fs-context.tsx';
import { joinPath, parentPath, validateName } from '../files/tree-model.ts';
import { FileOpsDialog, type FileOpsMode } from '../components/FileOpsDialog.tsx';
```

Add this state inside the component, after `pendingPath`:

```tsx
  const fs = useFileSystem();
  const [opsMode, setOpsMode] = useState<FileOpsMode | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [opsBusy, setOpsBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** Forces FilePreview to re-read after a rename retargets it. */
  const [reloadToken, setReloadToken] = useState(0);
  /** New-file flow: the preview opens straight into edit mode. */
  const [openInEditMode, setOpenInEditMode] = useState(false);
```

Add the operation helpers (still inside the component, before `return`):

```tsx
  /** Where a create lands: the selected directory, or the selected file's parent. */
  const targetDir = (() => {
    if (!selectedPath) return workspacePath;
    return tree.nodes[selectedPath]?.kind === 'dir' ? selectedPath : parentPath(selectedPath);
  })();

  const selectedNode = selectedPath ? tree.nodes[selectedPath] : undefined;

  async function submitOps(name: string): Promise<void> {
    const mode = opsMode;
    if (!mode) return;
    const invalid = validateName(name);
    if (invalid) {
      setOpsError(invalid);
      return;
    }

    const dir = mode === 'rename' ? parentPath(selectedPath ?? workspacePath) : targetDir;
    const destination = joinPath(dir, name);
    setOpsBusy(true);
    setOpsError(null);
    try {
      if (await fs.exists(destination)) {
        setOpsError('Something with that name already exists here.');
        return;
      }
      if (mode === 'newFolder') {
        await fs.mkdir(destination);
      } else if (mode === 'newFile') {
        await fs.writeTextFile(destination, '');
      } else if (selectedPath) {
        await fs.rename(selectedPath, destination);
      }
      await tree.refreshDir(dir);
      setOpsMode(null);
      if (mode === 'newFile') {
        setOpenInEditMode(true);
        setSelectedPath(destination);
      } else if (mode === 'rename') {
        // Keep previewing the same file under its new name.
        setSelectedPath(destination);
        setReloadToken(token => token + 1);
      }
    } catch (e) {
      setOpsError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpsBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!selectedPath) return;
    const dir = parentPath(selectedPath);
    try {
      await fs.remove(selectedPath, { recursive: selectedNode?.kind === 'dir' });
      await tree.refreshDir(dir);
      setSelectedPath(null);
      setDeleting(false);
      setDeleteError(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    }
  }
```

Add the toolbar just below `<PageHeader>`'s closing tag:

```tsx
      <div style={{ display: 'flex', gap: 8, padding: '8px 0' }}>
        <Button size="small" onClick={() => { setOpsMode('newFile'); setOpsError(null); }}>New file</Button>
        <Button size="small" onClick={() => { setOpsMode('newFolder'); setOpsError(null); }}>New folder</Button>
        <Button size="small" disabled={!selectedPath} onClick={() => { setOpsMode('rename'); setOpsError(null); }}>
          Rename
        </Button>
        <Button size="small" disabled={!selectedPath} onClick={() => { setDeleting(true); setDeleteError(null); }}>
          Delete
        </Button>
      </div>
```

Replace the `<FilePreview .../>` element with:

```tsx
          <FilePreview
            path={selectedNode?.kind === 'dir' ? null : selectedPath}
            onDirtyChange={setDirty}
            startInEditMode={openInEditMode}
            reloadToken={reloadToken}
          />
```

A directory can be selected (it's the target of New file / Rename / Delete) but must never be handed to the preview, which would try to read it as a file.

…and clear `openInEditMode` when the selection changes — add to `select()`, just before `setSelectedPath(path)`:

```tsx
    setOpenInEditMode(false);
```

Finally, add the two dialogs before the closing `</div>`, after the unsaved-changes dialog:

```tsx
      <FileOpsDialog
        open={opsMode !== null}
        mode={opsMode ?? 'newFile'}
        initialName={opsMode === 'rename' ? (selectedNode?.name ?? '') : ''}
        targetDir={opsMode === 'rename' ? parentPath(selectedPath ?? workspacePath) : targetDir}
        error={opsError}
        busy={opsBusy}
        onSubmit={name => void submitOps(name)}
        onCancel={() => { setOpsMode(null); setOpsError(null); }}
      />

      <Dialog open={deleting} onOpenChange={(_event, data) => { if (!data.open) setDeleting(false); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete {selectedNode?.name}?</DialogTitle>
            <DialogContent>
              {selectedNode?.kind === 'dir'
                ? `Delete folder "${selectedNode.name}" and everything inside it? This cannot be undone.`
                : `Delete "${selectedNode?.name}"? This cannot be undone.`}
              {deleteError ? ` — ${deleteError}` : ''}
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => void confirmDelete()}>Delete</Button>
              <Button onClick={() => setDeleting(false)}>Cancel</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
```

Task 8's `select()` returns early for directories without recording them. A directory must now be *selectable* as an operations target, so change that early return to record the selection (the preview is already guarded above):

```tsx
    if (node?.kind === 'dir') {
      setSelectedPath(path);
      return;
    }
```

- [ ] **Step 5: Add the context menu to FileTree**

In `apps/desktop/src/components/FileTree.tsx`, add an `onContextMenu` prop to `FileTreeProps` and to `NodeRows`, and attach it to each `TreeItemLayout`:

```tsx
  onContextMenu?: (path: string) => void;
```

```tsx
              onContextMenu={event => {
                event.preventDefault();
                onSelect(path);
                onContextMenu?.(path);
              }}
```

In `FilesPage`, pass `onContextMenu={() => {}}` for now — the toolbar is the tested surface, and the right-click simply selects. (A full popover menu is not required by the spec's behaviour and adds Fluent `Menu` positioning complexity; selection-on-right-click plus the toolbar covers the same operations.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -w desktop -- src/pages/FilesPage.test.tsx`
Expected: PASS, 12 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components/FileOpsDialog.tsx apps/desktop/src/components/FileTree.tsx apps/desktop/src/pages/FilesPage.tsx apps/desktop/src/pages/FilesPage.test.tsx
git commit -m "feat(desktop): create, rename and delete files from the Files page"
```

---

### Task 10: Live watching of expanded directories

**Files:**
- Modify: `apps/desktop/src/files/use-file-tree.ts`
- Test: `apps/desktop/src/components/FileTree.test.tsx` (extend)

**Interfaces:**
- Consumes: `FileSystemPort.watch` (Task 3).
- Produces: no new exports — `useFileTree` gains watcher lifecycle internally, capped at `MAX_WATCHERS = 32` with least-recently-expanded eviction.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/components/FileTree.test.tsx` (add `vi` to the vitest import):

```tsx
describe('FileTree watching', () => {
  it('re-lists a watched directory when it changes on disk', async () => {
    const fs = workspace();
    renderTree(fs);
    await screen.findByText('README.md');
    await waitFor(() => expect(fs.watcherCount()).toBeGreaterThan(0));

    fs.setFile('/ws/appeared.md', 'new');
    fs.emitChange('/ws');

    expect(await screen.findByText('appeared.md')).toBeInTheDocument();
  });

  it('watches a directory when it is expanded and stops when it is collapsed', async () => {
    const fs = workspace();
    renderTree(fs);
    await screen.findByText('docs');
    const rootOnly = fs.watcherCount();

    fireEvent.click(screen.getByText('docs'));
    await screen.findByText('design.md');
    await waitFor(() => expect(fs.watcherCount()).toBe(rootOnly + 1));

    fireEvent.click(screen.getByText('docs'));
    await waitFor(() => expect(fs.watcherCount()).toBe(rootOnly));
  });

  it('drops every watcher when the tree unmounts', async () => {
    const fs = workspace();
    const { unmount } = render(
      <FileSystemProvider fs={fs}>
        <Harness root="/ws" />
      </FileSystemProvider>,
    );
    await screen.findByText('README.md');
    await waitFor(() => expect(fs.watcherCount()).toBeGreaterThan(0));
    unmount();
    await waitFor(() => expect(fs.watcherCount()).toBe(0));
  });
});
```

`renderTree` currently doesn't return anything — change it to `return render(...)` so the last test can unmount. Export `Harness` is unnecessary; it's already in scope.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w desktop -- src/components/FileTree.test.tsx`
Expected: FAIL — `expected 0 to be greater than 0` (no watchers are registered yet).

- [ ] **Step 3: Add the watcher lifecycle**

In `apps/desktop/src/files/use-file-tree.ts`, add near the top:

```ts
/**
 * Cap on concurrently watched directories. Each one costs an inotify handle
 * on Linux, and a deep browse would otherwise accumulate them without bound;
 * the least-recently-expanded watcher is dropped when the cap is reached. Its
 * directory still refreshes on the next expand or file operation.
 */
const MAX_WATCHERS = 32;
```

Add `useRef` to the React import, then inside the hook, after the existing state:

```ts
  // Watchers are refs, not state: they're side effects keyed by path, and
  // putting them in state would re-render the tree on every subscribe.
  const watchers = useRef(new Map<string, () => void>());
  const watchOrder = useRef<string[]>([]);
```

Add the subscribe/unsubscribe effect after the toggle callback:

```ts
  // Watch exactly what's expanded: a run writing into .mc/runs/<id>/ shows up
  // live while you're looking at it, and costs nothing when it's collapsed.
  useEffect(() => {
    const current = watchers.current;
    const order = watchOrder.current;
    let cancelled = false;

    for (const [path, unwatch] of [...current]) {
      if (!expanded.includes(path)) {
        unwatch();
        current.delete(path);
        watchOrder.current = order.filter(p => p !== path);
      }
    }

    for (const path of expanded) {
      if (current.has(path)) continue;
      current.set(path, () => {}); // placeholder: reserve the slot against re-entry
      watchOrder.current = [...watchOrder.current, path];
      void (async () => {
        try {
          const unwatch = await fs.watch(path, () => void listDir(path, showHidden));
          if (cancelled || !current.has(path)) {
            unwatch();
            return;
          }
          current.set(path, unwatch);
        } catch {
          // Unwatchable directory (permissions, too many handles): the tree
          // still works, it just won't refresh itself here.
          current.delete(path);
          watchOrder.current = watchOrder.current.filter(p => p !== path);
        }
      })();

      while (watchOrder.current.length > MAX_WATCHERS) {
        const oldest = watchOrder.current[0];
        watchOrder.current = watchOrder.current.slice(1);
        current.get(oldest)?.();
        current.delete(oldest);
      }
    }

    return () => {
      cancelled = true;
    };
  }, [expanded, fs, listDir, showHidden]);

  // Tear every watcher down on unmount (a separate effect: the one above
  // re-runs on every expand, and doing this there would unwatch constantly).
  useEffect(() => {
    const current = watchers.current;
    return () => {
      for (const unwatch of current.values()) unwatch();
      current.clear();
      watchOrder.current = [];
    };
  }, []);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w desktop -- src/components/FileTree.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the whole desktop suite**

Run: `npm run test -w desktop`
Expected: PASS — every existing test still green.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/files/use-file-tree.ts apps/desktop/src/components/FileTree.test.tsx
git commit -m "feat(desktop): keep the file tree live for expanded directories"
```

---

### Task 11: Wire the Files tab into the app

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `apps/desktop/src/main.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: `FilesPage` (Task 8), `FileSystemProvider` (Task 5), `TauriFileSystem` (Task 4).
- Produces: `PageId` gains `'files'`; the app renders the Files tab.

- [ ] **Step 1: Update the tab-list test to expect five tabs**

In `apps/desktop/src/App.test.tsx`, replace the existing test at line 38:

```tsx
  it('renders the left nav with all five page tabs', () => {
    renderApp();
    for (const label of ['Runs', 'Workflows', 'Files', 'Doctor', 'Settings']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w desktop -- src/App.test.tsx`
Expected: FAIL — `Unable to find an accessible element with the role "tab" and name "Files"`.

- [ ] **Step 3: Add the tab**

In `apps/desktop/src/App.tsx`:

```tsx
import { FilesPage } from './pages/FilesPage.tsx';
```

```tsx
type PageId = 'runs' | 'workflows' | 'files' | 'doctor' | 'settings';
```

```tsx
const PAGES: { id: PageId; label: string }[] = [
  { id: 'runs', label: 'Runs' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'files', label: 'Files' },
  { id: 'doctor', label: 'Doctor' },
  { id: 'settings', label: 'Settings' },
];
```

And in the page switch, after the WorkflowsPage line:

```tsx
                {page === 'files' && <FilesPage />}
```

The existing workspace gate needs no change: `files` is not `doctor` or `settings`, so with no workspace open the page is replaced by `WelcomePage`, exactly like Runs and Workflows.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w desktop -- src/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Provide the real filesystem in production**

Replace `apps/desktop/src/main.tsx`:

```tsx
import './index.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { AgentClient } from './agent/client.ts';
import { TauriTransport } from './agent/tauri-transport.ts';
import { AgentClientProvider } from './agent/agent-context.tsx';
import { FileSystemProvider } from './files/fs-context.tsx';
import { TauriFileSystem } from './files/tauri-fs.ts';
import { createTauriNotifier } from './lib/notifier.ts';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

const client = new AgentClient(new TauriTransport());
const fileSystem = new TauriFileSystem();

createRoot(rootEl).render(
  <AgentClientProvider client={client}>
    <FileSystemProvider fs={fileSystem}>
      <App notifier={createTauriNotifier()} />
    </FileSystemProvider>
  </AgentClientProvider>,
);
```

- [ ] **Step 6: Document the tab**

In `README.md`, in the "Desktop app" section, replace the sentence ending "(workflow picker, live run view, xterm-backed interactive handoff)" with:

```
just adds a GUI (workflow picker, live run view, xterm-backed interactive handoff, and a
Files tab: a tree of the opened workspace with rendered-markdown preview and in-place
editing). The Files tab reaches the filesystem through Tauri's fs plugin, scoped at
runtime to the workspace you opened and nothing else — the agent's RPC surface has no
file methods.
```

- [ ] **Step 7: Run the full gate**

Run: `npm run verify`
Expected: PASS end to end — root typecheck, package tests, parity, desktop vitest, desktop build, `cargo check`.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx apps/desktop/src/main.tsx README.md
git commit -m "feat(desktop): add the Files tab to the app shell"
```

---

### Task 12: Manual verification against the live app

**Files:** none (verification only; fixes land as follow-up commits).

This is the only place the fs plugin, the Rust scope grant and the real watcher are exercised — the vitest suite covers everything above them but cannot load `@tauri-apps/*`.

- [ ] **Step 1: Launch the app**

Run: `npm run tauri dev -w desktop`
Expected: the window opens with a **Files** tab in the left nav.

- [ ] **Step 2: Verify the grant on a freshly-picked workspace**

Open a workspace with the header picker, then click Files.
Expected: the tree lists the workspace root. If it shows a "forbidden path" error, `grant_workspace` isn't being reached — check the command name in `invoke()` matches `generate_handler!`.

- [ ] **Step 3: Verify the grant on a restored workspace**

Quit and relaunch (the workspace is restored from app state), then click Files without touching the picker.
Expected: the tree lists the root — this is the case a grant wired into `openWorkspace()` would have missed.

- [ ] **Step 4: Verify preview and editing**

Open a `.md` file (rendered, not source), click Edit, change a word, Save.
Expected: it returns to the rendered view and the change is on disk (`cat` it).
Repeat on a `.yaml` file under `.mc/workflows/`.
Expected: highlighted preview, editable, saves.

- [ ] **Step 5: Verify the live watcher**

Expand `.mc/runs/`, start a run from the Runs tab, and watch the Files tree.
Expected: the new run directory appears without a manual refresh.

- [ ] **Step 6: Verify the destructive paths**

Delete the file currently open in the preview.
Expected: confirmation names the file; the preview clears afterwards.
Delete a folder.
Expected: the confirmation says "and everything inside it".

- [ ] **Step 7: Verify an unreadable directory**

Browse to a directory the user can't read (e.g. `sudo mkdir /tmp/ws-test/locked && sudo chmod 000 /tmp/ws-test/locked` inside a scratch workspace).
Expected: that node shows its error; the rest of the tree keeps working.

- [ ] **Step 8: Record the outcome**

Note any failures and fix them as follow-up commits before considering the feature done. Update the "Pending verification" section of the project memory if the manual pass changes what's outstanding.

---

## Notes for the implementer

- **Never import `@tauri-apps/*` outside `tauri-fs.ts`, `tauri-transport.ts`, `notifier.ts` and `main.tsx`.** A component that does becomes untestable, since the desktop vitest config keeps Tauri out of the test graph on purpose.
- **Don't touch `packages/`, `parity/` or the agent protocol.** If a task seems to need it, stop and re-read the spec — the separation is the whole point of the design.
- Fluent v9 component APIs occasionally differ from what's written here (`Textarea`'s `textarea` slot prop, `Tree`'s `openItems` shape). Adjust the call, not the structure, and keep the accessible roles the tests query.
