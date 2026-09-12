import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runWorkflow } from './runner.ts';
import { buildPrompt } from '../template.ts';
import { endMarkerPath } from './session-end.ts';
import { awaitStatePath } from './await-state.ts';
import type { RunManifest } from './manifest.ts';
import { planResume } from './resume.ts';
import type { ResumePlan } from './resume.ts';
import { AdapterRegistry } from '../registry.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { listRuns } from './manifest.ts';
import { parseWorkflow } from '../schema.ts';
import type {
  AgentStep, Frontend, ManualResponse, WhiphandEvent, Workflow, RunnerAdapter, SpawnSpec, RunCtx,
} from '../types.ts';

function fakeRunner(): RunnerAdapter {
  return {
    id: 'fake',
    capabilities: { sessionIdInjection: true, sessionResume: true, toolDenial: true, shareTranscript: false },
    detect: async () => ({ installed: true }),
    interactive(step: AgentStep, ctx: RunCtx): SpawnSpec {
      return {
        argv: ['fake', 'interactive', step.id, step.prompt], cwd: ctx.workdir, env: {}, interactive: true,
        endSession: { markerPath: endMarkerPath(ctx.runDir, step.id), quitSequence: 'q' },
        awaitState: { statePath: awaitStatePath(ctx.runDir, step.id) },
      };
    },
    headless(step: AgentStep, ctx: RunCtx): SpawnSpec {
      // encode target artifact + prompt so the fake spawn can act on it
      return {
        argv: ['fake', 'headless', step.id, ctx.artifacts[step.id], step.prompt],
        cwd: ctx.workdir, env: {}, interactive: false,
      };
    },
    harvest(step: AgentStep, ctx: RunCtx): SpawnSpec {
      return { argv: ['fake', 'harvest', step.id, ctx.artifacts[step.id]], cwd: ctx.workdir, env: {}, interactive: false };
    },
  };
}

function collector(): { events: WhiphandEvent[]; frontend: Frontend } {
  const events: WhiphandEvent[] = [];
  return {
    events,
    frontend: { runInteractive: async () => 0, onEvent: e => events.push(e) },
  };
}

const twoStep: Workflow = {
  name: 'r',
  steps: [
    { id: 'a', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, prompt: 'first', output: 'a.md' },
    { id: 'b', kind: 'agent', runner: 'fake', mode: 'headless', writes: true, prompt: 'second', inputs: ['a'], output: 'b.md' },
  ],
};

function registry(): AdapterRegistry {
  const reg = new AdapterRegistry();
  reg.register(fakeRunner());
  return reg;
}

test('dry-run emits spawn specs and spawns nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend, dryRun: true,
  });
  assert.equal(result.ok, true);
  const spawns = events.filter(e => e.type === 'step:spawn');
  assert.equal(spawns.length, 2);
  assert.equal(events.filter(e => e.type === 'run:done').length, 1);
});

const namedCommand: Workflow = {
  name: 'r',
  steps: [{
    kind: 'command', id: 'echo', output: 'echo.log',
    run: 'echo "{{ run.name }} / {{ run.slug }} / {{ run.id }} / $WHIPHAND_RUN_SLUG"',
  }],
};

test('--name lands on disk, on run:start, and in the step\'s template and env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const specs: SpawnSpec[] = [];
  const result = await runWorkflow({
    workflow: namedCommand, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend, name: '  OAuth support  ',
    spawnHeadless: async spec => { specs.push(spec); await writeFile(spec.capture!.path, 'x'); return 0; },
  });
  assert.equal(result.ok, true);

  assert.equal(await readFile(join(result.runDir, '.name'), 'utf8'), 'OAuth support');
  const start = events.find(e => e.type === 'run:start');
  assert.equal(start?.name, 'OAuth support');

  // Both routes to the same fact: the template for prose, the env for a shell
  // line that must not be at the mercy of quoting.
  // The run line is argv's last element on every platform — commandSpec builds
  // `[shell, ...shellFlags(shell), run]`, and Windows contributes three flags
  // to POSIX's one — so index from the end rather than from the shell.
  assert.equal(specs[0].argv.at(-1),
    `echo "OAuth support / oauth-support / ${result.runId} / $WHIPHAND_RUN_SLUG"`);
  assert.equal(specs[0].env.WHIPHAND_RUN_NAME, 'OAuth support');
  assert.equal(specs[0].env.WHIPHAND_RUN_SLUG, 'oauth-support');
  assert.equal(specs[0].env.WHIPHAND_RUN_ID, result.runId);
});

test('an unnamed run reads as its id everywhere a name would appear', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const specs: SpawnSpec[] = [];
  const result = await runWorkflow({
    workflow: namedCommand, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async spec => { specs.push(spec); await writeFile(spec.capture!.path, 'x'); return 0; },
  });
  assert.equal(result.ok, true);
  assert.equal(existsSync(join(result.runDir, '.name')), false);
  assert.equal(events.find(e => e.type === 'run:start')?.name, undefined);
  assert.equal(specs[0].argv.at(-1),
    `echo "${result.runId} / ${result.runId} / ${result.runId} / $WHIPHAND_RUN_SLUG"`);
  assert.ok(!('WHIPHAND_RUN_NAME' in specs[0].env));
});

