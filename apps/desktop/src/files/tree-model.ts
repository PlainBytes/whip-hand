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
 * Directories that are almost always noise in a workspace. `.whiphand` is
 * deliberately absent from the dotfile rule below — see isHidden.
 */
const NOISE_DIRS = new Set(['node_modules', 'target', 'dist', 'build', 'coverage']);

/** Never hidden despite the leading dot: it holds the workflows and runs. */
const ALWAYS_VISIBLE = new Set(['.whiphand']);

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
