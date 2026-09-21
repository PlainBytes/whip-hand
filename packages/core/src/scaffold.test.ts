import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execRunner } from './exec.ts';
import { commandSpec } from './engine/command.ts';
import { discoverStages } from './engine/stages.ts';
import { renderTemplate } from './template.ts';
import { resolveShell } from './shell.ts';
import type { CommandStep, RunCtx } from './types.ts';
import {
  createWorkflow, deleteWorkflow, cloneWorkflow, initWorkspace, workflowTemplate, specDrivenTemplate, featureDevelopmentTemplate,
  stagedFeatureDevelopmentTemplate, updateWorkflow,
} from './scaffold.ts';
import { parseWorkflow, validateWorkflowWarnings, validateWorkflowSemantics, WorkflowError } from './schema.ts';
import { loadWorkspaceConfig } from './config.ts';
import { findStep, flattenSteps } from './steps.ts';
import type { Workflow } from './types.ts';

async function withConfigHome<T>(fn: (configHome: string) => Promise<T>): Promise<T> {
  const configHome = await mkdtemp(join(tmpdir(), 'whiphand-config-home-'));
  const prev = process.env.WHIPHAND_CONFIG_HOME;
  process.env.WHIPHAND_CONFIG_HOME = configHome;
  try {
    return await fn(configHome);
  } finally {
    if (prev === undefined) delete process.env.WHIPHAND_CONFIG_HOME;
    else process.env.WHIPHAND_CONFIG_HOME = prev;
  }
}

/**
 * Every shipped template gives the human sign-off the same shape:
 * `human-review` loops until an approval that can send fresh feedback back to
 * both `execute` and `review` in the inner cycle it wraps — and that inner
 * cycle itself wraps a `test-fix` loop that repeats until `test_command`
 * passes before `review` ever runs.
 */
function assertHumanReviewShape(workflow: Workflow, innerLoopId: string): void {
  const testCommand = workflow.inputs?.test_command;
  assert.ok(testCommand !== undefined, 'test_command input is present');
  assert.equal(testCommand?.default, 'npm test');

  const humanReview = workflow.steps.find(s => s.id === 'human-review');
  assert.ok(humanReview !== undefined, 'human-review loop is present');
  if (humanReview === undefined || humanReview.kind !== 'loop') return assert.fail('human-review is a loop');
  assert.equal(humanReview.until, 'sign-off');

  const signOff = humanReview.steps.find(s => s.id === 'sign-off');
  assert.ok(signOff !== undefined && signOff.kind === 'approval');
  if (signOff === undefined || signOff.kind !== 'approval') return;
  assert.equal(signOff.verdict, true);
  assert.equal(signOff.capture, 'review');
  assert.equal(signOff.show_diff, true);
  assert.ok(signOff.output !== undefined, 'sign-off writes an artifact execute/review can read back');

  const inner = humanReview.steps.find(s => s.id === innerLoopId);
  assert.ok(inner !== undefined && inner.kind === 'loop');
  if (inner === undefined || inner.kind !== 'loop') return;

  const testFix = inner.steps.find(s => s.id === 'test-fix');
  assert.ok(testFix !== undefined && testFix.kind === 'loop', 'test-fix loop is present inside the review cycle');
  if (testFix === undefined || testFix.kind !== 'loop') return;
  const tests = testFix.steps.find(s => s.id === testFix.until);
  assert.ok(tests !== undefined && tests.kind === 'command' && tests.verdict === true,
    'test-fix\'s until is a verdict command step');
  assert.equal(tests?.kind === 'command' ? tests.output : undefined, 'tests.log');

  const execute = testFix.steps.find(s => s.id === 'execute');
  assert.ok(execute !== undefined && execute.kind === 'agent', 'execute is inside test-fix');
  if (execute === undefined || execute.kind !== 'agent') return;
  assert.ok(execute.inputs?.includes('tests'), 'execute reads the tests log');
  assert.ok(execute.inputs?.includes('sign-off'), 'execute reads the sign-off feedback');

  const innerIds = inner.steps.map(s => s.id);
  const review = inner.steps.find(s => s.id === 'review');
  assert.ok(review !== undefined && review.kind === 'agent' && review.verdict === true);
  if (review === undefined || review.kind !== 'agent') return;
  assert.ok(innerIds.indexOf('review') > innerIds.indexOf('test-fix'),
    'review comes after test-fix in the same parent loop');
  assert.ok(review.inputs?.includes('tests'), 'review reads this round\'s passing tests log');
  assert.ok(review.inputs?.includes('sign-off'), 'review reads the sign-off feedback too, to enforce it');
}

