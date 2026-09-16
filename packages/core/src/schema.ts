import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { LoopStep, StagesStep, Workflow, Step, StepKind } from './types.ts';
import { STAGE_REF } from './types.ts';
import { flattenSteps, isContainerStep, isLoopStep, isManualStep, isStagesStep } from './steps.ts';
import { ATTACHMENTS_REF } from './attachments.ts';
import { disabledIds } from './enabled.ts';

export class WorkflowError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`invalid workflow:\n  - ${problems.join('\n  - ')}`);
    this.name = 'WorkflowError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * A blank string (`''` or spaces-only) on an optional field means "absent" —
 * for every client, including hand-written YAML (`output: ""`). The
 * `z.string().optional()` inside the preprocess is what keeps the *type*
 * `string | undefined`; the preprocess is what actually does the blank-to-
 * absent conversion before that type ever sees the value.
 */
function optionalText(): z.ZodType<string | undefined, unknown> {
  return z.preprocess(
    v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  );
}

/**
 * A required field that is present but blank (or spaces-only) is rejected as
 * "is required", the same wording a missing field gets from
 * `formatWorkflowIssues`'s `invalid_type` mapping — a field the user left
 * untouched and a field they blanked out read as the same problem. Prose
 * values are never trimmed, only tested: `trim() !== ''`.
 */
function requiredText(): z.ZodType<string, unknown> {
  return z.string().superRefine((v, ctx) => {
    if (v.trim() === '') ctx.addIssue({ code: 'custom', message: 'is required' });
  });
}

const baseFields = {
  id: requiredText(),
  inputs: z.array(requiredText()).optional(),
  verdict: z.boolean().optional(),
  enabled: z.boolean().optional(),
};

/**
 * The step tree is recursive (a loop contains steps), so the union is reached
 * through a lazy thunk. `kind` defaults to 'agent' in the preprocess step,
 * which is what keeps every workflow written before kinds existed parsing
 * unchanged.
 */
export const stepSchema: z.ZodType<Step, unknown> = z.lazy(() => stepUnion);

