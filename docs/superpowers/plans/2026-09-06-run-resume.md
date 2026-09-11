# Run Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a failed, interrupted or cancelled run restart from its first unfinished step, in place, so a briefly unavailable model costs a pause rather than the whole run.

**Architecture:** `runWorkflow` gains an optional `ResumePlan`. When present it reuses the existing run directory and journal instead of minting new ones, and **replays the workflow walk from the top, skipping any execution the manifest already records as `done`**. No address arithmetic: mid-iteration restart inside nested loops falls out of the skip mechanism. A new `engine/resume.ts` does all the reading and refusing; the runner receives a plan it can trust.

**Tech Stack:** TypeScript (ESM, `.ts` imports, Node 24 native TS execution), zod 4 for schemas, `yaml` for the workflow snapshot, `node --test` for core/cli/agent, vitest + Testing Library for desktop.

**Spec:** `docs/superpowers/specs/2026-09-06-run-resume-design.md`

## Global Constraints

- **No manifest version bump.** Every new manifest field is `.optional()`, exactly as `progress` and `heartbeatAt` were. Manifests written before this feature must still parse.
- **Imports carry the `.ts` extension** (`./resume.ts`), matching every existing import in this repo.
- **`RunJournal.record` stays synchronous.** It fire-and-forget schedules onto an internal promise chain because core calls `frontend.onEvent` synchronously. Never `await` inside it.
- **`McEvent` and its zod mirror change together.** `packages/core/src/events.ts` declares `mcEventSchema: z.ZodType<McEvent>`, so adding a union member to `types.ts` without adding it to `events.ts` fails typecheck.
- **Resumable statuses are exactly** `failed`, `interrupted`, `cancelled`.
- **The `.locked` marker means "exempt from retention pruning", never "in use".** It must not block a resume.
- **Full gate before declaring any task done:** `npm run verify` (typecheck, core/agent tests, parity, desktop tests, desktop build, `cargo check`).

---

## File Structure

**Created:**
- `packages/core/src/engine/resume.ts` — `ResumePlan`, `ResumeError`, `planResume`. All reading and refusing; no spawning.
- `packages/core/src/engine/resume.test.ts` — fixture-run-directory tests for the above.

**Modified:**
- `packages/core/src/engine/artifacts.ts` — nothing; listed only to note `artifactPath` is already correct for resume.
- `packages/core/src/engine/manifest.ts` — `executionKey`, `resumedAt`/`stoppedTree` schema fields, `noteStoppedTree`, `RunJournal.reopen`, `workflow.yaml` excluded from artifacts.
- `packages/core/src/engine/runner.ts` — write the workflow snapshot, take the stopped-tree snapshot, accept `resume`, skip done executions, emit the two new events.
- `packages/core/src/types.ts` — `RunCtx.resumedStepIds`, two new `McEvent` members.
- `packages/core/src/events.ts` — zod mirrors for those two members.
- `packages/core/src/adapters/claude.ts` — `--resume` instead of `--session-id` for a resumed step.
- `packages/core/src/index.ts` — export `planResume`, `ResumeError`, `executionKey`, and the `ResumePlan` type.
- `packages/cli/src/program.ts` — optional workflow argument, `--resume`, `--fresh-session`.
- `packages/cli/src/commands/run.ts` — the resume branch.
- `packages/cli/src/render.ts` — two new renderer cases.
- `packages/agent/src/protocol.ts` — `resumeRun` params/result, methods map, exported types.
- `packages/agent/src/handlers.ts` — `resumeRun` handler and `resumeJobInBackground`.
- `packages/agent/src/frontend.ts` — populate `runIdBox` from `run:resume` too.
- `apps/desktop/src/state/store.ts` — reduce the two new events.
- `apps/desktop/src/pages/RunDetailPage.tsx` — the Resume button.

---

### Task 1: Snapshot the workflow into the run directory

A resumed run must execute the workflow that actually ran, not whatever the file says now. `runWorkflow` receives a *parsed* `Workflow`, not source text, so serialize the parsed (and defaulted) object back to YAML.

**Files:**
- Modify: `packages/core/src/engine/runner.ts` (after `createRunDirFor`, around line 111)
- Modify: `packages/core/src/engine/manifest.ts` (`isBookkeepingFile`)
- Test: `packages/core/src/engine/runner.test.ts`, `packages/core/src/engine/manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WORKFLOW_SNAPSHOT_NAME = 'workflow.yaml'` exported from `packages/core/src/engine/manifest.ts`; a `<runDir>/workflow.yaml` file written by every non-dry run.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/engine/manifest.test.ts`:

```ts
test('the workflow snapshot is bookkeeping, not a step artifact', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-snap'));
  await journal.flush();
  await writeFile(join(runDir, 'workflow.yaml'), 'name: r\nsteps: []\n', 'utf8');
  await writeFile(join(runDir, 'plan.md'), 'hello', 'utf8');

  const detail = await getRun(runDir, { ...DEFAULT_CONFIG, artifacts_dir: '..' }, basename(runDir));
  const names = (detail?.artifacts ?? []).map(a => a.name);
  assert.ok(names.includes('plan.md'));
  assert.equal(names.includes('workflow.yaml'), false);
});
```

Append to `packages/core/src/engine/runner.test.ts`. If the file does not already define these three helpers, add them — every later runner test in this plan uses them:

```ts
async function tmpWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mc-runner-'));
}

/** A frontend that swallows events; for tests that assert on the filesystem. */
function silentFrontend(): Frontend {
  return { runInteractive: async () => 0, onEvent: () => {} };
}

