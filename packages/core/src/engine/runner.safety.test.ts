/**
 * Invariant 7, tier 1, at the two places the plan settled that a step FAILS
 * rather than records: a stage whose write-guard cannot be established, and a
 * prompt file that cannot be written. Both used to surface differently — as a
 * `diff` degradation, and as a rejected `runWorkflow` — and both are pinned here
 * to the surface the spec named: a failed run with a reason, nothing spawned.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runWorkflow } from './runner.ts';
import { parseWorkflow } from '../schema.ts';
import { AdapterRegistry } from '../registry.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import type { AgentStep, Frontend, RunCtx, RunnerAdapter, SpawnSpec, WhiphandEvent } from '../types.ts';

const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd });

const tmpDirs: string[] = [];
after(async () => { await Promise.all(tmpDirs.map(dir => rm(dir, { recursive: true, force: true }))); });

async function repoWithPlans(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-safety-'));
  tmpDirs.push(dir);
  await git(dir, 'init', '-b', 'main');
  await mkdir(join(dir, 'plans'));
  await writeFile(join(dir, 'plans', '01-first.md'), '# First\n');
  await git(dir, 'add', '-A');
  await git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  return dir;
}

/** `git status` now exits 128 — but not with "not a git repository". */
const breakGit = (dir: string) => writeFile(join(dir, '.git', 'index'), 'corrupt');

function fakeRunner(extraFiles?: (ctx: RunCtx) => SpawnSpec['files']): RunnerAdapter {
  const build = (phase: string) => (step: AgentStep, ctx: RunCtx): SpawnSpec => ({
    argv: ['fake', phase, step.id, ctx.artifacts[step.id]],
    cwd: ctx.workdir, env: {}, interactive: false,
    ...(extraFiles === undefined ? {} : { files: extraFiles(ctx) }),
  });
  return {
    id: 'fake',
    doctor: { label: 'fake', argv: ['fake'], optional: true },
    capabilities: { sessionIdInjection: true, sessionIdCapture: false, sessionResume: true, toolDenial: true, shareTranscript: false },
    detect: async () => ({ installed: true }),
    interactive: build('interactive'), headless: build('headless'), harvest: build('harvest'),
  };
}

function harness(runner: RunnerAdapter) {
  const registry = new AdapterRegistry();
  registry.register(runner);
  const events: WhiphandEvent[] = [];
  const spawns: string[] = [];
  const frontend: Frontend = {
    runInteractive: async () => 0,
    runManual: async () => ({ choice: 'continue' }),
    onEvent: e => { events.push(e); },
  };
  const spawnHeadless = async (spec: SpawnSpec): Promise<number> => {
    spawns.push(spec.argv[2]);
    writeFileSync(spec.argv[3], 'VERDICT: PASS\n');
    return 0;
  };
  return { registry, events, spawns, frontend, spawnHeadless };
}

const stagedWorkflow = (writes: boolean, allowPaths = '') => parseWorkflow(`
name: staged
steps:
  - kind: stages
    id: build
    items: "plans/*.md"
    steps:
      - id: work
        runner: fake
        mode: headless
        writes: ${writes}${allowPaths}
        prompt: Do it
        output: work.md
      - kind: approval
        id: accept
        title: Accept?
        instructions: Look.
        output: accept.md
`);