const agentStepSchema = z.object({
  ...baseFields,
  kind: z.literal('agent'),
  runner: requiredText(),
  model: optionalText(),
  mode: z.enum(['interactive', 'headless']),
  writes: z.boolean(),
  prompt: requiredText(),
  output: requiredText(),
  allow_paths: z.array(requiredText()).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

/** `expect_exit: 0` and `expect_exit: [0, 1]` both normalize to an array. */
const expectExitSchema = z
  .union([z.number().int(), z.array(z.number().int()).min(1)])
  .transform(v => (Array.isArray(v) ? v : [v]));

const commandStepSchema = z.object({
  ...baseFields,
  kind: z.literal('command'),
  run: requiredText(),
  shell: optionalText(),
  cwd: optionalText(),
  env: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
  expect_exit: expectExitSchema.optional(),
  output: optionalText(),
});

/** 'manual' and 'approval' are the same shape; two literals so the union stays discriminated. */
function manualShape<K extends 'manual' | 'approval'>(kind: K) {
  return z.object({
    ...baseFields,
    kind: z.literal(kind),
    title: requiredText(),
    instructions: requiredText(),
    capture: z.enum(['note', 'review']).optional(),
    show_diff: z.boolean().optional(),
    default: z.enum(['continue', 'abort']).optional(),
    output: optionalText(),
  });
}

const loopStepSchema = z.object({
  kind: z.literal('loop'),
  id: requiredText(),
  steps: z.array(stepSchema).min(1),
  until: requiredText(),
  max_iterations: z.number().int().positive().optional(),
  on_exhausted: z.enum(['report', 'loop', 'interactive']).optional(),
  enabled: z.boolean().optional(),
});

const stagesStepSchema = z.object({
  kind: z.literal('stages'),
  id: requiredText(),
  items: requiredText(),
  steps: z.array(stepSchema).min(1),
  max_retries: z.number().int().nonnegative().optional(),
  enabled: z.boolean().optional(),
});

/** A step object with no `kind:` defaults to an `agent` step. */
function withDefaultKind(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && !('kind' in raw)) {
    return { ...(raw as Record<string, unknown>), kind: 'agent' };
  }
  return raw;
}

const stepUnion = z.preprocess(
  withDefaultKind,
  z.discriminatedUnion('kind', [
    agentStepSchema,
    commandStepSchema,
    manualShape('manual'),
    manualShape('approval'),
    loopStepSchema,
    stagesStepSchema,
  ]),
);

/**
 * The only form a `{{ inputs.x }}` placeholder can reference — see
 * template.ts's `PLACEHOLDER` regex. A name outside this alphabet would
 * parse into the workflow but could never be filled in from a prompt.
 */
const INPUT_NAME_RE = /^[A-Za-z0-9_-]+$/;

const inputNameSchema = z.string().superRefine((v, ctx) => {
  if (v.trim() === '') {
    ctx.addIssue({ code: 'custom', message: 'input name is required' });
  } else if (!INPUT_NAME_RE.test(v)) {
    ctx.addIssue({ code: 'custom', message: `input name '${v}' must use letters, digits, '-' or '_'` });
  }
});

export const workflowSchema: z.ZodType<Workflow, unknown> = z.object({
  name: requiredText(),
  description: optionalText(),
  inputs: z.record(inputNameSchema, z.object({
    required: z.boolean(),
    prompt: optionalText(),
    default: optionalText(),
    remember: z.boolean().optional(),
    multiline: z.boolean().optional(),
  })).optional(),
  on_findings: z.enum(['report', 'loop', 'interactive']).optional(),
  steps: z.array(stepSchema).min(1),
});

// ---------------------------------------------------------------------------
// Misplaced-field detection (runs on the raw YAML, before zod strips anything)
// ---------------------------------------------------------------------------

/**
 * zod objects are non-strict, so `run: npm test` on a step that forgot its
 * `kind: command` would be silently dropped and the step would run as an agent
 * with a confusing pile of "required" errors. Naming the misplaced field is a
 * far better diagnostic, and it needs the raw object because by the time zod
 * is done the evidence is gone.
 */
const FIELD_OWNER: Record<string, StepKind> = {
  runner: 'agent', model: 'agent', mode: 'agent', writes: 'agent', prompt: 'agent',
  allow_paths: 'agent', effort: 'agent',
  run: 'command', shell: 'command', expect_exit: 'command', timeout_ms: 'command',
  title: 'manual', instructions: 'manual', capture: 'manual', show_diff: 'manual',
  steps: 'loop', until: 'loop', max_iterations: 'loop', on_exhausted: 'loop',
  items: 'stages', max_retries: 'stages',
};

/**
 * `steps:` is the one field `loop` and `stages` both own — recorded above
 * against `'loop'` only (so a misplaced `until` on a `stages` step still
 * names `loop`, the kind that actually has `until`), with this the escape
 * that keeps a `stages` step's own `steps:` from being flagged as belonging
 * to the wrong kind.
 */
const SHARED_FIELDS = new Set(['steps']);

/** 'approval' shares every field with 'manual'. */
function ownerMatches(owner: StepKind, kind: StepKind, key: string): boolean {
  if (SHARED_FIELDS.has(key) && (kind === 'loop' || kind === 'stages')) return true;
  return owner === kind || (owner === 'manual' && kind === 'approval');
}

function checkMisplacedFields(raw: unknown, problems: string[]): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
  const obj = raw as Record<string, unknown>;
  const declared = typeof obj.kind === 'string' ? (obj.kind as StepKind) : undefined;
  const kind: StepKind = declared ?? 'agent';
  const id = typeof obj.id === 'string' ? obj.id : '(unnamed)';

  for (const key of Object.keys(obj)) {
    const owner = FIELD_OWNER[key];
    if (owner === undefined || ownerMatches(owner, kind, key)) continue;
    problems.push(
      declared === undefined
        ? `step '${id}': has '${key}', which belongs to kind '${owner}' — add 'kind: ${owner}'`
        : `step '${id}': kind '${kind}' has no '${key}' field (it belongs to kind '${owner}')`);
  }

  if (Array.isArray(obj.steps)) for (const child of obj.steps) checkMisplacedFields(child, problems);
}

/**
 * The workflow root's allowed vocabulary, stated directly rather than derived
 * by subtracting `FIELD_OWNER`: subtraction would make adding any field to a
 * step kind silently forbid that name at the root too. `enabled` belongs to
 * every step kind, so it has no single owner and cannot be registered in
 * `FIELD_OWNER` — this is its diagnostic instead.
 */