/** A frontend that records every event, for tests that assert on the stream. */
function collecting(sink: McEvent[]): Frontend {
  return { runInteractive: async () => 0, onEvent: e => { sink.push(e); } };
}
```

Then the test itself:

```ts
test('a run writes the workflow it executed into its run directory', async () => {
  const workdir = await tmpWorkdir();
  const workflow = parseWorkflow(
    'name: snap\nsteps:\n  - id: hello\n    kind: command\n    run: echo hi\n    output: hello.log\n');

  const result = await runWorkflow({
    workflow, workdir, inputs: {}, config: DEFAULT_CONFIG,
    registry: defaultRegistry(), frontend: silentFrontend(),
    spawnHeadless: async () => 0,
  });

  const snapshot = await readFile(join(result.runDir, 'workflow.yaml'), 'utf8');
  // Re-parseable, and the same workflow — this is what a resume will execute.
  assert.equal(parseWorkflow(snapshot).name, 'snap');
  assert.equal(parseWorkflow(snapshot).steps[0].id, 'hello');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test packages/core/src/engine/manifest.test.ts packages/core/src/engine/runner.test.ts
```

Expected: FAIL — `workflow.yaml` appears in the artifact list, and `ENOENT` opening the snapshot.

- [ ] **Step 3: Exclude the snapshot from artifacts**

In `packages/core/src/engine/manifest.ts`, add the constant next to `LOCK_MARKER_NAME`'s import block and extend `isBookkeepingFile`:

```ts
/** The run's own copy of the workflow it executed — read by resume, never a step output. */
export const WORKFLOW_SNAPSHOT_NAME = 'workflow.yaml';
```

```ts
function isBookkeepingFile(name: string): boolean {
  return name === 'run.json' || name === 'events.ndjson' || name.endsWith('.tmp')
    || name === LOCK_MARKER_NAME || name === WORKFLOW_SNAPSHOT_NAME
    || isEndMarkerName(name) || isAwaitStateName(name);
}
```

- [ ] **Step 4: Write the snapshot**

In `packages/core/src/engine/runner.ts`, add to the imports:

```ts
import { stringify as stringifyYaml } from 'yaml';
import { RunJournal, WORKFLOW_SNAPSHOT_NAME } from './manifest.ts';
```

(The existing `import { RunJournal } from './manifest.ts';` becomes the line above.)

Immediately after the run directory is created:

```ts
  const { runId, runDir } = await createRunDirFor(workdir, config);
  // The workflow the run actually executed, defaults and all. A resume reads
  // this rather than the workspace file, which may have changed since.
  await writeFile(join(runDir, WORKFLOW_SNAPSHOT_NAME), stringifyYaml(workflow), 'utf8');
```

`writeFile` is already imported at the top of `runner.ts`; add `join` to the existing `node:path` import:

```ts
import { join, resolve } from 'node:path';
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --test packages/core/src/engine/manifest.test.ts packages/core/src/engine/runner.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the full gate**

```bash
npm run verify
```

Expected: `verify: all checks passed`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/engine/runner.ts packages/core/src/engine/manifest.ts \
        packages/core/src/engine/runner.test.ts packages/core/src/engine/manifest.test.ts
git commit -m "feat(core): record the workflow each run executed"
```

---

### Task 2: Record the working tree as the run stops

Resume warns when the tree changed since the run stopped. The comparison must be *tree-when-stopped vs tree-now* — comparing against the tree at run **start** would flag every `writes: true` step's own legitimate output.

`snapshotTree` is async and `RunJournal.record` is synchronous, so the snapshot is taken in `runWorkflow`'s own `finally` (already async, already the last thing to touch the journal).

**Files:**
- Modify: `packages/core/src/engine/manifest.ts` (schema + `noteStoppedTree`)
- Modify: `packages/core/src/engine/runner.ts` (the `finally` block, around line 147)
- Test: `packages/core/src/engine/manifest.test.ts`

**Interfaces:**
- Consumes: `WORKFLOW_SNAPSHOT_NAME` from Task 1 (not directly used here).
- Produces: `RunManifest.resumedAt?: string[]`, `RunManifest.stoppedTree?: string`, and `RunJournal.noteStoppedTree(digest: string): void`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/engine/manifest.test.ts`:

```ts
test('noteStoppedTree records the tree digest and persists it', async () => {
  const runDir = await tmpRunDir();
  const journal = new RunJournal(baseInit(runDir, 'run-tree'));
  journal.record({ type: 'run:done', runId: 'run-tree', ok: false });
  journal.noteStoppedTree('deadbeef');
  await journal.flush();

  const onDisk = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunManifest;
  assert.equal(onDisk.stoppedTree, 'deadbeef');
});

test('manifests written before stoppedTree and resumedAt existed still parse', async () => {
  const runDir = await tmpRunDir();
  const legacy: RunManifest = {
    version: 2, runId: 'old2', workflow: 'r', workdir: '/work', dryRun: false,
    pid: process.pid, startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z',
    endedAt: '2026-01-01T00:00:02Z', status: 'failed', ok: false, inputs: {}, sessionIds: {},
    steps: [{ id: 'a', kind: 'agent', status: 'failed' }],
  };
  await mkdir(join(runDir, 'old2'), { recursive: true });
  await writeFile(join(runDir, 'old2', 'run.json'), JSON.stringify(legacy), 'utf8');

  const runs = await listRuns(runDir, { ...DEFAULT_CONFIG, artifacts_dir: '.' });
  assert.equal(runs.find(r => r.runId === 'old2')?.status, 'failed');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test packages/core/src/engine/manifest.test.ts
```

Expected: FAIL — `journal.noteStoppedTree is not a function`.

- [ ] **Step 3: Add the schema fields**

In `packages/core/src/engine/manifest.ts`, inside `runManifestSchema` after `endedAt`:

```ts
  /**
   * One ISO stamp per resume. Optional like `progress`, so manifests written
   * before resume existed still parse — no version bump.
   */
  resumedAt: z.array(z.string()).optional(),
  /**
   * `snapshotTree` digest of the working tree as this run stopped. Resume
   * diffs it against the tree at resume time to report drift. Absent when the
   * owning process was killed before it could record one.
   */
  stoppedTree: z.string().optional(),
```

- [ ] **Step 4: Add `noteStoppedTree`**

In `RunJournal`, next to `flush()`:

```ts
  /**
   * Records the working tree as the run stopped. Separate from `record()`
   * because taking the snapshot is async and `record()` deliberately is not —
   * the caller (`runWorkflow`'s finally) does the awaiting and hands over the
   * finished digest.
   */
  noteStoppedTree(digest: string): void {
    this.manifest.stoppedTree = digest;
    const snapshot = JSON.stringify(this.manifest, null, 2);
    this.chain = this.chain.then(async () => {
      const tmpPath = join(this.runDir, 'run.json.tmp');
      await writeFile(tmpPath, snapshot, 'utf8');
      await rename(tmpPath, join(this.runDir, 'run.json'));
    });
  }
```

- [ ] **Step 5: Take the snapshot in the runner**

In `packages/core/src/engine/runner.ts`, `snapshotTree` is already imported from `./git-guard.ts`. Replace the `finally` block (around line 147):

```ts
  } finally {
    journal.close();
    // Not in RunJournal.record: that is synchronous by design, and this is not.
    // A dry run touched nothing, so it has no tree state worth recording.
    if (!opts.dryRun) {
      const digest = await snapshotTree(workdir);
      if (digest !== null) journal.noteStoppedTree(digest);
    }
    await journal.flush();
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
node --test packages/core/src/engine/manifest.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the full gate and commit**

```bash
npm run verify
git add packages/core/src/engine/manifest.ts packages/core/src/engine/runner.ts \
        packages/core/src/engine/manifest.test.ts
git commit -m "feat(core): record the working tree as a run stops"
```

---

### Task 3: `executionKey` in core, and `planResume`

All the reading and all the refusing, so the runner receives a plan it can trust.

**Files:**
- Modify: `packages/core/src/engine/manifest.ts` (add `executionKey`)
- Create: `packages/core/src/engine/resume.ts`
- Create: `packages/core/src/engine/resume.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `WORKFLOW_SNAPSHOT_NAME` (Task 1), `stoppedTree` (Task 2), existing `getRun`, `isSafeRunId`, `snapshotTree`, `diffSnapshots`, `resolveWorkflowPath`, `parseWorkflow`.
- Produces:
  - `executionKey(stepId: string, iteration?: number): string`
  - `class ResumeError extends Error`
  - `interface ResumePlan` (full shape below)
  - `planResume(workdir: string, config: WorkspaceConfig, runId: string): Promise<ResumePlan>`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/engine/resume.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planResume, ResumeError } from './resume.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import type { RunManifest } from './manifest.ts';

const WORKFLOW = `name: cycle
steps:
  - id: plan
    kind: agent
    runner: fake
    mode: headless
    writes: false
    prompt: plan it
    output: plan.md
  - kind: loop
    id: fix
    until: check
    steps:
      - id: edit
        kind: agent
        runner: fake
        mode: headless
        writes: true
        prompt: edit
        output: edit.md
      - id: check
        kind: command
        run: "true"
        verdict: true
        output: check.log
`;

/** Writes a run directory with the given manifest steps and returns the workdir. */
async function fixture(
  steps: RunManifest['steps'],
  overrides: Partial<RunManifest> = {},
  opts: { snapshot?: boolean } = {},
): Promise<{ workdir: string; runId: string }> {
  const workdir = await mkdtemp(join(tmpdir(), 'mc-resume-'));
  const runId = '20260101-000000-aaaa';
  const runDir = join(workdir, '.mc', 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const manifest: RunManifest = {
    version: 2, runId, workflow: 'cycle', workdir, dryRun: false,
    pid: 999_999, startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z',
    endedAt: '2026-01-01T00:01:00Z', status: 'failed', ok: false,
    inputs: { feature: 'x' }, sessionIds: {}, steps, ...overrides,
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(manifest), 'utf8');
  if (opts.snapshot !== false) await writeFile(join(runDir, 'workflow.yaml'), WORKFLOW, 'utf8');
  return { workdir, runId };
}

test('planResume marks completed steps done and names the restart point', async () => {
  const { workdir, runId } = await fixture([
    { id: 'plan', kind: 'agent', status: 'done', artifact: '/r/plan.md' },
    { id: 'fix', kind: 'loop', status: 'running', iterations: 1 },
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 1, status: 'done', artifact: '/r/fix/iter-1/edit.md' },
    { id: 'check', kind: 'command', loopId: 'fix', iteration: 1, status: 'failed' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, runId);

  assert.equal(plan.done.has('plan'), true);
  assert.equal(plan.done.has('edit'), true);
  assert.equal(plan.done.has('check'), false);
  assert.equal(plan.restartAt?.stepId, 'check');
  assert.equal(plan.artifacts.plan, '/r/plan.md');
  assert.equal(plan.workflow.name, 'cycle');
});

test('planResume keeps only completed artifacts, so a half-written one is never referenced', async () => {
  const { workdir, runId } = await fixture([
    { id: 'plan', kind: 'agent', status: 'done', artifact: '/r/plan.md' },
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 1, status: 'failed', artifact: '/r/half.md' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, runId);

  assert.equal(plan.artifacts.plan, '/r/plan.md');
  assert.equal(plan.artifacts.edit, undefined);
});

test('planResume records a verdict so a skipped check still drives its loop', async () => {
  const { workdir, runId } = await fixture([
    { id: 'check', kind: 'command', loopId: 'fix', iteration: 1, status: 'done', verdict: 'fail' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, runId);

  assert.equal(plan.done.get('check')?.verdict, 'fail');
});

test('planResume keys a second iteration separately from the first', async () => {
  const { workdir, runId } = await fixture([
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 1, status: 'done', artifact: '/r/1.md' },
    { id: 'edit', kind: 'agent', loopId: 'fix', iteration: 2, status: 'done', artifact: '/r/2.md' },
  ]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, runId);

  assert.equal(plan.done.has('edit'), true);
  assert.equal(plan.done.has('edit#2'), true);
  // ctx.artifacts must hold the newest, which is what a forward reference wants.
  assert.equal(plan.artifacts.edit, '/r/2.md');
});

test('planResume resumes a session only for a step that actually started', async () => {
  // Session ids are minted for every interactive step before the run begins,
  // so a pending step has an id but no session on disk to resume.
  const { workdir, runId } = await fixture(
    [
      { id: 'plan', kind: 'agent', status: 'interrupted' },
      { id: 'later', kind: 'agent', status: 'pending' },
    ],
    { sessionIds: { plan: 'sess-plan', later: 'sess-later' } },
  );

  const plan = await planResume(workdir, DEFAULT_CONFIG, runId);

  assert.equal(plan.resumedStepIds.has('plan'), true);
  assert.equal(plan.resumedStepIds.has('later'), false);
});

test('planResume refuses a run that succeeded', async () => {
  const { workdir, runId } = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'done' }],
    { status: 'succeeded', ok: true });

  await assert.rejects(() => planResume(workdir, DEFAULT_CONFIG, runId), ResumeError);
});

test('planResume resumes a cancelled run', async () => {
  const { workdir, runId } = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'interrupted' }],
    { status: 'cancelled' });

  const plan = await planResume(workdir, DEFAULT_CONFIG, runId);
  assert.equal(plan.restartAt?.stepId, 'plan');
});

