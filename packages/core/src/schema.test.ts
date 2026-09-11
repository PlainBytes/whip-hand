import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, validateWorkflowWarnings, WorkflowError } from './schema.ts';

const VALID = `
name: feature
inputs:
  feature: { required: true, prompt: "What are we building?" }
steps:
  - id: plan
    runner: claude
    model: opus
    mode: interactive
    writes: false
    output: plan.md
    prompt: "Plan {{ inputs.feature }}"
  - id: execute
    runner: copilot
    mode: headless
    writes: true
    inputs: [plan]
    output: report.md
    prompt: "Implement the plan."
  - id: review
    runner: claude
    model: haiku
    mode: headless
    writes: false
    verdict: true
    inputs: [plan, execute]
    output: findings.md
    prompt: "Review the diff."
`;

test('parses a valid workflow', () => {
  const r = parseWorkflow(VALID);
  assert.equal(r.name, 'feature');
  assert.equal(r.steps.length, 3);
  const first = r.steps[0];
  assert.equal(first.kind === 'agent' && first.mode, 'interactive');
  const last = r.steps[2];
  assert.equal(last.kind === 'agent' && last.verdict, true);
});

test('rejects duplicate step ids', () => {
  const y = VALID.replaceAll('id: execute', 'id: plan');
  assert.throws(() => parseWorkflow(y), (e: unknown) =>
    e instanceof WorkflowError && e.problems.some(p => p.includes('duplicate step id')));
});

test('rejects inputs referencing unknown steps', () => {
  const y = VALID.replace('inputs: [plan, execute]', 'inputs: [plan, nonexistent]');
  assert.throws(() => parseWorkflow(y), (e: unknown) =>
    e instanceof WorkflowError && e.problems.some(p => p.includes('nonexistent')));
});

test('rejects inputs referencing later steps', () => {
  const y = VALID.replace('inputs: [plan]', 'inputs: [review]');
  assert.throws(() => parseWorkflow(y), (e: unknown) =>
    e instanceof WorkflowError && e.problems.some(p => p.includes('later step')));
});

test('rejects invalid mode', () => {
  const y = VALID.replace('mode: interactive', 'mode: chat');
  assert.throws(() => parseWorkflow(y), WorkflowError);
});

test('rejects empty steps', () => {
  assert.throws(() => parseWorkflow('name: x\nsteps: []'), WorkflowError);
});

test('accepts an optional description field', () => {
  const y = VALID.replace('name: feature', 'name: feature\ndescription: "Builds the feature end to end"');
  const r = parseWorkflow(y);
  assert.equal(r.description, 'Builds the feature end to end');
});

test('description is optional', () => {
  const r = parseWorkflow(VALID);
  assert.equal(r.description, undefined);
});

test('an input may declare remember: true, and it survives onto the workflow', () => {
  const y = VALID.replace(
    'feature: { required: true, prompt: "What are we building?" }',
    'feature: { required: true, prompt: "What are we building?" }\n  branch: { required: false, remember: true }',
  );
  const r = parseWorkflow(y);
  assert.equal(r.inputs?.branch.remember, true);
  assert.equal(r.inputs?.feature.remember, undefined);
});

// ---------------------------------------------------------------------------
// Step kinds and loops
// ---------------------------------------------------------------------------

const CYCLE = `
name: cycle
steps:
  - id: plan
    runner: claude
    mode: interactive
    writes: false
    output: plan.md
    prompt: "Plan it."
  - id: fix
    kind: loop
    until: review
    max_iterations: 3
    steps:
      - id: execute
        runner: copilot
        mode: headless
        writes: true
        inputs: [plan, review]
        output: report.md
        prompt: "Do it."
      - id: tests
        kind: command
        run: npm test
        verdict: true
        output: tests.log
        expect_exit: 0
      - id: review
        runner: claude
        mode: headless
        writes: false
        verdict: true
        inputs: [plan, execute, tests]
        output: findings.md
        prompt: "Review."
  - id: sign
    kind: approval
    title: "Ship it?"
    instructions: "Look at the diff."
    show_diff: true
    inputs: [review]
  - id: note
    kind: manual
    title: "Release note"
    instructions: "One line."
    capture: note
    output: note.md
`;

function problemsOf(yaml: string): string[] {
  try {
    parseWorkflow(yaml);
    return [];
  } catch (e) {
    return e instanceof WorkflowError ? e.problems : [String(e)];
  }
}

test('a step with no kind is an agent step', () => {
  const r = parseWorkflow(VALID);
  assert.deepEqual(r.steps.map(s => s.kind), ['agent', 'agent', 'agent']);
});

test('parses every step kind, including a nested loop body', () => {
  const r = parseWorkflow(CYCLE);
  assert.deepEqual(r.steps.map(s => s.id), ['plan', 'fix', 'sign', 'note']);
  assert.deepEqual(r.steps.map(s => s.kind), ['agent', 'loop', 'approval', 'manual']);
  const loop = r.steps[1];
  assert.equal(loop.kind, 'loop');
  if (loop.kind !== 'loop') return;
  assert.deepEqual(loop.steps.map(s => s.id), ['execute', 'tests', 'review']);
  assert.equal(loop.until, 'review');
  assert.equal(loop.max_iterations, 3);
});

