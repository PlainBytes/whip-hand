/**
 * `kind: stages` — a workflow body run once per stage file, in order, with
 * per-stage context. The happy path: discovery, order, per-stage scope and
 * artifact layout, cancellation, and what a manual step inside a stage is
 * told. Retries, exhaustion and resume live with the tasks that add them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from './runner.ts';
import type { RunOptions } from './runner.ts';
import { buildPrompt } from '../template.ts';
import { parseWorkflow } from '../schema.ts';
import { AdapterRegistry } from '../registry.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import type { RunManifest } from './manifest.ts';
import type {
  AgentStep, Frontend, ManualRequest, ManualResponse, RunCtx, RunnerAdapter, SpawnSpec, WhiphandEvent, Workflow,
} from '../types.ts';

function fakeRunner(): RunnerAdapter {
  // Through buildPrompt, like a real runner: `inputs:` must reach the prompt
  // exactly as claude/copilot would see it.
  const build = (phase: string) => (step: AgentStep, ctx: RunCtx): SpawnSpec => ({
    argv: ['fake', phase, step.id, ctx.artifacts[step.id], buildPrompt(step, ctx)],
    cwd: ctx.workdir, env: {}, interactive: phase === 'interactive',
  });
  return {
    id: 'fake',
    capabilities: { sessionIdInjection: true, sessionIdCapture: false, sessionResume: true, toolDenial: true, shareTranscript: false },
    detect: async () => ({ installed: true }),
    interactive: build('interactive'),
    headless: build('headless'),
    harvest: build('harvest'),
  };
}

function registry(): AdapterRegistry {
  const reg = new AdapterRegistry();
  reg.register(fakeRunner());
  return reg;
}

interface Harness {
  events: WhiphandEvent[];
  asked: ManualRequest[];
  frontend: Frontend;
  /** Every agent spawn, in order: which step and the prompt it was handed. */
  spawns: Array<{ stepId: string; prompt: string }>;
  spawnHeadless: NonNullable<RunOptions['spawnHeadless']>;
}

/**
 * `onAsk` runs as the human answers — the place a test edits the plan
 * directory mid-run. `onSpawn` runs before an agent spawn writes its artifact.
 */
function harness(opts: {
  onAsk?: (request: ManualRequest, n: number) => Promise<void> | void;
  onSpawn?: (stepId: string, n: number) => void;
  onEvent?: (e: WhiphandEvent) => void;
  answers?: ManualResponse[];
} = {}): Harness {
  const events: WhiphandEvent[] = [];
  const asked: ManualRequest[] = [];
  const spawns: Array<{ stepId: string; prompt: string }> = [];
  const queue = [...(opts.answers ?? [])];
  return {
    events, asked, spawns,
    frontend: {
      runInteractive: async () => 0,
      runManual: async request => {
        asked.push(request);
        await opts.onAsk?.(request, asked.length);
        return queue.shift() ?? { choice: 'continue' };
      },
      onEvent: e => { events.push(e); opts.onEvent?.(e); },
    },
    spawnHeadless: async spec => {
      if (spec.argv[0] !== 'fake') return 0;
      const [, , stepId, artifact, prompt] = spec.argv;
      spawns.push({ stepId, prompt });
      opts.onSpawn?.(stepId, spawns.filter(s => s.stepId === stepId).length);
      await writeFile(artifact, stepId === 'review' ? 'VERDICT: PASS\n' : `${stepId} done\n`);
      return 0;
    },
  };
}

/**
 * A realistic staged plan: a fix cycle per stage (execute, then a review that
 * ends the cycle), and a human gate after it — the schema insists on the gate.
 */
function stagedWorkflow(items = 'plans/*.md'): Workflow {
  return parseWorkflow(`
name: staged
steps:
  - kind: stages
    id: build
    items: "${items}"
    steps:
      - kind: loop
        id: cycle
        until: review
        max_iterations: 2
        steps:
          - id: execute
            runner: fake
            mode: headless
            writes: true
            prompt: "Implement {{ stage.title }}"
            inputs: [stage, review]
            output: execute-report.md
          - id: review
            runner: fake
            mode: headless
            writes: false
            verdict: true
            prompt: Review it
            inputs: [stage, execute]
            output: review.md
      - kind: approval
        id: accept
        title: "Accept {{ stage.title }}?"
        instructions: Look at the work.
        inputs: [stage, review]
        output: accept.md
`);
}

async function tmpRepoWithPlans(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-stages-'));
  await mkdir(join(dir, 'plans'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'plans', name), text);
  return dir;
}

const TWO_STAGES = { '01-schema.md': '# Schema\n', '02-api.md': '# API\n' };

async function run(dir: string, h: Harness, over: Partial<RunOptions> = {}) {
  return runWorkflow({
    workflow: stagedWorkflow(), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend, spawnHeadless: h.spawnHeadless, ...over,
  });
}

