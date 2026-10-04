/**
 * The run-store suites of the core parity corpus (Phase 2a of
 * docs/migration.md), generated like the rest of core-corpus.ts:
 *
 * - `store-runs`: every reader over the fixture run directories in
 *   `parity/fixtures/core/runs/` — one per manifest version, plus stale,
 *   fenced, corrupt, locked, named and bookkeeping-heavy runs.
 * - `store-journal`: event scripts played through a journal, covering every
 *   event type the journal folds, loops nested and appended mid-list, stages,
 *   a failure and two resumes, the run.log cap, a dry run, renames and locks.
 */
import { readdirSync } from 'node:fs';
import { RUN_FIXTURES } from './store-probe.ts';

type Op = Record<string, unknown> & { op: string };
type Ev = Record<string, unknown>;
type Entry = Record<string, unknown>;

function fixtureNames(): string[] {
  return readdirSync(RUN_FIXTURES, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name).sort();
}

export function storeRunsOps(): Op[] {
  const all = fixtureNames();
  const ops: Op[] = [{ op: 'runs', call: 'list', fixtures: all }];
  for (const name of all) ops.push({ op: 'runs', call: 'get', fixtures: [name], runId: name });
  const one = (call: string, fixture: string, extra: Record<string, unknown>): Op =>
    ({ op: 'runs', call, fixtures: [fixture], ...extra });
  const v1 = '20240101-000001-v1';
  ops.push(
    one('get', v1, { runId: 'missing' }),
    one('get', v1, { runId: '..' }),
    one('get', v1, { runId: 'a/b' }),
    one('rename', v1, { runId: v1, name: '  New\tname \u0001 ' }),
    one('rename', v1, { runId: v1, name: '' }),
    one('rename', v1, { runId: v1, name: null }),
    one('rename', v1, { runId: v1, name: 'x'.repeat(100) }),
    one('rename', v1, { runId: v1, name: '😀'.repeat(50) }),
    one('rename', v1, { runId: 'nope', name: 'x' }),
    one('rename', v1, { runId: '..', name: 'x' }),
    one('rename', '20240101-000013-no-manifest', { runId: '20240101-000013-no-manifest', name: 'named' }),
  );
  for (const name of all) ops.push(one('delete', name, { runId: name }));
  ops.push(one('delete', v1, { runId: 'missing' }));
  for (const max of [null, 0, 1, 3, 6, 100]) ops.push({ op: 'runs', call: 'prune', fixtures: all, max });
  return ops;
}

