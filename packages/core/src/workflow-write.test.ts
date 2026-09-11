import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { mergeWorkflow } from './workflow-write.ts';
import { parseWorkflow } from './schema.ts';
import type { Workflow } from './types.ts';

/** Mirrors scaffold.ts's workflowTemplate: the commented-out `tests` step, a
 * trailing comment on `plan`'s id, and a `commentBefore` on `sign-off`. */
const featureText = `# feature — plan interactively, then implement and review in a cycle
name: feature
description: Plan with a human, then implement and review in a cycle until the review passes.
inputs:
  feature:
    required: true
    prompt: What are we building?
steps:
  - id: plan # live terminal chat; artifact harvested afterwards
    runner: claude
    mode: interactive
    writes: false
    output: plan.md
    prompt: |
      We are planning: {{ inputs.feature }}. Work with me on a plan. Do not modify files.

  - id: fix-cycle # repeats its body until 'review' returns VERDICT: PASS
    kind: loop
    until: review
    max_iterations: 3
    steps:
      - id: execute # headless; may write
        runner: claude
        mode: headless
        writes: true
        inputs: [plan, review]
        output: execute-report.md
        prompt: Implement the attached plan.

      # A shell step: no tokens, no runner. Uncomment to make the tests part of
      # the cycle — with 'verdict: true' a non-zero exit sends the loop round
      # again instead of failing the run.
      # - id: tests
      #   kind: command
      #   run: npm test
      #   verdict: true
      #   output: tests.log

      - id: review # headless, read-only, must end with VERDICT: PASS|FAIL
        runner: claude
        mode: headless
        writes: false
        verdict: true
        inputs: [plan, execute]
        output: review.md
        prompt: Review the implementation against the attached plan.

  # A human gate. Delete it to let the workflow run unattended.
  - id: sign-off
    kind: approval
    title: Ship it?
    instructions: Review the diff and the findings before this goes any further.
    show_diff: true
    inputs: [review]
`;

/** The production shape: `updateWorkflow`'s only caller edits a `parseWorkflow`
 * result, which — unlike raw `yaml.parse` — has `kind: 'agent'` materialised on
 * every step that omitted it. */
function parsed(text: string): Workflow {
  return parseWorkflow(text);
}

test('a no-op save (parse, then merge the same workflow back) leaves the text unchanged', () => {
  const wf = parsed(featureText);
  assert.equal(mergeWorkflow(featureText, wf), featureText);
});

