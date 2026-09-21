/**
 * The guidance every headless agent step is prefixed with.
 *
 * A headless step used to get only the workflow's own prompt, and nothing said
 * that no human is at the other end or what the workflow keeps for itself. Past
 * runs paid for it: executors committing their own work and stashing the shared
 * tree, a commit-message agent asking a question nobody could answer, another
 * printing its result to stdout instead of writing the artifact, and reviewers
 * passing with open items "left for the human". The interactive counterpart is
 * interactive-guidance.ts.
 *
 * One text for all runners, delivered one way: as the head of the prompt the
 * runner hands the adapter (see `headlessPrompt`). Not through a system-prompt
 * channel, because copilot has none; a single prompt-level insertion gives
 * claude, copilot and opencode the identical words. It sits above the step's
 * own prompt behind a heading, so the step's prompt stays the task. Keep it
 * tight — it competes with that task for the model's attention.
 *
 * The text is a prompt template's input, so it must not contain `{{`.
 */
import type { AgentStep } from '../types.ts';

export function headlessGuidance(step: Pick<AgentStep, 'id' | 'writes'>): string {
  const scope =
    `You are running as step '${step.id}' of a Whiphand workflow, headless: no human is ` +
    `watching and no one will answer. Do not ask questions or wait for confirmation. When ` +
    `something is ambiguous, make the most reasonable choice consistent with the attached ` +
    `inputs and record that choice in your artifact.\n\n` +
    `Do this step's job only. The workflow has later steps — review, tests, a human gate, the ` +
    `commit — and that work is not yours. ` +
    (step.writes
      ? `A step that writes does not review its own work and does not commit it.`
      : `A read-only step does not fix what it finds; it reports it.`);

  const writeRule = step.writes
    ? ''
    : `This step is READ-ONLY. Change nothing in the working tree: no file writes, edits, ` +
      `renames or deletions, and no shell command that changes anything — no installs, ` +
      `formatters, code generation, or scripts that write files. When you think a change is ` +
      `needed, describe it in your artifact instead of making it. Whiphand's run directory is ` +
      `not part of the working tree: your artifact is expected there.`;

  const git =
    `Never run a git command that changes history or the index: no commit, stash, reset, ` +
    `checkout or switch, rebase, merge, push or tag. The workflow owns those. Reading with ` +
    `git diff, git log and git show is fine.`;

  const artifact =
    `Your deliverable is the artifact file, at the path named at the end of this prompt. ` +
    `Write it there with a file write, not to stdout. The step fails if the file is missing.`;

  const honesty =
    `Report what you did not do, did not verify or skipped, and why. Never claim a check you ` +
    `did not run.`;

  return [scope, writeRule, git, artifact, honesty].filter(part => part !== '').join('\n\n');
}

/**
 * The prompt a headless step is handed: the guidance, a separator, then the
 * step's own prompt under a heading of its own.
 */
export function headlessPrompt(step: Pick<AgentStep, 'id' | 'writes'>, prompt: string): string {
  return `${headlessGuidance(step)}\n\n---\n\n## Your task\n\n${prompt}`;
}
