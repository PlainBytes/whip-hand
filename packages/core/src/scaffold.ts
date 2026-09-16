/**
 * Workspace/workflow scaffolding (product def F8/F9). Shared by the CLI
 * (`whiphand init`, `whiphand new-workflow`) and the desktop app (via @whiphand/agent RPCs) so
 * the UI never grows an ability the CLI lacks.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { globalWorkflowsDir } from './config-home.ts';
import { DEFAULT_CONFIG } from './config.ts';
import { WorkflowError, parseWorkflow, validateWorkflowSemantics } from './schema.ts';
import { mergeWorkflow } from './workflow-write.ts';
import type { Scope, Workflow } from './types.ts';
import { WORKFLOW_NAME_RE } from './workflow-name.ts';

export { WORKFLOW_NAME_RE } from './workflow-name.ts';

/**
 * Every writer *and reader* must run this before interpolating `name` into a
 * path. The pattern admits no `/`, `.` or `..`, so a caller-supplied name can
 * never escape .whiphand/workflows or the global workflows dir — the desktop webview
 * reaches these functions over RPC (see @whiphand/agent) and its input is not
 * trusted. Exported for workspace.ts's `resolveWorkflowPath`, which joins a
 * name into the same two directories from the read side.
 */
export function assertValidWorkflowName(name: string): void {
  if (!WORKFLOW_NAME_RE.test(name)) {
    throw new Error(`invalid workflow name '${name}' (want ${WORKFLOW_NAME_RE})`);
  }
}

export function workflowTemplate(name: string): string {
  return `# ${name} — plan interactively, then implement, gate on tests passing, and
# review in a cycle until the review passes, then a human sign-off that can
# send it back for another cycle. Reference: docs/design.md
name: ${name}
description: Plan with a human, then implement, gate on tests, and review in a cycle until the review passes.
inputs:
  feature:
    required: true
    prompt: What are we building?
  test_command:
    required: false
    default: npm test
    prompt: Test command (leave blank to skip tests)
    remember: true
    multiline: false
steps:
  - id: plan          # live terminal chat; artifact harvested afterwards
    runner: claude
    mode: interactive
    writes: false
    output: plan.md
    prompt: |
      We are planning: {{ inputs.feature }}. Work with me on a plan. Do not modify files.

  # Repeats until 'sign-off' is approved. Requesting changes there attaches
  # fresh feedback ('sign-off' as a forward reference) and sends fix-cycle
  # round again — delete this whole loop, keeping fix-cycle at the top level,
  # to let the workflow run unattended instead.
  - id: human-review
    kind: loop
    until: sign-off
    max_iterations: 5
    steps:
      - id: fix-cycle   # repeats its body until 'review' returns VERDICT: PASS
        kind: loop
        until: review
        max_iterations: 3
        steps:
          # Repeats until the tests pass, handing the failing log back to
          # 'execute' each time. 'review' only runs once they are green. A
          # blank test_command runs 'sh -c ""', which exits 0, so tests pass
          # immediately and are effectively skipped.
          - id: test-fix
            kind: loop
            until: tests
            max_iterations: 3
            steps:
              - id: execute   # headless; may write
                runner: claude
                mode: headless
                writes: true
                # 'tests' is later in THIS loop, so it means the PREVIOUS
                # iteration's log; 'review' and 'sign-off' are later siblings
                # of the OUTER loops, so they mean the previous ROUND's
                # findings/feedback — all three are simply skipped, on the
                # first pass of each, when there is nothing yet to read.
                inputs: [plan, tests, review, sign-off]
                output: execute-report.md
                prompt: |
                  Implement the attached plan. If a tests log marked VERDICT: FAIL
                  is attached, fix every failure it shows before anything else.
                  If review findings or sign-off feedback are attached, address
                  every point.
              - id: tests
                kind: command
                run: "{{ inputs.test_command }}"
                verdict: true         # a failing exit sends the loop round again, not a crash
                output: tests.log
                timeout_ms: 1800000   # a hung suite fails the run (resumable) rather than blocking forever

          - id: review    # headless, read-only, must end with VERDICT: PASS|FAIL
            runner: claude
            mode: headless
            writes: false
            verdict: true
            inputs: [plan, execute, tests, sign-off]
            output: review.md
            prompt: |
              Review the implementation against the attached plan. If sign-off
              feedback is attached, FAIL unless every requested change is addressed.

      # A human gate. Its answer becomes the 'sign-off' both steps above read:
      # approving exits both loops, requesting changes sends fix-cycle round again.
      - id: sign-off
        kind: approval
        verdict: true
        title: Ship it?
        instructions: Approve, or request changes with comments on the whole change or on individual files.
        show_diff: true
        capture: review
        inputs: [review]
        output: feedback.md
`;
}

