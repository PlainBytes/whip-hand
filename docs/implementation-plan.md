# `whiphand` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `whiphand`, a CLI that runs workflows — ordered steps against a working folder, each step pinned to its own runner (`claude`/`copilot`), model, and tool policy, with interactive planning and headless execute/review.

**Architecture:** Two npm workspaces: `packages/core` (workflow schema, adapters producing `SpawnSpec`s, run engine, JSON events — no terminal I/O, never spawns interactive processes) and `packages/cli` (the `whiphand` binary — renders events, owns the TTY). The seam exists so a future Tauri frontend reuses core unchanged.

**Tech Stack:** Node ≥ 24 (native TypeScript type-stripping — no build step), npm workspaces, `node:test` runner, Zod v4, `yaml`, `commander`.

**Spec:** `docs/design.md` (and `docs/research.md` for the why). Read both before starting.

## Global Constraints

- Node `>=24` only; TypeScript must be **erasable-syntax-only** (`erasableSyntaxOnly: true` — no enums, no namespaces, no parameter properties) so `.ts` runs directly under Node without a build step.
- Dependencies limited to: `zod@^4`, `yaml@^2`, `commander@^14`. Dev-only additions require no justification beyond `@types/node`.
- `packages/core` must never import `node:readline`, never write to `process.stdout`/`stderr`, and never spawn a process with `stdio: 'inherit'`. All spawning of interactive steps happens in `packages/cli`.
- All CLI flags emitted for `claude`/`copilot` must match the verified tables in `docs/design.md` §"Why the two target CLIs make a thin adapter layer viable". Do not invent flags.
- Multi-value tool lists are passed as **one comma-joined argument** (e.g. `--disallowedTools "Write,Edit,NotebookEdit"`), never as variadic args — variadic flags would swallow the positional prompt.
- Artifacts live under `.whiphand/runs/<runId>/`; nothing else in the working tree may be touched by a `writes: false` step.
- Conventional commits (`feat:`, `test:`, `chore:`, `docs:`). Commit at the end of every task at minimum.
- v1 loop mode is bounded by `max_iterations` only. `max_spend_usd` is **out of scope for v1** (Task 13 updates `docs/design.md` accordingly).

## Verified CLI facts the code relies on

Confirmed against the installed binaries (`claude` 2.1.252, `copilot` 1.0.60) — re-verify with `--help` if either has been updated:

| Fact | claude | copilot |
|---|---|---|
| Seed interactive with prompt | positional: `claude "<prompt>"` | `-i, --interactive <prompt>` |
| Headless | `-p` (+ positional prompt) | `-p, --prompt <text>`; **requires** `--allow-all-tools` |
| Mint session id up front | `--session-id <uuid>` (creates) | **not possible** — `--session-id` *resumes* |
| Resume | `-r, --resume <id>` (works with `-p`) | `--resume=<id>` |
| Transcript export | — | `--share=<path>` (markdown, written after session ends) |
| Deny write tools | `--disallowedTools "Write,Edit,NotebookEdit"` | `--deny-tool write` (denial beats `--allow-all-tools`) |
| Version output | `2.1.252 (Claude Code)` | `GitHub Copilot CLI 1.0.60.` |

Consequence: claude's interactive harvest resumes the minted session; copilot's interactive harvest distills the `--share` transcript. This is why `RunnerAdapter.capabilities` exists.

## File structure (end state)

```
package.json                  npm workspaces root, scripts: test / typecheck
tsconfig.json                 shared strict config, erasableSyntaxOnly
packages/core/
  package.json                name: @whiphand/core
  src/
    types.ts                  all shared types (single source of truth)
    schema.ts                 Zod schema + parseWorkflow()
    template.ts               renderTemplate() + buildPrompt()
    config.ts                 loadWorkspaceConfig()
    registry.ts               AdapterRegistry + validateWorkflowRunners()
    adapters/claude.ts        claudeAdapter
    adapters/copilot.ts       copilotAdapter
    engine/artifacts.ts       createRunDir(), artifactPath(), assertArtifact()
    engine/git-guard.ts       snapshotTree(), diffSnapshots()
    engine/verdict.ts         parseVerdict()
    engine/runner.ts          runWorkflow()
    index.ts                  public re-exports
  src/*.test.ts, src/**/*.test.ts
packages/cli/
  package.json                name: @whiphand/cli, bin: { whiphand: "./src/main.ts" }
  src/
    main.ts                   commander wiring (#!/usr/bin/env node)
    tty.ts                    spawnInteractive(), spawnHeadless()
    commands/doctor.ts        doctorReport()
    commands/run.ts           runCommand()
examples/feature.yaml         sample plan/execute/review workflow
docs/                         research.md, design.md, this plan
```

---

### Task 1: Repository scaffold and toolchain smoke test

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `packages/core/package.json`, `packages/core/src/index.ts`, `packages/core/src/smoke.test.ts`
- Create: `packages/cli/package.json`, `packages/cli/src/main.ts`

**Interfaces:**
- Produces: a repo where `npm test` runs `node:test` over `.ts` files with zero build, and `npm run typecheck` type-checks both packages. Every later task depends on these two commands working.

- [ ] **Step 1: git init and root files**

```bash
cd whiphand && git init -b main
```

`package.json`:
```json
{
  "name": "whiphand",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "node --test \"packages/*/src/**/*.test.ts\"",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": { "@types/node": "^24.0.0", "typescript": "^5.9.0" }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["packages/*/src/**/*.ts"]
}
```

`.gitignore`:
```
node_modules/
.whiphand/runs/
```

- [ ] **Step 2: package manifests**

`packages/core/package.json`:
```json
{
  "name": "@whiphand/core",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^4.0.0", "yaml": "^2.6.0" }
}
```

`packages/cli/package.json`:
```json
{
  "name": "@whiphand/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": { "whiphand": "./src/main.ts" },
  "dependencies": { "@whiphand/core": "0.1.0", "commander": "^14.0.0" }
}
```

`packages/core/src/index.ts` (placeholder until Task 2):
```ts
export const CORE_VERSION = '0.1.0';
```

`packages/cli/src/main.ts`:
```ts
#!/usr/bin/env node
import { CORE_VERSION } from '@whiphand/core';

console.log(`whiphand ${CORE_VERSION}`);
```

- [ ] **Step 3: write the smoke test**

`packages/core/src/smoke.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_VERSION } from './index.ts';

test('toolchain runs TypeScript tests natively', () => {
  assert.equal(CORE_VERSION, '0.1.0');
});
```

- [ ] **Step 4: install and verify everything runs**

```bash
npm install
npm test        # expect: 1 pass
npm run typecheck   # expect: exit 0, no output
node packages/cli/src/main.ts   # expect: "whiphand 0.1.0"
```
If `node --test` does not pick up the glob, quote it exactly as in package.json (the shell must not expand it).

- [ ] **Step 5: commit**

```bash
git add -A && git commit -m "chore: scaffold npm-workspaces monorepo with no-build TS toolchain"
```

---

### Task 2: Core types and workflow schema

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/schema.ts`
- Test: `packages/core/src/schema.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces (everything later tasks import from `./types.ts` — exact shapes):

```ts
export type StepMode = 'interactive' | 'headless';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type OnFindings = 'report' | 'loop' | 'interactive';

export interface WorkflowInput { required: boolean; prompt?: string; default?: string; }

export interface Step {
  id: string;
  runner: string;
  model?: string;
  mode: StepMode;
  writes: boolean;
  prompt: string;
  inputs?: string[];        // ids of earlier steps whose artifacts feed this one
  output: string;           // artifact filename within the run dir
  allow_paths?: string[];
  effort?: EffortLevel;
  verdict?: boolean;        // this step's artifact must start with VERDICT: PASS|FAIL
}

export interface Workflow {
  name: string;
  inputs?: Record<string, WorkflowInput>;
  on_findings?: OnFindings;
  steps: Step[];
}

export interface SpawnSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;  // EXTRA env only; frontend merges process.env
  interactive: boolean;
}

export interface RunCtx {
  workdir: string;                       // absolute
  runId: string;
  runDir: string;                        // absolute
  sessionIds: Record<string, string>;    // stepId -> minted uuid (claude only)
  artifacts: Record<string, string>;     // stepId -> absolute artifact path
  inputs: Record<string, string>;        // resolved workflow input values
}

export interface DetectResult { installed: boolean; version?: string; }

export interface RunnerAdapter {
  id: string;
  capabilities: {
    sessionIdInjection: boolean;
    sessionResume: boolean;
    toolDenial: boolean;
    shareTranscript: boolean;
  };
  detect(): Promise<DetectResult>;
  interactive(step: Step, ctx: RunCtx): SpawnSpec;
  headless(step: Step, ctx: RunCtx): SpawnSpec;
  harvest(step: Step, ctx: RunCtx): SpawnSpec;
}

export interface WorkspaceConfig {
  defaults: { runner: string };
  on_findings: OnFindings;
  loop: { max_iterations: number };
  artifacts_dir: string;                 // relative to workdir, default '.whiphand/runs'
}

export type WhiphandEvent =
  | { type: 'run:start'; runId: string; workflow: string }
  | { type: 'step:start'; stepId: string; runner: string; model?: string; mode: StepMode }
  | { type: 'step:spawn'; stepId: string; spec: SpawnSpec; phase: 'main' | 'harvest' }
  | { type: 'step:artifact'; stepId: string; path: string }
  | { type: 'step:verdict'; stepId: string; verdict: 'pass' | 'fail' }
  | { type: 'step:done'; stepId: string; exitCode: number }
  | { type: 'guard:warning'; message: string }
  | { type: 'run:done'; runId: string; ok: boolean }
  | { type: 'run:error'; stepId?: string; message: string };

export interface Frontend {
  runInteractive(spec: SpawnSpec): Promise<number>;  // resolves with exit code
  onEvent(event: WhiphandEvent): void;
}
```

- `schema.ts` produces: `parseWorkflow(yamlText: string): Workflow` (throws `WorkflowError extends Error` with a `problems: string[]` field on any failure).

- [ ] **Step 1: write `types.ts`** exactly as above (plus a file-header comment saying it is the single source of truth for shared types).

- [ ] **Step 2: write the failing tests**

`packages/core/src/schema.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, WorkflowError } from './schema.ts';

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
  assert.equal(r.steps[0].mode, 'interactive');
  assert.equal(r.steps[2].verdict, true);
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
```

- [ ] **Step 3: run tests, verify they fail** — `npm test` → new tests FAIL (module `./schema.ts` not found).

- [ ] **Step 4: implement `schema.ts`**