function manifestOf(runDir: string): Promise<RunManifest> {
  return readFile(join(runDir, 'run.json'), 'utf8').then(text => JSON.parse(text) as RunManifest);
}

function errorMessage(h: Harness): string {
  const e = h.events.find(ev => ev.type === 'run:error');
  assert.ok(e !== undefined && e.type === 'run:error', 'expected a run:error');
  return e.message;
}

function items(h: Harness): string[] {
  return h.events.flatMap(e => e.type === 'stages:item' ? [e.stageId] : []);
}

function prompts(h: Harness, stepId: string): string[] {
  return h.spawns.filter(s => s.stepId === stepId).map(s => s.prompt);
}

test('a stages step runs its body once per stage file, in order', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const h = harness();
  const result = await run(dir, h);

  assert.equal(result.ok, true);
  assert.deepEqual(h.events.flatMap(e => e.type === 'stages:start' ? [[e.id, e.total]] : []), [['build', 2]]);
  assert.deepEqual(h.events.flatMap(e => e.type === 'stages:item' ? [[e.index, e.stageId, e.title, e.attempt]] : []),
    [[1, '01-schema', 'Schema', 1], [2, '02-api', 'API', 1]]);
  assert.deepEqual(h.events.flatMap(e => e.type === 'stages:accepted' ? [e.stageId] : []), ['01-schema', '02-api']);
  assert.deepEqual(h.events.flatMap(e => e.type === 'stages:done' ? [e.completed] : []), [2]);
  assert.deepEqual(h.spawns.map(s => s.stepId), ['execute', 'review', 'execute', 'review']);
  assert.equal(h.asked.length, 2, 'one gate per stage');
});

test('each stage gets its stage file and nothing from the stage before it', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const h = harness();
  const result = await run(dir, h);
  assert.equal(result.ok, true);

  const execute = prompts(h, 'execute');
  assert.match(execute[0], /Implement Schema/);
  assert.match(execute[0], /- stage: .*01-schema\.md/);
  assert.doesNotMatch(execute[0], /review\.md/, 'nothing to read on the first stage');
  assert.match(execute[1], /Implement API/);
  assert.match(execute[1], /- stage: .*02-api\.md/);
  assert.doesNotMatch(execute[1], /01-schema/, "stage 2 must not be handed stage 1's files");
  assert.doesNotMatch(prompts(h, 'review')[1], /01-schema/);
  assert.doesNotMatch(h.asked[1].context.artifacts.map(a => a.path).join('\n'), /01-schema/);

  for (const id of ['execute', 'review', 'accept', 'stage']) {
    assert.equal(result.artifacts[id], undefined, `'${id}' is scoped to its stage, not left behind for the run`);
  }
});

test('a stage added to the directory mid-run is picked up before the run ends', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const h = harness({
    onAsk: async (_request, n) => {
      if (n === 1) await writeFile(join(dir, 'plans', '03-extra.md'), '# Extra\n');
    },
  });
  const result = await run(dir, h);

  assert.equal(result.ok, true);
  assert.deepEqual(items(h), ['01-schema', '02-api', '03-extra']);
  assert.deepEqual(h.events.flatMap(e => e.type === 'stages:item' ? [e.total] : []), [2, 3, 3],
    'index/total are recomputed on every pass');
  assert.deepEqual(h.events.flatMap(e => e.type === 'stages:done' ? [e.completed] : []), [3]);
});

test('editing a completed stage file does not rewind, and deleting a pending one ends cleanly', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const h = harness({
    onAsk: async (_request, n) => {
      if (n !== 1) return;
      await writeFile(join(dir, 'plans', '01-schema.md'), '# Schema, revised\n');
      await rm(join(dir, 'plans', '02-api.md'));
    },
  });
  const result = await run(dir, h);

  assert.deepEqual(items(h), ['01-schema'], 'no re-run, no error for the file that vanished');
  assert.equal(result.ok, true);
  assert.deepEqual(h.events.flatMap(e => e.type === 'stages:done' ? [e.completed] : []), [1]);
});

test('cancelling mid-stage ends the run as cancelled, with the stage still open', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const controller = new AbortController();
  const h = harness({ onSpawn: (stepId, n) => { if (stepId === 'execute' && n === 2) controller.abort(); } });
  const result = await run(dir, h, { signal: controller.signal });

  assert.equal(result.cancelled, true);
  assert.deepEqual(items(h), ['01-schema', '02-api']);
  assert.deepEqual(h.events.flatMap(e => e.type === 'stages:accepted' ? [e.stageId] : []), ['01-schema']);
  assert.ok(!h.events.some(e => e.type === 'stages:done'));
  const manifest = await manifestOf(result.runDir);
  assert.equal(manifest.status, 'cancelled');
  assert.deepEqual(manifest.steps.find(s => s.id === 'build')!.completedStages, ['01-schema']);
});

