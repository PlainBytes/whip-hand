# Staged Plans (`kind: stages`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second cycle kind, `kind: stages`, that runs a workflow body once per stage file in a repository directory — each stage implemented by a fresh agent, reviewed, accepted by a human and committed before the next one starts — plus a shipped `staged-feature-development` workflow built from today's `feature-development`.

**Architecture:** `stages` is a container step beside `loop`. Stage files are discovered by a templated glob, re-read before every stage, and the position is the first stage id not yet completed. A stage opens a `StageFrame` on the existing frame chain (today `LoopFrame.parent`), so it inherits per-execution artifact paths, execution keys, manifest rows and skip-based resume — a stage frame is row-shaped exactly like a loop frame (`loopId` = the stages step, `iteration` = the attempt) plus one new `stage` discriminator. Per-stage context isolation is a save/restore of `ctx.artifacts`, `ctx.verdicts` and `extraFindings` around each stage. The engine never runs git: committing is a `command` step the author writes, fed by new `$WHIPHAND_ARTIFACT_*` / `$WHIPHAND_STAGE_*` environment variables.

**Tech Stack:** TypeScript (node:test for core/CLI/parity, vitest for desktop), zod 4 schemas in `packages/core/src/schema.ts` + `events.ts`, React 18 + Fluent UI v9 desktop, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-09-08-staged-plans-design.md` — read it before Task 1. The spec was agreed on 2026-09-08 and the code has moved since; the deviations below are deliberate and approved.

---

## Context

`whiphand` runs a workflow that plans once into `plan.md`, then implements and reviews in a cycle until a human signs off (`.whiphand/workflows/feature-development.yaml`). On a large feature that collapses: one plan is too big for an implementer step to hold, too big for a reviewer to check against a diff, and the single sign-off at the end is over a change nobody can read. What a careful engineer does instead is cut the work into stages and build, review, accept and commit one at a time.

The engine cannot express that today because the step tree is static: `flattenSteps` (`packages/core/src/steps.ts:42`) expands the workflow once, up front, and `kind: loop` repeats a *fixed* body until a verdict passes. Nothing can say "run this body once per item in a set that does not exist until the plan does". This plan adds that, and the workflow that uses it.

### Base branch — already in place

This plan is written against the command-feedback work (`b7d897e`, merged as `3171692`), which it depends on in three places: `ctx.verdicts` (verdict labels on input-artifact lines), `locateSteps`/`isForwardRef` forward-reference scoping in `scopeInputs`, and the `test-fix` loop shape the shipped workflows now use.

**Done on 2026-09-16:** local `main` was rebased onto `origin/main`, so it now reads `6243ec6 Version 0.1.7` on top of `3171692`, one commit ahead of the remote and clean. Verified green on that base: `npm run typecheck` clean, `npm test` 1203 passing / 0 failing / 6 skipped. Start Task 1 from here; if the tree has moved on again, re-check with `grep -c verdicts packages/core/src/engine/runner.ts` (expect a non-zero count) before building.

### What changed since the spec was written

| Spec says | Reality today | Consequence for this plan |
|---|---|---|
| "Frames become a stack" (`RunCtx.frames: Frame[]`) | Nested loops already ship: `LoopFrame.parent` chain, `ancestorLoops`, `outerLoops` on events and manifest rows | Generalize the existing chain (`Frame = LoopFrame \| StageFrame`) instead of introducing an array. |
| manifest `version` gains `3` | Manifest is already `MANIFEST_VERSION = 4` (`engine/manifest.ts:94`) | Stages bump it to **5**. |
| `stage` is a reserved step id | The shipped `feature-development` template has `id: stage` (`scaffold.ts:418`) | **Decision:** reserve `stage` only in a workflow that contains a `kind: stages` step, and reject `inputs: [stage]` outside a stages body. No existing workflow breaks. |
| Re-discovery matches "the last completed stage id" | — | **Decision:** track the set of completed stage ids and take the first not in it, so a stage inserted anywhere runs and a deleted file cannot derail position. |
| `stage.id` is the slug with the `NN-` ordinal stripped | — | **Deviation:** `stage.id` is the **whole basename** (`03a-api`). Stripping ordinals makes `01-api.md` and `03a-api.md` collide on `api`, and with the completed-set rule the second would silently never run. Consequence, documented in the README: renumbering a *completed* stage file makes it run again. |
| `commit` is `git commit -m "$WHIPHAND_STAGE_TITLE"` | `feature-development` writes commit messages with a haiku step | **Decision:** the shipped staged workflow keeps the haiku commit-message step, per stage. |
| Manual steps are implicitly verdict-bearing "inside any frame" | `executeLoop` ignores a `verdict-fail` from any non-`until` body step, and `until` already requires `verdict: true` | **Deviation:** implicit verdicts apply **inside a stage frame only**. Inside a loop the change would be inert, so it is not worth the blast radius. |
| `run:resume.iteration` exists | It is in `types.ts:458` but missing from `events.ts:86-88`, so it is stripped over RPC | Fixed as a one-line drive-by in Task 6 (that file is being edited anyway). |

## Global Constraints

- Node `>=24` (`package.json` engines); local node is v25.9.0 via nvm. Desktop vitest needs `NODE_OPTIONS=--no-experimental-webstorage` locally. `path.matchesGlob` and `fs.promises.glob` are both available and behave as this plan assumes (verified on this machine).
- `npm run verify` is the gate: `npm run typecheck` (covers `packages/*/src` and `parity/` only), `npm test`, `npm run test:parity`, `npm run test -w desktop`, `npm run build -w desktop` (this is where desktop `tsc` runs), `cargo check`.
- One idea gets one name across core, RPC, CLI and UI: the word is **stage** (`kind: stages`, `stage.*` templates, `$WHIPHAND_STAGE_*`, "Stage 3 of 7" in every surface).
- The engine never runs git on the author's behalf. Committing is always a `command` step in the workflow.
- Manifests v1–v5 must all still parse; no migration code. **Every new persisted field must be added to the zod schema in the same edit** — zod strips unknown keys, so a field that reaches disk but not the schema is silently lost on the next read, and stage identity is exactly what would be lost.
- `packages/core/src/execution-key.ts`, `format.ts` and `log-rows.ts` are imported directly by the desktop web bundle — they must stay free of node builtins.
- Sequential only: one working tree, no worktrees, no parallel stages, no `prev.*` cross-stage artifact references.
- Every task ends green on the commands it names, and commits.

## File map

**New files**
- `packages/core/src/engine/stages.ts` — stage discovery: glob, ordering, id/title extraction, next-stage selection.
- `packages/core/src/engine/stages.test.ts`
- `packages/core/src/engine/runner.stages.test.ts` — `stages` runner behaviour (kept apart from `runner.loops.test.ts`, which stays a record of loop behaviour).
- `apps/desktop/src/components/StagesView.tsx` (or a `StagesView` section inside `RunStepper.tsx`, matching `LoopView`).
- `parity/fixtures/workspace/.whiphand/workflows/staged.yaml` + `parity/fixtures/workspace/plans/` stage files.

**Core, modified:** `types.ts`, `execution-key.ts`, `engine/artifacts.ts`, `engine/runner.ts`, `engine/command.ts`, `engine/git-guard.ts`, `engine/manifest.ts`, `engine/resume.ts`, `engine/manual.ts`, `schema.ts`, `steps.ts`, `enabled.ts`, `template.ts`, `events.ts`, `log-rows.ts`, `format.ts`, `scaffold.ts`, `index.ts`.

**CLI, modified:** `render.ts`, `prompt.ts`, `program.ts`.

**Desktop, modified:** `state/store.ts`, `lib/run-tree.ts`, `components/RunStepper.tsx`, `components/StepSummary.tsx`, `review/from-manual.ts`, `components/NotificationBridge.tsx`, `components/OngoingRuns.tsx`, `pages/run-columns.tsx`, `pages/RunDetailPage.tsx`, `workflow-editor/StepCard.tsx`, `workflow-editor/StepRail.tsx`, `lib/step-tree.ts`, `lib/editor-model.ts`, `lib/draft-normalize.ts`, `lib/step-describe.ts`, `components/workflow-lane/*`.

**Docs:** `README.md`, `docs/design.md`, `.whiphand/workflows/staged-feature-development.yaml` (dogfood copy).

---

## Task 1: Frame chain generalization (no behaviour change)

The existing suite must pass untouched — this task only widens types and key/path helpers.

**Files**
- Modify: `packages/core/src/types.ts`, `execution-key.ts`, `engine/artifacts.ts`, `events.ts`, `engine/manifest.ts` (schemas only), `engine/runner.ts` (frame plumbing only), `apps/desktop/src/state/store.ts` (`StepState.kind`)
- Test: `packages/core/src/execution-key.test.ts`, `packages/core/src/engine/artifacts.test.ts`

**Interfaces — Produces**

```ts
// types.ts
export interface Stage {
  index: number;   // 1-based, recomputed on every pass
  total: number;
  id: string;      // basename without extension, e.g. '03a-api' — unique per file
  title: string;   // first markdown heading, falling back to id
  path: string;    // absolute
}
export interface StageFrame {
  kind: 'stages';
  id: string;            // the stages step's id
  stage: Stage;
  attempt: number;       // 1-based
  maxAttempts: number;   // 1 + max_retries
  parent?: Frame;
}
export interface LoopFrame { id: string; iteration: number; maxIterations: number; parent?: Frame }
export type Frame = LoopFrame | StageFrame;
/** A stages frame is a loop-shaped ref plus the stage it is on. */
export interface LoopRef { id: string; iteration: number; stage?: string }
// RunCtx gains: frame?: Frame;   (ctx.loop stays, and is now the nearest LoopFrame)

