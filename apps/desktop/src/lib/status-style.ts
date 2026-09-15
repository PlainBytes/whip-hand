/**
 * The single source of truth for status marker size and the waiting colour —
 * same spirit as `AWAIT_LABEL` in await-copy.ts for wording. Every
 * single-symbol status marker (the Activity badge, the ongoing-runs status,
 * the step pill status) reads its size from here, and every "waiting on you"
 * marker reads its colour from here, so none of them can drift apart again.
 */

/** Fluent `Badge`/`CounterBadge` size name; 24px. */
export const STATUS_BADGE_SIZE = 'large' as const;
/** Fluent `Spinner` size name; 24px, matching a large badge. */
export const STATUS_SPINNER_SIZE = 'extra-small' as const;
/** Pixel size for plain glyphs (e.g. the pending circle) matching a large badge. */
export const STATUS_GLYPH_PX = 24;

/**
 * "Someone is waiting on you" — Fluent filled `warning` (yellow). Deliberately
 * not `severe`: dark orange already means interrupted. Waiting markers must be
 * real Fluent `Badge`s so the fill and the inner symbol always match.
 */
export const WAITING_BADGE_COLOR = 'warning' as const;
