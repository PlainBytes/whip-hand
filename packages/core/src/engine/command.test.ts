import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commandSpec, captureHeader, captureFooter, envValueLimit } from './command.ts';
import { verdictFromExit, verdictFromChoice } from './verdict.ts';
import { execRunner } from '../exec.ts';
import { resolveShell } from '../shell.ts';
import { TemplateError } from '../template.ts';
import type { CommandStep, RunCtx } from '../types.ts';

// Command steps run through a POSIX shell on every OS. The tests below pass the
// shell on the ctx, as `runWorkflow` does after resolving it once per run.
const SH = '/bin/sh';
const defaultShell = (run: string): string[] => [SH, '-c', run];

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1', runSlug: 'r1', shell: SH,
  sessionIds: {}, artifacts: {}, attempts: {}, verdicts: {},
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

test('`{{ x }}` in `run` becomes a variable reference, not the value (invariant 8)', () => {
  const spec = commandSpec({ ...step, run: 'npm test -- {{ inputs.suite }}' }, ctx);
  assert.deepEqual(spec.argv, defaultShell('npm test -- ${WHIPHAND_INPUT_SUITE}'));
  assert.equal(spec.env.WHIPHAND_INPUT_SUITE, 'unit');
});

test('loop.iteration is a reference too, and is exported inside a loop', () => {
  const looped = { ...ctx, loop: { id: 'fix', iteration: 2, maxIterations: 3 } };
  const spec = commandSpec({ ...step, run: 'echo attempt {{ loop.iteration }} of {{ loop.max_iterations }}' }, looped);
  assert.deepEqual(spec.argv, defaultShell('echo attempt ${WHIPHAND_LOOP_ITERATION} of ${WHIPHAND_LOOP_MAX_ITERATIONS}'));
  assert.equal(spec.env.WHIPHAND_LOOP_ITERATION, '2');
  assert.equal(spec.env.WHIPHAND_LOOP_MAX_ITERATIONS, '3');
});

test('loop and stage variables are absent outside their constructs', () => {
  const env = commandSpec(step, ctx).env;
  assert.equal(Object.keys(env).some(k => k.startsWith('WHIPHAND_LOOP_') || k.startsWith('WHIPHAND_STAGE_')), false);
});

test('an input is exported only when this step references it, by run, env or cwd', () => {
  const many: RunCtx = { ...ctx, inputs: { a: '1', b: '2', c: '3', d: '4' } };
  const spec = commandSpec(
    { kind: 'command', id: 'c', run: 'echo {{ inputs.a }}', cwd: '{{ inputs.b }}', env: { X: '{{ inputs.c }}' } }, many);
  assert.equal(spec.env.WHIPHAND_INPUT_A, '1');
  assert.equal(spec.env.WHIPHAND_INPUT_B, '2');
  assert.equal(spec.env.WHIPHAND_INPUT_C, '3');
  assert.equal('WHIPHAND_INPUT_D' in spec.env, false, 'exported equals referenced');
  assert.equal(spec.env.X, '3', 'env values are data, so they get the value itself');
});

test('an input key with a dash maps to an underscore in its variable name', () => {
  const spec = commandSpec({ ...step, run: 'echo {{ inputs.test-command }}' }, { ...ctx, inputs: { 'test-command': 'npm test' } });
  assert.match(spec.argv[2], /\$\{WHIPHAND_INPUT_TEST_COMMAND\}/);
  assert.equal(spec.env.WHIPHAND_INPUT_TEST_COMMAND, 'npm test');
});

test('a referenced input over the environment limit fails the step before spawn, naming the input and its size', () => {
  const huge = 'x'.repeat(envValueLimit() + 1);
  assert.throws(
    () => commandSpec({ ...step, run: 'echo {{ inputs.blob }}' }, { ...ctx, inputs: { blob: huge } }),
    (error: Error) => error instanceof TemplateError && /input 'blob' is \d+ (bytes|characters), over the \d+/.test(error.message),
  );
  // Unreferenced, the same input is never exported, so it cannot fail anything.
  assert.doesNotThrow(() => commandSpec(step, { ...ctx, inputs: { blob: huge } }));
  assert.equal(envValueLimit('win32'), 32_767);
  assert.equal(envValueLimit('linux'), 128 * 1024);
});

