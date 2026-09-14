/**
 * The prompt every resume-based harvest sends: "write the artifact we agreed
 * on, then say done." Shared by claude, copilot and opencode — the three
 * adapters that harvest by resuming the interactive session itself, rather
 * than reading a transcript file — so the wording can't drift between them.
 */
import type { AgentStep, RunCtx } from '../types.ts';

export function harvestPrompt(step: AgentStep, ctx: RunCtx): string {
  const path = `${ctx.runDir}/${step.output}`;
  return `Write the final '${step.output}' artifact we agreed on in this conversation to ${path}. ` +
    `Write only the artifact content to that file, then reply with just: done`;
}