test('every shipped template gives the human sign-off the same send-it-back shape', () => {
  for (const [workflow, innerLoopId] of [
    [parseWorkflow(workflowTemplate('my-flow')), 'fix-cycle'],
    [parseWorkflow(specDrivenTemplate()), 'build-cycle'],
    [parseWorkflow(featureDevelopmentTemplate()), 'do-review'],
  ] as const) {
    assertHumanReviewShape(workflow, innerLoopId);
    assert.deepEqual(validateWorkflowWarnings(workflow), []);
    assert.deepEqual(validateWorkflowSemantics(workflow), []);
  }
});

test('workflowTemplate produces a parseable canonical workflow', () => {
  const workflow = parseWorkflow(workflowTemplate('my-flow'));
  assert.equal(workflow.name, 'my-flow');
  assert.equal(
    workflow.description,
    'Plan with a human, then implement, gate on tests, and review in a cycle until the review passes.',
  );
  assert.deepEqual(workflow.steps.map(s => s.id), ['plan', 'human-review']);

  const plan = workflow.steps[0];
  assert.equal(plan.kind === 'agent' && plan.mode, 'interactive');

  // The canonical shape is now a cycle: implement and review repeat until the
  // review passes, wrapped in a human sign-off that can send it round again.
  const humanReview = workflow.steps[1];
  assert.equal(humanReview.kind, 'loop');
  if (humanReview.kind !== 'loop') return;
  assert.deepEqual(humanReview.steps.map(s => s.id), ['fix-cycle', 'sign-off']);
  const fixCycle = humanReview.steps[0];
  assert.equal(fixCycle.kind, 'loop');
  if (fixCycle.kind !== 'loop') return;
  assert.equal(fixCycle.until, 'review');
  assert.deepEqual(fixCycle.steps.map(s => s.id), ['test-fix', 'review']);
  const testFix = fixCycle.steps[0];
  assert.equal(testFix.kind, 'loop');
  if (testFix.kind !== 'loop') return;
  assert.equal(testFix.until, 'tests');
  assert.deepEqual(testFix.steps.map(s => s.id), ['execute', 'tests']);
  const review = fixCycle.steps[1];
  assert.equal(review.kind === 'agent' && review.verdict, true);
});

test('specDrivenTemplate produces a parseable spec-driven workflow', () => {
  const workflow = parseWorkflow(specDrivenTemplate());
  assert.equal(workflow.name, 'spec-driven');
  assert.deepEqual(workflow.steps.map(s => s.id), [
    'functional-plan', 'functional-grill', 'technical-plan', 'technical-grill',
    'build-it', 'human-review',
  ]);

  const functionalGrill = workflow.steps[1];
  assert.equal(functionalGrill.kind === 'agent' && functionalGrill.mode, 'interactive');
  assert.equal(functionalGrill.kind === 'agent' && functionalGrill.output, 'functional-spec.md');

  const technicalGrill = workflow.steps[3];
  assert.equal(technicalGrill.kind === 'agent' && technicalGrill.mode, 'interactive');
  assert.equal(technicalGrill.kind === 'agent' && technicalGrill.output, 'technical-spec.md');

  // 'build-it' is the unchanged brake before implementation ever starts; only
  // the sign-off *after* it gained the send-it-back shape.
  assert.equal(workflow.steps[4].kind, 'approval');

  const humanReview = workflow.steps[5];
  assert.equal(humanReview.kind, 'loop');
  if (humanReview.kind !== 'loop') return;
  assert.deepEqual(humanReview.steps.map(s => s.id), ['build-cycle', 'sign-off']);
  const buildCycle = humanReview.steps[0];
  assert.equal(buildCycle.kind, 'loop');
  if (buildCycle.kind !== 'loop') return;
  assert.equal(buildCycle.until, 'review');
  assert.deepEqual(buildCycle.steps.map(s => s.id), ['test-fix', 'review']);
  const testFix = buildCycle.steps[0];
  assert.equal(testFix.kind, 'loop');
  if (testFix.kind !== 'loop') return;
  assert.equal(testFix.until, 'tests');
  assert.deepEqual(testFix.steps.map(s => s.id), ['execute', 'tests']);
  const review = buildCycle.steps[1];
  assert.equal(review.kind === 'agent' && review.verdict, true);
});

test('featureDevelopmentTemplate produces a parseable workflow, including the backward reference into the loop', () => {
  const workflow = parseWorkflow(featureDevelopmentTemplate());
  assert.equal(workflow.name, 'feature-development');
});

