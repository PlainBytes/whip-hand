/**
 * Vocabulary for "present some findings, then ask for a decision" panels —
 * title, instructions, sources to look at, and choices — independent of
 * what raised the request.
 */
import type { CaptureSpec, ManualChoice } from '../../../../packages/core/src/types.ts';

/**
 * Something to look at before deciding. `diff` is the working tree's change
 * set; `artifact` is one of the step's declared inputs — a plan, a review, a
 * findings report — addressed by the path the manual request carries.
 */
export type ReviewSource =
  | { kind: 'diff'; id: string; label: string }
  | { kind: 'artifact'; id: string; label: string; path: string };

export interface ReviewChoice {
  value: ManualChoice;
  label: string;
  /** Said in a tooltip, because the button itself is one word. */
  hint: string;
  primary: boolean;
}

/*
 * Deliberately carries no step id and no loop iteration. The stepper stays on
 * screen while a review is up — it sits above the subtree the overlay
 * replaces, and its focus pill survives even a collapsed stepper — so which
 * step is waiting, and which time round the loop, is already being said. A
 * copy in the panel's own header was the same fact twice.
 */
export interface ReviewRequest {
  /**
   * Identity of the *question*, not of the run. A second manual step — or the
   * same one on the next loop iteration — must not inherit the previous
   * answer's draft note, and this is what resets it.
   */
  key: string;
  /** "Decision needed" / "Your turn". */
  badge: string;
  title: string;
  /** Markdown, already templated by core. */
  instructions: string;
  sources: ReviewSource[];
  choices: ReviewChoice[];
  capture?: CaptureSpec;
}

/** The id the diff source always carries, so the overlay can address it. */
export const DIFF_SOURCE_ID = '__diff__';
