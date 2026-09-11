/**
 * The user-level ("global") config root: global workflow definitions
 * (`workflows/*.yaml`) and, from Phase 2, a global `config.yaml` — the
 * counterpart to each workspace's own `.whiphand/`.
 *
 * Lives in @whiphand/core, not @whiphand/agent, because both workspace.ts (global
 * workflows) and config.ts (global config) need it, and the CLI reaches them
 * without going through the agent.
 *
 * Deliberately shares its parent directory with @whiphand/agent's app-state.json on
 * darwin/win32 (`Application Support` / `AppData\Roaming`) — the two answer
 * different questions (config vs. data) so @whiphand/agent keeps its own,
 * near-identical platform switch in app-state.ts rather than sharing this
 * one; see the comment there. Unlike app-state.json, deleting this directory
 * is not a zero-cost cache eviction — it holds global workflow definitions
 * and (from Phase 2) global config, which are sources of truth.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveConfigHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.WHIPHAND_CONFIG_HOME) return env.WHIPHAND_CONFIG_HOME;
  const dir =
    platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
    : (env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return join(dir, 'whiphand');
}

export function globalWorkflowsDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return join(resolveConfigHome(env, platform, home), 'workflows');
}

export function globalConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return join(resolveConfigHome(env, platform, home), 'config.yaml');
}
