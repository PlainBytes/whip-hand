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
import { planResume } from './resume.ts';
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
    doctor: { label: 'fake', argv: ['fake'], optional: true },
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

// ---------------------------------------------------------------------------
// Resuming an exhausted loop
// ---------------------------------------------------------------------------

test('a run whose loop exhausted resumes to run exactly the next iteration', async () => {
  const dir = await tmpWorkdir();
  let attempts = 0;
  const spawnHeadless = async (spec: SpawnSpec): Promise<number> => {
    if (spec.argv[0] === 'fake') {
      attempts += 1;
      await writeFile(spec.argv[3], `attempt ${attempts}\n`);
      return 0;
    }
    // The 'tests' command step: pass only once the fourth attempt has run.
    return attempts > 3 ? 0 : 1;
  };

  const broken = await runWorkflow({
    workflow: flakyCommandWorkflow(3, 3), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: harness().frontend, spawnHeadless,
  });
  assert.equal(broken.ok, false, 'the loop exhausts at 3 iterations');
  assert.equal(attempts, 3);

  const plan = await planResume(dir, DEFAULT_CONFIG, broken.runId);
  assert.deepEqual(plan.loopBudgets.fix, { budget: 4, completed: 3 }, 'the default +1');

  const resumed = harness();
  const result = await runWorkflow({
    workflow: flakyCommandWorkflow(3, 3), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: resumed.frontend, resume: plan, spawnHeadless,
  });

  assert.equal(result.ok, true, 'the granted iteration 4 passes');
  assert.equal(attempts, 4, 'only iteration 4 spawns anything new');
  const skipped = resumed.events.filter(e => e.type === 'step:skipped');
  assert.equal(skipped.length, 6, 'both body steps of iterations 1-3 are skipped, not re-run');
  assert.ok(resumed.events.some(e => e.type === 'loop:iteration' && e.iteration === 4));
});

test('opts.maxIterations still beats a grant', async () => {
  const dir = await tmpWorkdir();
  const spawnHeadless = async (spec: SpawnSpec): Promise<number> => {
    if (spec.argv[0] === 'fake') { await writeFile(spec.argv[3], 'work\n'); return 0; }
    return 1;
  };

  const broken = await runWorkflow({
    workflow: flakyCommandWorkflow(99, 3), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: harness().frontend, spawnHeadless,
  });
  assert.equal(broken.ok, false);

  const plan = await planResume(dir, DEFAULT_CONFIG, broken.runId);
  const resumed = harness();
  await runWorkflow({
    workflow: flakyCommandWorkflow(99, 3), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: resumed.frontend, resume: plan, maxIterations: 7, spawnHeadless,
  });

  const start = resumed.events.find(e => e.type === 'loop:start');
  assert.ok(start && start.type === 'loop:start' && start.maxIterations === 7,
    'the absolute override wins over the default +1 grant');
});

test('an absolute override at or below what already ran warns and fails without spawning', async () => {
  const dir = await tmpWorkdir();
  const spawnHeadless = async (spec: SpawnSpec): Promise<number> => {
    if (spec.argv[0] === 'fake') { await writeFile(spec.argv[3], 'work\n'); return 0; }
    return 1;
  };

  const broken = await runWorkflow({
    workflow: flakyCommandWorkflow(99, 3), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: harness().frontend, spawnHeadless,
  });
  assert.equal(broken.ok, false);

  const plan = await planResume(dir, DEFAULT_CONFIG, broken.runId);
  const resumed = harness();
  let spawned = false;
  const result = await runWorkflow({
    workflow: flakyCommandWorkflow(99, 3), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: resumed.frontend, resume: plan, maxIterations: 3,
    spawnHeadless: async spec => { spawned = true; return spawnHeadless(spec); },
  });

  assert.equal(result.ok, false);
  assert.equal(spawned, false, 'nothing new spawns: every iteration within the override is already recorded');
  const warning = resumed.events.find(e => e.type === 'guard:warning');
  assert.ok(warning && warning.type === 'guard:warning'
    && warning.message.includes("loop 'fix'") && warning.message.includes('already completed 3')
    && warning.message.includes('allows only 3'));
});

