/** What every packaging script shares: where the repo and `dist/` are, and the signing hook. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSync } from '../lib/exec.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const distDir = path.join(repoRoot, 'dist');

/**
 * The "design for signing later" seam: unset today, so this is a no-op on
 * every build until an operator sets it. Its installer-side twin is Tauri's
 * own `bundle.windows.signCommand`. Whatever command is set is expected to
 * sign in place and exit non-zero on failure.
 *
 * WHIPHAND_SIGN_COMMAND must name a single executable, not a full command
 * line with its own arguments (see README): resolving it through the launch
 * seam is what stops shell metacharacters in an operator-supplied command
 * string from injecting arbitrary commands, and a multi-word command line has
 * nowhere to be split back apart once it is treated as a single executable
 * name.
 */
export function runSignCommand(binary) {
  const command = process.env.WHIPHAND_SIGN_COMMAND;
  if (!command) return;
  runSync([command, binary], { check: true });
  process.stdout.write(`  ${'sign'.padEnd(9)} WHIPHAND_SIGN_COMMAND applied\n`);
}
