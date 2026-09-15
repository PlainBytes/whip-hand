import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MAX_DIFF_FILES, MAX_PATCH_BYTES, pairPatches, parseNumstatZ, splitPatch, workingDiffFiles,
} from './diff.ts';
import type { DiffFileEntry, WorkingDiff } from './diff.ts';

const run = promisify(execFile);

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-diff-'));
  await run('git', ['init', '-b', 'main'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'a\nb\nc\nd\ne\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: dir });
  return dir;
}

/** The real index and worktree state, for asserting we left no trace. */
async function status(dir: string): Promise<string> {
  const { stdout } = await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: dir });
  return stdout;
}

function find(result: WorkingDiff, path: string): DiffFileEntry | undefined {
  return result.files.find(f => f.path === path);
}

// ---------------------------------------------------------------- pure parts

test('parseNumstatZ reads an ordinary record', () => {
  assert.deepEqual(parseNumstatZ('12\t3\tsrc/a.ts\0'), [
    { path: 'src/a.ts', additions: 12, deletions: 3, binary: false },
  ]);
});

test('parseNumstatZ tolerates the trailing newline git appends after the final NUL', () => {
  // Real output ends `...a.ts\0\n`; a naive filter(Boolean) leaves a "\n" field.
  assert.deepEqual(parseNumstatZ('1\t0\ta.ts\0\n'), [
    { path: 'a.ts', additions: 1, deletions: 0, binary: false },
  ]);
});

test('parseNumstatZ reads a rename as an empty path field plus two more fields', () => {
  assert.deepEqual(parseNumstatZ('1\t1\t\0old.txt\0new name.txt\0'), [
    { path: 'new name.txt', oldPath: 'old.txt', additions: 1, deletions: 1, binary: false },
  ]);
});

test('parseNumstatZ marks a binary record and zeroes its counts', () => {
  assert.deepEqual(parseNumstatZ('-\t-\tb.png\0'), [
    { path: 'b.png', additions: 0, deletions: 0, binary: true },
  ]);
});

test('parseNumstatZ keeps a path containing a literal tab', () => {
  // -z does not quote, so splitting on \t instead of indexOf would truncate this.
  assert.deepEqual(parseNumstatZ('1\t0\tweird\tname.txt\0'), [
    { path: 'weird\tname.txt', additions: 1, deletions: 0, binary: false },
  ]);
});

test('parseNumstatZ reads a mixed stream in order', () => {
  const entries = parseNumstatZ('-\t-\tb.png\0' + '1\t1\t\0old.txt\0new.txt\0' + '4\t0\tz.ts\0\n');
  assert.deepEqual(entries.map(e => e.path), ['b.png', 'new.txt', 'z.ts']);
});

test('splitPatch keeps the header with its chunk', () => {
  const patch = 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n@@ -1 +1 @@\n-c\n+d\n';
  const chunks = splitPatch(patch);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].startsWith('diff --git a/x b/x'));
  assert.ok(chunks[1].startsWith('diff --git a/y b/y'));
});

test('splitPatch is not fooled by a diff header inside a hunk body', () => {
  // Reviewing a .patch file: the inner header is prefixed, so ^ never matches it.
  const patch = 'diff --git a/p.patch b/p.patch\n@@ -1 +1 @@\n+diff --git a/inner b/inner\n';
  assert.equal(splitPatch(patch).length, 1);
});

test('splitPatch returns nothing for an empty patch', () => {
  assert.deepEqual(splitPatch(''), []);
  assert.deepEqual(splitPatch('\n'), []);
});

test('pairPatches refuses to pair when the two lists disagree in length', () => {
  // The integrity guard: a wrong pairing shows one file's diff under another's
  // name on a screen someone is about to approve.
  const entries = parseNumstatZ('1\t0\ta.ts\0' + '2\t0\tb.ts\0');
  const result = pairPatches(entries, ['diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+x\n']);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].patch, undefined);
  assert.equal(result.files[1].patch, undefined);
  assert.equal(result.patchesOmitted, 2);
  // Counts survive, so the rail is still correct.
  assert.equal(result.files[0].additions, 1);
  assert.equal(result.files[1].additions, 2);
});

