/**
 * The cycle constructs: loop steps, command steps, and manual/approval steps.
 * Kept in its own file so the original runner.test.ts stays a record of the
 * pre-cycles behaviour that must not regress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from './runner.ts';
import { buildPrompt } from '../template.ts';
import { endMarkerPath } from './session-end.ts';
import { awaitStatePath } from './await-state.ts';
import { AdapterRegistry } from '../registry.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import type { RunManifest } from './manifest.ts';
import type {
  AgentStep, Frontend, ManualRequest, ManualResponse, WhiphandEvent, Workflow, RunCtx,
  RunnerAdapter, SpawnSpec,
} from '../types.ts';

function fakeRunner(): RunnerAdapter {
  // buildPrompt is what turns `inputs: [...]` into the artifact list a real
  // runner sees, so the fake must go through it too or this harness would
  // quietly disagree with claude/copilot about what a step was told.
  const build = (phase: string) => (step: AgentStep, ctx: RunCtx): SpawnSpec => ({
    argv: ['fake', phase, step.id, ctx.artifacts[step.id], buildPrompt(step, ctx)],
    cwd: ctx.workdir, env: {}, interactive: phase === 'interactive',
    ...(phase === 'interactive'
      ? {
          endSession: { markerPath: endMarkerPath(ctx.runDir, step.id), quitSequence: 'q' },
          awaitState: { statePath: awaitStatePath(ctx.runDir, step.id) },
        }
      : {}),
  });
  return {
    id: 'fake',
    capabilities: { sessionIdInjection: true, sessionResume: true, toolDenial: true, shareTranscript: false },
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
  frontend: Frontend;
  asked: ManualRequest[];
}

function harness(answers: ManualResponse[] = []): Harness {
  const events: WhiphandEvent[] = [];
  const asked: ManualRequest[] = [];
  const queue = [...answers];
  return {
    events,
    asked,
    frontend: {
      runInteractive: async () => 0,
      runManual: async request => {
        asked.push(request);
        return queue.shift() ?? { choice: 'continue' };
      },
      onEvent: e => events.push(e),
    },
  };
}

const agent = (over: Partial<AgentStep> & { id: string }): AgentStep => ({
  kind: 'agent', runner: 'fake', mode: 'headless', writes: false,
  prompt: `prompt for ${over.id}`, output: `${over.id}.md`, ...over,
});

/** Fails the `until` command for the first `failures` iterations, then passes. */
function flakyCommandWorkflow(failures: number, maxIterations = 3): Workflow {
  return {
    name: 'cycle',
    steps: [{
      kind: 'loop', id: 'fix', until: 'tests', max_iterations: maxIterations,
      steps: [
        agent({ id: 'execute', writes: true, inputs: ['tests'] }),
        {
          kind: 'command', id: 'tests', verdict: true, output: 'tests.log',
          run: `test "$(cat counter)" -gt ${failures}`,
        },
      ],
    }],
  };
}

async function tmpWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'whiphand-cycle-'));
}

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------

test('a loop repeats its body until the until step passes', async () => {
  const dir = await tmpWorkdir();
  await writeFile(join(dir, 'counter'), '0');
  const h = harness();
  let attempts = 0;

  const result = await runWorkflow({
    workflow: flakyCommandWorkflow(2), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend,
    spawnHeadless: async spec => {
      if (spec.argv[0] === 'fake') {
        attempts += 1;
        await writeFile(join(dir, 'counter'), String(attempts));
        await writeFile(spec.argv[3], `attempt ${attempts}\n`);
        return 0;
      }
      // the real command step: compare the counter against the threshold
      return attempts > 2 ? 0 : 1;
    },
  });

  assert.equal(result.ok, true, 'the loop should exit once the command passes');
  assert.equal(attempts, 3, 'execute runs once per iteration until tests pass');
  const iterations = h.events.filter(e => e.type === 'loop:iteration');
  assert.deepEqual(iterations.map(e => e.type === 'loop:iteration' && e.iteration), [1, 2, 3]);
  const done = h.events.find(e => e.type === 'loop:done');
  assert.deepEqual(done, { type: 'loop:done', loopId: 'fix', iterations: 3, passed: true });
});

