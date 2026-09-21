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
import { WORKFLOW_NAME_RE, workflowNameProblem } from './workflow-name.ts';

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
  const problem = workflowNameProblem(name);
  if (problem !== null) throw new Error(`invalid workflow name '${name}' (${problem})`);
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
      We are planning: {{ inputs.feature }}.
      Before exploring, ask me whether there are files or docs you should read first.
      Work with me on a plan. Do not modify files.
      The artifact you write is the agreed plan as it now stands, not a transcript of our
      conversation. End it with a \`## Verify\` section: the exact command(s) that exercise
      this change, because the workflow's test command may not cover it.

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
          # blank test_command runs eval "", which exits 0, so tests pass
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
                  every point. Leave your work uncommitted: a human reads the
                  working tree at the gate below, and the workflow commits it
                  once they have approved.
                  Implement everything the plan asks. If something can't or shouldn't be
                  done, don't drop it silently: say so in the report.
                  Your report, the artifact, has these sections under exactly these headings:
                  ## Changed
                  The files you changed or added, one line each.
                  ## Verified
                  The exact commands you ran and their result. Run the tests relevant to
                  what you changed, not only the workflow's test command.
                  ## Not done / not verified
                  Anything you did not do or check, with the reason.
                  ## Deviations from the plan
                  Where you departed from the plan, with the reason.
                  ## Findings addressed
                  Only when a tests log, review findings or sign-off feedback were
                  attached: one line per point, and how you addressed it.
              - id: tests
                kind: command
                run: eval "{{ inputs.test_command }}"
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
              Review the uncommitted working-tree diff (\`git diff\` plus untracked
              files) against the attached plan. Walk the plan requirement by
              requirement and state for each whether it is met. If sign-off
              feedback is attached, FAIL unless every requested change is addressed.
              Check every claim in the execute report against the diff. A false claim
              is blocking. Also blocking:
              - HEAD moved, or the executor committed (check \`git log\`)
              - changes outside the plan's scope
              - an empty diff when the plan requires changes
              - a review or sign-off point that was not addressed
              If the attached tests log does not exercise the changed code, say so and
              run the relevant tests yourself, with read-only commands only.
              An improvement outside the plan is non-blocking at most.

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
      Before exploring, ask me whether there are files or docs you should read first.
      Work with me on the problem, who it serves, the behaviour, the edge
      cases, what is explicitly out of scope, and how we will know it works.
      Stay out of implementation — no file layout, no APIs, no libraries.
      One question at a time. Do not modify files.
      The artifact you write is the agreed plan as it now stands, not a transcript of our
      conversation.

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
      code changes, error handling, and how it gets tested. Before exploring,
      ask me whether there are files or docs you should read first. Then read
      the code before proposing structure. One question at a time. Do not
      modify files.
      The artifact you write is the agreed plan as it now stands, not a transcript of our
      conversation. End it with a \`## Verify\` section: the exact command(s) that exercise
      this change, because the workflow's test command may not cover it.

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
          # blank test_command runs eval "", which exits 0, so tests pass
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
                  address every requested change. Leave your work uncommitted: a
                  human reads the working tree at the gate below, and the workflow
                  commits it once they have approved.
                  Implement everything the technical spec asks. If something can't or shouldn't be
                  done, don't drop it silently: say so in the report.
                  Your report, the artifact, has these sections under exactly these headings:
                  ## Changed
                  The files you changed or added, one line each.
                  ## Verified
                  The exact commands you ran and their result. Run the tests relevant to
                  what you changed, not only the workflow's test command.
                  ## Not done / not verified
                  Anything you did not do or check, with the reason.
                  ## Deviations from the plan
                  Where you departed from the technical spec, with the reason.
                  ## Findings addressed
                  Only when a tests log, review findings or sign-off feedback were
                  attached: one line per point, and how you addressed it.
              - id: tests
                kind: command
                run: eval "{{ inputs.test_command }}"
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
              Review the uncommitted working-tree diff (\`git diff\` plus untracked
              files) against both specs — the functional one for whether it does the
              right thing, the technical one for whether it was built the agreed way.
              Walk each spec requirement by requirement and state for each whether it
              is met. If sign-off feedback is attached, FAIL unless every requested
              change is addressed.
              Check every claim in the execute report against the diff. A false claim
              is blocking. Also blocking:
              - HEAD moved, or the executor committed (check \`git log\`)
              - changes outside the specs' scope
              - an empty diff when the specs require changes
              - a review or sign-off point that was not addressed
              If the attached tests log does not exercise the changed code, say so and
              run the relevant tests yourself, with read-only commands only.
              An improvement outside the specs is non-blocking at most.
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
    prompt: |
      We are planning: {{ inputs.feature }}.
      Before exploring, ask me whether there are files or docs you should read first.
      Work with me on a plan. Do not modify files.
      The artifact you write is the agreed plan as it now stands, not a transcript of our
      conversation. End it with a \`## Verify\` section: the exact command(s) that exercise
      this change, because the workflow's test command may not cover it.

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
          # blank test_command runs eval "", which exits 0, so tests pass
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
                  every point. Leave your work uncommitted: a human reads the
                  working tree at the gate below, and the workflow commits it
                  once they have approved.
                  Implement everything the plan asks. If something can't or shouldn't be
                  done, don't drop it silently: say so in the report.
                  Your report, the artifact, has these sections under exactly these headings:
                  ## Changed
                  The files you changed or added, one line each.
                  ## Verified
                  The exact commands you ran and their result. Run the tests relevant to
                  what you changed, not only the workflow's test command.
                  ## Not done / not verified
                  Anything you did not do or check, with the reason.
                  ## Deviations from the plan
                  Where you departed from the plan, with the reason.
                  ## Findings addressed
                  Only when a tests log, review findings or sign-off feedback were
                  attached: one line per point, and how you addressed it.
                output: execute-report.md
              - id: tests
                kind: command
                run: eval "{{ inputs.test_command }}"
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
              Review the uncommitted working-tree diff (\`git diff\` plus untracked
              files) against the attached plan. Walk the plan requirement by
              requirement and state for each whether it is met. If sign-off
              feedback is attached, FAIL unless every requested change is addressed.
              Check every claim in the execute report against the diff. A false claim
              is blocking. Also blocking:
              - HEAD moved, or the executor committed (check \`git log\`)
              - changes outside the plan's scope
              - an empty diff when the plan requires changes
              - a review or sign-off point that was not addressed
              If the attached tests log does not exercise the changed code, say so and
              run the relevant tests yourself, with read-only commands only.
              An improvement outside the plan is non-blocking at most.
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
      Write the commit message for the change staged on this branch.
      Its source of truth is \`git diff --cached\`, plus the attached plan or stage
      file, review and feedback for why the change was made. Do not copy or
      paraphrase an existing commit message, such as one from \`git log\`.
      The subject is the first line: imperative mood, at most 72 characters, no
      trailing period. Then one blank line, then a body of one to three lines, each
      wrapped at 72 characters, in plain sentences with no bullets. The body says
      what changed and why.
      Trailers such as \`Co-Authored-By\` are allowed. If you add any, put them after
      the body, separated from it by one blank line.
      The file holds the message and nothing else: no preamble, no code fences, no
      review.
      If the index is empty, write a one-line subject saying so instead of asking.

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
 * The planner writes the stage files into the run folder
 * (`{{ run.dir }}/plans/NN-slug.md`), not the repository: they are never
 * committed to the branch or the PR, and go when `runs.max_retained` prunes the
 * run. `build.items` globs them by that absolute path, so a glob metacharacter
 * (`[`, `*`, `?`, `{`) in the workdir path would break the match.
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
    # The stage files go in the run folder, not the repo, so the planner should
    # change nothing in the repository. \`writes: true\` is still needed (without it
    # the runner denies the write tools outright). The git guard ignores every
    # path with a .whiphand segment, so run-folder writes never show up as
    # changes; that leaves the allow_paths below meaning "any change to the
    # repository fails this step".
    writes: true
    allow_paths: ["{{ run.dir }}/**"]
    inputs: [attachments]
    output: plan.md
    prompt: |
      We are planning: {{ inputs.feature }}.
      Before exploring, ask me whether there are files or docs you should read first.
      Work with me on a plan, then cut the work into stages. Order them so each builds on
      the earlier ones, which the workflow will already have committed by the time it is
      built, and keep each small enough to review in one sitting.
      Write one file per stage into {{ run.dir }}/plans/, named NN-slug.md, and nowhere
      else. The build turns every .md file in that folder into a stage, so put nothing
      else there. Each stage file follows this template:
      # <Stage title>
      ## Goal
      What this stage achieves, and why.
      ## Scope
      What to build or change.
      ## Out of scope
      What this stage must leave alone, including work that belongs to a later stage.
      ## Files
      The files it touches.
      ## Acceptance criteria
      Checkable statements a reviewer can walk through one by one.
      ## Verify
      The exact command(s) that exercise this stage, because the workflow's test command
      may not cover it.
      Change nothing in the repository. The artifact you write is the agreed plan as it
      now stands, not a transcript of our conversation.
      Before you tell me the plan is done, list {{ run.dir }}/plans/ and confirm that every
      stage file is there and that nothing was written elsewhere.

  - id: build
    kind: stages
    items: "{{ run.dir }}/plans/*.md"
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
                  Earlier stages are implemented and already committed by the workflow —
                  read the tree or \`git log\` if you need them. Implement only this stage,
                  and leave it uncommitted: committing is the workflow's job, not yours. A
                  human reads the working tree at the gate below, and the workflow commits
                  it once they have accepted. If a tests log marked VERDICT: FAIL is
                  attached, fix every failure first; if review findings are attached,
                  address every point.
                  Implement everything the stage asks. If something can't or shouldn't be
                  done, don't drop it silently: say so in the report.
                  Your report, the artifact, has these sections under exactly these headings:
                  ## Changed
                  The files you changed or added, one line each.
                  ## Verified
                  The exact commands you ran and their result. Run the tests relevant to
                  what you changed, not only the workflow's test command.
                  ## Not done / not verified
                  Anything you did not do or check, with the reason.
                  ## Deviations from the plan
                  Where you departed from the stage, with the reason.
                  ## Findings addressed
                  Only when a tests log, review findings or rejection feedback were
                  attached: one line per point, and how you addressed it.
              - id: tests
                kind: command
                run: eval "{{ inputs.test_command }}"
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
              Review the uncommitted working-tree diff (\`git diff\` plus untracked
              files) against this stage only. Walk the stage requirement by
              requirement and state for each whether it is met. If the implementer's
              report says a previous rejection's feedback was addressed, check that every
              point it names was actually addressed.
              Check every claim in the execute report against the diff. A false claim
              is blocking. Also blocking:
              - HEAD moved, or the executor committed (check \`git log\`)
              - changes outside the stage's scope
              - an empty diff when the stage requires changes
              - a review or rejection point that was not addressed
              If the attached tests log does not exercise the changed code, say so and
              run the relevant tests yourself, with read-only commands only.
              An improvement outside the stage is non-blocking at most.
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
          Write the commit message for the change staged on this branch.
          Its source of truth is \`git diff --cached\`, plus the attached plan or stage
          file, review and feedback for why the change was made. Do not copy or
          paraphrase an existing commit message, such as one from \`git log\`.
          The subject is the first line: imperative mood, at most 72 characters, no
          trailing period. Then one blank line, then a body of one to three lines, each
          wrapped at 72 characters, in plain sentences with no bullets. The body says
          what changed and why.
          Trailers such as \`Co-Authored-By\` are allowed. If you add any, put them after
          the body, separated from it by one blank line.
          The file holds the message and nothing else: no preamble, no code fences, no
          review.
          If the index is empty, write a one-line subject saying so instead of asking.
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

/**
 * The fifth workflow `whiphand init` ships: a research workflow, not a build.
 * It settles the question with the human, has a headless agent investigate and
 * write a sourced report, has a second agent check that report against the
 * brief and spot-check its sources, then puts the report in front of the human
 * to accept or send round again. Nothing in it writes to the repository, so it
 * has no branch, no test command and no commit. Fixed content, unlike
 * `workflowTemplate` — `whiphand new-workflow` does not offer this shape.
 * Exported only so scaffold.test.ts can parse it directly, and so its
 * byte-identical dogfood copy at `.whiphand/workflows/research.yaml` can be
 * generated from the same source rather than kept in sync by hand.
 *
 * The loops follow the other templates: an outer loop, `until: read`, wraps
 * the inner research/check cycle and the human gate. `read` has no `show_diff`
 * — there is no diff to show — so `validateWorkflowWarnings` says its
 * `capture: review` only takes an overall comment, which is all a report needs.
 * Web access is whatever the runner's tools give it; the prompt only says to
 * use them if there are any.
 */
export function researchTemplate(): string {
  return `# research — settle the question with you, investigate and check the findings
# in a cycle until the check passes, then a human read that can send the report
# back for another round. Reference: docs/design.md
name: research
description: Settle a question with a human, then research and check it in a cycle until the report holds up.
inputs:
  question:
    required: true
    multiline: true
    prompt: What do you want to find out?
steps:
  - id: frame         # live terminal chat; artifact harvested afterwards
    runner: claude
    model: opus
    mode: interactive
    writes: false
    inputs: [attachments]
    output: brief.md
    prompt: |
      We are framing a research question: {{ inputs.question }}
      Before exploring, ask me whether there are files or docs you should read first.
      Work with me until the brief is settled: the precise question or questions, what is
      in scope and what is out, which sources count (code in this repo, docs, the web),
      and what the answer must contain to be useful to me. One question at a time. Do not
      modify files, and do not start the research itself.
      The artifact you write is the agreed brief as it now stands, not a transcript of our
      conversation.

  # Repeats until 'read' is approved. Requesting changes there attaches fresh
  # feedback ('read' as a forward reference) and sends investigate round
  # again — delete this whole loop, keeping investigate at the top level, to
  # let the workflow run unattended instead.
  - id: human-review
    kind: loop
    until: read
    max_iterations: 5
    steps:
      - id: investigate   # repeats its body until 'check' returns VERDICT: PASS
        kind: loop
        until: check
        max_iterations: 3
        steps:
          - id: research    # headless, read-only; the artifact is the report
            runner: claude
            model: opus
            mode: headless
            writes: false
            # 'check' is later in THIS loop, so it means the PREVIOUS iteration's
            # findings; 'read' is a later sibling of the OUTER loop, so it means
            # the previous ROUND's feedback — both are simply skipped, on the
            # first pass of each, when there is nothing yet to read.
            inputs: [frame, check, read]
            output: report.md
            prompt: |
              Investigate the attached brief and answer it. Read the code and docs it names,
              and use web search or fetch tools if you have them and the brief lets the web
              count as a source. Change nothing in the repository.
              If check findings or read feedback are attached, address every point: fix what
              was wrong, source what was unsourced, and say so in the report.
              No claim without a source. A source is a file and line, or a URL, that you
              opened and that says what you claim. Do not cite from memory, and do not
              cite a source you did not open.
              Your report, the artifact, has these sections under exactly these headings:
              ## Answer
              Short and direct: answer each of the brief's questions, in the brief's order.
              ## Evidence
              Each claim, with its source: a \`file:line\` or a URL.
              ## Confidence and gaps
              How sure you are of each part of the answer, and what you could not find or
              verify, with the reason.
              ## Open questions
              What the evidence leaves unsettled, or raises and the brief did not ask.
          - id: check       # headless, read-only, must end with VERDICT: PASS|FAIL
            runner: claude
            model: opus
            mode: headless
            writes: false
            verdict: true
            inputs: [frame, research, read]
            output: check.md
            prompt: |
              Check the attached report against the attached brief. Change nothing in the
              repository. Walk the brief question by question and state for each whether the
              report answers it. If read feedback is attached, FAIL unless every requested
              change is addressed. FAIL if any of these hold:
              - the report does not answer a question in the brief
              - a claim in the report has no source
              - a source you spot-check does not say what the report claims
              - a required section is missing, or is not under its exact heading
              Spot-check by opening at least three of the report's sources, choosing the ones
              the answer leans on most, and say which you opened and what you found. If it
              cites fewer than three, open them all. A source you cannot open counts as one
              that does not say what is claimed.
              List every problem you found, so the next round can fix all of them at once.
              Gaps and open questions the report states honestly are not failures.

      # A human gate. Its answer becomes the 'read' both steps above read:
      # approving exits both loops, requesting changes sends investigate round again.
      - id: read
        kind: approval
        verdict: true
        title: Accept this report?
        instructions: Read the report. Approve it, or request changes with a comment saying what to look into or fix.
        capture: review
        inputs: [research]
        output: feedback.md
`;
}

/**
 * The sixth workflow `whiphand init` ships: fix a bug test-first. It branches
 * off trunk, settles the root cause, the regression test and the command that
 * runs just that test with the human, has an agent write only the test, and
 * then refuses to go on unless that test fails, so "fixed" later means a
 * failing test turned green rather than a claim. The fix runs in the usual
 * test-fix / review cycle behind a human sign-off, then commits. Fixed content,
 * unlike `workflowTemplate` — `whiphand new-workflow` does not offer this
 * shape. Exported only so scaffold.test.ts can parse it directly, and so its
 * byte-identical dogfood copy at `.whiphand/workflows/bugfix.yaml` can be
 * generated from the same source rather than kept in sync by hand.
 *
 * The diagnosed test command reaches the command steps as a file, not an
 * input: inputs are all resolved when the run starts (runner.ts refuses a
 * missing required one up front), so nothing can prompt for a `repro_command`
 * once the diagnosis exists. `reproduce` writes the command into
 * `<run dir>/repro.sh` and the command steps source it in a subshell,
 * `( . repro.sh )`, rather than run `sh repro.sh`. The shell a command step gets
 * is started by absolute path (shell.ts) and is not a login shell, so on Windows
 * Git's `usr\bin` is on PATH only if the user put it there: a second `sh`
 * looked up by name can exit 127, which the red gate would blame on the agent's
 * script. Sourcing looks nothing up, and an `exit N` in the script ends only the
 * subshell, with N. `if`/`$?` mean the same on Windows as on Linux, and a script
 * file, unlike a command read back out of markdown, needs no extraction,
 * quoting or CRLF handling.
 * `expect_exit` cannot express the red gate: it lists the codes that count as
 * success, and "any failure" is not a list — runners disagree on what they
 * exit with (1, 101, 2) and 126/127 mean the command never ran.
 */
export function bugfixTemplate(): string {
  return `# bugfix — branch off trunk, diagnose the bug with you, prove it with a failing
# test, then fix it in a cycle until the tests pass and the review passes, and
# commit on sign-off. Reference: docs/design.md
name: bugfix
description: Branch off trunk, diagnose a bug, prove it with a failing test, then fix it, gate on tests and review, and commit on sign-off.
inputs:
  bug:
    required: true
    multiline: true
    prompt: What is broken? Steps, expected vs actual
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
    run: git checkout -b "fix/{{ run.slug }}"
    output: branch.log

  - id: diagnose        # live terminal chat; artifact harvested afterwards
    kind: agent
    runner: claude
    model: opus
    mode: interactive
    writes: false
    inputs: [attachments]
    output: diagnosis.md
    prompt: |
      We are diagnosing a bug: {{ inputs.bug }}
      Before exploring, ask me whether there are files or docs you should read first.
      Ask for logs, stack traces and anything else that shows the bug happening, too.
      Find the root cause with me before anything is fixed. Read the code and the
      evidence, form a hypothesis, and check it against the code. Do not modify files.
      Agree with me on three things: the root cause (why it happens, not only where it
      shows), where the regression test goes, and the exact command that runs just
      that test, not the whole suite.
      The artifact you write is the agreed diagnosis as it now stands, not a transcript
      of our conversation. It has these sections under exactly these headings:
      ## Symptom
      What happens, and what should happen instead.
      ## Root cause
      Why it happens, with file:line evidence. Say what is confirmed and what is still
      a hypothesis.
      ## Regression test
      The test file, existing or new, and what the test asserts. It must fail today
      because of this bug, and pass once the bug is fixed.
      ## Test command
      The exact command, on one line, that runs just that test from the repository root.
      ## Fix outline
      What the fix changes, and why that removes the root cause rather than masking the
      symptom.

  # The diagnosed test command reaches the command steps below as a file, not as
  # an input: inputs are all collected when the run starts, so nothing can ask
  # for a repro_command once the diagnosis exists. 'reproduce' writes the command
  # into <run dir>/repro.sh and the command steps source it in a subshell,
  # ( . repro.sh ), instead of running "sh repro.sh": a second sh looked up by
  # name may not be on PATH under the Windows shell, and sourcing looks nothing
  # up. A script file needs no extracting from markdown or requoting into a run
  # line.
  - id: reproduce       # headless; writes the test and repro.sh, and no fix
    kind: agent
    runner: claude
    model: sonnet
    mode: headless
    writes: true
    inputs: [diagnose]
    output: reproduce-report.md
    prompt: |
      Write the regression test the attached diagnosis asks for, and nothing else: no
      fix, and no change to the code under test. Put it where the diagnosis's
      Regression test section says, in the style of the tests already there. Leave
      your work uncommitted: a human reads the working tree at the gate below, and the
      workflow commits it once they have approved.
      Then write the command that runs just that test into {{ run.dir }}/repro.sh, and
      write it nowhere else. The workflow sources that file in a POSIX sh subshell from
      the repository root, on every OS, so keep it POSIX sh. Start from the diagnosis's
      Test command section, and correct it if the test ended up elsewhere. The last
      command in the file must be the test itself, so the script exits with the test's
      own status: no \`|| true\`, no pipe that hides it.
      Run it and watch it fail. It must fail because of the bug, on an assertion that
      shows the symptom. A failure from a typo, a missing import, a bad fixture or a
      command that cannot run does not count: fix the test until it fails for the bug's
      reason. If you cannot make it fail for that reason, the diagnosis is wrong or
      incomplete. Do not touch the code under test to force a failure: say so in the
      report. The next step runs repro.sh and stops the whole run unless it fails.
      Your report, the artifact, has these sections under exactly these headings:
      ## Changed
      The test files you added or changed, and repro.sh, one line each.
      ## How it fails
      The command you ran, its exit status, and the output that shows the bug: the
      assertion message, expected against actual. Say why that failure is the bug's
      symptom and not a mistake in the test.
      ## Not done / not verified
      Anything you did not do or check, with the reason.

  # A green result here means the test does not reproduce the bug, so the run
  # fails with a message saying so instead of fixing something that was never
  # shown broken. expect_exit cannot say "any failure" (it lists the exit codes
  # that count as success), so the exit status is inverted by hand, and 126 and
  # 127 fail too: those mean repro.sh could not run the test at all, which
  # proves nothing about the bug. A missing repro.sh is checked for by name,
  # because sourcing a file that is not there is a shell-dependent error, and 2
  # is a plausible failing-test code. The subshell keeps an exit in repro.sh
  # from ending this step early. Command steps run under a POSIX shell on every
  # OS, so this reads the same on Windows as on Linux.
  - id: confirm-red
    kind: command
    run: |
      if [ ! -f "{{ run.dir }}/repro.sh" ]; then
        echo "confirm-red: reproduce wrote no repro.sh, so there is no regression test to run" >&2
        exit 1
      fi
      ( . "{{ run.dir }}/repro.sh" )
      code=$?
      if [ "$code" -eq 0 ]; then
        echo "confirm-red: the regression test passed, so it does not reproduce the bug" >&2
        exit 1
      fi
      if [ "$code" -eq 126 ] || [ "$code" -eq 127 ]; then
        echo "confirm-red: repro.sh could not run the test (exit $code), so its failure proves nothing" >&2
        exit 1
      fi
      echo "confirm-red: the regression test fails (exit $code), as it must before the fix"
    output: confirm-red.log
    timeout_ms: 1800000

  # Repeats until 'sign-off' is approved. Requesting changes there attaches
  # fresh feedback ('sign-off' as a forward reference) and sends fix-cycle round
  # again — delete this whole loop, keeping fix-cycle at the top level, to let
  # the workflow run unattended instead.
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
          # 'execute' each time. 'review' only runs once they are green.
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
                inputs: [diagnose, reproduce, tests, review, sign-off]
                kind: agent
                runner: claude
                model: sonnet
                mode: headless
                writes: true
                prompt: |
                  Fix the bug the attached diagnosis describes, at its root cause and not
                  only where it shows. The attached reproduce report says the regression
                  test fails today. Your fix must make it pass, and you must not change the
                  test to get there: do not weaken, skip or delete it, loosen an
                  assertion or change an expected value. If the test itself is wrong, say
                  so in the report; you may strengthen it. Change only what the fix needs:
                  no unrelated cleanup or refactor.
                  If a tests log marked VERDICT: FAIL is attached, fix every failure it
                  shows before anything else. It runs the regression test first, then the
                  workflow's test command. If review findings or sign-off feedback are
                  attached, address every point. Leave your work uncommitted: a human reads
                  the working tree at the gate below, and the workflow commits it once
                  they have approved.
                  Implement everything the diagnosis's fix outline asks. If something can't
                  or shouldn't be done, don't drop it silently: say so in the report.
                  Your report, the artifact, has these sections under exactly these headings:
                  ## Changed
                  The files you changed or added, one line each.
                  ## Verified
                  The exact commands you ran and their result. Run the tests relevant to
                  what you changed, not only the workflow's test command. Include the
                  regression test's command.
                  ## Regression test
                  Whether you left it untouched. If you changed it, what and why.
                  ## Not done / not verified
                  Anything you did not do or check, with the reason.
                  ## Deviations from the plan
                  Where you departed from the diagnosis's fix outline, with the reason.
                  ## Findings addressed
                  Only when a tests log, review findings or sign-off feedback were
                  attached: one line per point, and how you addressed it.
                output: execute-report.md
              # The regression test first, sourced from the same repro.sh the red gate
              # ran, so a blank test_command (eval "" exits 0) still leaves the
              # fix checked against the test that proves the bug. The suite runs
              # only once that test is green.
              - id: tests
                kind: command
                run: ( . "{{ run.dir }}/repro.sh" ) && eval "{{ inputs.test_command }}"
                verdict: true         # a failing exit sends the loop round again, not a crash
                output: tests.log
                timeout_ms: 1800000   # a hung suite fails the run (resumable) rather than blocking forever

          - id: review
            inputs: [diagnose, reproduce, execute, tests, sign-off]
            verdict: true
            kind: agent
            runner: claude
            model: opus
            mode: headless
            writes: false
            prompt: |
              Review the uncommitted working-tree diff (\`git diff\` plus untracked
              files) against the attached diagnosis. The diff holds both the regression
              test and the fix. Walk the diagnosis's root cause, regression test and fix
              outline requirement by requirement and state for each whether it is met. If
              sign-off feedback is attached, FAIL unless every requested change is addressed.
              Check every claim in the execute report against the diff. A false claim
              is blocking. Also blocking:
              - HEAD moved, or the executor committed (check \`git log\`)
              - the fix masks the symptom instead of removing the root cause the diagnosis
                names: a special case for the failing input, a swallowed error, a widened
                tolerance, a retry
              - the regression test is weaker than the diagnosis and the reproduce report
                say it is: a loosened or removed assertion, a changed expected value, a
                skip, a deleted test. Strengthening it is fine.
              - changes outside the diagnosis's scope, such as an unrelated cleanup,
                refactor or fix
              - an empty diff when the diagnosis requires a fix
              - a review or sign-off point that was not addressed
              If the attached tests log does not exercise the changed code, say so and
              run the relevant tests yourself, with read-only commands only.
              An improvement outside the diagnosis is non-blocking at most.
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
    inputs: [diagnose, review, sign-off]
    kind: agent
    runner: claude
    model: haiku        # summarising a diff is not what the workflow's model is for
    mode: headless
    writes: false       # Write/Edit denied; Bash stays, which is how it reads the diff
    output: commit-message.md
    prompt: |
      Write the commit message for the change staged on this branch.
      Its source of truth is \`git diff --cached\`, plus the attached plan or stage
      file, review and feedback for why the change was made. Do not copy or
      paraphrase an existing commit message, such as one from \`git log\`.
      The subject is the first line: imperative mood, at most 72 characters, no
      trailing period. Then one blank line, then a body of one to three lines, each
      wrapped at 72 characters, in plain sentences with no bullets. The body says
      what changed and why.
      Trailers such as \`Co-Authored-By\` are allowed. If you add any, put them after
      the body, separated from it by one blank line.
      The file holds the message and nothing else: no preamble, no code fences, no
      review.
      If the index is empty, write a one-line subject saying so instead of asking.

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
    ['research', researchTemplate()],
    ['bugfix', bugfixTemplate()],
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