test('stagedFeatureDevelopmentTemplate parses, stages the run folder\'s plans, and gates every stage', () => {
  const wf = parseWorkflow(stagedFeatureDevelopmentTemplate());
  assert.deepEqual(validateWorkflowSemantics(wf), []);
  assert.deepEqual(validateWorkflowWarnings(wf), []);
  const build = wf.steps.find(s => s.id === 'build');
  assert.ok(build && build.kind === 'stages');
  if (!build || build.kind !== 'stages') return;
  assert.equal(build.items, '{{ run.dir }}/plans/*.md');
  const gate = findStep(wf.steps, 'accept');
  assert.ok(gate && gate.kind === 'approval');
  if (!gate || gate.kind !== 'approval') return;
  assert.equal(gate.show_diff, true);
  assert.equal(gate.capture, 'review');
  assert.ok(findStep(wf.steps, 'commit'), 'each stage commits');
});

/**
 * A `show_diff` gate puts the *working tree* against HEAD in front of the human
 * (engine/diff.ts's `workingDiffFiles`), so it shows something only while the
 * implementer's work is still uncommitted. Nothing in the engine enforces that:
 * the write-guard cannot see a commit at all, because committing *removes*
 * porcelain lines rather than adding them, so `diffSnapshots` comes back empty
 * and the gate even volunteers "This stage produced no changes." The prompt is
 * the whole mechanism, which is why it is pinned here — an implementer that
 * commits its own work leaves a human approving a blank screen.
 */
test('every shipped template tells its implementer to leave the work uncommitted', () => {
  const shipped: Array<[string, string]> = [
    ['feature', workflowTemplate('feature')],
    ['feature-development', featureDevelopmentTemplate()],
    ['spec-driven', specDrivenTemplate()],
    ['staged-feature-development', stagedFeatureDevelopmentTemplate()],
  ];
  for (const [name, source] of shipped) {
    const wf = parseWorkflow(source);
    const gate = flattenSteps(wf.steps)
      .map(f => f.step)
      .find(s => (s.kind === 'approval' || s.kind === 'manual') && s.show_diff === true);
    assert.ok(gate, `${name} gates on a diff`);
    const execute = findStep(wf.steps, 'execute');
    assert.ok(execute?.kind === 'agent' && execute.writes === true, `${name}'s implementer writes`);
    if (execute?.kind !== 'agent') return;
    assert.match(
      execute.prompt ?? '', /uncommitted/i,
      `${name}'s 'execute' prompt must tell the agent not to commit, or ${gate?.id}'s diff is empty`,
    );
  }
});

/**
 * The execute report and the review checklist are prompt contracts, so the
 * prompt text is the whole mechanism and is pinned here — in the four shipped
 * templates and in the repo's own four local copies, which must not drift from
 * them. Past runs: a test file "updated" that was not, agreed items silently
 * not built, a reviewer passing an empty diff or an executor's own commit.
 */
