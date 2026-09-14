/**
 * The sessionIdCapture flow (opencode's shape): unlike sessionIdInjection,
 * the runner cannot know the session id before the interactive spawn exits,
 * and `SpawnSpec.files` has to land on disk before any spawn that names them.
 * Exercised here against a fake adapter rather than the opencode adapter
 * itself, so these tests describe the engine's contract, not opencode's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from './runner.ts';
import { AdapterRegistry } from '../registry.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { opencodeAdapter } from '../adapters/opencode.ts';
import type {
  AgentStep, Frontend, WhiphandEvent, Workflow, RunnerAdapter, SpawnSpec, RunCtx,
} from '../types.ts';

function collector(): { events: WhiphandEvent[]; frontend: Frontend } {
  const events: WhiphandEvent[] = [];
  return { events, frontend: { runInteractive: async () => 0, onEvent: e => events.push(e) } };
}

/** A `sessionIdCapture` adapter shaped like opencode's, with a controllable capture answer. */
function captureRunner(opts: { capture: (step: AgentStep, ctx: RunCtx) => Promise<string | undefined> }): RunnerAdapter {
  return {
    id: 'capturer',
    capabilities: { sessionIdInjection: false, sessionIdCapture: true, sessionResume: true, toolDenial: true, shareTranscript: false },
    detect: async () => ({ installed: true }),
    interactive(step: AgentStep, ctx: RunCtx): SpawnSpec {
      return {
        argv: ['capturer', 'interactive', step.id], cwd: ctx.workdir, interactive: true,
        env: {},
        files: [{ path: join(ctx.runDir, `.${step.id}.guidance.md`), content: 'be helpful' }],
      };
    },
    headless(step: AgentStep, ctx: RunCtx): SpawnSpec {
      return { argv: ['capturer', 'headless', step.id], cwd: ctx.workdir, env: {}, interactive: false };
    },
    harvest(step: AgentStep, ctx: RunCtx): SpawnSpec {
      return {
        argv: ['capturer', 'harvest', step.id, ctx.sessionIds[step.id] ?? '<none>', ctx.artifacts[step.id]],
        cwd: ctx.workdir, env: {}, interactive: false,
      };
    },
    captureSessionId: opts.capture,
  };
}

function registryWith(adapter: RunnerAdapter): AdapterRegistry {
  const reg = new AdapterRegistry();
  reg.register(adapter);
  return reg;
}