/**
 * The second workflow `whiphand init` ships: two planning phases, each followed by
 * a live session where the agent grills the human about what was just
 * planned, then the classic implementation/review cycle behind a human gate.
 * Fixed content, unlike `workflowTemplate` — `whiphand new-workflow` does not offer
 * this shape, and nothing on the `@whiphand/agent` RPC surface needs it. Exported
 * only so scaffold.test.ts can parse it directly.
 */
export function specDrivenTemplate(): string {
  return `# spec-driven — settle WHAT, then HOW, grilling each with you, then build,
# gate on tests passing, and review in a cycle until the review passes.
# Reference: docs/design.md
name: spec-driven
description: A functional spec and a technical spec, each grilled, then a build/test/review cycle.
inputs:
  feature:
    required: true
    prompt: What are we building?
  test_command:
    required: false
    default: npm test
    prompt: Test command (leave blank to skip tests)
    remember: true
    multiline: false
steps:
  - id: functional-plan       # live chat: what it must do, and for whom
    runner: claude
    model: opus
    mode: interactive
    writes: false
    output: functional-plan.md
    prompt: |
      We are settling WHAT to build, not how: {{ inputs.feature }}
      Work with me on the problem, who it serves, the behaviour, the edge
      cases, what is explicitly out of scope, and how we will know it works.
      Stay out of implementation — no file layout, no APIs, no libraries.
      One question at a time. Do not modify files.

  - id: functional-grill      # live chat: it attacks the draft, you defend it
    runner: claude
    model: opus
    mode: interactive
    writes: false
    inputs: [functional-plan]
    output: functional-spec.md
    prompt: |
      Grill me on the attached functional plan for: {{ inputs.feature }}
      Attack it: unstated assumptions, success criteria too vague to fail,
      missing edge cases, scope that crept in, requirements that can be read
      two ways. One challenge at a time; push back when an answer hand-waves.
      When it holds up, the artifact you write is the REVISED functional
      spec as it now stands — not a transcript of the argument.
      Do not modify files.

  - id: technical-plan        # live chat: how, against the settled spec
    runner: claude
    model: opus
    mode: interactive
    writes: false
    inputs: [functional-grill]
    output: technical-plan.md
    prompt: |
      The functional spec is settled. Work with me on HOW to build it in this
      codebase: the components and their boundaries, data flow, what existing
      code changes, error handling, and how it gets tested. Read the code
      before proposing structure. One question at a time. Do not modify files.

  - id: technical-grill
    runner: claude
    model: opus
    mode: interactive
    writes: false
    inputs: [functional-grill, technical-plan]
    output: technical-spec.md
    prompt: |
      Grill me on the attached technical plan. Attack it: does it actually
      deliver the functional spec, what breaks under failure, what did it
      invent that the codebase already has, where are the boundaries wrong,
      what is unnecessary. One challenge at a time.
      The artifact you write is the REVISED technical spec as it now stands.
      Do not modify files.

  - id: build-it              # the brake: stop before spending on implementation
    kind: approval
    title: Build this?
    instructions: |
      Both specs are settled. Continuing starts the implementation cycle,
      which writes code without stopping to ask.
    inputs: [functional-grill, technical-grill]

  # Repeats until 'sign-off' is approved. Requesting changes there attaches
  # fresh feedback ('sign-off' as a forward reference) and sends build-cycle
  # round again.
  - id: human-review
    kind: loop
    until: sign-off
    max_iterations: 5
    steps:
      - id: build-cycle
        kind: loop
        until: review
        max_iterations: 3
        steps:
          # Repeats until the tests pass, handing the failing log back to
          # 'execute' each time. 'review' only runs once they are green. A
          # blank test_command runs 'sh -c ""', which exits 0, so tests pass
          # immediately and are effectively skipped.
          - id: test-fix
            kind: loop
            until: tests
            max_iterations: 3
            steps:
              - id: execute
                runner: claude
                model: sonnet     # the specs did the thinking; this half is cheap
                mode: headless
                writes: true
                # 'tests' is later in THIS loop, so it means the PREVIOUS
                # iteration's log; 'review' and 'sign-off' are later siblings
                # of the OUTER loops, so they mean the previous ROUND's
                # findings/feedback — all three are simply skipped, on the
                # first pass of each, when there is nothing yet to read.
                inputs: [functional-grill, technical-grill, tests, review, sign-off]
                output: execute-report.md
                prompt: |
                  Implement the attached technical spec. It serves the functional
                  spec; where they disagree, say so rather than guessing. If a
                  tests log marked VERDICT: FAIL is attached, fix every failure it
                  shows before anything else. If sign-off feedback is attached,
                  address every requested change.
              - id: tests
                kind: command
                run: "{{ inputs.test_command }}"
                verdict: true         # a failing exit sends the loop round again, not a crash
                output: tests.log
                timeout_ms: 1800000   # a hung suite fails the run (resumable) rather than blocking forever

          - id: review
            runner: claude
            model: opus
            mode: headless
            writes: false
            verdict: true
            inputs: [functional-grill, technical-grill, execute, tests, sign-off]
            output: review.md
            prompt: |
              Review the implementation against both specs — the functional one
              for whether it does the right thing, the technical one for whether
              it was built the agreed way. If sign-off feedback is attached, FAIL
              unless every requested change is addressed.
              End with VERDICT: PASS or VERDICT: FAIL.

      # A human gate. Its answer becomes the 'sign-off' both steps above read:
      # approving exits both loops, requesting changes sends build-cycle round again.
      - id: sign-off
        kind: approval
        verdict: true
        title: Ship it?
        instructions: Approve, or request changes with comments on the whole change or on individual files.
        show_diff: true
        capture: review
        inputs: [review]
        output: feedback.md
`;
}