```ts
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { Workflow } from './types.ts';

export class WorkflowError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`invalid workflow:\n  - ${problems.join('\n  - ')}`);
    this.name = 'WorkflowError';
    this.problems = problems;
  }
}

const stepSchema = z.object({
  id: z.string().min(1),
  runner: z.string().min(1),
  model: z.string().min(1).optional(),
  mode: z.enum(['interactive', 'headless']),
  writes: z.boolean(),
  prompt: z.string().min(1),
  inputs: z.array(z.string().min(1)).optional(),
  output: z.string().min(1),
  allow_paths: z.array(z.string().min(1)).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  verdict: z.boolean().optional(),
});

const workflowSchema = z.object({
  name: z.string().min(1),
  inputs: z.record(z.string(), z.object({
    required: z.boolean(),
    prompt: z.string().optional(),
    default: z.string().optional(),
  })).optional(),
  on_findings: z.enum(['report', 'loop', 'interactive']).optional(),
  steps: z.array(stepSchema).min(1),
});

export function parseWorkflow(yamlText: string): Workflow {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new WorkflowError([`YAML parse error: ${(e as Error).message}`]);
  }
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowError(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`));
  }
  const workflow = parsed.data;
  const problems: string[] = [];
  const seen = new Set<string>();
  workflow.steps.forEach((step, idx) => {
    if (seen.has(step.id)) problems.push(`duplicate step id '${step.id}'`);
    seen.add(step.id);
    for (const ref of step.inputs ?? []) {
      const refIdx = workflow.steps.findIndex(s => s.id === ref);
      if (refIdx === -1) problems.push(`step '${step.id}' references unknown step '${ref}'`);
      else if (refIdx >= idx) problems.push(`step '${step.id}' references later step '${ref}'`);
    }
  });
  if (problems.length > 0) throw new WorkflowError(problems);
  return workflow;
}
```

- [ ] **Step 5: run tests, verify pass** — `npm test` → all pass. Run `npm run typecheck` → exit 0.

- [ ] **Step 6: export from index and commit**

`packages/core/src/index.ts`:
```ts
export const CORE_VERSION = '0.1.0';
export * from './types.ts';
export { parseWorkflow, WorkflowError } from './schema.ts';
```

```bash
git add -A && git commit -m "feat(core): workflow types and zod schema with cross-reference validation"
```

---

### Task 3: Prompt templating

**Files:**
- Create: `packages/core/src/template.ts`
- Test: `packages/core/src/template.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Step`, `RunCtx` from `./types.ts`.
- Produces:
  - `renderTemplate(tpl: string, inputs: Record<string, string>): string` — replaces `{{ inputs.<key> }}` (whitespace-tolerant inside braces); throws `TemplateError extends Error` on an unknown key.
  - `buildPrompt(step: Step, ctx: RunCtx): string` — rendered `step.prompt`, then (if `step.inputs` non-empty) an appended section:
    ```
    \n\n## Input artifacts (read these files first)\n- <stepId>: <absolute path>\n...
    ```

- [ ] **Step 1: write the failing tests**

`packages/core/src/template.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, buildPrompt, TemplateError } from './template.ts';
import type { RunCtx, Step } from './types.ts';

test('replaces input placeholders, whitespace-tolerant', () => {
  assert.equal(renderTemplate('build {{ inputs.feature }} now', { feature: 'oauth' }), 'build oauth now');
  assert.equal(renderTemplate('build {{inputs.feature}}', { feature: 'oauth' }), 'build oauth');
});

test('throws on unknown input key', () => {
  assert.throws(() => renderTemplate('{{ inputs.missing }}', {}), TemplateError);
});

test('leaves non-placeholder braces alone', () => {
  assert.equal(renderTemplate('code { x: 1 }', {}), 'code { x: 1 }');
});

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1',
  sessionIds: {}, artifacts: { plan: '/w/.whiphand/runs/r1/plan.md' }, inputs: { feature: 'oauth' },
};

test('buildPrompt appends artifact section for steps with inputs', () => {
  const step: Step = {
    id: 'execute', runner: 'copilot', mode: 'headless', writes: true,
    prompt: 'Implement {{ inputs.feature }}.', inputs: ['plan'], output: 'report.md',
  };
  const p = buildPrompt(step, ctx);
  assert.ok(p.startsWith('Implement oauth.'));
  assert.ok(p.includes('## Input artifacts'));
  assert.ok(p.includes('- plan: /w/.whiphand/runs/r1/plan.md'));
});

test('buildPrompt omits artifact section when step has no inputs', () => {
  const step: Step = {
    id: 'plan', runner: 'claude', mode: 'interactive', writes: false,
    prompt: 'Plan it.', output: 'plan.md',
  };
  assert.equal(buildPrompt(step, ctx), 'Plan it.');
});
```

- [ ] **Step 2: run tests, verify fail** — module not found.

- [ ] **Step 3: implement `template.ts`**

```ts
import type { RunCtx, Step } from './types.ts';

export class TemplateError extends Error {
  constructor(message: string) { super(message); this.name = 'TemplateError'; }
}

const PLACEHOLDER = /\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}/g;

export function renderTemplate(tpl: string, inputs: Record<string, string>): string {
  return tpl.replace(PLACEHOLDER, (_m, key: string) => {
    const value = inputs[key];
    if (value === undefined) throw new TemplateError(`unknown input '${key}'`);
    return value;
  });
}

