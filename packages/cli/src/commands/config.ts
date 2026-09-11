import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  CONFIG_KEYS, DEFAULT_CONFIG, diffConfigLayer, globalConfigPath, loadGlobalConfig,
  loadWorkspaceConfig, mergeConfig,
} from '@whiphand/core';
import type { ConfigKey, OnFindings, WorkspaceConfig } from '@whiphand/core';

export interface ConfigCommandOptions {
  global: boolean;
  cwd: string;
}

// The set of dotted keys `whiphand config` understands is @whiphand/core's CONFIG_KEYS —
// the same list `diffConfigLayer`'s `explicit` argument and the RPC protocol's
// `explicitKeys` are typed against, so the CLI and the desktop can't drift.
function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function unknownKeyMessage(key: string): string {
  return `unknown config key '${key}' — want one of: ${CONFIG_KEYS.join(', ')}`;
}

function readLeaf(config: WorkspaceConfig, key: ConfigKey): string {
  switch (key) {
    case 'defaults.runner': return config.defaults.runner;
    case 'on_findings': return config.on_findings;
    case 'loop.max_iterations': return String(config.loop.max_iterations);
    case 'artifacts_dir': return config.artifacts_dir;
    case 'runs.max_retained': return config.runs.max_retained === null ? 'null' : String(config.runs.max_retained);
    case 'runs.auto_name': return String(config.runs.auto_name);
    case 'runs.max_attachment_mb': return String(config.runs.max_attachment_mb);
  }
}

function coerceLeaf(key: ConfigKey, raw: string): string | number | boolean | null {
  switch (key) {
    case 'defaults.runner':
    case 'artifacts_dir':
      if (raw.length === 0) throw new Error(`'${key}' cannot be empty`);
      return raw;
    case 'on_findings':
      if (raw !== 'report' && raw !== 'loop' && raw !== 'interactive') {
        throw new Error(`'${key}' must be one of: report, loop, interactive`);
      }
      return raw;
    case 'loop.max_iterations':
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`'${key}' must be a positive integer`);
      return Number(raw);
    case 'runs.max_retained':
      if (raw === 'null') return null;
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        throw new Error(`'${key}' must be a positive integer, or 'null' to keep every run`);
      }
      return Number(raw);
    case 'runs.auto_name':
      if (raw !== 'true' && raw !== 'false') throw new Error(`'${key}' must be true or false`);
      return raw === 'true';
    case 'runs.max_attachment_mb':
      // A cap, not a count: 0.5 MB is a perfectly good one.
      if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) {
        throw new Error(`'${key}' must be a positive number of megabytes`);
      }
      return Number(raw);
  }
}

function withLeaf(
  config: WorkspaceConfig, key: ConfigKey, value: string | number | boolean | null,
): WorkspaceConfig {
  switch (key) {
    case 'defaults.runner': return { ...config, defaults: { runner: value as string } };
    case 'on_findings': return { ...config, on_findings: value as OnFindings };
    case 'loop.max_iterations': return { ...config, loop: { max_iterations: value as number } };
    case 'artifacts_dir': return { ...config, artifacts_dir: value as string };
    case 'runs.max_retained':
      return { ...config, runs: { ...config.runs, max_retained: value as number | null } };
    case 'runs.auto_name':
      return { ...config, runs: { ...config.runs, auto_name: value as boolean } };
    case 'runs.max_attachment_mb':
      return { ...config, runs: { ...config.runs, max_attachment_mb: value as number } };
  }
}

export function projectConfigPath(cwd: string): string {
  return join(resolve(cwd), '.whiphand', 'config.yaml');
}

/** Usage errors exit 2, matching `whiphand run`'s convention. */
const USAGE_ERROR = 2;

export async function configGetCommand(key: string | undefined, opts: ConfigCommandOptions): Promise<number> {
  const config = opts.global
    ? mergeConfig(DEFAULT_CONFIG, await loadGlobalConfig())
    : await loadWorkspaceConfig(resolve(opts.cwd));

  if (key === undefined) {
    process.stdout.write(stringifyYaml(config));
    return 0;
  }
  if (!isConfigKey(key)) {
    console.error(unknownKeyMessage(key));
    return USAGE_ERROR;
  }
  console.log(readLeaf(config, key));
  return 0;
}

export async function configSetCommand(
  key: string, value: string, opts: ConfigCommandOptions,
): Promise<number> {
  if (!isConfigKey(key)) {
    console.error(unknownKeyMessage(key));
    return USAGE_ERROR;
  }
  let coerced: string | number | boolean | null;
  try {
    coerced = coerceLeaf(key, value);
  } catch (e) {
    console.error((e as Error).message);
    return USAGE_ERROR;
  }

  const global = await loadGlobalConfig();
  // What this write's layer sits on top of — DEFAULT_CONFIG itself for a
  // global write, or DEFAULT_CONFIG-plus-global for a project write. Diffing
  // the desired full config against exactly this is what keeps the write to
  // "only what actually differs", so an unrelated global change keeps
  // propagating through every field this command didn't touch.
  const base = opts.global ? DEFAULT_CONFIG : mergeConfig(DEFAULT_CONFIG, global);
  const currentFull = opts.global
    ? mergeConfig(DEFAULT_CONFIG, global)
    : await loadWorkspaceConfig(resolve(opts.cwd));
  const desiredFull = withLeaf(currentFull, key, coerced);
  const layer = diffConfigLayer(desiredFull, base);

  const path = opts.global ? globalConfigPath() : projectConfigPath(opts.cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml(layer), 'utf8');
  console.log(`set ${key} = ${readLeaf(desiredFull, key)} (${opts.global ? 'global' : 'project'})`);
  return 0;
}