test('an unknown input is refused, as it always was', () => {
  assert.throws(() => commandSpec({ ...step, run: 'echo {{ inputs.nope }}' }, ctx), /unknown input 'nope'/);
});

test('cwd resolves relative to the workdir, and an explicit shell is honoured', () => {
  assert.equal(commandSpec({ ...step, cwd: 'sub' }, ctx).cwd, resolve('/w', 'sub'));
  assert.equal(commandSpec({ ...step, cwd: '/abs' }, ctx).cwd, '/abs');
  assert.equal(commandSpec({ ...step, shell: '/bin/bash' }, ctx).argv[0], '/bin/bash');
});

test('every shell takes -c: there is one dialect, so no per-shell flags', () => {
  // cmd and PowerShell are refused at parse time (schema.ts); anything else is the author's own choice.
  for (const shell of ['/bin/bash', 'bash', 'zsh', 'fish', 'C:/Program Files/Git/usr/bin/sh.exe']) {
    assert.deepEqual(commandSpec({ ...step, shell }, ctx).argv, [shell, '-c', 'npm test'], shell);
  }
});

test('with no shell on the ctx, the step resolves one itself rather than defaulting to cmd.exe', () => {
  const bare: RunCtx = { ...ctx, shell: undefined };
  const resolved = resolveShell();
  if (!resolved.ok) return; // a Windows box with no Git: nothing to assert
  assert.equal(commandSpec(step, bare).argv[0], resolved.path);
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

test('{{ run.dir }} in run: is a reference to WHIPHAND_RUN_DIR, and a value everywhere else', () => {
  const spec = commandSpec({ kind: 'command', id: 'c', run: 'ls "{{ run.dir }}/plans"', env: { PLANS: '{{ run.dir }}/plans' } }, ctx);
  assert.equal(spec.argv.at(-1), 'ls "${WHIPHAND_RUN_DIR}/plans"');
  assert.equal(spec.env.WHIPHAND_RUN_DIR, '/w/.whiphand/runs/r1');
  assert.equal(spec.env.PLANS, '/w/.whiphand/runs/r1/plans');
});

test('env paths are absolute with forward slashes, whatever the platform wrote them as', () => {
  const win: RunCtx = { ...ctx, runDir: 'C:\\Users\\me\\proj\\.whiphand\\runs\\r1', artifacts: { plan: 'C:\\Users\\me\\proj\\.whiphand\\runs\\r1\\plan.md' } };
  const spec = commandSpec({ kind: 'command', id: 'c', run: 'true', inputs: ['plan'] }, win);
  assert.equal(spec.env.WHIPHAND_RUN_DIR, 'C:/Users/me/proj/.whiphand/runs/r1');
  assert.equal(spec.env.WHIPHAND_ARTIFACT_PLAN, 'C:/Users/me/proj/.whiphand/runs/r1/plan.md');
});

test('a named run passes its name and slug to the shell', () => {
  const named: RunCtx = { ...ctx, runName: 'OAuth support', runSlug: 'oauth-support' };
  const spec = commandSpec(step, named);
  assert.equal(spec.env.WHIPHAND_RUN_NAME, 'OAuth support');
  assert.equal(spec.env.WHIPHAND_RUN_SLUG, 'oauth-support');
});

test('WHIPHAND_RUN_NAME is absent rather than empty for an unnamed run, and {{ run.name }} then refers to the id', () => {
  assert.ok(!('WHIPHAND_RUN_NAME' in commandSpec(step, ctx).env));
  const spec = commandSpec({ ...step, run: 'echo {{ run.name }}' }, ctx);
  assert.equal(spec.argv[2], 'echo ${WHIPHAND_RUN_ID}');
  assert.equal(spec.env.WHIPHAND_RUN_ID, 'r1');
});

test('run.slug renders in the shell line and in cwd, so a worktree step works', () => {
  const named: RunCtx = { ...ctx, runName: 'OAuth support', runSlug: 'oauth-support' };
  const wt: CommandStep = {
    kind: 'command', id: 'wt', output: 'wt.log',
    cwd: '../wt-{{ run.slug }}',
    run: 'git worktree add -b whiphand/{{ run.slug }} .',
  };
  const spec = commandSpec(wt, named);
  // `run` is a reference; `cwd` is data, so it gets the value.
  assert.equal(spec.argv[spec.argv.length - 1], 'git worktree add -b whiphand/${WHIPHAND_RUN_SLUG} .');
  assert.equal(spec.env.WHIPHAND_RUN_SLUG, 'oauth-support');
  assert.equal(spec.cwd, resolve('/w', '../wt-oauth-support'));
});

test('run.dir in `run` refers to $WHIPHAND_RUN_DIR, absolute with forward slashes', () => {
  const win: RunCtx = { ...ctx, runDir: 'C:\\Users\\me\\proj\\.whiphand\\runs\\r1' };
  const spec = commandSpec({ ...step, run: 'ls {{ run.dir }}/plans' }, win);
  assert.equal(spec.argv[spec.argv.length - 1], 'ls ${WHIPHAND_RUN_DIR}/plans');
  assert.equal(spec.env.WHIPHAND_RUN_DIR, 'C:/Users/me/proj/.whiphand/runs/r1');
});

test('the capture header names the command, so the artifact explains itself', () => {
  const spec = commandSpec(step, ctx);
  const header = captureHeader(step, spec.argv, { id: 'fix', iteration: 2, maxIterations: 3 });
  assert.ok(header.includes('$ npm test'));
  assert.ok(header.includes('iteration 2/3'));
  const staged = captureHeader(step, spec.argv, {
    kind: 'stages', id: 'build', attempt: 2, maxAttempts: 3,
    stage: { index: 1, total: 4, id: '01-schema', title: 'Schema', path: '/w/plans/01-schema.md' },
  });
  assert.ok(staged.includes("stage 1/4 '01-schema', attempt 2/3"));
  assert.ok(captureFooter(1).includes('exit code: 1'));
});

test('a command step exports each input artifact as an environment variable', () => {
  const withArtifacts: RunCtx = { ...ctx, artifacts: { 'execute-report': '/run/exec.md', plan: '/run/plan.md' } };
  const spec = commandSpec(
    { kind: 'command', id: 'commit', run: 'git commit', inputs: ['execute-report', 'plan'] }, withArtifacts);
  assert.equal(spec.env.WHIPHAND_ARTIFACT_EXECUTE_REPORT, '/run/exec.md');
  assert.equal(spec.env.WHIPHAND_ARTIFACT_PLAN, '/run/plan.md');
});

test('an `attachments` input never becomes a WHIPHAND_ARTIFACT_* variable — a command reads those from the run dir', () => {
  const withAttachments: RunCtx = {
    ...ctx,
    artifacts: { plan: '/run/plan.md' },
    attachments: ['/w/.whiphand/runs/r1/attachments/bug.png', '/w/.whiphand/runs/r1/attachments/log.txt'],
  };
  const spec = commandSpec(
    { kind: 'command', id: 'c', run: 'true', inputs: ['attachments', 'plan'] }, withAttachments);
  assert.equal(spec.env.WHIPHAND_ARTIFACT_PLAN, '/run/plan.md');
  assert.equal(Object.keys(spec.env).some(k => k.startsWith('WHIPHAND_ARTIFACT_ATTACHMENTS')), false);
});

test('inside a stage, a command step is told which stage it is in', () => {
  const stage = { index: 2, total: 7, id: '02-api', title: 'Add API routes', path: '/p/02-api.md' };
  const framed: RunCtx = { ...ctx, frame: { kind: 'stages', id: 'build', stage, attempt: 1, maxAttempts: 3 } };
  const spec = commandSpec({ kind: 'command', id: 'commit', run: 'git commit' }, framed);
  assert.equal(spec.env.WHIPHAND_STAGE_TITLE, 'Add API routes');
  assert.equal(spec.env.WHIPHAND_STAGE_INDEX, '2');
  assert.equal(spec.env.WHIPHAND_STAGE_TOTAL, '7');
  assert.equal(spec.env.WHIPHAND_STAGE_PATH, '/p/02-api.md');
  assert.equal(spec.env.WHIPHAND_STAGE_ID, '02-api');
});

test("a command step's own env values are templated", () => {
  const withInput: RunCtx = { ...ctx, inputs: { plan_dir: 'docs/plans/oauth' } };
  const spec = commandSpec(
    { kind: 'command', id: 'c', run: 'true', env: { WHIPHAND_PLAN_DIR: '{{ inputs.plan_dir }}' } }, withInput);
  assert.equal(spec.env.WHIPHAND_PLAN_DIR, 'docs/plans/oauth');
});

test('an input with no recorded artifact exports nothing rather than an empty variable', () => {
  const spec = commandSpec({ kind: 'command', id: 'c', run: 'true', inputs: ['nope'] }, ctx);
  assert.equal('WHIPHAND_ARTIFACT_NOPE' in spec.env, false);
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

// ---------------------------------------------------------------------------
// Injection inertness: values are data, never syntax — proven with a real shell.
// ---------------------------------------------------------------------------

const shell = resolveShell();
const hasShell = { skip: shell.ok ? false : 'no POSIX shell on this machine' };

/** Runs a command step's real argv through the resolved shell, in an empty directory. */
async function runStep(run: string, values: RunCtx['inputs'], extra: Partial<RunCtx> = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'wh-inject-'));
  const real: RunCtx = {
    ...ctx, workdir: dir, runDir: dir, shell: shell.ok ? shell.path : SH, inputs: values, ...extra,
  };
  const spec = commandSpec({ kind: 'command', id: 'c', run }, real);
  const { stdout } = await execRunner(spec.argv, { cwd: dir, env: { ...process.env, ...spec.env } });
  return stdout;
}

const HOSTILE = ['; touch pwned', '$(touch pwned)', '`touch pwned`', "'; touch pwned; '", '"; touch pwned; "', '* ?', '&& touch pwned', '| touch pwned', '\\', 'a\nb'];

test('a hostile value is inert in a double-quoted context', hasShell, async () => {
  for (const value of HOSTILE) {
    assert.equal(await runStep('printf %s "{{ inputs.v }}"', { v: value }), value, JSON.stringify(value));
  }
});

test('a hostile value is inert as a bare word — it may split or glob, but nothing in it is executed', hasShell, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-inject-'));
  for (const value of ['; touch pwned', '$(touch pwned)', '`touch pwned`', '&& touch pwned', '| touch pwned']) {
    const spec = commandSpec({ kind: 'command', id: 'c', run: 'echo {{ inputs.v }} > out.txt' },
      { ...ctx, workdir: dir, runDir: dir, shell: shell.ok ? shell.path : SH, inputs: { v: value } });
    await execRunner(spec.argv, { cwd: dir, env: { ...process.env, ...spec.env } });
    assert.equal(existsSync(join(dir, 'pwned')), false, `${JSON.stringify(value)} was executed`);
  }
});

test('a hostile value is inert inside a heredoc', hasShell, async () => {
  const out = await runStep('cat <<EOF\n{{ inputs.v }}\nEOF', { v: '$(touch pwned); `touch pwned`' });
  assert.equal(out, '$(touch pwned); `touch pwned`\n');
});

test('a stage title of `*` is not globbed when it is quoted, and a hostile run name is inert', hasShell, async () => {
  const stage = { index: 1, total: 1, id: '01-a', title: '*', path: '/p/01-a.md' };
  const out = await runStep('printf %s "{{ stage.title }}"', {}, { frame: { kind: 'stages', id: 'build', stage, attempt: 1, maxAttempts: 1 } });
  assert.equal(out, '*');
  const named = await runStep('printf %s "{{ run.name }}"', {}, { runName: '; rm -rf ~', runSlug: 'rm' });
  assert.equal(named, '; rm -rf ~');
});

test('the documented breaking change: inside single quotes the reference is literal', hasShell, async () => {
  const out = await runStep("printf %s '{{ run.name }}'", {}, { runName: 'demo', runSlug: 'demo' });
  assert.equal(out, '${WHIPHAND_RUN_NAME}');
});

test('a shipped-template style whole-command input runs through eval, and stays correct with quotes and &&', hasShell, async () => {
  const out = await runStep('eval "{{ inputs.test_command }}"', { test_command: 'cd . && printf "%s" "a b"' });
  assert.equal(out, 'a b');
});
