import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRenderer } from './render.ts';
import type { WhiphandEvent } from '@whiphand/core';

function capture(startMs = 0): { out: string[]; err: string[]; clock: { ms: number }; render: (e: WhiphandEvent) => void } {
  const out: string[] = [];
  const err: string[] = [];
  const clock = { ms: startMs };
  const render = createRenderer({ out: l => out.push(l), err: l => err.push(l), now: () => clock.ms });
  return { out, err, clock, render };
}

const startHeadless: WhiphandEvent = {
  type: 'step:start', stepId: 'impl', kind: 'agent', runner: 'claude', model: 'opus', mode: 'headless',
};

test('a tool call prints one indented activity line', () => {
  const { out, render } = capture();
  render({ type: 'step:progress', stepId: 'impl', progress: { kind: 'tool', tool: 'Read', target: 'runner.ts' } });
  assert.deepEqual(out, ['  Read runner.ts']);
});

test('a tool call with no target still prints the tool', () => {
  const { out, render } = capture();
  render({ type: 'step:progress', stepId: 'impl', progress: { kind: 'tool', tool: 'TodoWrite' } });
  assert.deepEqual(out, ['  TodoWrite']);
});

test('assistant prose prints nothing: it would drown the terminal', () => {
  const { out, render } = capture();
  render({ type: 'step:progress', stepId: 'impl', progress: { kind: 'text', text: 'Let me look at the runner…' } });
  assert.deepEqual(out, []);
});

test('a finished step summarises turns, elapsed and cost', () => {
  const { out, clock, render } = capture();
  render(startHeadless);
  render({ type: 'step:progress', stepId: 'impl', progress: { kind: 'usage', turns: 7, costUsd: 0.41 } });
  clock.ms = 192_000;
  render({ type: 'step:done', stepId: 'impl', exitCode: 0 });
  assert.deepEqual(out.at(-1), '  7 turns · 3m 12s · $0.41');
});

test('a copilot step summarises premium requests, having no dollar cost', () => {
  const { out, clock, render } = capture();
  render({ ...startHeadless, runner: 'copilot' });
  render({ type: 'step:progress', stepId: 'impl', progress: { kind: 'usage', turns: 2 } });
  render({ type: 'step:progress', stepId: 'impl', progress: { kind: 'usage', premiumRequests: 0.33 } });
  clock.ms = 45_000;
  render({ type: 'step:done', stepId: 'impl', exitCode: 0 });
  assert.deepEqual(out.at(-1), '  2 turns · 45s · 0.33 premium requests');
});

test('a step that reported no counters degrades to elapsed alone, never zeroes', () => {
  const { out, clock, render } = capture();
  render(startHeadless);
  clock.ms = 5_000;
  render({ type: 'step:done', stepId: 'impl', exitCode: 0 });
  assert.deepEqual(out.at(-1), '  5s');
});

test('each step is timed from its own start', () => {
  const { out, clock, render } = capture();
  render(startHeadless);
  clock.ms = 10_000;
  render({ type: 'step:done', stepId: 'impl', exitCode: 0 });
  clock.ms = 30_000;
  render({ ...startHeadless, stepId: 'review' });
  clock.ms = 61_000;
  render({ type: 'step:done', stepId: 'review', exitCode: 0 });
  assert.deepEqual(out.at(-1), '  31s');
});

test("a model id that already carries a provider prefix is not glued onto the runner name", () => {
  const { out, render } = capture();
  render({ ...startHeadless, runner: 'opencode', model: 'opencode/claude-haiku-4-5' });
  assert.deepEqual(out, ['→ step impl (opencode · opencode/claude-haiku-4-5, headless)']);
});

test('the existing per-event rendering is unchanged', () => {
  const { out, err, render } = capture();
  render({ type: 'run:start', runId: 'r1', workflow: 'cycle' });
  render(startHeadless);
  render({ type: 'step:artifact', stepId: 'impl', path: '.whiphand/runs/r1/impl.md' });
  render({ type: 'step:verdict', stepId: 'impl', verdict: 'pass' });
  render({ type: 'loop:iteration', loopId: 'fix', iteration: 2, maxIterations: 5 });
  render({ type: 'guard:warning', message: 'uncommitted changes' });
  render({ type: 'run:done', runId: 'r1', ok: true });
  assert.deepEqual(out, [
    "whiphand run r1 — workflow 'cycle'",
    '→ step impl (claude · opus, headless)',
    '  ✔ artifact .whiphand/runs/r1/impl.md',
    '  verdict: PASS',
    '↻ fix — iteration 2/5',
    '✔ run complete',
  ]);
  assert.deepEqual(err, ['  ⚠ uncommitted changes']);
});

test('run:start mentions a global workflow resolution, but not a project one', () => {
  const { out, render } = capture();
  render({ type: 'run:start', runId: 'r1', workflow: 'cycle', source: 'project' });
  render({ type: 'run:start', runId: 'r2', workflow: 'cycle', source: 'global' });
  assert.deepEqual(out, [
    "whiphand run r1 — workflow 'cycle'",
    "whiphand run r2 — workflow 'cycle' (global)",
  ]);
});

test('a non-headless step finishes silently, as it always did', () => {
  const { out, clock, render } = capture();
  render({ type: 'step:start', stepId: 'tests', kind: 'command' });
  clock.ms = 9_000;
  render({ type: 'step:done', stepId: 'tests', exitCode: 0 });
  assert.deepEqual(out, ['→ step tests (command)'], 'a command step streams its own output already');
});

