import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execRunner } from './exec.ts';
import { DEFAULT_SHELL, shellFlags } from './engine/command.ts';
import {
  createWorkflow, deleteWorkflow, cloneWorkflow, initWorkspace, workflowTemplate, specDrivenTemplate, featureDevelopmentTemplate,
  stagedFeatureDevelopmentTemplate, updateWorkflow,
} from './scaffold.ts';
import { parseWorkflow, validateWorkflowWarnings, validateWorkflowSemantics, WorkflowError } from './schema.ts';
import { loadWorkspaceConfig } from './config.ts';
import { findStep } from './steps.ts';
import type { Workflow } from './types.ts';

async function withConfigHome<T>(fn: (configHome: string) => Promise<T>): Promise<T> {
  const configHome = await mkdtemp(join(tmpdir(), 'whiphand-config-home-'));
  const prev = process.env.WHIPHAND_CONFIG_HOME;
  process.env.WHIPHAND_CONFIG_HOME = configHome;
  try {
    return await fn(configHome);
  } finally {
    if (prev === undefined) delete process.env.WHIPHAND_CONFIG_HOME;
    else process.env.WHIPHAND_CONFIG_HOME = prev;
  }
}

/**
 * Every shipped template gives the human sign-off the same shape:
 * `human-review` loops until an approval that can send fresh feedback back to
 * both `execute` and `review` in the inner cycle it wraps — and that inner
 * cycle itself wraps a `test-fix` loop that repeats until `test_command`
 * passes before `review` ever runs.
 */
function assertHumanReviewShape(workflow: Workflow, innerLoopId: string): void {
  const testCommand = workflow.inputs?.test_command;
  assert.ok(testCommand !== undefined, 'test_command input is present');
  assert.equal(testCommand?.default, 'npm test');

  const humanReview = workflow.steps.find(s => s.id === 'human-review');
  assert.ok(humanReview !== undefined, 'human-review loop is present');
  if (humanReview === undefined || humanReview.kind !== 'loop') return assert.fail('human-review is a loop');
  assert.equal(humanReview.until, 'sign-off');

  const signOff = humanReview.steps.find(s => s.id === 'sign-off');
  assert.ok(signOff !== undefined && signOff.kind === 'approval');
  if (signOff === undefined || signOff.kind !== 'approval') return;
  assert.equal(signOff.verdict, true);
  assert.equal(signOff.capture, 'review');
  assert.equal(signOff.show_diff, true);
  assert.ok(signOff.output !== undefined, 'sign-off writes an artifact execute/review can read back');

  const inner = humanReview.steps.find(s => s.id === innerLoopId);
  assert.ok(inner !== undefined && inner.kind === 'loop');
  if (inner === undefined || inner.kind !== 'loop') return;

  const testFix = inner.steps.find(s => s.id === 'test-fix');
  assert.ok(testFix !== undefined && testFix.kind === 'loop', 'test-fix loop is present inside the review cycle');
  if (testFix === undefined || testFix.kind !== 'loop') return;
  const tests = testFix.steps.find(s => s.id === testFix.until);
  assert.ok(tests !== undefined && tests.kind === 'command' && tests.verdict === true,
    'test-fix\'s until is a verdict command step');
  assert.equal(tests?.kind === 'command' ? tests.output : undefined, 'tests.log');

  const execute = testFix.steps.find(s => s.id === 'execute');
  assert.ok(execute !== undefined && execute.kind === 'agent', 'execute is inside test-fix');
  if (execute === undefined || execute.kind !== 'agent') return;
  assert.ok(execute.inputs?.includes('tests'), 'execute reads the tests log');
  assert.ok(execute.inputs?.includes('sign-off'), 'execute reads the sign-off feedback');

  const innerIds = inner.steps.map(s => s.id);
  const review = inner.steps.find(s => s.id === 'review');
  assert.ok(review !== undefined && review.kind === 'agent' && review.verdict === true);
  if (review === undefined || review.kind !== 'agent') return;
  assert.ok(innerIds.indexOf('review') > innerIds.indexOf('test-fix'),
    'review comes after test-fix in the same parent loop');
  assert.ok(review.inputs?.includes('tests'), 'review reads this round\'s passing tests log');
  assert.ok(review.inputs?.includes('sign-off'), 'review reads the sign-off feedback too, to enforce it');
}

