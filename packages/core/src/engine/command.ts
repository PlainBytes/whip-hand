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
import { inputArtifacts, renderTemplate } from '../template.ts';
import { nearestStage } from '../execution-key.ts';
import { ATTACHMENTS_REF } from '../attachments.ts';

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

/**
 * `stepId` -> the env var a command reaches its artifact through, e.g.
 * 'execute-report' -> 'WHIPHAND_ARTIFACT_EXECUTE_REPORT'.
 */
export function artifactEnvName(stepId: string): string {
  return `WHIPHAND_ARTIFACT_${stepId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
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
  // Each `inputs:` entry with a recorded artifact becomes a path a command
  // can read straight off the environment — `inputArtifacts` is the same
  // resolver `buildPrompt` uses, so a command and an agent agree on what an
  // input ref resolves to. An id with nothing recorded (never run, or a
  // dropped forward reference) exports nothing: an empty env var would read
  // as "the artifact is the empty string", which is a lie a missing var
  // can't tell. `attachments` expansions are skipped outright: they name a
  // file, not a step, and a command already reaches them at
  // `$WHIPHAND_RUN_DIR/attachments` — turning each into its own
  // `WHIPHAND_ARTIFACT_ATTACHMENTS_*` would just be a second, redundant way
  // to spell the same path. Two distinct step ids that happen to collapse to
  // the same env name (`a-b` and `a_b` both become `A_B`) collide silently
  // here; the later one in `inputs:` wins.
  const artifactEnv = Object.fromEntries(
    inputArtifacts(step.inputs ?? [], ctx)
      .filter((input): input is { id: string; path: string } =>
        input.path !== undefined && !input.id.startsWith(`${ATTACHMENTS_REF}/`))
      .map(({ id, path }) => [artifactEnvName(id), path]),
  );
  // A stage's title is a markdown heading pulled off disk — exactly the
  // "arbitrary human text" the run-name comment below warns about — so it
  // rides in as environment too, never as a `{{ stage.title }}` placeholder
  // a command would have to requote into its own shell line.
  const stage = nearestStage(ctx.frame);
  const stageEnv: Record<string, string> = stage === undefined ? {} : {
    WHIPHAND_STAGE_ID: stage.stage.id,
    WHIPHAND_STAGE_TITLE: stage.stage.title,
    WHIPHAND_STAGE_INDEX: String(stage.stage.index),
    WHIPHAND_STAGE_TOTAL: String(stage.stage.total),
    WHIPHAND_STAGE_PATH: stage.stage.path,
  };
  return {
    argv: [shell, ...shellFlags(shell), run],
    cwd,
    env: {
      // `step.env` is templated for the same reason `run` and `cwd` are: a
      // value only known at run time (an input, a loop iteration) has to
      // reach the shell line somehow, and `{{ }}` is that path for env same
      // as for everything else a step declares.
      ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, renderTemplate(v, ctx)])),
      ...artifactEnv,
      ...stageEnv,
      // The run's identity as environment rather than interpolation: a name is
      // arbitrary human text, and pasting it into a `sh -c` string is a quoting
      // hazard the slug only partly mitigates. `{{ run.* }}` is still there for
      // prose; "$WHIPHAND_RUN_SLUG" is the one to reach for in a shell line.
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