test('toggling one step to disabled: the commented-out tests step and every other comment survive', () => {
  const wf = parsed(featureText);
  const loop = wf.steps.find(s => s.id === 'fix-cycle') as { steps: Array<{ id: string; enabled?: boolean }> };
  const execute = loop.steps.find(s => s.id === 'execute')!;
  execute.enabled = false;

  const out = mergeWorkflow(featureText, wf);
  assert.ok(out.includes('# A shell step: no tokens, no runner.'), 'the commented-out tests block survives');
  assert.ok(out.includes('# A human gate. Delete it to let the workflow run unattended.'));
  assert.ok(out.includes('# live terminal chat; artifact harvested afterwards'));
  assert.ok(out.includes('id: execute # headless; may write'));
  assert.ok(/id: execute # headless; may write\n {8}enabled: false\n/.test(out), 'enabled: false lands right after id');
});

test('enabled is inserted after id even when a loop node leads with kind, not id', () => {
  const text = `name: feature-development
steps:
  - kind: loop
    id: human-review
    until: only
    max_iterations: 5
    steps:
      - id: only
        runner: claude
        mode: headless
        writes: false
        output: only.md
        prompt: hi
        verdict: true
`;
  const wf = parsed(text);
  const loop = wf.steps.find(s => s.id === 'human-review') as { enabled?: boolean };
  loop.enabled = false;
  const out = mergeWorkflow(text, wf);
  assert.ok(/kind: loop\n {4}id: human-review\n {4}enabled: false\n {4}until: only/.test(out));
});

test('reordering two steps preserves each one\'s own comment and content, unrestyled', () => {
  const wf = parsed(featureText);
  const [plan, loop, signOff] = wf.steps;
  wf.steps = [loop, plan, signOff];
  const out = mergeWorkflow(featureText, wf);
  const parsedOut = parseYaml(out) as Workflow;
  assert.deepEqual(parsedOut.steps.map(s => s.id), ['fix-cycle', 'plan', 'sign-off']);
  assert.ok(out.includes('# live terminal chat; artifact harvested afterwards'), 'moved node keeps its comment');
  const planIdx = out.indexOf('id: plan');
  const loopIdx = out.indexOf('id: fix-cycle');
  assert.ok(loopIdx < planIdx, 'fix-cycle now precedes plan in the text');
});

test('inserting a brand-new step does not disturb any existing node', () => {
  const wf = parsed(featureText);
  wf.steps.splice(1, 0, {
    kind: 'command', id: 'stage', run: 'git add -A', output: 'stage.log',
  } as unknown as Workflow['steps'][number]);
  const out = mergeWorkflow(featureText, wf);
  assert.ok(out.includes('id: stage'));
  assert.ok(out.includes('run: git add -A'));
  assert.ok(out.includes('# A shell step: no tokens, no runner.'));
  assert.ok(out.includes('# live terminal chat; artifact harvested afterwards'));
});

test('removing a step also removes the comment attached to it (accepted limitation)', () => {
  const wf = parsed(featureText);
  const loop = wf.steps.find(s => s.id === 'fix-cycle') as { steps: Array<{ id: string }> };
  loop.steps = loop.steps.filter(s => s.id !== 'review');
  wf.steps = wf.steps.filter(s => s.id !== 'sign-off');
  const out = mergeWorkflow(featureText, wf);
  assert.ok(!out.includes('# A human gate. Delete it to let the workflow run unattended.'));
  assert.ok(!out.includes('id: sign-off'));
});

test('renaming a step re-emits it, losing its own comment (matching is by id)', () => {
  const wf = parsed(featureText);
  const step = wf.steps[0] as { id: string };
  step.id = 'planning';
  const out = mergeWorkflow(featureText, wf);
  assert.ok(out.includes('id: planning'));
  assert.ok(!out.includes('# live terminal chat; artifact harvested afterwards'));
  // every other comment is untouched
  assert.ok(out.includes('# A shell step: no tokens, no runner.'));
  assert.ok(out.includes('# A human gate. Delete it to let the workflow run unattended.'));
});

test('moving a step carries its comment along with it', () => {
  const wf = parsed(featureText);
  const [plan, loop, signOff] = wf.steps;
  wf.steps = [signOff, plan, loop];
  const out = mergeWorkflow(featureText, wf);
  const commentIdx = out.indexOf('# A human gate. Delete it to let the workflow run unattended.');
  const idIdx = out.indexOf('id: sign-off');
  assert.ok(commentIdx !== -1 && commentIdx < idIdx);
  assert.ok(idIdx < out.indexOf('id: plan'), 'sign-off, with its comment, now leads the file');
});

test('a value change on an untouched-otherwise node only rewrites that key', () => {
  const wf = parsed(featureText);
  const signOff = wf.steps.find(s => s.id === 'sign-off') as { show_diff?: boolean };
  signOff.show_diff = false;
  const out = mergeWorkflow(featureText, wf);
  assert.ok(out.includes('show_diff: false'));
  assert.ok(out.includes('# A human gate. Delete it to let the workflow run unattended.'));
  assert.ok(out.includes('title: Ship it?'));
});

test('falls back to a fresh stringify when the existing text has no map root', () => {
  const wf: Workflow = { name: 'w', steps: [{ kind: 'command', id: 'a', run: 'echo hi', output: 'a.log' }] };
  const out = mergeWorkflow('', wf);
  assert.deepEqual(parseYaml(out), wf);
});

test('a no-op save does not inject kind: agent on a step that omitted it', () => {
  const wf = parsed(featureText);
  const out = mergeWorkflow(featureText, wf);
  assert.ok(!out.includes('kind: agent'), 'plan/execute/review never wrote kind: agent, so a no-op save must not add it');
  assert.equal(out, featureText);
});

test('an untouched inputs: entry survives even when its file key order differs from the schema field order', () => {
  const text = `name: w
inputs:
  base:
    required: false
    default: main
    prompt: Branch to start from
steps:
  - id: a
    kind: command
    run: echo hi
    output: a.log
`;
  const wf = parsed(text);
  const out = mergeWorkflow(text, wf);
  assert.equal(out, text, 'default-before-prompt must not read as a change and blow away the node\'s key order');
});

test('save and reparse a workflow with a normalized blank field: the key is removed from the file, nothing else changes', () => {
  const text = `name: w
steps:
  - id: a
    kind: command
    run: echo hi
    cwd: "   "
    output: a.log
`;
  const wf = parsed(text);
  assert.equal('cwd' in (wf.steps[0] as object), false, 'a blank cwd parses as absent, not as a key with undefined');
  const out = mergeWorkflow(text, wf);
  assert.ok(!out.includes('cwd:'), 'the blank cwd key must be dropped from the file, not stringified as null');
  assert.equal(out, `name: w
steps:
  - id: a
    kind: command
    run: echo hi
    output: a.log
`);
});

test('accepted limitation: an untouched folded (>) scalar is rewrapped onto one line', () => {
  const text = `name: w
steps:
  - id: a
    kind: agent
    runner: claude
    mode: headless
    writes: false
    output: a.md
    prompt: >
      Before you start your discovery, ask the user if there are any files that
      you should be aware of. If there are, ask the user to provide them.
  - id: b
    kind: command
    run: echo hi
    output: b.log
`;
  const wf = parsed(text);
  const out = mergeWorkflow(text, wf);
  // content is unchanged — folding a `>` scalar only changes where the line
  // breaks fall, never the words — but the wrapping the author chose is not
  // preserved, because the stringifier is configured with lineWidth: 0 to stop
  // it from rewrapping ordinary long plain scalars (the worse alternative).
  assert.ok(out.includes(
    'prompt: >\n      Before you start your discovery, ask the user if there are any files that you should be aware of. If there are, ask the user to provide them.',
  ));
});