/**
 * The third workflow `whiphand init` ships: the same plan → implement/review
 * cycle → sign-off body as `workflowTemplate`, but on its own branch — it syncs
 * the base branch, cuts `feature/<run slug>`, and commits the signed-off work
 * with a message an agent writes from the diff. Fixed content, unlike
 * `workflowTemplate` — `whiphand new-workflow` does not offer this shape.
 * Exported only so scaffold.test.ts can parse it directly.
 */
export function featureDevelopmentTemplate(): string {
  return `# feature-development — branch off trunk, plan, implement, gate on tests
# passing, and review in a cycle, then commit on sign-off. Reference: docs/design.md
name: feature-development
description: Branch off trunk, plan, implement, gate on tests, and review in a cycle, then commit on sign-off.
inputs:
  feature:
    required: true
    prompt: What are we building?
  base:
    required: false
    default: main
    prompt: Branch to start from
    multiline: false
  test_command:
    required: false
    default: npm test
    prompt: Test command (leave blank to skip tests)
    remember: true
    multiline: false
steps:
  - id: sync-base       # a dirty tree or a diverged trunk fails the run here,
    kind: command       # with git's own message in the artifact
    run: git checkout "{{ inputs.base }}" && git pull --ff-only
    output: sync-base.log

  - id: branch
    kind: command
    run: git checkout -b "feature/{{ run.slug }}"
    output: branch.log

  - id: plan
    kind: agent
    runner: claude
    model: opus
    mode: interactive
    writes: false
    output: plan.md
    prompt: >
      We are planning: {{ inputs.feature }}. Work with me on a plan.

      Do not modify files.

      Before you start your discovery, ask the user if there are any files that
      you should be aware of. If there are, ask the user to provide them.

  - kind: loop
    id: human-review
    until: sign-off
    max_iterations: 5
    steps:
      - kind: loop
        id: do-review
        until: review
        max_iterations: 10
        steps:
          # Repeats until the tests pass, handing the failing log back to
          # 'execute' each time. 'review' only runs once they are green. A
          # blank test_command runs 'sh -c ""', which exits 0, so tests pass
          # immediately and are effectively skipped.
          - id: test-fix
            kind: loop
            until: tests
            max_iterations: 3
            steps:
              - id: execute
                # 'tests' is later in THIS loop, so it means the PREVIOUS
                # iteration's log; 'review' and 'sign-off' are later siblings
                # of the OUTER loops, so they mean the previous ROUND's
                # findings/feedback — all three are simply skipped, on the
                # first pass of each, when there is nothing yet to read.
                inputs: [plan, tests, review, sign-off]
                kind: agent
                runner: claude
                model: sonnet
                mode: headless
                writes: true
                prompt: |
                  Implement the attached plan. If a tests log marked VERDICT: FAIL
                  is attached, fix every failure it shows before anything else.
                  If review findings or sign-off feedback are attached, address
                  every point.
                output: execute-report.md
              - id: tests
                kind: command
                run: "{{ inputs.test_command }}"
                verdict: true         # a failing exit sends the loop round again, not a crash
                output: tests.log
                timeout_ms: 1800000   # a hung suite fails the run (resumable) rather than blocking forever
          - id: review
            inputs: [plan, execute, tests, sign-off]
            verdict: true
            kind: agent
            runner: claude
            model: opus
            mode: headless
            writes: false
            prompt: |
              Review the implementation against the attached plan. If sign-off
              feedback is attached, FAIL unless every requested change is addressed.
            output: review.md
      - id: sign-off
        inputs: [review]
        kind: approval
        verdict: true
        title: Ship it?
        instructions: Review the diff and the findings before this goes any further.
        show_diff: true
        capture: review
        output: feedback.md

  # Everything but the run artifacts, so the message writer below sees the whole
  # change as one diff. [.] rather than . because git rejects an exclude pathspec
  # whose literal prefix is gitignored, and most repos ignore .whiphand/runs.
  # The short :! form because cmd.exe cannot carry a quote next to the parens
  # of :(exclude); without glob magic the * already spans subdirectories.
  - id: stage
    kind: command
    run: git add -A -- . ":![.]whiphand/runs/*"
    output: stage.log

  - id: commit-message
    inputs: [plan, review, sign-off]
    kind: agent
    runner: claude
    model: haiku        # summarising a diff is not what the workflow's model is for
    mode: headless
    writes: false       # Write/Edit denied; Bash stays, which is how it reads the diff
    output: commit-message.md
    prompt: |
      Write the commit message for the change staged on this branch. Read it with
      \`git diff --cached\`, and read the attached plan, review and sign-off feedback
      for why it was made.
      A subject line in the imperative mood, at most 72 characters, no trailing
      period. Then a blank line, then one to three short lines on what changed and
      why. Write the message and nothing else — no preamble, no fences, no review.

  - id: commit
    kind: command
    run: git commit -F ".whiphand/runs/{{ run.id }}/commit-message.md"
    output: commit.log
`;
}