export function buildPrompt(step: Step, ctx: RunCtx): string {
  const body = renderTemplate(step.prompt, ctx.inputs).trimEnd();
  const refs = step.inputs ?? [];
  if (refs.length === 0) return body;
  const lines = refs.map(id => {
    const path = ctx.artifacts[id];
    if (path === undefined) throw new TemplateError(`no artifact recorded for step '${id}'`);
    return `- ${id}: ${path}`;
  });
  return `${body}\n\n## Input artifacts (read these files first)\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: run tests, verify pass.** Add to `index.ts`: `export { renderTemplate, buildPrompt, TemplateError } from './template.ts';`

- [ ] **Step 5: commit**

```bash
git add -A && git commit -m "feat(core): prompt templating and artifact injection"
```

---

### Task 4: Adapter registry and capability validation

**Files:**
- Create: `packages/core/src/registry.ts`
- Test: `packages/core/src/registry.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `RunnerAdapter`, `Workflow` from `./types.ts`.
- Produces:
  - `class AdapterRegistry { register(adapter: RunnerAdapter): void; get(id: string): RunnerAdapter; has(id: string): boolean; list(): RunnerAdapter[]; }` — `register` throws on duplicate id; `get` throws on unknown id.
  - `validateWorkflowRunners(workflow: Workflow, registry: AdapterRegistry): string[]` — returns human-readable problems (empty array = valid): unknown runner; `mode: interactive` on an adapter with neither (`sessionIdInjection && sessionResume`) nor `shareTranscript`; `writes: false` on an adapter without `toolDenial`.

- [ ] **Step 1: write the failing tests**

`packages/core/src/registry.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry, validateWorkflowRunners } from './registry.ts';
import type { Workflow, RunnerAdapter, SpawnSpec } from './types.ts';

function fakeAdapter(id: string, caps: Partial<RunnerAdapter['capabilities']>): RunnerAdapter {
  const spec: SpawnSpec = { argv: [id], cwd: '/', env: {}, interactive: false };
  return {
    id,
    capabilities: {
      sessionIdInjection: false, sessionResume: false,
      toolDenial: false, shareTranscript: false, ...caps,
    },
    detect: async () => ({ installed: true }),
    interactive: () => spec, headless: () => spec, harvest: () => spec,
  };
}

const workflow = (runner: string, mode: 'interactive' | 'headless', writes = false): Workflow => ({
  name: 'r',
  steps: [{ id: 's1', runner, mode, writes, prompt: 'p', output: 'o.md' }],
});

test('register/get round-trips and rejects duplicates', () => {
  const reg = new AdapterRegistry();
  const a = fakeAdapter('x', {});
  reg.register(a);
  assert.equal(reg.get('x'), a);
  assert.ok(reg.has('x'));
  assert.throws(() => reg.register(fakeAdapter('x', {})));
  assert.throws(() => reg.get('y'));
});

test('flags unknown runner', () => {
  const reg = new AdapterRegistry();
  const problems = validateWorkflowRunners(workflow('ghost', 'headless', true), reg);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('ghost'));
});

test('interactive requires resume-injection pair or transcript sharing', () => {
  const reg = new AdapterRegistry();
  reg.register(fakeAdapter('bare', { toolDenial: true }));
  reg.register(fakeAdapter('resumer', { sessionIdInjection: true, sessionResume: true, toolDenial: true }));
  reg.register(fakeAdapter('sharer', { shareTranscript: true, toolDenial: true }));
  assert.equal(validateWorkflowRunners(workflow('bare', 'interactive'), reg).length, 1);
  assert.equal(validateWorkflowRunners(workflow('resumer', 'interactive'), reg).length, 0);
  assert.equal(validateWorkflowRunners(workflow('sharer', 'interactive'), reg).length, 0);
});

test('writes:false requires toolDenial', () => {
  const reg = new AdapterRegistry();
  reg.register(fakeAdapter('nodeny', {}));
  const problems = validateWorkflowRunners(workflow('nodeny', 'headless', false), reg);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('toolDenial') || problems[0].includes('read-only'));
});
```

- [ ] **Step 2: run tests, verify fail.**

- [ ] **Step 3: implement `registry.ts`**

```ts
import type { Workflow, RunnerAdapter } from './types.ts';

export class AdapterRegistry {
  #adapters = new Map<string, RunnerAdapter>();

  register(adapter: RunnerAdapter): void {
    if (this.#adapters.has(adapter.id)) throw new Error(`adapter '${adapter.id}' already registered`);
    this.#adapters.set(adapter.id, adapter);
  }
  get(id: string): RunnerAdapter {
    const a = this.#adapters.get(id);
    if (!a) throw new Error(`unknown runner '${id}'`);
    return a;
  }
  has(id: string): boolean { return this.#adapters.has(id); }
  list(): RunnerAdapter[] { return [...this.#adapters.values()]; }
}

export function validateWorkflowRunners(workflow: Workflow, registry: AdapterRegistry): string[] {
  const problems: string[] = [];
  for (const step of workflow.steps) {
    if (!registry.has(step.runner)) {
      problems.push(`step '${step.id}': unknown runner '${step.runner}'`);
      continue;
    }
    const caps = registry.get(step.runner).capabilities;
    if (step.mode === 'interactive') {
      const viaResume = caps.sessionIdInjection && caps.sessionResume;
      if (!viaResume && !caps.shareTranscript) {
        problems.push(
          `step '${step.id}': runner '${step.runner}' cannot harvest an interactive session ` +
          `(needs sessionIdInjection+sessionResume or shareTranscript)`);
      }
    }
    if (!step.writes && !caps.toolDenial) {
      problems.push(`step '${step.id}': runner '${step.runner}' lacks toolDenial, cannot enforce read-only`);
    }
  }
  return problems;
}
```

- [ ] **Step 4: run tests, verify pass.** Export both names from `index.ts`.

- [ ] **Step 5: commit**

```bash
git add -A && git commit -m "feat(core): adapter registry with validate-time capability checks"
```

---

### Task 5: Claude adapter

**Files:**
- Create: `packages/core/src/adapters/claude.ts`
- Test: `packages/core/src/adapters/claude.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Step`, `RunCtx`, `RunnerAdapter`, `SpawnSpec`, `DetectResult` from `../types.ts`; `buildPrompt` from `../template.ts`; `artifactPath` convention `${ctx.runDir}/${step.output}`.
- Produces:
  - `export const CLAUDE_WRITE_TOOLS = 'Write,Edit,NotebookEdit';`
  - `export const claudeAdapter: RunnerAdapter` with capabilities `{ sessionIdInjection: true, sessionResume: true, toolDenial: true, shareTranscript: false }`.
  - `interactive()` requires `ctx.sessionIds[step.id]` to be pre-minted by the engine (throws if absent).
- Argv contracts (tests assert these exactly):
  - interactive, writes:false: `['claude', '--session-id', <sid>, '--model', <m>, '--effort', <e>?, '--disallowedTools', 'Write,Edit,NotebookEdit', <prompt>]` (model/effort omitted when unset)
  - headless, writes:true: `['claude', '-p', '--model', <m>?, '--effort', <e>?, '--allowedTools', 'Bash,Write,Edit,NotebookEdit', <prompt>]`
  - headless, writes:false: `['claude', '-p', '--model', <m>?, '--effort', <e>?, '--allowedTools', 'Read,Grep,Glob,Bash', '--disallowedTools', 'Write,Edit,NotebookEdit', <prompt>]`
  - harvest: `['claude', '-p', '--resume', <sid>, '--model', <m>?, '--allowedTools', 'Write', <harvest prompt>]` where the harvest prompt is:
    `Write the final '<step.output>' artifact we agreed on in this conversation to <absolute artifact path>. Write only the artifact content to that file, then reply with just: done`

- [ ] **Step 1: write the failing tests**

`packages/core/src/adapters/claude.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAdapter, CLAUDE_WRITE_TOOLS } from './claude.ts';
import type { RunCtx, Step } from '../types.ts';

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1',
  sessionIds: { plan: '11111111-1111-4111-8111-111111111111' },
  artifacts: {}, inputs: {},
};

const planStep: Step = {
  id: 'plan', runner: 'claude', model: 'opus', mode: 'interactive',
  writes: false, prompt: 'Plan it.', output: 'plan.md',
};

test('interactive: pins session, denies write tools, seeds prompt last', () => {
  const spec = claudeAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.argv, [
    'claude', '--session-id', '11111111-1111-4111-8111-111111111111',
    '--model', 'opus', '--disallowedTools', CLAUDE_WRITE_TOOLS, 'Plan it.',
  ]);
  assert.equal(spec.cwd, '/w');
  assert.equal(spec.interactive, true);
});

test('interactive: throws when engine has not minted a session id', () => {
  assert.throws(() => claudeAdapter.interactive({ ...planStep, id: 'other' }, ctx), /session/);
});

test('headless writes:true pre-approves write tools', () => {
  const step: Step = { id: 'exec', runner: 'claude', mode: 'headless', writes: true, prompt: 'Do.', output: 'r.md' };
  const spec = claudeAdapter.headless(step, ctx);
  assert.deepEqual(spec.argv, ['claude', '-p', '--allowedTools', 'Bash,Write,Edit,NotebookEdit', 'Do.']);
  assert.equal(spec.interactive, false);
});

test('headless writes:false allows read-only set and denies write tools', () => {
  const step: Step = {
    id: 'review', runner: 'claude', model: 'haiku', mode: 'headless',
    writes: false, effort: 'high', prompt: 'Review.', output: 'f.md',
  };
  const spec = claudeAdapter.headless(step, ctx);
  assert.deepEqual(spec.argv, [
    'claude', '-p', '--model', 'haiku', '--effort', 'high',
    '--allowedTools', 'Read,Grep,Glob,Bash', '--disallowedTools', CLAUDE_WRITE_TOOLS, 'Review.',
  ]);
});

test('harvest resumes the minted session and only allows Write', () => {
  const spec = claudeAdapter.harvest(planStep, ctx);
  assert.equal(spec.argv[0], 'claude');
  assert.deepEqual(spec.argv.slice(1, 4), ['-p', '--resume', '11111111-1111-4111-8111-111111111111']);
  assert.ok(spec.argv.includes('--allowedTools'));
  assert.equal(spec.argv[spec.argv.indexOf('--allowedTools') + 1], 'Write');
  const prompt = spec.argv[spec.argv.length - 1];
  assert.ok(prompt.includes('/w/.whiphand/runs/r1/plan.md'));
  assert.ok(prompt.includes("'plan.md'"));
});
```

- [ ] **Step 2: run tests, verify fail.**

- [ ] **Step 3: implement `adapters/claude.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DetectResult, RunCtx, RunnerAdapter, SpawnSpec, Step } from '../types.ts';
import { buildPrompt } from '../template.ts';

const execFileAsync = promisify(execFile);

export const CLAUDE_WRITE_TOOLS = 'Write,Edit,NotebookEdit';
const READONLY_ALLOWED = 'Read,Grep,Glob,Bash';
const WRITES_ALLOWED = 'Bash,Write,Edit,NotebookEdit';

function modelArgs(step: Step): string[] {
  return step.model ? ['--model', step.model] : [];
}
function effortArgs(step: Step): string[] {
  return step.effort ? ['--effort', step.effort] : [];
}
function spec(ctx: RunCtx, argv: string[], interactive: boolean): SpawnSpec {
  return { argv, cwd: ctx.workdir, env: {}, interactive };
}
function sessionId(step: Step, ctx: RunCtx): string {
  const sid = ctx.sessionIds[step.id];
  if (!sid) throw new Error(`no session id minted for step '${step.id}'`);
  return sid;
}
export function harvestPrompt(step: Step, ctx: RunCtx): string {
  const path = `${ctx.runDir}/${step.output}`;
  return `Write the final '${step.output}' artifact we agreed on in this conversation to ${path}. ` +
    `Write only the artifact content to that file, then reply with just: done`;
}

export const claudeAdapter: RunnerAdapter = {
  id: 'claude',
  capabilities: { sessionIdInjection: true, sessionResume: true, toolDenial: true, shareTranscript: false },

  async detect(): Promise<DetectResult> {
    try {
      const { stdout } = await execFileAsync('claude', ['--version']);
      return { installed: true, version: stdout.match(/(\d+\.\d+\.\d+)/)?.[1] };
    } catch {
      return { installed: false };
    }
  },

  interactive(step: Step, ctx: RunCtx): SpawnSpec {
    const argv = [
      'claude', '--session-id', sessionId(step, ctx),
      ...modelArgs(step), ...effortArgs(step),
      ...(step.writes ? [] : ['--disallowedTools', CLAUDE_WRITE_TOOLS]),
      buildPrompt(step, ctx),
    ];
    return spec(ctx, argv, true);
  },

  headless(step: Step, ctx: RunCtx): SpawnSpec {
    const tools = step.writes
      ? ['--allowedTools', WRITES_ALLOWED]
      : ['--allowedTools', READONLY_ALLOWED, '--disallowedTools', CLAUDE_WRITE_TOOLS];
    const argv = ['claude', '-p', ...modelArgs(step), ...effortArgs(step), ...tools, buildPrompt(step, ctx)];
    return spec(ctx, argv, false);
  },

  harvest(step: Step, ctx: RunCtx): SpawnSpec {
    const argv = [
      'claude', '-p', '--resume', sessionId(step, ctx),
      ...modelArgs(step), '--allowedTools', 'Write', harvestPrompt(step, ctx),
    ];
    return spec(ctx, argv, false);
  },
};
```

- [ ] **Step 4: run tests, verify pass.** Export `claudeAdapter`, `CLAUDE_WRITE_TOOLS` from `index.ts`.

- [ ] **Step 5: sanity-check `detect()` against the real binary**

Run: `node -e "import('./packages/core/src/adapters/claude.ts').then(async m => console.log(await m.claudeAdapter.detect()))"`
Expected: `{ installed: true, version: '2.1.252' }` (or newer).

- [ ] **Step 6: commit**

```bash
git add -A && git commit -m "feat(core): claude adapter with session-mint interactive + resume harvest"
```

---

### Task 6: Copilot adapter

**Files:**
- Create: `packages/core/src/adapters/copilot.ts`
- Test: `packages/core/src/adapters/copilot.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: same core types; `buildPrompt` from `../template.ts`.
- Produces:
  - `export function transcriptPath(step: Step, ctx: RunCtx): string` → `` `${ctx.runDir}/${step.id}-transcript.md` ``
  - `export const copilotAdapter: RunnerAdapter` with capabilities `{ sessionIdInjection: false, sessionResume: true, toolDenial: true, shareTranscript: true }`.
- Argv contracts (tests assert exactly):
  - interactive, writes:false: `['copilot', '-i', <prompt>, '--model', <m>?, '--effort', <e>?, '--deny-tool', 'write', '--share=<transcriptPath>']` — `--share` is ALWAYS present on interactive specs (harvest depends on it).
  - headless, writes:true: `['copilot', '-p', <prompt>, '--model', <m>?, '--effort', <e>?, '--allow-all-tools', '--no-color']`
  - headless, writes:false: same plus `'--deny-tool', 'write'` before `--no-color` (copilot denial beats `--allow-all-tools`; shell-redirect writes are caught by the git guard, Task 9).
  - harvest: `['copilot', '-p', <harvest prompt>, '--allow-all-tools', '--no-color']` where the harvest prompt is:
    `Read the planning transcript at <transcriptPath> and write the final '<step.output>' artifact that was agreed in it to <absolute artifact path>. Write only the artifact content to that file, then reply with just: done`

- [ ] **Step 1: write the failing tests**

`packages/core/src/adapters/copilot.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copilotAdapter, transcriptPath } from './copilot.ts';
import type { RunCtx, Step } from '../types.ts';

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1',
  sessionIds: {}, artifacts: {}, inputs: {},
};

const planStep: Step = {
  id: 'plan', runner: 'copilot', model: 'gpt-5.5', mode: 'interactive',
  writes: false, prompt: 'Plan it.', output: 'plan.md',
};

test('transcript path convention', () => {
  assert.equal(transcriptPath(planStep, ctx), '/w/.whiphand/runs/r1/plan-transcript.md');
});