test('every shipped and local workflow gives execute a report contract and review a checklist', async () => {
  const localDir = new URL('../../../.whiphand/workflows/', import.meta.url);
  const sources: Array<[string, string]> = [
    ['template feature', workflowTemplate('feature')],
    ['template feature-development', featureDevelopmentTemplate()],
    ['template spec-driven', specDrivenTemplate()],
    ['template staged-feature-development', stagedFeatureDevelopmentTemplate()],
  ];
  for (const name of ['feature', 'feature-development', 'spec-driven', 'staged-feature-development']) {
    sources.push([`local ${name}`, await readFile(new URL(`${name}.yaml`, localDir), 'utf8')]);
  }
  const flat = (prompt: string | undefined): string => (prompt ?? '').replace(/\s+/g, ' ');
  for (const [label, source] of sources) {
    const wf = parseWorkflow(source);
    assert.deepEqual(validateWorkflowSemantics(wf), [], `${label} validates`);
    const execute = findStep(wf.steps, 'execute');
    const review = findStep(wf.steps, 'review');
    if (execute?.kind !== 'agent' || review?.kind !== 'agent') return assert.fail(`${label} has execute and review agents`);

    const run = flat(execute.prompt);
    assert.match(run, /Implement everything the .+ asks\. If something can't or shouldn't be done, don't drop it silently/, label);
    for (const heading of [
      '## Changed', '## Verified', '## Not done / not verified', '## Deviations from the plan', '## Findings addressed',
    ]) {
      assert.ok(run.includes(heading), `${label}'s execute prompt names the report section '${heading}'`);
    }
    assert.match(run, /exact commands you ran and their result\. Run the tests relevant to what you changed, not only the workflow's test command/, label);
    assert.match(run, /leave (your work|it) uncommitted/i, label);

    const check = flat(review.prompt);
    assert.match(check, /Review the uncommitted working-tree diff \(`git diff` plus untracked files\)/, label);
    assert.match(check, /requirement by requirement and state for each whether it is met/, label);
    assert.match(check, /Check every claim in the execute report against the diff\. A false claim is blocking/, label);
    for (const blocking of [
      '- HEAD moved, or the executor committed',
      '- changes outside ',
      '- an empty diff when ',
      ' point that was not addressed',
    ]) {
      assert.ok(check.includes(blocking), `${label}'s review prompt lists '${blocking}' as blocking`);
    }
    assert.match(check, /does not exercise the changed code, say so and run the relevant tests yourself, with read-only commands only/, label);
    assert.match(check, /non-blocking at most/, label);
  }
});

/**
 * The plan prompts are contracts too. Past runs: a staged planner that wrote no
 * `plans/*.md` (run 956e, "matched no stage files"), stage files in the wrong
 * folder so the build took `docs/design.md` for a stage (run d8ba), and a root
 * `npm test` that ran nothing of the stage being built. Every plan prompt, in
 * the shipped templates and the local copies, opens the same way, says the
 * artifact is the plan and not the chat, and (except the WHAT-only functional
 * plan) asks for a `## Verify` section.
 */
test('every shipped and local plan prompt shares the ask-for-files opening and the artifact contract', async () => {
  const localDir = new URL('../../../.whiphand/workflows/', import.meta.url);
  const sources: Array<[string, string]> = [
    ['template feature', workflowTemplate('feature')],
    ['template feature-development', featureDevelopmentTemplate()],
    ['template spec-driven', specDrivenTemplate()],
    ['template staged-feature-development', stagedFeatureDevelopmentTemplate()],
  ];
  for (const name of ['feature', 'feature-development', 'spec-driven', 'staged-feature-development']) {
    sources.push([`local ${name}`, await readFile(new URL(`${name}.yaml`, localDir), 'utf8')]);
  }
  const flat = (prompt: string | undefined): string => (prompt ?? '').replace(/\s+/g, ' ');
  const planIds = ['plan', 'functional-plan', 'technical-plan'];
  for (const [label, source] of sources) {
    const wf = parseWorkflow(source);
    assert.deepEqual(validateWorkflowSemantics(wf), [], `${label} validates`);
    const plans = planIds.flatMap((id) => {
      const step = findStep(wf.steps, id);
      return step === undefined ? [] : [{ id, step }];
    });
    assert.ok(plans.length > 0, `${label} has a plan step`);
    for (const { id, step } of plans) {
      if (step.kind !== 'agent') return assert.fail(`${label} ${id} is an agent step`);
      const prompt = flat(step.prompt);
      const at = `${label} ${id}`;
      assert.match(prompt, /Before exploring, ask me whether there are files or docs you should read first\./, at);
      assert.match(prompt, /The artifact you write is the agreed plan as it now stands, not a transcript of our conversation\./, at);
      assert.doesNotMatch(prompt, /ask the user|always ask for initial files/, `${at} has no ad-hoc ask-for-files wording`);
      if (id === 'functional-plan') {
        assert.ok(!prompt.includes('## Verify'), `${at} stays out of implementation, so it has no Verify section`);
      } else if (!label.endsWith('staged-feature-development')) {
        // The staged plan puts Verify in each stage file instead; the next test pins that.
        assert.match(prompt, /End it with a `## Verify` section: the exact command\(s\) that exercise this change, because the workflow's test command may not cover it\./, at);
      }
    }
  }
});

/**
 * The staged plan prompt is the only thing that tells the planner what a stage
 * file is, where it goes and how to check it did that: the build's `items` glob
 * takes whatever `.md` it finds, so the prompt is the whole guard.
 */
test('the staged plan prompt carries the stage-file template and the listing self-check', async () => {
  const localDir = new URL('../../../.whiphand/workflows/', import.meta.url);
  const sources: Array<[string, string]> = [
    ['template', stagedFeatureDevelopmentTemplate()],
    ['local', await readFile(new URL('staged-feature-development.yaml', localDir), 'utf8')],
  ];
  for (const [label, source] of sources) {
    const plan = findStep(parseWorkflow(source).steps, 'plan');
    assert.ok(plan?.kind === 'agent', `${label} has a plan agent`);
    const raw = plan.prompt ?? '';
    const prompt = raw.replace(/\s+/g, ' ');

    // The template is a heading and five sections, in order, each on its own line.
    const headings = raw.split('\n').filter((line) => /^#{1,2} /.test(line));
    assert.deepEqual(
      headings,
      ['# <Stage title>', '## Goal', '## Scope', '## Out of scope', '## Files', '## Acceptance criteria', '## Verify'],
      `${label} stage-file template`,
    );
    assert.match(prompt, /## Verify The exact command\(s\) that exercise this stage, because the workflow's test command may not cover it\./, label);

    assert.match(prompt, /Order them so each builds on the earlier ones, which the workflow will already have committed/, label);
    assert.match(prompt, /small enough to review in one sitting/, label);
    assert.match(prompt, /Write one file per stage into \{\{ run\.dir \}\}\/plans\/, named NN-slug\.md, and nowhere else\./, label);
    assert.match(prompt, /Change nothing in the repository\./, label);
    assert.match(
      prompt,
      /Before you tell me the plan is done, list \{\{ run\.dir \}\}\/plans\/ and confirm that every stage file is there and that nothing was written elsewhere\./,
      label,
    );
  }
});

/**
 * "Earlier stages are … committed" is background for the staged implementer,
 * not a task: the sentence is worded as the workflow's doing and followed by an
 * explicit "committing is the workflow's job", so it cannot be read as an
 * instruction to commit.
 */
test('the staged execute prompt says the workflow, not the implementer, commits', () => {
  const execute = findStep(parseWorkflow(stagedFeatureDevelopmentTemplate()).steps, 'execute');
  assert.ok(execute?.kind === 'agent');
  const prompt = (execute.prompt ?? '').replace(/\s+/g, ' ');
  assert.match(prompt, /Earlier stages are implemented and already committed by the workflow/);
  assert.match(prompt, /leave it uncommitted: committing is the workflow's job, not yours/);
});

/**
 * A command step's real spec — argv, env and all, exactly what a run would
 * spawn — executed through the resolved POSIX shell. Templates are identical
 * bytes on every platform now, so these run on the Windows leg too (where Git's
 * `sh.exe` is the shell); only a machine with no shell at all skips them.
 */
const shell = resolveShell();
const withShell = { skip: shell.ok ? false : 'no POSIX shell on this machine' };

async function runStep(
  step: CommandStep, cwd: string, env: Record<string, string> = {}, ctx: Partial<RunCtx> = {},
): Promise<void> {
  const base: RunCtx = {
    workdir: cwd, runId: 'r1', runDir: join(cwd, '.whiphand', 'runs', 'r1'), runSlug: 'r1',
    shell: shell.ok ? shell.path : '/bin/sh',
    sessionIds: {}, artifacts: {}, attempts: {}, verdicts: {}, inputs: {}, ...ctx,
  };
  const spec = commandSpec(step, base);
  await execRunner(spec.argv, { cwd, env: { ...process.env, ...spec.env, ...env } });
}

test('featureDevelopmentTemplate stage step works when the runs dir is gitignored and files are already staged', withShell, async () => {
  const stage = parseWorkflow(featureDevelopmentTemplate()).steps.find(s => s.id === 'stage');
  assert.ok(stage && stage.kind === 'command');
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: ws });
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-stage-'));
  await git('init', '-b', 'main');
  await writeFile(join(ws, '.gitignore'), '.whiphand/runs/\n');
  await writeFile(join(ws, 'a.txt'), 'a\n');
  await git('add', '-A');
  await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  await mkdir(join(ws, '.whiphand', 'runs', 'r1'), { recursive: true });
  await writeFile(join(ws, '.whiphand', 'runs', 'r1', 'plan.md'), 'plan\n');
  await writeFile(join(ws, 'a.txt'), 'changed\n');
  await git('add', 'a.txt');
  await writeFile(join(ws, 'b.txt'), 'new\n');

  // The shell a command step really gets, and its real spec. Rejects on a non-zero exit.
  await runStep(stage as CommandStep, ws);

  const { stdout } = await git('diff', '--cached', '--name-only');
  assert.deepEqual(stdout.trim().split('\n'), ['a.txt', 'b.txt']);
});

test('the staged workflow keeps its stage files in the run folder: no plan_dir input, no commit-plan step', () => {
  const wf = parseWorkflow(stagedFeatureDevelopmentTemplate());
  assert.ok(!('plan_dir' in (wf.inputs ?? {})));
  assert.equal(findStep(wf.steps, 'commit-plan'), undefined);
  const plan = findStep(wf.steps, 'plan');
  assert.ok(plan && plan.kind === 'agent');
  if (!plan || plan.kind !== 'agent') return;
  assert.equal(plan.writes, true);
  assert.deepEqual(plan.allow_paths, ['{{ run.dir }}/**']);
  assert.ok(plan.prompt.includes('{{ run.dir }}/plans/'));
});

test("the staged workflow's build glob finds the planner's files under <runDir>/plans, whatever the workdir", async () => {
  const wf = parseWorkflow(stagedFeatureDevelopmentTemplate());
  const build = findStep(wf.steps, 'build');
  assert.ok(build && build.kind === 'stages');
  if (!build || build.kind !== 'stages') return;

  const ws = await mkdtemp(join(tmpdir(), 'whiphand-staged-ws-'));
  const runDir = join(ws, '.whiphand', 'runs', 'r1');
  await mkdir(join(runDir, 'plans'), { recursive: true });
  await writeFile(join(runDir, 'plans', '01-schema.md'), '# Schema\n');
  await writeFile(join(runDir, 'plans', '02-api.md'), '# API\n');
  await writeFile(join(runDir, 'plan.md'), '# Not a stage\n');

  const pattern = renderTemplate(build.items, { inputs: {}, runId: 'r1', runSlug: 'r1', runDir });
  const stages = await discoverStages(ws, pattern);
  assert.deepEqual(stages.map(s => s.id), ['01-schema', '02-api']);
  assert.deepEqual(stages.map(s => s.title), ['Schema', 'API']);
});

test("the staged workflow's stage-body commit step exits 0 on an empty index instead of "
  + "failing the run, and still commits — and still fails — for real", withShell, async () => {
  const commit = findStep(parseWorkflow(stagedFeatureDevelopmentTemplate()).steps, 'commit');
  assert.ok(commit && commit.kind === 'command');
  if (!commit || commit.kind !== 'command') return;

  const ws = await mkdtemp(join(tmpdir(), 'whiphand-stage-commit-'));
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: ws });
  await git('init', '-b', 'main');
  await writeFile(join(ws, 'a.txt'), 'a\n');
  // The step under test runs its own `git commit`, so the identity has to
  // live in the repo, not in -c flags: CI runners have no global one.
  await git('config', 'user.email', 't@t');
  await git('config', 'user.name', 't');
  await git('add', '-A');
  await git('commit', '-m', 'init');
  const head = async () => (await git('rev-parse', 'HEAD')).stdout.trim();
  const before = await head();

  // A stage with no diff is a normal stage (product spec's own edge case):
  // an empty index must exit 0, not fail the run the way a bare `git commit`
  // would (exit 1, "nothing to commit").
  await runStep(commit as CommandStep, ws);
  assert.equal(await head(), before, 'nothing was committed');

  // Something staged: a real commit is made from the message artifact env
  // var the way a running stage would export it.
  await writeFile(join(ws, 'a.txt'), 'changed\n');
  await git('add', 'a.txt');
  const msgPath = join(ws, 'msg.txt');
  await writeFile(msgPath, 'do the thing\n');
  await runStep(commit as CommandStep, ws, { WHIPHAND_ARTIFACT_COMMIT_MESSAGE: msgPath });
  assert.notEqual(await head(), before, 'a real commit was made');
  assert.equal((await git('log', '-1', '--pretty=%s')).stdout.trim(), 'do the thing');

  // A real failure (a bad -F path here, standing in for e.g. a rejecting
  // hook) still exits non-zero — the whole point of not blanket-forgiving
  // exit 1 the way `expect_exit: [0, 1]` would.
  await writeFile(join(ws, 'a.txt'), 'changed again\n');
  await git('add', 'a.txt');
  await assert.rejects(() => runStep(
    commit as CommandStep, ws, { WHIPHAND_ARTIFACT_COMMIT_MESSAGE: join(ws, 'no-such-file.txt') }));
});

test('createWorkflow writes the file, refuses overwrite, validates the name', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const { path } = await createWorkflow(ws, 'my-flow');
  assert.equal(path, join(ws, '.whiphand', 'workflows', 'my-flow.yaml'));
  parseWorkflow(await readFile(path, 'utf8')); // valid on disk

  await assert.rejects(() => createWorkflow(ws, 'my-flow'), /already exists/);
  await assert.rejects(() => createWorkflow(ws, 'Bad Name!'), /invalid workflow name/);
});

test('initWorkspace creates config + starter workflows once, then is a no-op', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const first = await initWorkspace(ws);
  assert.deepEqual(first.created.sort(), [
    join('.whiphand', 'config.yaml'),
    join('.whiphand', 'workflows', 'feature-development.yaml'),
    join('.whiphand', 'workflows', 'feature.yaml'),
    join('.whiphand', 'workflows', 'spec-driven.yaml'),
    join('.whiphand', 'workflows', 'staged-feature-development.yaml'),
  ]);
  await loadWorkspaceConfig(ws); // parses
  const second = await initWorkspace(ws);
  assert.deepEqual(second.created, []);
});