test('planResume refuses a run whose owner is still alive', async () => {
  // A live pid plus a fresh heartbeat: readRunSummary leaves this 'running'.
  const { workdir, runId } = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'running' }],
    { status: 'running', pid: process.pid, heartbeatAt: new Date().toISOString(), endedAt: undefined });

  await assert.rejects(() => planResume(workdir, DEFAULT_CONFIG, runId), ResumeError);
});

test('planResume refuses an unknown run id', async () => {
  const { workdir } = await fixture([{ id: 'plan', kind: 'agent', status: 'failed' }]);
  await assert.rejects(() => planResume(workdir, DEFAULT_CONFIG, 'no-such-run'), ResumeError);
});

test('planResume falls back to the workspace workflow when a run has no snapshot, and says so', async () => {
  const { workdir, runId } = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'failed' }], {}, { snapshot: false });
  await mkdir(join(workdir, '.mc', 'workflows'), { recursive: true });
  await writeFile(join(workdir, '.mc', 'workflows', 'cycle.yaml'), WORKFLOW, 'utf8');

  const plan = await planResume(workdir, DEFAULT_CONFIG, runId);

  assert.equal(plan.workflow.name, 'cycle');
  assert.ok(plan.warnings.some(w => w.includes('no workflow snapshot')));
});

test('planResume refuses when there is no snapshot and no workflow to fall back to', async () => {
  const { workdir, runId } = await fixture(
    [{ id: 'plan', kind: 'agent', status: 'failed' }], {}, { snapshot: false });

  await assert.rejects(() => planResume(workdir, DEFAULT_CONFIG, runId), ResumeError);
});

