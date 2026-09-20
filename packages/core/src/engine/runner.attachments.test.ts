import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from './runner.ts';
import { planResume, ResumeError } from './resume.ts';
import { getRun } from './manifest.ts';
import { AttachmentError } from './attachments.ts';
import { buildPrompt } from '../template.ts';
import { toWorkspace } from '../path-form.ts';
import { AdapterRegistry } from '../registry.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import type {
  AgentStep, Frontend, ManualRequest, RunCtx, RunnerAdapter, SpawnSpec, WhiphandEvent, Workflow,
} from '../types.ts';

/** A runner whose headless argv ends with the fully built prompt, so it can be asserted. */
function promptRunner(): RunnerAdapter {
  const spec = (phase: string, step: AgentStep, ctx: RunCtx): SpawnSpec => ({
    argv: ['fake', phase, ctx.artifacts[step.id] ?? '', buildPrompt(step, ctx)],
    cwd: ctx.workdir, env: {}, interactive: phase === 'interactive',
  });
  return {
    id: 'fake',
    doctor: { label: 'fake', argv: ['fake'], optional: true },
    capabilities: { sessionIdInjection: false, sessionIdCapture: false, sessionResume: false, toolDenial: true, shareTranscript: false },
    detect: async () => ({ installed: true }),
    interactive: (step, ctx) => spec('interactive', step, ctx),
    headless: (step, ctx) => spec('headless', step, ctx),
    harvest: (step, ctx) => spec('harvest', step, ctx),
  };
}

function registry(): AdapterRegistry {
  const reg = new AdapterRegistry();
  reg.register(promptRunner());
  return reg;
}

function collector(): { events: WhiphandEvent[]; frontend: Frontend; manual: ManualRequest[] } {
  const events: WhiphandEvent[] = [];
  const manual: ManualRequest[] = [];
  return {
    events, manual,
    frontend: {
      runInteractive: async () => 0,
      runManual: async request => { manual.push(request); return { choice: 'continue' }; },
      onEvent: e => events.push(e),
    },
  };
}

const agent = (id: string, inputs?: string[]): AgentStep => ({
  id, kind: 'agent', runner: 'fake', mode: 'headless', writes: false,
  prompt: `do ${id}`, output: `${id}.md`, ...(inputs === undefined ? {} : { inputs }),
});

const readsAttachments: Workflow = { name: 'att', steps: [agent('plan', ['attachments']), agent('next', ['plan'])] };

/** Writes each step's artifact and remembers every prompt it was handed. */
function spawner(prompts: string[]) {
  return async (spec: SpawnSpec) => {
    prompts.push(spec.argv.at(-1)!);
    await writeFile(spec.argv[2], 'done\n');
    return 0;
  };
}