/**
 * The fourth workflow `whiphand init` ships: `feature-development` with the
 * plan cut into stage files and the human-review loop replaced by a `kind:
 * stages` step, so a large feature is built, reviewed, accepted and
 * committed one stage at a time instead of as one giant sign-off at the end.
 * Fixed content, unlike `workflowTemplate` — `whiphand new-workflow` does not
 * offer this shape. Exported only so scaffold.test.ts can parse it directly,
 * and so its byte-identical dogfood copy at
 * `.whiphand/workflows/staged-feature-development.yaml` can be generated
 * from the same source rather than kept in sync by hand.
 *
 * `execute` and `review`, both nested inside `do-review`'s loops, cannot list
 * `accept` in their own `inputs:` — a forward reference is only legal across
 * a loop that encloses the reader (the "previous iteration" reading), never
 * across a whole `stages` body, and `accept` sits at the body's own level,
 * outside every loop `execute`/`review` are nested in (see
 * `validateWorkflowSemantics`'s `sameBody` check). That reference is not
 * needed anyway: a rejection at `accept` reaches `execute` — the stage's
 * retry target, being the last `writes: true` agent step before the gate —
 * automatically, injected as findings when the stage retries (see
 * `runStage`/`withFindings` in engine/runner.ts). `review` has no such
 * channel, so its prompt asks it to judge the implementer's own report
 * instead of claiming to see the rejection note itself.
 */
