import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interactiveGuidance } from './interactive-guidance.ts';
import { endMarkerPath, shellPath } from './session-end.ts';
import type { AgentStep, RunCtx } from '../types.ts';

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1', runSlug: 'r1',
  sessionIds: {}, artifacts: {}, attempts: {}, inputs: {},
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
    assert.ok(text.includes(`touch ${shellPath(endMarkerPath(ctx.runDir, 'plan'))}`));
  }
});

test('the run dir is carved out of the read-only rule', () => {
  // harvest resumes this same session and asks it to write plan.md into the run
  // dir; without the carve-out that request contradicts the rule above it.
  const text = interactiveGuidance(step, ctx);
  assert.ok(text.includes(ctx.runDir));
  assert.ok(text.includes('exempt from the rule above'));
});

test('the model is told not to write the artifact itself: harvest does that', () => {
  const text = interactiveGuidance(step, ctx);
  assert.ok(text.includes("'plan.md'"));
  assert.ok(text.includes('do not write it yourself now'));
});