test('a loop that already passed is untouched by a resume that grants elsewhere', async () => {
  const dir = await tmpWorkdir();
  const workflow: Workflow = {
    name: 'two-loops',
    steps: [
      {
        kind: 'loop', id: 'good', until: 'checkGood', max_iterations: 3,
        steps: [agent({ id: 'executeGood', writes: true }), {
          kind: 'command', id: 'checkGood', verdict: true, output: 'checkGood.log', run: 'exit 0',
        }],
      },
      {
        kind: 'loop', id: 'bad', until: 'checkBad', max_iterations: 2,
        steps: [agent({ id: 'executeBad', writes: true }), {
          kind: 'command', id: 'checkBad', verdict: true, output: 'checkBad.log', run: 'exit 1',
        }],
      },
    ],
  };
  let goodSpawns = 0;
  const spawnHeadless = async (spec: SpawnSpec): Promise<number> => {
    if (spec.argv[0] === 'fake') {
      if (spec.argv[2] === 'executeGood') goodSpawns += 1;
      await writeFile(spec.argv[3], 'work\n');
      return 0;
    }
    // command steps: 'good' passes immediately, 'bad' never does.
    return spec.env.WHIPHAND_STEP_ID === 'checkGood' ? 0 : 1;
  };

  const broken = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: harness().frontend, spawnHeadless,
  });
  assert.equal(broken.ok, false, 'the bad loop exhausts');
  assert.equal(goodSpawns, 1, 'the good loop passed on its first iteration');

  const plan = await planResume(dir, DEFAULT_CONFIG, broken.runId);
  assert.equal(plan.loopBudgets.good, undefined, 'a passed loop gets no budget entry');
  assert.deepEqual(plan.loopBudgets.bad, { budget: 3, completed: 2 });

  const resumed = harness();
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: resumed.frontend, resume: plan,
    spawnHeadless: async spec => {
      if (spec.argv[0] === 'fake') {
        if (spec.argv[2] === 'executeGood') goodSpawns += 1;
        await writeFile(spec.argv[3], 'work\n');
        return 0;
      }
      // 'bad' passes now that it has been granted a third iteration.
      return 0;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(goodSpawns, 1, 'the good loop spawns nothing new on resume — it just replays its pass');
  assert.ok(!resumed.events.some(e => e.type === 'step:spawn' && e.stepId === 'executeGood'));
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
// Nested loops
// ---------------------------------------------------------------------------

test('a loop nested inside another gets its own artifacts and manifest row per outer round', async () => {
  const dir = await tmpWorkdir();
  const answers: ManualResponse[] = [
    { choice: 'retry', note: 'please fix X' },
    { choice: 'continue' },
  ];
  const h = harness(answers);
  const sawSignOff: Record<string, boolean[]> = { execute: [], review: [] };

  const workflow: Workflow = {
    name: 'nested',
    steps: [{
      kind: 'loop', id: 'human-review', until: 'sign-off', max_iterations: 3,
      steps: [
        {
          kind: 'loop', id: 'fix-cycle', until: 'review', max_iterations: 3,
          steps: [
            agent({ id: 'execute', writes: true, inputs: ['review', 'sign-off'] }),
            agent({ id: 'review', verdict: true, inputs: ['execute', 'sign-off'] }),
          ],
        },
        {
          kind: 'approval', id: 'sign-off', verdict: true, title: 'Ship it?',
          instructions: 'Look at it.', capture: 'review', inputs: ['review'], output: 'feedback.md',
        },
      ],
    }],
  };

  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend: h.frontend,
    spawnHeadless: async spec => {
      const stepId = spec.argv[2];
      const prompt = spec.argv[4];
      if (stepId === 'execute') {
        sawSignOff.execute.push(prompt.includes('- sign-off:'));
        await writeFile(spec.argv[3], 'implemented\n');
      } else {
        sawSignOff.review.push(prompt.includes('- sign-off:'));
        await writeFile(spec.argv[3], 'VERDICT: PASS\n');
      }
      return 0;
    },
  });

  assert.equal(result.ok, true, 'round 2 approves sign-off, which exits both loops');
  assert.deepEqual(sawSignOff.execute, [false, true],
    'round 1 has no sign-off feedback yet; round 2 sees round 1\'s');
  assert.deepEqual(sawSignOff.review, [false, true]);

  const round1Execute = join(result.runDir, 'human-review', 'iter-1', 'fix-cycle', 'iter-1', 'execute.md');
  const round2Execute = join(result.runDir, 'human-review', 'iter-2', 'fix-cycle', 'iter-1', 'execute.md');
  assert.ok(existsSync(round1Execute), 'round 1 kept its own artifact rather than being overwritten');
  assert.ok(existsSync(round2Execute), 'round 2 wrote to its own nested directory');

  const round1Feedback = join(result.runDir, 'human-review', 'iter-1', 'feedback.md');
  assert.ok((await readFile(round1Feedback, 'utf8')).includes('please fix X'));

  const manifest: RunManifest = JSON.parse(await readFile(join(result.runDir, 'run.json'), 'utf8'));
  const executeRows = manifest.steps.filter(s => s.id === 'execute');
  assert.equal(executeRows.length, 2, 'each round gets its own execute row, not one overwritten in place');
  assert.ok(executeRows.every(r => r.status === 'done'));
  assert.deepEqual(executeRows.map(r => r.outerLoops), [
    [{ id: 'human-review', iteration: 1 }],
    [{ id: 'human-review', iteration: 2 }],
  ], 'each execute row remembers which human-review round its fix-cycle ran under');

  const fixCycleRows = manifest.steps.filter(s => s.id === 'fix-cycle');
  assert.equal(fixCycleRows.length, 2, 'each round gets its own fix-cycle row, not the previous round\'s');
  assert.deepEqual(fixCycleRows.map(r => r.iteration), [1, 2], 'a fix-cycle row is identified by its human-review round');
  assert.ok(fixCycleRows.every(r => r.outerLoops === undefined),
    'fix-cycle has nothing beyond human-review, which is itself top-level');

  const humanReviewRows = manifest.steps.filter(s => s.id === 'human-review');
  assert.equal(humanReviewRows.length, 1, 'the outer loop itself is a single row, same as any top-level loop');
});

