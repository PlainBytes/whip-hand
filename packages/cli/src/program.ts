import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { CORE_VERSION, defaultRegistry, initWorkspace, createWorkflow } from '@whiphand/core';
import type { Scope } from '@whiphand/core';
import { runDoctor } from './commands/doctor.ts';
import { runCommand } from './commands/run.ts';
import { configGetCommand, configSetCommand } from './commands/config.ts';
import { renameRunCommand } from './commands/rename-run.ts';

/**
 * Builds the full `whiphand` CLI surface without parsing argv. Kept separate from
 * main.ts so it can be introspected (commands/options) without a process
 * exiting underneath the caller — e.g. by a CI parity check.
 */
// Number.parseInt would happily read '1.5' as 1; a budget the operator did
// not type is worse than an error.
function positiveInt(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError('must be a positive integer');
  const n = Number(value);
  if (n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

export function buildProgram(): Command {
  const program = new Command();
  program.name('whiphand').description('workflow runner for LLM CLIs').version(CORE_VERSION);

  program.command('doctor')
    .description('check the tools whiphand needs, and the working folder')
    .option('-C <dir>', 'working folder to check alongside the machine', process.cwd())
    .action(async (opts: { C: string }) => {
      console.log(await runDoctor(defaultRegistry(), resolve(opts.C)));
    });

  program.command('run')
    .description('run a workflow, or resume a stopped one')
    .argument('[workflow]',
      'workflow name (project .whiphand/workflows/, falling back to the global ones), a path to a YAML file, '
      + "or an explicit 'project:<name>' / 'global:<name>' selector; omit when using --resume")
    .option('--resume <runId>',
      'continue a failed, interrupted or cancelled run from its first unfinished step')
    .option('--fresh-session',
      'on resume, start a new agent session instead of continuing the recorded one', false)
    .option('--dry-run', 'resolve and print every step argv without spawning', false)
    .option('--input <pair...>', 'workflow input as key=value', [] as string[])
    .option('--attach <path...>',
      "copy a file into the run for steps whose inputs name 'attachments'; repeatable. "
      + 'Relative paths resolve against the current directory, not -C', [] as string[])
    .option('-C <dir>', 'working folder', process.cwd())
    .option('--json', 'emit one NDJSON line per event on stdout instead of human output', false)
    .option('--yes', 'resolve manual and approval steps to their default instead of asking', false)
    .option('--name <name>',
      'label this run, shown instead of its id and available to steps as {{ run.name }} '
      + "/ {{ run.slug }} and $WHIPHAND_RUN_NAME / $WHIPHAND_RUN_SLUG")
    .option('--max-iterations <n>', "override every loop's iteration budget for this run", positiveInt)
    .option('--extra-iterations <n>',
      'on resume, grant each loop that ran out this many more iterations (default 1)', positiveInt)
    .action(async (
      workflowRef: string | undefined,
      opts: {
        dryRun: boolean; input: string[]; attach: string[]; C: string; json: boolean;
        yes: boolean; maxIterations?: number; extraIterations?: number; resume?: string; freshSession: boolean;
        name?: string;
      },
    ) => {
      process.exitCode = await runCommand(workflowRef, {
        dryRun: opts.dryRun, input: opts.input, attach: opts.attach, cwd: opts.C, json: opts.json,
        yes: opts.yes, maxIterations: opts.maxIterations, extraIterations: opts.extraIterations,
        resume: opts.resume, freshSession: opts.freshSession, name: opts.name,
      });
    });

  program.command('rename-run')
    .description("set or clear a run's display label")
    .argument('<runId>', 'run id, as shown by `whiphand run` and in the desktop app')
    .argument('<name>', "new label; pass '' to clear it")
    .option('-C <dir>', 'working folder', process.cwd())
    .action(async (runId: string, name: string, opts: { C: string }) => {
      process.exitCode = await renameRunCommand(runId, name, { cwd: opts.C });
    });

  program.command('init')
    .description('initialize .whiphand/ (config + starter workflows) in the working folder')
    .option('-C <dir>', 'working folder', process.cwd())
    .action(async (opts: { C: string }) => {
      const { created } = await initWorkspace(resolve(opts.C));
      console.log(created.length > 0
        ? created.map(p => `created ${p}`).join('\n')
        : 'workspace already initialized — nothing to do');
    });

  program.command('new-workflow')
    .description('scaffold a workflow into .whiphand/workflows/, or the global workflows dir with --global')
    .argument('<name>', 'workflow name (lowercase, digits, - and _)')
    .option('--global', 'write to the user-level workflows dir, shared by every workspace', false)
    .option('-C <dir>', 'working folder', process.cwd())
    .action(async (name: string, opts: { global: boolean; C: string }) => {
      const scope: Scope = opts.global ? 'global' : 'project';
      const { path } = await createWorkflow(resolve(opts.C), name, scope);
      console.log(`created ${path}`);
    });

  const config = program.command('config').description('read or write workspace or global config');

  config.command('get')
    .description('print the resolved config, or one dotted key (defaults.runner, on_findings, '
      + 'loop.max_iterations, artifacts_dir, runs.max_retained, runs.auto_name, runs.max_attachment_mb)')
    .argument('[key]', 'dotted config key; omit to print the whole resolved config')
    .option('--global', 'read only the global layer instead of the merged workspace config', false)
    .option('-C <dir>', 'working folder', process.cwd())
    .action(async (key: string | undefined, opts: { global: boolean; C: string }) => {
      process.exitCode = await configGetCommand(key, { global: opts.global, cwd: opts.C });
    });

  config.command('set')
    .description('set one config key, in the workspace layer or (with --global) the shared one')
    .argument('<key>', 'dotted config key')
    .argument('<value>', "value to set; 'null' clears runs.max_retained to keep every run")
    .option('--global', 'write the global layer instead of this workspace\'s own', false)
    .option('-C <dir>', 'working folder', process.cwd())
    .action(async (key: string, value: string, opts: { global: boolean; C: string }) => {
      process.exitCode = await configSetCommand(key, value, { global: opts.global, cwd: opts.C });
    });

  return program;
}
