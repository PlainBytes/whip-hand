/**
 * The pieces every runner adapter builds its spawns from, kept here so the
 * three adapters differ only where their CLIs genuinely do — flag names,
 * prompt placement, permission mechanics — and never in the plumbing around
 * them. Each helper exists because the same few lines had been copy-pasted
 * into claude, copilot and opencode, and copies are what drift.
 *
 * Everything here is argv-neutral: it only ever emits exactly what the
 * adapter hands it, so the argv each adapter produces (pinned by the adapter
 * tests and the parity fixtures) is unaffected by the sharing.
 */
import type { AgentStep, ModelInfo, ModelList, RunCtx, SpawnSpec } from '../types.ts';
import { execRunner } from '../exec.ts';
import { PROBE_TIMEOUT_MS } from '../tools.ts';

/**
 * `[flag, value]` when the value is set, nothing otherwise. Truthiness rather
 * than `!== undefined` on purpose: an empty `model:` in a workflow means "the
 * runner's default", and passing `--model ''` would instead ask the runner
 * for a model named nothing.
 */
export function flagArgs(flag: string, value: string | undefined): string[] {
  return value ? [flag, value] : [];
}

/**
 * The fields every SpawnSpec carries. `env` defaults to empty — claude and
 * copilot inherit whiphand's environment untouched — while opencode passes
 * its per-spawn `OPENCODE_CONFIG_CONTENT` through it.
 */
export function spawnSpec(
  ctx: RunCtx, argv: string[], interactive: boolean, env: Record<string, string> = {},
): SpawnSpec {
  return { argv, cwd: ctx.workdir, env, interactive };
}

/**
 * The step's session id, or a throw naming the step. A missing id is a
 * runner-engine bug, never a user error, so failing loudly at spec-build time
 * beats spawning a runner with `undefined` in its argv.
 *
 * `missing` completes "no session id … for step": the adapters that inject an
 * id say it was never `minted`, while opencode (which captures its id after
 * the interactive spawn) says it was not `captured yet` — the distinction is
 * the first thing anyone debugging that throw needs to know.
 */
export function requireSessionId(step: AgentStep, ctx: RunCtx, missing: string): string {
  const sid = ctx.sessionIds[step.id];
  if (!sid) throw new Error(`no session id ${missing} for step '${step.id}'`);
  return sid;
}

/**
 * Whether this spawn continues a session rather than starting one. Only a
 * resumed run sets `resumedStepIds`, and only for a step the manifest saw
 * spawn a session — "the step started" is not enough, because step:start
 * fires before the prompt is built and a step that dies in between leaves its
 * id naming nothing (see planResume, which is where the set is built).
 */
export function isResumedStep(step: AgentStep, ctx: RunCtx): boolean {
  return ctx.resumedStepIds?.has(step.id) === true;
}

/**
 * Runs a model-listing command and parses its stdout. `source: 'unavailable'`
 * (not 'fallback') on any failure *and* on an empty parse — neither copilot
 * nor opencode has static aliases of its own to fall back to, and
 * 'unavailable' is what tells the editor to show plain free text with no
 * warnings. An empty parse is folded in with a failed spawn because a changed
 * output format must degrade to no suggestions, not to "this runner has no
 * models". claude's probe is richer (a live protocol with alias fallback) and
 * lives in claude-models.ts instead.
 */
export async function listModelsVia(
  argv: string[], parse: (stdout: string) => ModelInfo[],
): Promise<ModelList> {
  try {
    const { stdout } = await execRunner(argv, { timeout: PROBE_TIMEOUT_MS });
    const models = parse(stdout);
    if (models.length === 0) return { source: 'unavailable', models: [] };
    return { source: 'live', models };
  } catch {
    return { source: 'unavailable', models: [] };
  }
}

/**
 * The prompt every resume-based harvest sends: "write the artifact we agreed
 * on, then say done." Shared by claude, copilot and opencode — the three
 * adapters that harvest by resuming the interactive session itself, rather
 * than reading a transcript file — so the wording can't drift between them.
 */
export function harvestPrompt(step: AgentStep, ctx: RunCtx): string {
  const path = `${ctx.runDir}/${step.output}`;
  return `Write the final '${step.output}' artifact we agreed on in this conversation to ${path}. ` +
    `Write only the artifact content to that file, then reply with just: done`;
}