test('resuming mid round 2 of a nested loop skips round 1 and only replays round 2\'s unfinished work', async () => {
  const dir = await tmpWorkdir();
  let executeAttempts = 0;
  const workflow: Workflow = {
    name: 'nested',
    steps: [{
      kind: 'loop', id: 'human-review', until: 'sign-off', max_iterations: 3,
      steps: [
        {
          kind: 'loop', id: 'fix-cycle', until: 'review', max_iterations: 3,
          steps: [
            agent({ id: 'execute', writes: true, inputs: ['review', 'sign-off'] }),
            agent({ id: 'review', verdict: true, inputs: ['execute', 'sign-off'] }),
          ],
        },
        {
          kind: 'approval', id: 'sign-off', verdict: true, title: 'Ship it?',
          instructions: 'Look at it.', capture: 'review', inputs: ['review'], output: 'feedback.md',
        },
      ],
    }],
  };
  const spawnHeadless = async (spec: SpawnSpec): Promise<number> => {
    const stepId = spec.argv[2];
    if (stepId === 'execute') {
      executeAttempts += 1;
      await writeFile(spec.argv[3], `attempt ${executeAttempts}\n`);
    } else {
      await writeFile(spec.argv[3], 'VERDICT: PASS\n');
    }
    return 0;
  };

  // Round 1 approves nothing — it requests changes — then round 2's review
  // is the one left broken (the frontend crashes before it can decide), so
  // the run is interrupted mid round 2 rather than finishing cleanly.
  let calls = 0;
  const broken = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend: {
      runInteractive: async () => 0,
      runManual: async () => {
        calls += 1;
        if (calls === 1) return { choice: 'retry', note: 'please fix X' };
        throw new Error('the human went away');
      },
      onEvent: () => {},
    }, spawnHeadless,
  });
  assert.equal(broken.ok, false);
  assert.equal(executeAttempts, 2, 'round 1 and round 2 each ran fix-cycle once before the crash');

  const plan = await planResume(dir, DEFAULT_CONFIG, broken.runId);
  const resumed = harness([{ choice: 'continue' }]);
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend: resumed.frontend,
    resume: plan, spawnHeadless,
  });

  assert.equal(result.ok, true);
  assert.equal(executeAttempts, 2, 'round 2\'s already-passed fix-cycle is skipped, not re-run');
  const skipped = resumed.events.filter(e => e.type === 'step:skipped');
  // Round 1's execute+review+sign-off, plus round 2's own execute+review: five
  // skips, none of them round 1's work mistaken for round 2's or vice versa —
  // only round 2's sign-off (the one that never got an answer) is asked again.
  assert.equal(skipped.length, 5);
  assert.ok(resumed.events.some(e => e.type === 'step:manual'), 'round 2\'s sign-off is what actually resumes');
});

// ---------------------------------------------------------------------------
// A `test-fix`-shaped loop nested inside another loop: forward references
// into the inner loop must resolve against *its own* first iteration, not
// whatever the outer loop's previous round left lying around in ctx.artifacts.
// ---------------------------------------------------------------------------

