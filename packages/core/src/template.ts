import type { LoopFrame, RunCtx } from './types.ts';
import { ATTACHMENTS_REF } from './attachments.ts';

export class TemplateError extends Error {
  constructor(message: string) { super(message); this.name = 'TemplateError'; }
}

/**
 * Everything a template can see. `RunCtx` satisfies it structurally, so every
 * call site just passes the ctx it already has; tests can pass a literal
 * without building a whole run context.
 */
export interface TemplateScope {
  inputs: Record<string, string>;
  runId: string;
  /** Path/ref-safe form of the run name, falling back to runId. Never empty. */
  runSlug: string;
  runName?: string;
  loop?: LoopFrame;
}

const PLACEHOLDER =
  /\{\{\s*(inputs\.[A-Za-z0-9_-]+|loop\.(?:iteration|max_iterations)|run\.(?:name|slug|id))\s*\}\}/g;

export function renderTemplate(tpl: string, scope: TemplateScope): string {
  return tpl.replace(PLACEHOLDER, (_m, ref: string) => {
    if (ref.startsWith('loop.')) {
      const loop = scope.loop;
      if (loop === undefined) throw new TemplateError(`'${ref}' is only available inside a loop`);
      return String(ref === 'loop.iteration' ? loop.iteration : loop.maxIterations);
    }
    // Unlike loop.*, run.* is always available — every template is rendered
    // inside a run — so there is no "not here" error case. An unnamed run
    // reads as its id, which is what every display site falls back to too.
    if (ref.startsWith('run.')) {
      if (ref === 'run.id') return scope.runId;
      if (ref === 'run.slug') return scope.runSlug;
      return scope.runName ?? scope.runId;
    }
    const key = ref.slice('inputs.'.length);
    const value = scope.inputs[key];
    if (value === undefined) throw new TemplateError(`unknown input '${key}'`);
    return value;
  });
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
    return `- ${id}: ${path}`;
  });
  return `${body}\n\n## Input artifacts (read these files first)\n${lines.join('\n')}`;
}
