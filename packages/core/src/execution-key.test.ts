import test from 'node:test';
import assert from 'node:assert/strict';
import { ancestorLoops, executionKey, frameIdentity, sameLoopRefs } from './execution-key.ts';
import type { LoopFrame, StageFrame } from './types.ts';

test('a top-level step keeps the original single-level key', () => {
  assert.equal(executionKey('plan'), 'plan');
  assert.equal(executionKey('plan', undefined), 'plan');
});

test('iteration 1 (or absent) is dropped, with no outer loops', () => {
  assert.equal(executionKey('execute', 1), 'execute');
  assert.equal(executionKey('execute', undefined, []), 'execute');
});

test('iteration 2+ is suffixed, with no outer loops — unchanged from before nesting existed', () => {
  assert.equal(executionKey('execute', 2), 'execute#2');
  assert.equal(executionKey('execute', 3), 'execute#3');
});

test('an outer loop folds into the key, even at iteration 1', () => {
  assert.equal(
    executionKey('execute', 1, [{ id: 'human-review', iteration: 2 }]),
    'human-review#2/execute#1',
  );
});

test('two outer loops chain outermost first', () => {
  assert.equal(
    executionKey('execute', 1, [{ id: 'outer', iteration: 1 }, { id: 'inner', iteration: 3 }]),
    'outer#1/inner#3/execute#1',
  );
});

test('ancestorLoops is empty for a top-level frame or no frame', () => {
  assert.deepEqual(ancestorLoops(undefined), []);
  const top: LoopFrame = { id: 'fix', iteration: 2, maxIterations: 3 };
  assert.deepEqual(ancestorLoops(top), []);
});

test('ancestorLoops walks the parent chain outermost first, excluding the frame itself', () => {
  const outer: LoopFrame = { id: 'human-review', iteration: 2, maxIterations: 5 };
  const inner: LoopFrame = { id: 'fix-cycle', iteration: 1, maxIterations: 3, parent: outer };
  assert.deepEqual(ancestorLoops(inner), [{ id: 'human-review', iteration: 2 }]);
});

test('a three-level nest reports every ancestor, outermost first', () => {
  const x: LoopFrame = { id: 'x', iteration: 1, maxIterations: 1 };
  const y: LoopFrame = { id: 'y', iteration: 3, maxIterations: 3, parent: x };
  const z: LoopFrame = { id: 'z', iteration: 2, maxIterations: 2, parent: y };
  assert.deepEqual(ancestorLoops(z), [{ id: 'x', iteration: 1 }, { id: 'y', iteration: 3 }]);
});

test('a stage frame keys as step@stage#attempt, and never collides across stages', () => {
  assert.equal(executionKey('accept', 1, [], 'schema'), 'accept@schema#1');
  assert.equal(executionKey('accept', 1, [], 'api'), 'accept@api#1');
  assert.equal(executionKey('accept', 2, [], 'api'), 'accept@api#2');
});

test('a loop nested in a stage carries the stage in its outer chain', () => {
  const stage = { index: 2, total: 7, id: '02-api', title: 'Add API routes', path: '/p/02-api.md' };
  const sf: StageFrame = { kind: 'stages', id: 'build', stage, attempt: 2, maxAttempts: 3 };
  const lf: LoopFrame = { id: 'cycle', iteration: 3, maxIterations: 3, parent: sf };
  const idn = frameIdentity(lf);
  assert.deepEqual(idn.outerLoops, [{ id: 'build', iteration: 2, stage: '02-api' }]);
  assert.equal(executionKey('execute', idn.iteration, idn.outerLoops, idn.stage), 'build@02-api#2/execute#3');
});

test('a plain loop key is byte-identical to before stages existed', () => {
  assert.equal(executionKey('edit', 1), 'edit');
  assert.equal(executionKey('edit', 2), 'edit#2');
  assert.equal(executionKey('edit', 1, [{ id: 'outer', iteration: 2 }]), 'outer#2/edit#1');
});

test('sameLoopRefs separates two stages of the same stages step', () => {
  assert.equal(sameLoopRefs([{ id: 'b', iteration: 1, stage: 'a' }], [{ id: 'b', iteration: 1, stage: 'c' }]), false);
});