test('every shipped template gives the human sign-off the same send-it-back shape', () => {
  for (const [workflow, innerLoopId] of [
    [parseWorkflow(workflowTemplate('my-flow')), 'fix-cycle'],
    [parseWorkflow(specDrivenTemplate()), 'build-cycle'],
    [parseWorkflow(featureDevelopmentTemplate()), 'do-review'],
  ] as const) {
    assertHumanReviewShape(workflow, innerLoopId);
    assert.deepEqual(validateWorkflowWarnings(workflow), []);
    assert.deepEqual(validateWorkflowSemantics(workflow), []);
  }
});

test('workflowTemplate produces a parseable canonical workflow', () => {
  const workflow = parseWorkflow(workflowTemplate('my-flow'));
  assert.equal(workflow.name, 'my-flow');
  assert.equal(
    workflow.description,
    'Plan with a human, then implement, gate on tests, and review in a cycle until the review passes.',
  );
  assert.deepEqual(workflow.steps.map(s => s.id), ['plan', 'human-review']);

  const plan = workflow.steps[0];
  assert.equal(plan.kind === 'agent' && plan.mode, 'interactive');

  // The canonical shape is now a cycle: implement and review repeat until the
  // review passes, wrapped in a human sign-off that can send it round again.
  const humanReview = workflow.steps[1];
  assert.equal(humanReview.kind, 'loop');
  if (humanReview.kind !== 'loop') return;
  assert.deepEqual(humanReview.steps.map(s => s.id), ['fix-cycle', 'sign-off']);
  const fixCycle = humanReview.steps[0];
  assert.equal(fixCycle.kind, 'loop');
  if (fixCycle.kind !== 'loop') return;
  assert.equal(fixCycle.until, 'review');
  assert.deepEqual(fixCycle.steps.map(s => s.id), ['test-fix', 'review']);
  const testFix = fixCycle.steps[0];
  assert.equal(testFix.kind, 'loop');
  if (testFix.kind !== 'loop') return;
  assert.equal(testFix.until, 'tests');
  assert.deepEqual(testFix.steps.map(s => s.id), ['execute', 'tests']);
  const review = fixCycle.steps[1];
  assert.equal(review.kind === 'agent' && review.verdict, true);
});

test('specDrivenTemplate produces a parseable spec-driven workflow', () => {
  const workflow = parseWorkflow(specDrivenTemplate());
  assert.equal(workflow.name, 'spec-driven');
  assert.deepEqual(workflow.steps.map(s => s.id), [
    'functional-plan', 'functional-grill', 'technical-plan', 'technical-grill',
    'build-it', 'human-review',
  ]);

  const functionalGrill = workflow.steps[1];
  assert.equal(functionalGrill.kind === 'agent' && functionalGrill.mode, 'interactive');
  assert.equal(functionalGrill.kind === 'agent' && functionalGrill.output, 'functional-spec.md');

  const technicalGrill = workflow.steps[3];
  assert.equal(technicalGrill.kind === 'agent' && technicalGrill.mode, 'interactive');
  assert.equal(technicalGrill.kind === 'agent' && technicalGrill.output, 'technical-spec.md');

  // 'build-it' is the unchanged brake before implementation ever starts; only
  // the sign-off *after* it gained the send-it-back shape.
  assert.equal(workflow.steps[4].kind, 'approval');

  const humanReview = workflow.steps[5];
  assert.equal(humanReview.kind, 'loop');
  if (humanReview.kind !== 'loop') return;
  assert.deepEqual(humanReview.steps.map(s => s.id), ['build-cycle', 'sign-off']);
  const buildCycle = humanReview.steps[0];
  assert.equal(buildCycle.kind, 'loop');
  if (buildCycle.kind !== 'loop') return;
  assert.equal(buildCycle.until, 'review');
  assert.deepEqual(buildCycle.steps.map(s => s.id), ['test-fix', 'review']);
  const testFix = buildCycle.steps[0];
  assert.equal(testFix.kind, 'loop');
  if (testFix.kind !== 'loop') return;
  assert.equal(testFix.until, 'tests');
  assert.deepEqual(testFix.steps.map(s => s.id), ['execute', 'tests']);
  const review = buildCycle.steps[1];
  assert.equal(review.kind === 'agent' && review.verdict, true);
});

