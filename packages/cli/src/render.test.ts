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
  assert.deepEqual(out.at(-1), '  7 turns · 3m12s · $0.41');
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

test('the existing per-event rendering is unchanged', () => {
  const { out, err, render } = capture();
  render({ type: 'run:start', runId: 'r1', workflow: 'cycle' });
  render(startHeadless);
  render({ type: 'step:artifact', stepId: 'impl', path: '/w/.whiphand/runs/r1/impl.md' });
  render({ type: 'step:verdict', stepId: 'impl', verdict: 'pass' });
  render({ type: 'loop:iteration', loopId: 'fix', iteration: 2, maxIterations: 5 });
  render({ type: 'guard:warning', message: 'uncommitted changes' });
  render({ type: 'run:done', runId: 'r1', ok: true });
  assert.deepEqual(out, [
    "whiphand run r1 — workflow 'cycle'",
    '→ step impl (claude/opus, headless)',
    '  ✔ artifact /w/.whiphand/runs/r1/impl.md',
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

test('a dry run also names where each attachment would have been copied', () => {
  const out: string[] = [];
  const render = createRenderer({ out: l => out.push(l), err: () => {} }, { runDirOf: id => `/ws/.whiphand/runs/${id}` });
  render({ type: 'run:start', runId: 'r1', workflow: 'feature', attachments: [{ name: 'bug.png', size: 12 }] });
  assert.deepEqual(out.slice(1), ['📎 bug.png 12 B', `  → ${join('/ws/.whiphand/runs/r1', 'attachments', 'bug.png')}`]);
});