test('initWorkspace tops up a shipped workflow that is missing, even once the workspace is otherwise initialised', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await initWorkspace(ws);
  await rm(join(ws, '.whiphand', 'workflows', 'spec-driven.yaml'));

  const result = await initWorkspace(ws);

  assert.deepEqual(result.created, [join('.whiphand', 'workflows', 'spec-driven.yaml')]);
  parseWorkflow(await readFile(join(ws, '.whiphand', 'workflows', 'spec-driven.yaml'), 'utf8'));
});

function sampleWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: 'my-flow',
    description: 'A sample flow',
    steps: [
      { id: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive', writes: false, prompt: 'Plan it', output: 'plan.md' },
    ],
    ...overrides,
  };
}

test('updateWorkflow overwrites the file in place with the given content', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await createWorkflow(ws, 'my-flow');

  const { path } = await updateWorkflow(ws, 'my-flow', sampleWorkflow({ description: 'Updated description' }));

  assert.equal(path, join(ws, '.whiphand', 'workflows', 'my-flow.yaml'));
  const onDisk = parseWorkflow(await readFile(path, 'utf8'));
  assert.equal(onDisk.description, 'Updated description');
});

test('updateWorkflow locks the workflow name to the target file, ignoring a mismatched payload name', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await createWorkflow(ws, 'my-flow');

  await updateWorkflow(ws, 'my-flow', sampleWorkflow({ name: 'someone-elses-name' }));

  const onDisk = parseWorkflow(await readFile(join(ws, '.whiphand', 'workflows', 'my-flow.yaml'), 'utf8'));
  assert.equal(onDisk.name, 'my-flow');
});

