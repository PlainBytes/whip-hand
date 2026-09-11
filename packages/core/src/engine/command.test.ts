import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { commandSpec, captureHeader, captureFooter, DEFAULT_SHELL, shellFlags } from './command.ts';
import { verdictFromExit, verdictFromChoice } from './verdict.ts';
import type { CommandStep, RunCtx } from '../types.ts';

// `DEFAULT_SHELL` is `cmd.exe` on Windows and `/bin/sh` elsewhere, and the two
// take different flags — so a test about *templating* has no business pinning
// the flags too. What flag each shell gets is pinned exactly, per shell, by
// 'the flag that runs an inline command varies with the shell' below.
const defaultShell = (run: string): string[] => [DEFAULT_SHELL, ...shellFlags(DEFAULT_SHELL), run];

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1', runSlug: 'r1',
  sessionIds: {}, artifacts: {}, attempts: {},
  inputs: { suite: 'unit' },
};

const step: CommandStep = { kind: 'command', id: 'tests', run: 'npm test', output: 'tests.log' };

test('a command resolves to an ordinary non-interactive SpawnSpec', () => {
  const spec = commandSpec(step, ctx);
  assert.deepEqual(spec.argv, defaultShell('npm test'));
  assert.equal(spec.cwd, '/w');
  assert.equal(spec.interactive, false);
  assert.equal(spec.capture, undefined);
});

test('the command line is templated like a prompt', () => {
  const spec = commandSpec({ ...step, run: 'npm test -- {{ inputs.suite }}' }, ctx);
  assert.deepEqual(spec.argv, defaultShell('npm test -- unit'));
});

test('loop.iteration is available to a command inside a loop', () => {
  const looped = { ...ctx, loop: { id: 'fix', iteration: 2, maxIterations: 3 } };
  const spec = commandSpec({ ...step, run: 'echo attempt {{ loop.iteration }}' }, looped);
  assert.deepEqual(spec.argv, defaultShell('echo attempt 2'));
});

test('cwd resolves relative to the workdir, and an explicit shell is honoured', () => {
  assert.equal(commandSpec({ ...step, cwd: 'sub' }, ctx).cwd, resolve('/w', 'sub'));
  assert.equal(commandSpec({ ...step, cwd: '/abs' }, ctx).cwd, '/abs');
  assert.equal(commandSpec({ ...step, shell: '/bin/bash' }, ctx).argv[0], '/bin/bash');
});

test('the flag that runs an inline command varies with the shell, not just its name', () => {
  assert.deepEqual(
    commandSpec({ ...step, shell: 'cmd.exe' }, ctx).argv,
    ['cmd.exe', '/d', '/s', '/c', 'npm test'],
  );
  assert.deepEqual(
    commandSpec({ ...step, shell: 'C:\\Windows\\System32\\cmd.exe' }, ctx).argv,
    ['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', 'npm test'],
  );
  assert.deepEqual(
    commandSpec({ ...step, shell: 'powershell' }, ctx).argv,
    ['powershell', '-NoProfile', '-Command', 'npm test'],
  );
  assert.deepEqual(
    commandSpec({ ...step, shell: 'pwsh' }, ctx).argv,
    ['pwsh', '-NoProfile', '-Command', 'npm test'],
  );
});

test('an unrecognized shell falls back to -c rather than guessing wrong', () => {
  assert.deepEqual(
    commandSpec({ ...step, shell: 'fish' }, ctx).argv,
    ['fish', '-c', 'npm test'],
  );
});

test('capture rides on the spec so the frontend can tee output to a file', () => {
  const spec = commandSpec(step, ctx, '/w/.whiphand/runs/r1/tests.log');
  assert.deepEqual(spec.capture, { path: '/w/.whiphand/runs/r1/tests.log' });
});

test('step env is merged with the run-dir pointers, and does not leak process env', () => {
  const spec = commandSpec({ ...step, env: { CI: '1' } }, ctx);
  assert.deepEqual(spec.env, {
    CI: '1', WHIPHAND_RUN_DIR: '/w/.whiphand/runs/r1',
    WHIPHAND_RUN_ID: 'r1', WHIPHAND_RUN_SLUG: 'r1', WHIPHAND_STEP_ID: 'tests',
  });
});

test('a named run passes its name and slug to the shell', () => {
  const named: RunCtx = { ...ctx, runName: 'OAuth support', runSlug: 'oauth-support' };
  const spec = commandSpec(step, named);
  assert.equal(spec.env.WHIPHAND_RUN_NAME, 'OAuth support');
  assert.equal(spec.env.WHIPHAND_RUN_SLUG, 'oauth-support');
});

test('WHIPHAND_RUN_NAME is absent rather than empty for an unnamed run', () => {
  assert.ok(!('WHIPHAND_RUN_NAME' in commandSpec(step, ctx).env));
});

test('run.slug renders in the shell line and in cwd, so a worktree step works', () => {
  const named: RunCtx = { ...ctx, runName: 'OAuth support', runSlug: 'oauth-support' };
  const wt: CommandStep = {
    kind: 'command', id: 'wt', output: 'wt.log',
    cwd: '../wt-{{ run.slug }}',
    run: 'git worktree add -b whiphand/{{ run.slug }} .',
  };
  const spec = commandSpec(wt, named);
  // The run line is always last, however many flags the platform's shell took.
  assert.equal(spec.argv[spec.argv.length - 1], 'git worktree add -b whiphand/oauth-support .');
  assert.equal(spec.cwd, resolve('/w', '../wt-oauth-support'));
});

test('the capture header names the command, so the artifact explains itself', () => {
  const spec = commandSpec(step, ctx);
  const header = captureHeader(step, spec.argv, { id: 'fix', iteration: 2, maxIterations: 3 });
  assert.ok(header.includes('$ npm test'));
  assert.ok(header.includes('iteration 2/3'));
  assert.ok(captureFooter(1).includes('exit code: 1'));
});

test('a command verdict is its exit code measured against expect_exit', () => {
  assert.equal(verdictFromExit(0), 'pass');
  assert.equal(verdictFromExit(1), 'fail');
  assert.equal(verdictFromExit(1, [0, 1]), 'pass');
  assert.equal(verdictFromExit(2, [0, 1]), 'fail');
});

test('a manual verdict is the human answer; retry is a deliberate fail', () => {
  assert.equal(verdictFromChoice('continue'), 'pass');
  assert.equal(verdictFromChoice('retry'), 'fail');
  assert.equal(verdictFromChoice('abort'), 'fail');
});