/** `fix-cycle` (until: review) wrapping `test-fix` (until: tests) — the shape `.whiphand/workflows/*.yaml` ship. */
function nestedTestFixWorkflow(): Workflow {
  return {
    name: 'nested-test-fix',
    steps: [{
      kind: 'loop', id: 'fix-cycle', until: 'review', max_iterations: 3,
      steps: [
        {
          kind: 'loop', id: 'test-fix', until: 'tests', max_iterations: 3,
          steps: [
            agent({ id: 'execute', writes: true, inputs: ['tests', 'review'] }),
            { kind: 'command', id: 'tests', verdict: true, output: 'tests.log', run: 'true' },
          ],
        },
        agent({ id: 'review', verdict: true, inputs: ['execute', 'tests'] }),
      ],
    }],
  };
}

test('a forward ref into a nested loop drops on that loop\'s own first iteration, even on the outer loop\'s later rounds', async () => {
  const dir = await tmpWorkdir();
  const h = harness();
  let executeAttempts = 0;
  let testsAttempts = 0;
  let reviewAttempts = 0;
  const executePrompts: string[] = [];
  const reviewPrompts: string[] = [];

  const result = await runWorkflow({
    workflow: nestedTestFixWorkflow(), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend: h.frontend,
    spawnHeadless: async spec => {
      if (spec.argv[0] === 'fake') {
        const stepId = spec.argv[2];
        if (stepId === 'execute') {
          executeAttempts += 1;
          executePrompts.push(spec.argv[4]);
          await writeFile(spec.argv[3], `attempt ${executeAttempts}\n`);
        } else {
          reviewAttempts += 1;
          reviewPrompts.push(spec.argv[4]);
          await writeFile(spec.argv[3], reviewAttempts > 1 ? 'VERDICT: PASS\n' : 'VERDICT: FAIL\nfix it\n');
        }
        return 0;
      }
      // The 'tests' command step: passes round 1 straight away, fails round
      // 2's first attempt (so test-fix has to go round again), then passes.
      testsAttempts += 1;
      return testsAttempts === 2 ? 1 : 0;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(executeAttempts, 3, 'round 1, round 2 iter 1, round 2 iter 2');
  assert.equal(testsAttempts, 3);
  assert.equal(reviewAttempts, 2, 'round 1 requests changes; round 2 approves');

  // Round 1 (fix-cycle iteration 1): test-fix's own first iteration — no
  // previous tests run, and fix-cycle's own first iteration has no review yet.
  assert.ok(!executePrompts[0].includes('- tests:'), 'round 1 has no previous tests run');
  assert.ok(!executePrompts[0].includes('- review:'), 'round 1 has no previous review either');

  // Round 2 (fix-cycle iteration 2), test-fix iteration 1: the bug this fixes.
  // ctx.artifacts.tests still holds round 1's PASSING log, but test-fix is on
  // its own first iteration, so the reference must still be dropped.
  assert.ok(!executePrompts[1].includes('- tests:'),
    'test-fix\'s first iteration of round 2 must not see round 1\'s stale tests.log');
  // review belongs to the *outer* loop, which is on iteration 2 — its
  // previous round's feedback is exactly what a forward ref should resolve to.
  assert.ok(executePrompts[1].includes('- review:'), 'round 2 sees round 1\'s review feedback');

  // Round 2, test-fix iteration 2: now the reference resolves, to that same
  // loop's own iteration 1 result — which failed.
  assert.ok(executePrompts[2].includes('- tests:'), 'test-fix\'s iteration 2 sees its own iteration 1 result');
  assert.ok(executePrompts[2].includes('(VERDICT: FAIL)'), 'that result failed');

  // review reads tests too — a backward ref, resolved once test-fix has
  // actually passed within this same round.
  assert.ok(reviewPrompts[1].includes('- tests:') && reviewPrompts[1].includes('(VERDICT: PASS)'),
    'round 2\'s review sees test-fix\'s passing result');
});

test('a forward ref to a step skipped after `until` stays dropped on iteration 2, not just iteration 1', async () => {
  const dir = await tmpWorkdir();
  const h = harness();
  let attempts = 0;
  const executePrompts: string[] = [];

  const workflow: Workflow = {
    name: 'cycle',
    steps: [{
      kind: 'loop', id: 'fix', until: 'tests', max_iterations: 2,
      steps: [
        agent({ id: 'execute', writes: true, inputs: ['notes'] }),
        { kind: 'command', id: 'tests', verdict: true, output: 'tests.log', run: 'true' },
        // Both a failing and a passing 'tests' end the round right there —
        // fails abandon the rest of the body, passes exit the loop — so this
        // step never runs, on iteration 1 or any later one.
        agent({ id: 'notes' }),
      ],
    }],
  };

  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend: h.frontend,
    spawnHeadless: async spec => {
      if (spec.argv[0] === 'fake') {
        if (spec.argv[2] === 'execute') {
          attempts += 1;
          executePrompts.push(spec.argv[4]);
        }
        await writeFile(spec.argv[3], `attempt ${attempts}\n`);
        return 0;
      }
      return attempts > 1 ? 0 : 1; // 'tests': fails iteration 1, passes iteration 2
    },
  });

  assert.equal(result.ok, true, 'the loop should exit once tests pass');
  assert.equal(attempts, 2);
  assert.ok(!executePrompts[0].includes('- notes:'), 'iteration 1 has no notes run yet');
  assert.ok(!executePrompts[1].includes('- notes:'),
    'notes never ran on iteration 1 either, so the ref must stay dropped on iteration 2 too');
});

test('resuming mid round 2 of a nested test-fix loop resolves forward references the same way', async () => {
  const dir = await tmpWorkdir();
  const h = harness();
  const controller = new AbortController();
  let executeAttempts = 0;
  let testsAttempts = 0;
  let reviewAttempts = 0;
  const executePrompts: string[] = [];
  const reviewPrompts: string[] = [];

  const spawnHeadless = async (spec: SpawnSpec): Promise<number> => {
    if (spec.argv[0] === 'fake') {
      const stepId = spec.argv[2];
      if (stepId === 'execute') {
        executeAttempts += 1;
        executePrompts.push(spec.argv[4]);
        await writeFile(spec.argv[3], `attempt ${executeAttempts}\n`);
      } else {
        reviewAttempts += 1;
        reviewPrompts.push(spec.argv[4]);
        await writeFile(spec.argv[3], reviewAttempts > 1 ? 'VERDICT: PASS\n' : 'VERDICT: FAIL\nfix it\n');
      }
      return 0;
    }
    testsAttempts += 1;
    // Round 1 passes. Round 2's first attempt is interrupted before it can
    // record a verdict — the run stops there, mid test-fix, mid round 2.
    if (testsAttempts === 2) { controller.abort(); return 1; }
    // Replayed after resume: round 2's first real attempt now fails outright
    // (forcing a genuine second test-fix iteration), then the second passes.
    return testsAttempts === 3 ? 1 : 0;
  };

  const broken = await runWorkflow({
    workflow: nestedTestFixWorkflow(), workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(),
    frontend: h.frontend, signal: controller.signal, spawnHeadless,
  });
  assert.equal(broken.cancelled, true);
  assert.equal(executeAttempts, 2, 'round 1 and round 2 iteration 1 ran before the interruption');
  assert.equal(reviewAttempts, 1, 'only round 1\'s review (a FAIL) ran so far');

  const plan = await planResume(dir, DEFAULT_CONFIG, broken.runId);
  const resumed = harness();
  const result = await runWorkflow({
    workflow: nestedTestFixWorkflow(), workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(),
    frontend: resumed.frontend, resume: plan, spawnHeadless,
  });

  assert.equal(result.ok, true);
  // Round 2 iteration 1's execute is skipped (already done); test-fix then
  // fails again for real, iterates, and round 2 iteration 2's execute is a
  // genuinely fresh spawn — the one whose prompt this test cares about.
  assert.equal(executeAttempts, 3);
  assert.equal(reviewAttempts, 2);

  assert.ok(executePrompts[2].includes('- tests:') && executePrompts[2].includes('(VERDICT: FAIL)'),
    'after resume, test-fix\'s iteration 2 still sees its own iteration 1\'s failing result, not something stale');
  assert.ok(reviewPrompts[1].includes('- tests:') && reviewPrompts[1].includes('(VERDICT: PASS)'),
    'after resume, round 2\'s review still sees test-fix\'s eventual pass');
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

test('dry-run still registers a manual step\'s output path, so a later step referencing it does not crash', async () => {
  const h = harness();
  const result = await runWorkflow({
    workflow: {
      name: 'm',
      steps: [
        manualWorkflow({ default: 'continue', capture: 'review', output: 'feedback.md' }).steps[0],
        agent({ id: 'after', inputs: ['check'] }),
      ],
    },
    workdir: await tmpWorkdir(), inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend: h.frontend,
    dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.ok(result.artifacts['check']?.endsWith('feedback.md'));
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
