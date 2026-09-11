import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentError, copyAttachments, formatBytes, validateAttachments } from './attachments.ts';
import { WorkflowError } from '../schema.ts';
import type { Step, Workflow } from '../types.ts';

const reads: Workflow = {
  name: 'w',
  steps: [{
    id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: false,
    prompt: 'p', output: 'plan.md', inputs: ['attachments'],
  }],
};

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'whiphand-attach-'));
}

function problemsOf(e: unknown): string[] {
  assert.ok(e instanceof AttachmentError, `expected an AttachmentError, got ${String(e)}`);
  return e.problems;
}

test('no sources is always fine, whatever the workflow reads', async () => {
  assert.deepEqual(await validateAttachments([], { ...reads, steps: [] }, 25), []);
});

test('plans a name, a relative path, a size and a source for each file', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'bug.png'), 'png!');
  const planned = await validateAttachments(
    [{ path: join(dir, 'bug.png') }, { name: 'clip.png', bytes: new Uint8Array([1, 2, 3]) }], reads, 25);
  assert.deepEqual(planned.map(({ from: _f, ...r }) => r), [
    { name: 'bug.png', path: 'attachments/bug.png', size: 4, source: join(dir, 'bug.png') },
    { name: 'pasted-1.png', path: 'attachments/pasted-1.png', size: 3, source: 'pasted' },
  ]);
});

test('refuses an unknown path, naming it', async () => {
  const dir = await scratch();
  const missing = join(dir, 'nope.log');
  const e = await validateAttachments([{ path: missing }], reads, 25).catch(err => err);
  assert.deepEqual(problemsOf(e), [`attachment not found: ${missing}`]);
});

test('refuses a directory', async () => {
  const dir = await scratch();
  const e = await validateAttachments([{ path: dir }], reads, 25).catch(err => err);
  assert.match(problemsOf(e)[0], /is a directory/);
});

test('refuses a relative path — callers resolve it against their own cwd first', async () => {
  const e = await validateAttachments([{ path: 'bug.png' }], reads, 25).catch(err => err);
  assert.match(problemsOf(e)[0], /must be absolute/);
});

test('refuses a file over the cap with its size, the cap and the config key', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'big.bin'), Buffer.alloc(3 * 1024 * 1024));
  const e = await validateAttachments([{ path: join(dir, 'big.bin') }], reads, 2).catch(err => err);
  const [problem] = problemsOf(e);
  assert.match(problem, /big\.bin/);
  assert.match(problem, /3\.0 MB/);
  assert.match(problem, /2 MB limit/);
  assert.match(problem, /runs\.max_attachment_mb/);
});

test('refuses pasted bytes over the cap too', async () => {
  const e = await validateAttachments(
    [{ name: 'x.png', bytes: new Uint8Array(1024 * 1024 + 1) }], reads, 1).catch(err => err);
  assert.match(problemsOf(e)[0], /'pasted-1\.png' is 1\.0 MB, over the 1 MB limit/);
});

test('refuses files nothing reads, with the fix in the message', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'a.log'), 'x');
  const unused: Workflow = { ...reads, steps: [{ ...reads.steps[0], inputs: undefined } as Step] };
  const e = await validateAttachments([{ path: join(dir, 'a.log') }], unused, 25).catch(err => err);
  assert.ok(e instanceof WorkflowError, 'callers that refuse a bad workflow refuse this the same way');
  assert.match(e.message, /^1 file attached, but no step reads `attachments`\./);
  assert.match(e.message, /inputs: \[attachments\]/);
});

test('refuses when the only consumer is disabled', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'a.log'), 'x');
  const disabled: Workflow = {
    ...reads,
    steps: [{ ...reads.steps[0], enabled: false } as Step, { ...reads.steps[0], id: 'b', inputs: undefined } as Step],
  };
  const e = await validateAttachments([{ path: join(dir, 'a.log') }], disabled, 25).catch(err => err);
  assert.match(problemsOf(e).at(-1)!, /no step reads `attachments`/);
});

test('reports every problem at once', async () => {
  const dir = await scratch();
  const e = await validateAttachments([{ path: join(dir, 'x') }, { path: dir }], { ...reads, steps: [] }, 25)
    .catch(err => err);
  assert.equal(problemsOf(e).length, 3);
});

test('copies into attachments/ under the final names, bytes for bytes', async () => {
  const src = await scratch();
  const runDir = await scratch();
  await mkdir(join(src, 'one'));
  await mkdir(join(src, 'two'));
  await writeFile(join(src, 'one', 'log.txt'), 'first');
  await writeFile(join(src, 'two', 'log.txt'), 'second');
  const planned = await validateAttachments([
    { path: join(src, 'one', 'log.txt') },
    { path: join(src, 'two', 'log.txt') },
    { name: 'shot.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  ], reads, 25);

  await copyAttachments(runDir, planned);

  assert.deepEqual((await readdir(join(runDir, 'attachments'))).sort(), ['log-2.txt', 'log.txt', 'pasted-1.png']);
  assert.equal(await readFile(join(runDir, 'attachments', 'log.txt'), 'utf8'), 'first');
  assert.equal(await readFile(join(runDir, 'attachments', 'log-2.txt'), 'utf8'), 'second');
  assert.deepEqual([...await readFile(join(runDir, 'attachments', 'pasted-1.png'))], [0x89, 0x50, 0x4e, 0x47]);
});

test('copying never overwrites a file already there', async () => {
  const src = await scratch();
  const runDir = await scratch();
  await writeFile(join(src, 'a.txt'), 'new');
  await mkdir(join(runDir, 'attachments'));
  await writeFile(join(runDir, 'attachments', 'a.txt'), 'old');
  const planned = await validateAttachments([{ path: join(src, 'a.txt') }], reads, 25);
  await assert.rejects(copyAttachments(runDir, planned), /EEXIST/);
  assert.equal(await readFile(join(runDir, 'attachments', 'a.txt'), 'utf8'), 'old');
});

test('formatBytes', () => {
  assert.equal(formatBytes(12), '12 B');
  assert.equal(formatBytes(340 * 1024), '340 KB');
  assert.equal(formatBytes(1.25 * 1024 * 1024), '1.3 MB');
});
