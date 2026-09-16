/**
 * `kind: stages` — a workflow body run once per stage file, in order, with
 * per-stage context. The happy path: discovery, order, per-stage scope and
 * artifact layout, cancellation, and what a manual step inside a stage is
 * told — then a rejected stage's retries, an exhausted review cycle reaching
 * the gate, and the triage handover when retries run out. Resume lives with
 * the task that adds it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from './runner.ts';
import { planResume } from './resume.ts';
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
  /** Every live session handed to the frontend — triage, in these tests. */
  interactive: SpawnSpec[];
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
  /** What the n-th review spawn (1-based, across the whole run) concludes; PASS when absent. */
  review?: (n: number) => 'PASS' | 'FAIL';
} = {}): Harness {
  const events: WhiphandEvent[] = [];
  const asked: ManualRequest[] = [];
  const spawns: Array<{ stepId: string; prompt: string }> = [];
  const interactive: SpawnSpec[] = [];
  const queue = [...(opts.answers ?? [])];
  return {
    events, asked, spawns, interactive,
    frontend: {
      runInteractive: async spec => { interactive.push(spec); return 0; },
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
      const n = spawns.filter(s => s.stepId === stepId).length;
      opts.onSpawn?.(stepId, n);
      await writeFile(artifact, stepId === 'review' || stepId === 'lint'
        ? `VERDICT: ${opts.review?.(n) ?? 'PASS'}\n` : `${stepId} done\n`);
      return 0;
    },
  };
}

/**
 * A realistic staged plan: a fix cycle per stage (execute, then a review that
 * ends the cycle), and a human gate after it — the schema insists on the gate.
 */
function stagedWorkflow(items = 'plans/*.md', over: {
  onExhausted?: 'report' | 'interactive'; gateInputs?: string; before?: string;
} = {}): Workflow {
  return parseWorkflow(`
name: staged
steps:
${over.before ?? ''}
  - kind: stages
    id: build
    items: "${items}"
    steps:
      - kind: loop
        id: cycle
        until: review
        max_iterations: 2${over.onExhausted === undefined ? '' : `\n        on_exhausted: ${over.onExhausted}`}
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
        inputs: ${over.gateInputs ?? '[stage, review]'}
        output: accept.md
`);
}

const tmpDirs: string[] = [];
after(async () => {
  await Promise.all(tmpDirs.map(dir => rm(dir, { recursive: true, force: true })));
});

async function tmpRepoWithPlans(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-stages-'));
  tmpDirs.push(dir);
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

test('a badly named stage file added mid-run fails the stages step instead of throwing', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const h = harness({
    onAsk: async (_request, n) => {
      if (n === 1) await writeFile(join(dir, 'plans', '02a-a@b.md'), '# Bad\n');
    },
  });
  const result = await run(dir, h);

  assert.equal(result.ok, false, 'runWorkflow resolves with a failure rather than rejecting');
  assert.deepEqual(items(h), ['01-schema']);
  const error = h.events.find(e => e.type === 'run:error');
  assert.ok(error !== undefined && error.type === 'run:error');
  assert.equal(error.stepId, 'build');
  assert.match(error.message, /^stages step 'build': stage file '02a-a@b\.md': a stage name cannot contain/);
  assert.equal((await manifestOf(result.runDir)).status, 'failed');
});

test('a glob that matches a directory fails the stages step, naming the match', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  await mkdir(join(dir, 'plans', '03-assets'));
  const h = harness();
  const result = await run(dir, h, { workflow: stagedWorkflow('plans/*') });

  assert.equal(result.ok, false);
  assert.match(errorMessage(h), /^stages step 'build': stage file 'plans\/03-assets' is a directory, not a stage file$/);
  const error = h.events.find(e => e.type === 'run:error');
  assert.equal(error?.type === 'run:error' ? error.stepId : undefined, 'build');
  assert.equal(h.spawns.length, 0);
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

// ---------------------------------------------------------------------------
// Rejection, exhaustion and the human handover
// ---------------------------------------------------------------------------

const ONE_STAGE = { '01-schema.md': '# Schema\n' };

function attempts(h: Harness): number[] {
  return h.events.flatMap(e => e.type === 'stages:item' ? [e.attempt] : []);
}

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
}

