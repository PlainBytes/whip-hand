import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { globalConfigPath } from './config-home.ts';
import type { WorkspaceConfig } from './types.ts';
import { WorkflowError } from './schema.ts';

/**
 * One config *layer* as hand-written in a config.yaml — every field, at every
 * depth, optional. `runs.max_retained` is the one field where "the key is
 * absent" and "the key is present and null" mean different things (inherit
 * vs. explicitly keep everything), which is why it stays `.nullable()`
 * *inside* the `.partial()`: the object's own optionality covers "absent",
 * `.nullable()` covers "present but null".
 *
 * `max_retained` is `.nonnegative()` here but `.positive()` in the resolved
 * `workspaceConfigSchema` below, and that asymmetry is deliberate: `0` was the
 * old spelling of "keep everything" and the pre-scopes settings page wrote it
 * (its SpinButton had `min={0}`), so config.yaml files containing it exist.
 * Rejecting it would make `whiphand run`, `configGet` and `startRun` all fail in
 * those workspaces with no migration to rescue them. `loadConfigLayer`
 * normalizes it to `null` instead — the same meaning, spelled the way the rest
 * of the codebase spells it — so nothing downstream ever sees a `0`.
 */
export const partialConfigSchema = z.object({
  defaults: z.object({ runner: z.string().min(1) }).partial().optional(),
  on_findings: z.enum(['report', 'loop', 'interactive']).optional(),
  loop: z.object({ max_iterations: z.number().int().positive() }).partial().optional(),
  artifacts_dir: z.string().min(1).optional(),
  runs: z.object({
    max_retained: z.number().int().nonnegative().nullable(),
    auto_name: z.boolean(),
    max_attachment_mb: z.number().positive(),
  }).partial().optional(),
});
export type PartialConfig = z.infer<typeof partialConfigSchema>;

/**
 * Every settable leaf, as the dotted key both `whiphand config` and the desktop's
 * `configSet` address it by. A fixed list rather than a generic path walker:
 * WorkspaceConfig has a handful of leaves and each has its own coercion and
 * validity rules. Lives here so the CLI and the RPC protocol share one
 * definition instead of each keeping a copy that can drift.
 */
export const CONFIG_KEYS = [
  'defaults.runner', 'on_findings', 'loop.max_iterations', 'artifacts_dir',
  'runs.max_retained', 'runs.auto_name', 'runs.max_attachment_mb',
] as const;
export type ConfigKey = typeof CONFIG_KEYS[number];
export const configKeySchema = z.enum(CONFIG_KEYS);

// Full (all-fields-required) schema for a resolved WorkspaceConfig — distinct
// from `partialConfigSchema` above, which validates the partial shape allowed
// in a hand-written config.yaml layer. Consumers (e.g. @whiphand/agent's configSet)
// that receive an already-resolved config over the wire validate against this.
export const workspaceConfigSchema: z.ZodType<WorkspaceConfig> = z.object({
  defaults: z.object({ runner: z.string().min(1) }),
  on_findings: z.enum(['report', 'loop', 'interactive']),
  loop: z.object({ max_iterations: z.number().int().positive() }),
  artifacts_dir: z.string().min(1),
  runs: z.object({
    max_retained: z.number().int().positive().nullable(),
    auto_name: z.boolean(),
    max_attachment_mb: z.number().positive(),
  }),
});

export const DEFAULT_CONFIG: WorkspaceConfig = {
  defaults: { runner: 'claude' },
  on_findings: 'report',
  loop: { max_iterations: 3 },
  artifacts_dir: '.whiphand/runs',
  runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
};

/**
 * Parses one config.yaml into a layer. A missing file is an empty layer —
 * nothing to inherit past.
 *
 * Every failure names `path`. That mattered less when the only layer was the
 * workspace's own, but a malformed *global* config.yaml fails the load in
 * every workspace on the machine, and "config: on_findings: invalid" gives no
 * hint which of the two files to go fix. A YAML syntax error is wrapped for
 * the same reason: unwrapped it escaped as a raw YAMLParseError, bypassing
 * every caller that handles WorkflowError.
 */
export async function loadConfigLayer(path: string): Promise<PartialConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  let value: unknown;
  try {
    value = parseYaml(text) ?? {};
  } catch (e) {
    throw new WorkflowError([`${path}: ${(e as Error).message}`]);
  }
  const parsed = partialConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkflowError(parsed.error.issues.map(i => {
      const at = i.path.join('.');
      return at.length > 0 ? `${path}: ${at}: ${i.message}` : `${path}: ${i.message}`;
    }));
  }
  // `0` is the retired spelling of "keep everything" — see partialConfigSchema.
  // Normalized at this one choke point so no caller has to know it ever existed.
  const layer = parsed.data;
  if (layer.runs?.max_retained === 0) return { ...layer, runs: { ...layer.runs, max_retained: null } };
  return layer;
}

