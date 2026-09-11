import type { ManualChoice } from '../types.ts';

export const VERDICT_INSTRUCTION =
  "The very first line of the artifact MUST be exactly 'VERDICT: PASS' or 'VERDICT: FAIL'.";

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
