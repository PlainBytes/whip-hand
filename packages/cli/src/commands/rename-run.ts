import { resolve } from 'node:path';
import { loadWorkspaceConfig, renameRun } from '@whiphand/core';

/** Usage errors exit 2; a run that legitimately failed exits 1. */
const USAGE_ERROR = 2;

export interface RenameRunCommandOptions {
  cwd: string;
}

/**
 * Sets or clears one run's display label. An empty name clears it, which is
 * the CLI's spelling of the RPC's `null` — there is no separate --clear flag
 * to get wrong.
 */
export async function renameRunCommand(
  runId: string, name: string, opts: RenameRunCommandOptions,
): Promise<number> {
  const workdir = resolve(opts.cwd);
  const config = await loadWorkspaceConfig(workdir);
  const result = await renameRun(workdir, config, runId, name);
  if (!result.renamed) {
    console.error(`✘ no run '${runId}' under ${config.artifacts_dir}`);
    return USAGE_ERROR;
  }
  console.log(result.name === undefined
    ? `${runId} — name cleared`
    : `${runId} — ${result.name}`);
  return 0;
}