test('runs.auto_name names an unnamed run before its first step runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();
  const reg = registry();
  // The fake runner answers the naming ask by writing to the capture path.
  (reg.get('fake') as RunnerAdapter).suggestName =
    (_prompt: string, ctx: RunCtx, capturePath: string): SpawnSpec => ({
      argv: ['fake', 'name'], cwd: ctx.workdir, env: {}, interactive: false,
      capture: { path: capturePath },
    });

  const specs: SpawnSpec[] = [];
  const result = await runWorkflow({
    workflow: namedCommand, workdir: dir, inputs: {},
    config: { ...DEFAULT_CONFIG, defaults: { runner: 'fake' }, runs: { ...DEFAULT_CONFIG.runs, auto_name: true } },
    registry: reg, frontend,
    spawnHeadless: async spec => {
      specs.push(spec);
      await writeFile(spec.capture!.path, spec.argv[1] === 'name' ? 'Add OAuth support\n' : 'x');
      return 0;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(await readFile(join(result.runDir, '.name'), 'utf8'), 'Add OAuth support');
  // Named before step one, which is what makes the slug usable for a worktree.
  assert.equal(specs[0].argv[1], 'name');
  assert.equal(specs[1].argv.at(-1),
    `echo "Add OAuth support / add-oauth-support / ${result.runId} / $WHIPHAND_RUN_SLUG"`);
  // The captured reply is folded into the marker, not left as an artifact.
  assert.equal(existsSync(join(result.runDir, '.name.suggest')), false);
});

test('a run reads as running on disk while auto-naming is still in flight', async () => {
  // The window this closes: naming can block for up to SUGGEST_TIMEOUT_MS, and
  // a run directory with no run.json reads back as `status: 'unknown'` — which
  // pruneRuns will delete and NewRunDialog will not count as an active run.
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();
  const reg = registry();
  (reg.get('fake') as RunnerAdapter).suggestName =
    (_prompt: string, ctx: RunCtx, capturePath: string): SpawnSpec => ({
      argv: ['fake', 'name'], cwd: ctx.workdir, env: {}, interactive: false,
      capture: { path: capturePath },
    });

  let releaseNaming: () => void;
  const naming = new Promise<void>(resolve => { releaseNaming = resolve; });
  let sawRunning = false;
  const promise = runWorkflow({
    workflow: namedCommand, workdir: dir, inputs: {},
    config: { ...DEFAULT_CONFIG, defaults: { runner: 'fake' }, runs: { ...DEFAULT_CONFIG.runs, auto_name: true } },
    registry: reg, frontend,
    spawnHeadless: async spec => {
      if (spec.argv[1] === 'name') {
        // Read the workspace exactly as a concurrent pruneRuns would, while
        // the naming spawn is deliberately still outstanding.
        const runs = await listRuns(dir, DEFAULT_CONFIG);
        sawRunning = runs.length === 1 && runs[0].status === 'running';
        await writeFile(spec.capture!.path, 'Add OAuth support\n');
        releaseNaming();
      } else {
        await writeFile(spec.capture!.path, 'x');
      }
      return 0;
    },
  });
  await naming;
  const result = await promise;
  assert.equal(result.ok, true);
  assert.ok(sawRunning, 'a starting run must be visible as running, not unknown');
});

test('runs.auto_name never overrides a name the run was started with', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();
  const reg = registry();
  let asked = false;
  (reg.get('fake') as RunnerAdapter).suggestName = () => { asked = true; throw new Error('unreachable'); };
  const result = await runWorkflow({
    workflow: namedCommand, workdir: dir, inputs: {},
    config: { ...DEFAULT_CONFIG, defaults: { runner: 'fake' }, runs: { ...DEFAULT_CONFIG.runs, auto_name: true } },
    registry: reg, frontend, name: 'Typed by hand',
    spawnHeadless: async spec => { await writeFile(spec.capture!.path, 'x'); return 0; },
  });
  assert.equal(result.ok, true);
  assert.equal(asked, false);
  assert.equal(await readFile(join(result.runDir, '.name'), 'utf8'), 'Typed by hand');
});

test('headless run writes artifacts via injected spawn and succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async spec => { await writeFile(spec.argv[3], `# out for ${spec.argv[2]}\n`); return 0; },
  });
  assert.equal(result.ok, true);
  assert.ok((await readFile(result.artifacts['a'], 'utf8')).includes('out for a'));
  assert.ok(events.some(e => e.type === 'step:artifact'));
});

test('workflowSource flows onto the run:start event and the manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend, dryRun: true, workflowSource: 'global',
  });
  const start = events.find(e => e.type === 'run:start');
  assert.equal(start?.type === 'run:start' && start.source, 'global');
  const manifest = JSON.parse(await readFile(join(result.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.workflowSource, 'global');
});

test('missing artifact fails the run loudly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async () => 0, // exits fine but writes nothing
  });
  assert.equal(result.ok, false);
  assert.ok(events.some(e => e.type === 'run:error' && e.message.includes('a.md')));
});

test('non-zero exit stops the run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async () => 1,
  });
  assert.equal(result.ok, false);
});

test('verdict fail with report mode ends run not-ok; pass continues', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [
      { id: 'work', kind: 'agent', runner: 'fake', mode: 'headless', writes: true, prompt: 'w', output: 'w.md' },
      { id: 'review', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'r', output: 'f.md' },
    ],
  };
  const { frontend } = collector();
  const failing = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const content = spec.argv[2] === 'review' ? 'VERDICT: FAIL\nbad' : 'did work';
      await writeFile(spec.argv[3], content); return 0;
    },
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.verdict, 'fail');

  const passing = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const content = spec.argv[2] === 'review' ? 'VERDICT: PASS\nok' : 'did work';
      await writeFile(spec.argv[3], content); return 0;
    },
  });
  assert.equal(passing.ok, true);
  assert.equal(passing.verdict, 'pass');
});

test('verdict step prompt gets the instruction appended', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [{ id: 'rev', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'r', output: 'f.md' }],
  };
  const { frontend } = collector();
  let seenPrompt = '';
  await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      seenPrompt = spec.argv[4];
      await writeFile(spec.argv[3], 'VERDICT: PASS\n'); return 0;
    },
  });
  assert.ok(seenPrompt.includes('VERDICT: PASS'));
});

test('missing required input throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = { ...twoStep, inputs: { feature: { required: true } } };
  const { frontend } = collector();
  await assert.rejects(runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend, dryRun: true,
  }), /feature/);
});

// ---------------------------------------------------------------------------
// Disabling a step
// ---------------------------------------------------------------------------

