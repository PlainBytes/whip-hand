/**
 * The shared half of the "is it logged in" notes each harness adapter puts on
 * its Doctor row (`authNote` in claude.ts, copilot.ts, opencode.ts).
 *
 * The contract every check keeps:
 *  - local and cheap: an env var, a file, or a subcommand that never leaves the
 *    machine — never a call that validates a token against a server, because an
 *    offline laptop would then read as "logged out";
 *  - never interactive, and no secret is ever read into a note or a log — a
 *    check learns "is there one", not what it is;
 *  - a note only when we are *sure*. A timeout, an unreadable file, an unknown
 *    platform or an answer we do not recognise all mean "no note": a missing
 *    warning costs one failed step, a false one teaches people to ignore Doctor.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execRunner } from '../exec.ts';
import { PROBE_TIMEOUT_MS } from '../tools.ts';
import type { DetectResult } from '../types.ts';

/** Everything a check reads from the machine, so a test can substitute all of it. */
export interface AuthProbeDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  /** Rejects the way `fs.readFile` does: `code: 'ENOENT'` for a file that is not there. */
  readText(path: string): Promise<string>;
  /** stdout of a command that exited zero within PROBE_TIMEOUT_MS; rejects on anything else. */
  run(argv: string[]): Promise<string>;
}

export function liveAuthDeps(): AuthProbeDeps {
  return {
    env: process.env,
    platform: process.platform,
    home: homedir(),
    readText: path => readFile(path, 'utf8'),
    run: async argv => (await execRunner(argv, { timeout: PROBE_TIMEOUT_MS })).stdout,
  };
}

/** A variable that is set to something — `FOO=` and `FOO=0`/`false` are how people switch one off. */
export function envOn(env: NodeJS.ProcessEnv, ...names: string[]): boolean {
  return names.some(name => {
    const value = env[name];
    return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
  });
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** `//` header lines are how copilot marks config.json as its own; plain JSON.parse chokes on them. */
export function parseLenientJson(text: string): unknown {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
}

/**
 * Adds the check's note to an installed row. Uninstalled rows are returned as
 * they came (there is nothing to be logged in *to*), and a check that throws
 * is a check that had no answer — it must not fail the row's detect().
 */
export async function withAuthNote(
  probed: DetectResult, authNote: () => Promise<string | undefined>,
): Promise<DetectResult> {
  if (!probed.installed) return probed;
  let note: string | undefined;
  try {
    note = await authNote();
  } catch {
    return probed;
  }
  return note === undefined ? probed : { ...probed, notes: [...(probed.notes ?? []), note] };
}