test('each iteration writes its own artifacts instead of overwriting the last', async () => {
  const dir = await tmpWorkdir();
  const h = harness();
  let attempts = 0;

  const result = await runWorkflow({
    workflow: flakyCommandWorkflow(1), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend,
    spawnHeadless: async spec => {
      if (spec.argv[0] === 'fake') {
        attempts += 1;
        await writeFile(spec.argv[3], `attempt ${attempts}\n`);
        return 0;
      }
      return attempts > 1 ? 0 : 1;
    },
  });

  assert.equal(result.ok, true);
  const first = join(result.runDir, 'fix', 'iter-1', 'execute.md');
  const second = join(result.runDir, 'fix', 'iter-2', 'execute.md');
  assert.ok(existsSync(first) && existsSync(second), 'both iterations survive on disk');
  assert.equal((await readFile(first, 'utf8')).trim(), 'attempt 1');
  assert.equal((await readFile(second, 'utf8')).trim(), 'attempt 2');
  assert.equal(result.artifacts['execute'], second, 'latest wins for downstream references');
});

test('a loop body step referencing a later sibling gets the previous iteration', async () => {
  const dir = await tmpWorkdir();
  const h = harness();
  let attempts = 0;
  const seenInputs: Array<string[] | undefined> = [];

  await runWorkflow({
    workflow: {
      name: 'cycle',
      steps: [{
        kind: 'loop', id: 'fix', until: 'review', max_iterations: 2,
        steps: [
          agent({ id: 'execute', writes: true, inputs: ['review'] }),
          agent({ id: 'review', verdict: true, inputs: ['execute'] }),
        ],
      }],
    },
    workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend: h.frontend,
    spawnHeadless: async spec => {
      const stepId = spec.argv[2];
      if (stepId === 'execute') {
        attempts += 1;
        // The prompt lists the artifacts this step was given.
        seenInputs.push(spec.argv[4].includes('- review:') ? ['review'] : undefined);
        await writeFile(spec.argv[3], `attempt ${attempts}\n`);
      } else {
        await writeFile(spec.argv[3], attempts > 1 ? 'VERDICT: PASS\n' : 'VERDICT: FAIL\nfix it\n');
      }
      return 0;
    },
  });

  assert.deepEqual(seenInputs, [undefined, ['review']],
    'iteration 1 has no previous review to read; iteration 2 does');
});

test('an exhausted loop fails the run and names what never passed', async () => {
  const dir = await tmpWorkdir();
  const h = harness();

  const result = await runWorkflow({
    workflow: flakyCommandWorkflow(99, 2), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend,
    spawnHeadless: async spec => {
      if (spec.argv[0] === 'fake') { await writeFile(spec.argv[3], 'work\n'); return 0; }
      return 1;
    },
  });

  assert.equal(result.ok, false);
  const error = h.events.find(e => e.type === 'run:error');
  assert.ok(error && error.type === 'run:error' && error.message.includes("loop 'fix'"));
  assert.ok(error && error.type === 'run:error' && error.message.includes('2 iterations'));
  const done = h.events.find(e => e.type === 'loop:done');
  assert.equal(done && done.type === 'loop:done' && done.passed, false);
});