test('updateWorkflow refuses a traversing name instead of writing outside the workflows dir', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await createWorkflow(ws, 'my-flow');
  const escapee = join(ws, 'pwned.yaml');

  await assert.rejects(
    () => updateWorkflow(ws, join('..', '..', 'pwned'), sampleWorkflow()),
    /invalid workflow name/,
  );
  await assert.rejects(() => updateWorkflow(ws, 'not/nested', sampleWorkflow()), /invalid workflow name/);
  await assert.rejects(() => access(escapee), /ENOENT/);
});

test('createWorkflow writes into the global workflows dir when scope is global, mkdir-ing it on demand', async () => {
  await withConfigHome(async configHome => {
    const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
    const { path } = await createWorkflow(ws, 'my-global-flow', 'global');
    assert.equal(path, join(configHome, 'workflows', 'my-global-flow.yaml'));
    parseWorkflow(await readFile(path, 'utf8'));
    // Never touched the project's own .whiphand/workflows.
    await assert.rejects(() => access(join(ws, '.whiphand', 'workflows', 'my-global-flow.yaml')));
  });
});

test('updateWorkflow writes into the global workflows dir when scope is global', async () => {
  await withConfigHome(async configHome => {
    const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
    await createWorkflow(ws, 'my-global-flow', 'global');
    const { path } = await updateWorkflow(
      ws, 'my-global-flow', sampleWorkflow({ description: 'Updated globally' }), 'global',
    );
    assert.equal(path, join(configHome, 'workflows', 'my-global-flow.yaml'));
    const onDisk = parseWorkflow(await readFile(path, 'utf8'));
    assert.equal(onDisk.description, 'Updated globally');
  });
});