const ROOT_KEYS = new Set(['name', 'description', 'inputs', 'on_findings', 'steps']);

function checkRootFields(raw: unknown, problems: string[]): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!ROOT_KEYS.has(key)) {
      problems.push(`workflow: '${key}' belongs on a step, not on the workflow`);
    }
  }
}

// ---------------------------------------------------------------------------
// Semantics
// ---------------------------------------------------------------------------

interface Located {
  step: Step;
  /** Position in the tree; comparable lexicographically as document order. */
  path: number[];
  /** id of the enclosing loop, when this step is a direct loop body member. */
  parentLoopId?: string;
  /** ids of every loop this step is nested inside, directly or transitively, outermost first. */
  loopChain: string[];
  /** id of the nearest enclosing `stages` step, when there is one. */
  stagesId?: string;
  /**
   * ids of every `stages` step this step is nested inside, outermost first —
   * kept apart from `loopChain` rather than merged into one "container chain":
   * a loop body member can legally forward-reference a later sibling in the
   * *same* loop (see the forward-reference rule below), but a cross-stage
   * forward reference must stay a validation error, so nothing here may ever
   * be consulted the way `loopChain` is for that check.
   */
  stagesChain: string[];
}

function locate(steps: Step[], prefix: number[], loopChain: string[], stagesChain: string[], out: Located[]): void {
  steps.forEach((step, idx) => {
    const path = [...prefix, idx];
    out.push({
      step, path, parentLoopId: loopChain.at(-1), loopChain,
      stagesId: stagesChain.at(-1), stagesChain,
    });
    if (isLoopStep(step)) locate(step.steps, path, [...loopChain, step.id], stagesChain, out);
    else if (isStagesStep(step)) locate(step.steps, path, loopChain, [...stagesChain, step.id], out);
  });
}