/** `readRunLog` over small files, so the tail window's expansion and partial-line edges are all hit. */
export function storeRunLogOps(): Op[] {
  const numbered = (n: number, width = 0) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}${'x'.repeat(width)}\n`).join('');
  const big = numbered(600, 40);
  const ops: Op[] = [];
  const add = (file: Record<string, unknown>, ...reads: Array<Record<string, unknown>>) => {
    for (const r of reads) ops.push({ op: 'runLog', ...file, ...r });
  };
  add({},
    { limit: 10 }, { limit: 10, fromEnd: true }, { limit: 10, beforeByte: 0 }, { limit: 10, beforeByte: 50 });
  add({ content: '' }, { limit: 10 }, { limit: 10, fromEnd: true });
  add({ content: numbered(10) },
    { limit: 4 }, { limit: 4, offset: 8 }, { limit: 4, offset: 10 }, { limit: 4, offset: 99 },
    { limit: 3, fromEnd: true }, { limit: 50, fromEnd: true }, { limit: 3, beforeByte: 21 },
    { limit: 3, beforeByte: 23 }, { limit: 3, beforeByte: 500 }, { limit: 0 }, { limit: 0, fromEnd: true });
  add({ content: 'a\n\n\nb\nlast without newline' },
    { limit: 10 }, { limit: 2, fromEnd: true }, { limit: 10, fromEnd: true });
  add({ content: big },
    { limit: 1, fromEnd: true }, { limit: 10, fromEnd: true }, { limit: 200, fromEnd: true },
    { limit: 5000, fromEnd: true }, { limit: 10, beforeByte: 12_345 }, { limit: 7, offset: 590 });
  add({ content: 'héllo — wörld 😀\nζ\n'.repeat(300) },
    { limit: 3, fromEnd: true }, { limit: 3, beforeByte: 1001 }, { limit: 2, offset: 5 });
  add({ contentBase64: Buffer.from([0x61, 0xff, 0x0a, 0xe2, 0x82, 0x0a, 0xf0, 0x9f, 0x98, 0x0a, 0x62]).toString('base64') },
    { limit: 10 }, { limit: 10, fromEnd: true });
  add({ content: 'a\r\nb\r\n' }, { limit: 10 }, { limit: 10, fromEnd: true });
  return ops;
}

const WS_RUNS = '.whiphand/runs';

function journal(name: string, opts: {
  steps: Entry[]; script: Entry[];
  dryRun?: boolean; workflowSource?: string; inputs?: Record<string, string>;
  attachments?: Entry[]; sessionIds?: Record<string, string>; capBytes?: number;
}): Op {
  return {
    op: 'journal', runId: name, workflow: 'wf',
    dryRun: opts.dryRun ?? false,
    ...(opts.workflowSource === undefined ? {} : { workflowSource: opts.workflowSource }),
    inputs: opts.inputs ?? {},
    ...(opts.attachments === undefined ? {} : { attachments: opts.attachments }),
    sessionIds: opts.sessionIds ?? {},
    steps: opts.steps,
    ...(opts.capBytes === undefined ? {} : { capBytes: opts.capBytes }),
    script: opts.script,
  };
}

const ev = (event: Ev): Entry => ({ event });

function spawn(stepId: string, phase: string, interactive: boolean, env: Record<string, string> = {}): Entry {
  return ev({
    type: 'step:spawn', stepId, phase,
    spec: {
      argv: ['claude', '-p', 'Do the thing — carefully'], cwd: '.', env, interactive,
      ...(interactive ? { endSession: { markerPath: `${WS_RUNS}/x/.a.done`, quitSequence: '/exit\r' } } : {}),
    },
  });
}

function simple(): Op {
  const id = '20240102-000000-simple';
  return journal(id, {
    workflowSource: 'project',
    inputs: { topic: 'auth', '10': 'ten', '2': 'two' },
    steps: [
      { id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', model: 'opus' },
      { id: 'build', kind: 'command' },
      { id: 'skipme', kind: 'command', disabled: true },
    ],
    script: [
      ev({ type: 'run:start', runId: id, workflow: 'wf', source: 'project', name: 'My run' }),
      ev({
        type: 'run:env', runId: id, whiphandVersion: '0.3.5', nodeVersion: 'v24.0.0', platform: 'linux-x64',
        runners: [{ id: 'claude', installed: true, version: '2.0.1' }, { id: 'copilot', installed: false }, { id: 'opencode', installed: true }],
        git: { sha: '0123456789abcdef', dirty: true }, shell: '/bin/sh',
      }),
      ev({ type: 'step:start', stepId: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', model: 'opus' }),
      spawn('plan', 'main', false, { WHIPHAND_RUN_ID: id, API_TOKEN: 'secret' }),
      ev({ type: 'step:log', stepId: 'plan', stream: 'stdout', line: 'hello\\world\nsecond' }),
      ev({ type: 'step:log', stepId: 'plan', stream: 'stderr', line: 'warn' }),
      ev({ type: 'step:progress', stepId: 'plan', progress: { kind: 'text', text: 'thinking' } }),
      ev({ type: 'step:progress', stepId: 'plan', progress: { kind: 'tool', tool: 'Read', target: 'src/a.ts' } }),
      ev({ type: 'step:progress', stepId: 'plan', progress: { kind: 'usage', turns: 2, costUsd: 0.0358 } }),
      ev({ type: 'step:progress', stepId: 'plan', progress: { kind: 'usage', premiumRequests: 1.5 } }),
      ev({ type: 'step:progress', stepId: 'plan', progress: { kind: 'tool', tool: 'Bash' } }),
      ev({ type: 'step:artifact', stepId: 'plan', path: `${WS_RUNS}/${id}/plan.md`, bytes: 1536 }),
      ev({ type: 'step:done', stepId: 'plan', exitCode: 0 }),
      ev({ type: 'step:start', stepId: 'build', kind: 'command' }),
      ev({ type: 'step:timeout', stepId: 'build', timeoutMs: 1000 }),
      ev({ type: 'step:tree-delta', stepId: 'build', files: ['a.ts', 'b.ts'] }),
      ev({ type: 'step:artifact-missing', stepId: 'build', path: `${WS_RUNS}/${id}/build.md`, reason: 'empty' }),
      ev({ type: 'step:verdict', stepId: 'build', verdict: 'fail' }),
      ev({ type: 'guard:warning', message: 'loop budget exhausted' }),
      ev({ type: 'run:degraded', capability: 'git-guard', reason: 'not a git repository' }),
      ev({ type: 'run:degraded', capability: 'git-guard', reason: 'again' }),
      ev({ type: 'run:degraded', capability: 'hooks', reason: 'dropped', stepId: 'plan' }),
      ev({ type: 'run:degraded', capability: 'brand-new', reason: 'from the future', stepId: 'plan' }),
      { stoppedTree: 'tree-digest' },
      ev({ type: 'run:done', ok: true }),
    ],
  });
}

function loops(): Op {
  const id = '20240102-000001-loops';
  const outer = (n: number) => [{ id: 'outer', iteration: n }];
  return journal(id, {
    steps: [
      { id: 'outer', kind: 'loop' },
      { id: 'inner', kind: 'loop', loopId: 'outer' },
      { id: 'work', kind: 'command', loopId: 'inner' },
      { id: 'after', kind: 'command' },
    ],
    script: [
      ev({ type: 'run:start', runId: id, workflow: 'wf' }),
      ev({ type: 'loop:start', loopId: 'outer', maxIterations: 2 }),
      ev({ type: 'loop:iteration', loopId: 'outer', iteration: 1, maxIterations: 2 }),
      ev({ type: 'loop:start', loopId: 'inner', maxIterations: 2, parentLoopId: 'outer', parentIteration: 1 }),
      ev({ type: 'loop:iteration', loopId: 'inner', iteration: 1, maxIterations: 2, parentLoopId: 'outer', parentIteration: 1 }),
      ev({ type: 'step:start', stepId: 'work', kind: 'command', loopId: 'inner', iteration: 1, outerLoops: outer(1) }),
      ev({ type: 'step:done', stepId: 'work', exitCode: 0 }),
      ev({ type: 'loop:iteration', loopId: 'inner', iteration: 2, maxIterations: 2, parentLoopId: 'outer', parentIteration: 1 }),
      ev({ type: 'step:start', stepId: 'work', kind: 'command', loopId: 'inner', iteration: 2, outerLoops: outer(1) }),
      ev({ type: 'step:done', stepId: 'work', exitCode: 2 }),
      ev({ type: 'loop:done', loopId: 'inner', iterations: 2, passed: false, parentLoopId: 'outer', parentIteration: 1 }),
      ev({ type: 'loop:iteration', loopId: 'outer', iteration: 2, maxIterations: 2 }),
      ev({ type: 'loop:start', loopId: 'inner', maxIterations: 2, parentLoopId: 'outer', parentIteration: 2, outerLoops: [] }),
      ev({ type: 'step:start', stepId: 'work', kind: 'command', loopId: 'inner', iteration: 1, outerLoops: outer(2) }),
      ev({ type: 'step:skipped', stepId: 'work', loopId: 'inner', iteration: 1, outerLoops: outer(2) }),
      ev({ type: 'step:done', stepId: 'work', exitCode: 0 }),
      ev({ type: 'loop:done', loopId: 'inner', iterations: 1, passed: 1, parentLoopId: 'outer', parentIteration: 2 }),
      ev({ type: 'loop:done', loopId: 'outer', iterations: 2, passed: true }),
      ev({ type: 'step:start', stepId: 'after', kind: 'command' }),
      ev({ type: 'step:start', stepId: 'ghost', kind: 'command' }),
      ev({ type: 'step:done', stepId: 'nobody', exitCode: 0 }),
      ev({ type: 'run:cancelled' }),
      ev({ type: 'run:done', ok: false }),
    ],
  });
}

function stages(): Op {
  const id = '20240102-000002-stages';
  const item = (stageId: string, title: string, index: number, attempt: number, maxAttempts?: number): Entry => ev({
    type: 'stages:item', id: 'build', index, total: 3, stageId, title, attempt,
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
  const body = (stage: string, iteration: number, exitCode: number): Entry[] => [
    ev({ type: 'step:start', stepId: 'execute', kind: 'command', loopId: 'build', iteration, stage }),
    ev({ type: 'step:done', stepId: 'execute', exitCode }),
  ];
  return journal(id, {
    steps: [{ id: 'build', kind: 'stages' }, { id: 'execute', kind: 'command', loopId: 'build', stagesId: 'build' }],
    script: [
      ev({ type: 'run:start', runId: id, workflow: 'wf' }),
      ev({ type: 'stages:start', id: 'build', total: 3 }),
      item('10', 'Ten', 1, 1, 2),
      ...body('10', 1, 0),
      ev({ type: 'stages:accepted', id: 'build', stageId: '10' }),
      item('2', 'Two', 2, 1),
      ...body('2', 1, 1),
      item('2', 'Two', 2, 2, 2),
      ...body('2', 2, 1),
      ev({ type: 'stages:exhausted', id: 'build', stageId: '2', attempts: 2 }),
      ev({ type: 'run:error', stepId: 'execute', message: 'stage 2 rejected' }),
      { reopen: {} },
      ev({ type: 'run:resume', runId: id, workflow: 'wf', from: 'execute', iteration: 3 }),
      ev({ type: 'stages:start', id: 'build', total: 3 }),
      ev({ type: 'stages:accepted', id: 'build', stageId: '10' }),
      item('2', 'Two', 2, 3, 3),
      ...body('2', 3, 0),
      ev({ type: 'stages:accepted', id: 'build', stageId: '2' }),
      item('01-a', 'A', 3, 1, 2),
      ...body('01-a', 1, 0),
      ev({ type: 'stages:accepted', id: 'build', stageId: '01-a' }),
      ev({ type: 'stages:done', id: 'build', completed: 3 }),
      ev({ type: 'run:done', ok: true }),
    ],
  });
}

function failAndResume(): Op {
  const id = '20240102-000003-resume';
  return journal(id, {
    sessionIds: { chat: 'aaaa-session' },
    attachments: [{ name: 'spec.md', path: 'attachments/spec.md', size: 12, source: 'pasted' }],
    steps: [
      { id: 'chat', kind: 'agent', runner: 'claude', mode: 'interactive' },
      { id: 'check', kind: 'command' },
      { id: 'gate', kind: 'approval' },
      { id: 'final', kind: 'command' },
    ],
    script: [
      ev({ type: 'run:start', runId: id, workflow: 'wf', attachments: [{ name: 'spec.md', size: 12 }] }),
      ev({ type: 'step:start', stepId: 'chat', kind: 'agent', runner: 'claude', mode: 'interactive' }),
      spawn('chat', 'main', true),
      ev({ type: 'session:await', stepId: 'chat', awaiting: true, reason: 'permission' }),
      ev({ type: 'session:await', stepId: 'chat', awaiting: false }),
      ev({ type: 'session:await', stepId: 'chat', awaiting: true }),
      ev({ type: 'session:ended', stepId: 'chat', via: 'marker' }),
      ev({ type: 'step:pty-exit', stepId: 'chat', exitCode: 0, reason: 'ended' }),
      ev({ type: 'step:pty-exit', stepId: 'chat', exitCode: 1 }),
      ev({ type: 'step:session', stepId: 'chat', sessionId: 'bbbb-captured' }),
      spawn('chat', 'harvest', false),
      ev({ type: 'step:artifact', stepId: 'chat', path: `${WS_RUNS}/${id}/chat.md` }),
      ev({ type: 'step:done', stepId: 'chat', exitCode: 0 }),
      ev({ type: 'step:start', stepId: 'check', kind: 'command' }),
      ev({ type: 'step:retry', stepId: 'check', attempt: 2 }),
      ev({ type: 'step:done', stepId: 'check', exitCode: 0 }),
      ev({ type: 'run:error', stepId: 'check', message: "step 'check' wrote no artifact" }),
      { writeFile: { path: 'chat.md', content: 'chat\n' } },
      { writeFile: { path: 'attachments/spec.md', content: 'spec spec\n' } },
      { rename: '  Resumable\u0007 run ' },
      { lock: true },
      { list: true },
      { reopen: {} },
      ev({ type: 'run:resume', runId: id, workflow: 'wf', from: 'check', name: 'Resumable run' }),
      ev({ type: 'step:start', stepId: 'check', kind: 'command' }),
      ev({ type: 'step:done', stepId: 'check', exitCode: 0 }),
      ev({ type: 'step:start', stepId: 'gate', kind: 'approval' }),
      ev({
        type: 'step:manual', stepId: 'gate',
        request: { title: 'Ship it?', body: 'Look at chat.md', choices: ['continue', 'abort'], default: 'continue' },
      }),
      { list: true },
      ev({ type: 'step:manual-resolved', stepId: 'gate', choice: 'abort' }),
      ev({ type: 'step:done', stepId: 'gate', exitCode: 1 }),
      ev({ type: 'run:cancelled' }),
      { lock: false },
      { rename: null },
      { reopen: { workdir: 'moved' } },
      ev({ type: 'run:resume', runId: id, workflow: 'wf' }),
      ev({ type: 'step:start', stepId: 'gate', kind: 'approval' }),
      ev({ type: 'step:manual', stepId: 'gate', request: { title: 'Again?' } }),
      ev({ type: 'step:artifact', stepId: 'final', path: 'elsewhere/final.md' }),
      ev({ type: 'run:error', message: 'no step to blame' }),
      { list: true },
    ],
  });
}

function dryRun(): Op {
  const id = '20240102-000004-dry';
  return journal(id, {
    dryRun: true,
    steps: [{ id: 'a', kind: 'command' }],
    script: [
      ev({ type: 'run:start', runId: id, workflow: 'wf' }),
      ev({ type: 'step:start', stepId: 'a', kind: 'command' }),
      ev({ type: 'step:log', stepId: 'a', stream: 'stdout', line: 'dropped' }),
      ev({ type: 'step:progress', stepId: 'a', progress: { kind: 'tool', tool: 'Edit', target: 'x' } }),
      ev({ type: 'step:done', stepId: 'a', exitCode: 0 }),
      ev({ type: 'run:done', ok: true }),
    ],
  });
}

function capped(): Op {
  const id = '20240102-000005-capped';
  const lines: Entry[] = [];
  for (let i = 0; i < 12; i++) {
    lines.push(ev({ type: 'step:log', stepId: 'a', stream: i % 3 === 0 ? 'stderr' : 'stdout', line: `line ${i} ${'é'.repeat(i * 5)}` }));
  }
  return journal(id, {
    capBytes: 900,
    steps: [{ id: 'a', kind: 'command' }],
    script: [
      ev({ type: 'run:start', runId: id, workflow: 'wf' }),
      ev({ type: 'step:start', stepId: 'a', kind: 'command' }),
      ...lines,
      ev({ type: 'step:done', stepId: 'a', exitCode: 0 }),
      ev({ type: 'run:done', ok: true }),
    ],
  });
}

function longLines(): Op {
  const id = '20240102-000006-long';
  return journal(id, {
    steps: [{ id: 'a', kind: 'command' }],
    script: [
      ev({ type: 'run:start', runId: id, workflow: 'wf' }),
      ev({ type: 'step:log', stepId: 'a', stream: 'stdout', line: 'é'.repeat(5000) }),
      ev({ type: 'step:log', stepId: 'a', stream: 'stdout', line: `x${'é'.repeat(5000)}` }),
      ev({ type: 'step:log', stepId: 'a', stream: 'stdout', line: '🚀'.repeat(3000) }),
      ev({ type: 'guard:warning', stepId: 'a', message: `${'\\'.repeat(5000)}\n` }),
      ev({ type: 'run:error', stepId: 'a', message: 'boom' }),
    ],
  });
}

export function storeJournalOps(): Op[] {
  return [simple(), loops(), stages(), failAndResume(), dryRun(), capped(), longLines()];
}