test('a rejected stage runs again from the top with the rejection attached, then is accepted', async () => {
  const dir = await tmpRepoWithPlans(ONE_STAGE);
  const h = harness({ answers: [{ choice: 'retry', note: 'wrong table name' }, { choice: 'continue' }] });
  const result = await run(dir, h);

  assert.equal(result.ok, true);
  assert.deepEqual(attempts(h), [1, 2]);
  const execute = prompts(h, 'execute');
  assert.equal(execute.length, 2);
  assert.doesNotMatch(execute[0], /A previous review found problems/);
  assert.match(execute[1], /A previous review found problems/);
  assert.match(execute[1], /attempt-1[/\\]accept\.md/, "the rejection is attempt 1's gate artifact");
  assert.equal(h.asked[1].stage?.attempt, 2);
  assert.ok(existsSync(join(result.runDir, 'build', '01-schema', 'attempt-2', 'cycle', 'iter-1', 'execute-report.md')));
  assert.deepEqual(h.events.flatMap(e => e.type === 'step:verdict' && e.stepId === 'accept' ? [e.verdict] : []),
    ['fail', 'pass'], 'a gate inside a stage carries its verdict without verdict: true');
  assert.deepEqual(h.events.flatMap(e => e.type === 'stages:accepted' ? [e.stageId] : []), ['01-schema']);
});

test('a rejection is scoped to its stage: the next stage starts clean', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const h = harness({ answers: [{ choice: 'retry' }, { choice: 'continue' }, { choice: 'continue' }] });
  const result = await run(dir, h);

  assert.equal(result.ok, true);
  assert.deepEqual(items(h), ['01-schema', '01-schema', '02-api']);
  const last = prompts(h, 'execute').at(-1)!;
  assert.match(last, /Implement API/);
  assert.doesNotMatch(last, /A previous review found problems/);
  assert.doesNotMatch(last, /accept\.md/);
  assert.equal(h.asked[2].stage?.attempt, 1, 'the next stage is its own attempt 1');
});

test('retries run out into a triage session, and the run stops naming the stage', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const h = harness({ answers: [{ choice: 'retry' }, { choice: 'retry' }, { choice: 'retry' }] });
  const result = await run(dir, h);

  assert.equal(result.ok, false);
  assert.deepEqual(attempts(h), [1, 2, 3], 'max_retries defaults to 2: three attempts');
  assert.equal(h.interactive.length, 1, 'one triage session');
  const triage = h.interactive[0].argv.join(' ');
  assert.match(triage, /execute-triage/, 'seeded from the writes: true agent before the gate');
  assert.match(triage, /01-schema\.md/);
  assert.match(triage, /attempt-3[/\\]accept\.md/, 'the last rejection note');
  assert.match(triage, /attempt-3[/\\]cycle[/\\]iter-1[/\\]review\.md/, 'the last review findings');
  assert.match(triage, /previous attempt's work is in the working tree/);
  assert.match(errorMessage(h), /^stages step 'build': stage 1 of 2 \('Schema'\) was rejected 3 times$/);
  assert.ok(!items(h).includes('02-api'), 'the run stops at the stage');

  const manifest = await manifestOf(result.runDir);
  const row = manifest.steps.find(s => s.id === 'build')!;
  assert.equal(row.exhausted, true);
  assert.equal(row.attempt, 3);
  assert.equal(manifest.error?.stepId, 'build');
});

test('an inner review cycle that never passes reaches the gate instead of killing the run', async () => {
  const dir = await tmpRepoWithPlans(ONE_STAGE);
  const h = harness({ review: () => 'FAIL' });
  const result = await run(dir, h, { workflow: stagedWorkflow('plans/*.md', { gateInputs: '[stage]' }) });

  assert.equal(result.ok, true);
  assert.equal(h.asked.length, 1, 'the human was asked');
  assert.equal(prompts(h, 'review').length, 2, 'the cycle spent its whole budget first');
  assert.match(h.asked[0].instructions, /^Look at the work\./);
  assert.match(h.asked[0].instructions,
    /The review cycle 'cycle' never passed within 2 iterations — its findings are attached\./);
  assert.ok(h.asked[0].context.artifacts.some(a => a.id === 'review'),
    'the findings are forced onto the rail even though the gate did not list them');
  assert.ok(h.asked[0].context.artifacts.some(a => a.id === 'stage'));
  assert.ok(!h.events.some(e => e.type === 'run:error'));
  const done = h.events.find(e => e.type === 'loop:done');
  assert.equal(done?.type === 'loop:done' && done.passed, false);
});

test('outside a stages step, an exhausted loop still fails the run exactly as before', async () => {
  // The plain case — no stages step anywhere — is runner.loops.test.ts's
  // 'an exhausted loop fails the run and names what never passed'. This is
  // the stage-adjacent one: a loop *before* a stages step is not inside a
  // stage frame, so it never reaches that stage's gate.
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const h = harness({ review: () => 'FAIL' });
  const before = `
  - kind: loop
    id: precheck
    until: lint
    max_iterations: 2
    steps:
      - id: lint
        runner: fake
        mode: headless
        writes: false
        verdict: true
        prompt: Lint it
        output: lint.md`;
  const result = await run(dir, h, { workflow: stagedWorkflow('plans/*.md', { before }) });

  assert.equal(result.ok, false);
  assert.match(errorMessage(h), /^loop 'precheck' did not pass 'lint' within 2 iterations$/);
  assert.ok(!h.events.some(e => e.type === 'stages:start'), 'the stages step never started');
  assert.equal(h.asked.length, 0);
});

