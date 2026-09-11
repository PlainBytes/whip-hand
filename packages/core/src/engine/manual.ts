/**
 * Manual and approval steps: the points where a workflow stops and asks a human.
 *
 * Core never reads a terminal, so this module only *builds the question*. The
 * frontend answers it — the CLI on its tty, the desktop in a card — exactly as
 * `runInteractive` hands over a live session rather than owning one.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CaptureSpec, ManualChoice, ManualRequest, ManualResponse, ManualStep, RunCtx,
} from '../types.ts';
import { inputArtifacts, renderTemplate } from '../template.ts';

const run = promisify(execFile);

/** How much of a diff we are willing to put in front of a human at once. */
export const DIFF_LINE_LIMIT = 400;

/**
 * The working tree's diff as one block of text, truncated to something a tty
 * can reasonably print. `null` when this isn't a git repo — the same posture
 * git-guard takes: no repo means no diff, not a failure.
 *
 * Two limits, both real, both inherited by whoever renders this string:
 *
 * - `git diff HEAD` compares the index and the worktree *against HEAD*, and an
 *   untracked file is in neither — so a file a step just created does not
 *   appear here at all. (This comment used to claim the opposite.)
 * - The truncation is a flat line slice, so it can cut a hunk in half.
 *
 * Both are fixed in `workingDiffFiles` (./diff.ts), which the desktop's review
 * screen uses. This one stays as it is because the CLI prints it to a terminal,
 * where one bounded block of text is the right shape and a file-by-file
 * structure is not.
 */
export async function workingDiff(
  workdir: string, limit = DIFF_LINE_LIMIT,
): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await run('git', ['diff', '--stat', 'HEAD'], { cwd: workdir, maxBuffer: 8 << 20 }));
    const { stdout: patch } = await run('git', ['diff', 'HEAD'], { cwd: workdir, maxBuffer: 8 << 20 });
    stdout = patch.trim().length > 0 ? `${stdout.trimEnd()}\n\n${patch}` : stdout;
  } catch {
    return null;
  }
  const lines = stdout.split('\n');
  if (lines.length <= limit) return stdout;
  return `${lines.slice(0, limit).join('\n')}\n… ${lines.length - limit} more lines (see the working tree)`;
}

export function manualChoices(inLoop: boolean): ManualChoice[] {
  return inLoop ? ['continue', 'retry', 'abort'] : ['continue', 'abort'];
}

/**
 * The two capture kinds, spelled out once. `note` is required to `continue`
 * (unchanged from before `CaptureSpec` existed); `review` is required to
 * `retry` — a human cannot send work back without saying what to change — and
 * is the only kind that offers per-file comments.
 */
function captureSpecFor(kind: 'note' | 'review'): CaptureSpec {
  return kind === 'note'
    ? { kind: 'note', label: 'Note', requiredFor: ['continue'], perFile: false }
    : { kind: 'review', label: 'Feedback', requiredFor: ['retry'], perFile: true };
}

export async function buildManualRequest(
  step: ManualStep, ctx: RunCtx,
): Promise<ManualRequest> {
  // `attachments` expands to one entry per attached file, so a review screen
  // offers each of them on its own.
  const artifacts = inputArtifacts(step.inputs ?? [], ctx)
    .filter((a): a is { id: string; path: string } => a.path !== undefined);

  const diff = step.show_diff ? await workingDiff(ctx.workdir) : null;

  return {
    stepId: step.id,
    kind: step.kind,
    title: renderTemplate(step.title, ctx),
    instructions: renderTemplate(step.instructions, ctx),
    choices: manualChoices(ctx.loop !== undefined),
    ...(step.capture === undefined ? {} : { capture: captureSpecFor(step.capture) }),
    context: { artifacts, ...(diff === null ? {} : { diff }) },
    defaultChoice: step.default ?? 'continue',
    ...(ctx.loop === undefined ? {} : { loop: ctx.loop }),
  };
}

/** Rendered into the note artifact so it reads as a record, not a bare line. */
export function noteArtifact(step: ManualStep, request: ManualRequest, note: string): string {
  return `# ${request.title}\n\n_${step.kind} step '${step.id}'_\n\n${note.trim()}\n`;
}

/**
 * Rendered into the review artifact: the whole-changeset comment, then one
 * section per file, in the order they were left. The choice goes in the
 * subtitle — not just the title — because the agent reading this on the next
 * iteration needs to know whether it was sent back or waved through with
 * notes, and `noteArtifact` doesn't say.
 */
export function reviewArtifact(step: ManualStep, request: ManualRequest, answer: ManualResponse): string {
  const verdictWord = answer.choice === 'retry' ? 'changes requested' : 'approved';
  const lines = [`# ${request.title}`, '', `_${step.kind} step '${step.id}' — ${verdictWord}_`];

  const overall = (answer.note ?? '').trim();
  if (overall.length > 0) lines.push('', '## Overall', '', overall);

  for (const comment of answer.comments ?? []) {
    const body = comment.body.trim();
    if (body.length === 0) continue;
    lines.push('', `## \`${comment.path}\``, '', body);
  }

  return `${lines.join('\n')}\n`;
}