test('an exhausted loop blames the loop, not the reviewer that kept saying FAIL', async () => {
  // run:error's stepId now demotes the row it names, so blaming the until-step
  // would wipe the verdict and artifact of an iteration that really did run —
  // and re-run it on the next resume. What ran out was the loop's budget.
  const dir = await tmpWorkdir();
  const h = harness();

  const result = await runWorkflow({
    workflow: flakyCommandWorkflow(99, 2), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend,
    spawnHeadless: async spec => {
      if (spec.argv[0] === 'fake') { await writeFile(spec.argv[3], 'work\n'); return 0; }
      return 1;
    },
  });

  assert.equal(result.ok, false);
  const manifest: RunManifest = JSON.parse(await readFile(join(result.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.error?.stepId, 'fix');
  assert.equal(manifest.steps.find(s => s.id === 'fix')!.status, 'failed');
  // The reviewer completed every time it ran; its verdict and artifact stand.
  for (const row of manifest.steps.filter(s => s.id === 'tests')) {
    assert.equal(row.status, 'done');
    assert.equal(row.verdict, 'fail');
    assert.ok(row.artifact, 'a completed iteration keeps its artifact');
  }
});

test('--max-iterations overrides the loop budget for one run', async () => {
  const dir = await tmpWorkdir();
  const h = harness();

  await runWorkflow({
    workflow: flakyCommandWorkflow(99, 5), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend, maxIterations: 1,
    spawnHeadless: async spec => {
      if (spec.argv[0] === 'fake') { await writeFile(spec.argv[3], 'work\n'); return 0; }
      return 1;
    },
  });

  assert.equal(h.events.filter(e => e.type === 'loop:iteration').length, 1);
});

test('a hard failure inside a loop body stops the run rather than iterating', async () => {
  const dir = await tmpWorkdir();
  const h = harness();

  const result = await runWorkflow({
    workflow: flakyCommandWorkflow(99), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend,
    spawnHeadless: async spec => (spec.argv[0] === 'fake' ? 1 : 0), // agent step exits non-zero
  });

  assert.equal(result.ok, false);
  assert.equal(h.events.filter(e => e.type === 'loop:iteration').length, 1,
    'a broken step is a failure, not a reason to try again');
});

// ---------------------------------------------------------------------------
// Disabling a step
// ---------------------------------------------------------------------------

test('a loop whose until step is disabled fails at run start, naming the loop', async () => {
  const dir = await tmpWorkdir();
  const h = harness();
  const workflow: Workflow = {
    name: 'r',
    steps: [{
      kind: 'loop', id: 'fix', until: 'review', max_iterations: 2,
      steps: [
        agent({ id: 'execute', writes: true }),
        agent({ id: 'review', verdict: true, enabled: false }),
      ],
    }],
  };
  await assert.rejects(runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend: h.frontend, dryRun: true,
  }), (e: Error) => e.message.includes("loop 'fix'") && e.message.includes('can never end'));
  const runsDir = join(dir, '.whiphand', 'runs');
  assert.deepEqual(await readdir(runsDir).catch(() => []), []);
});

test('disabling a whole loop runs nothing inside it, and the manifest still records every body step', async () => {
  const dir = await tmpWorkdir();
  const h = harness();
  const started: string[] = [];
  const workflow: Workflow = {
    name: 'r',
    steps: [
      agent({ id: 'plan', writes: false }),
      {
        kind: 'loop', id: 'fix', until: 'review', max_iterations: 2, enabled: false,
        steps: [
          agent({ id: 'execute', writes: true }),
          agent({ id: 'review', verdict: true }),
        ],
      },
    ],
  };
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend: h.frontend,
    spawnHeadless: async spec => { started.push(spec.argv[2]); await writeFile(spec.argv[3], 'ok'); return 0; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(started, ['plan'], 'nothing inside the disabled loop ever spawns');
  assert.equal(h.events.some(e => e.type === 'loop:start'), false);

  const manifest: RunManifest = JSON.parse(await readFile(join(result.runDir, 'run.json'), 'utf8'));
  assert.equal(manifest.steps.find(s => s.id === 'fix')?.status, 'disabled');
  assert.equal(manifest.steps.find(s => s.id === 'execute')?.status, 'disabled');
  assert.equal(manifest.steps.find(s => s.id === 'review')?.status, 'disabled');
});

test('an exhausted loop\'s on_exhausted: interactive triage inherits the until-step\'s stripped inputs', async () => {
  // Before pruning happened once (in the pruner rather than at each buildPrompt
  // call site), this reproduced the spec's motivating crash one layer out: the
  // until step's own `inputs` still named a disabled step, so runTriage's
  // buildPrompt threw TemplateError at the human handoff — after the loop had
  // already burned its whole budget.
  const dir = await tmpWorkdir();
  const h = harness();
  const interactivePrompts: string[] = [];
  const workflow: Workflow = {
    name: 'r',
    steps: [
      agent({ id: 'notes', enabled: false }),
      {
        kind: 'loop', id: 'fix', until: 'review', max_iterations: 1, on_exhausted: 'interactive',
        steps: [
          agent({ id: 'execute', writes: true }),
          agent({ id: 'review', verdict: true, inputs: ['notes'] }),
        ],
      },
    ],
  };
  const frontend: Frontend = {
    runInteractive: async spec => { interactivePrompts.push(spec.argv.join(' ')); return 0; },
    onEvent: e => h.events.push(e),
  };
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => { await writeFile(spec.argv[3], 'VERDICT: FAIL\nno good'); return 0; },
  });
  assert.equal(result.ok, false, 'the loop still exhausts; only the crash is fixed');
  assert.equal(interactivePrompts.length, 1, 'the triage handoff happened instead of throwing');
  assert.ok(!interactivePrompts[0].includes('notes.md'), 'the stripped reference never reaches the prompt');
});

