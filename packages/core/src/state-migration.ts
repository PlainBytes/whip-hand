/**
 * One-time move of the state directories the product used under its earlier
 * names: `<root>/mission-control` or `<root>/whip-hand` becomes
 * `<root>/whiphand`.
 *
 * Two legacy names because the rename landed in two steps. `whip-hand` was
 * never released, but it did run locally between the two, so it can exist on a
 * developer's machine holding a real remote-access token — and a token that is
 * silently regenerated invalidates every browser link already handed out. They
 * are tried oldest first, so a machine carrying both ends up on the newer one.
 *
 * Lives here rather than in config-home.ts because that module is deliberately
 * read-only (see its header), and here rather than in @whiphand/agent because the CLI
 * reaches global config without going through the agent and needs the same
 * move. It re-derives the OS roots instead of importing the resolvers: the
 * resolvers now answer "where does state live *today*", and this answers "where
 * did it live *before*" — the same deliberate duplication config-home.ts and
 * app-state.ts already keep between themselves.
 *
 * Idempotent, and a no-op once there is nothing left to move. Never throws:
 * losing the old recent-workspace list is a papercut, but failing to start
 * because a directory could not be renamed is not.
 */
import { rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Oldest first: a machine carrying both should end up on the newer one. */
const LEGACY_DIRS = ['mission-control', 'whip-hand'] as const;
const CURRENT_DIR = 'whiphand';

/**
 * Any of these means the caller is placing state itself — a test, a sandbox, a
 * packaging harness — so the default locations are not ours to touch. Without
 * this guard the test suites, which point WHIPHAND_CONFIG_HOME at a temp dir, would
 * still march over a real `~/.config/mission-control` on the developer's box.
 */
const OVERRIDES = ['WHIPHAND_CONFIG_HOME', 'WHIPHAND_APP_STATE_FILE', 'WHIPHAND_REMOTE_CONFIG_FILE'] as const;

/**
 * The OS roots that have held our state. Config and data are the same directory
 * on darwin and win32 and different on Linux, so this can yield one root or two.
 */
function stateRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const shared =
    platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
    : undefined;
  if (shared !== undefined) return [shared];
  return [
    env.XDG_CONFIG_HOME ?? join(home, '.config'),
    env.XDG_DATA_HOME ?? join(home, '.local', 'share'),
  ];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function migrateLegacyStateDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): Promise<void> {
  if (OVERRIDES.some(name => env[name])) return;

  for (const root of new Set(stateRoots(env, platform, home))) {
    const to = join(root, CURRENT_DIR);
    for (const legacy of LEGACY_DIRS) {
      const from = join(root, legacy);
      // Nothing to move, or the destination is already populated — by an
      // earlier run, by the previous legacy name in this same loop, or by a
      // fresh install that got there first. Never merge the two: silently
      // interleaving two sets of global workflows is worse than leaving the old
      // directory sitting there for a human to look at.
      if (!(await exists(from))) continue;
      if (await exists(to)) continue;
      await rename(from, to).catch(() => {});
    }
  }
}
