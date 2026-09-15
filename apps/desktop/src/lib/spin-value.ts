/**
 * Reading a whole number out of a Fluent SpinButton's onChange.
 *
 * The component reports a change in one of two shapes: a step (arrow button,
 * arrow key) carries `value`, while typing and then blurring carries only
 * `displayValue` — the raw text — with `value` left undefined or null. Every
 * settings field that uses a SpinButton has to fold those together and then
 * refuse what the text can't mean, so the folding lives here once instead of
 * being re-typed (and slowly diverging) beside each field.
 */
import type { SpinButtonOnChangeData } from '@fluentui/react-components';

export interface SpinIntegerBounds {
  min: number;
  max?: number;
}

/**
 * The integer the user settled on, or undefined when there isn't a usable
 * one — blank text, a fraction, garbage, or a number outside the bounds.
 * Undefined means "ignore this change": the SpinButton keeps showing the last
 * value that was accepted, which is the right correction for a typo.
 */
export function spinInteger(data: SpinButtonOnChangeData, { min, max }: SpinIntegerBounds): number | undefined {
  const next = data.value ?? (data.displayValue ? Number(data.displayValue) : undefined);
  if (typeof next !== 'number' || !Number.isInteger(next)) return undefined;
  if (next < min || (max !== undefined && next > max)) return undefined;
  return next;
}