const planWorkflow: Workflow = {
  name: 'r',
  steps: [{ id: 'plan', kind: 'agent', runner: 'capturer', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' }],
};

test('a captured session id is emitted as step:session and threaded into harvest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const adapter = captureRunner({ capture: async () => 'ses_captured' });
  const harvestArgv: string[][] = [];
  const result = await runWorkflow({
    workflow: planWorkflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registryWith(adapter), frontend,
    spawnHeadless: async spec => {
      harvestArgv.push(spec.argv);
      if (spec.argv[1] === 'harvest') await writeFile(spec.argv[4], '# plan\n');
      return 0;
    },
  });
  assert.equal(result.ok, true);
  const sessionEvent = events.find(e => e.type === 'step:session');
  assert.deepEqual(sessionEvent, { type: 'step:session', stepId: 'plan', sessionId: 'ses_captured' });
  assert.equal(harvestArgv.find(a => a[1] === 'harvest')?.[3], 'ses_captured');

  const manifest = JSON.parse(await readFile(join(result.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.sessionIds.plan, 'ses_captured', 'folded into the manifest, same as an injected id');
});

test('an undetermined session id fails the step with a clear message and spawns no harvest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const adapter = captureRunner({ capture: async () => undefined });
  let harvestSpawned = false;
  const result = await runWorkflow({
    workflow: planWorkflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registryWith(adapter), frontend,
    spawnHeadless: async spec => {
      if (spec.argv[1] === 'harvest') harvestSpawned = true;
      return 0;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(harvestSpawned, false, 'a doomed harvest must never be attempted');
  const error = events.find(e => e.type === 'run:error');
  assert.ok(error?.type === 'run:error' && /could not determine.*session id/.test(error.message), JSON.stringify(error));
  assert.equal(events.some(e => e.type === 'step:session'), false);
});

test('capture is skipped for a resumed step: the manifest\'s id is trusted, not re-derived', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  let captureCalls = 0;
  const adapter = captureRunner({ capture: async () => { captureCalls += 1; return 'should-not-be-used'; } });
  const harvestArgv: string[][] = [];

  // First attempt: the id gets captured (so it lands in the manifest) but the
  // harvest itself fails, leaving a run that is resumable with that id intact.
  const first = await runWorkflow({
    workflow: planWorkflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registryWith(captureRunner({ capture: async () => 'ses_original' })), frontend,
    spawnHeadless: async spec => (spec.argv[1] === 'harvest' ? 1 : 0),
  });
  assert.equal(first.ok, false);

  const manifest = JSON.parse(await readFile(join(first.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.sessionIds.plan, 'ses_original');

  const { planResume } = await import('./resume.ts');
  const plan = await planResume(dir, DEFAULT_CONFIG, first.runId);
  assert.equal(plan.resumedStepIds.has('plan'), true, 'a spawned interactive step is resumable');

  const result = await runWorkflow({
    workflow: plan.workflow, workdir: dir, inputs: plan.inputs, config: DEFAULT_CONFIG,
    registry: registryWith(adapter), frontend, resume: plan,
    spawnHeadless: async spec => {
      harvestArgv.push(spec.argv);
      if (spec.argv[1] === 'harvest') await writeFile(spec.argv[4], '# plan again\n');
      return 0;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(captureCalls, 0, 'ctx.sessionIds already had an id — captureSessionId must not run again');
  assert.equal(harvestArgv.find(a => a[1] === 'harvest')?.[3], 'ses_original');
});

test('SpawnSpec.files land on disk before the spawn, and are skipped entirely on a dry run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();
  const adapter = captureRunner({ capture: async () => 'ses_x' });
  let sawFileWhenSpawned: boolean | undefined;

  const result = await runWorkflow({
    workflow: planWorkflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registryWith(adapter),
    frontend: {
      ...frontend,
      runInteractive: async (spec) => {
        const guidance = spec.files?.[0];
        sawFileWhenSpawned = guidance !== undefined && existsSync(guidance.path);
        return 0;
      },
    },
    spawnHeadless: async spec => {
      if (spec.argv[1] === 'harvest') await writeFile(spec.argv[4], '# plan\n');
      return 0;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(sawFileWhenSpawned, true, 'the guidance file must exist by the time the frontend spawns the session');

  const dryDir = await mkdtemp(join(tmpdir(), 'whiphand-run-dry-'));
  const dryResult = await runWorkflow({
    workflow: planWorkflow, workdir: dryDir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registryWith(adapter), frontend: collector().frontend, dryRun: true,
  });
  assert.equal(dryResult.ok, true);
  assert.equal(existsSync(join(dryResult.runDir, '.plan.guidance.md')), false, 'a dry run writes no support files');
});

test('a dry run against the real opencode adapter builds a harvest spec without throwing', async () => {
  // The fake capturer's own harvest() shrugs off a missing id with '<none>',
  // which is exactly what let this bug through review the first time: the
  // real adapter's harvest() calls sessionId(), which throws when nothing has
  // been captured — and a dry run never captures anything.
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-dry-opencode-'));
  const registry = new AdapterRegistry();
  registry.register(opencodeAdapter);
  const opencodeWorkflow: Workflow = {
    name: 'r',
    steps: [{ id: 'plan', kind: 'agent', runner: 'opencode', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' }],
  };
  const events: WhiphandEvent[] = [];
  const result = await runWorkflow({
    workflow: opencodeWorkflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry, frontend: { runInteractive: async () => 0, onEvent: e => events.push(e) }, dryRun: true,
  });
  assert.equal(result.ok, true);
  const harvestSpawn = events.find(e => e.type === 'step:spawn' && e.phase === 'harvest');
  assert.ok(harvestSpawn, 'the harvest step:spawn must still be emitted on a dry run');
});

test('a loop re-captures the session id every fresh interactive iteration, not just the first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-loop-capture-'));
  const { events, frontend } = collector();
  const captured: string[] = [];
  const harvested: string[] = [];
  let n = 0;
  const adapter = captureRunner({ capture: async () => { n += 1; const id = `ses_${n}`; captured.push(id); return id; } });

  const loopWorkflow: Workflow = {
    name: 'r',
    steps: [{
      kind: 'loop', id: 'fix', until: 'check', max_iterations: 2,
      steps: [
        { id: 'plan', kind: 'agent', runner: 'capturer', mode: 'interactive', writes: true, prompt: 'p', output: 'plan.md' },
        { kind: 'command', id: 'check', verdict: true, output: 'check.log', run: 'true' },
      ],
    }],
  };

  const result = await runWorkflow({
    workflow: loopWorkflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registryWith(adapter), frontend,
    spawnHeadless: async spec => {
      if (spec.argv[0] === 'capturer' && spec.argv[1] === 'harvest') {
        harvested.push(spec.argv[3]);
        await writeFile(spec.argv[4], '# plan\n');
        return 0;
      }
      // The command step ('check'): fail iteration 1, pass iteration 2.
      return harvested.length > 1 ? 0 : 1;
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(captured, ['ses_1', 'ses_2'], 'each fresh spawn must be captured on its own');
  assert.deepEqual(harvested, ['ses_1', 'ses_2'], 'each iteration must harvest its own session, not the previous one');
  const sessionEvents = events.filter(e => e.type === 'step:session');
  assert.deepEqual(sessionEvents.map(e => e.type === 'step:session' && e.sessionId), ['ses_1', 'ses_2']);
});