test('updateWorkflow rejects a semantically invalid workflow and does not touch the file', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const { path } = await createWorkflow(ws, 'my-flow');
  const before = await readFile(path, 'utf8');

  const invalid = sampleWorkflow({
    steps: [
      { id: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive', writes: false, prompt: 'Plan it', output: 'plan.md' },
      { id: 'plan', kind: 'agent', runner: 'claude', mode: 'headless', writes: true, prompt: 'Do it', output: 'out.md' },
    ],
  });

  await assert.rejects(() => updateWorkflow(ws, 'my-flow', invalid), (e: unknown) =>
    e instanceof WorkflowError && e.problems.some(p => p.includes('duplicate step id')));
  assert.equal(await readFile(path, 'utf8'), before);
});

test('deleteWorkflow removes a project workflow file', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const { path } = await createWorkflow(ws, 'my-flow');

  assert.deepEqual(await deleteWorkflow(ws, 'my-flow'), { deleted: true });
  await assert.rejects(() => access(path), /ENOENT/);
});

test('deleteWorkflow removes a global workflow when scope is global', async () => {
  await withConfigHome(async configHome => {
    const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
    await createWorkflow(ws, 'my-global-flow', 'global');

    assert.deepEqual(await deleteWorkflow(ws, 'my-global-flow', 'global'), { deleted: true });
    await assert.rejects(() => access(join(configHome, 'workflows', 'my-global-flow.yaml')), /ENOENT/);
  });
});