async function workspaceWith(files: Record<string, string>): Promise<{ workdir: string; src: string }> {
  const workdir = await mkdtemp(join(tmpdir(), 'whiphand-att-ws-'));
  const src = await mkdtemp(join(tmpdir(), 'whiphand-att-src-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(src, name), body);
  return { workdir, src };
}

test('copies attachments into the run and hands them to the step that reads them', async () => {
  const { workdir, src } = await workspaceWith({ 'bug.png': 'PNG', 'server.log': 'boom' });
  const { events, frontend } = collector();
  const prompts: string[] = [];
  const result = await runWorkflow({
    workflow: readsAttachments, workdir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    attachments: [{ path: join(src, 'bug.png') }, { path: join(src, 'server.log') }],
    spawnHeadless: spawner(prompts),
  });
  assert.equal(result.ok, true);

  const dir = join(result.runDir, 'attachments');
  assert.deepEqual((await readdir(dir)).sort(), ['bug.png', 'server.log']);
  assert.equal(await readFile(join(dir, 'bug.png'), 'utf8'), 'PNG');

  assert.match(prompts[0], /## Input artifacts \(read these files first\)/);
  // Workspace-relative with forward slashes: the one path style every prompt uses.
  assert.ok(prompts[0].includes(`- attachments/bug.png: ${toWorkspace(join(dir, 'bug.png'), workdir)}`));
  assert.ok(prompts[0].includes(`- attachments/server.log: ${toWorkspace(join(dir, 'server.log'), workdir)}`));
  assert.ok(prompts[0].includes('- attachments/bug.png: .whiphand/runs/'), prompts[0]);
  assert.ok(!prompts[1].includes('attachments/'), 'only the step that names the ref receives them');

  const start = events.find(e => e.type === 'run:start');
  assert.deepEqual(start?.type === 'run:start' && start.attachments,
    [{ name: 'bug.png', size: 3 }, { name: 'server.log', size: 4 }]);

  const detail = await getRun(workdir, DEFAULT_CONFIG, result.runId);
  assert.ok(detail !== null && detail.status !== 'unknown');
  assert.deepEqual(detail.attachments, [
    { name: 'bug.png', path: 'attachments/bug.png', size: 3, source: join(src, 'bug.png') },
    { name: 'server.log', path: 'attachments/server.log', size: 4, source: join(src, 'server.log') },
  ]);
  // Listed as artifacts too, so the run page shows them without being told.
  assert.ok(detail.artifacts.some(a => a.name === 'attachments/bug.png'));
});

test('refuses before a run directory exists when nothing reads the files', async () => {
  const { workdir, src } = await workspaceWith({ 'a.log': 'x' });
  const { frontend } = collector();
  const unread: Workflow = { name: 'plain', steps: [agent('plan')] };
  await assert.rejects(
    runWorkflow({
      workflow: unread, workdir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
      attachments: [{ path: join(src, 'a.log') }], spawnHeadless: spawner([]),
    }),
    (e: unknown) => e instanceof AttachmentError && /no step reads `attachments`/.test(e.message));
  assert.equal(existsSync(join(workdir, DEFAULT_CONFIG.artifacts_dir)), false);
});

test('refuses a missing file before a run directory exists', async () => {
  const { workdir, src } = await workspaceWith({});
  const { frontend } = collector();
  await assert.rejects(
    runWorkflow({
      workflow: readsAttachments, workdir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
      attachments: [{ path: join(src, 'gone.png') }], spawnHeadless: spawner([]),
    }),
    AttachmentError);
  assert.equal(existsSync(join(workdir, DEFAULT_CONFIG.artifacts_dir)), false);
});

test('honours runs.max_attachment_mb', async () => {
  const { workdir, src } = await workspaceWith({ 'big.bin': 'x'.repeat(2048) });
  const { frontend } = collector();
  const config = { ...DEFAULT_CONFIG, runs: { ...DEFAULT_CONFIG.runs, max_attachment_mb: 0.001 } };
  await assert.rejects(
    runWorkflow({
      workflow: readsAttachments, workdir, inputs: {}, config, registry: registry(), frontend,
      attachments: [{ path: join(src, 'big.bin') }], spawnHeadless: spawner([]),
    }),
    /over the 0\.001 MB limit/);
});

test('a dry run records the list and copies nothing', async () => {
  const { workdir, src } = await workspaceWith({ 'bug.png': 'PNG' });
  const { events, frontend } = collector();
  const result = await runWorkflow({
    workflow: readsAttachments, workdir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    dryRun: true, attachments: [{ path: join(src, 'bug.png') }],
  });
  assert.equal(result.ok, true);
  assert.equal(existsSync(join(result.runDir, 'attachments')), false);

  const spawn = events.find(e => e.type === 'step:spawn' && e.stepId === 'plan');
  assert.ok(spawn?.type === 'step:spawn'
    && spawn.spec.argv.at(-1)!.includes(toWorkspace(join(result.runDir, 'attachments', 'bug.png'), workdir)));
  const detail = await getRun(workdir, DEFAULT_CONFIG, result.runId);
  assert.ok(detail !== null && detail.status !== 'unknown');
  assert.deepEqual(detail.attachments?.map(a => a.name), ['bug.png']);
});

test('a workflow that can read attachments runs fine without any — the ref is dropped', async () => {
  const { workdir } = await workspaceWith({});
  const { events, frontend } = collector();
  const prompts: string[] = [];
  const result = await runWorkflow({
    workflow: readsAttachments, workdir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: spawner(prompts),
  });
  assert.equal(result.ok, true);
  assert.ok(!prompts[0].includes('## Input artifacts'), 'no empty artifact section');
  const start = events.find(e => e.type === 'run:start');
  assert.ok(start?.type === 'run:start' && start.attachments === undefined);
  const detail = await getRun(workdir, DEFAULT_CONFIG, result.runId);
  assert.ok(detail !== null && detail.status !== 'unknown' && detail.attachments === undefined);
});

test('the ref is dropped inside a loop too when nothing is attached', async () => {
  const { workdir } = await workspaceWith({});
  const { frontend } = collector();
  const prompts: string[] = [];
  const looped: Workflow = {
    name: 'loop',
    steps: [{
      kind: 'loop', id: 'fix', until: 'check', max_iterations: 1,
      steps: [agent('work', ['attachments']), { id: 'check', kind: 'command', run: 'true', verdict: true }],
    }],
  };
  const result = await runWorkflow({
    workflow: looped, workdir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => (spec.argv[0] === 'fake' ? spawner(prompts)(spec) : 0),
  });
  assert.equal(result.ok, true);
  assert.ok(!prompts[0].includes('## Input artifacts'));
});

test('inside a loop, attachments are still delivered — they are not a previous iteration', async () => {
  const { workdir, src } = await workspaceWith({ 'bug.png': 'PNG' });
  const { frontend } = collector();
  const prompts: string[] = [];
  const looped: Workflow = {
    name: 'loop',
    steps: [{
      kind: 'loop', id: 'fix', until: 'check', max_iterations: 1,
      steps: [agent('work', ['attachments']), { id: 'check', kind: 'command', run: 'true', verdict: true }],
    }],
  };
  const result = await runWorkflow({
    workflow: looped, workdir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    attachments: [{ path: join(src, 'bug.png') }],
    spawnHeadless: async spec => (spec.argv[0] === 'fake' ? spawner(prompts)(spec) : 0),
  });
  assert.equal(result.ok, true);
  assert.ok(prompts[0].includes('- attachments/bug.png: '));
});

test('a manual step naming attachments gets one context entry per file', async () => {
  const { workdir, src } = await workspaceWith({ 'a.png': '1', 'b.log': '2' });
  const { events, frontend, manual } = collector();
  const gate: Workflow = {
    name: 'gate',
    steps: [{ id: 'look', kind: 'approval', title: 'Look', instructions: 'Look at them.', inputs: ['attachments'] }],
  };
  const result = await runWorkflow({
    workflow: gate, workdir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    attachments: [{ path: join(src, 'a.png') }, { path: join(src, 'b.log') }], spawnHeadless: spawner([]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(manual[0].context.artifacts, [
    { id: 'attachments/a.png', path: toWorkspace(join(result.runDir, 'attachments', 'a.png'), workdir) },
    { id: 'attachments/b.log', path: toWorkspace(join(result.runDir, 'attachments', 'b.log'), workdir) },
  ]);
  assert.match(manual[0].context.artifacts[0].path, /^\.whiphand\/runs\/[^/]+\/attachments\/a\.png$/);
  // the recorded event says exactly what the frontend was asked
  const asked = events.find(e => e.type === 'step:manual');
  assert.deepEqual(asked?.type === 'step:manual' && asked.request.context.artifacts, manual[0].context.artifacts);
});

test('a resume refuses new attachments', async () => {
  const { workdir, src } = await workspaceWith({ 'a.png': '1' });
  const { frontend } = collector();
  const first = await runWorkflow({
    workflow: readsAttachments, workdir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async () => 1,
  });
  assert.equal(first.ok, false);
  const plan = await planResume(workdir, DEFAULT_CONFIG, first.runId);
  await assert.rejects(
    runWorkflow({
      workflow: plan.workflow, workdir, inputs: plan.inputs, config: DEFAULT_CONFIG, registry: registry(),
      frontend, resume: plan, attachments: [{ path: join(src, 'a.png') }], spawnHeadless: spawner([]),
    }),
    /cannot attach new ones/);
});

test('a resume re-seeds the attachments the run was started with', async () => {
  const { workdir, src } = await workspaceWith({ 'bug.png': 'PNG' });
  const { frontend } = collector();
  // Fails the first step, so the resume has to run it — attachments and all.
  const first = await runWorkflow({
    workflow: readsAttachments, workdir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    attachments: [{ path: join(src, 'bug.png') }], spawnHeadless: async () => 1,
  });
  assert.equal(first.ok, false);

  const plan = await planResume(workdir, DEFAULT_CONFIG, first.runId);
  assert.deepEqual(plan.attachments, [join(first.runDir, 'attachments', 'bug.png')]);

  const prompts: string[] = [];
  const resumed = await runWorkflow({
    workflow: plan.workflow, workdir, inputs: plan.inputs, config: DEFAULT_CONFIG, registry: registry(),
    frontend: collector().frontend, resume: plan, spawnHeadless: spawner(prompts),
  });
  assert.equal(resumed.ok, true);
  assert.ok(prompts[0].includes(`- attachments/bug.png: ${toWorkspace(join(first.runDir, 'attachments', 'bug.png'), workdir)}`));
  const detail = await getRun(workdir, DEFAULT_CONFIG, first.runId);
  assert.ok(detail !== null && detail.status !== 'unknown');
  assert.deepEqual(detail.attachments?.map(a => a.name), ['bug.png'], 'the reopened manifest keeps the list');
});

test('a resume whose recorded attachment is gone is a ResumeError naming it', async () => {
  const { workdir, src } = await workspaceWith({ 'bug.png': 'PNG' });
  const { frontend } = collector();
  const first = await runWorkflow({
    workflow: readsAttachments, workdir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    attachments: [{ path: join(src, 'bug.png') }], spawnHeadless: async () => 1,
  });
  await rm(join(first.runDir, 'attachments', 'bug.png'));
  await assert.rejects(planResume(workdir, DEFAULT_CONFIG, first.runId),
    (e: unknown) => e instanceof ResumeError && e.message.includes("'bug.png'"));
});
