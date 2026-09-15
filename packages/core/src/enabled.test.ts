import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEnabled, disabledRoots, disabledIds, pruneDisabled, droppedRefs, droppedRefSentence, joinNames, untilTargetOf,
} from './enabled.ts';
import type { AgentStep, LoopStep, Workflow } from './types.ts';

const agent = (over: Partial<AgentStep> & { id: string }): AgentStep => ({
  kind: 'agent', runner: 'claude', mode: 'headless', writes: false,
  prompt: `prompt for ${over.id}`, output: `${over.id}.md`, ...over,
});

/**
 * Mirrors the nesting in feature-development.yaml: a `human-review` loop
 * (disabled in some tests) wrapping a `do-review` loop, wrapping `execute`
 * and `review`, with `sign-off` as the outer loop's `until`. `commit-message`
 * reads `plan`, `review` and `sign-off` — the case the functional spec's
 * acceptance criteria are built around.
 */
function nested(overrides: { humanReviewDisabled?: boolean; planDisabled?: boolean } = {}): Workflow {
  const doReview: LoopStep = {
    kind: 'loop', id: 'do-review', until: 'review', max_iterations: 10,
    steps: [
      agent({ id: 'execute', writes: true, inputs: ['plan', 'review', 'sign-off'] }),
      agent({ id: 'review', verdict: true, inputs: ['plan', 'execute'] }),
    ],
  };
  const humanReview: LoopStep = {
    kind: 'loop', id: 'human-review', until: 'sign-off', max_iterations: 5,
    ...(overrides.humanReviewDisabled ? { enabled: false } : {}),
    steps: [
      doReview,
      { kind: 'manual', id: 'sign-off', title: 'Ship it?', instructions: 'go', verdict: true, inputs: ['review'] },
    ],
  };
  return {
    name: 'feature-development',
    steps: [
      agent({ id: 'plan', mode: 'interactive', ...(overrides.planDisabled ? { enabled: false } : {}) }),
      humanReview,
      agent({ id: 'commit-message', inputs: ['plan', 'review', 'sign-off'] }),
    ],
  };
}

test('isEnabled: absent means enabled', () => {
  assert.equal(isEnabled(agent({ id: 'a' })), true);
  assert.equal(isEnabled(agent({ id: 'a', enabled: true })), true);
  assert.equal(isEnabled(agent({ id: 'a', enabled: false })), false);
});

test('disabledRoots: one entry per explicit enabled:false, at any depth', () => {
  const wf = nested({ humanReviewDisabled: true });
  assert.deepEqual(disabledRoots(wf.steps), new Set(['human-review']));
});

test('disabledRoots: a disabled leaf inside an enabled loop is its own root', () => {
  const wf = nested();
  wf.steps.push(agent({ id: 'notes', enabled: false }));
  assert.deepEqual(disabledRoots(wf.steps), new Set(['notes']));
});

test('disabledIds: a disabled loop takes every descendant, at any depth, without inflating disabledRoots', () => {
  const wf = nested({ humanReviewDisabled: true });
  assert.deepEqual(disabledRoots(wf.steps), new Set(['human-review']));
  assert.deepEqual(
    disabledIds(wf.steps),
    new Set(['human-review', 'do-review', 'execute', 'review', 'sign-off']));
});

test('disabledIds: a plain disabled leaf is only itself', () => {
  const wf = nested({ planDisabled: true });
  assert.deepEqual(disabledIds(wf.steps), new Set(['plan']));
});

test('pruneDisabled: a disabled loop is removed whole, body and all', () => {
  const wf = nested({ humanReviewDisabled: true });
  const effective = pruneDisabled(wf);
  assert.deepEqual(effective.steps.map(s => s.id), ['plan', 'commit-message']);
});

test('pruneDisabled: strips a disabled id from every surviving step\'s inputs', () => {
  const wf = nested({ planDisabled: true });
  const effective = pruneDisabled(wf);
  const commitMessage = effective.steps.find(s => s.id === 'commit-message') as AgentStep;
  assert.deepEqual(commitMessage.inputs, ['review', 'sign-off']);
  const humanReview = effective.steps.find(s => s.id === 'human-review') as LoopStep;
  const doReview = humanReview.steps.find(s => s.id === 'do-review') as LoopStep;
  const execute = doReview.steps.find(s => s.id === 'execute') as AgentStep;
  assert.deepEqual(execute.inputs, ['review', 'sign-off'], 'the reference one loop level in is stripped too');
});

