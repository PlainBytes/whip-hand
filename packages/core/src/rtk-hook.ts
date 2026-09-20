/**
 * "rtk is installed but Claude Code never calls it": the check behind the rtk
 * row's note. rtk only saves tokens when a Claude Code hook routes commands
 * through it; `rtk init -g` writes that hook into `~/.claude/settings.json`
 * (`rtk init --show` reports the same, and lists this command in its usage).
 *
 * Same contract as the auth checks — local, no process spawned, and a note only
 * when we are *sure*: a settings file we cannot read or parse is claude's
 * business, not ours to judge, so it gives no note. Project-level and managed
 * settings are not read; a hook wired only there gets a note it does not
 * deserve, which running the suggested command does no harm to.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CheckContext } from './tools.ts';

export const RTK_HOOK_NOTE = 'rtk is installed but no Claude Code hook calls it — run `rtk init -g` to set it up';

/** The user-level files claude merges hooks from, in the config dir claude itself reads. */
const SETTINGS_FILES = ['settings.json', 'settings.local.json'];

/**
 * `rtk` as a word: `rtk hook claude`, `/home/me/.local/bin/rtk hook claude`,
 * `rtk.exe`, and the older script hook `~/.claude/hooks/rtk-rewrite.sh`, but
 * not a path that merely contains those letters (`cartkit`). Generous on
 * purpose — a missed hook makes a false note, a loose match only a missing one.
 */
const RTK_COMMAND = /(^|[^a-z0-9])rtk([^a-z0-9]|$)/i;

/** Every `command` string anywhere under `hooks`, whatever the event or nesting. */
function hookCommands(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(hookCommands);
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'command' && typeof value === 'string' ? [value] : hookCommands(value));
}

/** What the check reads from the machine, so a test can substitute all of it. */
export interface RtkHookDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  /** Rejects the way `fs.readFile` does: `code: 'ENOENT'` for a file that is not there. */
  readText(path: string): Promise<string>;
}

const liveDeps = (): RtkHookDeps => ({
  env: process.env, home: homedir(), readText: path => readFile(path, 'utf8'),
});

/**
 * The note for the rtk row: one entry when claude is in the report and no
 * user-level settings file has a hook that invokes rtk, else none. "Claude is in
 * the report" means installed — with no claude row (hidden, unregistered) or a
 * missing binary there is nothing for a hook to be wired into.
 */
export async function rtkHookCheck(ctx: CheckContext, deps: RtkHookDeps = liveDeps()): Promise<string[]> {
  if (!(await ctx.detected('claude'))?.installed) return [];

  const configDir = deps.env.CLAUDE_CONFIG_DIR || join(deps.home, '.claude');
  for (const name of SETTINGS_FILES) {
    let text: string;
    try {
      text = await deps.readText(join(configDir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
      return [];
    }
    let settings: unknown;
    try {
      settings = JSON.parse(text);
    } catch {
      return [];
    }
    const hooks = typeof settings === 'object' && settings !== null ? (settings as { hooks?: unknown }).hooks : undefined;
    if (hookCommands(hooks).some(command => RTK_COMMAND.test(command))) return [];
  }
  return [RTK_HOOK_NOTE];
}
