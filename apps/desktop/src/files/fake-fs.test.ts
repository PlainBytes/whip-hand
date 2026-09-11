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

  it('records granted roots', async () => {
    const fs = ws();
    await fs.ensureGranted('/ws');
    expect(fs.grantedRoots).toEqual(['/ws']);
  });
});
