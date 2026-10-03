/**
 * The engine suites of the core parity corpus (Phase 2d of
 * docs/migration.md), generated like the rest of core-corpus.ts:
 *
 * - `yaml`: the `yaml` package's stringify, which writes every run's
 *   workflow snapshot: every workflow file the corpus knows as a snapshot,
 *   and a matrix of scalars that exercise each quoting and folding rule.
 * - `engine`: the run engine's pure pieces (see engine-probe.ts).
 */
import { workflowFileOps } from './core-corpus.ts';

type Op = Record<string, unknown> & { op: string };

const LONG = 'The quick brown fox jumps over the lazy dog and keeps running far beyond the eighty column mark of a line';

const SCALARS: string[] = [
  '', ' ', '  lead', 'trail ', 'plain', 'true', 'True', 'TRUE', 'false', 'yes', 'no', 'null', 'Null', '~', '0', '-1', '+3',
  '017', '0o17', '0x1F', '1.5', '.5', '1e3', '1.0e-3', '.inf', '-.Inf', '.nan', '1_000', 'v1.2.3', '12:30', 'a: b', 'a:b',
  'a #b', 'a#b', '#hash', '- dash', '-', '? q', '?', ':colon', 'colon:', '[x]', '{x}', 'x{y}', '{{ inputs.a }}',
  'Accept {{ stage.title }}?', '"quoted"', "'single'", 'it\'s', 'say "hi"', 'both \' and "', '*star', '&amp', '!bang', '|pipe',
  '>gt', '%pct', '@at', '`tick`', ',comma', 'tab\there', 'line\nbreak', 'two\n\nbreaks', 'ends\n', 'ends\n\n', '\nstarts',
  '  indented\nnext', 'trailing space \nx', 'x\n  indented line\ny', '---', '--- x', 'a\n---\nb', '...', 'é ü 🚀', '\u0007bell',
  'ctl\u0001x', 'del\u007fx', 'c1\u0085x', 'nbsp x', 'ls x', LONG, `${LONG} ${LONG}`, `word${'x'.repeat(100)}`,
  `${LONG}\n${LONG}`, `short\n${'y'.repeat(120)}\nshort`, `${'é'.repeat(50)} ${'é'.repeat(50)}`, `"${LONG}"`, `${LONG}:`,
  `${LONG} #note`, `a\tb ${LONG}`, `${'a '.repeat(60)}`, `x${' '.repeat(100)}y`, '\t', '\n', 'a\r\nb', `${LONG}\n`,
  `  ${LONG}\nnext`, 'k: v\nk2: v2', '- a\n- b',
];

function yamlOps(): Op[] {
  const ops: Op[] = workflowFileOps().map(o => ({ op: 'workflowSnapshot', file: o.file }));
  ops.push({ op: 'stringifyYaml', value: { scalars: SCALARS } });
  ops.push({ op: 'stringifyYaml', value: Object.fromEntries(SCALARS.slice(0, 60).map((s, i) => [`k${i}`, s])) });
  ops.push({ op: 'stringifyYaml', value: Object.fromEntries(SCALARS.filter(s => s !== '').map(s => [s, 1])) });
  ops.push({ op: 'stringifyYaml', value: { nested: { deeper: { deepest: [LONG, { k: LONG }, [`${LONG}\n${LONG}`]] } } } });
  ops.push({ op: 'stringifyYaml', value: { empty: [], obj: {}, n: 3, f: 1.5, neg: -0.25, t: true, nil: null, big: 1e21, list: [[], {}, [1, [2]]] } });
  ops.push({ op: 'stringifyYaml', value: { '2': 'two', '10': 'ten', b: 'b', a: 'a' } });
  for (const s of SCALARS) ops.push({ op: 'stringifyYaml', value: { prompt: s } });
  return ops;
}

const PLANS = {
  'plans/01-alpha.md': '# Alpha stage\n\nDo alpha.\n',
  'plans/02-beta.md': 'no heading here\n',
  'plans/odd name.md': '#   Odd  \n',
};