test('a workflow with no enabled steps fails at run start, before any run directory exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    ...twoStep,
    steps: twoStep.steps.map(s => ({ ...s, enabled: false })),
  };
  const { frontend } = collector();
  await assert.rejects(runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend, dryRun: true,
  }), /no enabled steps/);
  const runsDir = join(dir, '.whiphand', 'runs');
  const entries = await readdir(runsDir).catch(() => []);
  assert.deepEqual(entries, [], 'no run directory was left behind');
});

test('a disabled step never starts, and a reader that named it runs without it instead of crashing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [
      { id: 'plan', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, prompt: 'p', output: 'plan.md', enabled: false },
      {
        id: 'execute', kind: 'agent', runner: 'fake', mode: 'headless', writes: true,
        prompt: 'do it', inputs: ['plan'], output: 'execute.md',
      },
    ],
  };
  const { events, frontend } = collector();
  const started: string[] = [];
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => { started.push(spec.argv[2]); await writeFile(spec.argv[3], 'ok'); return 0; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(started, ['execute'], 'plan is never spawned');
  assert.equal(events.some(e => e.type === 'step:start' && e.stepId === 'plan'), false);

  const warning = events.find(e => e.type === 'guard:warning');
  assert.ok(warning && warning.type === 'guard:warning'
    && warning.message === "plan is disabled. execute reads it; it'll run without it.");

  const manifest = JSON.parse(await readFile(join(result.runDir, 'run.json'), 'utf8')) as RunManifest;
  const planEntry = manifest.steps.find(s => s.id === 'plan');
  assert.equal(planEntry?.status, 'disabled', 'the disabled step is still recorded, dimmed, never started');
  const executeEntry = manifest.steps.find(s => s.id === 'execute');
  assert.equal(executeEntry?.status, 'done');
});

test('interactive step: main spawn via frontend, then harvest, then artifact assertion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [{ id: 'plan', kind: 'agent', runner: 'fake', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' }],
  };
  const { events } = collector();
  const order: string[] = [];
  const frontend: Frontend = {
    runInteractive: async spec => { order.push(`interactive:${spec.argv[2]}`); return 0; },
    onEvent: e => events.push(e),
  };
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      order.push(`headless:${spec.argv[1]}:${spec.argv[2]}`);
      if (spec.argv[1] === 'harvest') await writeFile(spec.argv[3], '# the plan\n');
      return 0;
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['interactive:plan', 'headless:harvest:plan']);
  const spawns = events.filter(e => e.type === 'step:spawn');
  assert.deepEqual(spawns.map(s => s.type === 'step:spawn' && s.phase), ['main', 'harvest']);
  assert.ok(result.artifacts['plan'].endsWith('plan.md'));
});

test('interactive step fails the run when harvest writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [{ id: 'plan', kind: 'agent', runner: 'fake', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' }],
  };
  const { events, frontend } = collector();
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async () => 0,
  });
  assert.equal(result.ok, false);
  assert.ok(events.some(e => e.type === 'run:error' && e.message.includes('plan.md')));
  // The harvest exited 0, so step:done recorded 'done' before the artifact
  // assertion could refuse. A row left reading done with no artifact can never
  // be re-run, and every later resume dies referencing it.
  const manifest: RunManifest = JSON.parse(await readFile(join(result.runDir, 'run.json'), 'utf8'));
  const plan = manifest.steps.find(s => s.id === 'plan')!;
  assert.equal(plan.status, 'failed');
  assert.equal(plan.artifact, undefined);
});

test('interactive step fails when the user session exits non-zero', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [{ id: 'plan', kind: 'agent', runner: 'fake', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' }],
  };
  const { events } = collector();
  const frontend: Frontend = { runInteractive: async () => 130, onEvent: e => events.push(e) };
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async () => 0,
  });
  assert.equal(result.ok, false);
});

test('loop mode re-runs execute until the reviewer passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    on_findings: 'loop',
    steps: [
      { id: 'exec', kind: 'agent', runner: 'fake', mode: 'headless', writes: true, prompt: 'do', output: 'r.md' },
      { id: 'review', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'check', output: 'f.md' },
    ],
  };
  const { frontend } = collector();
  let reviews = 0;
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const [, , stepId, artifact] = spec.argv;
      if (stepId === 'review') {
        reviews += 1;
        await writeFile(artifact, reviews < 3 ? 'VERDICT: FAIL\nfix it' : 'VERDICT: PASS\nok');
      } else {
        await writeFile(artifact, `attempt\n`);
      }
      return 0;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(reviews, 3); // initial + 2 loop re-reviews, within max_iterations=3
});

test('loop mode gives up after max_iterations and fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    on_findings: 'loop',
    steps: [
      { id: 'exec', kind: 'agent', runner: 'fake', mode: 'headless', writes: true, prompt: 'do', output: 'r.md' },
      { id: 'review', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'check', output: 'f.md' },
    ],
  };
  const { frontend } = collector();
  let execRuns = 0;
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const [, , stepId, artifact] = spec.argv;
      if (stepId === 'exec') execRuns += 1;
      await writeFile(artifact, stepId === 'review' ? 'VERDICT: FAIL\nstill bad' : 'attempt');
      return 0;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'fail');
  assert.equal(execRuns, 1 + DEFAULT_CONFIG.loop.max_iterations);
});

test('loop mode feeds findings into the re-run prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    on_findings: 'loop',
    steps: [
      { id: 'exec', kind: 'agent', runner: 'fake', mode: 'headless', writes: true, prompt: 'do', output: 'r.md' },
      { id: 'review', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'check', output: 'f.md' },
    ],
  };
  const { frontend } = collector();
  const execPrompts: string[] = [];
  await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const [, , stepId, artifact, prompt] = spec.argv;
      if (stepId === 'exec') execPrompts.push(prompt);
      await writeFile(artifact, stepId === 'review'
        ? (execPrompts.length < 2 ? 'VERDICT: FAIL\nbad' : 'VERDICT: PASS\nok')
        : 'attempt');
      return 0;
    },
  });
  assert.equal(execPrompts.length, 2);
  assert.ok(!execPrompts[0].includes('f.md'));
  assert.ok(execPrompts[1].includes('f.md')); // findings artifact injected on the re-run
});

