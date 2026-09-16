import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, listRuns, WORKFLOW_SNAPSHOT_NAME, MANIFEST_VERSION } from '@whiphand/core';
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

test('SIGINT aborts an in-flight run instead of leaving its spawned child an orphan', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  await mkdir(join(cwd, '.whiphand', 'workflows'), { recursive: true });
  await writeFile(join(cwd, 'wait.js'), 'setTimeout(() => {}, 5000);\n');
  await writeFile(join(cwd, '.whiphand', 'workflows', 'slow.yaml'), `
name: slow
steps:
  - id: wait
    kind: command
    run: node wait.js
`);
  // Not \`sleep 5\`: this runs through a resolved shell (sh -c on POSIX,
  // cmd.exe on Windows, where npm test also runs), and node is guaranteed to
  // be on PATH — sleep/timeout are not, on every platform. A script file
  // rather than \`node -e "..."\`: a quoted script containing ( ) cannot pass
  // through cmd.exe, and exec.ts refuses that shape outright. Command steps
  // run in the workspace, so the relative path resolves on both shells.

  const started = Date.now();
  const promise = withStderr(() => runCommand('slow', { dryRun: false, input: [], cwd }));
  // Give the command step a moment to actually spawn before signalling it.
  await new Promise(resolve => setTimeout(resolve, 200));
  process.emit('SIGINT');

  const { code } = await promise;
  const elapsedMs = Date.now() - started;
  assert.equal(code, 1, 'a cancelled run is not ok');
  assert.ok(
    elapsedMs < 2000,
    `must resolve well before the 5s sleep would exit on its own (took ${elapsedMs}ms)`,
  );
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

// ---------------------------------------------------------------------------
// --yes must be declared, not assumed: a gate inside a `stages` step refuses
// to run unattended unless it opts in with `default: continue` (or `abort`)
// itself. See docs/superpowers/specs/2026-09-08-staged-plans-design.md.
// ---------------------------------------------------------------------------

function stagedWorkflowYaml(gateDefault: string): string {
  return `
name: staged
steps:
  - id: build
    kind: stages
    items: "plans/*.md"
    steps:
      - id: implement
        kind: command
        run: "true"
        output: report.log
      - id: accept
        kind: approval
        title: "Ship it?"
        instructions: "Look."
${gateDefault}
`;
}

/** A workspace with one `stages` workflow and one plan file for it to iterate. */
async function stagedWorkspace(gateDefault: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  await mkdir(join(cwd, '.whiphand', 'workflows'), { recursive: true });
  await mkdir(join(cwd, 'plans'), { recursive: true });
  await writeFile(join(cwd, 'plans', '01-a.md'), '# A\n');
  await writeFile(join(cwd, '.whiphand', 'workflows', 'staged.yaml'), stagedWorkflowYaml(gateDefault));
  return cwd;
}

test('--yes refuses a staged workflow whose gate has no explicit default', async () => {
  const cwd = await stagedWorkspace('');
  const { code, err } = await withStderr(() => runCommand('staged', {
    dryRun: true, input: [], cwd, yes: true,
  }));

  assert.equal(code, 2);
  assert.match(err, /step 'accept': a gate inside stages step 'build' must set an explicit 'default'/);
  assert.match(err, /default: continue/, 'the refusal names the fix');
  assert.equal(existsSync(join(cwd, '.whiphand', 'runs')), false, 'refused before any step ran');
});

test('--yes runs a staged workflow whose gate opted in with default: continue', async () => {
  const cwd = await stagedWorkspace('        default: continue');
  const { code } = await withStderr(() => runCommand('staged', {
    dryRun: true, json: true, input: [], cwd, yes: true,
  }));

  assert.equal(code, 0);
});

test('a plain workflow with an ordinary gate is unaffected by --yes: it has always been allowed to answer it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  await mkdir(join(cwd, '.whiphand', 'workflows'), { recursive: true });
  await writeFile(join(cwd, '.whiphand', 'workflows', 'plain.yaml'), `
name: plain
steps:
  - id: sign
    kind: approval
    title: "Ship it?"
    instructions: "Look."
`);

  const { code } = await withStderr(() => runCommand('plain', {
    dryRun: true, json: true, input: [], cwd, yes: true,
  }));

  assert.equal(code, 0);
});

test('--resume --yes is refused the same way as a fresh run, before the resumed run continues', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-'));
  const runId = '20260101-000000-aaaa';
  const runDir = join(cwd, DEFAULT_CONFIG.artifacts_dir, runId);
  await mkdir(runDir, { recursive: true });
  const manifest = {
    version: MANIFEST_VERSION, runId, workflow: 'staged', workdir: cwd, dryRun: false,
    pid: 999_999, startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:00:00Z', status: 'failed', ok: false,
    inputs: {}, sessionIds: {}, steps: [],
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(manifest), 'utf8');
  await writeFile(join(runDir, WORKFLOW_SNAPSHOT_NAME), stagedWorkflowYaml(''), 'utf8');

  const { code, err } = await withStderr(() => runCommand(undefined, {
    dryRun: false, input: [], cwd, resume: runId, yes: true,
  }));

  assert.equal(code, 2);
  assert.match(err, /step 'accept': a gate inside stages step 'build' must set an explicit 'default'/);
});
