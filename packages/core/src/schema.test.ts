import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkflow, validateWorkflowWarnings, validateWorkflowDraft, formatWorkflowIssues, formatWorkflowFieldIssues,
  workflowSchema, WorkflowError, locateSteps, isForwardRef, unattendedProblems,
} from './schema.ts';
import { featureDevelopmentTemplate } from './scaffold.ts';
import type { Step } from './types.ts';

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

test('an input may declare multiline: false, and it survives onto the workflow', () => {
  const y = VALID.replace(
    'feature: { required: true, prompt: "What are we building?" }',
    'feature: { required: true, prompt: "What are we building?" }\n  branch: { required: false, multiline: false }',
  );
  const r = parseWorkflow(y);
  assert.equal(r.inputs?.branch.multiline, false);
  assert.equal(r.inputs?.feature.multiline, undefined);
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

const REVIEW_IN_STAGES_BODY = `
name: x
steps:
  - id: build
    kind: stages
    items: "plans/*.md"
    steps:
      - id: implement
        runner: claude
        mode: headless
        writes: true
        output: report.md
        prompt: "Implement."
      - id: accept
        kind: approval
        title: "Ship it?"
        instructions: "Look."
        show_diff: true
        capture: review
        output: feedback.md
`;

test("does not warn when capture: 'review' sits directly in a stages body — rejecting it retries the stage", () => {
  const workflow = parseWorkflow(REVIEW_IN_STAGES_BODY);
  assert.deepEqual(validateWorkflowWarnings(workflow), []);
});

test(
  "capture: 'review' inside a stages body still gets the show_diff warning but never the "
  + "'outside a loop' one — proves the body is actually walked, not skipped wholesale",
  () => {
    const workflow = parseWorkflow(REVIEW_IN_STAGES_BODY.replace('        show_diff: true\n', ''));
    assert.deepEqual(validateWorkflowWarnings(workflow), [
      "step 'accept': capture 'review' without 'show_diff: true' has no files to comment on, "
      + 'so it only takes an overall comment',
    ]);
  },
);

test("still warns when capture: 'review' sits outside any loop or stages body, even in a workflow that has stages elsewhere", () => {
  const workflow = parseWorkflow(REVIEW_IN_STAGES_BODY.replace(
    '  - id: build\n',
    `  - id: sign
    kind: approval
    title: "Ship it?"
    instructions: "Look."
    show_diff: true
    capture: review
    output: feedback.md
  - id: build
`,
  ));
  const warnings = validateWorkflowWarnings(workflow);
  assert.deepEqual(warnings, ["step 'sign': capture 'review' outside a loop can never offer 'retry', so it only approves with notes"]);
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

// ---------------------------------------------------------------------------
// Blank handling: '' and spaces-only parse as absent on optional fields,
// and as a validation problem on required ones.
// ---------------------------------------------------------------------------

function draftProblems(raw: unknown): string[] {
  return validateWorkflowDraft(raw).problems;
}

test('output: "" and "   " on a command step parse as absent, with the key missing from the result', () => {
  for (const blank of ['', '   ']) {
    const raw = {
      name: 'x',
      steps: [{ id: 'push', kind: 'command', run: 'git push', output: blank }],
    };
    const { workflow, problems } = validateWorkflowDraft(raw);
    assert.deepEqual(problems, []);
    const step = workflow!.steps[0] as { output?: string };
    assert.equal('output' in step, false, `output key should be absent for ${JSON.stringify(blank)}`);
  }
});

test('output: "" and "   " on a manual step parse as absent', () => {
  const raw = {
    name: 'x',
    steps: [{ id: 'ask', kind: 'manual', title: 't', instructions: 'i', output: '   ' }],
  };
  const { workflow, problems } = validateWorkflowDraft(raw);
  assert.deepEqual(problems, []);
  assert.equal('output' in (workflow!.steps[0] as object), false);
});

test('model, cwd, shell and description parse as absent when blank', () => {
  const raw = {
    name: 'x',
    description: '   ',
    steps: [
      {
        id: 'a', runner: 'claude', mode: 'headless', writes: false, prompt: 'hi', output: 'a.md', model: '',
      },
      { id: 'b', kind: 'command', run: 'echo hi', cwd: '   ', shell: '' },
    ],
  };
  const { workflow, problems } = validateWorkflowDraft(raw);
  assert.deepEqual(problems, []);
  assert.equal('description' in workflow!, false);
  assert.equal('model' in (workflow!.steps[0] as object), false);
  const b = workflow!.steps[1] as { cwd?: string; shell?: string };
  assert.equal('cwd' in b, false);
  assert.equal('shell' in b, false);
});

test('a blank required field is rejected as a validation problem, not silently accepted', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ id: 'a', kind: 'command', run: '   ', output: 'a.log' }, 'Command'],
    [{ id: 'a', runner: 'claude', mode: 'headless', writes: false, prompt: '  ', output: 'a.md' }, 'Prompt'],
    [{ id: 'a', kind: 'manual', title: '  ', instructions: 'i' }, 'Title'],
    [{ id: 'a', kind: 'manual', title: 't', instructions: '  ' }, 'Instructions'],
    [{ id: 'a', runner: '  ', mode: 'headless', writes: false, prompt: 'p', output: 'a.md' }, 'Runner'],
  ];
  for (const [step, label] of cases) {
    const problems = draftProblems({ name: 'x', steps: [step] });
    assert.ok(
      problems.some(p => p.includes(label) && (p.includes("can't be empty") || p.includes('is required'))),
      `expected a ${label} problem, got: ${problems.join(' | ')}`,
    );
  }
});

