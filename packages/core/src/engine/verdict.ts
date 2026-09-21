import type { ManualChoice } from '../types.ts';

/**
 * What a `verdict: true` step is told about its verdict. The first line is all
 * `parseVerdict` reads; the definitions and the section order exist so that
 * "PASS" means the same thing to every reviewer, and so nothing a human still
 * has to look at is buried in prose.
 */
export const VERDICT_INSTRUCTION = [
  "The very first line of the artifact MUST be exactly 'VERDICT: PASS' or 'VERDICT: FAIL'.",
  'PASS means nothing blocking remains: every requirement of the attached plan or stage is met, ' +
    'and nothing was changed that should not have been.',
  'FAIL means at least one blocking finding. Each blocking finding must be concrete: the file, ' +
    'what is wrong, and what would fix it.',
  'After the verdict line, use these sections, in this order:',
  '## Blocking\nThe findings that make this a FAIL. Empty on a PASS.',
  '## Non-blocking\nEverything worth saying that does not block, including nitpicks outside the ' +
    "step's scope.",
  '## Needs a human\nWhat could not be verified headless, such as a manual repro or a visual ' +
    'check. Items here never turn a PASS into a FAIL by themselves, but list them here rather ' +
    'than burying them in prose.',
].join('\n\n');

/** Exit codes a command step treats as success when it declares none. */
export const DEFAULT_EXPECT_EXIT = [0];

export function parseVerdict(text: string): 'pass' | 'fail' | null {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const m = firstLine.match(/^VERDICT:\s*(PASS|FAIL)\b/i);
  return m ? (m[1].toLowerCase() as 'pass' | 'fail') : null;
}

/** A command step's verdict is its exit code measured against `expect_exit`. */
export function verdictFromExit(code: number, expect: number[] = DEFAULT_EXPECT_EXIT): 'pass' | 'fail' {
  return expect.includes(code) ? 'pass' : 'fail';
}

/**
 * A manual step's verdict is the human's answer. 'retry' is a deliberate
 * "go round again", which is exactly a failed verdict to the enclosing loop;
 * 'abort' never reaches here — it fails the run outright.
 */
export function verdictFromChoice(choice: ManualChoice): 'pass' | 'fail' {
  return choice === 'continue' ? 'pass' : 'fail';
}