test('planResume warns that tree drift is unknown when no snapshot was recorded', async () => {
  const { workdir, runId } = await fixture([{ id: 'plan', kind: 'agent', status: 'failed' }]);

  const plan = await planResume(workdir, DEFAULT_CONFIG, runId);

  assert.ok(plan.warnings.some(w => w.includes('working tree')));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test packages/core/src/engine/resume.test.ts
```

Expected: FAIL — `Cannot find module './resume.ts'`.

- [ ] **Step 3: Add `executionKey` to core**

In `packages/core/src/engine/manifest.ts`, next to `MANIFEST_VERSION`:

```ts
/**
 * Identifies one *execution*. A loop runs the same step id many times, so an
 * id alone no longer addresses a row — the same `iteration ?? 1` defaulting
 * `beginStep` matches entries by, spelled once so resume and the desktop agree.
 */
export function executionKey(stepId: string, iteration?: number): string {
  return iteration === undefined || iteration === 1 ? stepId : `${stepId}#${iteration}`;
}
```

- [ ] **Step 4: Write `resume.ts`**

Create `packages/core/src/engine/resume.ts`:

```ts
/**
 * Everything needed to restart a run from its first unfinished step.
 *
 * All the reading and all the refusing happen here, so `runWorkflow` receives
 * a plan it can trust and stays about executing steps. Kept out of runner.ts,
 * which is long enough already.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Workflow, WorkspaceConfig } from '../types.ts';
import { parseWorkflow } from '../schema.ts';
import { resolveWorkflowPath } from '../workspace.ts';
import { diffSnapshots, snapshotTree } from './git-guard.ts';
import {
  executionKey, getRun, isSafeRunId, WORKFLOW_SNAPSHOT_NAME, type RunManifest,
} from './manifest.ts';

export class ResumeError extends Error {
  constructor(message: string) { super(message); this.name = 'ResumeError'; }
}

/** What a skipped execution has to tell the walk that replays it. */
export interface DoneExecution {
  artifact?: string;
  verdict?: 'pass' | 'fail';
}

export interface ResumePlan {
  runId: string;
  runDir: string;
  /** The manifest to reopen, exactly as read. */
  manifest: RunManifest;
  /** Parsed from the run's snapshot, or from the workspace as a fallback. */
  workflow: Workflow;
  inputs: Record<string, string>;
  sessionIds: Record<string, string>;
  /** stepId -> newest completed artifact, for forward references. */
  artifacts: Record<string, string>;
  /** stepId -> every completed artifact, oldest first. */
  attempts: Record<string, string[]>;
  /** Executions the manifest records as done, keyed by `executionKey`. */
  done: Map<string, DoneExecution>;
  /** Ids whose interactive session may be resumed rather than minted afresh. */
  resumedStepIds: Set<string>;
  /** First not-done execution. Display only — the mechanism is skip-based. */
  restartAt: { stepId: string; iteration?: number } | undefined;
  warnings: string[];
}

/** A run in any of these states is half-finished and can be continued. */
const RESUMABLE = new Set(['failed', 'interrupted', 'cancelled']);

export async function planResume(
  workdir: string, config: WorkspaceConfig, runId: string,
): Promise<ResumePlan> {
  if (!isSafeRunId(runId)) throw new ResumeError(`'${runId}' is not a valid run id`);
  const detail = await getRun(workdir, config, runId);
  if (detail === null) throw new ResumeError(`no run '${runId}' under ${config.artifacts_dir}`);
  if (detail.status === 'unknown') {
    throw new ResumeError(`run '${runId}' has no readable run.json, so there is nothing to resume`);
  }
  if (!RESUMABLE.has(detail.status)) {
    // 'running' lands here too: readRunSummary has already downgraded genuinely
    // abandoned runs to 'interrupted', so anything still claiming to run has a
    // live owner, and two writers would corrupt the run directory.
    throw new ResumeError(
      `run '${runId}' is ${detail.status}; only failed, interrupted or cancelled runs can be resumed`);
  }

  const warnings: string[] = [];
  const workflow = await loadWorkflow(detail, workdir, warnings);

  const done = new Map<string, DoneExecution>();
  const artifacts: Record<string, string> = {};
  const attempts: Record<string, string[]> = {};
  const resumedStepIds = new Set<string>();
  let restartAt: ResumePlan['restartAt'];

  for (const step of detail.steps) {
    if (step.status === 'done') {
      done.set(executionKey(step.id, step.iteration), {
        ...(step.artifact === undefined ? {} : { artifact: step.artifact }),
        ...(step.verdict === undefined ? {} : { verdict: step.verdict }),
      });
      // Only completed work is restored: a half-written artifact from the
      // attempt that failed must never become a forward reference.
      if (step.artifact !== undefined) {
        artifacts[step.id] = step.artifact;
        (attempts[step.id] ??= []).push(step.artifact);
      }
      continue;
    }
    if (restartAt === undefined && step.kind !== 'loop') {
      restartAt = { stepId: step.id, ...(step.iteration === undefined ? {} : { iteration: step.iteration }) };
    }
    // A session exists to resume only for a step that actually started; ids are
    // minted for every interactive step up front, so 'pending' has none on disk.
    if (step.status !== 'pending' && detail.sessionIds[step.id] !== undefined) {
      resumedStepIds.add(step.id);
    }
  }

  warnings.push(...await treeWarnings(detail, workdir));

  return {
    runId, runDir: detail.runDir, manifest: detail, workflow,
    inputs: detail.inputs, sessionIds: detail.sessionIds,
    artifacts, attempts, done, resumedStepIds, restartAt, warnings,
  };
}

/**
 * The workflow the run executed. The snapshot is authoritative; a run recorded
 * before snapshots existed falls back to the workspace file, which may since
 * have changed — hence the warning.
 */
async function loadWorkflow(
  manifest: RunManifest & { runDir: string }, workdir: string, warnings: string[],
): Promise<Workflow> {
  try {
    return parseWorkflow(await readFile(join(manifest.runDir, WORKFLOW_SNAPSHOT_NAME), 'utf8'));
  } catch (e) {
    if (e instanceof Error && e.name === 'WorkflowError') {
      throw new ResumeError(`run '${manifest.runId}' has an unreadable workflow snapshot: ${e.message}`);
    }
  }
  warnings.push(
    `no workflow snapshot in this run, so '${manifest.workflow}' was re-read from the workspace; `
    + 'its definition may have changed since the run started');
  try {
    return parseWorkflow(await readFile(await resolveWorkflowPath(manifest.workflow, workdir), 'utf8'));
  } catch (e) {
    throw new ResumeError(
      `run '${manifest.runId}' has no workflow snapshot and workflow '${manifest.workflow}' `
      + `could not be read: ${(e as Error).message}`);
  }
}

/** What changed in the working tree since the run stopped, as warnings. */
async function treeWarnings(manifest: RunManifest, workdir: string): Promise<string[]> {
  if (manifest.stoppedTree === undefined) {
    return ['no working tree snapshot was recorded when this run stopped, '
      + 'so changes since then cannot be reported'];
  }
  const now = await snapshotTree(workdir);
  if (now === null) return [];
  const changed = diffSnapshots(manifest.stoppedTree, now);
  if (changed.length === 0) return [];
  const shown = changed.slice(0, 10).join(', ');
  return [`${changed.length} file(s) changed since this run stopped: ${shown}`
    + (changed.length > 10 ? ', …' : '')];
}
```

- [ ] **Step 5: Export from core's index**

In `packages/core/src/index.ts`, alongside the existing manifest export:

```ts
export { RunJournal, listRuns, getRun, MANIFEST_VERSION, executionKey, WORKFLOW_SNAPSHOT_NAME } from './engine/manifest.ts';
export { planResume, ResumeError } from './engine/resume.ts';
export type { ResumePlan, DoneExecution } from './engine/resume.ts';
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
node --test packages/core/src/engine/resume.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 7: Run the full gate and commit**

```bash
npm run verify
git add packages/core/src/engine/resume.ts packages/core/src/engine/resume.test.ts \
        packages/core/src/engine/manifest.ts packages/core/src/index.ts
git commit -m "feat(core): plan a resume from a run's manifest"
```

---

### Task 4: `RunJournal.reopen`

A resumed run continues its existing manifest rather than seeding a new one.

**Files:**
- Modify: `packages/core/src/engine/manifest.ts`
- Test: `packages/core/src/engine/manifest.test.ts`

**Interfaces:**
- Consumes: `resumedAt` (Task 2).
- Produces: `RunJournal.reopen(runDir: string, manifest: RunManifest, heartbeatIntervalMs?: number): RunJournal`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/engine/manifest.test.ts`:

```ts
test('reopen continues an existing manifest instead of seeding a new one', async () => {
  const runDir = await tmpRunDir();
  const first = new RunJournal(cycleInit(runDir, 'run-reopen'));
  first.record({ type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'fake', mode: 'headless' });
  first.record({ type: 'step:done', stepId: 'execute', exitCode: 1 });
  first.record({ type: 'run:error', stepId: 'execute', message: 'boom' });
  await first.flush();

  const stopped = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunManifest;
  assert.equal(stopped.status, 'failed');

  const second = RunJournal.reopen(runDir, stopped);
  second.close();
  await second.flush();

  const reopened = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunManifest;
  assert.equal(reopened.status, 'running');
  assert.equal(reopened.runId, 'run-reopen');
  assert.equal(reopened.error, undefined);
  assert.equal(reopened.endedAt, undefined);
  assert.equal(reopened.ok, undefined);
  assert.equal(reopened.pid, process.pid);
  assert.equal(reopened.resumedAt?.length, 1);
  // The plan and its history survive: reopen never reseeds steps.
  assert.deepEqual(reopened.steps.map(s => s.id), stopped.steps.map(s => s.id));
});

test('a restarted step patches its entry rather than appending a second one', async () => {
  const runDir = await tmpRunDir();
  const first = new RunJournal(cycleInit(runDir, 'run-patch'));
  first.record({ type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'fake', mode: 'headless' });
  first.record({ type: 'step:done', stepId: 'execute', exitCode: 1 });
  await first.flush();

  const second = RunJournal.reopen(runDir, first.manifest);
  second.record({ type: 'step:start', stepId: 'execute', kind: 'agent', runner: 'fake', mode: 'headless' });
  second.record({ type: 'step:done', stepId: 'execute', exitCode: 0 });
  second.close();
  await second.flush();

  const entries = second.manifest.steps.filter(s => s.id === 'execute');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'done');
  assert.equal(entries[0].exitCode, 0);
});

test('reopen appends to the existing event log rather than truncating it', async () => {
  const runDir = await tmpRunDir();
  const first = new RunJournal(cycleInit(runDir, 'run-log'));
  first.record({ type: 'run:error', message: 'boom' });
  await first.flush();
  const before = (await readFile(join(runDir, 'events.ndjson'), 'utf8')).trim().split('\n').length;

  const second = RunJournal.reopen(runDir, first.manifest);
  second.record({ type: 'guard:warning', message: 'resumed' });
  second.close();
  await second.flush();

  const after = (await readFile(join(runDir, 'events.ndjson'), 'utf8')).trim().split('\n').length;
  assert.equal(after, before + 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test packages/core/src/engine/manifest.test.ts
```

Expected: FAIL — `RunJournal.reopen is not a function`.

- [ ] **Step 3: Implement `reopen`**

In `packages/core/src/engine/manifest.ts`, change the constructor to accept an optional existing manifest and add the static. Replace the constructor with:

```ts
  /**
   * `existing` is the resume path: rather than seeding a fresh manifest, keep
   * the one on disk — its steps are the record a resumed run continues.
   */
  constructor(init: RunJournalInit, existing?: RunManifest) {
    const now = new Date().toISOString();
    this.runDir = init.runDir;
    this.manifest = existing === undefined
      ? {
          version: MANIFEST_VERSION,
          runId: init.runId,
          workflow: init.workflow,
          workdir: init.workdir,
          dryRun: init.dryRun,
          pid: process.pid,
          startedAt: now,
          updatedAt: now,
          heartbeatAt: now,
          status: 'running',
          inputs: init.inputs,
          sessionIds: init.sessionIds,
          steps: init.steps.map(s => ({
            id: s.id, kind: s.kind, loopId: s.loopId, runner: s.runner, model: s.model,
            mode: s.mode, status: 'pending' as const,
          })),
        }
      : {
          ...existing,
          pid: process.pid,
          status: 'running',
          updatedAt: now,
          heartbeatAt: now,
          // A resumed run is not over, and does not carry its last failure.
          endedAt: undefined,
          ok: undefined,
          error: undefined,
          manualPending: undefined,
          resumedAt: [...(existing.resumedAt ?? []), now],
        };
    this.startHeartbeat(init.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Continues a stopped run's journal. The manifest is the one `planResume`
   * read; its `steps` are kept verbatim, so a restarted step patches its own
   * entry through `beginStep` rather than appending a duplicate.
   */
  static reopen(runDir: string, manifest: RunManifest, heartbeatIntervalMs?: number): RunJournal {
    return new RunJournal({
      runDir,
      runId: manifest.runId,
      workflow: manifest.workflow,
      workdir: manifest.workdir,
      dryRun: manifest.dryRun,
      inputs: manifest.inputs,
      sessionIds: manifest.sessionIds,
      // Ignored: `existing` supplies the steps. Reseeding them would erase the
      // history a resume exists to keep.
      steps: [],
      ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
    }, manifest);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test packages/core/src/engine/manifest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add packages/core/src/engine/manifest.ts packages/core/src/engine/manifest.test.ts
git commit -m "feat(core): let RunJournal reopen a stopped run"
```

---

### Task 5: The runner skips what is already done

The load-bearing task. Everything before it was groundwork.

**Files:**
- Modify: `packages/core/src/types.ts` (two `McEvent` members)
- Modify: `packages/core/src/events.ts` (their zod mirrors)
- Modify: `packages/core/src/engine/manifest.ts` (journal cases)
- Modify: `packages/core/src/engine/runner.ts` (`resume` option, ctx seeding, skip predicate)
- Test: `packages/core/src/engine/runner.test.ts`

**Interfaces:**
- Consumes: `ResumePlan`, `planResume` (Task 3); `RunJournal.reopen` (Task 4); `executionKey` (Task 3).
- Produces:
  - `RunOptions.resume?: ResumePlan`
  - `McEvent` members `{ type: 'run:resume'; runId: string; workflow: string; from?: string }` and `{ type: 'step:skipped'; stepId: string; loopId?: string; iteration?: number }`

**Note:** the caller passes `plan.workflow` as `opts.workflow` and `plan.inputs` as `opts.inputs`. `runWorkflow` does not swap them itself — that keeps input resolution and workflow validation on exactly one path.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/engine/runner.test.ts`. These use the file's existing harness conventions; `recordingFrontend()` collects emitted events and `spawnCounter()` counts spawns.

```ts
test('a resumed run spawns nothing for steps already done', async () => {
  const workdir = await tmpWorkdir();
  const workflow = parseWorkflow(
    'name: two\nsteps:\n'
    + '  - id: first\n    kind: command\n    run: "true"\n    output: first.log\n'
    + '  - id: second\n    kind: command\n    run: "true"\n    output: second.log\n');
  const spawns: string[] = [];

  const plan = fakePlan({
    workflow,
    done: new Map([['first', { artifact: '/r/first.log' }]]),
  });

  const events: McEvent[] = [];
  await runWorkflow({
    workflow, workdir, inputs: {}, config: DEFAULT_CONFIG,
    registry: defaultRegistry(), frontend: collecting(events),
    spawnHeadless: async spec => { spawns.push(spec.argv.join(' ')); return 0; },
    resume: plan,
  });

  assert.equal(spawns.length, 1, 'only the unfinished step should spawn');
  assert.ok(events.some(e => e.type === 'step:skipped' && e.stepId === 'first'));
  assert.ok(events.some(e => e.type === 'step:start' && e.stepId === 'second'));
  assert.equal(events.some(e => e.type === 'run:start'), false);
  assert.ok(events.some(e => e.type === 'run:resume'));
});

test('a skipped step restores its artifact for later steps to reference', async () => {
  const workdir = await tmpWorkdir();
  const workflow = parseWorkflow(
    'name: two\nsteps:\n'
    + '  - id: first\n    kind: command\n    run: "true"\n    output: first.log\n'
    + '  - id: second\n    kind: command\n    run: "true"\n    output: second.log\n');

  const result = await runWorkflow({
    workflow, workdir, inputs: {}, config: DEFAULT_CONFIG,
    registry: defaultRegistry(), frontend: silentFrontend(),
    spawnHeadless: async () => 0,
    resume: fakePlan({ workflow, done: new Map([['first', { artifact: '/r/first.log' }]]) }),
  });

  assert.equal(result.artifacts.first, '/r/first.log');
});

test('a skipped verdict step still sends its loop round again', async () => {
  const workdir = await tmpWorkdir();
  const workflow = parseWorkflow(
    'name: cyc\nsteps:\n'
    + '  - kind: loop\n    id: fix\n    until: check\n    max_iterations: 3\n    steps:\n'
    + '      - id: edit\n        kind: command\n        run: "true"\n        output: edit.log\n'
    + '      - id: check\n        kind: command\n        run: "true"\n        verdict: true\n        output: check.log\n');
  const events: McEvent[] = [];

  await runWorkflow({
    workflow, workdir, inputs: {}, config: DEFAULT_CONFIG,
    registry: defaultRegistry(), frontend: collecting(events),
    spawnHeadless: async () => 0,
    resume: fakePlan({
      workflow,
      done: new Map([
        ['edit', { artifact: '/r/fix/iter-1/edit.log' }],
        // Iteration 1 failed its check, so the replay must go round again
        // rather than reading the skip as a pass.
        ['check', { artifact: '/r/fix/iter-1/check.log', verdict: 'fail' }],
      ]),
    }),
  });

  const iterations = events.filter(e => e.type === 'loop:iteration');
  assert.ok(iterations.length >= 2, 'iteration 1 failed, so iteration 2 must run');
});

test('a skipped passing verdict step ends its loop where it ended before', async () => {
  const workdir = await tmpWorkdir();
  const workflow = parseWorkflow(
    'name: cyc\nsteps:\n'
    + '  - kind: loop\n    id: fix\n    until: check\n    max_iterations: 3\n    steps:\n'
    + '      - id: check\n        kind: command\n        run: "true"\n        verdict: true\n        output: check.log\n');
  const spawns: string[] = [];

  await runWorkflow({
    workflow, workdir, inputs: {}, config: DEFAULT_CONFIG,
    registry: defaultRegistry(), frontend: silentFrontend(),
    spawnHeadless: async spec => { spawns.push(spec.argv.join(' ')); return 0; },
    resume: fakePlan({
      workflow,
      done: new Map([['check', { artifact: '/r/c.log', verdict: 'pass' }]]),
    }),
  });

  assert.equal(spawns.length, 0, 'the loop already passed; nothing should run');
});

test('a resumed loop restarts mid-iteration, keeping what that iteration already produced', async () => {
  const workdir = await tmpWorkdir();
  const workflow = parseWorkflow(
    'name: cyc\nsteps:\n'
    + '  - kind: loop\n    id: fix\n    until: check\n    max_iterations: 3\n    steps:\n'
    + '      - id: edit\n        kind: command\n        run: "true"\n        output: edit.log\n'
    + '      - id: check\n        kind: command\n        run: "true"\n        verdict: true\n        output: check.log\n');
  const started: string[] = [];
  const events: McEvent[] = [];

  await runWorkflow({
    workflow, workdir, inputs: {}, config: DEFAULT_CONFIG,
    registry: defaultRegistry(), frontend: collecting(events),
    spawnHeadless: async () => 0,
    resume: fakePlan({
      workflow,
      done: new Map([
        ['edit', { artifact: '/r/1/edit.log' }],
        ['check', { artifact: '/r/1/check.log', verdict: 'fail' }],
        // Iteration 2 got as far as edit, then the run died.
        ['edit#2', { artifact: '/r/2/edit.log' }],
      ]),
    }),
  });

  for (const e of events) if (e.type === 'step:start') started.push(`${e.stepId}#${e.iteration ?? 1}`);
  // edit#2 was done, so only check#2 restarts.
  assert.equal(started.includes('edit#2'), false);
  assert.ok(started.includes('check#2'));
});

test('a skip is consumed once, so a step re-run by on_findings loop really runs', async () => {
  // The legacy top-level jump re-executes the same step id with no iteration,
  // so the same execution key comes round twice. The second time must not be
  // silently skipped.
  const workdir = await tmpWorkdir();
  const workflow = parseWorkflow(
    'name: legacy\non_findings: loop\nsteps:\n'
    + '  - id: work\n    kind: agent\n    runner: fake\n    mode: headless\n    writes: true\n'
    + '    prompt: do it\n    output: work.md\n'
    + '  - id: review\n    kind: command\n    run: "false"\n    verdict: true\n    output: review.log\n');
  const started: string[] = [];
  const events: McEvent[] = [];

  await runWorkflow({
    workflow, workdir, inputs: {}, config: { ...DEFAULT_CONFIG, loop: { max_iterations: 2 } },
    registry: defaultRegistry(), frontend: collecting(events),
    spawnHeadless: async () => 0,
    resume: fakePlan({ workflow, done: new Map([['work', { artifact: '/r/work.md' }]]) }),
  });

  for (const e of events) if (e.type === 'step:start') started.push(e.stepId);
  assert.ok(started.includes('work'), 'the second execution of work must not be skipped');
});
```

Add this helper near the top of `runner.test.ts`:

```ts
/** A minimal ResumePlan for runner tests; planResume is tested separately. */
function fakePlan(over: Partial<ResumePlan> & { workflow: Workflow }): ResumePlan {
  return {
    runId: 'run-x', runDir: '/tmp/does-not-matter',
    manifest: {
      version: 2, runId: 'run-x', workflow: over.workflow.name, workdir: '/w', dryRun: false,
      pid: process.pid, startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      status: 'failed', inputs: {}, sessionIds: {}, steps: [],
    },
    inputs: {}, sessionIds: {}, artifacts: {}, attempts: {},
    done: new Map(), resumedStepIds: new Set(), restartAt: undefined, warnings: [],
    ...over,
  };
}
```

**Note for the implementer:** `fakePlan` uses `runDir: '/tmp/does-not-matter'` — a resumed run writes its manifest there, so point it at a real temp directory created by the test if `runWorkflow` errors on the write. Use `await tmpRunDir()` and pass `runDir` explicitly in each test if so.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test packages/core/src/engine/runner.test.ts
```

Expected: FAIL — `resume` is not a known property of `RunOptions`, and `run:resume` / `step:skipped` are not `McEvent` members.

- [ ] **Step 3: Add the two events to `types.ts`**

In `packages/core/src/types.ts`, in the `McEvent` union:

```ts
export type McEvent =
  | { type: 'run:start'; runId: string; workflow: string }
  /**
   * A stopped run is being continued. Replaces `run:start` rather than joining
   * it: a second `run:start` would read as a second run to every consumer.
   */
  | { type: 'run:resume'; runId: string; workflow: string; from?: string }
  | {
      type: 'step:start'; stepId: string; kind: StepKind; runner?: string;
      model?: string; mode?: StepMode; loopId?: string; iteration?: number;
    }
  /** This execution already completed in an earlier attempt and was not re-run. */
  | { type: 'step:skipped'; stepId: string; loopId?: string; iteration?: number }
  // ... rest unchanged
```

And add to `RunCtx`:

```ts
  /**
   * Steps whose recorded session should be resumed rather than minted afresh.
   * Set only on a resumed run; adapters that cannot resume ignore it.
   */
  resumedStepIds?: ReadonlySet<string>;
```

- [ ] **Step 4: Mirror them in `events.ts`**

In `packages/core/src/events.ts`, inside `mcEventSchema`'s union:

```ts
  z.object({
    type: z.literal('run:resume'), runId: z.string(), workflow: z.string(),
    from: z.string().optional(),
  }),
  z.object({
    type: z.literal('step:skipped'), stepId: z.string(),
    loopId: z.string().optional(), iteration: z.number().int().positive().optional(),
  }),
```

- [ ] **Step 5: Handle them in the journal**

In `packages/core/src/engine/manifest.ts`, in `RunJournal.record`'s switch:

```ts
      case 'run:resume':
        break; // the manifest was already reopened by RunJournal.reopen
      case 'step:skipped':
        break; // the entry it names is already 'done'; only the event log records it
```

- [ ] **Step 6: Wire `resume` through the runner**

In `packages/core/src/engine/runner.ts`:

Add to the imports:

```ts
import { RunJournal, WORKFLOW_SNAPSHOT_NAME, executionKey } from './manifest.ts';
import type { ResumePlan } from './resume.ts';
```

Add to `RunOptions`:

```ts
  /**
   * Continue a stopped run instead of starting a new one. The caller passes
   * `plan.workflow` as `workflow` and `plan.inputs` as `inputs`, so input
   * resolution and workflow validation stay on exactly one path.
   */
  resume?: ResumePlan;
```

Replace the run-directory and ctx setup:

```ts
  const workdir = resolve(opts.workdir);
  const { runId, runDir } = opts.resume === undefined
    ? await createRunDirFor(workdir, config)
    : { runId: opts.resume.runId, runDir: opts.resume.runDir };
  if (opts.resume === undefined) {
    await writeFile(join(runDir, WORKFLOW_SNAPSHOT_NAME), stringifyYaml(workflow), 'utf8');
  }
  const ctx: RunCtx = {
    workdir, runId, runDir,
    sessionIds: { ...(opts.resume?.sessionIds ?? {}) },
    artifacts: { ...(opts.resume?.artifacts ?? {}) },
    attempts: { ...(opts.resume?.attempts ?? {}) },
    inputs,
    ...(opts.resume === undefined ? {} : { resumedStepIds: opts.resume.resumedStepIds }),
  };

  const planned = flattenSteps(workflow.steps);
  for (const { step } of planned) {
    if (!isAgentStep(step) || step.mode !== 'interactive') continue;
    // A resumed run keeps the ids it already minted; re-minting would orphan
    // the very sessions the resume exists to continue.
    if (ctx.sessionIds[step.id] !== undefined) continue;
    if (registry.get(step.runner).capabilities.sessionIdInjection) {
      ctx.sessionIds[step.id] = randomUUID();
    }
  }

  const journal = opts.resume === undefined
    ? new RunJournal({
        runDir, runId, workflow: workflow.name, workdir, dryRun: !!opts.dryRun,
        inputs, sessionIds: ctx.sessionIds, steps: planned.map(({ step, loopId }) => ({
          id: step.id,
          kind: step.kind,
          loopId,
          runner: isAgentStep(step) ? step.runner : undefined,
          model: isAgentStep(step) ? step.model : undefined,
          mode: isAgentStep(step) ? step.mode : undefined,
        })),
      })
    : RunJournal.reopen(runDir, opts.resume.manifest);
```

Inside `runSteps`, replace the opening emit:

```ts
    emit(opts.resume === undefined
      ? { type: 'run:start', runId, workflow: workflow.name }
      : {
          type: 'run:resume', runId, workflow: workflow.name,
          ...(opts.resume.restartAt === undefined ? {} : { from: opts.resume.restartAt.stepId }),
        });
```

Add the consume-once skip set just below `let loopsUsed = 0;`:

```ts
    /**
     * Executions to skip, consumed as they are used. Consume-once matters for
     * the `on_findings: loop` path, which re-executes the same top-level step
     * id — and so the same execution key — a second time: that execution has
     * to really run rather than inherit the first one's skip.
     */
    const skippable = new Map(opts.resume?.done ?? []);
```

And in `executeStep`, immediately after the loop branch:

```ts
      try {
        if (isLoopStep(step)) return await executeLoop(step);
        const key = executionKey(step.id, frame?.iteration);
        const alreadyDone = skippable.get(key);
        if (alreadyDone !== undefined) {
          skippable.delete(key);
          if (alreadyDone.artifact !== undefined) recordArtifact(step.id, alreadyDone.artifact);
          emit({
            type: 'step:skipped', stepId: step.id,
            ...(frame === undefined ? {} : { loopId: frame.id, iteration: frame.iteration }),
          });
          if (!step.verdict) return null;
          // Restoring the verdict is not optional: it is what drives a loop's
          // exit check and the top-level on_findings jump. Returning null here
          // would make a loop that originally failed twice replay as passing.
          verdict = alreadyDone.verdict;
          return alreadyDone.verdict === 'fail' ? 'verdict-fail' : null;
        }
        emit({
          type: 'step:start', stepId: step.id, kind: step.kind,
          // ... rest unchanged
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
node --test packages/core/src/engine/runner.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run the full gate and commit**

```bash
npm run verify
git add packages/core/src/types.ts packages/core/src/events.ts \
        packages/core/src/engine/manifest.ts packages/core/src/engine/runner.ts \
        packages/core/src/engine/runner.test.ts
git commit -m "feat(core): resume a run by skipping what it already finished"
```

---

### Task 6: Resume the agent session where the runner can

**Files:**
- Modify: `packages/core/src/adapters/claude.ts` (`interactive`, around line 106)
- Test: `packages/core/src/adapters/claude.test.ts`

**Interfaces:**
- Consumes: `RunCtx.resumedStepIds` (Task 5).
- Produces: nothing new; changes claude's `interactive()` argv.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/adapters/claude.test.ts` (match the file's existing `step`/`ctx` fixture helpers):

```ts
test('interactive resumes the recorded session for a step being retried', () => {
  const step: AgentStep = {
    id: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive',
    writes: false, prompt: 'plan it', output: 'plan.md',
  };
  const base = { ...baseCtx(), sessionIds: { plan: 'sess-plan' } };

  const fresh = claudeAdapter.interactive(step, base);
  assert.ok(fresh.argv.includes('--session-id'));
  assert.equal(fresh.argv.includes('--resume'), false);

  const resumed = claudeAdapter.interactive(step, { ...base, resumedStepIds: new Set(['plan']) });
  assert.ok(resumed.argv.includes('--resume'));
  assert.equal(resumed.argv.includes('--session-id'), false);
  assert.equal(resumed.argv[resumed.argv.indexOf('--resume') + 1], 'sess-plan');
});

test('interactive mints as usual for a step that is not being retried', () => {
  const step: AgentStep = {
    id: 'plan', kind: 'agent', runner: 'claude', mode: 'interactive',
    writes: false, prompt: 'plan it', output: 'plan.md',
  };
  const ctx = { ...baseCtx(), sessionIds: { plan: 'sess-plan' }, resumedStepIds: new Set(['other']) };

  assert.ok(claudeAdapter.interactive(step, ctx).argv.includes('--session-id'));
});
```

And in `packages/core/src/adapters/copilot.test.ts`, proving the field is inert for a
runner that never records a session id:

```ts
test('copilot ignores resumedStepIds, having no session id of its own to resume', () => {
  const step: AgentStep = {
    id: 'plan', kind: 'agent', runner: 'copilot', mode: 'interactive',
    writes: false, prompt: 'plan it', output: 'plan.md',
  };
  const ctx = baseCtx();

  const plain = copilotAdapter.interactive(step, ctx).argv;
  const withSet = copilotAdapter.interactive(step, { ...ctx, resumedStepIds: new Set(['plan']) }).argv;

  assert.deepEqual(withSet, plain);
});
```

If `copilot.test.ts` has no `baseCtx` helper, define one returning
`{ workdir: '/w', runId: 'r', runDir: '/w/.mc/runs/r', sessionIds: {}, artifacts: {}, attempts: {}, inputs: {} }`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test packages/core/src/adapters/claude.test.ts
```

Expected: FAIL — the resumed spawn still contains `--session-id`.

- [ ] **Step 3: Implement the branch**

In `packages/core/src/adapters/claude.ts`, in `interactive`:

```ts
  interactive(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const marker = endMarkerPath(ctx.runDir, step.id);
    const awaitPath = awaitStatePath(ctx.runDir, step.id);
    const settings = settingsArg(marker, awaitPath);
    // --session-id mints; continuing an existing conversation needs --resume,
    // exactly as harvest() already does. Only a resumed run sets this.
    const sessionArgs = ctx.resumedStepIds?.has(step.id) === true
      ? ['--resume', sessionId(step, ctx)]
      : ['--session-id', sessionId(step, ctx)];
    const argv = [
      'claude', ...sessionArgs,
      ...modelArgs(step), ...effortArgs(step),
      ...(step.writes ? [] : [`--disallowedTools=${CLAUDE_WRITE_TOOLS}`]),
      '--append-system-prompt', interactiveGuidance(step, ctx),
      ...settings,
      buildPrompt(step, ctx),
    ];
```

The rest of the method is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test packages/core/src/adapters/claude.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add packages/core/src/adapters/claude.ts packages/core/src/adapters/claude.test.ts
git commit -m "feat(core): resume a claude session for a retried interactive step"
```

---

### Task 7: `mc run --resume`

**Files:**
- Modify: `packages/cli/src/program.ts`
- Modify: `packages/cli/src/commands/run.ts`
- Modify: `packages/cli/src/render.ts`
- Test: `packages/cli/src/render.test.ts`, `packages/cli/src/program.test.ts`

**Interfaces:**
- Consumes: `planResume`, `ResumeError`, `ResumePlan` (Task 3); `RunOptions.resume` (Task 5).
- Produces: `runCommand(workflowRef: string | undefined, opts: { dryRun; input; cwd; json?; yes?; maxIterations?; resume?: string; freshSession?: boolean })`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/render.test.ts`:

```ts
test('renders a resume header and reused steps', () => {
  const lines: string[] = [];
  const render = createRenderer({ out: l => lines.push(l), err: () => {}, now: () => 0 });

  render({ type: 'run:resume', runId: 'r1', workflow: 'cycle', from: 'execute' });
  render({ type: 'step:skipped', stepId: 'plan' });
  render({ type: 'step:skipped', stepId: 'edit', loopId: 'fix', iteration: 2 });

  assert.match(lines[0], /resume r1/);
  assert.match(lines[0], /execute/);
  assert.match(lines[1], /plan/);
  assert.match(lines[1], /reused/);
  // Loop bodies stay indented, as step:start already does.
  assert.match(lines[2], /^ {2}/);
});
```

Append to `packages/cli/src/program.test.ts`:

```ts
test('run accepts --resume without a workflow argument', () => {
  const run = buildProgram().commands.find(c => c.name() === 'run')!;
  assert.equal(run.registeredArguments[0].required, false);
  assert.ok(run.options.some(o => o.long === '--resume'));
  assert.ok(run.options.some(o => o.long === '--fresh-session'));
});
```

Create `packages/cli/src/commands/run.test.ts` for the two refusals, capturing stderr so
the message is asserted rather than assumed:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from './run.ts';

/** Runs `fn` with console.error captured. */
async function withStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    return { code: await fn(), err: lines.join('\n') };
  } finally {
    console.error = original;
  }
}

test('--resume refuses a workflow argument, because the snapshot decides', async () => {
  const { code, err } = await withStderr(() => runCommand('cycle', {
    dryRun: false, input: [], cwd: process.cwd(), resume: '20260101-000000-aaaa',
  }));
  assert.equal(code, 2);
  assert.match(err, /do not also name one/);
});

test('--resume refuses --dry-run, which mints no artifacts to skip', async () => {
  const { code, err } = await withStderr(() => runCommand(undefined, {
    dryRun: true, input: [], cwd: process.cwd(), resume: '20260101-000000-aaaa',
  }));
  assert.equal(code, 2);
  assert.match(err, /--dry-run/);
});

test('a plain run with no workflow argument says what is missing', async () => {
  const { code, err } = await withStderr(() => runCommand(undefined, {
    dryRun: false, input: [], cwd: process.cwd(),
  }));
  assert.equal(code, 2);
  assert.match(err, /--resume/);
});
```

Both refusals must be checked **before** `planResume` runs, so these tests need no run
directory on disk.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test packages/cli/src/render.test.ts packages/cli/src/program.test.ts
```

Expected: FAIL — no `run:resume` case, and `<workflow>` is still required.

- [ ] **Step 3: Add the renderer cases**

In `packages/cli/src/render.ts`, in the `switch`, next to `run:start`:

```ts
      case 'run:resume':
        return out(`mc resume ${event.runId} — workflow '${event.workflow}'`
          + (event.from === undefined ? '' : `, from step '${event.from}'`));
      case 'step:skipped':
        return out(`${event.loopId === undefined ? '' : '  '}↷ step ${event.stepId} (reused)`);
```

- [ ] **Step 4: Add the CLI surface**

In `packages/cli/src/program.ts`, change the `run` command's argument and options:

```ts
  program.command('run')
    .description('run a workflow, or resume a stopped one')
    .argument('[workflow]', 'workflow name (in .mc/workflows/) or path to a YAML file; omit with --resume')
    .option('--resume <runId>', 'continue a failed, interrupted or cancelled run from its first unfinished step')
    .option('--fresh-session', 'on resume, start a new agent session instead of continuing the recorded one', false)
    .option('--dry-run', 'resolve and print every step argv without spawning', false)
```

and widen the action's types:

```ts
    .action(async (
      workflowRef: string | undefined,
      opts: {
        dryRun: boolean; input: string[]; C: string; json: boolean;
        yes: boolean; maxIterations?: number; resume?: string; freshSession: boolean;
      },
    ) => {
      process.exitCode = await runCommand(workflowRef, {
        dryRun: opts.dryRun, input: opts.input, cwd: opts.C, json: opts.json,
        yes: opts.yes, maxIterations: opts.maxIterations,
        resume: opts.resume, freshSession: opts.freshSession,
      });
    });
```

- [ ] **Step 5: Add the resume branch**

Replace `packages/cli/src/commands/run.ts` with:

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  defaultRegistry, loadWorkspaceConfig, parseInputPairs, parseWorkflow, planResume,
  resolveWorkflowPath, ResumeError, runWorkflow,
} from '@wp/core';
import type { Frontend, McEvent, ResumePlan } from '@wp/core';
import { spawnHeadless, spawnInteractive } from '../tty.ts';
import { createRenderer } from '../render.ts';
import { createManualPrompt, promptMissingInputs } from '../prompt.ts';

function jsonEvent(event: McEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export interface RunCommandOptions {
  dryRun: boolean; input: string[]; cwd: string; json?: boolean;
  yes?: boolean; maxIterations?: number; resume?: string; freshSession?: boolean;
}

export async function runCommand(
  workflowRef: string | undefined, opts: RunCommandOptions,
): Promise<number> {
  const workdir = resolve(opts.cwd);
  const promptOpts = { yes: !!opts.yes, ...(opts.json ? { isTty: false } : {}) };
  const frontend: Frontend = {
    runInteractive: spawnInteractive,
    runManual: createManualPrompt(promptOpts),
    onEvent: opts.json ? jsonEvent : createRenderer(),
  };
  const config = await loadWorkspaceConfig(workdir);

  let plan: ResumePlan | undefined;
  if (opts.resume !== undefined) {
    // The snapshot decides what runs, so a workflow ref could only contradict
    // it; and a dry run mints no artifacts, so it cannot honour a skip set.
    if (workflowRef !== undefined) {
      console.error('--resume runs the workflow the run recorded; do not also name one');
      return 2;
    }
    if (opts.dryRun) {
      console.error('--resume and --dry-run cannot be combined');
      return 2;
    }
    try {
      plan = await planResume(workdir, config, opts.resume);
    } catch (e) {
      if (e instanceof ResumeError) { console.error(`✘ ${e.message}`); return 1; }
      throw e;
    }
    for (const warning of plan.warnings) console.error(`  ⚠ ${warning}`);
    if (opts.freshSession) plan = { ...plan, resumedStepIds: new Set() };
  } else if (workflowRef === undefined) {
    console.error("missing workflow: name one, or pass --resume <runId>");
    return 2;
  }

  const workflow = plan === undefined
    ? parseWorkflow(await readFile(await resolveWorkflowPath(workflowRef!, workdir), 'utf8'))
    : plan.workflow;
  const inputs = plan === undefined
    ? await promptMissingInputs(workflow, parseInputPairs(opts.input), promptOpts)
    : plan.inputs;

  const result = await runWorkflow({
    workflow, workdir, inputs, config,
    registry: defaultRegistry(), frontend,
    dryRun: opts.dryRun, spawnHeadless,
    ...(opts.maxIterations === undefined ? {} : { maxIterations: opts.maxIterations }),
    ...(plan === undefined ? {} : { resume: plan }),
  });
  return result.ok ? 0 : 1;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
node --test packages/cli/src/render.test.ts packages/cli/src/program.test.ts \
             packages/cli/src/commands/run.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the full gate and commit**

```bash
npm run verify
git add packages/cli/src/program.ts packages/cli/src/commands/run.ts packages/cli/src/render.ts \
        packages/cli/src/render.test.ts packages/cli/src/program.test.ts \
        packages/cli/src/commands/run.test.ts
git commit -m "feat(cli): mc run --resume"
```

---

### Task 8: `resumeRun` over the agent protocol

**Files:**
- Modify: `packages/agent/src/protocol.ts`
- Modify: `packages/agent/src/handlers.ts`
- Modify: `packages/agent/src/frontend.ts`
- Test: `packages/agent/src/main.test.ts`

**Interfaces:**
- Consumes: `planResume`, `ResumeError` (Task 3); `RunOptions.resume` (Task 5).
- Produces: RPC `resumeRun { workdir: string; runId: string; freshSession?: boolean } -> { jobId: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/agent/src/main.test.ts`, matching that file's existing request/notification harness:

```ts
test('resumeRun against a run that cannot be resumed fails cleanly', async () => {
  const h = await startAgent();
  const res = await h.request('resumeRun', { workdir: h.workdir, runId: 'no-such-run' });
  assert.equal(res.error?.code, -32000);
  assert.match(String(res.error?.message), /no run/);
  await h.stop();
});

test('a resumed run carries its runId on every mcEvent notification', async () => {
  const h = await startAgent();
  // Arrange a resumable run on disk, then resume it.
  const runId = await h.writeFailedRun();
  const { result } = await h.request('resumeRun', { workdir: h.workdir, runId });

  const events = await h.collectMcEvents(result.jobId);
  assert.ok(events.length > 0);
  // The desktop correlates by runId; run:resume must populate it as run:start does.
  assert.ok(events.every(e => e.runId === runId));
  await h.stop();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test packages/agent/src/main.test.ts
```

Expected: FAIL — `resumeRun` is not a known method.

- [ ] **Step 3: Add the protocol entry**

In `packages/agent/src/protocol.ts`, next to `startRunParams`:

```ts
export const resumeRunParams = z.object({
  workdir: z.string().min(1),
  runId: z.string().min(1),
  /** Start a new agent session instead of continuing the recorded one. */
  freshSession: z.boolean().optional(),
});
export const resumeRunResult = z.object({ jobId: z.string() });
```

In the `methods` map, after `startRun`:

```ts
  resumeRun: { params: resumeRunParams, result: resumeRunResult },
```

With the exported types, after `StartRunResult`:

```ts
export type ResumeRunParams = z.infer<typeof resumeRunParams>;
export type ResumeRunResult = z.infer<typeof resumeRunResult>;
```

- [ ] **Step 4: Populate `runIdBox` from `run:resume`**

In `packages/agent/src/frontend.ts`, in `onEvent`:

```ts
      // A resumed run has no run:start; without this every mcEvent for it goes
      // out with runId undefined and the desktop cannot correlate it.
      if (event.type === 'run:start' || event.type === 'run:resume') runIdBox.current = event.runId;
      if (event.type === 'step:start') lastStepId = event.stepId;
      notify('mcEvent', {
        jobId, workdir: job.workdir, runId: runIdBox.current, event, ts: new Date().toISOString(),
      });
      if (event.type === 'run:start' || event.type === 'run:resume') {
        notify('runStateChanged', {
          jobId, workdir: job.workdir, runId: runIdBox.current, status: 'running',
        });
      }
```

- [ ] **Step 5: Add the handler**

In `packages/agent/src/handlers.ts`, add the background driver next to `runJobInBackground`:

```ts
async function resumeJobInBackground(
  notify: NotifyFn, job: ReturnType<JobManager['create']>, params: ResumeRunParams,
): Promise<void> {
  const runIdBox: { current?: string } = {};
  try {
    const workdir = resolve(params.workdir);
    const config = await loadWorkspaceConfig(workdir);
    let plan = await planResume(workdir, config, params.runId);
    if (params.freshSession) plan = { ...plan, resumedStepIds: new Set() };
    for (const warning of plan.warnings) {
      notify('mcEvent', {
        jobId: job.jobId, workdir: job.workdir, runId: plan.runId,
        event: { type: 'guard:warning', message: warning },
        ts: new Date().toISOString(),
      });
    }
    const result = await runWorkflow({
      workflow: plan.workflow, workdir, config,
      registry: defaultRegistry(),
      frontend: createFrontend(job, notify, runIdBox),
      spawnHeadless: createSpawnHeadless(job.jobId, notify),
      inputs: plan.inputs, signal: job.controller.signal, resume: plan,
    });
    job.status = result.cancelled ? 'cancelled' : result.ok ? 'succeeded' : 'failed';
  } catch (e) {
    job.status = 'failed';
    notify('mcEvent', {
      jobId: job.jobId, workdir: job.workdir, runId: runIdBox.current,
      event: { type: 'run:error', message: (e as Error).message },
      ts: new Date().toISOString(),
    });
  } finally {
    abandonManual(job, 'run ended');
    job.runId = runIdBox.current ?? params.runId;
    notify('runStateChanged', {
      jobId: job.jobId, workdir: job.workdir, runId: job.runId, status: job.status,
    });
  }
}
```

Add the handler next to `startRun`:

```ts
  const resumeRun: Handler = async (params, ctx): Promise<ResumeRunResult> => {
    const p = params as ResumeRunParams;
    const workdir = resolve(p.workdir);
    // Refuse before creating a job, so an unresumable run is an error the
    // caller sees rather than a job that dies a moment later.
    const config = await loadWorkspaceConfig(workdir);
    await planResume(workdir, config, p.runId);
    const job = jobs.create(workdir);
    job.promise = resumeJobInBackground(ctx.notify, job, p);
    // Deliberately no rememberRun: that records a workflow + inputs pair for
    // the New Run dialog's prefill, and a resume introduces neither.
    return { jobId: job.jobId };
  };
```

Register it in the returned object:

```ts
    startRun, resumeRun, cancelRun, endSession, resolveManual, listRuns, getRun, readArtifact, writeArtifact,
```

Add `planResume` and `ResumeError` to the `@wp/core` import at the top of the file, and `ResumeRunParams`/`ResumeRunResult` to the protocol import.

**Note:** nothing extra is needed to turn a `ResumeError` into an RPC error. `packages/agent/src/rpc.ts:87` already wraps *any* error thrown by a handler as `{ code: ErrorCode.ServerError (-32000), message }`, which is exactly what the first test asserts. Let it propagate — do not catch it in the handler and invent a result shape.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
node --test packages/agent/src/main.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the full gate and commit**

```bash
npm run verify
git add packages/agent/src/protocol.ts packages/agent/src/handlers.ts \
        packages/agent/src/frontend.ts packages/agent/src/main.test.ts
git commit -m "feat(agent): resumeRun RPC"
```

---

### Task 9: Resume from the desktop

**Files:**
- Modify: `apps/desktop/src/state/store.ts`
- Modify: `apps/desktop/src/pages/RunDetailPage.tsx`
- Test: `apps/desktop/src/state/store.test.ts`, `apps/desktop/src/pages/RunDetailPage.test.tsx`

**Interfaces:**
- Consumes: RPC `resumeRun` (Task 8); events `run:resume`, `step:skipped` (Task 5).
- Produces: nothing further.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/state/store.test.ts`:

```ts
describe('resumed runs', () => {
  it('picks up the run id from a resume, which has no run:start', () => {
    const { applyMcEvent } = useAppStore.getState();
    applyMcEvent({
      jobId: 'j-res', event: { type: 'run:resume', runId: 'r-res', workflow: 'cycle' }, ts: 't0',
    });
    expect(useAppStore.getState().jobs['j-res'].runId).toBe('r-res');
  });

  it('shows a skipped step as done rather than leaving it blank', () => {
    const { applyMcEvent } = useAppStore.getState();
    applyMcEvent({ jobId: 'j-skip', event: { type: 'run:resume', runId: 'r', workflow: 'c' }, ts: 't0' });
    applyMcEvent({ jobId: 'j-skip', event: { type: 'step:skipped', stepId: 'plan' }, ts: 't1' });

    expect(useAppStore.getState().jobs['j-skip'].steps['plan'].status).toBe('done');
  });

  it('keys a skipped loop-body step by its iteration', () => {
    const { applyMcEvent } = useAppStore.getState();
    applyMcEvent({
      jobId: 'j-skip2',
      event: { type: 'step:skipped', stepId: 'edit', loopId: 'fix', iteration: 2 },
      ts: 't1',
    });
    expect(useAppStore.getState().jobs['j-skip2'].steps['edit#2'].status).toBe('done');
  });
});
```

Append to `apps/desktop/src/pages/RunDetailPage.test.tsx`:

```ts
it('offers Resume for a failed run and calls resumeRun', async () => {
  const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-failed');
  await respondGetRun(transport, {
    runId: 'r-failed', runDir: '/ws/.mc/runs/r-failed', status: 'failed',
    workflow: 'cycle', inputs: {}, artifacts: [],
    steps: [{ id: 'plan', status: 'done' }, { id: 'execute', status: 'failed' }],
  });

  fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));

  const req = await waitFor(() => {
    const i = transport.sent.findIndex(l => (JSON.parse(l) as { method?: string }).method === 'resumeRun');
    if (i === -1) throw new Error('resumeRun not sent yet');
    return transport.sentRequest(i);
  });
  expect(req.params).toMatchObject({ workdir: '/ws', runId: 'r-failed' });
});

it('offers no Resume for a run that succeeded', async () => {
  const { transport } = renderRunDetail(undefined, vi.fn(), vi.fn(), 'r-ok2');
  await respondGetRun(transport, {
    runId: 'r-ok2', runDir: '/ws/.mc/runs/r-ok2', status: 'succeeded',
    workflow: 'cycle', inputs: {}, artifacts: [], steps: [{ id: 'plan', status: 'done' }],
  });

  await screen.findByRole('button', { name: 'Run again' });
  expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test -w desktop -- src/state/store.test.ts src/pages/RunDetailPage.test.tsx
```

Expected: FAIL — no Resume button; skipped steps produce no state.

- [ ] **Step 3: Reduce the new events**

In `apps/desktop/src/state/store.ts`, extend the runId pickup:

```ts
    const runId = params.runId
      ?? (event.type === 'run:start' || event.type === 'run:resume' ? event.runId : undefined);
```

and add the cases next to `run:start`:

```ts
      case 'run:start':
      case 'run:resume':
        break;
```

```ts
      case 'step:skipped':
        // Reused from an earlier attempt: it is done, it just did not run again.
        job = upsertStep(job, event.stepId, {
          loopId: event.loopId,
          iteration: event.iteration,
          status: 'done',
        }, event.iteration);
        break;
```

- [ ] **Step 4: Add the Resume button**

In `apps/desktop/src/pages/RunDetailPage.tsx`, add near the other status derivations:

```ts
/** Statuses a run can be continued from. Mirrors core's RESUMABLE set. */
const RESUMABLE_RUN_STATUSES = new Set(['failed', 'interrupted', 'cancelled']);
```

```ts
  const [resuming, setResuming] = useState(false);
  const canResume = !isRunning
    && typeof manifest?.status === 'string'
    && RESUMABLE_RUN_STATUSES.has(manifest.status);

  async function handleResume(): Promise<void> {
    if (!workspacePath || !effectiveRunId) return;
    setResuming(true);
    try {
      await client.request('resumeRun', { workdir: workspacePath, runId: effectiveRunId });
    } finally {
      setResuming(false);
    }
  }
```

and the button, immediately before the existing "Run again" button:

```tsx
        {canResume && (
          <Button
            appearance="primary"
            disabled={resuming}
            icon={resuming ? <Spinner size="tiny" /> : <Replay20Regular />}
            title="Continue this run from its first unfinished step"
            onClick={() => void handleResume()}
          >
            {resuming ? 'Resuming…' : 'Resume'}
          </Button>
        )}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run test -w desktop -- src/state/store.test.ts src/pages/RunDetailPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Run the full gate and commit**

```bash
npm run verify
git add apps/desktop/src/state/store.ts apps/desktop/src/pages/RunDetailPage.tsx \
        apps/desktop/src/state/store.test.ts apps/desktop/src/pages/RunDetailPage.test.tsx
git commit -m "feat(desktop): resume a stopped run"
```

---

## Verification

After Task 9, confirm the feature end to end in a scratch workspace rather than trusting the unit tests alone:

- [ ] Create a workflow whose second step is `kind: command` with `run: "false"`. Run it; watch it fail.
- [ ] `mc run --resume <runId>` and confirm the first step prints `↷ step … (reused)`, no spawn happens for it, and the second step runs again.
- [ ] Edit a tracked file, resume again, and confirm the tree-drift warning names it.
- [ ] Confirm `run.json` still holds one entry per step, with `resumedAt` growing by one per resume.
- [ ] Open the run in the desktop and confirm Resume appears, then disappears once the run succeeds.

## Notes for the implementer

- **Fixture realism in Task 3.** `getRun` calls `readRunSummary`, which *repairs* a manifest still claiming `running` when the pid is dead — and writes the repair back. The "refuses a live run" test therefore uses `process.pid` with a fresh `heartbeatAt` so no repair happens.
- **Task 5 is where a subtle bug will hide.** The `on_findings: loop` replay is the riskiest path in this whole plan; if its test is awkward to write, that is a signal about the design, not a reason to skip it.
- **Do not add `--from <stepId>`.** `restartAt` exists for display. Arbitrary restart points are explicitly out of scope in the spec.
- **Do not add retry/backoff.** Also out of scope; this plan is the foundation it would later sit on.