// ---------------------------------------------------------------------------
// Command steps
// ---------------------------------------------------------------------------

test('a command step really runs, captures its output, and its exit code is the verdict', async () => {
  const dir = await tmpWorkdir();
  const h = harness();

  const result = await runWorkflow({
    workflow: {
      name: 'cmd',
      steps: [{ kind: 'command', id: 'hello', run: 'echo hi there; echo oops >&2', output: 'hello.log' }],
    },
    workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend: h.frontend,
    spawnHeadless: async spec => {
      // Stand in for a real frontend: run it and honour spec.capture.
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { appendFile } = await import('node:fs/promises');
      const run = promisify(execFile);
      const { stdout, stderr } = await run(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd });
      if (spec.capture) await appendFile(spec.capture.path, stdout + stderr);
      return 0;
    },
  });

  assert.equal(result.ok, true);
  const log = await readFile(result.artifacts['hello'], 'utf8');
  assert.ok(log.includes('$ echo hi there'), 'the artifact says which command produced it');
  assert.ok(log.includes('hi there'));
  assert.ok(log.includes('exit code: 0'));
});

test('a failing command without verdict stops the run; with verdict it is only a signal', async () => {
  const dir = await tmpWorkdir();
  const hard = await runWorkflow({
    workflow: { name: 'c', steps: [{ kind: 'command', id: 'x', run: 'exit 1', output: 'x.log' }] },
    workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(),
    frontend: harness().frontend, spawnHeadless: async () => 1,
  });
  assert.equal(hard.ok, false);

  const h = harness();
  const soft = await runWorkflow({
    workflow: {
      name: 'c',
      steps: [{ kind: 'command', id: 'x', run: 'exit 1', verdict: true, output: 'x.log' }],
    },
    workdir: await tmpWorkdir(), inputs: {}, config: DEFAULT_CONFIG, registry: registry(),
    frontend: h.frontend, spawnHeadless: async () => 1,
  });
  assert.equal(soft.verdict, 'fail');
  assert.ok(h.events.some(e => e.type === 'step:verdict' && e.verdict === 'fail'));
});

test('expect_exit widens what counts as success', async () => {
  const h = harness();
  const result = await runWorkflow({
    workflow: {
      name: 'c',
      steps: [{ kind: 'command', id: 'x', run: 'exit 1', expect_exit: [0, 1], output: 'x.log' }],
    },
    workdir: await tmpWorkdir(), inputs: {}, config: DEFAULT_CONFIG, registry: registry(),
    frontend: h.frontend, spawnHeadless: async () => 1,
  });
  assert.equal(result.ok, true);
});

