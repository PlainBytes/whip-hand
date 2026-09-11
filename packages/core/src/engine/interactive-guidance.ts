/**
 * The guidance every interactive session is seeded with.
 *
 * Without it a runner treats the step prompt as an autonomous task and starts
 * doing the work of later steps; the only other guard is the write-tool denial
 * on read-only steps, which any shell command walks straight around.
 *
 * The text is shared; only delivery differs per runner (claude has
 * --append-system-prompt, copilot has no system-prompt flag at all and takes it
 * as a prompt prefix), so keep it tight — for copilot it competes with the task
 * prompt rather than sitting above it.
 */
import type { AgentStep, RunCtx } from '../types.ts';
import { endMarkerPath, shellPath } from './session-end.ts';

export function interactiveGuidance(step: AgentStep, ctx: RunCtx): string {
  // The runner is told to run this as a shell command, and the adapters
  // pre-approve the same string — so it has to be shell-readable, and it has
  // to be rendered the one way both sides render it.
  const marker = shellPath(endMarkerPath(ctx.runDir, step.id));

  const scope =
    `You are running as step '${step.id}' of a Whiphand workflow, in an interactive ` +
    `session with a human at this terminal. This is a collaboration, not a task queue.\n\n` +
    `Stay inside this step's scope: do what its prompt asks and nothing more. The workflow has ` +
    `later steps that do other work — implementing, reviewing, testing — and that work is not ` +
    `yours. Do not run ahead, and do not start implementing because the goal seems obvious.`;

  const writeRule = step.writes
    ? `Before you change anything, propose the approach and wait for the human to say go. ` +
      `Do not start editing on your own initiative.`
    : `This step is READ-ONLY. Investigate, discuss and plan; change nothing. No file writes, ` +
      `edits, renames or deletions, and no shell command that changes anything — no commits, ` +
      `installs, formatters, code generation, or scripts that write files. When you think a ` +
      `change is needed, describe it instead of making it.`;

  // Load-bearing: claude's harvest resumes THIS session and asks it to write the
  // artifact into the run dir. Without the carve-out that request contradicts the
  // read-only rule we just gave, and the model may refuse it.
  const carveOut =
    `Whiphand's own run directory (${ctx.runDir}) is not part of the working tree and is ` +
    `exempt from the rule above: the marker file below, and the artifact you will be asked to ` +
    `write once this session ends, are expected there.`;

  const ending =
    `Ending the session: when the human agrees this step's goal is met, run exactly\n\n` +
    `    touch ${marker}\n\n` +
    `then stop and tell them the session is complete. That command is what ends the session — ` +
    `never run it for any other reason. Whiphand collects this step's ` +
    `'${step.output}' artifact afterwards, so do not write it yourself now.`;

  return [scope, writeRule, carveOut, ending].join('\n\n');
}
