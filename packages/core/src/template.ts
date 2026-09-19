import type { Frame, LoopFrame, RunCtx } from './types.ts';
import { ATTACHMENTS_REF } from './attachments.ts';
import { nearestLoop, nearestStage } from './execution-key.ts';
import { toFwdAbs, toWorkspace } from './path-form.ts';

export class TemplateError extends Error {
  constructor(message: string) { super(message); this.name = 'TemplateError'; }
}

/**
 * Everything a template can see. `RunCtx` satisfies it structurally, so every
 * call site just passes the ctx it already has; tests can pass a literal
 * without building a whole run context.
 *
 * `frame` is the execution's actual construct chain (loop, stage, or both
 * nested); `loop` stays alongside it — rather than being derived and
 * discarded — for a caller with no frame of its own to build (a bare literal
 * in a test, `ManualRequest.loop`), which is why `loop.*` below prefers
 * `nearestLoop(scope.frame)` but still falls back to it.
 */
export interface TemplateScope {
  inputs: Record<string, string>;
  runId: string;
  /** Path/ref-safe form of the run name, falling back to runId. Never empty. */
  runSlug: string;
  runName?: string;
  /**
   * The run's directory, absolute. Optional so a bare literal in a test need
   * not invent one; `{{ run.dir }}` against a scope without it is a
   * `TemplateError` rather than the text `undefined`. `RunCtx` always has it.
   */
  runDir?: string;
  loop?: LoopFrame;
  frame?: Frame;
}

/**
 * `stepId` -> the env var a command reaches its artifact through, e.g.
 * 'execute-report' -> 'WHIPHAND_ARTIFACT_EXECUTE_REPORT'.
 */