test('interactive findings mode hands the operator a session and fails the run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    on_findings: 'interactive',
    steps: [
      { id: 'exec', kind: 'agent', runner: 'fake', mode: 'headless', writes: true, prompt: 'do', output: 'r.md' },
      { id: 'review', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'check', output: 'f.md' },
    ],
  };
  const { events } = collector();
  const interactivePrompts: string[] = [];
  const frontend: Frontend = {
    runInteractive: async spec => { interactivePrompts.push(spec.argv.join(' ')); return 0; },
    onEvent: e => events.push(e),
  };
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const [, , stepId, artifact] = spec.argv;
      await writeFile(artifact, stepId === 'review' ? 'VERDICT: FAIL\nbad' : 'work');
      return 0;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(interactivePrompts.length, 1);
  assert.ok(interactivePrompts[0].includes('f.md'));
});

test('dry run persists a run.json manifest with dryRun true and steps done', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend, dryRun: true,
  });
  const manifest: RunManifest = JSON.parse(
    await readFile(join(result.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.dryRun, true);
  assert.equal(manifest.status, 'succeeded');
  assert.equal(manifest.ok, true);
  assert.deepEqual(manifest.steps.map(s => s.status), ['done', 'done']);
});

test('successful headless run persists a run.json reflecting the outcome', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async spec => { await writeFile(spec.argv[3], `# out for ${spec.argv[2]}\n`); return 0; },
  });
  assert.equal(result.ok, true);
  const manifest: RunManifest = JSON.parse(
    await readFile(join(result.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.status, 'succeeded');
  assert.equal(manifest.ok, true);
  assert.equal(manifest.runId, result.runId);
  const a = manifest.steps.find(s => s.id === 'a')!;
  assert.equal(a.status, 'done');
  assert.equal(a.artifact, result.artifacts['a']);
});

test('maxRetainedRuns prunes older runs once the run completes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const spawnHeadless = async (spec: { argv: string[] }) => { await writeFile(spec.argv[3], '# out\n'); return 0; };

  const first = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: collector().frontend, spawnHeadless,
  });
  assert.equal(first.ok, true);

  const second = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: collector().frontend, spawnHeadless,
    maxRetainedRuns: 1,
  });
  assert.equal(second.ok, true);

  // Not asserting *which* runId survives: both runs can land in the same
  // second, and runId's random suffix then breaks the lexical-order-equals-
  // chronological-order assumption pruneRuns relies on (a pre-existing
  // property of listRuns' sort, not something this test is about). What
  // matters here is that completing a run with maxRetainedRuns set actually
  // triggers a prune.
  const remaining = await readdir(join(dir, DEFAULT_CONFIG.artifacts_dir));
  assert.equal(remaining.length, 1);
  assert.ok(remaining[0] === first.runId || remaining[0] === second.runId);
});

test('failing run persists a run.json with status failed and an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async () => 0, // exits fine but writes nothing -> missing artifact
  });
  assert.equal(result.ok, false);
  const manifest: RunManifest = JSON.parse(
    await readFile(join(result.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.ok, false);
  assert.ok(manifest.error?.message.includes('a.md'));
  assert.equal(manifest.steps.find(s => s.id === 'a')!.status, 'failed',
    'the step the run failed on must not read done, or no resume can re-run it');
});

test('aborting during step 1 spawn stops before step 2 and reports cancelled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const controller = new AbortController();
  let step2Spawned = false;
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend, signal: controller.signal,
    spawnHeadless: async spec => {
      if (spec.argv[2] === 'b') step2Spawned = true;
      controller.abort();
      return 130;
    },
  });
  assert.equal(step2Spawned, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.ok, false);
  const tail = events.slice(-2);
  assert.deepEqual(tail.map(e => e.type), ['run:cancelled', 'run:done']);
  assert.equal((tail[1] as { ok: boolean }).ok, false);

  const manifest: RunManifest = JSON.parse(await readFile(join(result.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.status, 'cancelled');
});

test('pre-aborted signal prevents any step from spawning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend, signal: controller.signal,
    spawnHeadless: async () => { spawned = true; return 0; },
  });
  assert.equal(spawned, false);
  assert.equal(result.cancelled, true);
  assert.ok(events.some(e => e.type === 'run:cancelled'));
});

test('headless steps get their artifact path appended to the prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [{ id: 'a', kind: 'agent', runner: 'fake', mode: 'headless', writes: true, prompt: 'do it', output: 'out.md' }],
  };
  const { frontend } = collector();
  let seenPrompt = '';
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => { seenPrompt = spec.argv[4]; await writeFile(spec.argv[3], 'x'); return 0; },
  });
  assert.ok(seenPrompt.startsWith('do it'));
  assert.ok(seenPrompt.includes(`Write your 'out.md' artifact to: ${result.artifacts['a']}`));
});

test('an unexpected throw still persists a terminal run.json instead of leaving it running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  // A spawn that rejects — e.g. ENOENT on the runner binary. This path never
  // reached fail(), so run.json used to stay at 'running' with a live pid,
  // which no reader could ever resolve.
  await assert.rejects(
    runWorkflow({
      workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
      registry: registry(), frontend,
      spawnHeadless: async () => { throw new Error('spawn fake ENOENT'); },
    }),
    /spawn fake ENOENT/,
  );
  assert.deepEqual(events.slice(-2).map(e => e.type), ['run:error', 'run:done']);

  const runsDir = join(dir, DEFAULT_CONFIG.artifacts_dir);
  const [runId] = await readdir(runsDir);
  const manifest: RunManifest = JSON.parse(
    await readFile(join(runsDir, runId, 'run.json'), 'utf8'));
  assert.equal(manifest.status, 'failed');
  assert.ok(manifest.error?.message.includes('spawn fake ENOENT'));
  // The step that was in flight when it blew up must not be left spinning.
  assert.equal(manifest.steps.find(s => s.id === 'a')!.status, 'interrupted');
});