test('a resumed run says so, and where it picks up', () => {
  const { out, render } = capture();
  render({ type: 'run:resume', runId: 'r1', workflow: 'cycle', from: 'execute' });
  assert.deepEqual(out, ["whiphand resume r1 — workflow 'cycle', from step 'execute'"]);
});

test('a resume with no restart point still names the run', () => {
  const { out, render } = capture();
  render({ type: 'run:resume', runId: 'r1', workflow: 'cycle' });
  assert.deepEqual(out, ["whiphand resume r1 — workflow 'cycle'"]);
});

test('a reused step is reported, not silently absent', () => {
  const { out, render } = capture();
  render({ type: 'step:skipped', stepId: 'plan' });
  // Loop bodies stay indented, exactly as step:start already indents them.
  render({ type: 'step:skipped', stepId: 'edit', loopId: 'fix', iteration: 2 });
  assert.deepEqual(out, ['↷ step plan (reused)', '  ↷ step edit (reused)']);
});

test('run:start with attachments adds one 📎 line with each final name and size', () => {
  const { out, render } = capture();
  render({
    type: 'run:start', runId: 'r1', workflow: 'feature',
    attachments: [{ name: 'bug.png', size: 1.2 * 1024 * 1024 }, { name: 'server.log', size: 340 * 1024 }],
  });
  assert.deepEqual(out, ["whiphand run r1 — workflow 'feature'", '📎 bug.png 1.2 MB · server.log 340 KB']);
});

test('run:start without attachments prints no 📎 line', () => {
  const { out, render } = capture();
  render({ type: 'run:start', runId: 'r1', workflow: 'feature' });
  assert.deepEqual(out, ["whiphand run r1 — workflow 'feature'"]);
});

test('stages events render as stage lines', () => {
  const { out, render } = capture();
  render({ type: 'stages:start', id: 'build', total: 7 });
  render({
    type: 'stages:item', id: 'build', index: 3, total: 7, stageId: '03-api', title: 'Add API routes', attempt: 1,
  });
  render({
    type: 'stages:item', id: 'build', index: 3, total: 7, stageId: '03-api', title: 'Add API routes', attempt: 2,
  });
  render({ type: 'stages:accepted', id: 'build', stageId: '03-api' });
  render({ type: 'stages:done', id: 'build', completed: 7 });
  assert.deepEqual(out, [
    '▤ stages build (7 stages)',
    '▤ build — stage 3/7: Add API routes',
    '▤ build — stage 3/7: Add API routes (attempt 2)',
    '▤ build — stage 3/7 accepted',
    '▤ build finished 7 stages',
  ]);
});

test('an exhausted stage is reported — the run stops there for a human', () => {
  const { out, render } = capture();
  render({ type: 'stages:exhausted', id: 'build', stageId: '03-api', attempts: 3 });
  assert.deepEqual(out, ["▤ build — stage '03-api' rejected after 3 attempt(s), handed to a human"]);
});

test('a loop directly inside a stage names the stage, so two stages read as different loops', () => {
  const { out, render } = capture();
  render({ type: 'loop:start', loopId: 'cycle', maxIterations: 3, parentLoopId: 'build', parentIteration: 1, parentStage: '01-schema' });
  render({ type: 'loop:start', loopId: 'cycle', maxIterations: 3, parentLoopId: 'build', parentIteration: 1, parentStage: '02-api' });
  assert.deepEqual(out, [
    '↻ loop build/01-schema 1 › cycle (up to 3 iterations)',
    '↻ loop build/02-api 1 › cycle (up to 3 iterations)',
  ]);
  assert.notEqual(out[0], out[1], 'stage 1 and stage 2 must not collapse onto one identical label');
});

test('a dry run also names where each attachment would have been copied', () => {
  const out: string[] = [];
  const render = createRenderer({ out: l => out.push(l), err: () => {} }, { runDirOf: id => `/ws/.whiphand/runs/${id}` });
  render({ type: 'run:start', runId: 'r1', workflow: 'feature', attachments: [{ name: 'bug.png', size: 12 }] });
  assert.deepEqual(out.slice(1), ['📎 bug.png 12 B', `  → ${join('/ws/.whiphand/runs/r1', 'attachments', 'bug.png')}`]);
});

test('degradations are held and printed as a summary once the run ends, one line each', () => {
  const { out, err, render } = capture();
  render({ type: 'run:start', runId: 'r1', workflow: 'w' });
  render({ type: 'run:degraded', capability: 'git-guard', stepId: 'look', reason: 'not a git repository: read-only tree assertion disabled' });
  render({ type: 'run:degraded', capability: 'process-containment', reason: 'the process guard (whiphand-job.exe) was not found' });
  assert.deepEqual(err, [], 'nothing between steps');
  render({ type: 'run:done', runId: 'r1', ok: true });
  assert.deepEqual(out.at(-1), '✔ run complete');
  assert.deepEqual(err, [
    '  ⚠ degraded: Read-only tree guard off (not a git repository) [look] — not a git repository: read-only tree assertion disabled',
    '  ⚠ degraded: Process containment unavailable — the process guard (whiphand-job.exe) was not found',
  ]);
});

test('a degradation that arrives after run:done (teardown) is printed as it comes', () => {
  const { err, render } = capture();
  render({ type: 'run:done', runId: 'r1', ok: true });
  render({ type: 'run:degraded', capability: 'retention', reason: 'could not prune r0: EBUSY' });
  assert.deepEqual(err, ['  ⚠ degraded: Old run directories could not be pruned — could not prune r0: EBUSY']);
});
