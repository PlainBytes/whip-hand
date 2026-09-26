import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { snapshotTree, diffSnapshots, pathsOutside, headSha, headPosition, classifyGitFailure } from './git-guard.ts';

const run = promisify(execFile);

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-git-'));
  await run('git', ['init', '-b', 'main'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'hello\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: dir });
  return dir;
}

/** The tree, asserting it was actually seen. */
async function treeOf(dir: string): Promise<string> {
  const snapshot = await snapshotTree(dir);
  assert.equal(snapshot.kind, 'ok', JSON.stringify(snapshot));
  return snapshot.kind === 'ok' ? snapshot.tree : '';
}

test('a directory that is not a repository is `not-a-repo`, and only that', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-plain-'));
  assert.deepEqual(await snapshotTree(dir), { kind: 'not-a-repo' });
  assert.deepEqual(await headSha(dir), { kind: 'not-a-repo' });
});

test('git failing when it was expected to work is `unavailable`, with git\'s own words', async () => {
  const dir = await gitRepo();
  // A corrupt index makes `git status` exit 128 — the same code as "not a repository".
  await writeFile(join(dir, '.git', 'index'), 'this is not an index');
  const snapshot = await snapshotTree(dir);
  assert.equal(snapshot.kind, 'unavailable', JSON.stringify(snapshot));
  if (snapshot.kind === 'unavailable') assert.match(snapshot.reason, /exit 128/);
});

test('an unusable working directory is `unavailable` rather than a repository that is not there', async () => {
  const snapshot = await snapshotTree(join(tmpdir(), 'whiphand-no-such-dir-xyz'));
  assert.equal(snapshot.kind, 'unavailable');
});

test('classification: exit 128 *and* `not a git repository`, nothing looser', () => {
  const failure = (code: number | string, stderr: string) => classifyGitFailure({ code, stderr, message: 'boom' });
  assert.deepEqual(failure(128, 'fatal: not a git repository (or any of the parent directories): .git\n'), { kind: 'not-a-repo' });
  // Exit 128 alone is not enough: dubious ownership is 128 too, and is the case that matters.
  const ownership = failure(128, "fatal: detected dubious ownership in repository at 'C:/w'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory C:/w\n");
  assert.equal(ownership.kind, 'unavailable');
  assert.match((ownership as { reason: string }).reason, /dubious ownership/);
  // And the words alone are not enough without the code.
  assert.equal(failure(1, 'fatal: not a git repository').kind, 'unavailable');
  assert.equal(failure('ENOENT', '').kind, 'unavailable');
  assert.equal(failure('ETIMEDOUT', '').kind, 'unavailable');
  assert.equal(classifyGitFailure(new Error('spawn git ENOENT')).kind, 'unavailable');
});

test('git runs under LC_ALL=C, so its wording cannot be localized away from the classifier', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-plain-'));
  // Even under a hostile locale in our own environment, a non-repo is still recognised.
  const saved = { LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE, LANG: process.env.LANG };
  process.env.LC_ALL = 'de_DE.UTF-8'; process.env.LANGUAGE = 'de'; process.env.LANG = 'de_DE.UTF-8';
  try {
    assert.deepEqual(await snapshotTree(dir), { kind: 'not-a-repo' });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('headSha reports the commit', async () => {
  const dir = await gitRepo();
  const head = await headSha(dir);
  assert.equal(head.kind, 'ok');
  if (head.kind === 'ok') assert.match(head.sha, /^[0-9a-f]{40}$/);
});

test('headPosition reports the commit, and an unborn HEAD as a null sha rather than a failure', async () => {
  const dir = await gitRepo();
  const head = await headPosition(dir);
  assert.equal(head.kind, 'ok');
  if (head.kind === 'ok') assert.match(head.sha ?? '', /^[0-9a-f]{40}$/);

  const fresh = await mkdtemp(join(tmpdir(), 'whiphand-unborn-'));
  await run('git', ['init', '-b', 'main'], { cwd: fresh });
  assert.deepEqual(await headPosition(fresh), { kind: 'ok', sha: null }, 'no commits yet is a fact, not a failure');

  const plain = await mkdtemp(join(tmpdir(), 'whiphand-plain-'));
  assert.deepEqual(await headPosition(plain), { kind: 'not-a-repo' });
});

test('unchanged tree diffs empty', async () => {
  const dir = await gitRepo();
  const before = await treeOf(dir);
  const after = await treeOf(dir);
  assert.deepEqual(diffSnapshots(before, after), []);
});

test('detects modified and new files', async () => {
  const dir = await gitRepo();
  const before = await treeOf(dir);
  await writeFile(join(dir, 'a.txt'), 'changed\n');
  await writeFile(join(dir, 'new.txt'), 'new\n');
  const after = await treeOf(dir);
  const changed = diffSnapshots(before, after);
  assert.ok(changed.some(p => p.includes('a.txt')));
  assert.ok(changed.some(p => p.includes('new.txt')));
});

test('ignores changes under .whiphand/', async () => {
  const dir = await gitRepo();
  const before = await treeOf(dir);
  await mkdir(join(dir, '.whiphand', 'runs', 'r1'), { recursive: true });
  await writeFile(join(dir, '.whiphand', 'runs', 'r1', 'plan.md'), 'plan\n');
  const after = await treeOf(dir);
  assert.deepEqual(diffSnapshots(before, after), []);
});

test('the .whiphand exclusion is by whole segment, so a lookalike name is still a change', () => {
  assert.deepEqual(diffSnapshots('', '?? .whiphand/runs/r1/plan.md'), []);
  assert.deepEqual(diffSnapshots('', '?? sub/.whiphand/x'), []);
  assert.deepEqual(diffSnapshots('', '?? not.whiphand/x.md'), ['?? not.whiphand/x.md']);
  assert.deepEqual(diffSnapshots('', '?? .whiphand-notes.md'), ['?? .whiphand-notes.md']);
});

test('pathsOutside returns only the paths no glob covers', () => {
  const globs = ['docs/plans/oauth/**', 'CHANGELOG.md'];
  assert.deepEqual(
    pathsOutside(['docs/plans/oauth/01-schema.md', 'CHANGELOG.md', 'src/app.ts'], globs), ['src/app.ts']);
});

test('a glob with no wildcard still matches its own path', () => {
  assert.deepEqual(pathsOutside(['CHANGELOG.md'], ['CHANGELOG.md']), []);
});