test('featureDevelopmentTemplate produces a parseable workflow, including the backward reference into the loop', () => {
  const workflow = parseWorkflow(featureDevelopmentTemplate());
  assert.equal(workflow.name, 'feature-development');
});

test('stagedFeatureDevelopmentTemplate parses, stages the plan dir, and gates every stage', () => {
  const wf = parseWorkflow(stagedFeatureDevelopmentTemplate());
  assert.deepEqual(validateWorkflowSemantics(wf), []);
  assert.deepEqual(validateWorkflowWarnings(wf), []);
  const build = wf.steps.find(s => s.id === 'build');
  assert.ok(build && build.kind === 'stages');
  if (!build || build.kind !== 'stages') return;
  assert.equal(build.items, '{{ inputs.plan_dir }}/*.md');
  const gate = findStep(wf.steps, 'accept');
  assert.ok(gate && gate.kind === 'approval');
  if (!gate || gate.kind !== 'approval') return;
  assert.equal(gate.show_diff, true);
  assert.equal(gate.capture, 'review');
  assert.ok(findStep(wf.steps, 'commit'), 'each stage commits');
});

test('featureDevelopmentTemplate stage step works when the runs dir is gitignored and files are already staged', async () => {
  const stage = parseWorkflow(featureDevelopmentTemplate()).steps.find(s => s.id === 'stage');
  assert.ok(stage && stage.kind === 'command');
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: ws });
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-stage-'));
  await git('init', '-b', 'main');
  await writeFile(join(ws, '.gitignore'), '.whiphand/runs/\n');
  await writeFile(join(ws, 'a.txt'), 'a\n');
  await git('add', '-A');
  await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  await mkdir(join(ws, '.whiphand', 'runs', 'r1'), { recursive: true });
  await writeFile(join(ws, '.whiphand', 'runs', 'r1', 'plan.md'), 'plan\n');
  await writeFile(join(ws, 'a.txt'), 'changed\n');
  await git('add', 'a.txt');
  await writeFile(join(ws, 'b.txt'), 'new\n');

  // The shell a command step really gets (cmd.exe on Windows), so this also
  // pins that the run line survives cmd's quoting. Rejects on a non-zero exit.
  await execRunner([DEFAULT_SHELL, ...shellFlags(DEFAULT_SHELL), stage.run], { cwd: ws });

  const { stdout } = await git('diff', '--cached', '--name-only');
  assert.deepEqual(stdout.trim().split('\n'), ['a.txt', 'b.txt']);
});

test('createWorkflow writes the file, refuses overwrite, validates the name', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const { path } = await createWorkflow(ws, 'my-flow');
  assert.equal(path, join(ws, '.whiphand', 'workflows', 'my-flow.yaml'));
  parseWorkflow(await readFile(path, 'utf8')); // valid on disk

  await assert.rejects(() => createWorkflow(ws, 'my-flow'), /already exists/);
  await assert.rejects(() => createWorkflow(ws, 'Bad Name!'), /invalid workflow name/);
});

test('initWorkspace creates config + starter workflows once, then is a no-op', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const first = await initWorkspace(ws);
  assert.deepEqual(first.created.sort(), [
    join('.whiphand', 'config.yaml'),
    join('.whiphand', 'workflows', 'feature-development.yaml'),
    join('.whiphand', 'workflows', 'feature.yaml'),
    join('.whiphand', 'workflows', 'spec-driven.yaml'),
    join('.whiphand', 'workflows', 'staged-feature-development.yaml'),
  ]);
  await loadWorkspaceConfig(ws); // parses
  const second = await initWorkspace(ws);
  assert.deepEqual(second.created, []);
});

test('initWorkspace tops up a shipped workflow that is missing, even once the workspace is otherwise initialised', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await initWorkspace(ws);
  await rm(join(ws, '.whiphand', 'workflows', 'spec-driven.yaml'));

  const result = await initWorkspace(ws);

  assert.deepEqual(result.created, [join('.whiphand', 'workflows', 'spec-driven.yaml')]);
  parseWorkflow(await readFile(join(ws, '.whiphand', 'workflows', 'spec-driven.yaml'), 'utf8'));
});

function sampleWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: 'my-flow',
    description: 'A sample flow',
    steps: [
      { id: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive', writes: false, prompt: 'Plan it', output: 'plan.md' },
    ],
    ...overrides,
  };
}