function comparePaths(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? -1;
    const bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/** Where one step sits in the tree, by id — what `scopeInputs` needs to tell a forward reference from a backward one. */
export interface StepTreeLocation {
  path: number[];
  /** id of the enclosing loop, when this step is a direct loop body member. */
  parentLoopId?: string;
  /** ids of every loop this step is nested inside, directly or transitively, outermost first. */
  loopChain: string[];
  /** id of the nearest enclosing `stages` step, when there is one. */
  stagesId?: string;
  /** ids of every `stages` step this step is nested inside, outermost first. */
  stagesChain: string[];
}

/** Every step's location, keyed by id — built once per run (or per validation pass) and read by id from there on. */
export function locateSteps(steps: Step[]): Map<string, StepTreeLocation> {
  const located: Located[] = [];
  locate(steps, [], [], [], located);
  const byId = new Map<string, StepTreeLocation>();
  for (const entry of located) {
    byId.set(entry.step.id, {
      path: entry.path, parentLoopId: entry.parentLoopId, loopChain: entry.loopChain,
      stagesId: entry.stagesId, stagesChain: entry.stagesChain,
    });
  }
  return byId;
}

/** Whether `toId` comes after `fromId` in document order — a reference from `fromId` to `toId` means "the previous iteration". */
export function isForwardRef(locations: Map<string, StepTreeLocation>, fromId: string, toId: string): boolean {
  const from = locations.get(fromId);
  const to = locations.get(toId);
  if (from === undefined || to === undefined) return false;
  return comparePaths(to.path, from.path) > 0;
}

/**
 * Cross-field checks zod's shape validation can't express: id uniqueness across
 * the whole tree, artifact-reference direction, and loop wiring.
 */
export function validateWorkflowSemantics(workflow: Workflow): string[] {
  const problems: string[] = [];

  const located: Located[] = [];
  locate(workflow.steps, [], [], [], located);

  // Whether `stage` may appear in any step's `inputs:` at all — see the loop
  // below. Computed once rather than per-reference: it depends on the whole
  // tree, not on where the reader sits in it.
  const hasStages = located.some(entry => isStagesStep(entry.step));

  const byId = new Map<string, Located>();
  for (const entry of located) {
    if (entry.step.id === ATTACHMENTS_REF) {
      // As a loop id it would also be the directory the attached files are
      // copied into; as a step id, `inputs: [attachments]` would be ambiguous.
      problems.push(`${isLoopStep(entry.step) ? 'loop' : 'step'} id '${ATTACHMENTS_REF}' is reserved `
        + `for the files attached to a run; rename it`);
    }
    // Only a problem once the workflow actually has a `stages` step: nothing
    // makes `stage` special otherwise, and the shipped feature-development
    // template's command step is named exactly this (see scaffold.ts) —
    // every workspace `whiphand init` ever ran has that file, so a blanket
    // reservation would stop it (and every workspace built from it) from
    // parsing at all.
    if (hasStages && entry.step.id === STAGE_REF) {
      problems.push(`step id '${STAGE_REF}' is reserved for the current stage file; rename it`);
    }
    if (byId.has(entry.step.id)) problems.push(`duplicate step id '${entry.step.id}'`);
    else byId.set(entry.step.id, entry);
  }

  for (const src of located) {
    const step = src.step;

    if (isLoopStep(step)) {
      validateLoop(step, problems);
      continue;
    }

    if (isStagesStep(step)) {
      validateStages(step, src, problems);
      continue;
    }

    if (isManualStep(step) && step.capture !== undefined && !step.output) {
      problems.push(`step '${step.id}': capture '${step.capture}' needs an 'output' to write it to`);
    }

    for (const ref of step.inputs ?? []) {
      // Not a step: the files attached to the run, which exist before step
      // one, so there is no ordering or artifact to check.
      if (ref === ATTACHMENTS_REF) continue;
      // Not a step either: the current stage file's own fields, readable via
      // {{ stage.* }} — real only inside a stages body, exactly like `loop`
      // is only real inside a loop, so a reader outside one is refused here
      // rather than left to fail later at render time. Outside a stages body
      // a real step called `stage` still wins: the feature-development
      // template has one, and its readers must keep resolving to it.
      if (ref === STAGE_REF && (src.stagesId !== undefined || !byId.has(ref))) {
        if (src.stagesId === undefined) {
          problems.push(`step '${step.id}' reads '${STAGE_REF}', which only exists inside a stages step`);
        }
        continue;
      }
      const tgt = byId.get(ref);
      if (tgt === undefined) {
        problems.push(`step '${step.id}' references unknown step '${ref}'`);
        continue;
      }
      if (isContainerStep(tgt.step)) {
        const label = isLoopStep(tgt.step) ? `loop '${ref}'` : `stages step '${ref}'`;
        problems.push(`step '${step.id}' references ${label}, which produces no artifact`);
        continue;
      }
      if (!tgt.step.output) {
        problems.push(`step '${step.id}' references step '${ref}', which produces no artifact`);
        continue;
      }
      // A stage's artifacts are scoped to it and restored away when the
      // stages step ends (see runStage), so a reader outside that stages
      // step would find nothing recorded at run time. Said here instead.
      if (tgt.stagesId !== undefined && !src.stagesChain.includes(tgt.stagesId)) {
        problems.push(`step '${step.id}' references step '${ref}' inside stages step '${tgt.stagesId}', `
          + 'whose artifacts do not outlive a stage');
        continue;
      }
      const order = comparePaths(tgt.path, src.path);
      if (order === 0) {
        problems.push(`step '${step.id}' references itself`);
      } else if (order > 0) {
        // A later step is only referenceable when it belongs to a loop that
        // encloses the referencing step — however deeply nested the
        // referencer is inside it, the reference means "that step's artifact
        // from that loop's previous iteration". Deliberately loopChain only,
        // never stagesChain: a cross-stage forward reference has no "previous
        // iteration" to mean (each stage is a fresh pass over fresh input),
        // so it stays an ordinary forward-reference error.
        const sameBody = tgt.parentLoopId !== undefined && src.loopChain.includes(tgt.parentLoopId);
        if (!sameBody) problems.push(`step '${step.id}' references later step '${ref}'`);
      }
    }
  }

  return problems;
}

/**
 * A `stages` step's own two rules, beyond the shape zod already checked:
 * where it may sit in the tree, and what its body must contain.
 */
function validateStages(step: StagesStep, src: Located, problems: string[]): void {
  // Nesting is refused outright rather than "supported, but here's what
  // breaks": a stage frame is folded into the same loop-shaped chain a
  // `LoopFrame` is (see execution-key.ts), and letting either wrap the other
  // would need every consumer of that chain to reason about two containers
  // occupying one link instead of one.
  if (src.loopChain.length > 0) {
    problems.push(`stages step '${step.id}' cannot run inside a loop`);
  }
  if (src.stagesChain.length > 0) {
    problems.push(`stages step '${step.id}' cannot run inside another stages step`);
  }

  // A loop inside a stages body that exhausts its budget has to send its
  // failure *somewhere* — a later task makes that "up to the human gate"
  // rather than "kill the run". Requiring the gate in the body's own document
  // order, at parse time, is what keeps the runner from ever needing
  // end-of-body reconciliation logic to invent one.
  const body = flattenSteps(step.steps);
  const disabled = disabledIds(step.steps);
  body.forEach((entry, i) => {
    if (!isLoopStep(entry.step)) return;
    // The loop's own body follows it in the flattened list and must not
    // count: a gate inside the loop (e.g. its `until`) is not *after* it.
    const later = body.slice(i + 1);
    const end = later.findIndex(e => e.depth <= entry.depth);
    const after = end === -1 ? [] : later.slice(end);
    // A disabled gate is pruned before the run, so it cannot be the one
    // that accepts an exhausted cycle — and neither can one inside a
    // disabled container.
    const gated = after.some(e => isManualStep(e.step) && !disabled.has(e.step.id));
    if (!gated) {
      problems.push(`stages step '${step.id}': loop '${entry.step.id}' needs a manual or approval `
        + 'step after it, or an exhausted cycle has no one to accept it');
    }
  });
}

function validateLoop(loop: LoopStep, problems: string[]): void {
  if (loop.on_exhausted === 'loop') {
    problems.push(`loop '${loop.id}': on_exhausted 'loop' is meaningless — use report or interactive`);
  }
  const target = loop.steps.find(s => s.id === loop.until);
  if (target === undefined) {
    problems.push(`loop '${loop.id}': until '${loop.until}' is not a step in its body`);
    return;
  }
  if (isContainerStep(target)) {
    const kind = isLoopStep(target) ? 'loop' : 'stages step';
    problems.push(`loop '${loop.id}': until step '${loop.until}' is a ${kind} `
      + '— it must name a non-loop step with verdict on');
  } else if (!target.verdict) {
    problems.push(`loop '${loop.id}': until step '${loop.until}' must set 'verdict: true'`);
  }
}

// ---------------------------------------------------------------------------
// Non-fatal diagnostics: a step that still runs, just uselessly.
// ---------------------------------------------------------------------------

function collectManualWarnings(steps: Step[], insideLoop: boolean, warnings: string[]): void {
  for (const step of steps) {
    if (isLoopStep(step)) {
      collectManualWarnings(step.steps, true, warnings);
      continue;
    }
    if (!isManualStep(step) || step.capture !== 'review') continue;
    if (!insideLoop) {
      warnings.push(
        `step '${step.id}': capture 'review' outside a loop can never offer 'retry', `
        + 'so it only approves with notes');
    }
    if (!step.show_diff) {
      warnings.push(
        `step '${step.id}': capture 'review' without 'show_diff: true' has no files to comment on, `
        + 'so it only takes an overall comment');
    }
  }
}

/**
 * Diagnostics for a step that still runs, just uselessly — as opposed to
 * `validateWorkflowSemantics`, whose problems refuse to run the workflow at
 * all. Not called by `parseWorkflow`: a caller that wants them (a lint
 * command, an editor) asks for them explicitly.
 */
export function validateWorkflowWarnings(workflow: Workflow): string[] {
  const warnings: string[] = [];
  collectManualWarnings(workflow.steps, false, warnings);
  return warnings;
}

/**
 * Gates inside a `stages` step that `--yes` would answer without the author
 * having said so. `defaultChoice` is `continue`, so an unattended run would
 * silently accept every stage — "implement all seven stages unattended", the
 * exact thing `stages` exists to prevent. A gate opts in explicitly by
 * writing `default: continue` (or `abort`) itself; only that is trusted, not
 * the mere presence of a gate. `flattenSteps` already threads `stagesId`
 * through a nested loop, so a gate after a stage's retry loop is covered the
 * same as one sitting directly in the stage body. A disabled gate is pruned
 * before the run and can never be reached, so it is not a problem — matching
 * `disabledIds`, which also drops it from `validateStages`'s own gate check.
 */
export function unattendedProblems(workflow: Workflow): string[] {
  const disabled = disabledIds(workflow.steps);
  const problems: string[] = [];
  for (const { step, stagesId } of flattenSteps(workflow.steps)) {
    if (stagesId === undefined || !isManualStep(step) || step.default !== undefined) continue;
    if (disabled.has(step.id)) continue;
    problems.push(
      `step '${step.id}': a gate inside stages step '${stagesId}' must set an explicit 'default' to run under --yes`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Turning a zod issue list into the editor's and the CLI's wording
// ---------------------------------------------------------------------------

/** The editor's own label for a field key, where it differs from the YAML key. */
const FIELD_LABELS: Record<string, string> = {
  id: 'Step ID',
  name: 'Name',
  output: 'Output filename',
  run: 'Command',
  prompt: 'Prompt',
  instructions: 'Instructions',
  title: 'Title',
  runner: 'Runner',
  until: 'Repeat until',
  timeout_ms: 'Timeout (ms)',
  expect_exit: 'Successful exit codes',
  max_iterations: 'Max iterations',
  cwd: 'Working directory',
  allow_paths: 'Allowed paths',
  inputs: 'Reads from',
  steps: 'Steps',
  items: 'Stage files',
  max_retries: 'Max retries',
};

function fieldLabel(key: unknown): string {
  return typeof key === 'string' ? (FIELD_LABELS[key] ?? key) : String(key);
}

/** 1-based, depth-first ordinal per step path — matches the editor's card numbering. */
function buildOrdinalMap(steps: unknown): Map<string, number> {
  const map = new Map<string, number>();
  let n = 0;
  function walk(list: unknown, prefix: number[]): void {
    if (!Array.isArray(list)) return;
    list.forEach((item, i) => {
      const path = [...prefix, i];
      n += 1;
      map.set(path.join(','), n);
      const nested = item !== null && typeof item === 'object' ? (item as { steps?: unknown }).steps : undefined;
      if (Array.isArray(nested)) walk(nested, path);
    });
  }
  walk(steps, []);
  return map;
}

interface StepLocation {
  obj: Record<string, unknown>;
  path: number[];
  /** What remains of the issue's path once the step chain is consumed. */
  fieldPath: PropertyKey[];
}

/** Walks `raw` along an issue's path, descending through `steps` arrays to find the deepest step it names. */
function locateStep(raw: unknown, path: PropertyKey[]): StepLocation | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  let node: unknown = (raw as { steps?: unknown }).steps;
  let idx = 0;
  let result: StepLocation | undefined;
  let stepPath: number[] = [];
  while (path[idx] === 'steps' && typeof path[idx + 1] === 'number' && Array.isArray(node)) {
    const i = path[idx + 1] as number;
    const item = node[i];
    if (item === null || typeof item !== 'object') break;
    stepPath = [...stepPath, i];
    result = { obj: item as Record<string, unknown>, path: stepPath, fieldPath: path.slice(idx + 2) };
    node = (item as { steps?: unknown }).steps;
    idx += 2;
  }
  return result;
}

function stepLabel(raw: unknown, loc: StepLocation, ordinals: Map<string, number>): string {
  const id = loc.obj.id;
  if (typeof id === 'string' && id.trim() !== '') return `step '${id}'`;
  return `step #${ordinals.get(loc.path.join(',')) ?? '?'}`;
}

/** Walks `raw` along an issue's path to read the value that actually failed — zod 4 does not put it on the issue itself. */
function valueAtPath(raw: unknown, path: readonly PropertyKey[]): unknown {
  let node: unknown = raw;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

/**
 * `invalid_type` covers two very different cases: a field the user never
 * filled in (the value at its path is `undefined`) and a field they filled in
 * with the wrong shape (`timeout_ms: "5000"`, `run: 5`). Only the first is
 * "is required" — the second falls back to zod's own "expected X, received Y"
 * message. zod 4 does not set `issue.input` unless `reportInput` is enabled,
 * so the value has to be read back out of `raw` at the issue's own path.
 */
function phraseFor(issue: z.core.$ZodIssue, raw: unknown): string {
  switch (issue.code) {
    case 'too_small': {
      const origin = (issue as { origin?: string }).origin;
      if (origin === 'array') return 'needs at least one entry';
      if (origin === 'number' || origin === 'int' || origin === 'bigint') return 'must be greater than 0';
      return "can't be empty";
    }
    case 'invalid_type':
      return valueAtPath(raw, issue.path) === undefined ? 'is required' : issue.message;
    default:
      return issue.message;
  }
}

interface ClassifiedIssue {
  stepId?: string;
  field?: string;
  /** Field-local text, with no step or label prefix — what a `Field`'s own `validationMessage` wants. */
  phrase: string;
  /** The full line, matching `formatWorkflowIssues`'s string form — for a problem list, not a single field. */
  message: string;
}

function classifyIssue(raw: unknown, issue: z.core.$ZodIssue, ordinals: Map<string, number>): ClassifiedIssue {
  const path = issue.path;

  // A step's own `kind` failed to match any of the discriminated union's
  // literals — this is about the field itself, not a value inside it, so it
  // gets its own full sentence rather than a "<label> <phrase>" join.
  if (issue.code === 'invalid_union' && (issue as { discriminator?: string }).discriminator === 'kind') {
    const options = (issue as { options?: unknown[] }).options ?? [];
    const loc = locateStep(raw, path.slice(0, -1));
    const prefix = loc ? stepLabel(raw, loc, ordinals) : 'workflow';
    const stepId = loc && typeof loc.obj.id === 'string' && loc.obj.id.trim() !== '' ? loc.obj.id : undefined;
    const phrase = `kind must be one of ${options.join(', ')}`;
    return { stepId, field: 'kind', phrase, message: `${prefix}: ${phrase}` };
  }

  // A named workflow input: either its name is malformed (own full-sentence
  // message from `inputNameSchema`) or one of its fields (prompt, default,
  // required) failed.
  if (path[0] === 'inputs' && locateStep(raw, path) === undefined) {
    if (issue.code === 'invalid_key') {
      const nested = (issue as { issues?: z.core.$ZodIssue[] }).issues ?? [];
      const phrase = nested[0]?.message ?? issue.message;
      return { phrase, message: phrase };
    }
    if (typeof path[1] === 'string') {
      const field = path.length > 2 ? fieldLabel(path[2]) : 'value';
      const phrase = phraseFor(issue, raw);
      return { phrase, message: `input '${path[1]}': ${field} ${phrase}` };
    }
  }

  const loc = locateStep(raw, path);
  if (loc !== undefined) {
    const field = loc.fieldPath[0];
    const stepId = typeof loc.obj.id === 'string' && loc.obj.id.trim() !== '' ? loc.obj.id : undefined;
    const phrase = phraseFor(issue, raw);
    return {
      stepId,
      field: typeof field === 'string' ? field : undefined,
      phrase,
      message: `${stepLabel(raw, loc, ordinals)}: ${fieldLabel(field)} ${phrase}`,
    };
  }

  // Not inside any step: a workflow root field (name, description, steps…).
  const field = path[0];
  const phrase = phraseFor(issue, raw);
  return { field: typeof field === 'string' ? field : undefined, phrase, message: `workflow: ${fieldLabel(field)} ${phrase}` };
}

/**
 * Turns zod's issue array into the editor's and the CLI's plain-language
 * problem list — `step 'push': Output filename can't be empty`, one line per
 * issue, in place of zod 4's pretty-printed JSON. `raw` is the pre-parse
 * value: the only place a step's `id` (or its depth-first ordinal, for a step
 * whose own `id` is what's wrong) can still be read, since a failed parse
 * produces no typed `Workflow` to read it from afterwards.
 */
export function formatWorkflowIssues(raw: unknown, issues: z.core.$ZodIssue[]): string[] {
  const ordinals = buildOrdinalMap(raw !== null && typeof raw === 'object' ? (raw as { steps?: unknown }).steps : undefined);
  return issues.map(issue => classifyIssue(raw, issue, ordinals).message);
}

/** One problem, addressed to a specific step and field when it names one — what an editor field's own error marker needs. */
export interface WorkflowFieldProblem {
  stepId?: string;
  field?: string;
  /** Field-local text, with no step or label prefix. */
  phrase: string;
  /** The full line, matching `formatWorkflowIssues`'s string form. */
  message: string;
}

/** Like `formatWorkflowIssues`, but keeps each issue's step id and field key alongside its wording. */
export function formatWorkflowFieldIssues(raw: unknown, issues: z.core.$ZodIssue[]): WorkflowFieldProblem[] {
  const ordinals = buildOrdinalMap(raw !== null && typeof raw === 'object' ? (raw as { steps?: unknown }).steps : undefined);
  return issues.map(issue => classifyIssue(raw, issue, ordinals));
}

/**
 * `step '<id>' references …`, `loop '<id>': until …` and `step '<id>':
 * capture …` are the `validateWorkflowSemantics` shapes an editor field can
 * point at — Reads from, Repeat until and Output filename, respectively. Any
 * other line that names a step (`loop '<id>': on_exhausted …`) still gets its
 * step id, so an editor can reveal and badge that step's card.
 */
function classifySemanticProblem(problem: string): WorkflowFieldProblem {
  const ref = /^step '([^']+)' (references.*)$/.exec(problem);
  if (ref) return { stepId: ref[1], field: 'inputs', phrase: ref[2], message: problem };
  const until = /^loop '([^']+)': (until.*)$/.exec(problem);
  if (until) return { stepId: until[1], field: 'until', phrase: until[2], message: problem };
  const capture = /^step '([^']+)': (capture.*)$/.exec(problem);
  if (capture) return { stepId: capture[1], field: 'output', phrase: capture[2], message: problem };
  const named = /^(?:step|loop) '([^']+)':/.exec(problem);
  if (named) return { stepId: named[1], phrase: problem, message: problem };
  return { phrase: problem, message: problem };
}