test('cancelling mid-step finalizes that step instead of leaving it running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();
  const controller = new AbortController();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend, signal: controller.signal,
    spawnHeadless: async () => { controller.abort(); return 130; },
  });
  const manifest: RunManifest = JSON.parse(
    await readFile(join(result.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.status, 'cancelled');
  const a = manifest.steps.find(s => s.id === 'a')!;
  assert.equal(a.status, 'interrupted');
  assert.ok(a.endedAt);
});

test('a marker left by an earlier attempt never closes the next session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    on_findings: 'loop',
    steps: [
      { id: 'exec', kind: 'agent', runner: 'fake', mode: 'interactive', writes: true, prompt: 'do', output: 'r.md' },
      { id: 'review', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'check', output: 'f.md' },
    ],
  };
  const { events } = collector();
  const sessions: string[] = [];
  const frontend: Frontend = {
    // The engine must have cleared the marker before the session starts,
    // otherwise the watcher would close it the instant it opened.
    runInteractive: async spec => {
      const marker = spec.endSession!.markerPath;
      sessions.push(existsSync(marker) ? 'stale-marker-present' : 'clean');
      await writeFile(marker, ''); // the model says "we're done"
      return 0;
    },
    onEvent: e => events.push(e),
  };
  await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: { ...DEFAULT_CONFIG, loop: { max_iterations: 1 } },
    registry: registry(), frontend,
    spawnHeadless: async spec => {
      const [, phase, stepId, artifact] = spec.argv;
      if (phase === 'harvest') await writeFile(artifact, 'work');
      else await writeFile(artifact, stepId === 'review' ? 'VERDICT: FAIL\nbad' : 'work');
      return 0;
    },
  });

  assert.equal(sessions.length, 2, 'the loop re-ran the interactive step');
  assert.deepEqual(sessions, ['clean', 'clean']);
});

test('the triage session gets the same end-of-session spec as a declared step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    on_findings: 'interactive',
    steps: [
      { id: 'exec', kind: 'agent', runner: 'fake', mode: 'headless', writes: true, prompt: 'do', output: 'r.md' },
      { id: 'review', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'check', output: 'f.md' },
    ],
  };
  const { events } = collector();
  const specs: SpawnSpec[] = [];
  const frontend: Frontend = {
    runInteractive: async spec => { specs.push(spec); return 0; },
    onEvent: e => events.push(e),
  };
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const [, , stepId, artifact] = spec.argv;
      await writeFile(artifact, stepId === 'review' ? 'VERDICT: FAIL\nbad' : 'work');
      return 0;
    },
  });

  assert.equal(specs.length, 1);
  assert.equal(specs[0].endSession?.markerPath, endMarkerPath(result.runDir, 'review-triage'));
});

test('a dry run leaves no marker files behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [{ id: 'plan', kind: 'agent', runner: 'fake', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' }],
  };
  const { frontend } = collector();
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend, dryRun: true,
  });

  // Bookkeeping only — no session marker or await-state file for 'plan'.
  assert.deepEqual(
    (await readdir(result.runDir)).sort(), ['events.ndjson', 'run.json', 'workflow.yaml']);
});

test('a stale await state never makes a fresh session open already looking blocked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    on_findings: 'loop',
    steps: [
      { id: 'exec', kind: 'agent', runner: 'fake', mode: 'interactive', writes: true, prompt: 'do', output: 'r.md' },
      { id: 'review', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'check', output: 'f.md' },
    ],
  };
  const { events } = collector();
  const sessions: string[] = [];
  const frontend: Frontend = {
    runInteractive: async spec => {
      const statePath = spec.awaitState!.statePath;
      sessions.push(existsSync(statePath) ? 'stale-state-present' : 'clean');
      await writeFile(statePath, '{"r":"turn"}');       // the session blocks on the human
      await writeFile(spec.endSession!.markerPath, ''); // then the human ends it
      return 0;
    },
    onEvent: e => events.push(e),
  };
  await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: { ...DEFAULT_CONFIG, loop: { max_iterations: 1 } },
    registry: registry(), frontend,
    spawnHeadless: async spec => {
      const [, phase, stepId, artifact] = spec.argv;
      if (phase === 'harvest') await writeFile(artifact, 'work');
      else await writeFile(artifact, stepId === 'review' ? 'VERDICT: FAIL\nbad' : 'work');
      return 0;
    },
  });

  assert.equal(sessions.length, 2, 'the loop re-ran the interactive step');
  assert.deepEqual(sessions, ['clean', 'clean']);
});

test('the triage session gets its own await-state path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    on_findings: 'interactive',
    steps: [
      { id: 'exec', kind: 'agent', runner: 'fake', mode: 'headless', writes: true, prompt: 'do', output: 'r.md' },
      { id: 'review', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'check', output: 'f.md' },
    ],
  };
  const { events } = collector();
  const specs: SpawnSpec[] = [];
  const frontend: Frontend = {
    runInteractive: async spec => { specs.push(spec); return 0; },
    onEvent: e => events.push(e),
  };
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const [, , stepId, artifact] = spec.argv;
      await writeFile(artifact, stepId === 'review' ? 'VERDICT: FAIL\nbad' : 'work');
      return 0;
    },
  });

  assert.equal(specs[0].awaitState?.statePath, awaitStatePath(result.runDir, 'review-triage'));
});

// --- headless progress ----------------------------------------------------

/** Like fakeRunner, but its headless steps advertise a progress stream. */
function progressRegistry(): AdapterRegistry {
  const base = fakeRunner();
  const reg = new AdapterRegistry();
  reg.register({
    ...base,
    headless(step: AgentStep, ctx: RunCtx): SpawnSpec {
      return { ...base.headless(step, ctx), progress: { format: 'claude-stream-json' } };
    },
  });
  return reg;
}

const oneStep: Workflow = {
  name: 'r',
  steps: [{ id: 'a', kind: 'agent', runner: 'fake', mode: 'headless', writes: true, prompt: 'go', output: 'a.md' }],
};

