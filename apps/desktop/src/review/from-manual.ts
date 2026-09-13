/**
 * The one adapter: a parked manual/approval step, as the generic review model.
 *
 * Pure, so the mapping is testable without a run. Everything specific to
 * manual steps — the choice vocabulary, the loop frame, the note field — stops
 * here; the panel downstream only ever sees a ReviewRequest.
 */
import type { CaptureSpec, ManualChoice, ManualRequest } from '../../../../packages/core/src/types.ts';
import { ancestorLoops, executionKey } from '../../../../packages/core/src/execution-key.ts';
import { manualLabel } from '../lib/await-copy.ts';
import { DIFF_SOURCE_ID, type ReviewChoice, type ReviewRequest, type ReviewSource } from './model.ts';

const CHOICE_LABEL: Record<ManualChoice, string> = {
  continue: 'Continue',
  retry: 'Retry',
  abort: 'Abort run',
};

const CHOICE_HINT: Record<ManualChoice, string> = {
  continue: 'Carry on to the next step.',
  retry: 'Go round the loop again.',
  abort: 'Stop the run here.',
};

/**
 * `retry` reads differently under `capture: 'review'`: "Retry" describes what
 * the loop does, but this screen belongs to the human, and what the human is
 * doing is asking the agent to make specific changes.
 */
function choiceLabel(value: ManualChoice, captureKind: CaptureSpec['kind'] | undefined): string {
  if (value === 'retry' && captureKind === 'review') return 'Request changes';
  return CHOICE_LABEL[value];
}

function choiceHint(value: ManualChoice, captureKind: CaptureSpec['kind'] | undefined): string {
  if (value === 'retry' && captureKind === 'review') return 'Send it back to the agent with your comments.';
  return CHOICE_HINT[value];
}

/** The basename is what a human recognises; the full path is on the row. */
function labelFor(artifactPath: string, id: string): string {
  const name = artifactPath.split(/[/\\]/).pop();
  return name === undefined || name === '' ? id : name;
}

export function fromManualRequest(request: ManualRequest): ReviewRequest {
  const sources: ReviewSource[] = [];

  // Only when the workflow author asked for it with `show_diff: true`. Core
  // omits `context.diff` otherwise, and offering a change set nobody asked to
  // see would misrepresent what this step was told to put in front of someone.
  if (request.context.diff !== undefined) {
    sources.push({ kind: 'diff', id: DIFF_SOURCE_ID, label: 'Changes' });
  }
  for (const artifact of request.context.artifacts) {
    sources.push({
      kind: 'artifact', id: artifact.id, path: artifact.path,
      label: labelFor(artifact.path, artifact.id),
    });
  }

  const choices: ReviewChoice[] = request.choices.map(value => ({
    value,
    label: choiceLabel(value, request.capture?.kind),
    hint: choiceHint(value, request.capture?.kind),
    primary: value === 'continue',
  }));

  const loop = request.loop;
  return {
    // The iteration is part of the identity: the same step id comes round
    // again inside a loop, and its second asking is a different question —
    // and once loops nest, so is which round of any *enclosing* loop it's in.
    key: executionKey(request.stepId, loop?.iteration, ancestorLoops(loop)),
    badge: manualLabel(request.kind),
    title: request.title,
    instructions: request.instructions,
    sources,
    choices,
    ...(request.capture === undefined ? {} : { capture: request.capture }),
  };
}
