import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkflow, initWorkspace, workflowTemplate, specDrivenTemplate, featureDevelopmentTemplate, updateWorkflow,
} from './scaffold.ts';
import { parseWorkflow, WorkflowError } from './schema.ts';
import { loadWorkspaceConfig } from './config.ts';
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

test('workflowTemplate produces a parseable canonical workflow', () => {
  const workflow = parseWorkflow(workflowTemplate('my-flow'));
  assert.equal(workflow.name, 'my-flow');
  assert.equal(workflow.description, 'Plan with a human, then implement and review in a cycle until the review passes.');
  assert.deepEqual(workflow.steps.map(s => s.id), ['plan', 'fix-cycle', 'sign-off']);

  const plan = workflow.steps[0];
  assert.equal(plan.kind === 'agent' && plan.mode, 'interactive');

  // The canonical shape is now a cycle: implement and review repeat until the
  // review passes, which is the loop the whole tool exists to run.
  const loop = workflow.steps[1];
  assert.equal(loop.kind, 'loop');
  if (loop.kind !== 'loop') return;
  assert.equal(loop.until, 'review');
  assert.deepEqual(loop.steps.map(s => s.id), ['execute', 'review']);
  const review = loop.steps[1];
  assert.equal(review.kind === 'agent' && review.verdict, true);

  assert.equal(workflow.steps[2].kind, 'approval');
});

test('specDrivenTemplate produces a parseable spec-driven workflow', () => {
  const workflow = parseWorkflow(specDrivenTemplate());
  assert.equal(workflow.name, 'spec-driven');
  assert.deepEqual(workflow.steps.map(s => s.id), [
    'functional-plan', 'functional-grill', 'technical-plan', 'technical-grill',
    'build-it', 'build-cycle', 'sign-off',
  ]);

  const functionalGrill = workflow.steps[1];
  assert.equal(functionalGrill.kind === 'agent' && functionalGrill.mode, 'interactive');
  assert.equal(functionalGrill.kind === 'agent' && functionalGrill.output, 'functional-spec.md');

  const technicalGrill = workflow.steps[3];
  assert.equal(technicalGrill.kind === 'agent' && technicalGrill.mode, 'interactive');
  assert.equal(technicalGrill.kind === 'agent' && technicalGrill.output, 'technical-spec.md');

  assert.equal(workflow.steps[4].kind, 'approval');

  const loop = workflow.steps[5];
  assert.equal(loop.kind, 'loop');
  if (loop.kind !== 'loop') return;
  assert.equal(loop.until, 'review');
  assert.deepEqual(loop.steps.map(s => s.id), ['execute', 'review']);
  const review = loop.steps[1];
  assert.equal(review.kind === 'agent' && review.verdict, true);

  assert.equal(workflow.steps[6].kind, 'approval');
});

test('featureDevelopmentTemplate produces a parseable workflow, including the backward reference into the loop', () => {
  const workflow = parseWorkflow(featureDevelopmentTemplate());
  assert.equal(workflow.name, 'feature-development');
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