const toolLine = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/w/runner.ts' } }] },
});
const resultLine = JSON.stringify({ type: 'result', num_turns: 2, total_cost_usd: 0.5 });

test('a headless step reports each parsed progress line as an event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const result = await runWorkflow({
    workflow: oneStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: progressRegistry(), frontend,
    spawnHeadless: async (spec, _signal, onLine) => {
      onLine?.(toolLine);
      onLine?.('this is not json and must not become an event');
      onLine?.(resultLine);
      await writeFile(spec.argv[3], '# out\n');
      return 0;
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    events.filter(e => e.type === 'step:progress').map(e => e.progress),
    [{ kind: 'tool', tool: 'Read', target: '/w/runner.ts' }, { kind: 'usage', turns: 2, costUsd: 0.5 }],
  );
});

test('a step that asked for no progress is handed no line callback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  let sawCallback: boolean | undefined;
  await runWorkflow({
    workflow: oneStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async (spec, _signal, onLine) => {
      sawCallback = onLine !== undefined;
      await writeFile(spec.argv[3], '# out\n');
      return 0;
    },
  });
  assert.equal(sawCallback, false, 'plain headless specs stream nothing to parse');
  assert.equal(events.filter(e => e.type === 'step:progress').length, 0);
});

// ---------------------------------------------------------------------------
// Resume groundwork: the run records what it executed
// ---------------------------------------------------------------------------

test('a run records the workflow it executed in its run directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();

  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async spec => { await writeFile(spec.argv[3], `# out for ${spec.argv[2]}\n`); return 0; },
  });

  // Re-parseable, and the same workflow — this is what a resume will execute,
  // rather than whatever the workspace file says by then.
  const snapshot = parseWorkflow(await readFile(join(result.runDir, 'workflow.yaml'), 'utf8'));
  assert.equal(snapshot.name, 'r');
  assert.deepEqual(snapshot.steps.map(s => s.id), ['a', 'b']);
});

/** A committed git repo, so the read-only guard actually engages. */
async function gitRepo(): Promise<string> {
  const exec = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-git-'));
  await exec('git', ['init', '-b', 'main'], { cwd: dir });
  await writeFile(join(dir, 'tracked.txt'), 'hello\n');
  await exec('git', ['add', '.'], { cwd: dir });
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: dir });
  return dir;
}

test('a read-only step whose tree changed after a clean harvest is recorded failed, not done', async () => {
  // The field wedge, from run 20260910-134600-15ec: a concurrent run edited
  // the tree during a 42-minute interactive session, so the guard refused a
  // step whose harvest had already exited 0 and written a perfectly good
  // artifact. The run must not record that step as done.
  const dir = await gitRepo();
  const workflow: Workflow = {
    name: 'r',
    steps: [{ id: 'plan', kind: 'agent', runner: 'fake', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' }],
  };
  const { events, frontend } = collector();
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      if (spec.argv[1] === 'harvest') {
        await writeFile(spec.argv[3], '# the plan\n');
        // Somebody else's run, moving the tree under us.
        await writeFile(join(dir, 'tracked.txt'), 'edited by another run\n');
      }
      return 0;
    },
  });

  assert.equal(result.ok, false);
  assert.ok(events.some(e => e.type === 'run:error' && e.message.includes('modified the tree')));
  const manifest: RunManifest = JSON.parse(await readFile(join(result.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.steps.find(s => s.id === 'plan')!.status, 'failed');
});

test('a command killed by its timeout is recorded failed even when the child reports 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [{ id: 'slow', kind: 'command', run: 'sleep 10', output: 'slow.log', timeout_ms: 20 }],
  };
  const { frontend } = collector();
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    // A killed child whose exit code reads as a clean one: step:done records
    // 'done' before the timeout check can refuse.
    spawnHeadless: async (_spec, signal) => {
      await new Promise(r => signal?.addEventListener('abort', r, { once: true }));
      return 0;
    },
  });

  assert.equal(result.ok, false);
  const manifest: RunManifest = JSON.parse(await readFile(join(result.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.steps.find(s => s.id === 'slow')!.status, 'failed');
  assert.ok(manifest.error?.message.includes('timed out'));
});

test('a run wedged by a step that finished without its artifact can still be resumed', async () => {
  // The whole invariant, end to end: whatever a run failed on, fixing the
  // underlying problem and resuming must carry it to completion.
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();
  const broken = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async () => 0, // exits clean, writes nothing
  });
  assert.equal(broken.ok, false);

  const plan = await planResume(dir, DEFAULT_CONFIG, broken.runId);
  const resumed = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: resumed.frontend, resume: plan,
    spawnHeadless: async spec => { await writeFile(spec.argv[3], `# out for ${spec.argv[2]}\n`); return 0; },
  });

  assert.equal(result.ok, true, 'the resume must not die on the row the first attempt left behind');
  assert.equal(result.runId, broken.runId, 'resumed in place');
  assert.ok(result.artifacts['a'] && result.artifacts['b']);
  // 'b' names 'a' in its inputs — the reference that used to throw.
  assert.ok(resumed.events.some(e => e.type === 'step:spawn' && e.stepId === 'a'),
    "the step that never produced its artifact has to run again");
});