test('a stage whose steps need the write-guard FAILS at entry when git is unavailable — before any step spawns', async () => {
  const dir = await repoWithPlans();
  await breakGit(dir);
  const h = harness(fakeRunner());
  const result = await runWorkflow({
    workflow: stagedWorkflow(false), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: h.registry, frontend: h.frontend, spawnHeadless: h.spawnHeadless,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(h.spawns, [], 'no agent ran in a stage whose read-only promise could not be kept');
  const error = h.events.find(e => e.type === 'run:error');
  assert.ok(error && error.type === 'run:error');
  assert.equal(error.stepId, 'build');
  assert.match(error.message, /stages step 'build' cannot run without its git write-guard, and git is unavailable: git failed \(exit 128\)/);
  assert.equal(h.events.some(e => e.type === 'run:degraded' && e.capability === 'diff'), false, 'not downgraded to a record');
});

test('a stage with an allow_paths step is guarded too', async () => {
  const dir = await repoWithPlans();
  await breakGit(dir);
  const h = harness(fakeRunner());
  const result = await runWorkflow({
    workflow: stagedWorkflow(true, '\n        allow_paths: ["docs/**"]'), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: h.registry, frontend: h.frontend, spawnHeadless: h.spawnHeadless,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(h.spawns, []);
});

test('a stage with no guarded step carries on when git is unavailable, and records the lost "no changes" note as a degradation', async () => {
  const dir = await repoWithPlans();
  await breakGit(dir);
  const h = harness(fakeRunner());
  const result = await runWorkflow({
    workflow: stagedWorkflow(true), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: h.registry, frontend: h.frontend, spawnHeadless: h.spawnHeadless,
  });
  assert.equal(result.ok, true);
  const degraded = h.events.find(e => e.type === 'run:degraded' && e.capability === 'diff');
  assert.ok(degraded && degraded.type === 'run:degraded');
  assert.equal(degraded.stepId, 'build');
});

const oneStep = parseWorkflow(`
name: one
steps:
  - id: look
    runner: fake
    mode: headless
    writes: true
    prompt: look
    output: look.md
`);

test('a prompt file that cannot be written FAILS the step with the file named — runWorkflow resolves, nothing spawns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-promptfile-'));
  tmpDirs.push(dir);
  // A regular file where the adapter's file needs a directory: the write cannot succeed.
  const h = harness(fakeRunner(ctx => {
    const blocker = join(ctx.runDir, 'blocked');
    mkdirSync(dirname(blocker), { recursive: true });
    writeFileSync(blocker, 'in the way');
    return [{ path: join(blocker, 'prompt'), content: 'do it\n' }];
  }));
  const result = await runWorkflow({
    workflow: oneStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: h.registry, frontend: h.frontend, spawnHeadless: h.spawnHeadless,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(h.spawns, []);
  const error = h.events.find(e => e.type === 'run:error');
  assert.ok(error && error.type === 'run:error');
  assert.equal(error.stepId, 'look');
  assert.match(error.message, /could not write .*blocked.*prompt, which the runner needs to start/);
  const last = h.events.at(-1);
  assert.deepEqual(last, { type: 'run:done', runId: result.runId, ok: false }, 'a normal failed run: run:error, then run:done');
});

test('a degradation the caller opened the workspace with is recorded on the run — workspace identity fell back to its lexical form', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-identity-'));
  tmpDirs.push(dir);
  const h = harness(fakeRunner());
  const reason = 'could not canonicalize /x (EACCES); comparing it by its lexical form';
  const result = await runWorkflow({
    workflow: oneStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, dryRun: true,
    degradations: [{ capability: 'workspace-identity', reason }],
    registry: h.registry, frontend: h.frontend, spawnHeadless: h.spawnHeadless,
  });
  assert.equal(result.ok, true);
  assert.ok(h.events.some(e => e.type === 'run:degraded' && e.capability === 'workspace-identity' && e.reason === reason));
});

// ---------------------------------------------------------------------------
// HEAD guard: an agent step that moves HEAD fails unless it opted in.
// ---------------------------------------------------------------------------

/** What an agent that commits does: writes a file and commits just that file, so the tree is clean again. */
async function commitFile(dir: string, name: string): Promise<void> {
  await writeFile(join(dir, name), 'made by a step\n');
  await git(dir, 'add', name);
  await git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-m', name);
}

/**
 * The fake runner's headless spawns (and, via `runInteractive`, its interactive
 * session) commit a file when `commits` says so; a command step's spawn — no
 * `fake` argv — always does, since a command step is the workflow committing.
 */
function committingHarness(dir: string, commits: (stepId: string) => boolean) {
  const h = harness(fakeRunner());
  const spawnHeadless = async (spec: SpawnSpec): Promise<number> => {
    if (spec.argv[0] !== 'fake') { await commitFile(dir, 'from-command.txt'); return 0; }
    if (spec.argv[1] === 'headless' && commits(spec.argv[2])) await commitFile(dir, `${spec.argv[2]}.txt`);
    return h.spawnHeadless(spec);
  };
  const frontend: Frontend = {
    ...h.frontend,
    runInteractive: async spec => {
      if (commits(spec.argv[2])) await commitFile(dir, `${spec.argv[2]}.txt`);
      return 0;
    },
  };
  return { ...h, spawnHeadless, frontend };
}

const agentWorkflow = (extra = '', mode = 'headless') => parseWorkflow(`
name: head-guard
steps:
  - id: work
    runner: fake
    mode: ${mode}
    writes: true${extra}
    prompt: Do it
    output: work.md
`);

const runIn = (dir: string, workflow: ReturnType<typeof parseWorkflow>, h: ReturnType<typeof committingHarness>) =>
  runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: h.registry, frontend: h.frontend, spawnHeadless: h.spawnHeadless,
  });