test('interactive: seeds via -i, denies write, always shares transcript', () => {
  const spec = copilotAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.argv, [
    'copilot', '-i', 'Plan it.', '--model', 'gpt-5.5',
    '--deny-tool', 'write', '--share=/w/.whiphand/runs/r1/plan-transcript.md',
  ]);
  assert.equal(spec.interactive, true);
});

test('headless writes:true requires --allow-all-tools', () => {
  const step: Step = { id: 'exec', runner: 'copilot', mode: 'headless', writes: true, prompt: 'Do.', output: 'r.md' };
  const spec = copilotAdapter.headless(step, ctx);
  assert.deepEqual(spec.argv, ['copilot', '-p', 'Do.', '--allow-all-tools', '--no-color']);
  assert.equal(spec.interactive, false);
});

test('headless writes:false adds write denial (denial beats allow-all)', () => {
  const step: Step = { id: 'rev', runner: 'copilot', mode: 'headless', writes: false, prompt: 'Review.', output: 'f.md' };
  const spec = copilotAdapter.headless(step, ctx);
  assert.deepEqual(spec.argv, ['copilot', '-p', 'Review.', '--allow-all-tools', '--deny-tool', 'write', '--no-color']);
});

test('harvest distills the shared transcript into the artifact', () => {
  const spec = copilotAdapter.harvest(planStep, ctx);
  assert.equal(spec.argv[0], 'copilot');
  assert.equal(spec.argv[1], '-p');
  const prompt = spec.argv[2];
  assert.ok(prompt.includes('/w/.whiphand/runs/r1/plan-transcript.md'));
  assert.ok(prompt.includes('/w/.whiphand/runs/r1/plan.md'));
  assert.ok(spec.argv.includes('--allow-all-tools'));
});
```

- [ ] **Step 2: run tests, verify fail.**

- [ ] **Step 3: implement `adapters/copilot.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DetectResult, RunCtx, RunnerAdapter, SpawnSpec, Step } from '../types.ts';
import { buildPrompt } from '../template.ts';

const execFileAsync = promisify(execFile);

export function transcriptPath(step: Step, ctx: RunCtx): string {
  return `${ctx.runDir}/${step.id}-transcript.md`;
}

function modelArgs(step: Step): string[] {
  return step.model ? ['--model', step.model] : [];
}
function effortArgs(step: Step): string[] {
  return step.effort ? ['--effort', step.effort] : [];
}
function spec(ctx: RunCtx, argv: string[], interactive: boolean): SpawnSpec {
  return { argv, cwd: ctx.workdir, env: {}, interactive };
}

export const copilotAdapter: RunnerAdapter = {
  id: 'copilot',
  // --session-id RESUMES on copilot; it cannot mint. Interactive harvest goes via --share.
  capabilities: { sessionIdInjection: false, sessionResume: true, toolDenial: true, shareTranscript: true },

  async detect(): Promise<DetectResult> {
    try {
      const { stdout } = await execFileAsync('copilot', ['--version']);
      return { installed: true, version: stdout.match(/(\d+\.\d+\.\d+)/)?.[1] };
    } catch {
      return { installed: false };
    }
  },

  interactive(step: Step, ctx: RunCtx): SpawnSpec {
    const argv = [
      'copilot', '-i', buildPrompt(step, ctx),
      ...modelArgs(step), ...effortArgs(step),
      ...(step.writes ? [] : ['--deny-tool', 'write']),
      `--share=${transcriptPath(step, ctx)}`,
    ];
    return spec(ctx, argv, true);
  },

  headless(step: Step, ctx: RunCtx): SpawnSpec {
    const argv = [
      'copilot', '-p', buildPrompt(step, ctx),
      ...modelArgs(step), ...effortArgs(step),
      '--allow-all-tools',
      ...(step.writes ? [] : ['--deny-tool', 'write']),
      '--no-color',
    ];
    return spec(ctx, argv, false);
  },

  harvest(step: Step, ctx: RunCtx): SpawnSpec {
    const prompt =
      `Read the planning transcript at ${transcriptPath(step, ctx)} and write the final ` +
      `'${step.output}' artifact that was agreed in it to ${ctx.runDir}/${step.output}. ` +
      `Write only the artifact content to that file, then reply with just: done`;
    return spec(ctx, ['copilot', '-p', prompt, '--allow-all-tools', '--no-color'], false);
  },
};
```

- [ ] **Step 4: run tests, verify pass.** Export `copilotAdapter`, `transcriptPath` from `index.ts`.

- [ ] **Step 5: sanity-check `detect()`** — same pattern as Task 5 Step 5; expected `{ installed: true, version: '1.0.60' }` (or newer).

- [ ] **Step 6: commit**

```bash
git add -A && git commit -m "feat(core): copilot adapter with share-transcript interactive harvest"
```

---

### Task 7: Workspace config loader

**Files:**
- Create: `packages/core/src/config.ts`
- Test: `packages/core/src/config.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `WorkspaceConfig`, `OnFindings` from `./types.ts`.
- Produces: `loadWorkspaceConfig(workdir: string): Promise<WorkspaceConfig>` — reads `<workdir>/.whiphand/config.yaml`; a missing file returns pure defaults; a present file is validated (Zod) and deep-merged over defaults; invalid content throws `WorkflowError` (reused from `schema.ts`).
- Defaults (exact): `{ defaults: { runner: 'claude' }, on_findings: 'report', loop: { max_iterations: 3 }, artifacts_dir: '.whiphand/runs' }`

- [ ] **Step 1: write the failing tests**

`packages/core/src/config.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceConfig } from './config.ts';
import { WorkflowError } from './schema.ts';

test('missing config yields defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
  const cfg = await loadWorkspaceConfig(dir);
  assert.deepEqual(cfg, {
    defaults: { runner: 'claude' },
    on_findings: 'report',
    loop: { max_iterations: 3 },
    artifacts_dir: '.whiphand/runs',
  });
});

test('partial config merges over defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
  await mkdir(join(dir, '.whiphand'));
  await writeFile(join(dir, '.whiphand', 'config.yaml'), 'on_findings: loop\nloop: { max_iterations: 5 }\n');
  const cfg = await loadWorkspaceConfig(dir);
  assert.equal(cfg.on_findings, 'loop');
  assert.equal(cfg.loop.max_iterations, 5);
  assert.equal(cfg.defaults.runner, 'claude');
});

test('invalid config throws WorkflowError', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
  await mkdir(join(dir, '.whiphand'));
  await writeFile(join(dir, '.whiphand', 'config.yaml'), 'on_findings: explode\n');
  await assert.rejects(loadWorkspaceConfig(dir), WorkflowError);
});
```

- [ ] **Step 2: run tests, verify fail.**

- [ ] **Step 3: implement `config.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { WorkspaceConfig } from './types.ts';
import { WorkflowError } from './schema.ts';

const configSchema = z.object({
  defaults: z.object({ runner: z.string().min(1) }).partial().optional(),
  on_findings: z.enum(['report', 'loop', 'interactive']).optional(),
  loop: z.object({ max_iterations: z.number().int().positive() }).partial().optional(),
  artifacts_dir: z.string().min(1).optional(),
});

export const DEFAULT_CONFIG: WorkspaceConfig = {
  defaults: { runner: 'claude' },
  on_findings: 'report',
  loop: { max_iterations: 3 },
  artifacts_dir: '.whiphand/runs',
};

export async function loadWorkspaceConfig(workdir: string): Promise<WorkspaceConfig> {
  let text: string;
  try {
    text = await readFile(join(workdir, '.whiphand', 'config.yaml'), 'utf8');
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
  const parsed = configSchema.safeParse(parseYaml(text));
  if (!parsed.success) {
    throw new WorkflowError(parsed.error.issues.map(i => `config: ${i.path.join('.')}: ${i.message}`));
  }
  const c = parsed.data;
  return {
    defaults: { runner: c.defaults?.runner ?? DEFAULT_CONFIG.defaults.runner },
    on_findings: c.on_findings ?? DEFAULT_CONFIG.on_findings,
    loop: { max_iterations: c.loop?.max_iterations ?? DEFAULT_CONFIG.loop.max_iterations },
    artifacts_dir: c.artifacts_dir ?? DEFAULT_CONFIG.artifacts_dir,
  };
}
```

- [ ] **Step 4: run tests, verify pass.** Export `loadWorkspaceConfig`, `DEFAULT_CONFIG` from `index.ts`.

- [ ] **Step 5: commit**

```bash
git add -A && git commit -m "feat(core): workspace config loader with defaults"
```

---

### Task 8: Artifact store

**Files:**
- Create: `packages/core/src/engine/artifacts.ts`
- Test: `packages/core/src/engine/artifacts.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Step` from `../types.ts`.
- Produces:
  - `createRunDir(workdir: string, artifactsDir: string): Promise<{ runId: string; runDir: string }>` — `runId` = `YYYYMMDD-HHmmss-<4 hex chars>` (sortable, collision-resistant); creates `<workdir>/<artifactsDir>/<runId>` recursively; `runDir` is absolute.
  - `artifactPath(runDir: string, step: Step): string` — `join(runDir, step.output)`.
  - `assertArtifact(path: string): Promise<void>` — throws `ArtifactError extends Error` if the file is missing or its trimmed content is empty. The error message must contain the path.

- [ ] **Step 1: write the failing tests**

`packages/core/src/engine/artifacts.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunDir, artifactPath, assertArtifact, ArtifactError } from './artifacts.ts';
import type { Step } from '../types.ts';

test('createRunDir creates a unique absolute run dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
  const a = await createRunDir(dir, '.whiphand/runs');
  const b = await createRunDir(dir, '.whiphand/runs');
  assert.notEqual(a.runId, b.runId);
  assert.ok(a.runDir.startsWith(dir));
  assert.ok((await stat(a.runDir)).isDirectory());
  assert.match(a.runId, /^\d{8}-\d{6}-[0-9a-f]{4}$/);
});

test('artifactPath joins run dir and output name', () => {
  const step: Step = { id: 'p', runner: 'claude', mode: 'headless', writes: false, prompt: 'x', output: 'plan.md' };
  assert.equal(artifactPath('/r', step), '/r/plan.md');
});

test('assertArtifact accepts non-empty, rejects missing and empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
  const good = join(dir, 'good.md');
  await writeFile(good, '# plan\n');
  await assertArtifact(good); // no throw
  await assert.rejects(assertArtifact(join(dir, 'missing.md')), ArtifactError);
  const empty = join(dir, 'empty.md');
  await writeFile(empty, '  \n');
  await assert.rejects(assertArtifact(empty), (e: unknown) =>
    e instanceof ArtifactError && e.message.includes(empty));
});
```

- [ ] **Step 2: run tests, verify fail.**

- [ ] **Step 3: implement `engine/artifacts.ts`**