test('deleteWorkflow of a project workflow leaves the global one of the same name in place', async () => {
  await withConfigHome(async configHome => {
    const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
    await createWorkflow(ws, 'shared', 'global');
    await createWorkflow(ws, 'shared');

    assert.deepEqual(await deleteWorkflow(ws, 'shared'), { deleted: true });
    await assert.rejects(() => access(join(ws, '.whiphand', 'workflows', 'shared.yaml')), /ENOENT/);
    await access(join(configHome, 'workflows', 'shared.yaml'));
  });
});

test('deleteWorkflow falls back to <name>.yml', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const dir = join(ws, '.whiphand', 'workflows');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'legacy.yml');
  await writeFile(path, workflowTemplate('legacy'), 'utf8');

  assert.deepEqual(await deleteWorkflow(ws, 'legacy'), { deleted: true });
  await assert.rejects(() => access(path), /ENOENT/);
});

test('deleteWorkflow reports deleted: false when neither file exists', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  assert.deepEqual(await deleteWorkflow(ws, 'never-there'), { deleted: false });
});

test('deleteWorkflow refuses an invalid name instead of unlinking outside the workflows dir', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const escapee = join(ws, '.whiphand', 'x.yaml');
  await mkdir(join(ws, '.whiphand'), { recursive: true });
  await writeFile(escapee, 'name: x\n', 'utf8');

  await assert.rejects(() => deleteWorkflow(ws, join('..', 'x')), /invalid workflow name/);
  await assert.rejects(() => deleteWorkflow(ws, 'Bad Name!'), /invalid workflow name/);
  await access(escapee); // still there
});

test("cloneWorkflow writes <to>.yaml with name: <to>, keeps the source's comments, and leaves the source unchanged", async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const { path: fromPath } = await createWorkflow(ws, 'my-flow');
  const before = await readFile(fromPath, 'utf8');

  const { path } = await cloneWorkflow(ws, 'my-flow', 'my-flow-copy');

  assert.equal(path, join(ws, '.whiphand', 'workflows', 'my-flow-copy.yaml'));
  const cloned = await readFile(path, 'utf8');
  assert.match(cloned, /^name: my-flow-copy$/m);
  assert.ok(cloned.includes('plan interactively, then implement, gate on tests passing'), 'keeps the source\'s leading comment');
  assert.equal(await readFile(fromPath, 'utf8'), before);
});

test('cloneWorkflow refuses to overwrite an existing target and leaves it untouched', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await createWorkflow(ws, 'my-flow');
  await createWorkflow(ws, 'already-there');
  const targetPath = join(ws, '.whiphand', 'workflows', 'already-there.yaml');
  const before = await readFile(targetPath, 'utf8');

  await assert.rejects(
    () => cloneWorkflow(ws, 'my-flow', 'already-there'),
    (e: unknown) => e instanceof Error && (e as NodeJS.ErrnoException).code === 'EEXIST',
  );
  assert.equal(await readFile(targetPath, 'utf8'), before);
});

test('cloneWorkflow stays in the given scope', async () => {
  await withConfigHome(async configHome => {
    const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
    await createWorkflow(ws, 'my-global-flow', 'global');

    const { path } = await cloneWorkflow(ws, 'my-global-flow', 'my-global-flow-copy', 'global');
    assert.equal(path, join(configHome, 'workflows', 'my-global-flow-copy.yaml'));
    await assert.rejects(() => access(join(ws, '.whiphand', 'workflows', 'my-global-flow-copy.yaml')), /ENOENT/);
  });
});

test('cloneWorkflow works from a .yml source', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  const dir = join(ws, '.whiphand', 'workflows');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'legacy.yml'), workflowTemplate('legacy'), 'utf8');

  const { path } = await cloneWorkflow(ws, 'legacy', 'legacy-copy');
  assert.equal(path, join(dir, 'legacy-copy.yaml'));
  const onDisk = parseWorkflow(await readFile(path, 'utf8'));
  assert.equal(onDisk.name, 'legacy-copy');
});

test('cloneWorkflow throws a clear error when the source does not exist', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await assert.rejects(() => cloneWorkflow(ws, 'never-there', 'copy'), /not found/);
});

test('cloneWorkflow rejects an invalid source or target name', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-scaffold-'));
  await createWorkflow(ws, 'my-flow');
  await assert.rejects(() => cloneWorkflow(ws, 'Bad Name!', 'copy'), /invalid workflow name/);
  await assert.rejects(() => cloneWorkflow(ws, 'my-flow', 'Bad Name!'), /invalid workflow name/);
});
