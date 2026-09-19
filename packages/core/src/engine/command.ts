/**
 * Command steps: the one step kind that spends no tokens and needs no runner.
 *
 * A command resolves to an ordinary SpawnSpec, which is what makes it a
 * first-class citizen for free — `--dry-run` prints it, AbortSignal cancels
 * it, the desktop already streams its output as `stepLog`, and the CLI/desktop
 * parity suite compares it exactly like an agent spawn.
 */
import { isAbsolute, resolve } from 'node:path';
import type { CommandStep, Frame, RunCtx, SpawnSpec } from '../types.ts';
import {
  TemplateError, artifactEnvName, bindings, inputArtifacts, referencedRefs, renderReferences, renderTemplate,
} from '../template.ts';
import { isStageFrame, nearestStage } from '../execution-key.ts';
import { ATTACHMENTS_REF } from '../attachments.ts';
import { toFwdAbs } from '../path-form.ts';
import { resolveShell, shellRefusal } from '../shell.ts';

/**
 * The most one environment variable can carry: Linux's MAX_ARG_STRLEN (128 KiB
 * per `NAME=value` string), Windows' 32,767 characters. A referenced input over
 * it fails the step *before* spawn, naming the input and its size, instead of
 * surfacing as an opaque E2BIG from the launch.
 */
export function envValueLimit(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? 32_767 : 128 * 1024;
}

function assertFitsEnv(envName: string, key: string, value: string, platform: NodeJS.Platform): void {
  const limit = envValueLimit(platform);
  const size = platform === 'win32' ? envName.length + 1 + value.length : Buffer.byteLength(`${envName}=${value}`);
  if (size > limit) {
    throw new TemplateError(
      `input '${key}' is ${size} ${platform === 'win32' ? 'characters' : 'bytes'}, over the ${limit} a command's `
      + `environment can carry (it is exported as ${envName}); pass it as a file instead`);
  }
}

/**
 * Command steps run through a POSIX shell on every OS, so the flag that runs an
 * inline string is always `-c`. (`cmd` and PowerShell are refused at parse
 * time; any other explicit shell gets `-c` too — the author's own choice, which
 * we neither reason about nor test.)
 */
const SHELL_FLAGS = ['-c'];

export function commandSpec(step: CommandStep, ctx: RunCtx, capturePath?: string): SpawnSpec {
  // `run` is rendered with the *reference* renderer (invariant 8): `{{ x }}`
  // becomes `${WHIPHAND_X}`, so a value is expanded by the shell as data and a
  // run named `; rm -rf ~` is inert. Everything else a step declares — `cwd`,
  // `env` values — is data read by us, not parsed by a shell, so those get the
  // value itself.
  const { text: run, used } = renderReferences(step.run, ctx);
  // `cwd` is templated for the same reason `run` is: the whole point of
  // {{ run.slug }} is deriving a per-run directory, and a step that has to
  // `cd` into it in its own shell line cannot also declare it as its cwd.
  const cwdTpl = step.cwd === undefined ? undefined : renderTemplate(step.cwd, ctx);
  const cwd = cwdTpl === undefined
    ? ctx.workdir
    : (isAbsolute(cwdTpl) ? cwdTpl : resolve(ctx.workdir, cwdTpl));
  const shell = step.shell ?? ctx.shell ?? resolvedShellOrThrow();

  // The binding table is the one source for what the environment holds.
  // `run.*` is always exported, `stage.*` inside a stages step, `loop.*` inside
  // a loop; an input is exported **only when this step references it** — by
  // `run`, an `env` value or `cwd` — so "exported equals referenced" holds by
  // construction and an unrelated multi-megabyte input never rides along.
  const referenced = new Set<string>([
    ...used.map(binding => binding.ref),
    ...referencedRefs(step.cwd ?? ''),
    ...Object.values(step.env ?? {}).flatMap(referencedRefs),
  ]);
  const bound: Record<string, string> = {};
  for (const binding of bindings(ctx)) {
    if (binding.ref.startsWith('inputs.')) {
      if (!referenced.has(binding.ref)) continue;
      assertFitsEnv(binding.envName, binding.ref.slice('inputs.'.length), binding.value, process.platform);
    }
    bound[binding.envName] = binding.value;
  }

  // Each `inputs:` entry with a recorded artifact becomes a path a command
  // can read straight off the environment — `inputArtifacts` is the same
  // resolver `buildPrompt` uses, so a command and an agent agree on what an
  // input ref resolves to. An id with nothing recorded (never run, or a
  // dropped forward reference) exports nothing: an empty env var would read
  // as "the artifact is the empty string", which is a lie a missing var
  // can't tell. `attachments` expansions are skipped outright: they name a
  // file, not a step, and a command already reaches them at
  // `$WHIPHAND_RUN_DIR/attachments`. Two distinct step ids that collapse to the
  // same env name (`a-b` and `a_b` both become `A_B`) are rejected at parse time.
  //
  // Paths in the environment are absolute with forward slashes (invariant 2):
  // the consumer's cwd is `step.cwd`, so there is no relative form to give.
  const artifactEnv = Object.fromEntries(
    inputArtifacts(step.inputs ?? [], ctx)
      .filter((input): input is { id: string; path: string } =>
        input.path !== undefined && !input.id.startsWith(`${ATTACHMENTS_REF}/`))
      .map(({ id, path }) => [artifactEnvName(id), toFwdAbs(path)]),
  );
  // A stage's title is a markdown heading pulled off disk — exactly the
  // "arbitrary human text" that must ride in as environment, never as text a
  // command would have to requote into its own shell line. (`stage.*` is in the
  // binding table above; the path has no placeholder, so it is added here.)
  const stage = nearestStage(ctx.frame);
  const stageEnv: Record<string, string> = stage === undefined ? {} : { WHIPHAND_STAGE_PATH: toFwdAbs(stage.stage.path) };
  return {
    argv: [shell, ...SHELL_FLAGS, run],
    cwd,
    env: {
      // `step.env` is templated for the same reason `run` and `cwd` are: a
      // value only known at run time (an input, a loop iteration) has to
      // reach the shell line somehow, and `{{ }}` is that path for env same
      // as for everything else a step declares.
      ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, renderTemplate(v, ctx)])),
      ...artifactEnv,
      ...bound,
      ...stageEnv,
      WHIPHAND_STEP_ID: step.id,
    },
    interactive: false,
    ...(capturePath === undefined ? {} : { capture: { path: capturePath } }),
  };
}

/** Only reached when a `RunCtx` was built without the run's resolved shell (a test double). */
function resolvedShellOrThrow(): string {
  const result = resolveShell();
  if (!result.ok) throw new TemplateError(shellRefusal(result));
  return result.path;
}

/**
 * The header a captured command artifact opens with. Written by core before
 * the spawn so the artifact says which command produced it, and so a silent
 * command still leaves a non-empty (and therefore valid) artifact behind.
 */
/** `frame` is the innermost construct the command runs under — a loop's iteration, or a stage and its attempt. */
export function captureHeader(step: CommandStep, argv: string[], frame?: Frame): string {
  const where = frame === undefined
    ? ''
    : isStageFrame(frame)
      ? ` (stage ${frame.stage.index}/${frame.stage.total} '${frame.stage.id}', attempt ${frame.attempt}/${frame.maxAttempts})`
      : ` (iteration ${frame.iteration}/${frame.maxIterations})`;
  return `$ ${argv[argv.length - 1]}\n# step '${step.id}'${where}\n\n`;
}

export function captureFooter(exitCode: number): string {
  return `\n(exit code: ${exitCode})\n`;
}