export function stagedFeatureDevelopmentTemplate(): string {
  return `# staged-feature-development — branch off trunk, plan, cut the plan into
# stages, then build, review, accept and commit one stage at a time.
# Reference: docs/design.md
name: staged-feature-development
description: Cut a large feature into stages, then build, review, accept and commit one stage at a time.
inputs:
  feature:
    required: true
    prompt: What are we building?
  plan_dir:
    required: true
    remember: true
    multiline: false
    prompt: "Plan directory (e.g. docs/plans/oauth)"
  base:
    required: false
    default: main
    multiline: false
    prompt: Branch to start from
  test_command:
    required: false
    default: npm test
    remember: true
    multiline: false
    prompt: Test command (leave blank to skip tests)
steps:
  - id: sync-base
    kind: command
    run: git checkout "{{ inputs.base }}" && git pull --ff-only
    output: sync-base.log

  - id: branch
    kind: command
    run: git checkout -b "feature/{{ run.slug }}"
    output: branch.log

  - id: plan
    kind: agent
    runner: claude
    model: opus
    mode: interactive
    writes: true                       # the plan lives in the repo, not the run dir
    allow_paths: ["{{ inputs.plan_dir }}/**"]
    inputs: [attachments]
    output: plan.md
    prompt: |
      We are planning: {{ inputs.feature }}. Work with me on a plan, then cut the work
      into stages small enough to review in one sitting. Write one file per stage into
      {{ inputs.plan_dir }}/, named NN-slug.md, each opening with a \`# Title\` heading.
      Write nothing outside that directory.

  - id: commit-plan
    kind: command
    run: 'git add -A -- "$WHIPHAND_PLAN_DIR" && git commit -m "plan: \${WHIPHAND_RUN_NAME:-$WHIPHAND_RUN_SLUG}"'
    env: { WHIPHAND_PLAN_DIR: "{{ inputs.plan_dir }}" }
    expect_exit: [0, 1]                # 1 is git's "nothing to commit"
    output: commit-plan.log

  - id: build
    kind: stages
    items: "{{ inputs.plan_dir }}/*.md"
    max_retries: 2
    steps:
      - id: do-review
        kind: loop
        until: review
        max_iterations: 10
        steps:
          - id: test-fix
            kind: loop
            until: tests
            max_iterations: 3
            steps:
              - id: execute
                # 'tests' is later in THIS loop, so it means the previous iteration's
                # log; 'review' is a later sibling of the outer loop, so it means the
                # previous round's findings — both are simply dropped when there is
                # nothing yet to read. 'accept' is a later sibling of the stages body
                # itself, not of any loop that encloses this step, so it can never be a
                # forward reference here — a human's rejection at 'accept' instead
                # reaches this step, the stage's retry target, as injected findings
                # when the stage is retried.
                inputs: [stage, tests, review]
                kind: agent
                runner: claude
                model: sonnet
                mode: headless
                writes: true
                output: execute-report.md
                prompt: |
                  Implement stage {{ stage.index }} of {{ stage.total }}: {{ stage.title }}.
                  Earlier stages are implemented and committed — read the tree or \`git log\`
                  if you need them. Implement only this stage. If a tests log marked
                  VERDICT: FAIL is attached, fix every failure first; if review findings
                  are attached, address every point.
              - id: tests
                kind: command
                run: "{{ inputs.test_command }}"
                verdict: true
                output: tests.log
                timeout_ms: 1800000
          - id: review
            inputs: [stage, execute, tests]
            verdict: true
            kind: agent
            runner: claude
            model: opus
            mode: headless
            writes: false
            output: review.md
            prompt: |
              Review the working-tree diff against this stage only. If the implementer's
              report says a previous rejection's feedback was addressed, check that every
              point it names was actually addressed.
      - id: accept
        inputs: [stage, review]
        kind: approval
        title: "Stage {{ stage.index }}/{{ stage.total }}: {{ stage.title }}"
        instructions: Accept this stage before the next one starts.
        show_diff: true
        capture: review
        output: accept.md
      - id: stage-changes
        kind: command
        run: git add -A -- . ":![.]whiphand/runs/*"
        output: stage-changes.log
      - id: commit-message
        inputs: [stage, review, accept]
        kind: agent
        runner: claude
        model: haiku
        mode: headless
        writes: false
        output: commit-message.md
        prompt: |
          Write the commit message for this stage, staged on this branch. Read it with
          \`git diff --cached\`, and read the attached stage file, review and feedback for
          why it was made. A subject line in the imperative mood, at most 72 characters,
          no trailing period; then a blank line, then one to three short lines. Write the
          message and nothing else.
      - id: commit
        inputs: [commit-message]
        kind: command
        # A stage with no diff is a normal stage (the human saw that at
        # 'accept' and took it anyway) — 'git commit' alone would exit 1 for
        # "nothing to commit" and fail the run right here, since there is no
        # expect_exit to forgive it. Checking the index first turns that case
        # into a clean exit 0 with no commit made; a real commit failure (a
        # hook, a bad message file) still exits non-zero and fails the run
        # loudly, exactly as every later stage's clean-history assumption needs.
        run: git diff --cached --quiet && echo "nothing to commit for this stage" || git commit -F "$WHIPHAND_ARTIFACT_COMMIT_MESSAGE"
        output: commit.log

  - id: push
    kind: command
    run: git push -u origin "feature/{{ run.slug }}"
    output: push.log
`;
}

