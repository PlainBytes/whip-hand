import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interactiveGuidance } from './interactive-guidance.ts';
import type { AgentStep, RunCtx } from '../types.ts';

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1', runSlug: 'r1',
  sessionIds: {}, artifacts: {}, attempts: {}, verdicts: {}, inputs: {},
};

const step: AgentStep = { kind: 'agent',
  id: 'plan', runner: 'claude', mode: 'interactive',
  writes: false, prompt: 'Plan it.', output: 'plan.md',
};

test('a read-only step is told to change nothing, including via the shell', () => {
  const text = interactiveGuidance(step, ctx);
  assert.ok(text.includes('READ-ONLY'));
  assert.ok(text.includes('no shell command that changes anything'));
  assert.ok(!text.includes('wait for the human to say go'));
});

test('a writes step is told to propose first rather than never write', () => {
  const text = interactiveGuidance({ ...step, writes: true }, ctx);
  assert.ok(text.includes('wait for the human to say go'));
  assert.ok(!text.includes('READ-ONLY'));
});

test('both modes get the scope rule that keeps a step out of later steps work', () => {
  for (const writes of [true, false]) {
    const text = interactiveGuidance({ ...step, writes }, ctx);
    assert.ok(text.includes("step 'plan'"));
    assert.ok(text.includes('Do not run ahead'));
    // Workspace-relative with forward slashes: what the rule pre-approves too.
    assert.ok(text.includes('touch .whiphand/runs/r1/.plan.done'));
    assert.ok(!text.includes('/w/'), 'no absolute path is shown to the model');
  }
});

test('a run dir with a space gets its marker single-quoted; a Windows one stays workspace-relative', () => {
  const spaced = interactiveGuidance(step, { ...ctx, runDir: '/w/my runs/r1' });
  assert.ok(spaced.includes("touch 'my runs/r1/.plan.done'"));
  assert.ok(spaced.includes('run directory (my runs/r1)'));

  const win = interactiveGuidance(step, { ...ctx, workdir: 'D:\\w', runDir: 'D:\\w\\.whiphand\\runs\\r1' });
  assert.ok(win.includes('touch .whiphand/runs/r1/.plan.done'));
  assert.ok(!win.includes('\\'), 'no backslash reaches the model');
});

test('a run dir outside the workspace falls back to the absolute forward-slash marker', () => {
  const text = interactiveGuidance(step, { ...ctx, runDir: '/elsewhere/runs/r1' });
  assert.ok(text.includes('touch /elsewhere/runs/r1/.plan.done'));
});

test('the run dir is carved out of the read-only rule', () => {
  // harvest resumes this same session and asks it to write plan.md into the run
  // dir; without the carve-out that request contradicts the rule above it.
  const text = interactiveGuidance(step, ctx);
  // Workspace-relative, like every path a model is shown.
  assert.ok(text.includes('run directory (.whiphand/runs/r1)'));
  assert.ok(!text.includes(ctx.runDir), 'not the absolute path');
  assert.ok(text.includes('exempt from the rule above'));
});

test('the model is told not to write the artifact itself: harvest does that', () => {
  const text = interactiveGuidance(step, ctx);
  assert.ok(text.includes("'plan.md'"));
  assert.ok(text.includes('do not write it yourself now'));
});