test('a stages step whose glob matches nothing fails the run', async () => {
  const dir = await tmpRepoWithPlans({});
  const h = harness();
  const result = await run(dir, h);

  assert.equal(result.ok, false);
  assert.match(errorMessage(h), /stages step 'build' matched no stage files \(plans\/\*\.md\)/);
  assert.equal(h.spawns.length, 0);
});

test('a stage file that vanishes between discovery and use fails that stage, not silently', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  // stages:start is emitted after the first discovery and before the first
  // stage runs: deleting the file there is exactly "between discovery and use".
  const h = harness({
    onEvent: e => { if (e.type === 'stages:start') unlinkSync(join(dir, 'plans', '01-schema.md')); },
  });
  const result = await run(dir, h);

  assert.equal(result.ok, false);
  assert.match(errorMessage(h), /stage file/);
  assert.match(errorMessage(h), /expected artifact was not written/);
  assert.equal(h.spawns.length, 0, 'no body step ran with an empty stage');
});

test('a loop inside a stage writes its artifacts under that stage', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const h = harness();
  const result = await run(dir, h);
  assert.equal(result.ok, true);

  const runDir = result.runDir;
  assert.ok(existsSync(join(runDir, 'build', '01-schema', 'attempt-1', 'cycle', 'iter-1', 'execute-report.md')));
  assert.ok(existsSync(join(runDir, 'build', '02-api', 'attempt-1', 'cycle', 'iter-1', 'execute-report.md')));
  // A body step directly under the stage frame, not inside the loop, lands
  // under its stage too rather than at the flat top-level path.
  assert.ok(existsSync(join(runDir, 'build', '01-schema', 'attempt-1', 'accept.md')));
  assert.ok(existsSync(join(runDir, 'build', '02-api', 'attempt-1', 'accept.md')));
  assert.ok(!existsSync(join(runDir, 'accept.md')), 'the gate must not collide at the top level');
});

test('a body step gets one manifest row per stage, not one overwritten in place', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const h = harness();
  const result = await run(dir, h);
  assert.equal(result.ok, true);

  const starts = h.events.flatMap(e => e.type === 'step:start' && e.stepId === 'accept' ? [[e.loopId, e.stage]] : []);
  assert.deepEqual(starts, [['build', '01-schema'], ['build', '02-api']]);

  const manifest = await manifestOf(result.runDir);
  const rowsOf = (id: string) => manifest.steps.filter(s => s.id === id);
  assert.deepEqual(rowsOf('accept').map(r => [r.stage, r.status]), [['01-schema', 'done'], ['02-api', 'done']]);
  assert.deepEqual(rowsOf('accept').map(r => r.artifact),
    [join(result.runDir, 'build', '01-schema', 'attempt-1', 'accept.md'),
      join(result.runDir, 'build', '02-api', 'attempt-1', 'accept.md')]);
  assert.deepEqual(rowsOf('execute').map(r => r.outerLoops), [
    [{ id: 'build', iteration: 1, stage: '01-schema' }],
    [{ id: 'build', iteration: 1, stage: '02-api' }],
  ]);
  assert.deepEqual(rowsOf('cycle').map(r => [r.stage, r.status]), [['01-schema', 'done'], ['02-api', 'done']],
    'the loop inside the stage gets its own row per stage too');
});

test('an approval inside a stage is offered retry and carries the stage on its request', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const h = harness();
  const result = await run(dir, h);
  assert.equal(result.ok, true);

  assert.deepEqual(h.asked[0].choices, ['continue', 'retry', 'abort']);
  assert.equal(h.asked[0].title, 'Accept Schema?');
  assert.deepEqual(h.asked[0].stage, { stagesId: 'build', id: '01-schema', title: 'Schema', index: 1, total: 2, attempt: 1 });
  assert.equal(h.asked[0].stage?.title, 'Schema');
  assert.equal(h.asked[0].stage?.index, 1);
  assert.equal(h.asked[0].execution?.stage, '01-schema');
  assert.deepEqual(h.asked[1].execution, { loopId: 'build', iteration: 1, stage: '02-api' });
  assert.equal(h.asked[0].loop, undefined, 'a stage is not a loop');
});

test('an oddly named stage file warns but still runs', async () => {
  const dir = await tmpRepoWithPlans({ ...TWO_STAGES, 'notes.md': '# Notes\n' });
  const h = harness();
  const result = await run(dir, h);

  assert.equal(result.ok, true);
  assert.ok(h.events.some(e => e.type === 'guard:warning' && /notes\.md/.test(e.message)));
  assert.deepEqual(items(h), ['01-schema', '02-api', 'notes']);
});