/** Where a scoped workflow file lives — a global write `mkdir -p`s its directory on demand, same as project. */
function workflowsDir(workdir: string, scope: Scope): string {
  return scope === 'global' ? globalWorkflowsDir() : join(workdir, '.whiphand', 'workflows');
}

async function writeWorkflowFile(
  workdir: string, name: string, content: string, scope: Scope,
): Promise<{ path: string }> {
  assertValidWorkflowName(name);
  const dir = workflowsDir(workdir, scope);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.yaml`);
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw Object.assign(new Error(`workflow '${name}' already exists at ${path}`), { code: 'EEXIST' });
    }
    throw e;
  }
  return { path };
}

export async function createWorkflow(
  workdir: string, name: string, scope: Scope = 'project',
): Promise<{ path: string }> {
  return writeWorkflowFile(workdir, name, workflowTemplate(name), scope);
}

export async function updateWorkflow(
  workdir: string, name: string, workflow: Workflow, scope: Scope = 'project',
): Promise<{ path: string }> {
  assertValidWorkflowName(name);
  const locked: Workflow = { ...workflow, name };
  const problems = validateWorkflowSemantics(locked);
  if (problems.length > 0) throw new WorkflowError(problems);
  const dir = workflowsDir(workdir, scope);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.yaml`);
  let existing: string | undefined;
  try {
    existing = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const content = existing === undefined ? stringifyYaml(locked) : mergeWorkflow(existing, locked);
  await writeFile(path, content, 'utf8');
  return { path };
}

/**
 * Hard-deletes one scoped workflow file. Touches only `scope`'s directory, so
 * deleting a project workflow that overrides a global one uncovers the global
 * one rather than removing it too. Tries `.yaml` then `.yml`, the two
 * extensions `listWorkflows` shows. `{ deleted: false }` means neither file was
 * there — already gone, which is what the caller wanted.
 */
export async function deleteWorkflow(
  workdir: string, name: string, scope: Scope = 'project',
): Promise<{ deleted: boolean }> {
  assertValidWorkflowName(name);
  const dir = workflowsDir(workdir, scope);
  for (const ext of ['yaml', 'yml']) {
    try {
      await unlink(join(dir, `${name}.${ext}`));
      return { deleted: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return { deleted: false };
}

/**
 * Copies one scoped workflow file onto a new name, in the same scope. Reads
 * and reparses the source rather than copying it byte-for-byte, so `to` lands
 * in the `name:` field too, not just the filename; `mergeWorkflow` then
 * rewrites only that field, keeping the source's comments and formatting.
 * The write goes through `writeWorkflowFile`'s `wx`-flag guard, so a target
 * that already exists throws EEXIST rather than being overwritten — the
 * caller's own existence check can be stale by the time this runs.
 */
export async function cloneWorkflow(
  workdir: string, from: string, to: string, scope: Scope = 'project',
): Promise<{ path: string }> {
  assertValidWorkflowName(from);
  assertValidWorkflowName(to);
  const dir = workflowsDir(workdir, scope);
  let raw: string | undefined;
  for (const ext of ['yaml', 'yml']) {
    try {
      raw = await readFile(join(dir, `${from}.${ext}`), 'utf8');
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  if (raw === undefined) throw new Error(`workflow '${from}' not found`);
  const parsed = parseWorkflow(raw);
  const content = mergeWorkflow(raw, { ...parsed, name: to });
  return writeWorkflowFile(workdir, to, content, scope);
}

export async function initWorkspace(workdir: string): Promise<{ created: string[] }> {
  const created: string[] = [];
  const configRel = join('.whiphand', 'config.yaml');
  await mkdir(join(workdir, '.whiphand'), { recursive: true });
  try {
    await writeFile(join(workdir, configRel), stringifyYaml(DEFAULT_CONFIG), { encoding: 'utf8', flag: 'wx' });
    created.push(configRel);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const shipped: Array<[string, string]> = [
    ['feature', workflowTemplate('feature')],
    ['feature-development', featureDevelopmentTemplate()],
    ['spec-driven', specDrivenTemplate()],
    ['staged-feature-development', stagedFeatureDevelopmentTemplate()],
  ];
  for (const [name, content] of shipped) {
    const rel = join('.whiphand', 'workflows', `${name}.yaml`);
    try {
      await writeWorkflowFile(workdir, name, content, 'project');
      created.push(rel);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  return { created };
}