test('a command step needs no runner and is skipped by the runner capability gate', async () => {
  // An empty registry would reject any agent step; a command-only workflow runs.
  const result = await runWorkflow({
    workflow: { name: 'c', steps: [{ kind: 'command', id: 'x', run: 'exit 0', output: 'x.log' }] },
    workdir: await tmpWorkdir(), inputs: {}, config: DEFAULT_CONFIG,
    registry: new AdapterRegistry(), frontend: harness().frontend, spawnHeadless: async () => 0,
  });
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Manual and approval steps
// ---------------------------------------------------------------------------

const manualWorkflow = (over: Record<string, unknown> = {}): Workflow => ({
  name: 'm',
  steps: [{
    kind: 'manual', id: 'check', title: 'Look at it', instructions: 'Have a look.', ...over,
  } as Workflow['steps'][number]],
});

test('a manual step asks the frontend and continues on continue', async () => {
  const h = harness([{ choice: 'continue' }]);
  const result = await runWorkflow({
    workflow: manualWorkflow(), workdir: await tmpWorkdir(), inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend, spawnHeadless: async () => 0,
  });
  assert.equal(result.ok, true);
  assert.equal(h.asked.length, 1);
  assert.deepEqual(h.asked[0].choices, ['continue', 'abort']);
  assert.ok(h.events.some(e => e.type === 'step:manual'));
  assert.ok(h.events.some(e => e.type === 'step:manual-resolved' && e.choice === 'continue'));
});

test('abort fails the run and names the declined step', async () => {
  const h = harness([{ choice: 'abort' }]);
  const result = await runWorkflow({
    workflow: manualWorkflow(), workdir: await tmpWorkdir(), inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend, spawnHeadless: async () => 0,
  });
  assert.equal(result.ok, false);
  const error = h.events.find(e => e.type === 'run:error');
  assert.ok(error && error.type === 'run:error' && error.message.includes("'check' was declined"));
});

test('capture: note writes what the human typed as the step artifact', async () => {
  const h = harness([{ choice: 'continue', note: 'shipped behind a flag' }]);
  const result = await runWorkflow({
    workflow: manualWorkflow({ capture: 'note', output: 'note.md' }),
    workdir: await tmpWorkdir(), inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend, spawnHeadless: async () => 0,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(h.asked[0].capture, { kind: 'note', label: 'Note', requiredFor: ['continue'], perFile: false });
  assert.ok((await readFile(result.artifacts['check'], 'utf8')).includes('shipped behind a flag'));
});

test('inside a loop a manual step can retry, which is a failed verdict', async () => {
  const h = harness([{ choice: 'retry' }, { choice: 'continue' }]);
  const result = await runWorkflow({
    workflow: {
      name: 'm',
      steps: [{
        kind: 'loop', id: 'gate', until: 'check', max_iterations: 3,
        steps: [{
          kind: 'approval', id: 'check', title: 'Ship it?', instructions: 'Review the diff.',
          verdict: true,
        }],
      }],
    },
    workdir: await tmpWorkdir(), inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend, spawnHeadless: async () => 0,
  });
  assert.equal(result.ok, true);
  assert.equal(h.asked.length, 2, 'retry sends the loop round once more');
  assert.deepEqual(h.asked[0].choices, ['continue', 'retry', 'abort'],
    'retry is only offered where there is a loop to retry');
  assert.equal(h.asked[1].loop?.iteration, 2);
});

test('a workflow with manual steps is rejected up front on a frontend that cannot ask', async () => {
  await assert.rejects(
    runWorkflow({
      workflow: manualWorkflow(), workdir: await tmpWorkdir(), inputs: {}, config: DEFAULT_CONFIG,
      registry: registry(),
      frontend: { runInteractive: async () => 0, onEvent: () => {} },
      spawnHeadless: async () => 0,
    }),
    (e: unknown) => e instanceof Error && e.message.includes('cannot run manual steps'));
});

test('dry-run resolves manual steps to their default without asking anyone', async () => {
  const h = harness();
  const result = await runWorkflow({
    workflow: manualWorkflow({ default: 'continue' }), workdir: await tmpWorkdir(), inputs: {},
    config: DEFAULT_CONFIG, registry: registry(), frontend: h.frontend, dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.equal(h.asked.length, 0);
  assert.ok(h.events.some(e => e.type === 'step:manual'));
});

test('the manual request carries the referenced artifacts, resolved to paths', async () => {
  const h = harness([{ choice: 'continue' }]);
  await runWorkflow({
    workflow: {
      name: 'm',
      steps: [
        agent({ id: 'plan', writes: false }),
        {
          kind: 'approval', id: 'check', title: 'Ship {{ inputs.what }}?',
          instructions: 'Read the plan.', inputs: ['plan'],
        },
      ],
    },
    workdir: await tmpWorkdir(), inputs: { what: 'oauth' }, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend,
    spawnHeadless: async spec => { await writeFile(spec.argv[3], 'the plan\n'); return 0; },
  });
  assert.equal(h.asked[0].title, 'Ship oauth?', 'the title is templated like a prompt');
  assert.equal(h.asked[0].context.artifacts.length, 1);
  assert.equal(h.asked[0].context.artifacts[0].id, 'plan');
});

test('a verdict command that exits non-zero is done with a FAIL, not a failed step', async () => {
  const dir = await tmpWorkdir();
  const h = harness();
  await runWorkflow({
    workflow: {
      name: 'c',
      steps: [{ kind: 'command', id: 'tests', run: 'exit 1', verdict: true, output: 'x.log' }],
    },
    workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(),
    frontend: h.frontend, spawnHeadless: async () => 1,
  });

  const manifest = JSON.parse(
    await readFile(join(dir, '.whiphand', 'runs', ...(await readdir(join(dir, '.whiphand', 'runs'))), 'run.json'), 'utf8'));
  const step = manifest.steps.find((s: { id: string }) => s.id === 'tests');
  assert.equal(step.status, 'done', 'reporting a FAIL is the step working, not the step breaking');
  assert.equal(step.verdict, 'fail');
  assert.equal(step.exitCode, 1, 'the exit code is still recorded');
});

test('a command that runs past its timeout says so, rather than reporting a kill signal', async () => {
  const dir = await tmpWorkdir();
  const h = harness();
  const result = await runWorkflow({
    workflow: {
      name: 'c',
      steps: [{ kind: 'command', id: 'slow', run: 'sleep 30', timeout_ms: 50, output: 'slow.log' }],
    },
    workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(),
    frontend: h.frontend,
    // Stand in for a frontend that honours the abort: wait for it, then report
    // the shell's signal-termination code, exactly as the real ones do.
    spawnHeadless: (spec, signal) => new Promise(resolvePromise => {
      void spec;
      signal?.addEventListener('abort', () => resolvePromise(130), { once: true });
    }),
  });

  assert.equal(result.ok, false);
  const error = h.events.find(e => e.type === 'run:error');
  assert.ok(error && error.type === 'run:error' && error.message.includes('timed out after 50ms'),
    `expected a timeout message, got: ${error && error.type === 'run:error' ? error.message : 'none'}`);
  assert.ok((await readFile(join(dir, '.whiphand', 'runs',
    ...(await readdir(join(dir, '.whiphand', 'runs'))), 'slow.log'), 'utf8')).includes('timed out'));
});

test('cancelling the run is not reported as a step timing out', async () => {
  const dir = await tmpWorkdir();
  const h = harness();
  const controller = new AbortController();
  const result = await runWorkflow({
    workflow: {
      name: 'c',
      steps: [{ kind: 'command', id: 'slow', run: 'sleep 30', timeout_ms: 60_000, output: 'slow.log' }],
    },
    workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(),
    frontend: h.frontend, signal: controller.signal,
    spawnHeadless: (spec, signal) => new Promise(resolvePromise => {
      void spec;
      signal?.addEventListener('abort', () => resolvePromise(130), { once: true });
      setTimeout(() => controller.abort(), 10);
    }),
  });

  assert.equal(result.cancelled, true);
  assert.ok(h.events.some(e => e.type === 'run:cancelled'));
  assert.ok(!h.events.some(e => e.type === 'run:error' && e.message.includes('timed out')));
});
