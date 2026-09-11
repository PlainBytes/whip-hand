import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  AttachmentError, defaultRegistry, loadWorkspaceConfig, parseInputPairs, parseWorkflow, planResume,
  resolveWorkflowPath, ResumeError, runWorkflow, validateAttachments, validateWorkflowWarnings,
} from '@whiphand/core';
import type { AttachmentSource, Frontend, WhiphandEvent, ResumePlan, Scope, Workflow } from '@whiphand/core';
import { spawnHeadless, spawnInteractive } from '../tty.ts';
import { createRenderer } from '../render.ts';
import { createManualPrompt, promptMissingInputs } from '../prompt.ts';

function jsonEvent(event: WhiphandEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export interface RunCommandOptions {
  dryRun: boolean;
  input: string[];
  /**
   * Files to copy into the run (`--attach`). Resolved against the shell's
   * working directory, not `cwd`: `-C` picks the workspace, and a path the
   * operator typed means what it means in their shell.
   */
  attach?: string[];
  cwd: string;
  json?: boolean;
  yes?: boolean;
  maxIterations?: number;
  /** Run id to continue instead of starting a new run. */
  resume?: string;
  /** On resume, mint fresh sessions rather than continuing recorded ones. */
  freshSession?: boolean;
  /** Display label for this run. Meaningless on a resume — the run has one. */
  name?: string;
}

/** Usage errors exit 2; a run that legitimately failed exits 1. */
const USAGE_ERROR = 2;

/** Attachment refusals are bad invocations, so they exit 2 like any other usage error. */
function attachmentRefusal(e: AttachmentError): number {
  for (const problem of e.problems) console.error(`✘ ${problem}`);
  return USAGE_ERROR;
}

export async function runCommand(
  workflowRef: string | undefined, opts: RunCommandOptions,
): Promise<number> {
  const workdir = resolve(opts.cwd);
  const promptOpts = { yes: !!opts.yes, ...(opts.json ? { isTty: false } : {}) };

  if (opts.resume !== undefined) {
    // The run's own snapshot decides what executes, so a workflow ref could
    // only ever contradict it.
    if (workflowRef !== undefined) {
      console.error('--resume runs the workflow the run recorded; do not also name one');
      return USAGE_ERROR;
    }
    // A dry run mints no artifacts, so it cannot honour a skip set.
    if (opts.dryRun) {
      console.error('--resume and --dry-run cannot be combined');
      return USAGE_ERROR;
    }
    // Silently ignoring it would look like a rename that did not take.
    if (opts.name !== undefined) {
      console.error("--resume continues an existing run; rename it with 'whiphand rename-run' instead");
      return USAGE_ERROR;
    }
    // A resume sees exactly the files the run started with, the same way it
    // keeps the inputs it started with.
    if ((opts.attach ?? []).length > 0) {
      console.error('--resume keeps the files the run was started with; --attach cannot add to them');
      return USAGE_ERROR;
    }
  } else if (workflowRef === undefined) {
    console.error('missing workflow: name one, or pass --resume <runId> to continue a stopped run');
    return USAGE_ERROR;
  }

  const config = await loadWorkspaceConfig(workdir);

  let plan: ResumePlan | undefined;
  if (opts.resume !== undefined) {
    try {
      plan = await planResume(workdir, config, opts.resume);
    } catch (e) {
      // A refusal is a run that did not happen, not a mistyped command.
      if (e instanceof ResumeError) {
        console.error(`✘ ${e.message}`);
        return 1;
      }
      throw e;
    }
    for (const warning of plan.warnings) console.error(`  ⚠ ${warning}`);
    if (opts.freshSession) plan = { ...plan, resumedStepIds: new Set() };
  }

  let workflowSource: Scope | undefined;
  let workflow: Workflow;
  if (plan === undefined) {
    const resolved = await resolveWorkflowPath(workflowRef!, workdir);
    workflowSource = resolved.source;
    workflow = parseWorkflow(await readFile(resolved.path, 'utf8'));
  } else {
    workflow = plan.workflow;
  }
  for (const warning of validateWorkflowWarnings(workflow)) console.error(`  ⚠ ${warning}`);

  const attachments: AttachmentSource[] = (opts.attach ?? []).map(path => ({ path: resolve(process.cwd(), path) }));
  // Checked here as well as in runWorkflow so a bad --attach is refused before
  // the operator is prompted for inputs they would then have typed for nothing.
  try {
    await validateAttachments(attachments, workflow, config.runs.max_attachment_mb);
  } catch (e) {
    if (e instanceof AttachmentError) return attachmentRefusal(e);
    throw e;
  }

  // A resumed run keeps the inputs it was started with: re-prompting for them
  // would let the continuation answer differently than the run it continues.
  const inputs = plan === undefined
    ? await promptMissingInputs(workflow, parseInputPairs(opts.input), promptOpts)
    : plan.inputs;

  const frontend: Frontend = {
    runInteractive: spawnInteractive,
    runManual: createManualPrompt(promptOpts),
    onEvent: opts.json
      ? jsonEvent
      // A dry run copies nothing, so it says where a real run would have put each file.
      : createRenderer({}, opts.dryRun ? { runDirOf: runId => resolve(workdir, config.artifacts_dir, runId) } : {}),
  };

  let result;
  try {
    result = await runWorkflow({
      workflow, workdir, inputs, config,
      registry: defaultRegistry(), frontend,
      dryRun: opts.dryRun, spawnHeadless, workflowSource,
      ...(opts.maxIterations === undefined ? {} : { maxIterations: opts.maxIterations }),
      ...(opts.name === undefined ? {} : { name: opts.name }),
      ...(plan === undefined ? {} : { resume: plan }),
      ...(attachments.length === 0 ? {} : { attachments }),
    });
  } catch (e) {
    // A file that changed between the check above and the run's own.
    if (e instanceof AttachmentError) return attachmentRefusal(e);
    throw e;
  }
  return result.ok ? 0 : 1;
}
