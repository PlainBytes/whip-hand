# Whiphand workflow format: reference for authors

A workflow is one YAML file (`<name>.yaml`) that `whiphand run` executes step by step. This
reference is complete for writing one: every key the schema accepts is listed here. Check a
file with `whiphand validate <file>` (see the last section) before you call it done.

Every `yaml` block below is a complete, valid workflow unless its first line is `# fragment`.

## Top level

| Key | Required | Value |
|---|---|---|
| `name` | yes | Non-blank string, shown in run lists. |
| `description` | no | One line of text. |
| `inputs` | no | Map of input name → input spec (below). |
| `on_findings` | no | `report` \| `loop` \| `interactive`. Overrides the workspace setting (default `report`) for a `verdict: true` step that is **not** inside a loop. |
| `worktree` | no | `true`, `false`, or `{ base, branch, sync }` (below). |
| `mcp` | no | Workflow-default MCP policy, plus server definitions (below). |
| `plugins` | no | Workflow-default plugin policy (below). |
| `steps` | yes | Non-empty list of steps. |

No other key is allowed at the root: `enabled:` or any step field there fails with
`workflow: '<key>' belongs on a step, not on the workflow`.

### `inputs:` (workflow level)

Values the operator supplies at run start (`--input key=value`, or the desktop's New Run form).
Names use only letters, digits, `-` and `_`. Two names that differ only by `-`/`_` (`a-b`,
`a_b`) are refused, because both map to one environment variable.

| Field | Required | Value |
|---|---|---|
| `required` | **yes** | `true` or `false`. Must always be written. |
| `prompt` | no | The question shown when asking for the value. |
| `default` | no | Value used when none is given. |
| `remember` | no | Desktop only: prefill the field from the last run. |
| `multiline` | no | Desktop only: `false` shows a one-line box instead of a text area. |

Use a value as `{{ inputs.<name> }}`. Declare every input you reference.

### `worktree:`

Runs the whole workflow in a new git worktree on a new branch, decided before step 1.

```yaml
# fragment
worktree:
  base: "{{ inputs.base }}"        # git revision to branch from; default HEAD
  branch: "feature/{{ run.slug }}" # new branch; default whiphand/{{ run.slug }}
  sync: true                       # start from base's fetched upstream; default true
```

`worktree: true` = all defaults; `false` = never. Only `base`, `branch`, `sync` are allowed.
`base`/`branch` may use only declared `{{ inputs.* }}` and `{{ run.id }}`, `{{ run.slug }}`,
`{{ run.name }}` (not `run.dir`, `run.workdir`, `loop.*`, `stage.*`).

## Steps

Every step is a map with an `id` and a `kind`. **No `kind` means `agent`.** The six kinds:
`agent`, `command`, `manual`, `approval`, `loop`, `stages`.

Rules for every step:

- `id` (required): unique across the whole file, nested steps included. It becomes a file
  name, so no `\ / : * ? " < > |`, no trailing dot or space, not `CON`/`NUL`/`COM1`….
  `attachments` is reserved; `stage` is reserved in a workflow that has a `stages` step.
- `enabled: false` (every kind, `loop`/`stages` included) parks a step: it never runs, and
  `inputs:` naming it are dropped at run time. Absent = enabled. Disabling a loop disables its
  body. A loop's `until` step must never be disabled. Validation ignores `enabled`.
- A field that belongs to another kind is refused (e.g. `run:` without `kind: command` →
  "has 'run', which belongs to kind 'command' — add 'kind: command'").

Leaf kinds (`agent`, `command`, `manual`, `approval`) also take:

- `inputs`: list of step ids whose artifacts this step reads (see "Inputs"), or the reserved
  `attachments` / `stage`.
- `verdict: true`: the step reports PASS/FAIL instead of failing the run (see "Verdicts").
- `output`: the artifact file name, a relative path such as `plan.md` or `reports/x.md`.
  Required on `agent`, optional elsewhere. A step with no `output` cannot be named in `inputs`.

`loop` and `stages` take neither `inputs`, `verdict` nor `output`.

### `kind: agent` (default)

Runs an LLM CLI.

| Field | Required | Value |
|---|---|---|
| `runner` | yes | `claude`, `copilot` or `opencode`. |
| `model` | no | Runner-specific model name (`opus`, `sonnet`, `haiku` for claude). Absent = runner default. |
| `mode` | yes | `interactive`: a live session with the human; when it ends, a short headless "harvest" spawn writes the artifact. `headless`: runs alone, no human. |
| `writes` | yes | `false`: file-edit tools are denied except for the step's own artifact, and any change to the working tree fails the step. `true`: may edit the tree. |
| `prompt` | yes | The task. Templated (`{{ inputs.* }}`, `{{ run.* }}`, `{{ loop.* }}`, `{{ stage.* }}`). The engine appends the input artifact paths, the artifact path to write, and (for `verdict: true`) the verdict format; do not restate them. |
| `output` | yes | Artifact file the agent writes. |
| `allow_paths` | no | Globs (templated) a `writes: true` step may change; any other changed path fails the step. Paths with a `.whiphand` segment never count as changes. |
| `allow_commits` | no | `true` lets the agent move HEAD (commit). Default: an agent that commits fails the step. |
| `effort` | no | `low` \| `medium` \| `high` \| `xhigh` \| `max`, passed to the runner's reasoning-effort flag. |
| `harvest_timeout_ms` | no | Positive integer; how long an interactive step's harvest spawn may take. Default 300000. |
| `mcp` | no | `{ allow: [...] }` or `{ deny: [...] }`; replaces the workflow `mcp` policy for this step. No `servers` here. |
| `plugins` | no | `{ allow: [...] }` or `{ deny: [...] }`; replaces the workflow `plugins` policy. |
| `inputs`, `verdict`, `enabled` | no | As above. |

Tell an implementing agent to leave its work **uncommitted** when a later step reviews or
shows the diff: the diff is the working tree against HEAD.

### `kind: command`

Runs a shell line. No runner, no tokens.

| Field | Required | Value |
|---|---|---|
| `run` | yes | One POSIX `/bin/sh` command line on every OS (Git's `sh.exe` on Windows). |
| `shell` | no | Another shell, run with `-c`. `cmd`, `powershell`, `pwsh` (and `.exe`) are refused. Usually omit. |
| `cwd` | no | Working directory (templated); relative to the run's execution tree. Default: the tree root. |
| `env` | no | Map of extra environment variables; values are templated. |
| `timeout_ms` | no | Positive integer. On timeout the step fails the run. Default: no timeout. |
| `expect_exit` | no | Exit code or list of codes that count as success. Default `[0]`. |
| `output` | no | File that receives the command's output and exit code. |
| `inputs`, `verdict`, `enabled` | no | As above. |

**Quoting rule.** In `run:`, `{{ x }}` does not paste the value: it becomes a shell variable
reference (`{{ inputs.base }}` → `${WHIPHAND_INPUT_BASE}`), so values are never code. Quote it
like any shell variable: `git checkout "{{ inputs.base }}"`. Inside single quotes it is not
expanded at all. An input whose whole purpose is to be a command (`test_command`) is run with
an explicit `eval "{{ inputs.test_command }}"`; never `eval` free text. In `cwd` and `env`
values, `{{ x }}` is the value itself.

Environment a command step sees:

- `WHIPHAND_RUN_ID`, `WHIPHAND_RUN_SLUG`, `WHIPHAND_RUN_NAME` (when named), `WHIPHAND_RUN_DIR`
  (run folder), `WHIPHAND_WORKDIR` (execution tree);
- `WHIPHAND_LOOP_ITERATION`, `WHIPHAND_LOOP_MAX_ITERATIONS` inside a loop;
- `WHIPHAND_STAGE_INDEX`, `_TOTAL`, `_ID`, `_TITLE`, `_PATH` inside a stages step;
- `WHIPHAND_INPUT_<NAME>` (upper-cased, `-` → `_`) only for inputs the step's `run`, `cwd` or
  `env` references;
- `WHIPHAND_ARTIFACT_<ID>` (upper-cased, non-alphanumerics → `_`) holding the path of each
  `inputs:` entry that has an artifact; unset (not empty) when there is none yet. Attachments
  are at `"$WHIPHAND_RUN_DIR/attachments"`.

### `kind: manual` and `kind: approval`

A human checkpoint; the two kinds are identical. The human answers *continue*, *retry* (only
offered inside a loop) or *abort*.

| Field | Required | Value |
|---|---|---|
| `title` | yes | Templated. |
| `instructions` | yes | Templated. |
| `capture` | no | `note`: free text, required to continue. `review`: an overall comment plus per-file comments, required to retry. Needs `output`. |
| `show_diff` | no | `true` shows the working tree's diff against HEAD. |
| `default` | no | `continue` \| `abort`: the answer `whiphand run --yes` takes. Required on every gate inside a `stages` step for `--yes` runs. |
| `output` | no | File the answer (and captured text) is written to. Required with `capture`. |
| `inputs`, `verdict`, `enabled` | no | As above. Named inputs are shown to the human. |

`capture: review` belongs inside a loop, with `show_diff: true` (otherwise `validate` warns).
Put the step's id in the loop's `until` and in the implementing step's `inputs` so the next
attempt reads what was asked for.

### `kind: loop`

Repeats its body until a step passes.

| Field | Required | Value |
|---|---|---|
| `steps` | yes | Non-empty body; any kind except `stages`, loops may nest. |
| `until` | yes | Id of a **direct** body step (not a loop/stages) with `verdict: true`. |
| `max_iterations` | no | Positive integer. Default: workspace `loop.max_iterations` (3). |
| `on_exhausted` | no | `report` \| `interactive` (`loop` is refused). Default: the resolved `on_findings`. |
| `enabled` | no | As above. |

- **`until` exits immediately.** When the `until` step passes, the loop ends at once; body
  steps after it are skipped. When it fails, the next iteration starts. Put the exit check last
  to run the whole body every time.
- Running out of iterations fails the run (resumable), or with `on_exhausted: interactive`
  opens a live session with the findings. Inside a stages step it instead ends the attempt's
  work and goes to the stage's gate.
- Each iteration's artifacts are kept apart; an `inputs:` reference reads the newest.

### `kind: stages`

Runs its body once per file matching a glob, one stage at a time, each gated by a human.

| Field | Required | Value |
|---|---|---|
| `items` | yes | Glob, templated, re-evaluated before each stage; relative to the execution tree or absolute (`"{{ run.dir }}/plans/*.md"`). No match at the start fails the step. |
| `steps` | yes | Non-empty body. |
| `max_retries` | no | Non-negative integer; rejections allowed per stage. Default 2 (3 attempts). |
| `enabled` | no | As above. |

- Files are sorted by path; name them `NN-slug.md`. A stage's id is the file's basename without
  extension; its title is the file's first `# heading`, else the id.
- **Gate rule (enforced):** every enabled `verdict: true` step in the body, at any depth, must
  be followed later by an enabled `manual`/`approval` step placed **directly** in the stages
  body (not inside a loop). A verdict step after the last gate is refused.
- At a body-level gate, *continue* accepts the stage; *retry* re-runs the stage from the top
  with the rejection injected into the last `writes: true` agent step before the gate.
- `inputs: [stage]` attaches the current stage file. `{{ stage.index }}`, `{{ stage.total }}`,
  `{{ stage.id }}`, `{{ stage.title }}` are available in the body.
- Each stage sees only what existed before the stages step plus its own work. A step outside
  the stages step cannot read a step inside it.
- A stages step cannot be inside a loop or another stages step.
- A step can `allow_paths: ["{{ run.dir }}/**"]` to write stage files into the run folder
  while refusing any repository change.

## Inputs (artifact references)

`inputs: [plan, review]` hands the step those steps' artifact paths: an agent gets them in its
prompt under `## Input artifacts` (labelled with the step's verdict, if it has one), a human
step shows them, a command step gets `$WHIPHAND_ARTIFACT_<ID>`.

- A reference must name an earlier step with an `output`, never a loop or stages step.
- **Forward reference = previous iteration.** Naming a *later* step that is in the body of a
  loop enclosing this step means "that step's artifact from the loop's previous iteration". It
  is dropped on the loop's first iteration (also when an outer loop restarts it), and whenever
  there is none. This is how test logs, review findings and sign-off feedback reach the next
  attempt. Any other later step is refused ("references later step").
- `attachments`: every file the operator attached with `whiphand run --attach <file>`. Exempt
  from ordering. A run with attachments refuses to start unless an enabled step names it.
- `stage`: the current stage file, only inside a stages step.

## Verdicts

`verdict: true` makes a step report PASS/FAIL instead of failing the run:

- `agent`: the artifact's first line must be `VERDICT: PASS` or `VERDICT: FAIL` (the engine
  tells the agent so);
- `command`: exit code in `expect_exit` (default `[0]`) is PASS, anything else FAIL. Without
  `verdict: true`, an unexpected exit fails the run;
- `manual`/`approval`: *continue* is PASS, *retry* is FAIL.

Inside a loop, a FAIL at `until` sends the loop round again. Outside any loop, `on_findings`
decides: `report` ends the run after writing findings, `loop` re-runs from the nearest
earlier `writes: true` step, `interactive` opens a live session. Prefer an explicit loop.

## Placeholders

| Placeholder | Value | Where |
|---|---|---|
| `{{ inputs.<name> }}` | The workflow input | everywhere templated |
| `{{ run.id }}`, `{{ run.slug }}`, `{{ run.name }}` | Run id, slug, display name | everywhere templated |
| `{{ run.dir }}` | Run folder, absolute | steps only |
| `{{ run.workdir }}` | Execution tree (worktree or workspace), absolute | steps only |
| `{{ loop.iteration }}`, `{{ loop.max_iterations }}` | 1-based iteration, budget of the nearest loop | inside a loop |
| `{{ stage.index }}`, `{{ stage.total }}`, `{{ stage.id }}`, `{{ stage.title }}` | Current stage | inside a stages step |

Templated fields: agent `prompt`, `allow_paths`; command `run` (as shell variables), `cwd`,
`env` values; manual/approval `title`, `instructions`; stages `items`; `worktree.base`,
`worktree.branch`. An unknown `run.*`, `loop.*` or `stage.*` field is refused. Other `{{ }}`
text is left alone.

## MCP servers and plugins

Restrict what agent steps may use. Both `mcp:` and `plugins:` take **either** `allow`
(`allow: [names]`) or `deny` (`deny: [names]`), never both; `allow: []` means none. A step's setting replaces the
workflow's, never merges. Absent everywhere = unrestricted.

```yaml
# fragment
mcp:
  servers:                     # workflow level only
    docs: { type: http, url: "https://example.test/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } }
    pw: { command: npx, args: ["@playwright/mcp@latest"], env: { KEY: "${PW_KEY}" } }
  allow: [docs]
plugins:
  deny: [some-plugin]
```

`servers` (workflow level only) maps a name to a definition, either stdio (`command`,
optional `args`, `env`) or remote (`type`: `http` or `sse`, `url`, optional `headers`); no
other keys. Server names follow the input-name rule. A defined server is on only when
a resolved `allow` names it. Write credentials as `${NAME}` references, never literal values.

## Worked examples

### 1. Plan, then implement/review until the review passes

```yaml
name: plan-build
description: Plan with a human, then implement and review until the review passes.
inputs:
  feature:
    required: true
    prompt: What are we building?
steps:
  - id: plan
    runner: claude
    model: opus
    mode: interactive
    writes: false
    output: plan.md
    prompt: |
      We are planning: {{ inputs.feature }}. Work with me on a plan.
      Do not modify any files. The artifact is the agreed plan.

  - id: build
    kind: loop
    until: review
    max_iterations: 4
    steps:
      - id: execute
        runner: claude
        model: sonnet
        mode: headless
        writes: true
        inputs: [plan, review]     # review: previous iteration's findings
        output: execute-report.md
        prompt: |
          Implement the attached plan (attempt {{ loop.iteration }}).
          If review findings are attached, address every point.
          Leave the work uncommitted.
      - id: review
        runner: claude
        model: opus
        mode: headless
        writes: false
        verdict: true
        inputs: [plan, execute]
        output: review.md
        prompt: Review the uncommitted diff (`git diff`) against the attached plan.
```

### 2. Test-fix loop inside a review loop, inside a human sign-off loop

```yaml
name: iterate-lite
inputs:
  feature:
    required: true
  test_command:
    required: false
    default: npm test
    multiline: false
steps:
  - id: plan
    runner: claude
    mode: interactive
    writes: false
    inputs: [attachments]
    output: plan.md
    prompt: "Plan with me: {{ inputs.feature }}. Do not modify files."

  - id: human-review
    kind: loop
    until: sign-off
    max_iterations: 5
    steps:
      - id: do-review
        kind: loop
        until: review
        max_iterations: 5
        steps:
          - id: test-fix
            kind: loop
            until: tests
            max_iterations: 3
            steps:
              - id: execute
                runner: claude
                mode: headless
                writes: true
                inputs: [plan, tests, review, sign-off]
                output: execute-report.md
                prompt: |
                  Implement the attached plan; leave it uncommitted.
                  Fix every failure in an attached tests log marked VERDICT: FAIL, then
                  address any review findings and sign-off feedback.
              - id: tests
                kind: command
                run: eval "{{ inputs.test_command }}"
                verdict: true
                timeout_ms: 1800000
                output: tests.log
          - id: review
            runner: claude
            mode: headless
            writes: false
            verdict: true
            inputs: [plan, execute, tests, sign-off]
            output: review.md
            prompt: Review the uncommitted diff against the plan.
      - id: sign-off
        kind: approval
        title: "Ship {{ inputs.feature }}?"
        instructions: Accept, or send it back with comments on the diff.
        show_diff: true
        capture: review
        verdict: true
        inputs: [review]
        output: sign-off.md

  - id: commit
    kind: command
    run: git add -A -- . ":![.]whiphand/*" && git commit -m "{{ inputs.feature }}"
    output: commit.log
```

`execute` names `tests` (later in `test-fix`), `review` (later in `do-review`) and `sign-off`
(later in `human-review`): each is the previous iteration of its own loop, dropped when absent.

### 3. Stages: plan into files, then build and gate each one

```yaml
name: staged
inputs:
  feature:
    required: true
worktree:
  branch: "feature/{{ run.slug }}"
steps:
  - id: plan
    runner: claude
    mode: interactive
    writes: true
    allow_paths: ["{{ run.dir }}/plans/**"]
    output: plan.md
    prompt: |
      Plan {{ inputs.feature }} with me, then write one file per stage to
      {{ run.dir }}/plans/NN-slug.md, each opening with a "# Title" line.

  - id: build
    kind: stages
    items: "{{ run.dir }}/plans/*.md"
    max_retries: 2
    steps:
      - id: do-review
        kind: loop
        until: review
        max_iterations: 5
        steps:
          - id: execute
            runner: claude
            mode: headless
            writes: true
            inputs: [stage, review]
            output: execute-report.md
            prompt: |
              Implement stage {{ stage.index }}/{{ stage.total }}: {{ stage.title }}.
              Leave it uncommitted.
          - id: review
            runner: claude
            mode: headless
            writes: false
            verdict: true
            inputs: [stage, execute]
            output: review.md
            prompt: Review the uncommitted diff against this stage only.
      - id: accept
        kind: approval
        title: "Stage {{ stage.index }}/{{ stage.total }}: {{ stage.title }}"
        instructions: Accept this stage before the next one starts.
        show_diff: true
        default: abort
        inputs: [stage, review]
        output: accept.md
      - id: commit
        kind: command
        # Skip the commit when the stage changed nothing; exclude the run folder.
        run: git add -A -- . ":![.]whiphand/*" && (git diff --cached --quiet || git commit -m "$WHIPHAND_STAGE_TITLE")
        output: commit.log
```

`accept` is the required gate after the `review` verdict; `default: abort` lets `--yes` runs
start without waving stages through.

### 4. Commands only

```yaml
name: check
description: List TODOs, then run the tests; a failing test fails the run.
inputs:
  target:
    required: false
    default: src
steps:
  - id: todos
    kind: command
    run: grep -rn "TODO" "{{ inputs.target }}"
    expect_exit: [0, 1]          # grep exits 1 when it finds nothing
    output: todos.log
  - id: tests
    kind: command
    run: npm test
    timeout_ms: 600000
    output: tests.log
  - id: summary
    kind: command
    inputs: [todos, tests]
    run: tail -n 5 "$WHIPHAND_ARTIFACT_TODOS" "$WHIPHAND_ARTIFACT_TESTS"
```

Without `verdict: true`, an exit outside `expect_exit` fails the run there. With
`verdict: true` outside a loop, a FAIL is handled by `on_findings` (default `report`: the run
ends, failed).

## How to check your work

```bash
whiphand validate path/to/workflow.yaml   # or a workflow name; '-' reads stdin
```

It prints one `error:` or `warning:` line per problem, then `ok: <name>` or `N problems`. Exit
0 = valid (warnings allowed), 1 = problems, 2 = file not found or unreadable. Fix every
`error:` and re-run until it prints `ok:`. It does not check that runners or the shell are
installed (`whiphand doctor` does).
