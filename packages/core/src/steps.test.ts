import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenSteps } from './steps.ts';
import type { AgentStep, LoopStep, StagesStep } from './types.ts';

const agent = (over: Partial<AgentStep> & { id: string }): AgentStep => ({
  kind: 'agent', runner: 'claude', mode: 'headless', writes: false,
  prompt: `prompt for ${over.id}`, output: `${over.id}.md`, ...over,
});

test('flattenSteps: threads stagesId into a stages body, through a nested loop, and resets loopId there', () => {
  const cycle: LoopStep = {
    kind: 'loop', id: 'cycle', until: 'gate', max_iterations: 3,
    steps: [
      agent({ id: 'implement', writes: true }),
      { kind: 'manual', id: 'gate', title: 'Sign off', instructions: 'go', verdict: true },
    ],
  };
  const build: StagesStep = { kind: 'stages', id: 'build', items: '*.md', steps: [cycle] };

  const flat = flattenSteps([build]);
  const byId = Object.fromEntries(flat.map(f => [f.step.id, f]));

  assert.equal(byId.build.stagesId, undefined, 'the stages step itself has no enclosing stagesId');
  assert.equal(byId.build.depth, 0);

  // The loop is a direct member of the stages body: stagesId names 'build',
  // and it has no loopId of its own (it is not inside another loop).
  assert.equal(byId.cycle.stagesId, 'build');
  assert.equal(byId.cycle.loopId, undefined);
  assert.equal(byId.cycle.depth, 1);

  // Steps inside the loop, which is itself inside the stages body, carry
  // both: stagesId threaded through the nested loop, loopId naming the
  // immediate parent.
  assert.equal(byId.implement.stagesId, 'build');
  assert.equal(byId.implement.loopId, 'cycle');
  assert.equal(byId.implement.depth, 2);
  assert.equal(byId.gate.stagesId, 'build');
  assert.equal(byId.gate.loopId, 'cycle');
  assert.equal(byId.gate.depth, 2);
});

test('flattenSteps: resets loopId on entering a stages body, even if the caller passed one in', () => {
  // A stages step cannot really sit inside a loop (schema.ts refuses it),
  // but flattenSteps is a pure tree walk and takes loopId as a plain
  // argument — this pins the "reset, not inherit" behavior directly rather
  // than relying on that outer loopId always being undefined in practice.
  const build: StagesStep = { kind: 'stages', id: 'build', items: '*.md', steps: [agent({ id: 'implement' })] };
  const flat = flattenSteps([build], 'outer-loop');
  const implement = flat.find(f => f.step.id === 'implement')!;
  assert.equal(implement.loopId, undefined);
  assert.equal(implement.stagesId, 'build');
});
