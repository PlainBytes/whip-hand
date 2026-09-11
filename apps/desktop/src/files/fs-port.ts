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
  /**
   * Watches one file; resolves to an unwatch function. Separate from watch()
   * because the two backends answer it differently: a real filesystem watches
   * the containing directory, while the artifact adapter has no directories
   * and polls.
   */
  watchFile(path: string, onChange: () => void): Promise<() => void>;
}