// execution-key.ts
export function isStageFrame(frame: Frame | undefined): frame is StageFrame;
export function nearestLoop(frame: Frame | undefined): LoopFrame | undefined;
export function nearestStage(frame: Frame | undefined): StageFrame | undefined;
export function frameRef(frame: Frame): LoopRef;
export function ancestorLoops(frame: Frame | undefined): LoopRef[];   // unchanged signature, widened input
export function executionKey(
  stepId: string, iteration?: number, outerLoops?: readonly LoopRef[], stage?: string): string;
export function frameIdentity(frame: Frame | undefined):
  { loopId?: string; iteration?: number; stage?: string; outerLoops: LoopRef[] };
```

`frameIdentity` is the single place that turns a frame into the tuple every emit site, the journal and resume already speak. A stage frame is deliberately **loop-shaped**, so nothing that uses `loopId` as "my container" has to learn a second parenting concept:
- no frame → `{ outerLoops: [] }`
- loop frame → `{ loopId: f.id, iteration: f.iteration, outerLoops: ancestorLoops(f) }`
- stage frame → `{ loopId: f.id, iteration: f.attempt, stage: f.stage.id, outerLoops: ancestorLoops(f) }`

- [ ] **Step 1: Write the failing key and path tests**

```ts
// execution-key.test.ts
test('a stage frame keys as step@stage#attempt, and never collides across stages', () => {
  assert.equal(executionKey('accept', 1, [], 'schema'), 'accept@schema#1');
  assert.equal(executionKey('accept', 1, [], 'api'), 'accept@api#1');
  assert.equal(executionKey('accept', 2, [], 'api'), 'accept@api#2');
});

test('a loop nested in a stage carries the stage in its outer chain', () => {
  const stage = { index: 2, total: 7, id: '02-api', title: 'Add API routes', path: '/p/02-api.md' };
  const sf: StageFrame = { kind: 'stages', id: 'build', stage, attempt: 2, maxAttempts: 3 };
  const lf: LoopFrame = { id: 'cycle', iteration: 3, maxIterations: 3, parent: sf };
  const idn = frameIdentity(lf);
  assert.deepEqual(idn.outerLoops, [{ id: 'build', iteration: 2, stage: '02-api' }]);
  assert.equal(executionKey('execute', idn.iteration, idn.outerLoops, idn.stage), 'build@02-api#2/execute#3');
});

test('a plain loop key is byte-identical to before stages existed', () => {
  assert.equal(executionKey('edit', 1), 'edit');
  assert.equal(executionKey('edit', 2), 'edit#2');
  assert.equal(executionKey('edit', 1, [{ id: 'outer', iteration: 2 }]), 'outer#2/edit#1');
});