test('pruneDisabled: an untouched step\'s inputs array is the same reference (no needless copy)', () => {
  const wf = nested();
  const effective = pruneDisabled(wf);
  const original = (wf.steps[0] as AgentStep);
  const kept = effective.steps.find(s => s.id === 'plan') as AgentStep;
  assert.equal(kept, original);
});

test('droppedRefs: enabled non-command readers of a disabled id, command readers excluded', () => {
  const wf = nested({ planDisabled: true });
  const refs = droppedRefs(wf);
  const byReader = Object.fromEntries(refs.map(r => [r.reader, r.missing]));
  assert.deepEqual(byReader['commit-message'], ['plan']);
  assert.deepEqual(byReader['execute'], ['plan']);
  assert.deepEqual(byReader['review'], ['plan'], 'review also reads plan, per feature-development.yaml');
});

test('droppedRefs: evaluates against the full disabledIds set, not just the roots', () => {
  const wf = nested({ humanReviewDisabled: true });
  const refs = droppedRefs(wf);
  const commitMessage = refs.find(r => r.reader === 'commit-message');
  assert.deepEqual(new Set(commitMessage?.missing), new Set(['review', 'sign-off']));
});

test('droppedRefs: a reader inside a disabled loop never appears, even though it carries no enabled:false of its own', () => {
  const wf = nested({ humanReviewDisabled: true });
  const refs = droppedRefs(wf);
  // 'execute' and 'review' both read 'sign-off'/'review' respectively and are
  // themselves inside the disabled 'human-review' loop — they will not run,
  // so warning about what they lose would name a step that never starts.
  assert.equal(refs.some(r => r.reader === 'execute'), false);
  assert.equal(refs.some(r => r.reader === 'review'), false);
});

test('droppedRefs: a command step\'s inputs are a runtime no-op and never appear', () => {
  const wf: Workflow = {
    name: 'w',
    steps: [
      agent({ id: 'plan', enabled: false }),
      { kind: 'command', id: 'stage', run: 'echo hi', inputs: ['plan'], output: 'stage.log' },
    ],
  };
  assert.deepEqual(droppedRefs(wf), []);
});

test('droppedRefSentence: groups every reader that lost the same id into one sentence', () => {
  const sentences = droppedRefSentence([
    { reader: 'execute', missing: ['plan'] },
    { reader: 'commit-message', missing: ['plan'] },
  ]);
  assert.deepEqual(sentences, ["plan is disabled. execute and commit-message read it; they'll run without it."]);
});

test('droppedRefSentence: a single reader still gets a grammatical sentence', () => {
  const sentences = droppedRefSentence([{ reader: 'execute', missing: ['plan'] }]);
  assert.deepEqual(sentences, ["plan is disabled. execute reads it; it'll run without it."]);
});

test('joinNames: none, one, two, and a list with no Oxford comma', () => {
  assert.equal(joinNames([]), '');
  assert.equal(joinNames(['plan']), 'plan');
  assert.equal(joinNames(['plan', 'review']), 'plan and review');
  assert.equal(joinNames(['plan', 'review', 'fix']), 'plan, review and fix');
});

test('untilTargetOf: finds the loop whose until: names the id, at any depth', () => {
  const wf = nested();
  assert.equal((untilTargetOf(wf.steps, 'sign-off') as LoopStep).id, 'human-review');
  assert.equal((untilTargetOf(wf.steps, 'review') as LoopStep).id, 'do-review');
  assert.equal(untilTargetOf(wf.steps, 'plan'), undefined);
});

test('untilTargetOf: ignores enabled state, unconditionally — the loop, or the target, being disabled changes nothing', () => {
  const disabledLoop = nested({ humanReviewDisabled: true });
  assert.equal((untilTargetOf(disabledLoop.steps, 'sign-off') as LoopStep).id, 'human-review');

  const wf = nested();
  const humanReview = wf.steps.find(s => s.id === 'human-review') as LoopStep;
  const signOff = humanReview.steps.find(s => s.id === 'sign-off')!;
  signOff.enabled = false;
  assert.equal((untilTargetOf(wf.steps, 'sign-off') as LoopStep).id, 'human-review');
});
