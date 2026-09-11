import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { LoopStep, Workflow, Step, StepKind } from './types.ts';
import { isLoopStep, isManualStep } from './steps.ts';
import { ATTACHMENTS_REF } from './attachments.ts';

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

const baseFields = {
  id: z.string().min(1),
  inputs: z.array(z.string().min(1)).optional(),
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
  runner: z.string().min(1),
  model: z.string().min(1).optional(),
  mode: z.enum(['interactive', 'headless']),
  writes: z.boolean(),
  prompt: z.string().min(1),
  output: z.string().min(1),
  allow_paths: z.array(z.string().min(1)).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

/** `expect_exit: 0` and `expect_exit: [0, 1]` both normalize to an array. */
const expectExitSchema = z
  .union([z.number().int(), z.array(z.number().int()).min(1)])
  .transform(v => (Array.isArray(v) ? v : [v]));

const commandStepSchema = z.object({
  ...baseFields,
  kind: z.literal('command'),
  run: z.string().min(1),
  shell: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
  expect_exit: expectExitSchema.optional(),
  output: z.string().min(1).optional(),
});

/** 'manual' and 'approval' are the same shape; two literals so the union stays discriminated. */
function manualShape<K extends 'manual' | 'approval'>(kind: K) {
  return z.object({
    ...baseFields,
    kind: z.literal(kind),
    title: z.string().min(1),
    instructions: z.string().min(1),
    capture: z.enum(['note', 'review']).optional(),
    show_diff: z.boolean().optional(),
    default: z.enum(['continue', 'abort']).optional(),
    output: z.string().min(1).optional(),
  });
}

const loopStepSchema = z.object({
  kind: z.literal('loop'),
  id: z.string().min(1),
  steps: z.array(stepSchema).min(1),
  until: z.string().min(1),
  max_iterations: z.number().int().positive().optional(),
  on_exhausted: z.enum(['report', 'loop', 'interactive']).optional(),
  enabled: z.boolean().optional(),
});

/** A step object with no `kind:` is an agent step — the only kind that used to exist. */
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
  ]),
);

export const workflowSchema: z.ZodType<Workflow, unknown> = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputs: z.record(z.string(), z.object({
    required: z.boolean(),
    prompt: z.string().optional(),
    default: z.string().optional(),
    remember: z.boolean().optional(),
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
};

/** 'approval' shares every field with 'manual'. */
function ownerMatches(owner: StepKind, kind: StepKind): boolean {
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
    if (owner === undefined || ownerMatches(owner, kind)) continue;
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
}

function locate(steps: Step[], prefix: number[], loopChain: string[], out: Located[]): void {
  steps.forEach((step, idx) => {
    const path = [...prefix, idx];
    out.push({ step, path, parentLoopId: loopChain.at(-1), loopChain });
    if (isLoopStep(step)) locate(step.steps, path, [...loopChain, step.id], out);
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

/**
 * Cross-field checks zod's shape validation can't express: id uniqueness across
 * the whole tree, artifact-reference direction, and loop wiring.
 */
export function validateWorkflowSemantics(workflow: Workflow): string[] {
  const problems: string[] = [];

  const located: Located[] = [];
  locate(workflow.steps, [], [], located);

  const byId = new Map<string, Located>();
  for (const entry of located) {
    if (entry.step.id === ATTACHMENTS_REF) {
      // As a loop id it would also be the directory the attached files are
      // copied into; as a step id, `inputs: [attachments]` would be ambiguous.
      problems.push(`${isLoopStep(entry.step) ? 'loop' : 'step'} id '${ATTACHMENTS_REF}' is reserved `
        + `for the files attached to a run; rename it`);
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

    if (isManualStep(step) && step.capture !== undefined && !step.output) {
      problems.push(`step '${step.id}': capture '${step.capture}' needs an 'output' to write it to`);
    }

    for (const ref of step.inputs ?? []) {
      // Not a step: the files attached to the run, which exist before step
      // one, so there is no ordering or artifact to check.
      if (ref === ATTACHMENTS_REF) continue;
      const tgt = byId.get(ref);
      if (tgt === undefined) {
        problems.push(`step '${step.id}' references unknown step '${ref}'`);
        continue;
      }
      if (isLoopStep(tgt.step)) {
        problems.push(`step '${step.id}' references loop '${ref}', which produces no artifact`);
        continue;
      }
      if (!tgt.step.output) {
        problems.push(`step '${step.id}' references step '${ref}', which produces no artifact`);
        continue;
      }
      const order = comparePaths(tgt.path, src.path);
      if (order === 0) {
        problems.push(`step '${step.id}' references itself`);
      } else if (order > 0) {
        // A later step is only referenceable when it belongs to a loop that
        // encloses the referencing step — however deeply nested the
        // referencer is inside it, the reference means "that step's artifact
        // from that loop's previous iteration".
        const sameBody = tgt.parentLoopId !== undefined && src.loopChain.includes(tgt.parentLoopId);
        if (!sameBody) problems.push(`step '${step.id}' references later step '${ref}'`);
      }
    }
  }

  return problems;
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
  if (isLoopStep(target) || !target.verdict) {
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

  const misplaced: string[] = [];
  checkRootFields(raw, misplaced);
  if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { steps?: unknown }).steps)) {
    for (const step of (raw as { steps: unknown[] }).steps) checkMisplacedFields(step, misplaced);
  }
  if (misplaced.length > 0) throw new WorkflowError(misplaced);

  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowError(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`));
  }
  const workflow = parsed.data;
  const problems = validateWorkflowSemantics(workflow);
  if (problems.length > 0) throw new WorkflowError(problems);
  return workflow;
}
