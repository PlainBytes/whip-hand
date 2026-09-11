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
import { parentPath, type DirEntry } from './tree-model.ts';

/**
 * Coalescing window handed to the plugin's watcher. The tree also debounces
 * its own re-listing; this just keeps a burst of inotify events from crossing
 * the IPC boundary one at a time.
 */
const WATCH_DELAY_MS = 150;

/**
 * Rejects a `..` path segment before it reaches the plugin.
 *
 * The plugin's fs scope only canonicalizes a path that already exists before
 * matching it against the granted `<workspace>/**` glob; a path that doesn't
 * exist yet is matched literally, segment by segment, with `..` uninterpreted
 * and `**` crossing separators. So `writeTextFile`, `mkdir`, and a `rename`
 * destination — the calls that can name a path with nothing there yet — could
 * otherwise use `<workspace>/../../etc/foo` to create or overwrite something
 * outside the granted directory even though it textually matches the glob.
 * Reads target paths that already exist, so the scope canonicalizes and
 * correctly bounds them regardless — but every path-taking method calls this
 * for consistency, so the guard doesn't quietly depend on which methods
 * happen to read versus write.
 */
function assertNoParentTraversal(path: string): void {
  if (path.split(/[\\/]/).includes('..')) {
    throw new Error(`path must not contain a '..' segment: ${path}`);
  }
}

export class TauriFileSystem implements FileSystemPort {
  private granted = new Set<string>();

  async ensureGranted(root: string): Promise<void> {
    assertNoParentTraversal(root);
    if (this.granted.has(root)) return;
    await invoke('grant_workspace', { path: root });
    this.granted.add(root);
  }

  async readDir(path: string): Promise<DirEntry[]> {
    assertNoParentTraversal(path);
    const entries = await fsReadDir(path);
    return entries.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory }));
  }

  async readFile(path: string): Promise<Uint8Array> {
    assertNoParentTraversal(path);
    return fsReadFile(path);
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    assertNoParentTraversal(path);
    await fsWriteTextFile(path, contents);
  }

  async stat(path: string): Promise<FileStat> {
    assertNoParentTraversal(path);
    const info = await fsStat(path);
    return {
      size: info.size,
      mtimeMs: info.mtime ? info.mtime.getTime() : 0,
      isDirectory: info.isDirectory,
    };
  }

  async exists(path: string): Promise<boolean> {
    assertNoParentTraversal(path);
    return fsExists(path);
  }

  async mkdir(path: string): Promise<void> {
    assertNoParentTraversal(path);
    await fsMkdir(path);
  }

  async rename(from: string, to: string): Promise<void> {
    assertNoParentTraversal(from);
    assertNoParentTraversal(to);
    await fsRename(from, to);
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    assertNoParentTraversal(path);
    await fsRemove(path, { recursive: options?.recursive ?? false });
  }

  async watch(path: string, onChange: () => void): Promise<() => void> {
    assertNoParentTraversal(path);
    return fsWatch(path, () => onChange(), { recursive: false, delayMs: WATCH_DELAY_MS });
  }

  /*
   * Watches the containing directory, not the file. A watch on the inode
   * dies when a writer replaces the file via write-to-temp-then-rename,
   * which is how CLI runners tend to write artifacts — and the watch would
   * go quiet with no error to notice.
   *
   * The plugin's WatchEvent always carries `paths: string[]` (verified
   * against the installed @tauri-apps/plugin-fs types), so filtering events
   * down to this one path is possible without a defensive "call onChange for
   * any event" fallback. Still, this module is the one piece no test can
   * reach, so the match is deliberately loose: an exact match covers
   * Linux/Windows, and a basename match covers macOS FSEvents handing back a
   * canonicalized path (e.g. /private/var... for /var..., or a resolved
   * symlink) that differs textually from `path` for the same file. A
   * redundant match here is harmless — the caller compares mtimes before
   * acting — but a missed one goes silently wrong with nothing to notice.
   */
  async watchFile(path: string, onChange: () => void): Promise<() => void> {
    assertNoParentTraversal(path);
    const basename = path.split(/[\\/]/).pop();
    const unwatch = await fsWatch(parentPath(path), event => {
      if (event.paths.some(p => p === path || p.split(/[\\/]/).pop() === basename)) onChange();
    }, { recursive: false, delayMs: WATCH_DELAY_MS });

    // The plugin's unwatch closes a resource id on the Rust side; calling it
    // twice closes an already-freed id and its voided promise surfaces as an
    // unhandled rejection in the webview. Latch it so a second call is a
    // no-op, matching the other two backends (which are already safe to call
    // twice).
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      unwatch();
    };
  }
}
