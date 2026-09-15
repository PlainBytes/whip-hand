/**
 * Parsing for the free-text count fields — New Run's "Max loop iterations" and
 * the run page's "Continue with more iterations". Both feed a protocol field
 * declared `z.number().int().positive()`, so anything this lets through the
 * agent would reject anyway; the point of checking here is to say so beside
 * the field instead of after the click.
 */

/**
 * The whole trimmed string as a positive integer, or undefined for anything
 * else — blank, zero, a sign, a decimal point, an exponent, or trailing junk.
 *
 * Deliberately not `parseInt`: it reads "12abc" as 12, which would start a
 * run with a budget the user never finished typing. `Number` alone is no
 * better — it accepts "1e3", "0x10" and " " (as 0). A digits-only match first
 * leaves `Number` nothing to be lenient about. The safe-integer bound turns
 * away a pasted run of digits that would round to some other count.
 */
export function parsePositiveInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n > 0 && Number.isSafeInteger(n) ? n : undefined;
}
