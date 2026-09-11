/**
 * Owns the Files page's tree state: what's listed, what's expanded, and the
 * lazy directory reads that fill it in.
 *
 * State lives here rather than in the zustand store because nothing outside
 * this page consumes it. `showHidden` persists in localStorage rather than
 * through the agent's setUiState RPC, which would mean extending the agent
 * protocol for a desktop-only preference.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileSystem } from './fs-context.tsx';
import {
  applyDirError, applyDirListing, makeRootNode, parentPath, type TreeNodes,
} from './tree-model.ts';

const SHOW_HIDDEN_KEY = 'whiphand.files.showHidden';

/**
 * Cap on concurrently watched directories. Each one costs an inotify handle
 * on Linux, and a deep browse would otherwise accumulate them without bound;
 * the least-recently-expanded watcher is dropped when the cap is reached. Its
 * directory still refreshes on the next expand or file operation.
 */
const MAX_WATCHERS = 32;

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
  /** Expands every ancestor of `path` within the root, without collapsing anything. */
  expand: (path: string) => void;
  refreshDir: (path: string) => Promise<void>;
  showHidden: boolean;
  setShowHidden: (value: boolean) => void;
}

export function useFileTree(root: string | null): FileTreeState {
  const fs = useFileSystem();
  const [nodes, setNodes] = useState<TreeNodes>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [showHidden, setShowHiddenState] = useState(readShowHidden);

  // Watchers are refs, not state: they're side effects keyed by path, and
  // putting them in state would re-render the tree on every subscribe.
  const watchers = useRef(new Map<string, () => void>());
  const watchOrder = useRef<string[]>([]);

  // Always-current mirror of showHidden for the watch callback below. That
  // callback is registered once per subscribed directory and never
  // resubscribed while the directory stays expanded (the reconciliation
  // effect skips paths already in the map), so a closure over `showHidden`
  // directly would go stale the moment the filter is toggled: a later
  // filesystem-driven refresh of that directory would silently revert to
  // whatever `showHidden` was at subscribe time. Reading through a ref that
  // render keeps in sync sidesteps that without needing to resubscribe.
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;

  // Same trick for `expand` below, which must keep its identity across an
  // expand while still deciding from the current set.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

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

  // The updater passed to setExpanded must stay pure: React (StrictMode
  // today, and any future concurrent path) may invoke it twice for one
  // commit, and a side effect inside it would fire the read twice. Decide
  // from the current expanded value first, then let the updater only
  // compute the next array.
  const toggle = useCallback((path: string) => {
    const wasExpanded = expanded.includes(path);
    setExpanded(current => (wasExpanded ? current.filter(p => p !== path) : [...current, path]));
    if (!wasExpanded) void listDir(path, showHidden);
  }, [expanded, listDir, showHidden]);

  /**
   * Reveals `path` by expanding every one of its ancestors up to the root.
   * Unlike `toggle` this never collapses: it is used to show a file the
   * reader navigated to from a markdown link, where collapsing whatever was
   * already open would be the opposite of the intent.
   *
   * Deliberately identity-stable: it reads `expanded` and `showHidden` through
   * refs rather than naming them as dependencies, because FilesPage's markdown
   * docContext depends on this function. Were it to change identity on every
   * expand, opening an unrelated folder would remount every image in the open
   * document (see the memoized return below).
   *
   * It stops at the root rather than walking on to the filesystem root, so a
   * link that resolved outside the workspace (it shouldn't — the resolvers
   * refuse those — but the tree must not depend on that) expands nothing, and
   * no directory above the workspace is ever listed.
   */
  const expand = useCallback((path: string) => {
    if (!root) return;
    const ancestors: string[] = [];
    let dir = parentPath(path);
    for (;;) {
      if (dir !== root && !dir.startsWith(`${root}/`) && !dir.startsWith(`${root}\\`)) break;
      ancestors.unshift(dir);
      if (dir === root) break;
      const up = parentPath(dir);
      if (up === dir) break;
      dir = up;
    }
    // Read what's newly opened before the updater runs, for the same reason
    // toggle does: the updater must stay pure, since React may call it twice
    // for one commit and the reads would then fire twice.
    const opened = ancestors.filter(p => !expandedRef.current.includes(p));
    if (opened.length === 0) return;
    setExpanded(current => [...new Set([...current, ...ancestors])]);
    // A directory that was never open has never been listed, so revealing it
    // without this would expand onto an empty branch.
    for (const p of opened) void listDir(p, showHiddenRef.current);
  }, [root, listDir]);

  // Watch exactly what's expanded: a run writing into .whiphand/runs/<id>/ shows up
  // live while you're looking at it, and costs nothing when it's collapsed.
  useEffect(() => {
    const current = watchers.current;

    for (const [path, unwatch] of [...current]) {
      if (!expanded.includes(path)) {
        unwatch();
        current.delete(path);
      }
    }
    // Reconcile the order array once against the map, rather than filtering
    // a snapshot taken before the removal loop started on every removal:
    // that would reassign from the same stale snapshot each time and lose
    // every removal but the last whenever two or more paths collapse in one
    // pass (e.g. a workspace switch, which collapses everything at once).
    watchOrder.current = watchOrder.current.filter(p => current.has(p));

    for (const path of expanded) {
      if (current.has(path)) continue;
      // Placeholder: reserves the slot against re-entry, and doubles as this
      // subscription's claim on the path — a distinct function identity per
      // attempt, which is what the arrival check below compares against.
      const claim = () => {};
      current.set(path, claim);
      watchOrder.current = [...watchOrder.current, path];
      void (async () => {
        try {
          const unwatch = await fs.watch(path, () => void listDir(path, showHiddenRef.current));
          // The map is the single source of truth for "is this subscription
          // still the wanted one?". An effect-scoped `cancelled` flag would
          // be wrong: it is set by *every* cleanup, so any expand or collapse
          // arriving before this promise resolved would make the subscription
          // unwatch itself while its placeholder stayed in the map — the next
          // pass then skips the path as already watched and the directory
          // silently stops live-updating until it is collapsed and
          // re-expanded. Collapse, LRU eviction and unmount all remove the
          // path from the map (the unmount teardown effect's cleanup runs
          // after this effect's), so the map alone catches every case.
          //
          // Identity, not mere presence: a path evicted by the LRU while its
          // watch() was in flight is resubscribed by the next pass under a
          // *new* claim, and `has(path)` would then be true for both — two
          // live handles for one directory, with the map remembering only
          // the last unwatch. Comparing claims keeps exactly one.
          if (current.get(path) !== claim) {
            unwatch();
            return;
          }
          current.set(path, unwatch);
        } catch {
          // Unwatchable directory (permissions, too many handles): the tree
          // still works, it just won't refresh itself here. Same claim check
          // as above — a failed stale attempt must not tear down whatever
          // took its place.
          if (current.get(path) !== claim) return;
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
  }, [expanded, fs, listDir]);

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

  // Memoized, not a fresh literal per render: FilesPage derives its markdown
  // docContext from this object, and Markdown keys its `components` map on
  // that context. A new identity every render would make the `img` override a
  // new component *type* each time, so React would unmount and remount every
  // MarkdownImage — revoking its object URL and re-reading the file from disk
  // on every keystroke elsewhere on the page, with a visible flicker.
  return useMemo(
    () => ({ nodes, expanded, toggle, expand, refreshDir, showHidden, setShowHidden }),
    [nodes, expanded, toggle, expand, refreshDir, showHidden, setShowHidden],
  );
}
