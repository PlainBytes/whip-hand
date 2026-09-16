/**
 * Parsing the free-text numeric fields on a step card (a loop's max
 * iterations, a command's timeout) back into the workflow draft.
 *
 * Blank is a real value in those fields — "unset, use the default" — so the
 * text maps straight onto the draft field, and anything that isn't a positive
 * whole number clears it rather than writing a 0 or NaN into the YAML. Shared
 * by StepCard and StepRail so both fields agree on what counts.
 */

/**
 * A positive integer, or undefined for blank/zero/negative/garbage. Lenient
 * the way `parseInt` is: "12s" reads as 12 and "1.5" as 1 — unlike the New
 * Run dialog's `parsePositiveInt`, which refuses both.
 */
export function numberOrUndefined(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * A non-negative integer, or undefined for blank/negative/garbage — for the
 * one field where 0 is a real setting rather than a slip: a stages step's
 * Max retries, where 0 means "no retries, a failing stage goes straight to
 * its gate" (schema.ts allows it). Same `parseInt` leniency as above.
 */
export function nonNegativeOrUndefined(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