test('updateWorkflow overwrites the file in place with the given content', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await createWorkflow(ws, 'my-flow');

  const { path } = await updateWorkflow(ws, 'my-flow', sampleWorkflow({ description: 'Updated description' }));

  assert.equal(path, join(ws, '.whiphand', 'workflows', 'my-flow.yaml'));
  const onDisk = parseWorkflow(await readFile(path, 'utf8'));
  assert.equal(onDisk.description, 'Updated description');
});

test('updateWorkflow locks the workflow name to the target file, ignoring a mismatched payload name', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await createWorkflow(ws, 'my-flow');

  await updateWorkflow(ws, 'my-flow', sampleWorkflow({ name: 'someone-elses-name' }));

  const onDisk = parseWorkflow(await readFile(join(ws, '.whiphand', 'workflows', 'my-flow.yaml'), 'utf8'));
  assert.equal(onDisk.name, 'my-flow');
});

test('updateWorkflow refuses a traversing name instead of writing outside the workflows dir', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await createWorkflow(ws, 'my-flow');
  const escapee = join(ws, 'pwned.yaml');

  await assert.rejects(
    () => updateWorkflow(ws, join('..', '..', 'pwned'), sampleWorkflow()),
    /invalid workflow name/,
  );
  await assert.rejects(() => updateWorkflow(ws, 'not/nested', sampleWorkflow()), /invalid workflow name/);
  await assert.rejects(() => access(escapee), /ENOENT/);
});

test('createWorkflow writes into the global workflows dir when scope is global, mkdir-ing it on demand', async () => {
  await withConfigHome(async configHome => {
    const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
    const { path } = await createWorkflow(ws, 'my-global-flow', 'global');
    assert.equal(path, join(configHome, 'workflows', 'my-global-flow.yaml'));
    parseWorkflow(await readFile(path, 'utf8'));
    // Never touched the project's own .whiphand/workflows.
    await assert.rejects(() => access(join(ws, '.whiphand', 'workflows', 'my-global-flow.yaml')));
  });
});

test('updateWorkflow writes into the global workflows dir when scope is global', async () => {
  await withConfigHome(async configHome => {
    const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
    await createWorkflow(ws, 'my-global-flow', 'global');
    const { path } = await updateWorkflow(
      ws, 'my-global-flow', sampleWorkflow({ description: 'Updated globally' }), 'global',
    );
    assert.equal(path, join(configHome, 'workflows', 'my-global-flow.yaml'));
    const onDisk = parseWorkflow(await readFile(path, 'utf8'));
    assert.equal(onDisk.description, 'Updated globally');
  });
});

test('updateWorkflow rejects a semantically invalid workflow and does not touch the file', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const { path } = await createWorkflow(ws, 'my-flow');
  const before = await readFile(path, 'utf8');

  const invalid = sampleWorkflow({
    steps: [
      { id: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive', writes: false, prompt: 'Plan it', output: 'plan.md' },
      { id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: true, prompt: 'Do it', output: 'out.md' },
    ],
  });

  await assert.rejects(() => updateWorkflow(ws, 'my-flow', invalid), (e: unknown) =>
    e instanceof WorkflowError && e.problems.some(p => p.includes('duplicate step id')));
  assert.equal(await readFile(path, 'utf8'), before);
});

test('deleteWorkflow removes a project workflow file', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const { path } = await createWorkflow(ws, 'my-flow');

  assert.deepEqual(await deleteWorkflow(ws, 'my-flow'), { deleted: true });
  await assert.rejects(() => access(path), /ENOENT/);
});

test('deleteWorkflow removes a global workflow when scope is global', async () => {
  await withConfigHome(async configHome => {
    const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
    await createWorkflow(ws, 'my-global-flow', 'global');

    assert.deepEqual(await deleteWorkflow(ws, 'my-global-flow', 'global'), { deleted: true });
    await assert.rejects(() => access(join(configHome, 'workflows', 'my-global-flow.yaml')), /ENOENT/);
  });
});