```ts
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Step } from '../types.ts';

export class ArtifactError extends Error {
  constructor(message: string) { super(message); this.name = 'ArtifactError'; }
}

export async function createRunDir(
  workdir: string, artifactsDir: string,
): Promise<{ runId: string; runDir: string }> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const runId = `${stamp}-${randomBytes(2).toString('hex')}`;
  const runDir = resolve(workdir, artifactsDir, runId);
  await mkdir(runDir, { recursive: true });
  return { runId, runDir };
}

export function artifactPath(runDir: string, step: Step): string {
  return join(runDir, step.output);
}

export async function assertArtifact(path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ArtifactError(`expected artifact was not written: ${path}`);
  }
  if (text.trim().length === 0) throw new ArtifactError(`artifact is empty: ${path}`);
}
```

- [ ] **Step 4: run tests, verify pass.** Export the three functions and `ArtifactError` from `index.ts`.

- [ ] **Step 5: commit**

```bash
git add -A && git commit -m "feat(core): run-scoped artifact store with loud missing/empty assertions"
```

---

### Task 9: Git guard (read-only tree assertion)

**Files:**
- Create: `packages/core/src/engine/git-guard.ts`
- Test: `packages/core/src/engine/git-guard.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing from core (self-contained over `git`).
- Produces:
  - `snapshotTree(workdir: string): Promise<string | null>` — `null` when `workdir` is not inside a git work tree (guard disabled); otherwise the sorted output of `git status --porcelain=v1 --untracked-files=all`.
  - `diffSnapshots(before: string, after: string): string[]` — paths that appear in `after` but not in `before` (or whose status changed), **excluding** any path containing `.whiphand/`. Empty array = tree unchanged.

- [ ] **Step 1: write the failing tests**

`packages/core/src/engine/git-guard.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { snapshotTree, diffSnapshots } from './git-guard.ts';

const run = promisify(execFile);

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-git-'));
  await run('git', ['init', '-b', 'main'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'hello\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: dir });
  return dir;
}

test('non-repo returns null (guard disabled)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-plain-'));
  assert.equal(await snapshotTree(dir), null);
});

test('unchanged tree diffs empty', async () => {
  const dir = await gitRepo();
  const before = await snapshotTree(dir);
  const after = await snapshotTree(dir);
  assert.notEqual(before, null);
  assert.deepEqual(diffSnapshots(before!, after!), []);
});

test('detects modified and new files', async () => {
  const dir = await gitRepo();
  const before = await snapshotTree(dir);
  await writeFile(join(dir, 'a.txt'), 'changed\n');
  await writeFile(join(dir, 'new.txt'), 'new\n');
  const after = await snapshotTree(dir);
  const changed = diffSnapshots(before!, after!);
  assert.ok(changed.some(p => p.includes('a.txt')));
  assert.ok(changed.some(p => p.includes('new.txt')));
});

test('ignores changes under .whiphand/', async () => {
  const dir = await gitRepo();
  const before = await snapshotTree(dir);
  await mkdir(join(dir, '.whiphand', 'runs', 'r1'), { recursive: true });
  await writeFile(join(dir, '.whiphand', 'runs', 'r1', 'plan.md'), 'plan\n');
  const after = await snapshotTree(dir);
  assert.deepEqual(diffSnapshots(before!, after!), []);
});
```

- [ ] **Step 2: run tests, verify fail.**

- [ ] **Step 3: implement `engine/git-guard.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function snapshotTree(workdir: string): Promise<string | null> {
  try {
    const { stdout } = await run(
      'git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: workdir });
    return stdout.split('\n').filter(Boolean).sort().join('\n');
  } catch {
    return null; // not a git repo (or git missing): guard disabled
  }
}

export function diffSnapshots(before: string, after: string): string[] {
  const beforeSet = new Set(before.split('\n').filter(Boolean));
  return after
    .split('\n')
    .filter(Boolean)
    .filter(line => !beforeSet.has(line))
    .filter(line => !line.includes('.whiphand/'));
}
```

- [ ] **Step 4: run tests, verify pass.** Export both functions from `index.ts`.

- [ ] **Step 5: commit**

```bash
git add -A && git commit -m "feat(core): git working-tree guard for read-only steps"
```

---

### Task 10: Run engine — dry-run, headless execution, verdicts, report mode

**Files:**
- Create: `packages/core/src/engine/verdict.ts`
- Create: `packages/core/src/engine/runner.ts`
- Test: `packages/core/src/engine/verdict.test.ts`, `packages/core/src/engine/runner.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9 (exact names as defined there).
- Produces:
  - `parseVerdict(text: string): 'pass' | 'fail' | null` — first line matching `/^VERDICT:\s*(PASS|FAIL)\b/i`; `null` when absent.
  - `VERDICT_INSTRUCTION` (string constant): `The very first line of the artifact MUST be exactly 'VERDICT: PASS' or 'VERDICT: FAIL'.` — the engine appends it to the prompt of any `verdict: true` step.
  - ```ts
    export interface RunOptions {
      workflow: Workflow;
      workdir: string;
      inputs: Record<string, string>;
      config: WorkspaceConfig;
      registry: AdapterRegistry;
      frontend: Frontend;
      dryRun?: boolean;
      spawnHeadless?: (spec: SpawnSpec) => Promise<number>;  // injectable; REQUIRED when not dryRun
    }
    export interface RunResult {
      ok: boolean;
      runId: string;
      runDir: string;
      artifacts: Record<string, string>;
      verdict?: 'pass' | 'fail';
    }
    export function runWorkflow(opts: RunOptions): Promise<RunResult>;
    ```
- Engine behavior in this task (interactive steps come in Task 12; loop/interactive findings in Task 13):
  1. Validate: `validateWorkflowRunners`; missing required workflow inputs → throw `WorkflowError`.
  2. `createRunDir`; build `RunCtx`; for each step with `mode: 'interactive'` on an adapter with `sessionIdInjection`, mint `ctx.sessionIds[step.id] = crypto.randomUUID()` up front.
  3. Emit `run:start`. For each step in order: record `ctx.artifacts[step.id] = artifactPath(runDir, step)` **before** building specs (so `buildPrompt` in later steps can reference it); for `verdict: true` steps, append `\n\n${VERDICT_INSTRUCTION}` to the prompt (do this by wrapping the step object passed to the adapter: `{ ...step, prompt: step.prompt + ... }`); emit `step:start`.
  4. `dryRun`: emit `step:spawn` (phase `main`) with the resolved spec — plus phase `harvest` for interactive steps — then `step:done` with exitCode 0. Never spawn, never assert artifacts.
  5. Real headless run: snapshot tree if `!step.writes` (a `null` snapshot emits `guard:warning` once per run); `spawnHeadless(spec)`; non-zero exit → `run:error` + result `ok: false` (stop the run); re-snapshot and `diffSnapshots` → any changes → `run:error` naming the paths, `ok: false`; `assertArtifact`; emit `step:artifact`.
  6. `verdict: true` step: read artifact, `parseVerdict`; `null` → `run:error` (`ok: false`); otherwise emit `step:verdict`. On `fail` with `on_findings: 'report'` (workflow override, else config): emit `run:done` with `ok: false`, return `verdict: 'fail'`. On `pass`: continue.
  7. Emit `run:done`; `ok` true only if all steps completed and no verdict failed.
  8. Interactive steps in a non-dry run: **in this task**, throw `new Error('interactive steps not yet supported')` — Task 12 replaces this.

- [ ] **Step 1: write the failing verdict tests**

`packages/core/src/engine/verdict.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from './verdict.ts';

test('parses pass and fail, case-insensitive, first line only', () => {
  assert.equal(parseVerdict('VERDICT: PASS\nall good'), 'pass');
  assert.equal(parseVerdict('verdict: fail\nproblems'), 'fail');
  assert.equal(parseVerdict('summary\nVERDICT: FAIL'), null);
  assert.equal(parseVerdict('no verdict here'), null);
});
```

- [ ] **Step 2: implement `engine/verdict.ts`, run tests, verify pass**

```ts
export const VERDICT_INSTRUCTION =
  "The very first line of the artifact MUST be exactly 'VERDICT: PASS' or 'VERDICT: FAIL'.";

export function parseVerdict(text: string): 'pass' | 'fail' | null {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const m = firstLine.match(/^VERDICT:\s*(PASS|FAIL)\b/i);
  return m ? (m[1].toLowerCase() as 'pass' | 'fail') : null;
}
```

- [ ] **Step 3: write the failing runner tests**

`packages/core/src/engine/runner.test.ts` — uses a fake adapter whose "headless spawn" writes the artifact file itself, so no real CLI is touched:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from './runner.ts';
import { AdapterRegistry } from '../registry.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import type { Frontend, WhiphandEvent, Workflow, RunnerAdapter, SpawnSpec, Step, RunCtx } from '../types.ts';

function fakeRunner(): RunnerAdapter {
  return {
    id: 'fake',
    capabilities: { sessionIdInjection: true, sessionResume: true, toolDenial: true, shareTranscript: false },
    detect: async () => ({ installed: true }),
    interactive(step: Step, ctx: RunCtx): SpawnSpec {
      return { argv: ['fake', 'interactive', step.id], cwd: ctx.workdir, env: {}, interactive: true };
    },
    headless(step: Step, ctx: RunCtx): SpawnSpec {
      // encode target artifact + prompt so the fake spawn can act on it
      return {
        argv: ['fake', 'headless', step.id, `${ctx.runDir}/${step.output}`, step.prompt],
        cwd: ctx.workdir, env: {}, interactive: false,
      };
    },
    harvest(step: Step, ctx: RunCtx): SpawnSpec {
      return { argv: ['fake', 'harvest', step.id, `${ctx.runDir}/${step.output}`], cwd: ctx.workdir, env: {}, interactive: false };
    },
  };
}

function collector(): { events: WhiphandEvent[]; frontend: Frontend } {
  const events: WhiphandEvent[] = [];
  return {
    events,
    frontend: { runInteractive: async () => 0, onEvent: e => events.push(e) },
  };
}

const twoStep: Workflow = {
  name: 'r',
  steps: [
    { id: 'a', runner: 'fake', mode: 'headless', writes: false, prompt: 'first', output: 'a.md' },
    { id: 'b', runner: 'fake', mode: 'headless', writes: true, prompt: 'second', inputs: ['a'], output: 'b.md' },
  ],
};

function registry(): AdapterRegistry {
  const reg = new AdapterRegistry();
  reg.register(fakeRunner());
  return reg;
}

test('dry-run emits spawn specs and spawns nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend, dryRun: true,
  });
  assert.equal(result.ok, true);
  const spawns = events.filter(e => e.type === 'step:spawn');
  assert.equal(spawns.length, 2);
  assert.equal(events.filter(e => e.type === 'run:done').length, 1);
});