test('a blank id or until is rejected the same way', () => {
  const blankId = draftProblems({ name: 'x', steps: [{ id: '  ', kind: 'command', run: 'x', output: 'a.log' }] });
  assert.ok(blankId.some(p => p.includes('Step ID') && p.includes('is required')));

  const blankUntil = draftProblems({
    name: 'x',
    steps: [{
      kind: 'loop', id: 'l', until: '  ',
      steps: [{ id: 'a', kind: 'command', run: 'x', output: 'a.log', verdict: true }],
    }],
  });
  assert.ok(blankUntil.some(p => p.includes('Repeat until') && p.includes('is required')));
});

test('an agent step without output gives "Output filename is required"', () => {
  const problems = draftProblems({
    name: 'x',
    steps: [{ id: 'a', runner: 'claude', mode: 'headless', writes: false, prompt: 'hi' }],
  });
  assert.ok(problems.some(p => p === "step 'a': Output filename is required"),
    `got: ${problems.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// formatWorkflowIssues: step naming (by id, or a depth-first ordinal fallback)
// ---------------------------------------------------------------------------

test('the formatter names a nested loop-body step by its id', () => {
  const problems = draftProblems({
    name: 'x',
    steps: [{
      kind: 'loop', id: 'l', until: 'inner',
      steps: [{ id: 'inner', kind: 'command', run: '  ', verdict: true }],
    }],
  });
  assert.ok(problems.some(p => p === "step 'inner': Command is required"), `got: ${problems.join(' | ')}`);
});

test('the formatter falls back to a 1-based depth-first ordinal when the step has no usable id', () => {
  const problems = draftProblems({
    name: 'x',
    steps: [
      { id: 'first', kind: 'command', run: 'x', output: 'a.log' },
      { kind: 'command', run: '  ', output: 'b.log' }, // no id at all
    ],
  });
  assert.ok(problems.some(p => p.startsWith('step #2:')), `got: ${problems.join(' | ')}`);
});

test('formatWorkflowIssues is usable directly against a bare zod parse', () => {
  const raw = { name: 'x', steps: [{ id: 'a', kind: 'command', run: '  ', output: 'a.log' }] };
  const parsed = workflowSchema.safeParse(raw);
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  const problems = formatWorkflowIssues(raw, parsed.error.issues);
  assert.ok(problems.some(p => p === "step 'a': Command is required"), `got: ${problems.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// A present-but-wrong-type value is not "is required" — only an actually
// missing value gets that wording; zod 4 does not put the offending value on
// the issue itself, so the formatter has to walk `raw` to tell the two apart.
// ---------------------------------------------------------------------------

test('a quoted number ("5000") on a numeric field reports the type mismatch, not "is required"', () => {
  const raw = {
    name: 'x',
    steps: [{ id: 'a', kind: 'command', run: 'x', output: 'a.log', timeout_ms: '5000' }],
  };
  const problems = draftProblems(raw);
  assert.ok(problems.some(p => p.startsWith("step 'a': Timeout (ms)") && !p.includes('is required')),
    `got: ${problems.join(' | ')}`);
});

test('a wrong-type value on a required text field reports the type mismatch, not "is required"', () => {
  const raw = { name: 'x', steps: [{ id: 'a', kind: 'command', run: 5, output: 'a.log' }] };
  const problems = draftProblems(raw);
  assert.ok(problems.some(p => p.startsWith("step 'a': Command") && !p.includes('is required')),
    `got: ${problems.join(' | ')}`);
});

test('a genuinely missing required field is still "is required"', () => {
  const raw = { name: 'x', steps: [{ id: 'a', kind: 'command', output: 'a.log' }] };
  const problems = draftProblems(raw);
  assert.ok(problems.some(p => p === "step 'a': Command is required"), `got: ${problems.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// formatWorkflowFieldIssues: structured problems for an editor field
// ---------------------------------------------------------------------------

test('formatWorkflowFieldIssues addresses a shape problem to its step id and field key', () => {
  const raw = { name: 'x', steps: [{ id: 'push', kind: 'command', run: '  ', output: 'a.log' }] };
  const parsed = workflowSchema.safeParse(raw);
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  const [problem] = formatWorkflowFieldIssues(raw, parsed.error.issues);
  assert.deepEqual(
    { stepId: problem.stepId, field: problem.field, phrase: problem.phrase },
    { stepId: 'push', field: 'run', phrase: 'is required' },
  );
});

test('validateWorkflowDraft addresses a semantic "references" problem to the referencing step\'s inputs field', () => {
  const { fieldProblems } = validateWorkflowDraft({
    name: 'x',
    steps: [{ id: 'a', kind: 'command', run: 'x', output: 'a.log', inputs: ['missing'] }],
  });
  const problem = fieldProblems.find(p => p.stepId === 'a');
  assert.equal(problem?.field, 'inputs');
  assert.ok(problem?.phrase.includes('references unknown step'), `got: ${problem?.phrase}`);
});

test('validateWorkflowDraft addresses a loop\'s bad "until" to that loop\'s until field', () => {
  const { fieldProblems } = validateWorkflowDraft({
    name: 'x',
    steps: [{
      kind: 'loop', id: 'l', until: 'nope',
      steps: [{ id: 'a', kind: 'command', run: 'x', output: 'a.log', verdict: true }],
    }],
  });
  const problem = fieldProblems.find(p => p.stepId === 'l');
  assert.equal(problem?.field, 'until');
  assert.ok(problem?.phrase.includes('not a step in its body'), `got: ${problem?.phrase}`);
});

test('validateWorkflowDraft addresses a manual step\'s capture without an output to that step\'s output field', () => {
  const { fieldProblems } = validateWorkflowDraft({
    name: 'x',
    steps: [{ id: 'm', kind: 'manual', title: 't', instructions: 'i', capture: 'note' }],
  });
  const problem = fieldProblems.find(p => p.stepId === 'm');
  assert.equal(problem?.field, 'output');
  assert.equal(problem?.message, "step 'm': capture 'note' needs an 'output' to write it to");
});

test('validateWorkflowDraft still addresses any other semantic problem that names a step to that step', () => {
  const { fieldProblems } = validateWorkflowDraft({
    name: 'x',
    steps: [{
      kind: 'loop', id: 'l', until: 'a', on_exhausted: 'loop',
      steps: [{ id: 'a', kind: 'command', run: 'x', output: 'a.log', verdict: true }],
    }],
  });
  const problem = fieldProblems.find(p => p.message.includes('on_exhausted'));
  assert.equal(problem?.stepId, 'l');
  assert.equal(problem?.field, undefined);
});

// ---------------------------------------------------------------------------
// Input names
// ---------------------------------------------------------------------------

test('an empty input name is rejected', () => {
  const problems = draftProblems({
    name: 'x',
    inputs: { '': { required: true } },
    steps: [{ id: 'a', kind: 'command', run: 'x', output: 'a.log' }],
  });
  assert.ok(problems.some(p => p === 'input name is required'), `got: ${problems.join(' | ')}`);
});

test("an input name with a space ('my input') is rejected", () => {
  const problems = draftProblems({
    name: 'x',
    inputs: { 'my input': { required: true } },
    steps: [{ id: 'a', kind: 'command', run: 'x', output: 'a.log' }],
  });
  assert.ok(problems.some(p => p.includes("input name 'my input' must use letters, digits, '-' or '_'")),
    `got: ${problems.join(' | ')}`);
});

test("'my-input_1' is an accepted input name", () => {
  const problems = draftProblems({
    name: 'x',
    inputs: { 'my-input_1': { required: true } },
    steps: [{ id: 'a', kind: 'command', run: 'x', output: 'a.log' }],
  });
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// A loop as its own until target
// ---------------------------------------------------------------------------

test('a loop named as its own until target gets the loop-specific message', () => {
  const problems = draftProblems({
    name: 'x',
    steps: [{
      kind: 'loop', id: 'outer', until: 'inner',
      steps: [{
        kind: 'loop', id: 'inner', until: 'leaf',
        steps: [{ id: 'leaf', kind: 'command', run: 'x', output: 'a.log', verdict: true }],
      }],
    }],
  });
  assert.ok(problems.some(p => p === "loop 'outer': until step 'inner' is a loop "
    + '— it must name a non-loop step with verdict on'), `got: ${problems.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// parseWorkflow uses the new formatter's wording, not zod's raw JSON
// ---------------------------------------------------------------------------

test('parseWorkflow error text uses the new plain-language format', () => {
  const y = `
name: x
steps:
  - id: push
    kind: command
    run: git push
    output: ""
`;
  // output: "" now parses as absent on a command step, so this is valid.
  assert.doesNotThrow(() => parseWorkflow(y));

  const badY = `
name: x
steps:
  - id: a
    runner: claude
    mode: headless
    writes: false
    prompt: ""
`;
  assert.throws(() => parseWorkflow(badY), (e: unknown) => {
    if (!(e instanceof WorkflowError)) return false;
    assert.ok(e.problems.some(p => p === "step 'a': Prompt is required"), `got: ${e.problems.join(' | ')}`);
    assert.ok(!e.message.includes('"origin"'), 'must not be zod\'s raw JSON issue dump');
    return true;
  });
});

// ---------------------------------------------------------------------------
// locateSteps / isForwardRef — what the runner's scopeInputs uses to tell a
// forward reference (this loop's previous iteration) from a backward one.
// ---------------------------------------------------------------------------

const NESTED_STEPS: Step[] = [
  {
    kind: 'loop', id: 'outer', until: 'sign-off', steps: [
      {
        kind: 'loop', id: 'inner', until: 'tests', steps: [
          {
            id: 'execute', kind: 'agent', runner: 'claude', mode: 'headless', writes: true,
            inputs: ['tests', 'review', 'sign-off'], output: 'report.md', prompt: 'Do it.',
          },
          { id: 'tests', kind: 'command', verdict: true, output: 'tests.log', run: 'npm test' },
        ],
      },
      {
        id: 'review', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, verdict: true,
        inputs: ['execute', 'tests'], output: 'findings.md', prompt: 'Review it.',
      },
    ],
  },
  {
    id: 'sign-off', kind: 'approval', verdict: true, title: 'Ship it?', instructions: 'Look at the diff.',
    capture: 'review', show_diff: true, inputs: ['review'], output: 'feedback.md',
  },
];

test('locateSteps records each step\'s document-order path, enclosing loop and loop chain', () => {
  const located = locateSteps(NESTED_STEPS);
  assert.deepEqual(located.get('execute')?.parentLoopId, 'inner');
  assert.deepEqual(located.get('execute')?.loopChain, ['outer', 'inner']);
  assert.deepEqual(located.get('tests')?.parentLoopId, 'inner');
  assert.deepEqual(located.get('review')?.parentLoopId, 'outer');
  assert.deepEqual(located.get('review')?.loopChain, ['outer']);
  assert.equal(located.get('sign-off')?.parentLoopId, undefined);
  assert.deepEqual(located.get('sign-off')?.loopChain, []);
});

test('isForwardRef is true for a later sibling, false for an earlier one or an unknown id', () => {
  const located = locateSteps(NESTED_STEPS);
  assert.equal(isForwardRef(located, 'execute', 'tests'), true);
  assert.equal(isForwardRef(located, 'execute', 'review'), true);
  assert.equal(isForwardRef(located, 'execute', 'sign-off'), true);
  assert.equal(isForwardRef(located, 'review', 'execute'), false);
  assert.equal(isForwardRef(located, 'tests', 'execute'), false);
  assert.equal(isForwardRef(located, 'execute', 'execute'), false);
  assert.equal(isForwardRef(located, 'nonexistent', 'tests'), false);
  assert.equal(isForwardRef(located, 'execute', 'nonexistent'), false);
});

// ---------------------------------------------------------------------------
// `kind: stages` — parse, validate, flatten. No runner support yet.
// ---------------------------------------------------------------------------

const STAGED_YAML = `
name: staged
inputs:
  plan_dir: { required: true }
steps:
  - id: plan
    runner: claude
    mode: interactive
    writes: false
    output: plan.md
    prompt: "Plan it."
  - id: build
    kind: stages
    items: "{{ inputs.plan_dir }}/*.md"
    steps:
      - id: implement
        runner: claude
        mode: headless
        writes: true
        inputs: [stage]
        output: report.md
        prompt: "Implement {{ stage.title }}."
      - id: review
        runner: claude
        mode: headless
        writes: false
        verdict: true
        inputs: [implement]
        output: review.md
        prompt: "Review."
`;

const STAGES_IN_LOOP = `
name: x
steps:
  - kind: loop
    id: cycle
    until: gate
    steps:
      - id: build
        kind: stages
        items: "plans/*.md"
        steps:
          - id: implement
            runner: claude
            mode: headless
            writes: true
            output: report.md
            prompt: "Do it."
      - id: gate
        kind: approval
        verdict: true
        title: "Ship it?"
        instructions: "Look."
`;

const STAGES_IN_STAGES = `
name: x
steps:
  - id: outer
    kind: stages
    items: "plans/*.md"
    steps:
      - id: inner
        kind: stages
        items: "sub/*.md"
        steps:
          - id: leaf
            runner: claude
            mode: headless
            writes: true
            output: report.md
            prompt: "Do it."
`;

const UNTIL_STAGES = `
name: x
steps:
  - kind: loop
    id: cycle
    until: build
    steps:
      - id: build
        kind: stages
        items: "plans/*.md"
        steps:
          - id: implement
            runner: claude
            mode: headless
            writes: true
            output: report.md
            prompt: "Do it."
      - id: gate
        kind: approval
        verdict: true
        title: "Ship it?"
        instructions: "Look."
`;

const STAGES_LOOP_NO_GATE = `
name: x
steps:
  - id: build
    kind: stages
    items: "plans/*.md"
    steps:
      - kind: loop
        id: cycle
        until: review
        steps:
          - id: implement
            runner: claude
            mode: headless
            writes: true
            inputs: [stage]
            output: report.md
            prompt: "Implement {{ stage.title }}."
          - id: review
            runner: claude
            mode: headless
            writes: false
            verdict: true
            inputs: [implement]
            output: review.md
            prompt: "Review."
`;

const STAGES_GATE_ONLY_INSIDE_LOOP = `
name: x
steps:
  - id: build
    kind: stages
    items: "plans/*.md"
    steps:
      - kind: loop
        id: cycle
        until: gate
        steps:
          - id: implement
            runner: claude
            mode: headless
            writes: true
            output: report.md
            prompt: "Implement."
          - id: gate
            kind: approval
            verdict: true
            title: "Ship it?"
            instructions: "Look."
`;

const STAGE_STEP_READ_WITHOUT_STAGES = `
name: x
steps:
  - id: stage
    kind: command
    run: "git add -A"
    output: stage.log
  - id: after
    runner: claude
    mode: headless
    writes: false
    inputs: [stage]
    output: after.md
    prompt: "Look."
`;

const STAGED_WITH_STAGE_ID = `
name: x
steps:
  - id: stage
    runner: claude
    mode: headless
    writes: false
    output: x.md
    prompt: "Hi."
  - id: build
    kind: stages
    items: "plans/*.md"
    steps:
      - id: implement
        runner: claude
        mode: headless
        writes: true
        output: report.md
        prompt: "Implement."
`;

const STAGE_REF_OUTSIDE = `
name: x
steps:
  - id: plan
    runner: claude
    mode: headless
    writes: false
    inputs: [stage]
    output: plan.md
    prompt: "Plan."
`;

const REF_TO_STAGES = `
name: x
steps:
  - id: build
    kind: stages
    items: "plans/*.md"
    steps:
      - id: implement
        runner: claude
        mode: headless
        writes: true
        output: report.md
        prompt: "Implement."
  - id: summarize
    runner: claude
    mode: headless
    writes: false
    inputs: [build]
    output: summary.md
    prompt: "Summarize."
`;

const ITEMS_ON_AGENT = `
name: x
steps:
  - id: a
    kind: agent
    runner: claude
    mode: headless
    writes: false
    output: a.md
    prompt: "Hi"
    items: "plans/*.md"
`;

test('a stages step parses with its glob, body and default retries', () => {
  const stages = parseWorkflow(STAGED_YAML).steps[1];
  assert.equal(stages.kind, 'stages');
  assert.equal(stages.kind === 'stages' && stages.items, '{{ inputs.plan_dir }}/*.md');
});

test('a stages step inside a loop or inside another stages step is refused', () => {
  assert.throws(() => parseWorkflow(STAGES_IN_LOOP), /stages step 'build' cannot run inside a loop/);
  assert.throws(() => parseWorkflow(STAGES_IN_STAGES), /stages step 'inner' cannot run inside another stages step/);
});

test("a loop's until cannot name a stages step", () => {
  assert.throws(() => parseWorkflow(UNTIL_STAGES), /until step 'build' is a stages step/);
});

test('a loop inside a stages body must be followed by a human step', () => {
  assert.throws(() => parseWorkflow(STAGES_LOOP_NO_GATE),
    /stages step 'build': loop 'cycle' needs a manual or approval step after it, or an exhausted cycle has no one to accept it/);
});

test("a gate inside the loop's own body does not count as a gate after it", () => {
  assert.throws(() => parseWorkflow(STAGES_GATE_ONLY_INSIDE_LOOP),
    /stages step 'build': loop 'cycle' needs a manual or approval step after it/);
});

const STAGES_ONLY_GATE_DISABLED = `
name: x
steps:
  - id: build
    kind: stages
    items: "plans/*.md"
    steps:
      - kind: loop
        id: cycle
        until: review
        steps:
          - id: implement
            runner: claude
            mode: headless
            writes: true
            output: report.md
            prompt: "Implement."
          - id: review
            runner: claude
            mode: headless
            writes: false
            verdict: true
            inputs: [implement]
            output: review.md
            prompt: "Review."
      - kind: approval
        id: accept
        enabled: false
        title: Accept?
        instructions: Look.
`;

test('a disabled gate does not count as the human step after a loop — it never runs', () => {
  assert.throws(() => parseWorkflow(STAGES_ONLY_GATE_DISABLED),
    /stages step 'build': loop 'cycle' needs a manual or approval step after it/);
  // The same workflow with that gate enabled is fine: the disable is what fails it.
  parseWorkflow(STAGES_ONLY_GATE_DISABLED.replace('        enabled: false\n', ''));
});

const STAGE_ARTIFACT_READ_OUTSIDE = `
name: x
steps:
  - id: build
    kind: stages
    items: "plans/*.md"
    steps:
      - id: implement
        runner: claude
        mode: headless
        writes: true
        output: report.md
        prompt: "Implement."
  - id: summarize
    runner: claude
    mode: headless
    writes: false
    inputs: [implement]
    output: summary.md
    prompt: "Summarize."
`;

test('a step outside a stages step cannot read a step declared inside its body', () => {
  assert.throws(() => parseWorkflow(STAGE_ARTIFACT_READ_OUTSIDE),
    /step 'summarize' references step 'implement' inside stages step 'build', whose artifacts do not outlive a stage/);
});

test("without a stages step, inputs: [stage] still resolves to a real step named 'stage'", () => {
  parseWorkflow(STAGE_STEP_READ_WITHOUT_STAGES);
});

test("'stage' is only reserved in a workflow that has a stages step", () => {
  parseWorkflow(featureDevelopmentTemplate());          // has `id: stage`, no stages step — still parses
  assert.throws(() => parseWorkflow(STAGED_WITH_STAGE_ID),
    /step id 'stage' is reserved for the current stage file; rename it/);
});

test('inputs: [stage] is allowed inside a stages body and refused outside one', () => {
  parseWorkflow(STAGED_YAML);
  assert.throws(() => parseWorkflow(STAGE_REF_OUTSIDE),
    /step 'plan' reads 'stage', which only exists inside a stages step/);
});

test('a step referencing the stages step itself is refused — it produces no artifact', () => {
  assert.throws(() => parseWorkflow(REF_TO_STAGES), /references stages step 'build', which produces no artifact/);
});

test("misplaced 'items' names the kind it belongs to", () => {
  assert.throws(() => parseWorkflow(ITEMS_ON_AGENT),
    /kind 'agent' has no 'items' field \(it belongs to kind 'stages'\)/);
});

// ---------------------------------------------------------------------------
// unattendedProblems
// ---------------------------------------------------------------------------

const STAGED_WORKFLOW = `
name: x
steps:
  - id: build
    kind: stages
    items: "plans/*.md"
    steps:
      - id: implement
        runner: claude
        mode: headless
        writes: true
        output: report.md
        prompt: "Implement."
      - id: accept
        kind: approval
        title: "Ship it?"
        instructions: "Look."
`;

const STAGED_WORKFLOW_WITH_DEFAULT = STAGED_WORKFLOW.replace(
  '        instructions: "Look."\n', '        instructions: "Look."\n        default: continue\n');

test('--yes refuses a staged workflow whose gate has no explicit default', () => {
  assert.deepEqual(unattendedProblems(parseWorkflow(STAGED_WORKFLOW)), [
    "step 'accept': a gate inside stages step 'build' must set an explicit 'default' to run under --yes",
  ]);
  assert.deepEqual(unattendedProblems(parseWorkflow(STAGED_WORKFLOW_WITH_DEFAULT)), []);
});

test('a gate outside any stages step is left alone: --yes has always been allowed to answer it', () => {
  const workflow = `
name: x
steps:
  - id: sign
    kind: approval
    title: "Ship it?"
    instructions: "Look."
`;
  assert.deepEqual(unattendedProblems(parseWorkflow(workflow)), []);
});

test('a gate nested inside a loop inside a stages body is still caught', () => {
  const workflow = `
name: x
steps:
  - id: build
    kind: stages
    items: "plans/*.md"
    steps:
      - kind: loop
        id: cycle
        until: review
        steps:
          - id: implement
            runner: claude
            mode: headless
            writes: true
            inputs: [stage]
            output: report.md
            prompt: "Implement {{ stage.title }}."
          - id: review
            runner: claude
            mode: headless
            writes: false
            verdict: true
            inputs: [implement]
            output: review.md
            prompt: "Review."
      - id: accept
        kind: approval
        title: "Ship it?"
        instructions: "Look."
`;
  assert.deepEqual(unattendedProblems(parseWorkflow(workflow)), [
    "step 'accept': a gate inside stages step 'build' must set an explicit 'default' to run under --yes",
  ]);
});

test('a disabled gate inside a stages step is never reached, so it is not a --yes problem', () => {
  const workflow = `
name: x
steps:
  - id: build
    kind: stages
    items: "plans/*.md"
    steps:
      - id: implement
        runner: claude
        mode: headless
        writes: true
        output: report.md
        prompt: "Implement."
      - id: accept
        kind: approval
        enabled: false
        title: "Ship it?"
        instructions: "Look."
      - id: fallback
        kind: approval
        default: continue
        title: "Ship it anyway?"
        instructions: "Look."
`;
  assert.deepEqual(unattendedProblems(parseWorkflow(workflow)), []);
});
