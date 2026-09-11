/**
 * Watcher bookkeeping in useFileTree, driven directly through the hook.
 *
 * FileTree.test.tsx covers watching from the UI side, but it can't reach the
 * case that matters here: a `fs.watch()` promise still in flight when the
 * next expand or collapse arrives. A fake that holds those promises open
 * makes that window explicit instead of a race the test hopes to hit.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { FakeFileSystem } from './fake-fs.ts';
import { FileSystemProvider } from './fs-context.tsx';
import { useFileTree } from './use-file-tree.ts';

/** Mirrors MAX_WATCHERS in use-file-tree.ts (not exported: it's an internal cap). */
const MAX_WATCHERS = 32;

class DeferredWatchFileSystem extends FakeFileSystem {
  private deferred: (() => void)[] = [];

  /** While true, every watch() call hangs until releaseWatches(). */
  deferWatches = false;

  override async watch(path: string, onChange: () => void): Promise<() => void> {
    if (!this.deferWatches) return super.watch(path, onChange);
    return new Promise<() => void>(resolve => {
      this.deferred.push(() => void super.watch(path, onChange).then(resolve));
    });
  }

  pendingWatches(): number {
    return this.deferred.length;
  }

  releaseWatches(): void {
    const queued = this.deferred;
    this.deferred = [];
    for (const subscribe of queued) subscribe();
  }
}

function workspace(): DeferredWatchFileSystem {
  const fs = new DeferredWatchFileSystem();
  fs.setFile('/ws/README.md', '# hi');
  fs.setFile('/ws/docs/design.md', '# design');
  fs.setFile('/ws/src/index.ts', 'export {};');
  return fs;
}

function renderTree(fs: FakeFileSystem) {
  return renderHook(() => useFileTree('/ws'), {
    wrapper: ({ children }) => <FileSystemProvider fs={fs}>{children}</FileSystemProvider>,
  });
}

describe('useFileTree watchers', () => {
  it('keeps watching a directory whose subscription resolves after a later expand', async () => {
    const fs = workspace();
    fs.deferWatches = true;
    const { result } = renderTree(fs);
    await waitFor(() => expect(result.current.nodes['/ws']?.childrenLoaded).toBe(true));

    // Two expands land before any watch() promise resolves. The second one
    // re-runs the reconciliation effect, and its cleanup used to make the
    // first directory's in-flight subscription unwatch itself on arrival
    // while leaving its placeholder behind in the map — so the next pass
    // skipped it as "already watched" and it was never resubscribed.
    act(() => result.current.toggle('/ws/docs'));
    act(() => result.current.toggle('/ws/src'));
    expect(fs.pendingWatches()).toBe(3); // root + docs + src

    await act(async () => {
      fs.releaseWatches();
    });
    await waitFor(() => expect(fs.watcherCount()).toBe(3));

    // The live updates those watchers exist for still arrive.
    fs.setFile('/ws/docs/appeared.md', 'new');
    fs.emitChange('/ws/docs');
    await waitFor(() => expect(result.current.nodes['/ws/docs/appeared.md']).toBeDefined());
  });

  it('unwatches a subscription that resolves after the tree unmounted', async () => {
    const fs = workspace();
    fs.deferWatches = true;
    const { result, unmount } = renderTree(fs);
    await waitFor(() => expect(result.current.nodes['/ws']?.childrenLoaded).toBe(true));
    expect(fs.pendingWatches()).toBe(1);

    unmount();
    await act(async () => {
      fs.releaseWatches();
    });

    await waitFor(() => expect(fs.watcherCount()).toBe(0));
  });

  it('drops the least-recently-expanded watchers once the cap is reached', async () => {
    const fs = new DeferredWatchFileSystem();
    const dirs = Array.from({ length: 40 }, (_unused, i) => `/ws/d${String(i).padStart(2, '0')}`);
    for (const dir of dirs) fs.setFile(`${dir}/a.txt`, 'x');
    fs.deferWatches = true;

    const { result } = renderTree(fs);
    await waitFor(() => expect(result.current.nodes['/ws']?.childrenLoaded).toBe(true));
    for (const dir of dirs) act(() => result.current.toggle(dir));

    await act(async () => {
      fs.releaseWatches();
    });

    // 41 directories are expanded (root + 40); only the newest MAX_WATCHERS
    // stay subscribed, and the evicted placeholders don't linger as live
    // handles once their promises land.
    await waitFor(() => expect(fs.watcherCount()).toBe(MAX_WATCHERS));
    await act(async () => {});
    expect(fs.watcherCount()).toBe(MAX_WATCHERS);
  });
});