test('a step that started but died before spawning records no session to resume', async () => {
  // The second half of the field failure: technical-grill was recorded as
  // started (step:start fires before the prompt is built), then threw in
  // buildPrompt over a missing input artifact — never spawning. Its minted id
  // named no conversation, so the next resume's `--resume <id>` exited 1.
  const workflow: Workflow = {
    name: 'r',
    steps: [
      { id: 'a', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, prompt: 'first', output: 'a.md' },
      { id: 'b', kind: 'agent', runner: 'fake', mode: 'interactive', writes: false, prompt: 'second', inputs: ['a'], output: 'b.md' },
    ],
  };
  // 'a' skipped as done but contributing no artifact — the wedged state, so
  // that building 'b' throws exactly where it did in the field. The adapter
  // has to route through buildPrompt for that, as the real ones do.
  const plan = await resumePlan(workflow, new Map([['a', {}]]));
  const viaBuildPrompt = new AdapterRegistry();
  const base = fakeRunner();
  viaBuildPrompt.register({
    ...base,
    interactive: (step, ctx) => ({ ...base.interactive(step, ctx), argv: ['fake', 'interactive', step.id, buildPrompt(step, ctx)] }),
  });
  const { frontend } = collector();
  await assert.rejects(runWorkflow({
    workflow, workdir: await mkdtemp(join(tmpdir(), 'whiphand-run-')), inputs: {},
    config: DEFAULT_CONFIG, registry: viaBuildPrompt, frontend, resume: plan,
    spawnHeadless: async () => 0,
  }), /no artifact recorded for step 'a'/);

  const manifest: RunManifest = JSON.parse(await readFile(join(plan.runDir, 'run.json'), 'utf8'));
  const b = manifest.steps.find(s => s.id === 'b')!;
  assert.equal(b.status, 'interrupted', 'it did start');
  assert.equal(b.sessionStarted, undefined, 'but no conversation was ever opened under its id');
});

// ---------------------------------------------------------------------------
// Resume: the walk replays from the top, skipping what already finished
// ---------------------------------------------------------------------------

/**
 * A ResumePlan over a real run directory — RunJournal.reopen writes there, so
 * it cannot be a placeholder path. planResume itself is tested in resume.test.ts.
 */
async function resumePlan(
  workflow: Workflow, done: Map<string, { artifact?: string; verdict?: 'pass' | 'fail' }>,
  steps: RunManifest['steps'] = [],
): Promise<ResumePlan> {
  const runDir = await mkdtemp(join(tmpdir(), 'whiphand-resume-run-'));
  const manifest: RunManifest = {
    version: 2, runId: 'run-x', workflow: workflow.name, workdir: '/w', dryRun: false,
    pid: process.pid, startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    status: 'failed', inputs: {}, sessionIds: {}, steps,
  };
  return {
    runId: 'run-x', runDir, manifest, workflow,
    inputs: {}, sessionIds: {}, artifacts: {}, attempts: {},
    done, resumedStepIds: new Set(), attachments: [], restartAt: undefined, loopBudgets: {}, warnings: [],
  };
}

const twoCommands: Workflow = {
  name: 'two',
  steps: [
    { id: 'first', kind: 'command', run: 'exit 0', output: 'first.log' },
    { id: 'second', kind: 'command', run: 'exit 0', output: 'second.log' },
  ],
};

test('a resumed run spawns nothing for steps already done', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const spawns: string[] = [];

  await runWorkflow({
    workflow: twoCommands, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async spec => { spawns.push(spec.argv.join(' ')); return 0; },
    resume: await resumePlan(twoCommands, new Map([['first', { artifact: '/r/first.log' }]])),
  });

  assert.equal(spawns.length, 1, 'only the unfinished step should spawn');
  assert.ok(events.some(e => e.type === 'step:skipped' && e.stepId === 'first'));
  assert.ok(events.some(e => e.type === 'step:start' && e.stepId === 'second'));
  // A second run:start would read as a second run to every consumer.
  assert.equal(events.some(e => e.type === 'run:start'), false);
  assert.ok(events.some(e => e.type === 'run:resume'));
});

test('a resumed run leaves one entry per step, with the retry rewriting its failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();
  const plan = await resumePlan(
    twoCommands,
    new Map([['first', { artifact: '/r/first.log' }]]),
    [
      { id: 'first', kind: 'command', status: 'done', artifact: '/r/first.log', endedAt: '2026-01-01T00:00:01Z' },
      { id: 'second', kind: 'command', status: 'failed', exitCode: 1, endedAt: '2026-01-01T00:00:02Z' },
    ],
  );

  await runWorkflow({
    workflow: twoCommands, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async () => 0,
    resume: plan,
  });

  const onDisk = JSON.parse(await readFile(join(plan.runDir, 'run.json'), 'utf8')) as RunManifest;
  assert.deepEqual(onDisk.steps.map(s => s.id), ['first', 'second']);
  // The skipped step keeps everything it earned; the re-run one ends on its retry.
  assert.equal(onDisk.steps[0].status, 'done');
  assert.equal(onDisk.steps[0].artifact, '/r/first.log');
  assert.equal(onDisk.steps[1].status, 'done');
  assert.equal(onDisk.steps[1].exitCode, 0);
});

test('a skipped step restores its artifact for later steps to reference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();

  const result = await runWorkflow({
    workflow: twoCommands, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async () => 0,
    resume: await resumePlan(twoCommands, new Map([['first', { artifact: '/r/first.log' }]])),
  });

  assert.equal(result.artifacts['first'], '/r/first.log');
});

test('a resumed run continues in place rather than minting a new run directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const plan = await resumePlan(twoCommands, new Map([['first', { artifact: '/r/first.log' }]]));

  const result = await runWorkflow({
    workflow: twoCommands, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async () => 0,
    resume: plan,
  });

  // A new run directory would strand every artifact the resume exists to reuse.
  assert.equal(result.runId, plan.runId);
  assert.equal(result.runDir, plan.runDir);
  const resumeEvent = events.find(e => e.type === 'run:resume');
  assert.equal(resumeEvent?.type === 'run:resume' && resumeEvent.runId, plan.runId);
});

const cycle: Workflow = {
  name: 'cyc',
  steps: [
    {
      kind: 'loop', id: 'fix', until: 'check', max_iterations: 3,
      steps: [
        { id: 'edit', kind: 'command', run: 'exit 0', output: 'edit.log' },
        { id: 'check', kind: 'command', run: 'exit 0', verdict: true, output: 'check.log' },
      ],
    },
  ],
};

test('a skipped verdict step that failed still sends its loop round again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();

  await runWorkflow({
    workflow: cycle, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async () => 0,
    resume: await resumePlan(cycle, new Map([
      ['edit', { artifact: '/r/fix/iter-1/edit.log' }],
      // Iteration 1 failed its check. Returning null for this skip would make
      // the loop read as passing and end a run that had not finished.
      ['check', { artifact: '/r/fix/iter-1/check.log', verdict: 'fail' }],
    ])),
  });

  const iterations = events.filter(e => e.type === 'loop:iteration');
  assert.ok(iterations.length >= 2, 'iteration 1 failed, so iteration 2 must run');
});