test('on_exhausted: interactive inside a stage still opens triage rather than reaching the gate', async () => {
  const dir = await tmpRepoWithPlans(ONE_STAGE);
  const h = harness({ review: () => 'FAIL' });
  const result = await run(dir, h, { workflow: stagedWorkflow('plans/*.md', { onExhausted: 'interactive' }) });

  assert.equal(result.ok, false);
  assert.equal(h.asked.length, 0, 'the gate is never reached');
  assert.equal(h.interactive.length, 1);
  assert.match(h.interactive[0].argv.join(' '), /review-triage/);
  assert.match(errorMessage(h), /^loop 'cycle' did not pass 'review' within 2 iterations$/);
  assert.notEqual((await manifestOf(result.runDir)).steps.find(s => s.id === 'build')!.exhausted, true,
    'an exhausted loop is not an exhausted stage');
});

test('a stage that changed nothing says so at the gate rather than being skipped', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  gitInit(dir);
  // Stage 2's implementer really edits the tree; stage 1's does not.
  const h = harness({
    onSpawn: (stepId, n) => { if (stepId === 'execute' && n === 2) writeFileSync(join(dir, 'api.ts'), 'export {};\n'); },
  });
  const result = await run(dir, h);

  assert.equal(result.ok, true);
  assert.equal(h.asked.length, 2, 'the gate is never skipped');
  assert.match(h.asked[0].instructions, /this stage produced no changes/i);
  assert.doesNotMatch(h.asked[1].instructions, /produced no changes/i);
});

test('abort at a stage gate fails the run immediately', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  const h = harness({ answers: [{ choice: 'abort' }] });
  const result = await run(dir, h);

  assert.equal(result.ok, false);
  assert.match(errorMessage(h), /approval step 'accept' was declined/);
  assert.deepEqual(attempts(h), [1], 'no retry');
  assert.deepEqual(items(h), ['01-schema']);
  assert.equal(h.interactive.length, 0, 'no triage');
});

test('accepting is authoritative: a run whose every stage was accepted ends ok', async () => {
  const dir = await tmpRepoWithPlans(TWO_STAGES);
  // Stage 1's cycle FAILs both iterations and is accepted anyway; stage 2 passes.
  const h = harness({ review: n => n <= 2 ? 'FAIL' : 'PASS' });
  const result = await run(dir, h);

  assert.equal(result.ok, true);
  assert.equal(result.verdict, undefined, "an accepted stage's failing review does not become the run's verdict");
  assert.deepEqual(items(h), ['01-schema', '02-api']);
  const manifest = await manifestOf(result.runDir);
  assert.equal(manifest.status, 'succeeded');
  assert.notEqual(manifest.status, 'failed');
});

test("a replayed rejected gate sends the stage round again rather than reading as accepted", async () => {
  const dir = await tmpRepoWithPlans(ONE_STAGE);
  const controller = new AbortController();
  // Rejected at attempt 1, then cancelled while attempt 2's implementer runs.
  const first = harness({
    answers: [{ choice: 'retry' }],
    onSpawn: (stepId, n) => { if (stepId === 'execute' && n === 2) controller.abort(); },
  });
  const broken = await run(dir, first, { signal: controller.signal });
  assert.equal(broken.cancelled, true);

  // Only the runner's skip path is under test here. planResume does not yet
  // key a row directly under a stage by its stage (Task 9), so attempt 1's
  // gate is handed over under the key executeStep looks it up by.
  const plan = await planResume(dir, DEFAULT_CONFIG, broken.runId);
  const gate = plan.done.get('accept');
  assert.equal(gate?.verdict, 'fail', 'the implicit verdict reached the manifest');
  const done = new Map([...plan.done].filter(([key]) => key !== 'accept'));
  done.set('accept@01-schema#1', gate!);

  const resumed = harness();
  const result = await run(dir, resumed, { resume: { ...plan, done }, workflow: plan.workflow });

  assert.equal(result.ok, true);
  assert.ok(resumed.events.some(e => e.type === 'step:skipped' && e.stepId === 'accept' && e.stage === '01-schema'),
    "attempt 1's gate is replayed, not asked again");
  assert.deepEqual(attempts(resumed), [1, 2], 'the replayed rejection sends the stage round again');
  assert.equal(prompts(resumed, 'execute').length, 1, 'attempt 2 really runs');
  assert.match(prompts(resumed, 'execute')[0], /A previous review found problems/);
  assert.equal(resumed.asked.length, 1, "only attempt 2's gate asks");
});