/** The user-level layer, shared by every workspace on the machine. */
export async function loadGlobalConfig(): Promise<PartialConfig> {
  return loadConfigLayer(globalConfigPath());
}

/**
 * Merges layers over `base`, later layers winning — per leaf, not per
 * object: a layer that sets only `defaults.runner` must not wipe out a
 * `loop.max_iterations` supplied by an earlier one. `max_retained` is
 * checked against `undefined` specifically (not `??`, which would also
 * treat an explicit `null` as "fall through") — that distinction is the
 * whole point of the absent/null split above.
 */
export function mergeConfig(base: WorkspaceConfig, ...layers: PartialConfig[]): WorkspaceConfig {
  let result = base;
  for (const layer of layers) {
    result = {
      defaults: { runner: layer.defaults?.runner ?? result.defaults.runner },
      on_findings: layer.on_findings ?? result.on_findings,
      loop: { max_iterations: layer.loop?.max_iterations ?? result.loop.max_iterations },
      artifacts_dir: layer.artifacts_dir ?? result.artifacts_dir,
      runs: {
        max_retained: layer.runs?.max_retained !== undefined
          ? layer.runs.max_retained
          : result.runs.max_retained,
        auto_name: layer.runs?.auto_name ?? result.runs.auto_name,
        max_attachment_mb: layer.runs?.max_attachment_mb ?? result.runs.max_attachment_mb,
      },
    };
  }
  return result;
}

/**
 * The layer `full` would need to be written on top of `base` for
 * `mergeConfig(base, thatLayer)` to reproduce `full` exactly: only the
 * leaves that actually differ. What `configSet` writes, so that saving the
 * settings page records genuine overrides and later changes to the layer
 * beneath keep propagating through the fields nobody touched.
 *
 * `explicit` names leaves to write even when they equal `base` — the caller
 * asserting "this workspace is pinned here", not "this happens to be the
 * value today". Without it a pin whose value coincides with the layer beneath
 * is unrepresentable: the diff drops it, and a later change underneath
 * silently moves the workspace that thought it had opted out. Value equality
 * alone can't tell the two apart, which is why the intent has to come from
 * the caller rather than be inferred here.
 */
export function diffConfigLayer(
  full: WorkspaceConfig, base: WorkspaceConfig, explicit: readonly ConfigKey[] = [],
): PartialConfig {
  const pinned = (key: ConfigKey): boolean => explicit.includes(key);
  const layer: PartialConfig = {};
  if (pinned('defaults.runner') || full.defaults.runner !== base.defaults.runner) {
    layer.defaults = { runner: full.defaults.runner };
  }
  if (pinned('on_findings') || full.on_findings !== base.on_findings) layer.on_findings = full.on_findings;
  if (pinned('loop.max_iterations') || full.loop.max_iterations !== base.loop.max_iterations) {
    layer.loop = { max_iterations: full.loop.max_iterations };
  }
  if (pinned('artifacts_dir') || full.artifacts_dir !== base.artifacts_dir) {
    layer.artifacts_dir = full.artifacts_dir;
  }
  // Every runs.* leaf builds up one `runs` object: assigning layer.runs twice
  // would drop whichever was written first.
  const runs: NonNullable<PartialConfig['runs']> = {};
  if (pinned('runs.max_retained') || full.runs.max_retained !== base.runs.max_retained) {
    runs.max_retained = full.runs.max_retained;
  }
  if (pinned('runs.auto_name') || full.runs.auto_name !== base.runs.auto_name) {
    runs.auto_name = full.runs.auto_name;
  }
  if (pinned('runs.max_attachment_mb') || full.runs.max_attachment_mb !== base.runs.max_attachment_mb) {
    runs.max_attachment_mb = full.runs.max_attachment_mb;
  }
  // Values are only set above when they differ, so an all-undefined `runs`
  // means "nothing to write" — and `runs: {}` in a layer file would read as an
  // override where an omitted scalar leaf reads as inheritance.
  if (Object.values(runs).some(v => v !== undefined)) layer.runs = runs;
  return layer;
}

/**
 * The fully resolved config a workspace runs with: DEFAULT_CONFIG, with the
 * global layer applied, with the project's own `.whiphand/config.yaml` applied on
 * top.
 */
export async function loadWorkspaceConfig(workdir: string): Promise<WorkspaceConfig> {
  const [global, project] = await Promise.all([
    loadGlobalConfig(),
    loadConfigLayer(join(workdir, '.whiphand', 'config.yaml')),
  ]);
  return mergeConfig(DEFAULT_CONFIG, global, project);
}
