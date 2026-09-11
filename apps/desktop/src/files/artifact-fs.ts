/**
 * A FileSystemPort backed by the agent's artifact RPCs, so the Artifacts tab
 * can reuse the Files page's FilePreview verbatim instead of growing a second
 * viewer.
 *
 * Deliberately not a filesystem: artifacts are addressed by *name* against
 * one run's manifest listing, and this adapter is what preserves that. Paths
 * only appear here because FilePreview is path-shaped; every one of them is
 * translated back to a name the manifest already vouches for, and a path
 * that isn't in the manifest is refused outright.
 *
 * Two things about the RPCs underneath that this port relies on, each of
 * which used to be a limitation:
 *
 * 1. BYTES, NOT TEXT. readFile() always asks `readArtifact` for base64 and
 *    decodes it here, so what arrives is exactly what is on disk. The
 *    default utf8 encoding decodes on the agent, and an image, a HAR trace
 *    or any other binary artifact would already have been mangled by the
 *    time it got here. Text callers lose nothing: the port's contract was
 *    always a Uint8Array, and FilePreview decodes that itself. That is what
 *    lets an attached screenshot render in the Artifacts tab, and a relative
 *    image in a markdown artifact render through MarkdownImage.
 * 2. stat() IS NOT A READ. It goes through `statArtifact`, which returns
 *    size and mtime and no content, so opening a file costs one read, not
 *    two. A caller that gates on stat() before reading something oversized
 *    (FilePreview's image loader) really is spared those bytes, and a
 *    viewer polling a multi-megabyte image is not re-downloading it every
 *    interval.
 */
import type { AgentClient } from '../agent/client.ts';
import { decodeBase64ToBytes } from '../lib/base64.ts';
import type { DirEntry } from './tree-model.ts';
import type { FileStat, FileSystemPort } from './fs-port.ts';

export interface ArtifactRef {
  name: string;
  path: string;
}

/**
 * Poll interval for watchFile(). Each poll is a statArtifact round trip, not
 * a read, so this only trades staleness against RPC chatter while a
 * document is open.
 */
const ARTIFACT_POLL_INTERVAL_MS = 2000;

export class ArtifactFileSystem implements FileSystemPort {
  /**
   * The mtime this adapter last reported from stat(), per path. FilePreview
   * stats immediately before saving and compares that value itself; handing
   * the same value back to the server as expectedMtimeMs closes the window
   * between its check and the actual write.
   */
  private readonly lastStatMtime = new Map<string, number>();

  constructor(
    private readonly client: AgentClient,
    private readonly workdir: string,
    private readonly runId: string,
    private readonly artifacts: ReadonlyArray<ArtifactRef>,
  ) {}

  private nameFor(path: string): string {
    const artifact = this.artifacts.find(a => a.path === path);
    if (!artifact) throw new Error(`not an artifact of this run: ${path}`);
    return artifact.name;
  }

  private statRemote(path: string): Promise<{ size: number; mtimeMs: number }> {
    return this.client.request('statArtifact', {
      workdir: this.workdir, runId: this.runId, name: this.nameFor(path),
    });
  }

  /** No-op: the agent's own containment is the boundary, not a granted scope. */
  async ensureGranted(_root: string): Promise<void> {}

  async readFile(path: string): Promise<Uint8Array> {
    const { content } = await this.client.request('readArtifact', {
      workdir: this.workdir, runId: this.runId, name: this.nameFor(path), encoding: 'base64',
    });
    return decodeBase64ToBytes(content);
  }

  /**
   * Always a fresh RPC — never served from a cache shared with readFile.
   * FilePreview's stale-write guard *is* this call, so caching it would
   * defeat the very check it exists for.
   */
  async stat(path: string): Promise<FileStat> {
    const { size, mtimeMs } = await this.statRemote(path);
    this.lastStatMtime.set(path, mtimeMs);
    return { size, mtimeMs, isDirectory: false };
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    const expectedMtimeMs = this.lastStatMtime.get(path);
    const { mtimeMs } = await this.client.request('writeArtifact', {
      workdir: this.workdir, runId: this.runId, name: this.nameFor(path), content: contents,
      ...(expectedMtimeMs === undefined ? {} : { expectedMtimeMs }),
    });
    this.lastStatMtime.set(path, mtimeMs);
  }

  async exists(path: string): Promise<boolean> {
    return this.artifacts.some(a => a.path === path);
  }

  // Unreachable from the Artifacts tab: the tree is built from the manifest
  // and rendered without row actions, so nothing offers to list, create,
  // rename or delete. They throw rather than no-op so a future caller finds
  // out immediately instead of silently getting nothing.
  async readDir(_path: string): Promise<DirEntry[]> {
    throw new Error('readDir is not supported for artifacts');
  }

  async mkdir(_path: string): Promise<void> {
    throw new Error('mkdir is not supported for artifacts');
  }

  async rename(_from: string, _to: string): Promise<void> {
    throw new Error('rename is not supported for artifacts');
  }

  async remove(_path: string, _options?: { recursive?: boolean }): Promise<void> {
    throw new Error('remove is not supported for artifacts');
  }

  async watch(_path: string, _onChange: () => void): Promise<() => void> {
    throw new Error('watch is not supported for artifacts');
  }

  /**
   * Polls. This adapter has no directories to watch, and the run it belongs
   * to is frequently driven by another process — the same reason
   * RunDetailPage polls the manifest. Only the mtime is polled; the content
   * is left for the caller to fetch once onChange says it moved.
   *
   * Unlike watch(), a path that isn't one of this run's artifacts is refused
   * quietly (a no-op unwatch) rather than thrown: Task 11 calls the returned
   * function from React effect cleanup, where a throw would be disruptive.
   */
  async watchFile(path: string, onChange: () => void): Promise<() => void> {
    if (!this.artifacts.some(a => a.path === path)) return () => {};
    let lastMtime: number | undefined = this.lastStatMtime.get(path);
    let stopped = false;

    const timer = setInterval(() => {
      void (async () => {
        if (stopped) return;
        try {
          // Deliberately this.statRemote(), not this.stat(): stat() caches
          // mtimeMs into lastStatMtime for the write guard, and a poll landing
          // between FilePreview's save-time stat() and its actual write would
          // refresh that cache to a newer value, silently defeating the guard
          // for a concurrent external write that should have been rejected.
          const { mtimeMs } = await this.statRemote(path);
          // Re-check after the await: a poll already in flight when stop()
          // runs must not call onChange() into what may by then be an
          // unmounted component.
          if (stopped) return;
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
}
