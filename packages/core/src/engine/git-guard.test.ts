import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { snapshotTree, diffSnapshots, pathsOutside } from './git-guard.ts';

const run = promisify(execFile);

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-git-'));
  await run('git', ['init', '-b', 'main'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'hello\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: dir });
  return dir;
}

test('non-repo returns null (guard disabled)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-plain-'));
  assert.equal(await snapshotTree(dir), null);
});

test('unchanged tree diffs empty', async () => {
  const dir = await gitRepo();
  const before = await snapshotTree(dir);
  const after = await snapshotTree(dir);
  assert.notEqual(before, null);
  assert.deepEqual(diffSnapshots(before!, after!), []);
});

test('detects modified and new files', async () => {
  const dir = await gitRepo();
  const before = await snapshotTree(dir);
  await writeFile(join(dir, 'a.txt'), 'changed\n');
  await writeFile(join(dir, 'new.txt'), 'new\n');
  const after = await snapshotTree(dir);
  const changed = diffSnapshots(before!, after!);
  assert.ok(changed.some(p => p.includes('a.txt')));
  assert.ok(changed.some(p => p.includes('new.txt')));
});

test('ignores changes under .whiphand/', async () => {
  const dir = await gitRepo();
  const before = await snapshotTree(dir);
  await mkdir(join(dir, '.whiphand', 'runs', 'r1'), { recursive: true });
  await writeFile(join(dir, '.whiphand', 'runs', 'r1', 'plan.md'), 'plan\n');
  const after = await snapshotTree(dir);
  assert.deepEqual(diffSnapshots(before!, after!), []);
});

test('pathsOutside returns only the paths no glob covers', () => {
  const globs = ['docs/plans/oauth/**', 'CHANGELOG.md'];
  assert.deepEqual(
    pathsOutside(['docs/plans/oauth/01-schema.md', 'CHANGELOG.md', 'src/app.ts'], globs), ['src/app.ts']);
});

test('a glob with no wildcard still matches its own path', () => {
  assert.deepEqual(pathsOutside(['CHANGELOG.md'], ['CHANGELOG.md']), []);
});