export function artifactEnvName(stepId: string): string {
  return `WHIPHAND_ARTIFACT_${stepId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** `inputs.<key>` -> `WHIPHAND_INPUT_<KEY>`: uppercased, `-` becoming `_`. */
export function inputEnvName(key: string): string {
  return `WHIPHAND_INPUT_${key.toUpperCase().replace(/-/g, '_')}`;
}

const PLACEHOLDER =
  /\{\{\s*(inputs\.[A-Za-z0-9_-]+|loop\.(?:iteration|max_iterations)|stage\.(?:index|total|id|title)|run\.(?:name|slug|id|dir))\s*\}\}/g;

/**
 * One resolved placeholder: the `{{ ref }}` a template names, the environment
 * variable a command step sees it through, and its value. The single table
 * behind both renderers *and* `commandSpec`'s env map, so "what `run:` refers to"
 * and "what the environment holds" cannot drift apart.
 */
export interface Binding {
  ref: string;
  envName: string;
  value: string;
}

const REF_FIELDS = {
  'run.id': 'WHIPHAND_RUN_ID',
  'run.slug': 'WHIPHAND_RUN_SLUG',
  'run.name': 'WHIPHAND_RUN_NAME',
  'run.dir': 'WHIPHAND_RUN_DIR',
  'stage.index': 'WHIPHAND_STAGE_INDEX',
  'stage.total': 'WHIPHAND_STAGE_TOTAL',
  'stage.id': 'WHIPHAND_STAGE_ID',
  'stage.title': 'WHIPHAND_STAGE_TITLE',
  'loop.iteration': 'WHIPHAND_LOOP_ITERATION',
  'loop.max_iterations': 'WHIPHAND_LOOP_MAX_ITERATIONS',
} as const;

/** Resolves one ref against the scope, with the errors `renderTemplate` always gave. */
function bind(ref: string, scope: TemplateScope): Binding {
  if (ref.startsWith('loop.')) {
    const loop = nearestLoop(scope.frame) ?? scope.loop;
    if (loop === undefined) throw new TemplateError(`'${ref}' is only available inside a loop`);
    return {
      ref, envName: REF_FIELDS[ref as 'loop.iteration' | 'loop.max_iterations'],
      value: String(ref === 'loop.iteration' ? loop.iteration : loop.maxIterations),
    };
  }
  if (ref.startsWith('stage.')) {
    const stageFrame = nearestStage(scope.frame);
    if (stageFrame === undefined) throw new TemplateError(`'${ref}' is only available inside a stages step`);
    const field = ref.slice('stage.'.length) as 'index' | 'total' | 'id' | 'title';
    return { ref, envName: REF_FIELDS[ref as 'stage.index'], value: String(stageFrame.stage[field]) };
  }
  // Unlike loop.*/stage.*, run.* is always available — every template is
  // rendered inside a run — so the only "not here" case is a scope built
  // without a run dir (a test literal). An unnamed run reads as its id,
  // which is what every display site falls back to too.
  if (ref.startsWith('run.')) {
    // Absolute with forward slashes — the value `$WHIPHAND_RUN_DIR` holds, so
    // one name means one thing. (A glob over it, as `items:` does, inherits
    // the limit that `[`, `*`, `?` or `{` in the workdir path read as glob
    // syntax.)
    if (ref === 'run.dir') {
      if (scope.runDir === undefined) throw new TemplateError(`'${ref}' needs a run directory, and this scope has none`);
      return { ref, envName: REF_FIELDS['run.dir'], value: toFwdAbs(scope.runDir) };
    }
    // An unnamed run's name *is* its id, so `{{ run.name }}` refers to
    // WHIPHAND_RUN_ID and WHIPHAND_RUN_NAME stays unset — "absent rather than
    // empty" is a contract templates lean on (`${WHIPHAND_RUN_NAME:-…}`).
    if (ref === 'run.name' && scope.runName === undefined) return { ref, envName: REF_FIELDS['run.id'], value: scope.runId };
    const value = ref === 'run.id' ? scope.runId : ref === 'run.slug' ? scope.runSlug : scope.runName!;
    return { ref, envName: REF_FIELDS[ref as 'run.id'], value };
  }
  const key = ref.slice('inputs.'.length);
  const value = scope.inputs[key];
  if (value === undefined) throw new TemplateError(`unknown input '${key}'`);
  return { ref, envName: inputEnvName(key), value };
}

/** Every ref a template names, in order of appearance, without duplicates. */
export function referencedRefs(tpl: string): string[] {
  return [...new Set([...tpl.matchAll(PLACEHOLDER)].map(m => m[1]))];
}

/**
 * The binding table for a scope: every placeholder that resolves *here* —
 * `run.*` always, `stage.*` inside a stages step, `loop.*` inside a loop, and
 * one `inputs.<key>` per input. (Which inputs a command actually exports is
 * decided per step from what it references; see command.ts.)
 */
export function bindings(scope: TemplateScope): Binding[] {
  const out: Binding[] = [];
  const refs = [
    'run.id', 'run.slug', 'run.name',
    ...(scope.runDir === undefined ? [] : ['run.dir']),
    ...(nearestStage(scope.frame) === undefined ? [] : ['stage.index', 'stage.total', 'stage.id', 'stage.title']),
    ...((nearestLoop(scope.frame) ?? scope.loop) === undefined ? [] : ['loop.iteration', 'loop.max_iterations']),
    ...Object.keys(scope.inputs).filter(k => INPUT_KEY.test(k)).map(k => `inputs.${k}`),
  ];
  for (const ref of refs) out.push(bind(ref, scope));
  return out;
}

const INPUT_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * The *value* renderer: `{{ x }}` becomes the value itself. For prose and data
 * — agent prompts, manual-step instructions, `cwd`, `env` values, `allow_paths`
 * globs — where the result is read, never parsed by a shell.
 */
export function renderTemplate(tpl: string, scope: TemplateScope): string {
  return tpl.replace(PLACEHOLDER, (_m, ref: string) => bind(ref, scope).value);
}

/**
 * The *reference* renderer, for a command step's `run:` only (invariant 8:
 * values are data, never syntax). `{{ x }}` becomes a variable reference —
 * `${WHIPHAND_X}`, unquoted — not the value, so the substitution happens in the
 * shell, where it is data. Parameter expansion never re-parses a value: no `;`,
 * `$(…)` or backtick in it is executed, so this is injection-safe in every
 * context. Inside `"…"` and heredocs it behaves as expected; as a bare word it
 * word-splits and globs like any unquoted shell variable ("quote it the way you
 * would any shell variable"). No quote-state scanner: unquoted is always safe,
 * merely sometimes surprising, and never a hole.
 *
 * Still resolves each ref, so an unknown input or a `loop.*` outside a loop is
 * refused exactly as before. Returns the bindings it used, which is what the
 * command's environment is built from.
 */
export function renderReferences(tpl: string, scope: TemplateScope): { text: string; used: Binding[] } {
  const used = new Map<string, Binding>();
  const text = tpl.replace(PLACEHOLDER, (_m, ref: string) => {
    const binding = bind(ref, scope);
    used.set(ref, binding);
    return `\${${binding.envName}}`;
  });
  return { text, used: [...used.values()] };
}

/**
 * Any step that carries prose and may reference earlier artifacts. Structural
 * rather than a named step type so agent prompts and manual instructions share
 * one renderer.
 */
export interface Templated {
  prompt: string;
  inputs?: string[];
}

/**
 * One `{ id, path }` per file a step's `inputs:` names, in order. A step id
 * names its artifact; the reserved ref `attachments` names every attached
 * file, labelled by its place in the run dir (`attachments/bug.png`) — and
 * nothing at all when the run has none, the way the runner drops it.
 */
export function inputArtifacts(
  refs: readonly string[], ctx: Pick<RunCtx, 'artifacts' | 'attachments'>,
): Array<{ id: string; path: string | undefined }> {
  return refs.flatMap(id => id === ATTACHMENTS_REF
    ? (ctx.attachments ?? []).map(path => ({ id: `${ATTACHMENTS_REF}/${path.split(/[\\/]/).pop()}`, path }))
    : [{ id, path: ctx.artifacts[id] }]);
}

export function buildPrompt(step: Templated, ctx: RunCtx): string {
  const body = renderTemplate(step.prompt, ctx).trimEnd();
  const inputs = inputArtifacts(step.inputs ?? [], ctx);
  if (inputs.length === 0) return body;
  const lines = inputs.map(({ id, path }) => {
    if (path === undefined) throw new TemplateError(`no artifact recorded for step '${id}'`);
    // attachments/* entries name a file, not a step, so they never carry a verdict.
    const verdict = id.startsWith(`${ATTACHMENTS_REF}/`) ? undefined : ctx.verdicts[id];
    const label = verdict === undefined ? '' : ` (VERDICT: ${verdict.toUpperCase()})`;
    // Workspace-relative, forward slashes: one path style in every prompt (the
    // runner's cwd is the workspace root, so it resolves).
    return `- ${id}: ${toWorkspace(path, ctx.workdir)}${label}`;
  });
  return `${body}\n\n## Input artifacts (read these files first)\n${lines.join('\n')}`;
}
