/**
 * The reader-voiced note the editor shows on a card that lost an input to a
 * disabled step — "Reads plan, which is disabled — this step will run without
 * it." One sentence per reader, so a reader that lost two inputs gets one
 * note, not two.
 *
 * The disabler-voiced sentence ("plan is disabled. execute and commit-message
 * read it…") lives in core beside `droppedRefs`, as `droppedRefSentence` — the
 * CLI needs it too. Both are derived from the same `droppedRefs`, so the two
 * voices can never disagree about the facts.
 */
import { droppedRefs } from '../../../../packages/core/src/enabled.ts';
import type { Workflow } from '../../../../packages/core/src/types.ts';

export interface ReaderNote {
  stepId: string;
  text: string;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** One note per reader that lost a reference to a disabled step. */
export function readerNotes(workflow: Workflow): ReaderNote[] {
  return droppedRefs(workflow).map(({ reader, missing }) => {
    const isSame = missing.length === 1;
    return {
      stepId: reader,
      text: `Reads ${joinNames(missing)}, which ${isSame ? 'is' : 'are'} disabled — `
        + `this step will run without ${isSame ? 'it' : 'them'}.`,
    };
  });
}