test('expect_exit accepts a scalar and normalizes it to an array', () => {
  const scalar = parseWorkflow(CYCLE);
  const loop = scalar.steps[1];
  if (loop.kind !== 'loop') throw new Error('expected a loop');
  const tests = loop.steps[1];
  if (tests.kind !== 'command') throw new Error('expected a command');
  assert.deepEqual(tests.expect_exit, [0]);

  const list = parseWorkflow(CYCLE.replace('expect_exit: 0', 'expect_exit: [0, 1]'));
  const listLoop = list.steps[1];
  if (listLoop.kind !== 'loop') throw new Error('expected a loop');
  const listTests = listLoop.steps[1];
  if (listTests.kind !== 'command') throw new Error('expected a command');
  assert.deepEqual(listTests.expect_exit, [0, 1]);
});

test('a loop body step may reference a later sibling — the previous iteration', () => {
  // `execute` references `review`, which comes after it inside the same loop.
  assert.deepEqual(problemsOf(CYCLE), []);
});

test("rejects until that does not name a step in the loop's own body", () => {
  assert.ok(problemsOf(CYCLE.replace('until: review', 'until: plan'))
    .some(p => p.includes('not a step in its body')));
});

test('rejects until naming a step without verdict', () => {
  const y = CYCLE.replace('        verdict: true\n        inputs: [plan, execute, tests]',
    '        inputs: [plan, execute, tests]');
  assert.ok(problemsOf(y).some(p => p.includes("must set 'verdict: true'")));
});

test('rejects on_exhausted: loop', () => {
  const y = CYCLE.replace('    max_iterations: 3', '    max_iterations: 3\n    on_exhausted: loop');
  assert.ok(problemsOf(y).some(p => p.includes('on_exhausted')));
});

test('rejects a forward reference that crosses out of the loop body', () => {
  assert.ok(problemsOf(CYCLE.replace('inputs: [review]\n', 'inputs: [note]\n'))
    .some(p => p.includes('later step')));
});

test('rejects a reference into a loop body from before the loop', () => {
  const y = CYCLE.replace('    output: plan.md', '    inputs: [execute]\n    output: plan.md');
  assert.ok(problemsOf(y).some(p => p.includes('later step')));
});

test('allows a reference into a loop body from after the loop', () => {
  // `sign` references `review`, a loop body step: the final iteration's artifact.
  assert.deepEqual(problemsOf(CYCLE), []);
});

test('rejects referencing a loop, which has no artifact', () => {
  assert.ok(problemsOf(CYCLE.replace('inputs: [review]', 'inputs: [fix]'))
    .some(p => p.includes('produces no artifact')));
});

test('step ids must be unique across loop boundaries', () => {
  assert.ok(problemsOf(CYCLE.replace('      - id: tests', '      - id: plan'))
    .some(p => p.includes('duplicate step id')));
});

test('rejects capture: note without an output', () => {
  const y = CYCLE.replace('    capture: note\n    output: note.md', '    capture: note');
  assert.ok(problemsOf(y).some(p => p.includes("capture 'note' needs an 'output'")));
});

test('names a field that belongs to another kind, instead of silently dropping it', () => {
  const missingKind = problemsOf(CYCLE.replace('    prompt: "Plan it."',
    '    prompt: "Plan it."\n    run: npm test'));
  assert.ok(missingKind.some(p => p.includes("belongs to kind 'command'")),
    `expected a kind hint, got: ${missingKind.join(' | ')}`);

  const foreign = problemsOf(CYCLE.replace('        run: npm test',
    '        run: npm test\n        writes: true'));
  assert.ok(foreign.some(p => p.includes("has no 'writes' field")),
    `expected a foreign-field error, got: ${foreign.join(' | ')}`);
});

test('rejects enabled on the workflow root — it belongs on a step, not the workflow', () => {
  const y = `name: x\nenabled: false\nsteps:\n  - id: a\n    prompt: hi\n    output: a.md\n    writes: false\n    mode: headless\n    runner: claude\n`;
  const problems = problemsOf(y);
  assert.ok(problems.some(p => p === "workflow: 'enabled' belongs on a step, not on the workflow"),
    `expected the root diagnostic, got: ${problems.join(' | ')}`);
});

test('rejects an unknown root key generally, not just enabled — an allow-list, not enabled\'s own special case', () => {
  const y = `name: x\ndescriptoin: typo\nsteps:\n  - id: a\n    prompt: hi\n    output: a.md\n    writes: false\n    mode: headless\n    runner: claude\n`;
  const problems = problemsOf(y);
  assert.ok(problems.some(p => p.includes("'descriptoin'")), `expected a typo diagnostic, got: ${problems.join(' | ')}`);
});

test('a step carrying enabled parses fine — enabled is allowed on every step kind', () => {
  assert.deepEqual(problemsOf(CYCLE.replace('    prompt: "Plan it."', '    enabled: false\n    prompt: "Plan it."')), []);
});