test('headless run writes artifacts via injected spawn and succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async spec => { await writeFile(spec.argv[3], `# out for ${spec.argv[2]}\n`); return 0; },
  });
  assert.equal(result.ok, true);
  assert.ok((await readFile(result.artifacts['a'], 'utf8')).includes('out for a'));
  assert.ok(events.some(e => e.type === 'step:artifact'));
});

test('missing artifact fails the run loudly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { events, frontend } = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async () => 0, // exits fine but writes nothing
  });
  assert.equal(result.ok, false);
  assert.ok(events.some(e => e.type === 'run:error' && e.message.includes('a.md')));
});

test('non-zero exit stops the run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const { frontend } = collector();
  const result = await runWorkflow({
    workflow: twoStep, workdir: dir, inputs: {}, config: DEFAULT_CONFIG,
    registry: registry(), frontend,
    spawnHeadless: async () => 1,
  });
  assert.equal(result.ok, false);
});

test('verdict fail with report mode ends run not-ok; pass continues', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [
      { id: 'work', runner: 'fake', mode: 'headless', writes: true, prompt: 'w', output: 'w.md' },
      { id: 'review', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'r', output: 'f.md' },
    ],
  };
  const { frontend } = collector();
  const failing = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const content = spec.argv[2] === 'review' ? 'VERDICT: FAIL\nbad' : 'did work';
      await writeFile(spec.argv[3], content); return 0;
    },
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.verdict, 'fail');

  const passing = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const content = spec.argv[2] === 'review' ? 'VERDICT: PASS\nok' : 'did work';
      await writeFile(spec.argv[3], content); return 0;
    },
  });
  assert.equal(passing.ok, true);
  assert.equal(passing.verdict, 'pass');
});

test('verdict step prompt gets the instruction appended', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [{ id: 'rev', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'r', output: 'f.md' }],
  };
  const { frontend } = collector();
  let seenPrompt = '';
  await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      seenPrompt = spec.argv[4];
      await writeFile(spec.argv[3], 'VERDICT: PASS\n'); return 0;
    },
  });
  assert.ok(seenPrompt.includes('VERDICT: PASS'));
});

test('missing required input throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = { ...twoStep, inputs: { feature: { required: true } } };
  const { frontend } = collector();
  await assert.rejects(runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend, dryRun: true,
  }), /feature/);
});
```

- [ ] **Step 4: run tests, verify fail.**

- [ ] **Step 5: implement `engine/runner.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  Frontend, WhiphandEvent, OnFindings, Workflow, RunCtx, RunnerAdapter, SpawnSpec, Step, WorkspaceConfig,
} from '../types.ts';
import { AdapterRegistry, validateWorkflowRunners } from '../registry.ts';
import { WorkflowError } from '../schema.ts';
import { createRunDir, artifactPath, assertArtifact } from './artifacts.ts';
import { snapshotTree, diffSnapshots } from './git-guard.ts';
import { parseVerdict, VERDICT_INSTRUCTION } from './verdict.ts';

export interface RunOptions {
  workflow: Workflow;
  workdir: string;
  inputs: Record<string, string>;
  config: WorkspaceConfig;
  registry: AdapterRegistry;
  frontend: Frontend;
  dryRun?: boolean;
  spawnHeadless?: (spec: SpawnSpec) => Promise<number>;
}

export interface RunResult {
  ok: boolean;
  runId: string;
  runDir: string;
  artifacts: Record<string, string>;
  verdict?: 'pass' | 'fail';
}

function resolveInputs(workflow: Workflow, given: Record<string, string>): Record<string, string> {
  const problems: string[] = [];
  const resolved: Record<string, string> = { ...given };
  for (const [key, def] of Object.entries(workflow.inputs ?? {})) {
    if (resolved[key] === undefined && def.default !== undefined) resolved[key] = def.default;
    if (resolved[key] === undefined && def.required) problems.push(`missing required input '${key}'`);
  }
  if (problems.length > 0) throw new WorkflowError(problems);
  return resolved;
}

/** Steps passed to adapters get the verdict instruction appended when needed. */
function effectiveStep(step: Step): Step {
  if (!step.verdict) return step;
  return { ...step, prompt: `${step.prompt}\n\n${VERDICT_INSTRUCTION}` };
}

export async function runWorkflow(opts: RunOptions): Promise<RunResult> {
  const { workflow, config, registry, frontend } = opts;
  const emit = (e: WhiphandEvent) => frontend.onEvent(e);

  const problems = validateWorkflowRunners(workflow, registry);
  if (problems.length > 0) throw new WorkflowError(problems);
  const inputs = resolveInputs(workflow, opts.inputs);

  const workdir = resolve(opts.workdir);
  const { runId, runDir } = await createRunDir(workdir, config.artifacts_dir);
  const ctx: RunCtx = { workdir, runId, runDir, sessionIds: {}, artifacts: {}, inputs };

  for (const step of workflow.steps) {
    const adapter = registry.get(step.runner);
    if (step.mode === 'interactive' && adapter.capabilities.sessionIdInjection) {
      ctx.sessionIds[step.id] = randomUUID();
    }
  }

  emit({ type: 'run:start', runId, workflow: workflow.name });
  const onFindings: OnFindings = workflow.on_findings ?? config.on_findings;
  let warnedNoGit = false;
  const fail = (message: string, stepId?: string): RunResult => {
    emit({ type: 'run:error', stepId, message });
    emit({ type: 'run:done', runId, ok: false });
    return { ok: false, runId, runDir, artifacts: ctx.artifacts };
  };

  let verdict: 'pass' | 'fail' | undefined;

  for (const step of workflow.steps) {
    const adapter = registry.get(step.runner);
    ctx.artifacts[step.id] = artifactPath(runDir, step);
    const eff = effectiveStep(step);
    emit({ type: 'step:start', stepId: step.id, runner: step.runner, model: step.model, mode: step.mode });

    if (opts.dryRun) {
      const main = step.mode === 'interactive' ? adapter.interactive(eff, ctx) : adapter.headless(eff, ctx);
      emit({ type: 'step:spawn', stepId: step.id, spec: main, phase: 'main' });
      if (step.mode === 'interactive') {
        emit({ type: 'step:spawn', stepId: step.id, spec: adapter.harvest(eff, ctx), phase: 'harvest' });
      }
      emit({ type: 'step:done', stepId: step.id, exitCode: 0 });
      continue;
    }

    if (step.mode === 'interactive') {
      throw new Error('interactive steps not yet supported'); // replaced in Task 12
    }
    const spawnHeadless = opts.spawnHeadless;
    if (!spawnHeadless) throw new Error('spawnHeadless is required for non-dry runs');

    let before: string | null = null;
    if (!step.writes) {
      before = await snapshotTree(workdir);
      if (before === null && !warnedNoGit) {
        warnedNoGit = true;
        emit({ type: 'guard:warning', message: 'not a git repository: read-only tree assertion disabled' });
      }
    }

    const spec = adapter.headless(eff, ctx);
    emit({ type: 'step:spawn', stepId: step.id, spec, phase: 'main' });
    const exitCode = await spawnHeadless(spec);
    emit({ type: 'step:done', stepId: step.id, exitCode });
    if (exitCode !== 0) return fail(`step '${step.id}' exited with code ${exitCode}`, step.id);

    if (before !== null) {
      const after = await snapshotTree(workdir);
      const changed = diffSnapshots(before, after ?? '');
      if (changed.length > 0) {
        return fail(`read-only step '${step.id}' modified the tree: ${changed.join(', ')}`, step.id);
      }
    }

    try {
      await assertArtifact(ctx.artifacts[step.id]);
    } catch (e) {
      return fail((e as Error).message, step.id);
    }
    emit({ type: 'step:artifact', stepId: step.id, path: ctx.artifacts[step.id] });

    if (step.verdict) {
      const text = await readFile(ctx.artifacts[step.id], 'utf8');
      const v = parseVerdict(text);
      if (v === null) return fail(`step '${step.id}' artifact is missing a VERDICT line`, step.id);
      verdict = v;
      emit({ type: 'step:verdict', stepId: step.id, verdict: v });
      if (v === 'fail' && onFindings === 'report') {
        emit({ type: 'run:done', runId, ok: false });
        return { ok: false, runId, runDir, artifacts: ctx.artifacts, verdict: v };
      }
      // 'loop' and 'interactive' findings modes land in Task 13.
    }
  }

  const ok = verdict !== 'fail';
  emit({ type: 'run:done', runId, ok });
  return { ok, runId, runDir, artifacts: ctx.artifacts, verdict };
}
```

- [ ] **Step 6: run tests, verify pass. Typecheck.** Export `runWorkflow`, `RunOptions`, `RunResult`, `parseVerdict`, `VERDICT_INSTRUCTION` from `index.ts`.

- [ ] **Step 7: commit**

```bash
git add -A && git commit -m "feat(core): run engine with dry-run, headless execution, verdicts, report mode"
```

---

### Task 11: CLI — doctor, run, dry-run, real spawns

**Files:**
- Create: `packages/cli/src/tty.ts`
- Create: `packages/cli/src/commands/doctor.ts`
- Create: `packages/cli/src/commands/run.ts`
- Modify: `packages/cli/src/main.ts`
- Create: `examples/feature.yaml`
- Test: `packages/cli/src/commands/doctor.test.ts`, `packages/cli/src/tty.test.ts`

**Interfaces:**
- Consumes: `@whiphand/core` public API (`parseWorkflow`, `AdapterRegistry`, `claudeAdapter`, `copilotAdapter`, `loadWorkspaceConfig`, `runWorkflow`, `WhiphandEvent`, `SpawnSpec`, `Frontend`).
- Produces:
  - `tty.ts`: `spawnInteractive(spec: SpawnSpec): Promise<number>` (spawns `spec.argv` with `stdio: 'inherit'`, env `{...process.env, ...spec.env}`, cwd `spec.cwd`; resolves with exit code) and `spawnHeadless(spec: SpawnSpec): Promise<number>` (same but `stdio: ['ignore', 'inherit', 'inherit']` so step output streams to the terminal).
  - `doctor.ts`: `doctorReport(registry: AdapterRegistry): Promise<string>` — one line per adapter: `✔ claude 2.1.252` / `✘ codex not installed`.
  - `run.ts`: `runCommand(workflowRef: string, opts: { dryRun: boolean; input: string[]; cwd: string }): Promise<number>` — resolves `workflowRef` as a path if it exists, else `<cwd>/.whiphand/workflows/<workflowRef>.yaml`; parses `--input key=value` pairs; renders events as single lines (`→ step plan (claude/opus, interactive)`, dry-run spawns as `$ claude --session-id …`); returns process exit code (0 ok / 1 failure).
- `main.ts` wires commander: `whiphand doctor`, `whiphand run <workflow> [--dry-run] [--input <k=v>...] [-C <dir>]`.

- [ ] **Step 1: write the failing tests**

`packages/cli/src/tty.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnHeadless } from './tty.ts';

