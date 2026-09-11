/**
 * Command steps: the one step kind that spends no tokens and needs no runner.
 *
 * A command resolves to an ordinary SpawnSpec, which is what makes it a
 * first-class citizen for free — `--dry-run` prints it, AbortSignal cancels
 * it, the desktop already streams its output as `stepLog`, and the CLI/desktop
 * parity suite compares it exactly like an agent spawn.
 */
import { isAbsolute, resolve } from 'node:path';
import type { CommandStep, LoopFrame, RunCtx, SpawnSpec } from '../types.ts';
import { renderTemplate } from '../template.ts';

export const DEFAULT_SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

/**
 * The flag that runs an inline command string varies with the shell, not
 * just its name — `cmd.exe` wants `/d /s /c`, PowerShell wants `-NoProfile
 * -Command`, everything POSIX wants `-c`. Matched on basename so a full path
 * (`/usr/local/bin/bash`) still resolves.
 */
const SHELL_FLAGS: Record<string, string[]> = {
  sh: ['-c'],
  bash: ['-c'],
  zsh: ['-c'],
  cmd: ['/d', '/s', '/c'],
  'cmd.exe': ['/d', '/s', '/c'],
  powershell: ['-NoProfile', '-Command'],
  'powershell.exe': ['-NoProfile', '-Command'],
  pwsh: ['-NoProfile', '-Command'],
  'pwsh.exe': ['-NoProfile', '-Command'],
};

export function shellFlags(shell: string): string[] {
  const base = shell.split(/[/\\]/).pop() ?? shell;
  return SHELL_FLAGS[base.toLowerCase()] ?? ['-c'];
}

export function commandSpec(step: CommandStep, ctx: RunCtx, capturePath?: string): SpawnSpec {
  const run = renderTemplate(step.run, ctx);
  // `cwd` is templated for the same reason `run` is: the whole point of
  // {{ run.slug }} is deriving a per-run directory, and a step that has to
  // `cd` into it in its own shell line cannot also declare it as its cwd.
  const cwdTpl = step.cwd === undefined ? undefined : renderTemplate(step.cwd, ctx);
  const cwd = cwdTpl === undefined
    ? ctx.workdir
    : (isAbsolute(cwdTpl) ? cwdTpl : resolve(ctx.workdir, cwdTpl));
  const shell = step.shell ?? DEFAULT_SHELL;
  return {
    argv: [shell, ...shellFlags(shell), run],
    cwd,
    // The run's identity as environment rather than interpolation: a name is
    // arbitrary human text, and pasting it into a `sh -c` string is a quoting
    // hazard the slug only partly mitigates. `{{ run.* }}` is still there for
    // prose; "$WHIPHAND_RUN_SLUG" is the one to reach for in a shell line.
    env: {
      ...(step.env ?? {}),
      WHIPHAND_RUN_DIR: ctx.runDir,
      WHIPHAND_RUN_ID: ctx.runId,
      WHIPHAND_RUN_SLUG: ctx.runSlug,
      ...(ctx.runName === undefined ? {} : { WHIPHAND_RUN_NAME: ctx.runName }),
      WHIPHAND_STEP_ID: step.id,
    },
    interactive: false,
    ...(capturePath === undefined ? {} : { capture: { path: capturePath } }),
  };
}

/**
 * The header a captured command artifact opens with. Written by core before
 * the spawn so the artifact says which command produced it, and so a silent
 * command still leaves a non-empty (and therefore valid) artifact behind.
 */
export function captureHeader(step: CommandStep, argv: string[], frame?: LoopFrame): string {
  const iter = frame ? ` (iteration ${frame.iteration}/${frame.maxIterations})` : '';
  return `$ ${argv[argv.length - 1]}\n# step '${step.id}'${iter}\n\n`;
}

export function captureFooter(exitCode: number): string {
  return `\n(exit code: ${exitCode})\n`;
}
