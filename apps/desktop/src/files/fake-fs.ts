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
  private fileWatchers = new Map<string, Set<() => void>>();
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

  /** Lifts a previously injected error — a file that was briefly unreadable. */
  clearError(path: string): void {
    this.errors.delete(path);
  }

  /** Counts both directory and file watchers, so an assertion of zero can't pass vacuously. */
  watcherCount(): number {
    let total = 0;
    for (const set of this.watchers.values()) total += set.size;
    for (const set of this.fileWatchers.values()) total += set.size;
    return total;
  }

  private check(path: string): void {
    const message = this.errors.get(path);
    if (message) throw new Error(message);
  }

  private notify(path: string): void {
    for (const listener of this.watchers.get(parentPath(path)) ?? []) listener();
    for (const listener of this.fileWatchers.get(path) ?? []) listener();
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
      .sort((a, b) => {
        if (a.name < b.name) return -1;
        if (a.name > b.name) return 1;
        return 0;
      });
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

  async watchFile(path: string, onChange: () => void): Promise<() => void> {
    const set = this.fileWatchers.get(path) ?? new Set();
    set.add(onChange);
    this.fileWatchers.set(path, set);
    return () => {
      set.delete(onChange);
      if (set.size === 0) this.fileWatchers.delete(path);
    };
  }

  /** Fires a directory's watchers without any write — an external change. */
  emitChange(dirPath: string): void {
    for (const listener of this.watchers.get(dirPath) ?? []) listener();
  }

  /** Fires one file's watchers without a write — an external change. */
  emitFileChange(path: string): void {
    for (const listener of this.fileWatchers.get(path) ?? []) listener();
  }

  /** Writes without notifying, to simulate a change the watcher missed. */
  setFileSilently(path: string, contents: string): void {
    this.setFile(path, contents);
  }
}