test('spawnHeadless returns the child exit code', async () => {
  const ok = await spawnHeadless({ argv: ['true'], cwd: process.cwd(), env: {}, interactive: false });
  assert.equal(ok, 0);
  const bad = await spawnHeadless({ argv: ['false'], cwd: process.cwd(), env: {}, interactive: false });
  assert.equal(bad, 1);
});
```

`packages/cli/src/commands/doctor.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry } from '@whiphand/core';
import type { RunnerAdapter } from '@whiphand/core';
import { doctorReport } from './doctor.ts';

function stub(id: string, installed: boolean, version?: string): RunnerAdapter {
  return {
    id,
    capabilities: { sessionIdInjection: false, sessionResume: false, toolDenial: false, shareTranscript: false },
    detect: async () => ({ installed, version }),
    interactive: () => { throw new Error('unused'); },
    headless: () => { throw new Error('unused'); },
    harvest: () => { throw new Error('unused'); },
  };
}

test('reports installed and missing runners', async () => {
  const reg = new AdapterRegistry();
  reg.register(stub('claude', true, '2.1.252'));
  reg.register(stub('ghost', false));
  const report = await doctorReport(reg);
  assert.ok(report.includes('claude 2.1.252'));
  assert.ok(report.includes('ghost'));
  assert.ok(report.includes('not installed'));
});
```

- [ ] **Step 2: run tests, verify fail.**

- [ ] **Step 3: implement `tty.ts`**

```ts
import { spawn } from 'node:child_process';
import type { SpawnSpec } from '@whiphand/core';

function doSpawn(spec: SpawnSpec, stdio: 'inherit' | ('ignore' | 'inherit')[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const [cmd, ...args] = spec.argv;
    const child = spawn(cmd, args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio,
    });
    child.on('error', reject);
    child.on('exit', code => resolvePromise(code ?? 1));
  });
}

export function spawnInteractive(spec: SpawnSpec): Promise<number> {
  return doSpawn(spec, 'inherit');
}

export function spawnHeadless(spec: SpawnSpec): Promise<number> {
  return doSpawn(spec, ['ignore', 'inherit', 'inherit']);
}
```

- [ ] **Step 4: implement `commands/doctor.ts`**

```ts
import type { AdapterRegistry } from '@whiphand/core';

export async function doctorReport(registry: AdapterRegistry): Promise<string> {
  const lines = await Promise.all(registry.list().map(async adapter => {
    const result = await adapter.detect();
    return result.installed
      ? `✔ ${adapter.id} ${result.version ?? '(version unknown)'}`
      : `✘ ${adapter.id} not installed`;
  }));
  return lines.join('\n');
}
```

- [ ] **Step 5: implement `commands/run.ts`**

```ts
import { readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  AdapterRegistry, claudeAdapter, copilotAdapter,
  loadWorkspaceConfig, parseWorkflow, runWorkflow,
} from '@whiphand/core';
import type { Frontend, WhiphandEvent } from '@whiphand/core';
import { spawnHeadless, spawnInteractive } from '../tty.ts';

export function defaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(claudeAdapter);
  registry.register(copilotAdapter);
  return registry;
}

function parseInputPairs(pairs: string[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new Error(`--input expects key=value, got '${pair}'`);
    inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return inputs;
}

async function resolveWorkflowPath(workflowRef: string, cwd: string): Promise<string> {
  const asPath = resolve(cwd, workflowRef);
  try { await access(asPath); return asPath; } catch { /* fall through */ }
  return join(cwd, '.whiphand', 'workflows', `${workflowRef}.yaml`);
}

function renderEvent(event: WhiphandEvent): void {
  switch (event.type) {
    case 'run:start': return console.log(`whiphand run ${event.runId} — workflow '${event.workflow}'`);
    case 'step:start': return console.log(
      `→ step ${event.stepId} (${event.runner}${event.model ? '/' + event.model : ''}, ${event.mode})`);
    case 'step:spawn': return console.log(`  $ ${event.spec.argv.map(a => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
    case 'step:artifact': return console.log(`  ✔ artifact ${event.path}`);
    case 'step:verdict': return console.log(`  verdict: ${event.verdict.toUpperCase()}`);
    case 'step:done': return;
    case 'guard:warning': return console.warn(`  ⚠ ${event.message}`);
    case 'run:error': return console.error(`✘ ${event.message}`);
    case 'run:done': return console.log(event.ok ? '✔ run complete' : '✘ run failed');
  }
}

export async function runCommand(
  workflowRef: string,
  opts: { dryRun: boolean; input: string[]; cwd: string },
): Promise<number> {
  const workdir = resolve(opts.cwd);
  const workflowPath = await resolveWorkflowPath(workflowRef, workdir);
  const workflow = parseWorkflow(await readFile(workflowPath, 'utf8'));
  const config = await loadWorkspaceConfig(workdir);
  const frontend: Frontend = { runInteractive: spawnInteractive, onEvent: renderEvent };
  const result = await runWorkflow({
    workflow, workdir, inputs: parseInputPairs(opts.input), config,
    registry: defaultRegistry(), frontend,
    dryRun: opts.dryRun, spawnHeadless,
  });
  return result.ok ? 0 : 1;
}
```

- [ ] **Step 6: rewrite `main.ts`**

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { CORE_VERSION } from '@whiphand/core';
import { doctorReport } from './commands/doctor.ts';
import { defaultRegistry, runCommand } from './commands/run.ts';

const program = new Command();
program.name('whiphand').description('workflow runner for LLM CLIs').version(CORE_VERSION);

program.command('doctor').description('detect installed runners').action(async () => {
  console.log(await doctorReport(defaultRegistry()));
});

program.command('run')
  .description('run a workflow')
  .argument('<workflow>', 'workflow name (in .whiphand/workflows/) or path to a YAML file')
  .option('--dry-run', 'resolve and print every step argv without spawning', false)
  .option('--input <pair...>', 'workflow input as key=value', [] as string[])
  .option('-C <dir>', 'working folder', process.cwd())
  .action(async (workflowRef: string, opts: { dryRun: boolean; input: string[]; C: string }) => {
    process.exitCode = await runCommand(workflowRef, { dryRun: opts.dryRun, input: opts.input, cwd: opts.C });
  });

await program.parseAsync();
```

- [ ] **Step 7: create `examples/feature.yaml`** — copy the workflow verbatim from `docs/design.md` §"Workflow format".

- [ ] **Step 8: run tests + manual verification**

```bash
npm test && npm run typecheck
node packages/cli/src/main.ts doctor
# expect: ✔ claude 2.1.252 / ✔ copilot 1.0.60
node packages/cli/src/main.ts run examples/feature.yaml --dry-run --input feature=demo
# expect: three steps printed with full argv, harvest spec for the plan step, "✔ run complete", exit 0
```

- [ ] **Step 9: commit**

```bash
git add -A && git commit -m "feat(cli): whiphand doctor and whiphand run with dry-run and real spawns"
```

---

### Task 12: Interactive handoff in the engine

**Files:**
- Modify: `packages/core/src/engine/runner.ts` (replace the `interactive steps not yet supported` throw)
- Test: extend `packages/core/src/engine/runner.test.ts`

**Interfaces:**
- Consumes: `Frontend.runInteractive` (already wired from Task 10/11).
- Produces: engine behavior for `mode: 'interactive'` in a non-dry run:
  1. Snapshot tree when `!step.writes` (same as headless).
  2. `const spec = adapter.interactive(eff, ctx)`; emit `step:spawn` (`main`); `await frontend.runInteractive(spec)`; non-zero exit → run fails.
  3. `const hSpec = adapter.harvest(eff, ctx)`; emit `step:spawn` (`harvest`); `await spawnHeadless(hSpec)`; non-zero exit → run fails.
  4. Git-guard check, `assertArtifact`, `step:artifact`, verdict handling — identical to the headless path (share the code; do not duplicate it: extract the post-spawn tail of the headless branch into a local `async function finishStep(step, eff): Promise<RunResult | null>` returning `null` to continue or a failure result).

- [ ] **Step 1: write the failing tests** (append to `runner.test.ts`)

```ts
test('interactive step: main spawn via frontend, then harvest, then artifact assertion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [{ id: 'plan', runner: 'fake', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' }],
  };
  const { events } = collector();
  const order: string[] = [];
  const frontend: Frontend = {
    runInteractive: async spec => { order.push(`interactive:${spec.argv[2]}`); return 0; },
    onEvent: e => events.push(e),
  };
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      order.push(`headless:${spec.argv[1]}:${spec.argv[2]}`);
      if (spec.argv[1] === 'harvest') await writeFile(spec.argv[3], '# the plan\n');
      return 0;
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['interactive:plan', 'headless:harvest:plan']);
  const spawns = events.filter(e => e.type === 'step:spawn');
  assert.deepEqual(spawns.map(s => s.type === 'step:spawn' && s.phase), ['main', 'harvest']);
  assert.ok(result.artifacts['plan'].endsWith('plan.md'));
});

test('interactive step fails the run when harvest writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [{ id: 'plan', runner: 'fake', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' }],
  };
  const { events, frontend } = collector();
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async () => 0,
  });
  assert.equal(result.ok, false);
  assert.ok(events.some(e => e.type === 'run:error' && e.message.includes('plan.md')));
});

