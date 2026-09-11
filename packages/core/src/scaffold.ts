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
import { WorkflowError, validateWorkflowSemantics } from './schema.ts';
import { mergeWorkflow } from './workflow-write.ts';
import type { Scope, Workflow } from './types.ts';

export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

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
  return `# ${name} — plan interactively, then implement and review in a cycle
# until the review passes. Reference: docs/design.md
name: ${name}
description: Plan with a human, then implement and review in a cycle until the review passes.
inputs:
  feature:
    required: true
    prompt: What are we building?
steps:
  - id: plan          # live terminal chat; artifact harvested afterwards
    runner: claude
    mode: interactive
    writes: false
    output: plan.md
    prompt: |
      We are planning: {{ inputs.feature }}. Work with me on a plan. Do not modify files.

  - id: fix-cycle     # repeats its body until 'review' returns VERDICT: PASS
    kind: loop
    until: review
    max_iterations: 3
    steps:
      - id: execute   # headless; may write
        runner: claude
        mode: headless
        writes: true
        # 'review' comes later in this body, so it means the PREVIOUS
        # iteration's findings — absent, and simply skipped, on the first pass.
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

      - id: review    # headless, read-only, must end with VERDICT: PASS|FAIL
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
  return `# spec-driven — settle WHAT, then HOW, grilling each with you, then build and
# review in a cycle until the review passes. Reference: docs/design.md
name: spec-driven
description: A functional spec and a technical spec, each grilled, then a build/review cycle.
inputs:
  feature:
    required: true
    prompt: What are we building?
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

  - id: build-cycle
    kind: loop
    until: review
    max_iterations: 3
    steps:
      - id: execute
        runner: claude
        model: sonnet     # the specs did the thinking; this half is cheap
        mode: headless
        writes: true
        # 'review' is later in this body, so it means the PREVIOUS iteration's
        # findings — absent, and simply skipped, on the first pass.
        inputs: [functional-grill, technical-grill, review]
        output: execute-report.md
        prompt: Implement the attached technical spec. It serves the functional spec; where they disagree, say so rather than guessing.

      # Uncomment to make verification part of the cycle: with 'verdict: true'
      # a non-zero exit sends the loop round again instead of failing the run.
      # - id: tests
      #   kind: command
      #   run: npm test
      #   verdict: true
      #   output: tests.log

      - id: review
        runner: claude
        model: opus
        mode: headless
        writes: false
        verdict: true
        inputs: [functional-grill, technical-grill, execute]
        output: review.md
        prompt: |
          Review the implementation against both specs — the functional one
          for whether it does the right thing, the technical one for whether
          it was built the agreed way. End with VERDICT: PASS or VERDICT: FAIL.

  - id: sign-off
    kind: approval
    title: Ship it?
    instructions: Review the diff and the findings before this goes any further.
    show_diff: true
    inputs: [review]
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
  return `# feature-development — branch off trunk, plan, implement and review in a cycle,
# then commit on sign-off. Reference: docs/design.md
name: feature-development
description: Branch off trunk, plan, implement and review in a cycle, then commit on sign-off.
inputs:
  feature:
    required: true
    prompt: What are we building?
  base:
    required: false
    default: main
    prompt: Branch to start from
steps:
  - id: sync-base       # a dirty tree or a diverged trunk fails the run here,
    kind: command       # with git's own message in the artifact
    run: git checkout "{{ inputs.base }}" && git pull --ff-only
    output: sync-base.log

  - id: branch
    kind: command
    run: git checkout -b "feature/{{ run.slug }}"
    output: branch.log

  - id: plan            # unchanged from the current local copy
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

  - kind: loop          # unchanged from the current local copy
    id: human-review
    until: sign-off
    max_iterations: 5
    steps:
      - kind: loop
        id: do-review
        until: review
        max_iterations: 10
        steps:
          - id: execute
            inputs: [plan, review, sign-off]
            kind: agent
            runner: claude
            model: sonnet
            mode: headless
            writes: true
            prompt: Implement the attached plan.
            output: execute-report.md
          - id: review
            inputs: [plan, execute]
            verdict: true
            kind: agent
            runner: claude
            model: opus
            mode: headless
            writes: false
            prompt: Review the implementation against the attached plan.
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

  - id: stage           # everything but the run artifacts, so the message
    kind: command       # writer below sees the whole change as one diff
    run: git add -A -- . ":(exclude).whiphand/runs"
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