test('deleteWorkflow of a project workflow leaves the global one of the same name in place', async () => {
  await withConfigHome(async configHome => {
    const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
    await createWorkflow(ws, 'shared', 'global');
    await createWorkflow(ws, 'shared');

    assert.deepEqual(await deleteWorkflow(ws, 'shared'), { deleted: true });
    await assert.rejects(() => access(join(ws, '.whiphand', 'workflows', 'shared.yaml')), /ENOENT/);
    await access(join(configHome, 'workflows', 'shared.yaml'));
  });
});

test('deleteWorkflow falls back to <name>.yml', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const dir = join(ws, '.whiphand', 'workflows');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'legacy.yml');
  await writeFile(path, workflowTemplate('legacy'), 'utf8');

  assert.deepEqual(await deleteWorkflow(ws, 'legacy'), { deleted: true });
  await assert.rejects(() => access(path), /ENOENT/);
});

test('deleteWorkflow reports deleted: false when neither file exists', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  assert.deepEqual(await deleteWorkflow(ws, 'never-there'), { deleted: false });
});

test('deleteWorkflow refuses an invalid name instead of unlinking outside the workflows dir', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const escapee = join(ws, '.whiphand', 'x.yaml');
  await mkdir(join(ws, '.whiphand'), { recursive: true });
  await writeFile(escapee, 'name: x\n', 'utf8');

  await assert.rejects(() => deleteWorkflow(ws, join('..', 'x')), /invalid workflow name/);
  await assert.rejects(() => deleteWorkflow(ws, 'Bad Name!'), /invalid workflow name/);
  await access(escapee); // still there
});

test("cloneWorkflow writes <to>.yaml with name: <to>, keeps the source's comments, and leaves the source unchanged", async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const { path: fromPath } = await createWorkflow(ws, 'my-flow');
  const before = await readFile(fromPath, 'utf8');

  const { path } = await cloneWorkflow(ws, 'my-flow', 'my-flow-copy');

  assert.equal(path, join(ws, '.whiphand', 'workflows', 'my-flow-copy.yaml'));
  const cloned = await readFile(path, 'utf8');
  assert.match(cloned, /^name: my-flow-copy$/m);
  assert.ok(cloned.includes('plan interactively, then implement, gate on tests passing'), 'keeps the source\'s leading comment');
  assert.equal(await readFile(fromPath, 'utf8'), before);
});

test('cloneWorkflow refuses to overwrite an existing target and leaves it untouched', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await createWorkflow(ws, 'my-flow');
  await createWorkflow(ws, 'already-there');
  const targetPath = join(ws, '.whiphand', 'workflows', 'already-there.yaml');
  const before = await readFile(targetPath, 'utf8');

  await assert.rejects(
    () => cloneWorkflow(ws, 'my-flow', 'already-there'),
    (e: unknown) => e instanceof Error && (e as NodeJS.ErrnoException).code === 'EEXIST',
  );
  assert.equal(await readFile(targetPath, 'utf8'), before);
});

test('cloneWorkflow stays in the given scope', async () => {
  await withConfigHome(async configHome => {
    const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
    await createWorkflow(ws, 'my-global-flow', 'global');

    const { path } = await cloneWorkflow(ws, 'my-global-flow', 'my-global-flow-copy', 'global');
    assert.equal(path, join(configHome, 'workflows', 'my-global-flow-copy.yaml'));
    await assert.rejects(() => access(join(ws, '.whiphand', 'workflows', 'my-global-flow-copy.yaml')), /ENOENT/);
  });
});

test('cloneWorkflow works from a .yml source', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const dir = join(ws, '.whiphand', 'workflows');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'legacy.yml'), workflowTemplate('legacy'), 'utf8');

  const { path } = await cloneWorkflow(ws, 'legacy', 'legacy-copy');
  assert.equal(path, join(dir, 'legacy-copy.yaml'));
  const onDisk = parseWorkflow(await readFile(path, 'utf8'));
  assert.equal(onDisk.name, 'legacy-copy');
});

test('cloneWorkflow throws a clear error when the source does not exist', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await assert.rejects(() => cloneWorkflow(ws, 'never-there', 'copy'), /not found/);
});

test('cloneWorkflow rejects an invalid source or target name', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await createWorkflow(ws, 'my-flow');
  await assert.rejects(() => cloneWorkflow(ws, 'Bad Name!', 'copy'), /invalid workflow name/);
  await assert.rejects(() => cloneWorkflow(ws, 'my-flow', 'Bad Name!'), /invalid workflow name/);
});