test('interactive step fails when the user session exits non-zero', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    steps: [{ id: 'plan', runner: 'fake', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' }],
  };
  const { events } = collector();
  const frontend: Frontend = { runInteractive: async () => 130, onEvent: e => events.push(e) };
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async () => 0,
  });
  assert.equal(result.ok, false);
});
```

Note the fake adapter's `harvest` argv from Task 10 is `['fake', 'harvest', step.id, <artifact path>]` — index 1 is the phase, matching the assertions above.

- [ ] **Step 2: run tests, verify fail** (engine throws `interactive steps not yet supported`).

- [ ] **Step 3: implement** — replace the throw in `runner.ts` with the flow described under Interfaces, extracting the shared post-spawn tail (`git-guard` → `assertArtifact` → `step:artifact` → verdict) into `finishStep` used by both branches.

- [ ] **Step 4: run all tests, verify pass. Typecheck.**

- [ ] **Step 5: commit**

```bash
git add -A && git commit -m "feat(core): interactive handoff — frontend-owned session, deterministic harvest"
```

---

### Task 13: `on_findings` loop and interactive modes

**Files:**
- Modify: `packages/core/src/engine/runner.ts`
- Test: extend `packages/core/src/engine/runner.test.ts`
- Modify: `docs/design.md` (move `max_spend_usd` to "Out of scope for v1")

**Interfaces:**
- Consumes: existing engine internals; `config.loop.max_iterations`.
- Produces, when a `verdict: true` step yields `fail`:
  - **`loop`**: find the nearest *preceding* step with `writes: true` (validate at run start that one exists for workflows with a verdict step when mode is `loop`; otherwise throw `WorkflowError`). Re-run from that step through the verdict step, with the findings artifact appended to the loop-target's `inputs` (deduplicated). Repeat until verdict `pass` or `config.loop.max_iterations` re-runs are exhausted; exhaustion → `run:done` `ok: false`, `verdict: 'fail'`. Each iteration re-emits normal step events.
  - **`interactive`**: spawn one interactive session via `frontend.runInteractive` using the verdict step's adapter with a synthetic step `{ ...verdictStep, id: '<verdictStep.id>-triage', mode: 'interactive', writes: true, prompt: 'The review found problems. Findings are in <findings path>. Work with me to resolve them.' }` (session id minted if the adapter supports it; no harvest, no artifact assertion — the human decides what happens in it). After it exits: `run:done` with `ok: false`, `verdict: 'fail'` (the findings stood; a clean follow-up run is the way to prove them resolved).
- Structure: implement the run as an inner `executeSteps(fromIndex: number): Promise<...>` so loop mode can re-enter at the loop target without duplicating the step loop.

- [ ] **Step 1: write the failing tests** (append to `runner.test.ts`)

```ts
test('loop mode re-runs execute until the reviewer passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    on_findings: 'loop',
    steps: [
      { id: 'exec', runner: 'fake', mode: 'headless', writes: true, prompt: 'do', output: 'r.md' },
      { id: 'review', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'check', output: 'f.md' },
    ],
  };
  const { frontend } = collector();
  let reviews = 0;
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const [, , stepId, artifact] = spec.argv;
      if (stepId === 'review') {
        reviews += 1;
        await writeFile(artifact, reviews < 3 ? 'VERDICT: FAIL\nfix it' : 'VERDICT: PASS\nok');
      } else {
        await writeFile(artifact, `attempt\n`);
      }
      return 0;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(reviews, 3); // initial + 2 loop re-reviews, within max_iterations=3
});

test('loop mode gives up after max_iterations and fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    on_findings: 'loop',
    steps: [
      { id: 'exec', runner: 'fake', mode: 'headless', writes: true, prompt: 'do', output: 'r.md' },
      { id: 'review', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'check', output: 'f.md' },
    ],
  };
  const { frontend } = collector();
  let execRuns = 0;
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const [, , stepId, artifact] = spec.argv;
      if (stepId === 'exec') execRuns += 1;
      await writeFile(artifact, stepId === 'review' ? 'VERDICT: FAIL\nstill bad' : 'attempt');
      return 0;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'fail');
  assert.equal(execRuns, 1 + DEFAULT_CONFIG.loop.max_iterations);
});

test('loop mode feeds findings into the re-run prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    on_findings: 'loop',
    steps: [
      { id: 'exec', runner: 'fake', mode: 'headless', writes: true, prompt: 'do', output: 'r.md' },
      { id: 'review', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'check', output: 'f.md' },
    ],
  };
  const { frontend } = collector();
  const execPrompts: string[] = [];
  await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const [, , stepId, artifact, prompt] = spec.argv;
      if (stepId === 'exec') execPrompts.push(prompt);
      await writeFile(artifact, stepId === 'review'
        ? (execPrompts.length < 2 ? 'VERDICT: FAIL\nbad' : 'VERDICT: PASS\nok')
        : 'attempt');
      return 0;
    },
  });
  assert.equal(execPrompts.length, 2);
  assert.ok(!execPrompts[0].includes('f.md'));
  assert.ok(execPrompts[1].includes('f.md')); // findings artifact injected on the re-run
});

test('interactive findings mode hands the operator a session and fails the run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-run-'));
  const workflow: Workflow = {
    name: 'r',
    on_findings: 'interactive',
    steps: [
      { id: 'exec', runner: 'fake', mode: 'headless', writes: true, prompt: 'do', output: 'r.md' },
      { id: 'review', runner: 'fake', mode: 'headless', writes: false, verdict: true, prompt: 'check', output: 'f.md' },
    ],
  };
  const { events } = collector();
  const interactivePrompts: string[] = [];
  const frontend: Frontend = {
    runInteractive: async spec => { interactivePrompts.push(spec.argv.join(' ')); return 0; },
    onEvent: e => events.push(e),
  };
  const result = await runWorkflow({
    workflow, workdir: dir, inputs: {}, config: DEFAULT_CONFIG, registry: registry(), frontend,
    spawnHeadless: async spec => {
      const [, , stepId, artifact] = spec.argv;
      await writeFile(artifact, stepId === 'review' ? 'VERDICT: FAIL\nbad' : 'work');
      return 0;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(interactivePrompts.length, 1);
  assert.ok(interactivePrompts[0].includes('f.md'));
});
```

- [ ] **Step 2: run tests, verify fail.**

- [ ] **Step 3: implement** per the Interfaces block: restructure the step loop into `executeSteps(fromIndex)`; on `fail` + `loop`, append the findings artifact id to the loop-target's effective `inputs` and re-enter; on `fail` + `interactive`, build the synthetic triage step, mint a session id if the adapter injects, `frontend.runInteractive(adapter.interactive(triageStep, ctx))`, then finish `ok: false`.

- [ ] **Step 4: run all tests, verify pass. Typecheck.**

- [ ] **Step 5: update `docs/design.md`** — in §"Workspace configuration" remove `max_spend_usd` from the example and the `loop` bullet ("bounded by `max_iterations`"), and add `max_spend_usd` spend ceilings to §"Out of scope for v1".

- [ ] **Step 6: commit**

```bash
git add -A && git commit -m "feat(core): configurable on_findings — loop with bounded re-runs, interactive triage"
```

---

### Task 14: End-to-end verification and README

**Files:**
- Create: `README.md`
- Create: throwaway repo under the session scratchpad (not committed)

This task burns real tokens (small models, tiny repo) — it is the only one that does.

- [ ] **Step 1: build the throwaway target repo**

```bash
SCRATCH=$(mktemp -d /tmp/whiphand-e2e-XXXX) && cd "$SCRATCH" && git init -b main
mkdir -p src .whiphand/workflows
cat > src/calc.js <<'EOF'
// deliberate defect: subtract instead of add
export function add(a, b) { return a - b; }
EOF
git add -A && git commit -m init
```

`.whiphand/workflows/fix.yaml` (headless-only first — no human needed):
```yaml
name: fix
steps:
  - id: execute
    runner: claude
    model: haiku
    mode: headless
    writes: true
    output: report.md
    prompt: |
      src/calc.js has a bug: add() subtracts. Fix it.
      Then write a short report of what you changed to the artifact path given below.
      Write the report to the file named report.md inside the newest directory under .whiphand/runs/.
  - id: review
    runner: claude
    model: haiku
    mode: headless
    writes: false
    verdict: true
    inputs: [execute]
    output: findings.md
    prompt: |
      Check git diff: does add() now correctly add? Write findings to the artifact path
      referenced in your input artifacts section, as findings.md next to the report.
```

- [ ] **Step 2: dry-run first, inspect argv**

```bash
node packages/cli/src/main.ts run fix --dry-run -C "$SCRATCH"
```
Check: review step argv contains `--disallowedTools Write,Edit,NotebookEdit`; execute step contains `--allowedTools Bash,Write,Edit,NotebookEdit`.

- [ ] **Step 3: real headless run**

```bash
node packages/cli/src/main.ts run fix -C "$SCRATCH"
```
Verify: exit 0; `git -C "$SCRATCH" diff HEAD` shows `a + b`; both artifacts exist; findings start with `VERDICT:`.
Known risk to watch: the artifact-path prompt phrasing — if the model writes the artifact elsewhere, tighten the engine so the artifact path is passed explicitly in the prompt (the `buildPrompt` artifact section already names it for steps with `inputs`; for output paths, append a line `Write your '<output>' artifact to: <absolute path>` in `effectiveStep` for ALL headless steps and add a unit test for it — this is an allowed scope adjustment, note it in the commit).

- [ ] **Step 4: interactive end-to-end (operator present — this is you, the human)**

Add a `plan` step (interactive, `claude`, `writes: false`, output `plan.md`) in front of `execute` in `fix.yaml`, run without `--dry-run`, hold a two-line conversation, exit, and verify: the harvest runs, `plan.md` lands non-empty, and during the session an attempted file edit is refused (tool denial working). Then verify the copilot variant: switch the plan step's runner to `copilot`, confirm the transcript file lands via `--share` and the harvest distills it.

- [ ] **Step 5: read-only violation drill**

Temporarily set `writes: true` → `false` on the execute step and run: the run must FAIL with `read-only step 'execute' modified the tree: src/calc.js` (after resetting the scratch repo: `git -C "$SCRATCH" checkout -- .`). Revert the workflow.

- [ ] **Step 6: write `README.md`** — short: what `whiphand` is (2 sentences), install (`npm install`, `node packages/cli/src/main.ts` or `npm link`), quickstart (`whiphand doctor`, `whiphand run examples/feature.yaml --dry-run --input feature=demo`), workflow format reference pointer to `docs/design.md`, and the three `on_findings` modes.

- [ ] **Step 7: full suite, final commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "docs: README and e2e verification notes"
```

---

## Self-review notes (already applied)

- Spec coverage: schema/validation → T2; templating/artifact injection → T3; registry + validate-time capability check → T4; claude + copilot adapters with exact verified flags → T5/T6; workspace config with `on_findings` → T7; artifact store → T8; two-layer read-only enforcement → T9 + engine wiring in T10; dry-run and `whiphand doctor` → T10/T11; TTY seam (`Frontend.runInteractive`, core never inherits stdio) → T10–T12; interactive handoff with deterministic harvest → T12; `on_findings` report/loop/interactive → T10/T13; e2e → T14.
- Deviation from `docs/design.md`, intentional: `max_spend_usd` deferred out of v1 (Task 13 Step 5 syncs the design doc); `allow_paths` is parsed and carried on `Step` but not yet enforced by any adapter — it is documented in the schema for workflow compatibility and its enforcement belongs to a future copilot/claude sandbox flag investigation, not v1 (the git guard covers `writes: false`; `writes: true` steps are trusted within the workdir).
- Type consistency: `SpawnSpec`/`RunCtx`/`Frontend`/`WhiphandEvent` defined once in Task 2 and only imported afterwards; fake-adapter argv layout (`['fake', <phase>, <stepId>, <artifactPath>, <prompt>]`) is consistent between Task 10's definition and Task 12/13's assertions.