/**
 * `z.preprocess(..., z.string().optional())` (what `optionalText` and the
 * `expect_exit` transform are built on) can leave the parsed object holding
 * an *own key* whose value is `undefined`, rather than no key at all — zod 4
 * does not delete it. `data[key]` and `JSON.stringify` both already treat
 * that the same as absent, but `'key' in obj` and `Object.keys(obj)` do not,
 * and both `mergeWorkflow` and the desktop editor rely on real absence.
 * Strips them recursively so the returned `Workflow` never carries one.
 */
function stripUndefinedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefinedKeys) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = stripUndefinedKeys(v);
  }
  return out as T;
}

/**
 * One-stop validation for a workflow draft, however it was produced (parsed
 * YAML, or a desktop editor's in-memory object): misplaced fields, then shape
 * (formatted through `formatWorkflowIssues`), then cross-field semantics.
 * `workflow` is set whenever the shape check passed, even if semantics then
 * added problems — a caller that wants to keep editing can still read it.
 * `fieldProblems` carries the same problems as `problems`, addressed to a
 * step id and field key where one applies — what an editor uses to mark the
 * offending `Field` itself, rather than only listing the problem in a footer.
 */
export function validateWorkflowDraft(
  raw: unknown,
): { workflow?: Workflow; problems: string[]; fieldProblems: WorkflowFieldProblem[] } {
  const misplaced: string[] = [];
  checkRootFields(raw, misplaced);
  if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { steps?: unknown }).steps)) {
    for (const step of (raw as { steps: unknown[] }).steps) checkMisplacedFields(step, misplaced);
  }
  if (misplaced.length > 0) {
    return { problems: misplaced, fieldProblems: misplaced.map(m => ({ phrase: m, message: m })) };
  }

  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldProblems = formatWorkflowFieldIssues(raw, parsed.error.issues);
    return { problems: fieldProblems.map(p => p.message), fieldProblems };
  }
  const workflow = stripUndefinedKeys(parsed.data);
  const problems = validateWorkflowSemantics(workflow);
  return { workflow, problems, fieldProblems: problems.map(classifySemanticProblem) };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseWorkflow(yamlText: string): Workflow {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new WorkflowError([`YAML parse error: ${(e as Error).message}`]);
  }

  const { workflow, problems } = validateWorkflowDraft(raw);
  if (problems.length > 0) throw new WorkflowError(problems);
  return workflow!;
}