const errorOf = (h: { events: WhiphandEvent[] }) => {
  const error = h.events.find(e => e.type === 'run:error');
  assert.ok(error && error.type === 'run:error', 'the run recorded a run:error');
  return error;
};

test('an agent step that commits FAILS, naming the step, both commits and the way out', async () => {
  const dir = await repoWithPlans();
  const before = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
  const h = committingHarness(dir, () => true);
  const result = await runIn(dir, agentWorkflow(), h);
  const after = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
  assert.notEqual(after, before, 'the fake agent really did commit');
  assert.equal(result.ok, false);
  const error = errorOf(h);
  assert.equal(error.stepId, 'work');
  assert.ok(error.message.includes(`step 'work' moved HEAD from ${before.slice(0, 12)} to ${after.slice(0, 12)}`), error.message);
  assert.match(error.message, /the workflow commits/);
  assert.match(error.message, /set `allow_commits: true` on the step/);
});

test('a read-only step that commits fails too — its clean tree afterwards is exactly what hid the commit', async () => {
  const dir = await repoWithPlans();
  const h = committingHarness(dir, () => true);
  const result = await runIn(dir, parseWorkflow(`
name: read-only
steps:
  - id: look
    runner: fake
    mode: headless
    writes: false
    prompt: Look
    output: look.md
`), h);
  assert.equal(result.ok, false);
  assert.match(errorOf(h).message, /step 'look' moved HEAD from/);
});

test('an interactive step that commits fails after the session, at the same place the tree guard looks', async () => {
  const dir = await repoWithPlans();
  const h = committingHarness(dir, () => true);
  const result = await runIn(dir, agentWorkflow('', 'interactive'), h);
  assert.equal(result.ok, false);
  assert.match(errorOf(h).message, /step 'work' moved HEAD from/);
});

test('allow_commits: true lets the step commit', async () => {
  const dir = await repoWithPlans();
  const h = committingHarness(dir, () => true);
  const result = await runIn(dir, agentWorkflow('\n    allow_commits: true'), h);
  assert.equal(result.ok, true, JSON.stringify(h.events.find(e => e.type === 'run:error')));
  assert.equal(h.events.some(e => e.type === 'run:degraded'), false);
});

test('an agent step that does not commit is unaffected', async () => {
  const dir = await repoWithPlans();
  const h = committingHarness(dir, () => false);
  const result = await runIn(dir, agentWorkflow(), h);
  assert.equal(result.ok, true);
});

test('a command step that commits still passes — the workflow is allowed to commit', async () => {
  const dir = await repoWithPlans();
  const before = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
  const h = committingHarness(dir, () => false);
  const result = await runIn(dir, parseWorkflow(`
name: commit-step
steps:
  - kind: command
    id: commit
    run: exit 0
`), h);
  assert.equal(result.ok, true, JSON.stringify(h.events.find(e => e.type === 'run:error')));
  assert.notEqual((await git(dir, 'rev-parse', 'HEAD')).stdout.trim(), before, 'the command step really did commit');
});

test('the first commit into a repository with no commits yet is seen too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-unborn-'));
  tmpDirs.push(dir);
  await git(dir, 'init', '-b', 'main');
  const h = committingHarness(dir, () => true);
  const result = await runIn(dir, agentWorkflow(), h);
  assert.equal(result.ok, false);
  assert.match(errorOf(h).message, /step 'work' moved HEAD from \(no commits\) to [0-9a-f]{12};/);
});

test('a workspace that is not a repository is unaffected, and the HEAD guard says nothing about it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-nogit-'));
  tmpDirs.push(dir);
  const h = harness(fakeRunner());
  const result = await runWorkflow({
    workflow: agentWorkflow(), workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: h.registry, frontend: h.frontend, spawnHeadless: h.spawnHeadless,
  });
  assert.equal(result.ok, true);
  assert.equal(h.events.some(e => e.type === 'run:degraded'), false, 'a writes: true step in a plain folder raises nothing');
  assert.equal(h.events.some(e => e.type === 'guard:warning'), false);
});

test('each step is compared against HEAD as it began: a second step that does not commit passes after a first that was allowed to', async () => {
  const dir = await repoWithPlans();
  const h = committingHarness(dir, id => id === 'first');
  const result = await runIn(dir, parseWorkflow(`
name: two
steps:
  - id: first
    runner: fake
    mode: headless
    writes: true
    allow_commits: true
    prompt: one
    output: first.md
  - id: second
    runner: fake
    mode: headless
    writes: true
    prompt: two
    output: second.md
`), h);
  assert.equal(result.ok, true, JSON.stringify(h.events.find(e => e.type === 'run:error')));
});