test('a skipped verdict step that passed ends its loop where it ended before', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const spawns: string[] = [];

  await runWorkflow({
    workflow: cycle, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async spec => { spawns.push(spec.argv.join(' ')); return 0; },
    resume: await resumePlan(cycle, new Map([
      ['edit', { artifact: '/r/fix/iter-1/edit.log' }],
      ['check', { artifact: '/r/fix/iter-1/check.log', verdict: 'pass' }],
    ])),
  });

  assert.equal(spawns.length, 0, 'the loop already passed; nothing should run again');
  assert.ok(events.some(e => e.type === 'loop:done' && e.passed));
});

test('a resumed loop restarts mid-iteration, keeping what that iteration produced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();

  await runWorkflow({
    workflow: cycle, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async () => 0,
    resume: await resumePlan(cycle, new Map([
      ['edit', { artifact: '/r/1/edit.log' }],
      ['check', { artifact: '/r/1/check.log', verdict: 'fail' }],
      // Iteration 2 got as far as edit, then the run died.
      ['edit#2', { artifact: '/r/2/edit.log' }],
    ])),
  });

  const started = events
    .filter(e => e.type === 'step:start')
    .map(e => `${e.stepId}#${e.iteration ?? 1}`);
  assert.equal(started.includes('edit#2'), false, 'edit was done in iteration 2');
  assert.ok(started.includes('check#2'), 'the failed step restarts, in its own iteration');
});

test('a skip is consumed once, so a step re-run by on_findings loop really runs', async () => {
  // The legacy top-level jump re-executes the same step id with no iteration,
  // so the same execution key comes round twice. A persistent lookup would
  // silently skip the second execution and the findings would never be addressed.
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'legacy',
    on_findings: 'loop',
    steps: [
      { id: 'work', kind: 'agent', runner: 'fake', mode: 'headless', writes: true, prompt: 'w', output: 'w.md' },
      { id: 'review', kind: 'agent', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'r', output: 'f.md' },
    ],
  };
  const { events, frontend } = collector();

  await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: { ...DEFAULT_CONFIG, loop: { max_iterations: 1 } },
    registry: registry(), frontend,
    spawnHeadless: async spec => {
      await writeFile(spec.argv[3], spec.argv[2] === 'review' ? 'VERDICT: FAIL\n' : '# work\n');
      return 0;
    },
    resume: await resumePlan(workflow, new Map([['work', { artifact: '/r/w.md' }]])),
  });

  const worked = events.filter(e => e.type === 'step:start' && e.stepId === 'work');
  assert.equal(worked.length, 1, 'the second execution of work must not inherit the first skip');
});

test('a dry run records the workflow too, so nothing depends on having spawned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();

  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend, dryRun: true,
  });

  assert.equal(parseWorkflow(await readFile(join(result.runDir, 'workflow.yaml'), 'utf8')).name, 'r');
});

// ---------------------------------------------------------------------------
// capture: 'review'
// ---------------------------------------------------------------------------

/** A frontend that answers each successive runManual call with the next scripted response. */
function scriptedManual(answers: ManualResponse[]): { events: WhiphandEvent[]; frontend: Frontend } {
  const events: WhiphandEvent[] = [];
  let next = 0;
  return {
    events,
    frontend: {
      runInteractive: async () => 0,
      runManual: async () => answers[next++],
      onEvent: e => events.push(e),
    },
  };
}

test('capture: note writes byte-identical to before CaptureSpec existed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [{
      id: 'sign', kind: 'manual', title: 'Ship it?', instructions: 'Look at the diff.',
      capture: 'note', output: 'note.md',
    }],
  };
  const { frontend } = scriptedManual([{ choice: 'continue', note: 'looks good' }]);

  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
  });
  assert.equal(result.ok, true);
  assert.equal(
    await readFile(join(result.runDir, 'note.md'), 'utf8'),
    "# Ship it?\n\n_manual step 'sign'_\n\nlooks good\n",
  );
});

const reviewLoop: Workflow = {
  name: 'r',
  steps: [{
    id: 'fix', kind: 'loop', until: 'sign', max_iterations: 2,
    steps: [
      {
        id: 'execute', kind: 'agent', runner: 'fake', mode: 'headless', writes: true,
        inputs: ['sign'], prompt: 'do it', output: 'report.md',
      },
      {
        id: 'sign', kind: 'approval', verdict: true, title: 'Ship it?',
        instructions: 'Look at the diff.', capture: 'review', output: 'feedback.md',
      },
    ],
  }],
};

test('retry with comments writes the review artifact and drives the loop round again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend, events } = scriptedManual([
    { choice: 'retry', note: 'fix the naming', comments: [{ path: 'src/x.ts', body: 'rename this' }] },
    { choice: 'continue' },
  ]);

  const result = await runWorkflow({
    workflow: reviewLoop, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      await writeFile(spec.argv[3], `# out for ${spec.argv[2]}\n`);
      return 0;
    },
  });
  assert.equal(result.ok, true);

  const feedback1 = await readFile(join(result.runDir, 'fix', 'iter-1', 'feedback.md'), 'utf8');
  assert.match(feedback1, /_approval step 'sign' — changes requested_/);
  assert.match(feedback1, /## `src\/x\.ts`/);
  assert.match(feedback1, /rename this/);
  assert.match(feedback1, /fix the naming/);

  // Two iterations really ran (a second 'execute' spawned), and the loop's
  // own verdict is the human's: fail (retry), then pass (continue).
  assert.equal(events.filter(e => e.type === 'step:start' && e.stepId === 'execute').length, 2);
  assert.equal(events.filter(e => e.type === 'step:verdict').map(e => e.verdict).join(','), 'fail,pass');
});