test('pairPatches drops a patch over MAX_PATCH_BYTES but keeps the entry', () => {
  const entries = parseNumstatZ('1\t0\tbig.ts\0');
  const huge = `diff --git a/big.ts b/big.ts\n@@ -0,0 +1 @@\n+${'x'.repeat(MAX_PATCH_BYTES)}\n`;
  const result = pairPatches(entries, [huge]);
  assert.equal(result.files[0].patch, undefined);
  assert.equal(result.files[0].truncated, true);
  assert.equal(result.patchesOmitted, 1);
});

test('pairPatches derives added and deleted from the chunk header', () => {
  const entries = parseNumstatZ('1\t0\tnew.ts\0' + '0\t1\tgone.ts\0');
  const result = pairPatches(entries, [
    'diff --git a/new.ts b/new.ts\nnew file mode 100644\n@@ -0,0 +1 @@\n+x\n',
    'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n@@ -1 +0,0 @@\n-x\n',
  ]);
  assert.equal(result.files[0].status, 'added');
  assert.equal(result.files[1].status, 'deleted');
});

// ------------------------------------------------------------ against real git

test('a directory that is not a repo returns null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-plain-'));
  assert.equal(await workingDiffFiles(dir), null);
});

test('a clean repo returns an empty list, not null', async () => {
  // The distinction is the whole point: null is "no repo", [] is "no changes",
  // and they render as completely different screens.
  const dir = await gitRepo();
  assert.deepEqual(await workingDiffFiles(dir), { files: [] });
});

test('reports a modified file with counts and a patch', async () => {
  const dir = await gitRepo();
  await writeFile(join(dir, 'a.txt'), 'a\nb\nc\nd\nZ\n');
  const result = await workingDiffFiles(dir);
  const file = find(result!, 'a.txt')!;
  assert.equal(file.status, 'modified');
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 1);
  assert.ok(file.patch!.includes('@@'));
  assert.ok(file.patch!.includes('+Z'));
});

test('reports an untracked file as an addition', async () => {
  // The regression test for the bug this module exists to fix: `git diff HEAD`
  // omits untracked files entirely, so a file a step just created was invisible.
  const dir = await gitRepo();
  await writeFile(join(dir, 'brand-new.ts'), 'export const x = 1;\n');
  const result = await workingDiffFiles(dir);
  const file = find(result!, 'brand-new.ts')!;
  assert.equal(file.status, 'added');
  assert.equal(file.additions, 1);
  assert.ok(file.patch!.includes('+export const x = 1;'));
});

test('leaves the real index and git status untouched', async () => {
  const dir = await gitRepo();
  await writeFile(join(dir, 'a.txt'), 'changed\n');
  await writeFile(join(dir, 'untracked.txt'), 'new\n');
  const before = await status(dir);
  await workingDiffFiles(dir);
  assert.equal(await status(dir), before);
});

test('reports a deleted file', async () => {
  const dir = await gitRepo();
  await rm(join(dir, 'a.txt'));
  const file = find((await workingDiffFiles(dir))!, 'a.txt')!;
  assert.equal(file.status, 'deleted');
  assert.equal(file.deletions, 5);
});

test('reports a rename with both paths', async () => {
  const dir = await gitRepo();
  await run('git', ['mv', 'a.txt', 'b.txt'], { cwd: dir });
  const file = find((await workingDiffFiles(dir))!, 'b.txt')!;
  assert.equal(file.status, 'renamed');
  assert.equal(file.oldPath, 'a.txt');
});

test('a rename into a path with a space keeps the path exact and pairs correctly', async () => {
  // This is the test that fails if anyone ever "simplifies" splitPatch into
  // parsing `diff --git a/… b/…` — git does not quote a space, so that header
  // is genuinely ambiguous.
  const dir = await gitRepo();
  await run('git', ['mv', 'a.txt', 'b c.txt'], { cwd: dir });
  await writeFile(join(dir, 'b c.txt'), 'a\nb\nc\nd\nZ\n');
  const file = find((await workingDiffFiles(dir))!, 'b c.txt')!;
  assert.equal(file.status, 'renamed');
  assert.equal(file.oldPath, 'a.txt');
  assert.ok(file.patch!.includes('+Z'));
});