test('rejects an empty loop body', () => {
  const y = `name: x\nsteps:\n  - id: l\n    kind: loop\n    until: a\n    steps: []\n`;
  assert.throws(() => parseWorkflow(y), WorkflowError);
});

// ---------------------------------------------------------------------------
// capture: 'review' and the two non-fatal warnings
// ---------------------------------------------------------------------------

test("accepts capture: 'review'", () => {
  const y = CYCLE.replace('    capture: note\n    output: note.md', '    capture: review\n    output: note.md');
  const r = parseWorkflow(y);
  const note = r.steps[3];
  assert.equal(note.kind === 'manual' && note.capture, 'review');
});

test("rejects capture: 'review' without an output", () => {
  const y = CYCLE.replace('    capture: note\n    output: note.md', '    capture: review');
  assert.ok(problemsOf(y).some(p => p.includes("capture 'review' needs an 'output'")));
});

const REVIEW_LOOP = `
name: x
steps:
  - id: fix
    kind: loop
    until: sign
    steps:
      - id: execute
        runner: claude
        mode: headless
        writes: true
        inputs: [sign]
        output: report.md
        prompt: Do it.
      - id: sign
        kind: approval
        verdict: true
        title: "Ship it?"
        instructions: "Look at the diff."
        show_diff: true
        capture: review
        output: feedback.md
`;

const REVIEW_OUTSIDE_LOOP = `
name: x
steps:
  - id: sign
    kind: approval
    title: "Ship it?"
    instructions: "Look at the diff."
    show_diff: true
    capture: review
    output: feedback.md
`;

test("warns when capture: 'review' sits outside a loop", () => {
  const workflow = parseWorkflow(REVIEW_OUTSIDE_LOOP);
  const warnings = validateWorkflowWarnings(workflow);
  assert.ok(warnings.some(w => w.includes("'review' outside a loop")));
});

test("does not warn when capture: 'review' is the until step of its own loop", () => {
  const workflow = parseWorkflow(REVIEW_LOOP);
  assert.deepEqual(validateWorkflowWarnings(workflow), []);
});

test("warns when capture: 'review' has no show_diff", () => {
  const workflow = parseWorkflow(REVIEW_OUTSIDE_LOOP.replace('    show_diff: true\n', ''));
  const warnings = validateWorkflowWarnings(workflow);
  assert.ok(warnings.some(w => w.includes("without 'show_diff: true'")));
});

test('validateWorkflowWarnings does not fail parsing — these are warnings, not errors', () => {
  assert.doesNotThrow(() => parseWorkflow(REVIEW_OUTSIDE_LOOP));
});

test('a step nested inside an inner loop may reference a later step of an outer loop', () => {
  // The pattern `.whiphand/workflows/feature-development.yaml` uses: an
  // automated review loop nested inside an outer loop that converges on a
  // human's `capture: review` sign-off. `execute`, two levels down, reads
  // `sign-off`'s feedback from the outer loop's previous pass.
  const y = `
name: x
steps:
  - kind: loop
    id: outer
    until: sign-off
    steps:
      - kind: loop
        id: inner
        until: review
        steps:
          - id: execute
            runner: claude
            mode: headless
            writes: true
            inputs: [review, sign-off]
            output: report.md
            prompt: Do it.
          - id: review
            runner: claude
            mode: headless
            writes: false
            verdict: true
            inputs: [execute]
            output: findings.md
            prompt: Review it.
      - id: sign-off
        kind: approval
        verdict: true
        title: "Ship it?"
        instructions: "Look at the diff."
        show_diff: true
        capture: review
        inputs: [review]
        output: feedback.md
`;
  assert.deepEqual(problemsOf(y), []);
});

// ---------------------------------------------------------------------------
// The reserved `attachments` ref
// ---------------------------------------------------------------------------

test('accepts attachments in inputs, even on the very first step', () => {
  const y = VALID.replace('    output: plan.md\n', '    inputs: [attachments]\n    output: plan.md\n');
  const first = parseWorkflow(y).steps[0];
  assert.deepEqual(first.kind === 'agent' ? first.inputs : undefined, ['attachments']);
});

test('attachments is exempt from the unknown, artifact and ordering checks', () => {
  const y = VALID.replace('inputs: [plan, execute]', 'inputs: [attachments, plan, execute]');
  assert.doesNotThrow(() => parseWorkflow(y));
});

test('rejects attachments as a step id', () => {
  const y = VALID.replaceAll('id: plan', 'id: attachments').replaceAll('[plan', '[attachments');
  assert.throws(() => parseWorkflow(y), (e: unknown) =>
    e instanceof WorkflowError && e.problems.some(p => p.includes("step id 'attachments' is reserved")));
});

test('rejects attachments as a loop id — it would collide with the attachments directory', () => {
  assert.ok(problemsOf(CYCLE.replace('- id: fix', '- id: attachments'))
    .some(p => p.includes("loop id 'attachments' is reserved")));
});