const RUNS: Array<[string, string, Record<string, unknown>]> = [
  ['basic', `name: basic
inputs:
  who: { required: true }
  greeting: { required: false, default: hello }
steps:
  - id: greet
    kind: command
    run: printf '%s, %s\\n' "{{ inputs.greeting }}" "{{ inputs.who }}"; printf 'to stderr\\n' >&2
    output: greet.log
  - id: env
    kind: command
    inputs: [greet]
    env: { MSG: "run {{ run.slug }}" }
    run: printf '%s\\n' "$MSG" "$WHIPHAND_STEP_ID"; test -n "$WHIPHAND_ARTIFACT_GREET"
    output: env.log
  - id: three
    kind: command
    run: exit 3
    expect_exit: [0, 3]
    verdict: true
    output: three.log
`, { name: 'My  Run!' }],
  ['loop-passes', `name: loop
steps:
  - id: fix
    kind: loop
    until: check
    max_iterations: 3
    steps:
      - id: work
        kind: command
        inputs: [check]
        run: printf 'iteration {{ loop.iteration }}\\n'
        output: work.log
      - id: check
        kind: command
        verdict: true
        run: n=$(cat ../count 2>/dev/null || echo 0); n=$((n+1)); echo $n > ../count; test $n -ge 2
        cwd: sub
        output: check.log
`, { files: { 'sub/.keep': '' } }],
  ['loop-exhausted', `name: loop
steps:
  - id: fix
    kind: loop
    until: check
    steps:
      - id: check
        kind: command
        verdict: true
        run: exit 1
`, { maxIterations: 2 }],
  ['stages', `name: staged
steps:
  - kind: stages
    id: build
    items: "plans/*.md"
    max_retries: 1
    steps:
      - id: execute
        kind: command
        run: printf 'stage {{ stage.index }}/{{ stage.total }} {{ stage.id }} {{ stage.title }}\\n'; cat "$WHIPHAND_STAGE_PATH"
        output: execute.md
      - id: accept
        kind: approval
        inputs: [stage, execute]
        title: "Accept {{ stage.title }}?"
        instructions: Look.
        capture: review
        output: accept.md
`, { files: PLANS, answers: [
    { choice: 'continue', note: 'fine' },
    { choice: 'retry', note: 'redo', comments: [{ path: 'a.ts', body: ' fix this ' }, { path: 'b.ts', body: '  ' }] },
    { choice: 'continue' },
    { choice: 'continue', note: '' },
  ] }],
  ['stages-exhausted', `name: staged
steps:
  - kind: stages
    id: build
    items: "plans/0*.md"
    max_retries: 0
    steps:
      - id: execute
        kind: command
        run: "true"
      - id: gate
        kind: manual
        title: Gate
        instructions: Decide.
        capture: note
        output: gate.md
`, { files: PLANS, answers: [{ choice: 'continue', note: '  noted  ' }, { choice: 'retry', note: 'no' }] }],
  ['fails', `name: fails
steps:
  - id: a
    kind: command
    run: echo out; exit 2
    output: a.log
  - id: never
    kind: command
    run: "true"
`, {}],
  ['declined', `name: declined
steps:
  - id: ask
    kind: manual
    title: Go?
    instructions: Say.
  - id: after
    kind: command
    run: "true"
`, { answers: [{ choice: 'abort' }] }],
  ['disabled', `name: disabled
steps:
  - id: plan
    kind: command
    run: echo plan
    output: plan.md
    enabled: false
  - id: use
    kind: command
    inputs: [plan]
    run: echo use
  - id: gate
    kind: approval
    title: ok
    instructions: ok
    default: abort
`, { answers: [{ choice: 'continue' }] }],
  ['missing-artifact', `name: missing
steps:
  - id: a
    kind: command
    run: "true"
    output: a.log
  - id: verdictless
    kind: command
    verdict: true
    run: "exit 0"
`, {}],
  ['resume-after-fix', `name: resumable
steps:
  - id: first
    kind: command
    run: echo first
    output: first.log
  - id: fix
    kind: loop
    until: check
    max_iterations: 2
    steps:
      - id: check
        kind: command
        verdict: true
        run: test -f ok
        output: check.log
  - id: needs
    kind: command
    run: test -f ok2
  - id: last
    kind: command
    inputs: [first]
    run: cat "$WHIPHAND_ARTIFACT_FIRST"
    output: last.log
`, { resume: { files: { ok: '', ok2: '' } } }],
  ['resume-refused', `name: done
steps:
  - id: a
    kind: command
    run: "true"
`, { resume: {} }],
  ['resume-stage', `name: staged
steps:
  - kind: stages
    id: build
    items: "plans/0*.md"
    max_retries: 0
    steps:
      - id: execute
        kind: command
        run: "true"
        output: x.md
      - id: gate
        kind: approval
        title: Gate
        instructions: Decide.
`, { files: PLANS, answers: [{ choice: 'continue' }, { choice: 'retry' }, { choice: 'continue' }], resume: { extraIterations: 1 } }],
  ['refused', `name: refused
inputs:
  need: { required: true }
steps:
  - id: a
    kind: command
    run: "true"
  - id: b
    runner: nobody
    mode: headless
    writes: true
    prompt: x
    output: b.md
`, {}],
];

function engineOps(): Op[] {
  const ops: Op[] = [];
  for (const o of workflowFileOps()) {
    ops.push({ op: 'runWorkflow', file: o.file, dryRun: true, files: PLANS });
  }
  for (const [, yaml, extra] of RUNS) ops.push({ op: 'runWorkflow', yaml, ...extra });
  return ops;
}

export const ENGINE_SUITES: Record<string, () => Op[]> = {
  yaml: yamlOps,
  engine: engineOps,
};