test('pairs the right patch to each of two files when one path contains a space', async () => {
  const dir = await gitRepo();
  await mkdir(join(dir, 'a b'), { recursive: true });
  await writeFile(join(dir, 'a b', 'c.txt'), 'spaced\n');
  await writeFile(join(dir, 'x.txt'), 'plain\n');
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'two'], { cwd: dir });
  await writeFile(join(dir, 'a b', 'c.txt'), 'SPACED\n');
  await writeFile(join(dir, 'x.txt'), 'PLAIN\n');

  const result = await workingDiffFiles(dir);
  assert.ok(find(result!, 'a b/c.txt')!.patch!.includes('+SPACED'));
  assert.ok(find(result!, 'x.txt')!.patch!.includes('+PLAIN'));
});

test('reports a binary file without a patch', async () => {
  const dir = await gitRepo();
  await writeFile(join(dir, 'b.png'), Buffer.from([0, 1, 2, 3]));
  const file = find((await workingDiffFiles(dir))!, 'b.png')!;
  assert.equal(file.binary, true);
  assert.equal(file.patch, undefined);
});

test('handles a non-ASCII path identically whatever core.quotepath says', async () => {
  const dir = await gitRepo();
  await writeFile(join(dir, 'café.txt'), 'x\n');
  await run('git', ['config', 'core.quotepath', 'true'], { cwd: dir });
  const quoted = await workingDiffFiles(dir);
  await run('git', ['config', 'core.quotepath', 'false'], { cwd: dir });
  const unquoted = await workingDiffFiles(dir);
  assert.deepEqual(quoted, unquoted);
  assert.ok(find(quoted!, 'café.txt'));
});

test('is immune to a hostile local gitconfig', async () => {
  // Every -c flag in the implementation earns its place here.
  const dir = await gitRepo();
  await writeFile(join(dir, 'a.txt'), 'a\nb\nc\nd\nZ\n');
  const plain = await workingDiffFiles(dir);
  for (const [key, value] of [
    ['diff.renames', 'false'], ['color.ui', 'always'], ['diff.context', '10'],
    ['diff.noprefix', 'true'],
  ]) {
    await run('git', ['config', key, value], { cwd: dir });
  }
  assert.deepEqual(await workingDiffFiles(dir), plain);
});

test('excludes the run directory under .whiphand/', async () => {
  // whiphand init writes no .gitignore, so a run's own plan.md is untracked and
  // would otherwise dominate the review it is the subject of.
  const dir = await gitRepo();
  await mkdir(join(dir, '.whiphand', 'runs', 'r1'), { recursive: true });
  await writeFile(join(dir, '.whiphand', 'runs', 'r1', 'plan.md'), 'plan\n');
  await writeFile(join(dir, 'real.ts'), 'x\n');
  const result = await workingDiffFiles(dir);
  assert.deepEqual(result!.files.map(f => f.path), ['real.ts']);
});

test('still diffs when .whiphand/ itself is gitignored', async () => {
  // git rejects an exclude pathspec whose literal prefix is an ignored path.
  const dir = await gitRepo();
  await writeFile(join(dir, '.gitignore'), '.whiphand/\n');
  await mkdir(join(dir, '.whiphand', 'runs', 'r1'), { recursive: true });
  await writeFile(join(dir, '.whiphand', 'runs', 'r1', 'plan.md'), 'plan\n');
  await writeFile(join(dir, 'real.ts'), 'x\n');
  const result = await workingDiffFiles(dir);
  assert.deepEqual(result!.files.map(f => f.path).sort(), ['.gitignore', 'real.ts']);
});

test('a repo with no commits reports everything as added', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-empty-'));
  await run('git', ['init', '-b', 'main'], { cwd: dir });
  await writeFile(join(dir, 'first.ts'), 'x\n');
  const file = find((await workingDiffFiles(dir))!, 'first.ts')!;
  assert.equal(file.status, 'added');
});

test('caps the file list and says how many it dropped', async () => {
  const dir = await gitRepo();
  const extra = 20;
  for (let i = 0; i < MAX_DIFF_FILES + extra; i++) {
    await writeFile(join(dir, `f${i}.txt`), `${i}\n`);
  }
  const result = await workingDiffFiles(dir);
  assert.equal(result!.files.length, MAX_DIFF_FILES);
  // a.txt is unchanged, so the tree holds exactly the files we just wrote.
  assert.equal(result!.filesTruncated, extra);
});
