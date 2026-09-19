/**
 * Asking the default runner to name a run that was started without a name.
 *
 * Off unless `runs.auto_name` is set, and best-effort throughout: a runner
 * that cannot answer, a spawn that fails, a timeout, or a reply with nothing
 * usable in it all leave the run unnamed. Nothing here may fail or meaningfully
 * delay a run — the name is a convenience, and a run reads perfectly well as
 * its id without one.
 *
 * It happens at run *start*, before the first step, rather than at the end
 * where a summary of what actually happened would be a better name: `{{
 * run.slug }}` exists so step one can create a worktree or a branch, and a name
 * minted afterwards is too late to be one.
 */
import { writeSpecFiles } from './spawn-files.ts';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunCtx, SpawnSpec, Workflow } from '../types.ts';
import type { AdapterRegistry } from '../registry.ts';
import { normalizeRunName, setRunName, SUGGEST_CAPTURE_NAME } from './run-name.ts';

/** How long the naming spawn gets before the run carries on without a name. */
export const SUGGEST_TIMEOUT_MS = 20_000;

/**
 * Deliberately terse, and it names the constraints rather than trusting the
 * model to guess them: the reply is used verbatim as a label and, slugified,
 * as a branch name.
 */
export function suggestNamePrompt(workflow: Workflow, inputs: Record<string, string>): string {
  const shown = Object.entries(inputs)
    .filter(([, v]) => v.trim().length > 0)
    .map(([k, v]) => `- ${k}: ${v.slice(0, 400)}`);
  return [
    `Name this run of the '${workflow.name}' workflow in 2-5 words, so a human`,
    'scanning a list of runs can tell what it was about.',
    '',
    ...(shown.length === 0 ? ['It was started with no inputs.'] : ['Its inputs are:', ...shown]),
    '',
    'Reply with the name alone: no quotes, no punctuation at the end, no preamble,',
    'no explanation. Do not use any tools.',
  ].join('\n');
}

export interface AutoNameOptions {
  ctx: RunCtx;
  workflow: Workflow;
  registry: AdapterRegistry;
  /** The workspace's default runner — the one that gets asked. */
  runner: string;
  spawnHeadless?: (spec: SpawnSpec, signal?: AbortSignal) => Promise<number>;
  /** The run's own signal: a cancelled run must not sit here waiting. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Names the run if it can, writing the `.name` marker and returning the name.
 * Returns undefined — never throws — whenever it cannot.
 */
export async function autoNameRun(opts: AutoNameOptions): Promise<string | undefined> {
  const { ctx, workflow, registry, runner } = opts;
  if (!registry.has(runner)) return undefined;
  const adapter = registry.get(runner);
  if (adapter.suggestName === undefined) return undefined;

  const capturePath = join(ctx.runDir, SUGGEST_CAPTURE_NAME);
  let spec: SpawnSpec;
  try {
    spec = adapter.suggestName(suggestNamePrompt(workflow, ctx.inputs), ctx, capturePath);
  } catch {
    return undefined;
  }
  if (opts.spawnHeadless === undefined) return undefined;

  // Its own controller, chained to the run's: the timeout must be able to give
  // up on the naming spawn without touching the run, and a cancelled run must
  // still not leave this one running. Wired up before the first `await` below,
  // and re-checked after it, because a run cancelled in that window would
  // otherwise never reach the listener and would sit out the whole timeout.
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, opts.timeoutMs ?? SUGGEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    // Both capture implementations open the file in append mode, so a
    // `.name.suggest` that outlived a crashed run would be prepended to this
    // reply and become part of the name. The `finally` below is the normal
    // cleanup; this is the one that covers the abnormal exit.
    await rm(capturePath, { force: true }).catch(() => {});
    if (opts.signal?.aborted === true) return undefined;
    // The naming prompt rides in a file like any other. Naming is best-effort,
    // so a file that cannot be written just means no name (the catch below).
    await writeSpecFiles(spec);

    const exitCode = await opts.spawnHeadless(spec, controller.signal);
    if (exitCode !== 0) return undefined;
    const name = normalizeRunName(await readFile(capturePath, 'utf8'));
    if (name === null) return undefined;
    await setRunName(ctx.runDir, name);
    return name;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
    // The reply has been folded into the marker; leaving it behind would just
    // be a second, staler copy of the same string in the run directory.
    await rm(capturePath, { force: true }).catch(() => {});
    for (const file of spec.files ?? []) await rm(file.path, { force: true }).catch(() => {});
  }
}
