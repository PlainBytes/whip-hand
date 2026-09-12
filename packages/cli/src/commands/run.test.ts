import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, listRuns } from '@whiphand/core';
import { runCommand } from './run.ts';

/** Runs `fn` with console.error captured, so the message itself is asserted. */
async function withStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    return { code: await fn(), err: lines.join('\n') };
  } finally {
    console.error = original;
  }
}

test('--resume refuses a workflow argument, because the snapshot decides', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  const { code, err } = await withStderr(() => runCommand('cycle', {
    dryRun: false, input: [], cwd, resume: '20260101-000000-aaaa',
  }));

  assert.equal(code, 2);
  assert.match(err, /do not also name one/);
});

test('--resume refuses --dry-run, which mints no artifacts to skip', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  const { code, err } = await withStderr(() => runCommand(undefined, {
    dryRun: true, input: [], cwd, resume: '20260101-000000-aaaa',
  }));

  assert.equal(code, 2);
  assert.match(err, /--dry-run/);
});

test('a plain run with no workflow argument says what is missing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  const { code, err } = await withStderr(() => runCommand(undefined, {
    dryRun: false, input: [], cwd,
  }));

  assert.equal(code, 2);
  assert.match(err, /--resume/);
});

test('--resume reports why a run cannot be resumed rather than throwing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  const { code, err } = await withStderr(() => runCommand(undefined, {
    dryRun: false, input: [], cwd, resume: '20260101-000000-aaaa',
  }));

  assert.equal(code, 1, 'a real refusal is a run failure, not a usage error');
  assert.match(err, /no run/);
});

test('run prints validateWorkflowWarnings diagnostics to stderr', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  await mkdir(join(cwd, '.whiphand', 'workflows'), { recursive: true });
  await writeFile(join(cwd, '.whiphand', 'workflows', 'x.yaml'), `
name: x
steps:
  - id: sign
    kind: approval
    title: "Ship it?"
    instructions: "Look at the diff."
    show_diff: true
    capture: review
    output: feedback.md
`);

  const { code, err } = await withStderr(() => runCommand('x', {
    dryRun: true, input: [], cwd,
  }));

  assert.equal(code, 0);
  assert.match(err, /'review' outside a loop/);
});

/** A workspace whose one workflow reads attachments, from a command step (so a dry run needs no runner). */
async function attachWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  await mkdir(join(cwd, '.whiphand', 'workflows'), { recursive: true });
  await writeFile(join(cwd, '.whiphand', 'workflows', 'triage.yaml'), `
name: triage
steps:
  - id: look
    kind: command
    inputs: [attachments]
    run: ls "$WHIPHAND_RUN_DIR/attachments"
`);
  await writeFile(join(cwd, '.whiphand', 'workflows', 'plain.yaml'), `
name: plain
steps:
  - id: look
    kind: command
    run: "true"
`);
  return cwd;
}

/** Runs `fn` from `dir`, so a relative path means what it would in a shell there. */
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

test('--attach resolves a relative path against the shell cwd, not -C', async () => {
  const workspace = await attachWorkspace();
  const shell = await mkdtemp(join(tmpdir(), 'whiphand-shell-'));
  await writeFile(join(shell, 'bug.png'), 'PNG');

  const { code } = await withStderr(() => inDir(shell, () => runCommand('triage', {
    dryRun: true, json: true, input: [], cwd: workspace, attach: ['bug.png'],
  })));

  assert.equal(code, 0);
  const [run] = await listRuns(workspace, DEFAULT_CONFIG);
  assert.ok(run.status !== 'unknown');
  assert.deepEqual(run.attachments, [
    { name: 'bug.png', path: 'attachments/bug.png', size: 3, source: join(shell, 'bug.png') },
  ]);
});

test('--resume with --attach is a usage error', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  const { code, err } = await withStderr(() => runCommand(undefined, {
    dryRun: false, input: [], cwd, resume: '20260101-000000-aaaa', attach: ['x.png'],
  }));

  assert.equal(code, 2);
  assert.match(err, /--attach/);
});

test('--extra-iterations without --resume is a usage error', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  const { code, err } = await withStderr(() => runCommand('cycle', {
    dryRun: false, input: [], cwd, extraIterations: 2,
  }));

  assert.equal(code, 2);
  assert.match(err, /--extra-iterations/);
  assert.match(err, /--resume/);
});

test('--extra-iterations with --max-iterations is a usage error', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  const { code, err } = await withStderr(() => runCommand(undefined, {
    dryRun: false, input: [], cwd, resume: '20260101-000000-aaaa', extraIterations: 2, maxIterations: 5,
  }));

  assert.equal(code, 2);
  assert.match(err, /--max-iterations/);
  assert.match(err, /--extra-iterations/);
});

test('a missing --attach file is refused with ✘ and exit 2, before any run exists', async () => {
  const cwd = await attachWorkspace();
  const missing = join(cwd, 'nope.png');
  const { code, err } = await withStderr(() => runCommand('triage', {
    dryRun: true, input: [], cwd, attach: [missing],
  }));

  assert.equal(code, 2);
  assert.equal(err, `✘ attachment not found: ${missing}`);
  assert.equal(existsSync(join(cwd, '.whiphand', 'runs')), false);
});

test('attaching to a workflow that reads no attachments is refused with the fix', async () => {
  const cwd = await attachWorkspace();
  await writeFile(join(cwd, 'a.log'), 'x');
  const { code, err } = await withStderr(() => runCommand('plain', {
    dryRun: true, input: [], cwd, attach: [join(cwd, 'a.log')],
  }));

  assert.equal(code, 2);
  assert.match(err, /^✘ 1 file attached, but no step reads `attachments`\./);
  assert.match(err, /inputs: \[attachments\]/);
  assert.equal(existsSync(join(cwd, '.whiphand', 'runs')), false);
});

test('a dry run with --attach records the list and copies nothing', async () => {
  const cwd = await attachWorkspace();
  await writeFile(join(cwd, 'a.log'), 'x');
  const { code } = await withStderr(() => runCommand('triage', {
    dryRun: true, json: true, input: [], cwd, attach: [join(cwd, 'a.log')],
  }));

  assert.equal(code, 0);
  const [run] = await listRuns(cwd, DEFAULT_CONFIG);
  assert.ok(!(await readdir(run.runDir)).includes('attachments'));
});