test('sameLoopRefs separates two stages of the same stages step', () => {
  assert.equal(sameLoopRefs([{ id: 'b', iteration: 1, stage: 'a' }], [{ id: 'b', iteration: 1, stage: 'c' }]), false);
});
```

```ts
// artifacts.test.ts
test('a stage frame gets one directory per stage and attempt', () => {
  const stage = { index: 2, total: 7, id: '02-api', title: 'T', path: '/p/02-api.md' };
  const f: StageFrame = { kind: 'stages', id: 'build', stage, attempt: 1, maxAttempts: 3 };
  assert.equal(artifactPath('/run', { output: 'accept.md' }, f),
    join('/run', 'build', '02-api', 'attempt-1', 'accept.md'));
  const loop: LoopFrame = { id: 'cycle', iteration: 1, maxIterations: 3, parent: { ...f, attempt: 2 } };
  assert.equal(artifactPath('/run', { output: 'execute-report.md' }, loop),
    join('/run', 'build', '02-api', 'attempt-2', 'cycle', 'iter-1', 'execute-report.md'));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsc --noEmit && node --test packages/core/src/execution-key.test.ts packages/core/src/engine/artifacts.test.ts`
Expected: FAIL — `frameIdentity` / `StageFrame` do not exist.

- [ ] **Step 3: Implement**

`execution-key.ts` — keep the promise that a single-level loop key is byte-identical, and give a stage its own always-explicit segment:

```ts
const segment = (id: string, n: number | undefined, stage: string | undefined, bare: boolean): string => {
  // A stage segment is never bare: two stages of one stages step must not collapse onto one key.
  if (stage !== undefined) return `${id}@${stage}#${n ?? 1}`;
  return bare && (n === undefined || n === 1) ? id : `${id}#${n ?? 1}`;
};
```
`bare` is `outerLoops.length === 0`, exactly as today. `sameLoopRefs` gains `&& r.stage === bb[i].stage`.

`artifacts.ts` — segments are derivable from a `LoopRef` alone, which is what lets resume rebuild a path (Task 9):

```ts
const segments = chain.flatMap(f => isStageFrame(f)
  ? [f.id, f.stage.id, `attempt-${f.attempt}`]
  : [f.id, `iter-${f.iteration}`]);
```

`runner.ts` — `executeStep(step, frame?: Frame)`; set `ctx.frame = frame` and `ctx.loop = nearestLoop(frame)` in the try/finally that today assigns `ctx.loop` (runner.ts:824-868); replace the `executionKey(step.id, frame?.iteration, ancestorLoops(frame))` sites (runner.ts:834-835, 885) with `frameIdentity(...)`; `executeLoop`'s `const outer = ctx.loop` becomes `const outer = ctx.frame`; `scopeInputs`'s forward-ref walk is typed over `Frame` and **skips stage frames** while looking for the owning loop.

Schemas, in this same edit (a persisted field that misses its schema is silently dropped on read):
- `events.ts` `loopRefSchema` gains `stage: z.string().optional()`.
- `manifest.ts:35` row `outerLoops` element gains the same optional field; the row itself gains `stage: z.string().optional()`.
- `apps/desktop/src/state/store.ts` `StepState` gains `stage?: string` so the RPC-carried field survives into the store.

- [ ] **Step 4: Full suite green, no behaviour change**

Run: `npm run typecheck && npm test`
Expected: PASS, including every existing loop, resume and manifest test unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src apps/desktop/src
git commit -m "Generalize the loop frame chain to loop and stage frames"
```

---

## Task 2: Command steps read `inputs:` and stage environment

**Files**
- Modify: `packages/core/src/engine/command.ts`, `engine/runner.ts` (`executeCommand` scoping), `enabled.ts` (`droppedRefs` no longer skips command steps)
- Test: `packages/core/src/engine/command.test.ts`, `packages/core/src/enabled.test.ts`

**Interfaces — Produces**

```ts
// command.ts
export function artifactEnvName(stepId: string): string;   // 'execute-report' -> 'WHIPHAND_ARTIFACT_EXECUTE_REPORT'
// commandSpec(step, ctx, capturePath?) additionally sets:
//   WHIPHAND_ARTIFACT_<ID>=<path>   per input naming a step with a recorded artifact
//   WHIPHAND_STAGE_ID / _TITLE / _INDEX / _TOTAL / _PATH   inside a stage frame
// and renders step.env values through renderTemplate.
```

- [ ] **Step 1: Write the failing tests**

```ts
test('a command step exports each input artifact as an environment variable', () => {
  const ctx = { ...baseCtx, artifacts: { 'execute-report': '/run/exec.md', plan: '/run/plan.md' } };
  const spec = commandSpec(
    { kind: 'command', id: 'commit', run: 'git commit', inputs: ['execute-report', 'plan'] }, ctx);
  assert.equal(spec.env.WHIPHAND_ARTIFACT_EXECUTE_REPORT, '/run/exec.md');
  assert.equal(spec.env.WHIPHAND_ARTIFACT_PLAN, '/run/plan.md');
});

test('inside a stage, a command step is told which stage it is in', () => {
  const stage = { index: 2, total: 7, id: '02-api', title: 'Add API routes', path: '/p/02-api.md' };
  const ctx = { ...baseCtx, frame: { kind: 'stages', id: 'build', stage, attempt: 1, maxAttempts: 3 } };
  const spec = commandSpec({ kind: 'command', id: 'commit', run: 'git commit' }, ctx);
  assert.equal(spec.env.WHIPHAND_STAGE_TITLE, 'Add API routes');
  assert.equal(spec.env.WHIPHAND_STAGE_INDEX, '2');
  assert.equal(spec.env.WHIPHAND_STAGE_TOTAL, '7');
  assert.equal(spec.env.WHIPHAND_STAGE_PATH, '/p/02-api.md');
  assert.equal(spec.env.WHIPHAND_STAGE_ID, '02-api');
});

test("a command step's own env values are templated", () => {
  const ctx = { ...baseCtx, inputs: { plan_dir: 'docs/plans/oauth' } };
  const spec = commandSpec(
    { kind: 'command', id: 'c', run: 'true', env: { WHIPHAND_PLAN_DIR: '{{ inputs.plan_dir }}' } }, ctx);
  assert.equal(spec.env.WHIPHAND_PLAN_DIR, 'docs/plans/oauth');
});

test('an input with no recorded artifact exports nothing rather than an empty variable', () => {
  const spec = commandSpec({ kind: 'command', id: 'c', run: 'true', inputs: ['nope'] }, baseCtx);
  assert.equal('WHIPHAND_ARTIFACT_NOPE' in spec.env, false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test packages/core/src/engine/command.test.ts`
Expected: FAIL — `spec.env.WHIPHAND_ARTIFACT_EXECUTE_REPORT` is `undefined`.

- [ ] **Step 3: Implement**

```ts
export function artifactEnvName(stepId: string): string {
  return `WHIPHAND_ARTIFACT_${stepId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
```
In `commandSpec`, build the artifact env from `inputArtifacts(step.inputs ?? [], ctx)` (`template.ts:63`), skipping entries whose `path` is `undefined` and the `attachments/…` expansions (those are files, not steps). Add the stage block from `nearestStage(ctx.frame)`. Template `step.env` values with `renderTemplate(v, ctx)` — the same reason `run:` and `cwd:` already are. Environment rather than interpolation, for the reason the existing comment gives about run names: a stage title is arbitrary human text and pasting it into a `sh -c` string is a quoting hazard.

`runner.ts:670` — `executeCommand` builds its spec from `scopeInputs(step, frame)`, so a forward reference inside a loop is dropped for a command exactly as for an agent.

`enabled.ts:91` — drop `|| isCommandStep(step)` from `droppedRefs` and update the comment: a command step's `inputs:` is no longer a runtime no-op. Fix the one `enabled.test.ts` expectation this flips.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "Give command steps their input artifacts and stage as environment"
```

---

## Task 3: `allow_paths` enforcement

`allow_paths` is declared (`types.ts:62`), validated (`schema.ts:71`) and editable in the desktop, and read by nothing. The planner now writes into the repository, so this is the one thing we can still prove about it.

**Files**
- Modify: `packages/core/src/engine/git-guard.ts`, `engine/runner.ts` (`finishStep`)
- Test: `packages/core/src/engine/git-guard.test.ts`, `packages/core/src/engine/runner.test.ts`

**Interfaces — Produces**

```ts
// git-guard.ts
export function pathsOutside(paths: string[], globs: string[]): string[];  // paths matching no glob, in order
```

- [ ] **Step 1: Write the failing tests**

```ts
// git-guard.test.ts
test('pathsOutside returns only the paths no glob covers', () => {
  const globs = ['docs/plans/oauth/**', 'CHANGELOG.md'];
  assert.deepEqual(
    pathsOutside(['docs/plans/oauth/01-schema.md', 'CHANGELOG.md', 'src/app.ts'], globs), ['src/app.ts']);
});

test('a glob with no wildcard still matches its own path', () => {
  assert.deepEqual(pathsOutside(['CHANGELOG.md'], ['CHANGELOG.md']), []);
});
```

```ts
// runner.test.ts — beside the existing read-only guard test (runner.test.ts:1015), reusing its git fixture
test('a writes step that writes outside allow_paths fails the run and names the file', async () => {
  // one agent step, writes: true, allow_paths: ['docs/plans/**'],
  // whose spawn writes docs/plans/01-a.md AND src/sneaky.ts
  assert.equal(result.ok, false);
  assert.match(errorMessage(h), /step 'plan' wrote outside allow_paths: src\/sneaky\.ts/);
});

test('a writes step staying inside allow_paths passes', async () => { /* only docs/plans/01-a.md written */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test packages/core/src/engine/git-guard.test.ts`
Expected: FAIL — `pathsOutside` is not exported.

- [ ] **Step 3: Implement**

```ts
import { matchesGlob } from 'node:path';

export function pathsOutside(paths: string[], globs: string[]): string[] {
  return paths.filter(p => !globs.some(g => matchesGlob(p, g)));
}
```
In `finishStep` (`runner.ts:445-458`), inside the existing `before !== null` block that already computes `changed`, after the read-only check:

```ts
if (isAgentStep(step) && step.writes && (step.allow_paths?.length ?? 0) > 0) {
  const globs = step.allow_paths!.map(g => renderTemplate(g, ctx));
  const outside = pathsOutside(pathsFromStatusLines(changed), globs);
  if (outside.length > 0) {
    return fail(`step '${step.id}' wrote outside allow_paths: ${outside.join(', ')}`, step.id);
  }
}
```
Reuses the snapshot the guard already takes — no second `git status`. Note the inherited limitation, worth a comment: a file already dirty *before* the step and modified again produces the same porcelain line, so it does not appear in `changed`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "Enforce allow_paths from the tree snapshot the guard already takes"
```

---

## Task 4: Stage discovery

**Files**
- Create: `packages/core/src/engine/stages.ts`, `packages/core/src/engine/stages.test.ts`

**Interfaces — Produces**

```ts
// engine/stages.ts
export class StageError extends Error {}
export function stageTitleOf(text: string, fallback: string): string;   // first '# ' heading, else fallback
export async function discoverStages(workdir: string, pattern: string): Promise<Stage[]>;
export function nextStage(stages: Stage[], completed: ReadonlySet<string>): Stage | undefined;
/** Names that do not read as 'NN-slug' — reported as guard warnings, not failures. */
export function oddStageNames(stages: Stage[]): string[];
```

- [ ] **Step 1: Write the failing tests**

```ts
test('stages are ordered by path, and an inserted 03a sorts between 03 and 04', async () => {
  const dir = await tmpPlanDir({ '01-schema.md': '# Schema\n', '03-api.md': '# API\n',
    '03a-api.md': '# API routes\n', '04-ui.md': '# UI\n' });
  const stages = await discoverStages(dir, 'plans/*.md');
  assert.deepEqual(stages.map(s => s.id), ['01-schema', '03-api', '03a-api', '04-ui']);
  assert.deepEqual(stages.map(s => s.index), [1, 2, 3, 4]);
  assert.equal(stages[0].total, 4);
  assert.ok(stages.every(s => isAbsolute(s.path)));
});

test('the id is the whole basename, so two stages of the same topic never collide', async () => {
  const dir = await tmpPlanDir({ '01-api.md': '# One\n', '03a-api.md': '# Two\n' });
  const stages = await discoverStages(dir, 'plans/*.md');
  assert.deepEqual(stages.map(s => s.id), ['01-api', '03a-api']);
});

test('the title is the first markdown heading, falling back to the id', async () => {
  const dir = await tmpPlanDir({ '01-a.md': 'preamble\n\n#  Add API routes  \n\nbody\n', '02-b.md': 'no heading\n' });
  const stages = await discoverStages(dir, 'plans/*.md');
  assert.equal(stages[0].title, 'Add API routes');
  assert.equal(stages[1].title, '02-b');
});

test('a filename that would corrupt an execution key is refused by name', async () => {
  const dir = await tmpPlanDir({ '01-a@b.md': '# x\n' });
  await assert.rejects(() => discoverStages(dir, 'plans/*.md'),
    /stage file '01-a@b\.md': a stage name cannot contain '@', '#', '\/' or '\\'/);
});

test('nextStage takes the first id not already completed, wherever it was inserted', () => {
  const stages = [stage('01-schema', 1), stage('02-api', 2), stage('03-ui', 3)];
  assert.equal(nextStage(stages, new Set(['01-schema']))?.id, '02-api');
  assert.equal(nextStage(stages, new Set(['01-schema', '02-api', '03-ui'])), undefined);
  assert.equal(nextStage([stage('00-intro', 1), ...stages], new Set(['01-schema']))?.id, '00-intro');
});

test('an unpadded ordinal is reported so a 9/10 mis-sort is visible', () => {
  assert.deepEqual(oddStageNames([stage('9-a', 1), stage('10-b', 2), stage('notes', 3)]), ['notes']);
});

test('an empty match is an empty list, not an error', async () => {
  assert.deepEqual(await discoverStages(await tmpPlanDir({}), 'plans/*.md'), []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test packages/core/src/engine/stages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`glob` from `node:fs/promises` with `{ cwd: workdir }` (the pattern is always workdir-relative — never process cwd), resolved to absolute paths, sorted by the relative path with a plain `<` comparison so `03a` lands between `03` and `04`. `stage.id` is `basename(path).replace(/\.[^.]+$/, '')`, refused when it contains `@`, `#`, `/` or `\`. `stageTitleOf` takes the first `/^#\s+(.+?)\s*$/m` match, trimmed. `oddStageNames` returns ids not matching `^\d+[a-z]*-`, which the runner emits as `guard:warning` — the `NN-` convention is what makes ordering predictable, and silence about a stray file would be worse than a warning.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && node --test packages/core/src/engine/stages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/stages.ts packages/core/src/engine/stages.test.ts
git commit -m "Add stage discovery: glob, order, id and title"
```

---

## Task 5: `stages` in the type system, schema, tree helpers and templates

No runner support yet — a `stages` workflow parses, validates and flattens, and the desktop still compiles.

**Files**
- Modify: `packages/core/src/types.ts`, `schema.ts`, `steps.ts`, `enabled.ts`, `template.ts`, `events.ts` (`step:start.kind`), `engine/manifest.ts` (kind enum + `stagesId`), `index.ts`
- Modify (compile-keeping only): `apps/desktop/src/workflow-editor/StepRail.tsx` (`convertStep`), `StepCard.tsx` (`KIND_OPTIONS`), `components/StepSummary.tsx` (`KIND_COLOR`)
- Test: `packages/core/src/schema.test.ts`, `template.test.ts`, `enabled.test.ts`

**Interfaces — Produces**

```ts
// types.ts
export type StepKind = 'agent' | 'command' | 'manual' | 'approval' | 'loop' | 'stages';
export interface StagesStep {
  kind: 'stages';
  id: string;
  items: string;          // templated glob, relative to the workdir
  steps: Step[];
  max_retries?: number;   // default 2; deliberately NOT overridden by --max-iterations
  enabled?: boolean;
}
export type Step = AgentStep | CommandStep | ManualStep | LoopStep | StagesStep;
export const STAGE_REF = 'stage';   // the reserved pseudo-artifact id

// steps.ts
export function isStagesStep(step: Step): step is StagesStep;
export function isContainerStep(step: Step): step is LoopStep | StagesStep;
export function childSteps(step: Step): Step[];   // [] for leaves
export function isLeafStep(step: Step): step is AgentStep | CommandStep | ManualStep;  // now !isContainerStep
export interface FlatStep { step: Step; loopId?: string; stagesId?: string; depth: number }
```

- [ ] **Step 1: Write the failing schema and template tests**

```ts
// schema.test.ts
test('a stages step parses with its glob, body and default retries', () => {
  const stages = parseWorkflow(STAGED_YAML).steps[1];
  assert.equal(stages.kind, 'stages');
  assert.equal(stages.items, '{{ inputs.plan_dir }}/*.md');
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

test("'stage' is only reserved in a workflow that has a stages step", () => {
  parseWorkflow(FEATURE_DEVELOPMENT_YAML);          // has `id: stage`, no stages step — still parses
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
```

```ts
// template.test.ts
test('stage.* renders inside a stage frame', () => {
  const stage = { index: 2, total: 7, id: '02-api', title: 'Add API routes', path: '/p/02-api.md' };
  const scope = { inputs: {}, runId: 'r', runSlug: 'r',
    frame: { kind: 'stages', id: 'build', stage, attempt: 1, maxAttempts: 3 } };
  assert.equal(renderTemplate('Stage {{ stage.index }}/{{ stage.total }}: {{ stage.title }}', scope),
    'Stage 2/7: Add API routes');
});

test('stage.* outside a stages step is a TemplateError', () => {
  assert.throws(() => renderTemplate('{{ stage.title }}', { inputs: {}, runId: 'r', runSlug: 'r' }),
    /'stage.title' is only available inside a stages step/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test packages/core/src/schema.test.ts packages/core/src/template.test.ts`
Expected: FAIL — `kind must be one of agent, command, manual, approval, loop`.

- [ ] **Step 3: Implement**

`schema.ts`
- `stagesStepSchema`: `{ kind: z.literal('stages'), id: requiredText(), items: requiredText(), steps: z.array(stepSchema).min(1), max_retries: z.number().int().nonnegative().optional(), enabled: z.boolean().optional() }`, added to `stepUnion`.
- `FIELD_OWNER`: add `items: 'stages'`, `max_retries: 'stages'`. `steps` stays owned by `'loop'`; add a `SHARED_FIELDS = new Set(['steps'])` escape in `ownerMatches` so a misplaced `until` on a stages step still names `loop`.
- `FIELD_LABELS`: `items: 'Stage files'`, `max_retries: 'Max retries'`.
- `locate()` recurses through `childSteps(step)`; `Located`/`StepTreeLocation` gain `stagesId?: string` and `stagesChain: string[]`, kept **separate** from `loopChain` so a cross-stage forward reference stays a validation error rather than becoming legal.
- `validateWorkflowSemantics`: reject a `stages` step whose `loopChain` or `stagesChain` is non-empty; reject `id === STAGE_REF` when the tree contains any stages step; allow an `inputs` entry equal to `STAGE_REF` when the reader's `stagesId !== undefined` and reject it otherwise (skipping the unknown-step check for it, as `ATTACHMENTS_REF` is skipped at `schema.ts:321`); extend the "references loop … which produces no artifact" branch to `isContainerStep`; for each `stages` step, require a manual/approval step somewhere after each `loop` in its body.
- `validateLoop`: `until` naming a container step is refused with the kind in the message.

`steps.ts` — `childSteps` returns `isContainerStep(step) ? step.steps : []`; `flattenSteps`, `findStep`, `collectLoops`, `isLeafStep` all go through it; `flattenSteps` threads `stagesId` down and keeps `loopId` for loop parents only.

`enabled.ts` — `pruneList`, `disabledIds`' descendant expansion, `droppedRefs` and `untilTargetOf` recurse through `childSteps` instead of `isLoopStep`, so disabling a stages step takes its body with it.

`runner.ts:181-186` — the `on_findings: 'loop'` startup guard tests `!isLoopStep(step) && step.verdict`; switch to `!isContainerStep(step)`.

`template.ts` — `TemplateScope` gains `frame?: Frame` (`RunCtx` satisfies it structurally); `PLACEHOLDER` gains `stage\.(?:index|total|id|title)`; `loop.*` reads `nearestLoop(scope.frame) ?? scope.loop`, `stage.*` reads `nearestStage(scope.frame)` and throws `TemplateError` when absent.

`events.ts` / `manifest.ts` — add `'stages'` to both `kind` enums (a closed enum would make every stages manifest unparseable, and an unparseable manifest is unlistable *and* unresumable); add optional `stagesId` to the row and to `RunJournalInit.steps`, seeded from `flattenSteps`.

Desktop, compile-keeping only (real editor work is Task 12): `'stages'` in `KIND_OPTIONS`, a `case 'stages'` in `convertStep` (carrying id/enabled, seeding `items: ''` and `steps: childSteps(step)`), and a `KIND_COLOR.stages` entry.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && npm run build -w desktop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src apps/desktop/src
git commit -m "Add the stages step kind to types, schema and tree helpers"
```

---

## Task 6: `stages` events, manifest v5 and log lines

**Files**
- Modify: `packages/core/src/types.ts` (four events + `ManualRequest`), `events.ts`, `engine/manifest.ts`, `log-rows.ts`, `format.ts`
- Test: `packages/core/src/engine/manifest.test.ts`, `log-rows.test.ts`

**Interfaces — Produces**

```ts
// types.ts — WhiphandEvent gains
| { type: 'stages:start'; id: string; total: number }
| { type: 'stages:item'; id: string; index: number; total: number; stageId: string; title: string; attempt: number }
/** This stage was accepted and is finished — what a resume reads to skip it entirely. */
| { type: 'stages:accepted'; id: string; stageId: string }
| { type: 'stages:done'; id: string; completed: number }

// ManualRequest gains
stage?: { stagesId: string; id: string; title: string; index: number; total: number; attempt: number };
/** The frame identity of this execution, so a frontend can key the request to its manifest row. */
execution?: { loopId?: string; iteration?: number; stage?: string; outerLoops?: LoopRef[] };

// manifest.ts
export const MANIFEST_VERSION = 5;
// body rows gain:  stagesId?: string; stage?: string        (stage id; the frame discriminator)
// the stages row gains: total?: number; completed?: number; attempt?: number;
//   completedStages?: string[];  currentStage?: { id: string; title: string; index: number };
//   exhausted?: boolean;         // retries ran out and triage ran — what resume grants against

// format.ts
export function stageLabel(index: number, total: number, title: string): string; // 'stage 2 of 7 · Add API routes'
```

- [ ] **Step 1: Write the failing tests**

```ts
// manifest.test.ts
test('a stages run records one row per stage execution, tagged with its stage', () => {
  const j = journalFor([{ id: 'build', kind: 'stages' }, { id: 'accept', kind: 'approval', stagesId: 'build' }]);
  j.record({ type: 'stages:start', id: 'build', total: 2 });
  j.record({ type: 'stages:item', id: 'build', index: 1, total: 2, stageId: '01-a', title: 'A', attempt: 1 });
  j.record({ type: 'step:start', stepId: 'accept', kind: 'approval', loopId: 'build', iteration: 1, stage: '01-a' });
  j.record({ type: 'step:done', stepId: 'accept', exitCode: 0 });
  j.record({ type: 'stages:accepted', id: 'build', stageId: '01-a' });
  j.record({ type: 'stages:item', id: 'build', index: 2, total: 2, stageId: '02-b', title: 'B', attempt: 1 });
  j.record({ type: 'step:start', stepId: 'accept', kind: 'approval', loopId: 'build', iteration: 1, stage: '02-b' });
  j.record({ type: 'step:done', stepId: 'accept', exitCode: 0 });
  j.record({ type: 'stages:accepted', id: 'build', stageId: '02-b' });
  j.record({ type: 'stages:done', id: 'build', completed: 2 });

  const rows = manifestOf(j).steps.filter(s => s.id === 'accept');
  assert.equal(rows.length, 2, 'two stages, two rows — they must not overwrite each other');
  assert.deepEqual(rows.map(r => r.stage), ['01-a', '02-b']);
  const build = manifestOf(j).steps.find(s => s.id === 'build');
  assert.equal(build.kind, 'stages');
  assert.deepEqual(build.completedStages, ['01-a', '02-b']);
  assert.equal(build.status, 'done');
});

test('a retried stage gets its own row rather than overwriting attempt 1', () => {
  // two stages:item for the same stageId with attempt 1 then 2 => two 'accept' rows, iteration 1 and 2
});

test('a manifest with stage rows round-trips through the schema', () => {
  const parsed = runManifestSchema.parse(JSON.parse(JSON.stringify(manifestOf(j))));
  assert.equal(parsed.steps.find(s => s.id === 'accept')!.stage, '01-a',
    'stage must survive the parse — a stripped field collapses every stage onto one key');
});

test('version 5 is written, and v1..v4 manifests still parse', () => { /* one fixture per version */ });
```

```ts
// log-rows.test.ts
test('stages events summarize as stage lines', () => {
  assert.match(summarizeEvent({ type: 'stages:item', id: 'build', index: 3, total: 7,
    stageId: '03-api', title: 'Add API routes', attempt: 1 })!.text, /stage 3 of 7 · Add API routes/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test packages/core/src/engine/manifest.test.ts packages/core/src/log-rows.test.ts`
Expected: FAIL — the event types are not in the union.

- [ ] **Step 3: Implement**

`step:start` and `step:skipped` gain an optional `stage?: string` (the frame's stage id) beside `loopId`/`iteration`/`outerLoops`, in both `types.ts` and `events.ts`; `beginStep` gains a `stage` argument and matches rows on it (`s.stage === wantedStage` alongside the existing id/iteration/`sameLoopRefs` test), so the seeded virgin-row takeover cannot swallow stage 2's first row.

Journal reducers beside the loop ones (`manifest.ts:595-619`):
- `stages:start` → `beginStep(event.id, undefined, undefined, undefined, { kind: 'stages', status: 'running', startedAt: now, total: event.total, completedStages: [] })`.
- `stages:item` → `upsertStep(event.id, { currentStage: { id, title, index }, attempt })`.
- `stages:accepted` → append `stageId` to `completedStages` (idempotent).
- `stages:done` → `current.delete(event.id)` then `upsertStep(event.id, { status: 'done', completed: event.completed, endedAt: now })`.
- `MANIFEST_VERSION = 5`; add `z.literal(5)` to the version union at `manifest.ts:108`.

`events.ts` — the four schemas plus the drive-by fix: `run:resume` gains `iteration: z.number().int().positive().optional()`, so the field the CLI prints survives the RPC.

`log-rows.ts` `summarizeEvent` — one case per event, using `format.ts`'s new `stageLabel`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "Record stages in events, the manifest (v5) and the run log"
```

---

## Task 7: `executeStages` — the happy path

**Files**
- Modify: `packages/core/src/engine/runner.ts`, `engine/manual.ts`
- Create: `packages/core/src/engine/runner.stages.test.ts`

**Interfaces — Consumes:** Tasks 1, 4, 5, 6. **Produces:** `stages` execution, `ctx.artifacts.stage`, per-stage scope.

- [ ] **Step 1: Write the failing tests**

```ts
test('a stages step runs its body once per stage file, in order', async () => {
  const dir = await tmpRepoWithPlans({ '01-schema.md': '# Schema\n', '02-api.md': '# API\n' });
  const result = await runWorkflow({ workflow: stagedWorkflow(), workdir: dir, ... });
  assert.equal(result.ok, true);
  assert.deepEqual(h.events.filter(e => e.type === 'stages:item').map(e => [e.index, e.stageId]),
    [[1, '01-schema'], [2, '02-api']]);
  assert.deepEqual(h.events.filter(e => e.type === 'stages:accepted').map(e => e.stageId), ['01-schema', '02-api']);
  assert.deepEqual(h.events.filter(e => e.type === 'stages:done').map(e => e.completed), [2]);
});

test('each stage gets its stage file and nothing from the stage before it', async () => {
  const prompts = spawnedPrompts('execute');
  assert.match(prompts[0], /01-schema\.md/);
  assert.doesNotMatch(prompts[0], /review\.md/, 'nothing to read on the first stage');
  assert.match(prompts[1], /02-api\.md/);
  assert.doesNotMatch(prompts[1], /01-schema/, "stage 2 must not be handed stage 1's files");
});

test('a stage added to the directory mid-run is picked up before the run ends', async () => {
  // the gate answer for stage 1 writes 03-extra.md into the plan dir
  assert.deepEqual(items.map(e => e.stageId), ['01-schema', '02-api', '03-extra']);
});

test('editing a completed stage file does not rewind, and deleting a pending one ends cleanly', async () => {
  // stage 1's gate answer rewrites 01-schema.md and deletes 02-api.md
  assert.deepEqual(items.map(e => e.stageId), ['01-schema'], 'no re-run, no error for the file that vanished');
  assert.equal(result.ok, true);
});

test('cancelling mid-stage ends the run as cancelled, with the stage still open', async () => {
  const controller = new AbortController();      // aborted from the fake spawn of stage 2's 'execute'
  assert.equal(result.cancelled, true);
  assert.equal(manifestOf(runDir).status, 'cancelled');
  assert.equal(manifestOf(runDir).steps.find(s => s.id === 'build')!.completedStages.length, 1);
});

test('a stages step whose glob matches nothing fails the run', async () => {
  assert.equal(result.ok, false);
  assert.match(errorMessage(h), /stages step 'build' matched no stage files/);
});

test('a stage file that vanishes between discovery and use fails that stage, not silently', async () => {
  assert.match(errorMessage(h), /expected artifact was not written|stage file/);
});

test('a loop inside a stage writes its artifacts under that stage', async () => {
  assert.ok(existsSync(join(runDir, 'build', '01-schema', 'attempt-1', 'cycle', 'iter-1', 'execute-report.md')));
  assert.ok(existsSync(join(runDir, 'build', '02-api', 'attempt-1', 'cycle', 'iter-1', 'execute-report.md')));
});

test('an approval inside a stage is offered retry and carries the stage on its request', async () => {
  assert.deepEqual(h.asked[0].choices, ['continue', 'retry', 'abort']);
  assert.equal(h.asked[0].stage?.title, 'Schema');
  assert.equal(h.asked[0].stage?.index, 1);
  assert.equal(h.asked[0].execution?.stage, '01-schema');
});

test('an oddly named stage file warns but still runs', async () => {
  assert.ok(h.events.some(e => e.type === 'guard:warning' && /notes\.md/.test(e.message)));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test packages/core/src/engine/runner.stages.test.ts`
Expected: FAIL — `stages` steps are not executed.

- [ ] **Step 3: Implement `executeStages`**

In `executeStep`, dispatch containers first: `if (isStagesStep(step)) return await executeStages(step); if (isLoopStep(step)) return await executeLoop(step);`.

```ts
// Never 'verdict-fail': a stages step has no artifact, so the top-level
// on_findings: 'loop' jump would build "Read the findings at undefined".
async function executeStages(stages: StagesStep): Promise<RunResult | null> {
  const outer = ctx.frame;
  const pattern = renderTemplate(stages.items, ctx);
  const completed = new Set<string>(resumedCompletedStages(stages, outer));   // Task 9; empty on a fresh run
  const maxAttempts = 1 + (stages.max_retries ?? DEFAULT_STAGE_RETRIES);      // 2 retries
  let started = false;

  for (;;) {
    if (opts.signal?.aborted) return cancelled();
    const list = await discoverStages(workdir, pattern);
    if (!started) {
      if (list.length === 0) return fail(`stages step '${stages.id}' matched no stage files (${pattern})`, stages.id);
      for (const odd of oddStageNames(list)) {
        emit({ type: 'guard:warning', stepId: stages.id,
          message: `stage file '${odd}' is not named NN-slug, so its position in the order is not obvious` });
      }
      emit({ type: 'stages:start', id: stages.id, total: list.length });
      started = true;
    }
    const stage = nextStage(list, completed);
    if (stage === undefined) break;
    const outcome = await runStage(stages, stage, maxAttempts, outer, completed);
    if (outcome !== null) return outcome;
  }
  emit({ type: 'stages:done', id: stages.id, completed: completed.size });
  return null;
}
```

`runStage` holds the per-stage contract:
1. `await assertArtifact(stage.path)` — the file was read once for its title; make its disappearance a named failure rather than an empty prompt.
2. **Snapshot** `ctx.artifacts`, `ctx.verdicts`, the `extraFindings` map (`new Map([...extraFindings])`) and the run-level `verdict`, once, before attempt 1. Do **not** snapshot `ctx.attempts` — it is an append-only audit list.
3. **Scrub**: delete from `ctx.artifacts`/`ctx.verdicts` every step id declared anywhere inside `stages.steps`. This is what makes minimal context real on a *resumed* run too, where `planResume` seeded the newest artifact per id across all stages (`resume.ts:210-213`).
4. Per attempt: restore the snapshot, re-scrub, then set `ctx.artifacts[STAGE_REF] = stage.path` — a pseudo-artifact, never through `recordArtifact`, so it has no attempt history and no verdict. Emit `stages:item`.
5. Walk `stages.steps` with `executeStep(body, frame)` where `frame: StageFrame = { kind: 'stages', id: stages.id, stage, attempt, maxAttempts, parent: outer }`. A `RunResult` returns immediately; `'verdict-fail'` handling is Task 8 (here, carry on).
6. On a completed body: `completed.add(stage.id)`, emit `stages:accepted`, restore the snapshot, return `null`.

`manual.ts` — `manualChoices(isStageFrame(ctx.frame) || ctx.loop !== undefined)`; `buildManualRequest` fills `stage` from `nearestStage(ctx.frame)` and `execution` from `frameIdentity(ctx.frame)`; `events.ts` gains the matching optional schema fields (again: unschema'd fields are stripped over RPC).

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS, with every loop test untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "Run a workflow body once per stage, with per-stage context"
```

---

## Task 8: Rejection, exhaustion and the human handover

**Files**
- Modify: `packages/core/src/engine/runner.ts`, `engine/manual.ts`
- Test: `packages/core/src/engine/runner.stages.test.ts`

**Interfaces — Produces**

```ts
// runner.ts (internal)
function stageRetryTarget(body: Step[], gateId: string): AgentStep | undefined;  // last writes:true agent before the gate
function carriesVerdict(step: Step, frame: Frame | undefined): boolean;
//   = step.verdict || (isManualStep(step) && isStageFrame(frame))
// runTriage(source: AgentStep, prompt?: string)   — prompt overrides the default findings sentence
```

- [ ] **Step 1: Write the failing tests**

```ts
test('a rejected stage runs again from the top with the rejection attached, then is accepted', async () => {
  const h = harness([{ choice: 'retry', note: 'wrong table name' }, { choice: 'continue' }]);
  assert.equal(result.ok, true);
  assert.deepEqual(h.events.filter(e => e.type === 'stages:item').map(e => e.attempt), [1, 2]);
  assert.match(spawnedPrompts('execute')[1], /A previous review found problems/);
  assert.match(spawnedPrompts('execute')[1], /accept\.md/);
  assert.ok(existsSync(join(runDir, 'build', '01-schema', 'attempt-2', 'cycle', 'iter-1', 'execute-report.md')));
});

test('a rejection is scoped to its stage: the next stage starts clean', async () => {
  assert.doesNotMatch(spawnedPrompts('execute').at(-1)!, /A previous review found problems/);
});

test('retries run out into a triage session, and the run stops naming the stage', async () => {
  const h = harness([{ choice: 'retry' }, { choice: 'retry' }, { choice: 'retry' }]);
  assert.equal(result.ok, false);
  assert.equal(interactiveSpawns.length, 1, 'one triage session');
  assert.match(interactiveSpawns[0].argv.join(' '), /01-schema\.md/);
  assert.match(errorMessage(h), /stage 1 of 2 \('Schema'\) was rejected 3 times/);
  assert.equal(manifestOf(runDir).steps.find(s => s.id === 'build')!.exhausted, true);
});

test('an inner review cycle that never passes reaches the gate instead of killing the run', async () => {
  // cycle: max_iterations 2, review always FAILs; the gate answers continue
  assert.equal(result.ok, true);
  assert.equal(h.asked.length, 1, 'the human was asked');
  assert.match(h.asked[0].instructions, /review cycle 'cycle' never passed/);
  assert.ok(h.asked[0].context.artifacts.some(a => a.id === 'review'),
    'the findings are forced onto the rail even though the gate did not list them');
});

test('outside a stages step, an exhausted loop still fails the run exactly as before', async () => { /* unchanged loop test */ });

test('on_exhausted: interactive inside a stage still opens triage rather than reaching the gate', async () => { ... });

test('a stage that changed nothing says so at the gate rather than being skipped', async () => {
  assert.match(h.asked[0].instructions, /this stage produced no changes/i);
});

test('abort at a stage gate fails the run immediately', async () => {
  assert.match(errorMessage(h), /approval step 'accept' was declined/);
});

test('accepting is authoritative: a run whose every stage was accepted ends ok', async () => {
  // stage 1's review FAILed and was accepted anyway
  assert.equal(result.ok, true);
  assert.notEqual(manifestOf(runDir).status, 'failed');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test packages/core/src/engine/runner.stages.test.ts`
Expected: FAIL — a rejection currently just carries on.

- [ ] **Step 3: Implement**

**Implicit manual verdicts.** `finishStep` returns early on `!step.verdict` (`runner.ts:474`), so a human choosing `retry` at a gate that did not set `verdict: true` is silently read as `continue`. Replace with `carriesVerdict(step, ctx.frame)` — **stage frames only**: inside a loop, `executeLoop` ignores a non-`until` verdict anyway and `until` already requires `verdict: true`, so widening further buys nothing and risks existing workflows. An implicit verdict sets `ctx.verdicts[step.id]` and emits `step:verdict`, but must **not** write the run-level `verdict` variable. Mirror both halves in `executeStep`'s skip path (`runner.ts:849-854`), or a resumed run reads a rejected gate as a pass.

**Rejection inside a stage.** In `runStage`'s body walk, classify a `'verdict-fail'` by the step that produced it:
- `manual`/`approval` → the human said `retry`. Remember `{ gateId, path: ctx.artifacts[gateId] }`, abandon the rest of the body, start the next attempt.
- a `loop` child → an exhausted cycle (below). Push `{ loopId, untilId }` onto the frame's `exhausted` list and carry on to the next body step.
- anything else → carry on, exactly as a loop does for a non-`until` verdict step.

On attempt `n > 1`, after restore+scrub, re-seed the rejection so the note resolves: `ctx.artifacts[gateId] = rejectedPath`, `ctx.verdicts[gateId] = 'fail'`, `extraFindings.set(stageRetryTarget(stages.steps, gateId)!.id, [gateId])`. `withFindings` (`runner.ts:505`) does the rest, and the next restore clears it — that is what keeps a rejection scoped to its stage.

**An exhausted loop inside a stage reaches the gate.** In `executeLoop`, when the budget runs out: if `nearestStage(ctx.frame) !== undefined` and `loop.on_exhausted !== 'interactive'`, emit the existing `loop:done passed:false` and `return 'verdict-fail'` instead of `fail(...)`. Outside a stage — and for an author who explicitly chose `on_exhausted: interactive` — behaviour is unchanged. Schema already guarantees a gate follows the loop (Task 5), so there is no end-of-body reconciliation to write.

**Gate copy.** `executeManual` passes `executeStages`'s per-stage notes into `buildManualRequest` as an optional `notes: string[]` plus `forceInputs: string[]`, so `manual.ts` stays a pure question-builder: one line per exhausted cycle (`The review cycle 'cycle' never passed within 2 iterations — its findings are attached.`) and, when `diffSnapshots(stageEntrySnapshot, await snapshotTree(workdir) ?? '')` is empty, `This stage produced no changes.` (`diffSnapshots` already drops `.whiphand/` lines, so no extra filtering.) Each exhausted loop's `until` id is forced onto the artifact rail even when the gate did not list it.

**Handover.** When attempts run out: `runTriage(stageRetryTarget(...), prompt)` — the prompt names the stage file, the last review findings and the rejection note, and says a previous attempt's work is in the tree — then mark the stages row exhausted and `fail(\`stages step '<id>': stage <index> of <total> ('<title>') was rejected <n> times\`, stages.id)`. Generalize `runTriage(source, prompt?)` (`runner.ts:956`) by making its hardcoded sentence a default parameter.

**Acceptance is authoritative.** On an accepted stage, restore the run-level `verdict` to the value snapshotted at stage entry, rather than setting `undefined` — a failure from before the stages step must not be erased.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "Retry, exhaust and hand over a rejected stage to a human"
```

---

## Task 9: Resume through stages

A resume must **not** replay a finished stage: its inner loop row is `failed` forever when the human accepted an exhausted cycle, and `computeLoopBudgets` would grant it a fresh iteration and really spawn the implementer over already-committed work. Completed stages are skipped wholesale instead, from the manifest's own record.

**Files**
- Modify: `packages/core/src/engine/resume.ts`, `engine/runner.ts`
- Test: `packages/core/src/engine/resume.test.ts`, `engine/runner.stages.test.ts`

**Interfaces — Produces**

```ts
// resume.ts — ResumePlan gains
/** stages execution key -> stage ids this run already accepted. */
stagesCompleted: Record<string, string[]>;
/** '<stagesKey>@<stageId>' -> attempts this resume allows, granted only after triage. */
stageBudgets: Record<string, number>;
export function stageBudgetKey(stagesKey: string, stageId: string): string;
```

- [ ] **Step 1: Write the failing tests**

```ts
// resume.test.ts
test('a resumed staged run skips the stages it already accepted', async () => {
  const workdir = await fixture([
    { id: 'build', kind: 'stages', status: 'failed', total: 3, completedStages: ['01-a', '02-b'],
      currentStage: { id: '03-c', title: 'C', index: 3 }, attempt: 1 },
    doneStageRow('execute', '01-a'), doneStageRow('accept', '01-a'),
    doneStageRow('execute', '02-b'), doneStageRow('accept', '02-b'),
    { id: 'execute', kind: 'agent', status: 'interrupted', loopId: 'build', iteration: 1, stage: '03-c' },
  ], { version: 5 }, { snapshotText: STAGED_WORKFLOW });
  const plan = await planResume(workdir, DEFAULT_CONFIG, RUN_ID);
  assert.deepEqual(plan.stagesCompleted['build'], ['01-a', '02-b']);
  assert.equal(plan.restartAt?.stepId, 'execute');
  assert.ok(plan.done.has('accept@01-a#1'));
});

test('a run stopped in triage grants the rejected stage one more attempt; an interrupted one does not', async () => {
  const exhausted = await planResume(await fixture(ROWS_WITH_EXHAUSTED_TRUE, { version: 5 }, SNAP), ...);
  assert.equal(exhausted.stageBudgets['build@03-c'], 4);      // 3 used, one more granted
  assert.match(exhausted.warnings.join('\n'), /stage '03-c' was rejected 3 times; this resume allows one more attempt/);
  const interrupted = await planResume(await fixture(ROWS_WITHOUT_EXHAUSTED, { version: 5 }, SNAP), ...);
  assert.deepEqual(interrupted.stageBudgets, {});
});

test("a completed stage's exhausted inner loop gets no iteration grant", async () => {
  assert.equal(plan.loopBudgets['build@01-a#1/cycle#1'], undefined);
});

test('an orphaned done row in an earlier stage is still healed to the right path', async () => {
  // healing must not collapse rows by bare id across stages
  assert.match(plan.warnings.join('\n'), /adopting the 'execute-report\.md'/);
});
```

```ts
// runner.stages.test.ts
test('resuming a staged run re-runs only the unfinished stage', async () => {
  assert.equal(spawnCount, 1, 'the accepted stages are not walked again');
  assert.deepEqual(h.events.filter(e => e.type === 'stages:item').map(e => e.stageId), ['03-c']);
});

test('a resumed stages step re-globs, so a stage added while the run was stopped runs too', async () => {
  // 03-extra.md is written into the plan dir between the two runWorkflow calls
  assert.deepEqual(h2.events.filter(e => e.type === 'stages:item').map(e => e.stageId), ['03-c', '03-extra']);
});

test('an interrupted stage tells its implementer that a previous attempt left work behind', async () => {
  assert.match(spawnedPrompts('execute').at(-1)!, /a previous attempt was interrupted/i);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test packages/core/src/engine/resume.test.ts`
Expected: FAIL — `stagesCompleted` does not exist.

- [ ] **Step 3: Implement**

- `rowKey` becomes `executionKey(id, row.iteration, row.outerLoops, row.stage)`.
- `loopContext(row)` becomes `[...(row.outerLoops ?? []), ...(row.loopId === undefined ? [] : [{ id: row.loopId, iteration: row.iteration ?? 1, ...(row.stage === undefined ? {} : { stage: row.stage }) }])]` — today it returns `[]` whenever `loopId` is absent, which would strand a loop nested in a stage.
- `frameOfRow` rebuilds stage frames: a `loopId` row carrying `stage` becomes a `StageFrame` (`attempt = iteration`), and an `outerLoops` entry with `stage` likewise, so `healOrphanedDone`'s `artifactPath` lands in the right stage directory. Every segment is derivable from the ref alone (Task 1's `attempt-N` decision) — nothing needs the stage's title or index.
- `healOrphanedDone`'s newest-by-id map keys on `${step.id}@${step.stage ?? ''}`, so an orphan in an earlier stage is healed rather than skipped.
- `stagesCompleted[rowKey(stagesRow)] = stagesRow.completedStages ?? []`, consumed by `executeStages`'s `resumedCompletedStages`.
- `computeLoopBudgets` skips any loop row whose stage (its own `stage`, or the innermost `outerLoops` stage) is in that stages step's `completedStages`.
- `computeStageBudgets`: only for a `kind: 'stages'` row with `exhausted === true`; `attemptsUsed` is the **max attempt among that stage's own rows** (not the scalar `attempt`, which a crash can leave stale); grant `attemptsUsed + 1`, with the warning. `runStage` reads the grant in place of `maxAttempts`, and the implementer's prompt for that attempt says a human has just been through the tree in a triage session.
- `restartAt` display: unchanged fall-through to the first unfinished body row; add the stage to `warnings` so the `run:resume` line is useful.
- An interrupted stage re-runs from scratch against a tree that already holds its own partial edits — the engine never discards work it was not asked to discard, and per-stage commits keep the blast radius to one stage. `runStage` therefore appends one sentence to the implementer's prompt (through the same `extraFindings`-style injection) when this stage has a `resumedStepIds`/interrupted row: *a previous attempt was interrupted; reconcile whatever it left in the tree.*

Known pre-existing wart to leave alone but not build on: `ctx.attempts` is seeded from the resume *and* re-pushed during replay, so its counts inflate. Nothing in this feature may derive a stage attempt from `ctx.attempts` — the frame is the only source.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "Resume a staged run at the stage it stopped in"
```

---

## Task 10: CLI — stage lines, gate header, and the `--yes` refusal

**Files**
- Modify: `packages/cli/src/render.ts`, `prompt.ts`, `program.ts`, `packages/core/src/schema.ts`, `packages/core/src/index.ts`
- Test: `packages/cli/src/render.test.ts`, `prompt.test.ts`, `packages/core/src/schema.test.ts`

**Interfaces — Produces**

```ts
// core schema.ts
/** Gates inside a stages step that --yes would answer without the author having said so. */
export function unattendedProblems(workflow: Workflow): string[];
```

- [ ] **Step 1: Write the failing tests**

```ts
// render.test.ts
test('stages events render as stage lines', () => {
  expectLines([
    { type: 'stages:start', id: 'build', total: 7 },
    { type: 'stages:item', id: 'build', index: 3, total: 7, stageId: '03-api', title: 'Add API routes', attempt: 1 },
    { type: 'stages:item', id: 'build', index: 3, total: 7, stageId: '03-api', title: 'Add API routes', attempt: 2 },
    { type: 'stages:done', id: 'build', completed: 7 },
  ], [
    '▤ stages build (7 stages)',
    '▤ build — stage 3/7: Add API routes',
    '▤ build — stage 3/7: Add API routes (attempt 2)',
    '▤ build finished 7 stages',
  ]);
});

// prompt.test.ts
test('a gate inside a stage names the stage above the question', async () => {
  assert.match(written, /stage 3\/7 'Add API routes' of 'build'/);
});

// schema.test.ts
test('--yes refuses a staged workflow whose gate has no explicit default', () => {
  assert.deepEqual(unattendedProblems(STAGED_WORKFLOW), [
    "step 'accept': a gate inside stages step 'build' must set an explicit 'default' to run under --yes",
  ]);
  assert.deepEqual(unattendedProblems(STAGED_WORKFLOW_WITH_DEFAULT), []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test packages/cli/src/render.test.ts packages/cli/src/prompt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`render.ts` — three cases beside the loop ones (`render.ts:127-138`), reusing `stageLabel`; `step:start`/`step:skipped` indentation keys off "inside any container" (`loopId` or `stagesId`).

`prompt.ts:65-67` — print the stage line when `request.stage` is set, the loop line otherwise.

`program.ts` — with `--yes`, call `unattendedProblems(workflow)` once the workflow is resolved and refuse, listing every offending gate. `defaultChoice` is `continue`, so without this `whiphand run --yes` would implement all seven stages unattended at full token cost — the exact thing this feature exists to prevent. CI opts in per gate by writing `default: continue`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/cli/src
git commit -m "Show stages in the CLI and refuse silent --yes gates"
```

---

## Task 11: Desktop run views — stepper, gate, notifications, progress, triage

**Files**
- Modify: `apps/desktop/src/state/store.ts`, `lib/run-tree.ts`, `components/RunStepper.tsx`, `components/StepSummary.tsx`, `review/from-manual.ts`, `components/NotificationBridge.tsx`, `components/OngoingRuns.tsx`, `pages/run-columns.tsx`, `pages/RunDetailPage.tsx`
- Test: `lib/run-tree.test.ts`, `components/RunStepper.test.tsx`, `review/from-manual.test.ts`, `pages/RunDetailPage.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// run-tree.test.ts
test('rows from two stages of one stages step become two stage groups, not one folded step', () => {
  const stages = buildRunTree(rows)[0];
  assert.equal(stages.kind, 'stages');
  assert.deepEqual(stages.children.map(c => c.stage), ['01-a', '02-b']);
  assert.equal(stages.children[0].children.length, 2);
});

test('a loop inside a stage keeps its rows under that stage', () => {
  const cycle = buildRunTree(rows)[0].children[1].children.find(n => n.kind === 'loop');
  assert.equal(cycle.children[0].executions.length, 2, 'two iterations fold, as they do outside a stage');
});

// RunStepper.test.tsx
test('a stages group is labelled by stage, not by iteration', () => {
  render(<RunStepper steps={stagedRows} />);
  expect(screen.getByText('stage 2 of 7 · Add API routes')).toBeInTheDocument();
  expect(screen.queryByText(/iteration 2 of 7/)).toBeNull();
});

// from-manual.test.ts
test('a gate inside a stage keys on its stage, so two stages do not share one review', () => {
  expect(fromManualRequest(reqFor('01-a')).key).not.toEqual(fromManualRequest(reqFor('02-b')).key);
  expect(fromManualRequest(reqFor('02-b')).key).toBe('accept@02-b#1');
});

// RunDetailPage.test.tsx
test('a run stopped in triage says which stage it stopped at', async () => {
  expect(await screen.findByText(/stopped at stage 3 of 7 · Add API routes after 3 rejections/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `NODE_OPTIONS=--no-experimental-webstorage npm run test -w desktop`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `store.ts`: `stages:*` reducers mirroring the loop ones (`store.ts:545-570`); `step:start`/`step:skipped` carry `stage` into `StepState`; `upsertStep`'s key uses `executionKey(id, iteration, outerLoops, stage)`; `stages:item` also records `job.stageProgress` for the grids.
- `run-tree.ts`: `loopIds` collects container rows of **both** kinds; `belongsTo` compares `stage` alongside `loopId`/`outerLoops` (`sameLoopRefs` already discriminates by `stage`). A `StagesNode { kind: 'stages'; stages: row; children: StageGroup[] }` buckets its rows by `stage`, then by attempt where more than one exists, and builds each bucket with the existing recursion so loops inside a stage still fold by iteration.
- `RunStepper.tsx`: `metaLine` gains `case 'stages'`; a `StagesView` modelled on `LoopView` renders each stage group with `stageLabel(...)` and an `attempt 2 of 3` badge where attempts exist; collapsed mode counts stages rather than raw steps; `isDisabledNode` handles the new node kind.
- `from-manual.ts`: key from `request.execution` when present (`executionKey(stepId, execution.iteration, execution.outerLoops, execution.stage)`), falling back to today's `loop` path; add the stage title as the review's subtitle.
- `NotificationBridge.tsx`: a `manualRequest` carrying `stage` gets body `Stage 3 of 7: Add API routes`; the title stays `manualLabel(kind)` so OS grouping is unchanged.
- `OngoingRuns.tsx` / `run-columns.tsx`: with stage progress (live from `job.stageProgress`, historic from the manifest's stages row), the status cell reads `running · stage 3/7`.
- `RunDetailPage.tsx`: `findCurrentStepIndex` skips container rows of both kinds; the run-error MessageBar gains the stage sentence when the stages row names a current stage and the run failed.

- [ ] **Step 4: Verify**

Run: `NODE_OPTIONS=--no-experimental-webstorage npm run test -w desktop && npm run build -w desktop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "Show stage progression in the desktop run views"
```

---

## Task 12: Desktop workflow editor — authoring a `stages` step

**Files**
- Modify: `apps/desktop/src/workflow-editor/StepCard.tsx`, `StepRail.tsx`, `WorkflowEditor.tsx`, `use-workflow-draft.ts`, `lib/step-tree.ts`, `lib/editor-model.ts`, `lib/draft-normalize.ts`, `lib/step-describe.ts`, `components/workflow-lane/*`
- Test: `workflow-editor/WorkflowEditor.test.tsx`, `lib/editor-model.test.ts`, `lib/step-describe.test.ts`

- [ ] **Step 1: Write the failing tests**

```tsx
test('a stages step edits its glob and retries, and holds a body', async () => {
  render(<WorkflowEditor workflow={stagedDraft} ... />);
  await user.clear(screen.getByLabelText('Stage files'));
  await user.type(screen.getByLabelText('Stage files'), '{{ inputs.plan_dir }}/*.md');
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
    steps: expect.arrayContaining([expect.objectContaining({ kind: 'stages', items: '{{ inputs.plan_dir }}/*.md' })]),
  }));
});

test('converting a loop to stages keeps its body', () => {
  expect(convertStep({ kind: 'loop', id: 'x', until: 'a', steps: [stepA] }, 'stages'))
    .toMatchObject({ kind: 'stages', id: 'x', steps: [stepA] });
});

test('a step inside a stages body can be added, moved and described', () => { /* step-tree + step-describe */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `NODE_OPTIONS=--no-experimental-webstorage npm run test -w desktop`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add a `StagesFields` card beside `LoopFields` (`StepCard.tsx:221-273`) with **Stage files** (`items`) and **Max retries** (`max_retries`), no `until`. Replace every `isLoopStep` container test in the editor helpers (`step-tree.ts`, `editor-model.ts`, `draft-normalize.ts`, `step-describe.ts`, `use-workflow-draft.ts`, `WorkflowEditor.tsx`, `workflow-lane/*`) with core's `isContainerStep`/`childSteps`, so body insertion, folding, numbering, dragging and lane rendering all work for `stages`. `step-describe.ts` describes a stages step as `once per stage file`.

- [ ] **Step 4: Verify**

Run: `NODE_OPTIONS=--no-experimental-webstorage npm run test -w desktop && npm run build -w desktop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "Author stages steps in the workflow editor"
```

---

## Task 13: Parity — CLI and desktop agree on stage progression

**Files**
- Create: `parity/fixtures/workspace/.whiphand/workflows/staged.yaml`, `parity/fixtures/workspace/plans/01-a.md`, `02-b.md`
- Modify: `parity/behavior.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('stages parity: CLI and agent walk the same stages and write the same manifest', async () => {
  const cliDir = await copyFixtureWorkspace();
  const agentDir = await copyFixtureWorkspace();
  const cliRunId = await runCliStaged(cliDir, ['--yes']);        // the fixture's gate declares default: continue
  const agentRunId = await runAgentStaged(agentDir, { yes: true });
  const cliManifest = await readManifest(cliDir, cliRunId);
  assert.deepEqual(cliManifest, await readManifest(agentDir, agentRunId));
  const build = cliManifest.steps.find(s => s.id === 'build');
  assert.deepEqual(build.completedStages, ['01-a', '02-b']);
  assert.deepEqual(cliManifest.steps.filter(s => s.id === 'accept').map(s => s.stage), ['01-a', '02-b']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:parity`
Expected: FAIL.

- [ ] **Step 3: Implement**

`staged.yaml` uses the stub runner binaries in `parity/fixtures/bin` (as `parity.yaml` does): a `kind: stages` over `plans/*.md`, one headless `execute`, one `verdict` command, and a gate with `default: continue`. Normalize timestamps and ids the way the existing manifest comparisons do.

- [ ] **Step 4: Verify**

Run: `npm run test:parity`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add parity
git commit -m "Prove CLI and desktop agree on stage progression"
```

---

## Task 14: The shipped `staged-feature-development` workflow and docs

**Files**
- Modify: `packages/core/src/scaffold.ts`, `scaffold.test.ts`, `README.md`, `docs/design.md`
- Create: `.whiphand/workflows/staged-feature-development.yaml` (dogfood copy, force-added past `.gitignore`)

- [ ] **Step 1: Write the failing test**

```ts
test('stagedFeatureDevelopmentTemplate parses, stages the plan dir, and gates every stage', () => {
  const wf = parseWorkflow(stagedFeatureDevelopmentTemplate());
  assert.deepEqual(validateWorkflowSemantics(wf), []);
  assert.deepEqual(validateWorkflowWarnings(wf), []);
  const build = wf.steps.find(s => s.id === 'build');
  assert.equal(build.kind, 'stages');
  assert.equal(build.items, '{{ inputs.plan_dir }}/*.md');
  const gate = findStep(wf.steps, 'accept');
  assert.equal(gate.kind, 'approval');
  assert.equal(gate.show_diff, true);
  assert.equal(gate.capture, 'review');
  assert.ok(findStep(wf.steps, 'commit'), 'each stage commits');
});

test('initWorkspace ships four workflows', async () => { /* config + feature, feature-development, spec-driven, staged-feature-development */ });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test packages/core/src/scaffold.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`staged-feature-development` is `feature-development` with the plan cut into stage files and the human-review loop replaced by a `stages` step:

```yaml
name: staged-feature-development
description: Cut a large feature into stages, then build, review, accept and commit one stage at a time.
inputs:
  feature:   { required: true,  prompt: What are we building? }
  plan_dir:  { required: true,  remember: true, multiline: false, prompt: "Plan directory (e.g. docs/plans/oauth)" }
  base:      { required: false, default: main, multiline: false, prompt: Branch to start from }
  test_command: { required: false, default: npm test, remember: true, multiline: false,
                  prompt: Test command (leave blank to skip tests) }
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
      {{ inputs.plan_dir }}/, named NN-slug.md, each opening with a `# Title` heading.
      Write nothing outside that directory.

  - id: commit-plan
    kind: command
    run: git add -A -- "$WHIPHAND_PLAN_DIR" && git commit -m "plan: $WHIPHAND_RUN_NAME"
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
                # 'tests' is later in THIS loop, so it means the previous iteration's log;
                # 'review' and 'accept' are later siblings of the outer loop and of the
                # stages body, so they mean the previous round's findings and the human's
                # rejection — each is simply dropped when there is nothing yet to read.
                inputs: [stage, tests, review, accept]
                kind: agent
                runner: claude
                model: sonnet
                mode: headless
                writes: true
                output: execute-report.md
                prompt: |
                  Implement stage {{ stage.index }} of {{ stage.total }}: {{ stage.title }}.
                  Earlier stages are implemented and committed — read the tree or `git log`
                  if you need them. Implement only this stage. If a tests log marked
                  VERDICT: FAIL is attached, fix every failure first; if review findings or
                  stage feedback are attached, address every point.
              - id: tests
                kind: command
                run: "{{ inputs.test_command }}"
                verdict: true
                output: tests.log
                timeout_ms: 1800000
          - id: review
            inputs: [stage, execute, tests, accept]
            verdict: true
            kind: agent
            runner: claude
            model: opus
            mode: headless
            writes: false
            output: review.md
            prompt: |
              Review the working-tree diff against this stage only. If stage feedback is
              attached, FAIL unless every requested change is addressed.
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
          `git diff --cached`, and read the attached stage file, review and feedback for
          why it was made. A subject line in the imperative mood, at most 72 characters,
          no trailing period; then a blank line, then one to three short lines. Write the
          message and nothing else.
      - id: commit
        inputs: [commit-message]
        kind: command
        run: git commit -F "$WHIPHAND_ARTIFACT_COMMIT_MESSAGE"
        output: commit.log

  - id: push
    kind: command
    run: git push -u origin "feature/{{ run.slug }}"
    output: push.log
```

Notes for the implementer: `commit` deliberately has **no** `expect_exit: [0, 1]` — a failing commit must fail the run loudly, because every later stage's clean-context guarantee assumes this one is in the history. `accept` is a forward reference from `execute`/`review`, dropped on the first attempt and carrying the human's feedback on a retry.

Register it in `initWorkspace`'s `shipped` list, copy the same YAML to `.whiphand/workflows/staged-feature-development.yaml` (`git add -f`), and document `stages`, `stage.*`, `$WHIPHAND_ARTIFACT_*`/`$WHIPHAND_STAGE_*`, `allow_paths` and the stage-id/renumbering rule in `README.md` and `docs/design.md`, beside the loop reference.

- [ ] **Step 4: Verify**

Run: `npm run verify`
Expected: PASS (parity's init byte-comparison covers the new template automatically).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src README.md docs/design.md
git add -f .whiphand/workflows/staged-feature-development.yaml
git commit -m "Ship the staged-feature-development workflow"
```

---

## Task 15: One real end-to-end run

The only check that can fail for reasons none of the others can see.

- [ ] **Step 1:** On a scratch branch of this repo, run `whiphand run staged-feature-development` on a genuine multi-stage change (three stages is enough).
- [ ] **Step 2:** Confirm, in order: the planner writes only inside the plan directory (an `allow_paths` violation would have failed it); the plan commit lands; each gate shows that stage's title, diff and stage file; accepting commits exactly that stage; the next implementer's prompt contains the next stage file and no earlier-stage artifacts.
- [ ] **Step 3:** Reject one stage once and confirm the retry prompt carries the feedback; interrupt mid-stage and `whiphand run --resume <id>`, confirming it restarts in that stage and does not re-walk the committed ones.
- [ ] **Step 4:** Open the same run in the desktop: stepper, gate, notification body and runs-grid progress all read in stages.
- [ ] **Step 5:** Record what the real run taught us in `docs/superpowers/specs/2026-09-08-staged-plans-design.md`, and commit.

---

## Verification

- `npm run verify` green — root typecheck, core/CLI tests, parity, desktop tests and build, `cargo check`.
- New suites: `engine/stages.test.ts`, `engine/runner.stages.test.ts`, plus added cases in `artifacts.test.ts`, `execution-key.test.ts`, `command.test.ts`, `git-guard.test.ts`, `schema.test.ts`, `template.test.ts`, `manifest.test.ts`, `resume.test.ts`, CLI `render`/`prompt`, desktop `run-tree`/`RunStepper`/`from-manual`/`RunDetailPage`, and `parity/behavior.test.ts`.
- Regression guard: every existing loop test passes **unchanged** — the loop path may only behave differently *inside* a stage frame.
- The end-to-end run in Task 15.

## Out of scope

Parallel stages (needs a worktree per stage and a merge), dependency graphs between stages, `prev.*` cross-stage artifact references, engine-owned commits, a workspace config key for `max_retries`, and the pre-existing `ctx.attempts` double-counting on resume.
