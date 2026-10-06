/**
 * How a workspace presents itself: its short label, its colour, and the
 * order and filtering of the switcher's list. Pure and free of React so it
 * can be unit-tested directly.
 */
import type { RecentWorkspace } from '../shared/protocol.gen.ts';

/** The last path segment, tolerating trailing separators and either style. */
export function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

/**
 * Fluent "BorderActive" palette tokens. Both webLightTheme and webDarkTheme
 * define these with separately tuned values (Blue is #0078d4 light,
 * #5caae5 dark), so a dot painted with one stays legible against
 * --colorNeutralBackground1/2 in either theme.
 *
 * Red and Green are deliberately absent: StatusBadge and DoctorPage already
 * spend them on run status and adapter health, and a workspace dot must not
 * read as "this workspace failed". The muted neutrals (Anchor, Platinum,
 * Beige, Mink, Steel) are absent too — against --colorNeutralForeground3
 * they read as "disabled".
 */
const WORKSPACE_COLOR_VARS = [
  '--colorPaletteBlueBorderActive',
  '--colorPaletteRoyalBlueBorderActive',
  '--colorPaletteCornflowerBorderActive',
  '--colorPaletteTealBorderActive',
  '--colorPaletteLightTealBorderActive',
  '--colorPalettePurpleBorderActive',
  '--colorPaletteGrapeBorderActive',
  '--colorPaletteLilacBorderActive',
  '--colorPaletteMagentaBorderActive',
  '--colorPalettePinkBorderActive',
  '--colorPaletteMarigoldBorderActive',
  '--colorPalettePumpkinBorderActive',
] as const;

/**
 * FNV-1a over the string's UTF-16 code units. Math.imul keeps the multiply
 * exactly 32-bit, so a string yields the same colour on every platform and in
 * every session — no Date, no Math.random, no locale.
 */
function hashPath(path: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The CSS custom property name (not a resolved colour) for this workspace.
 * Hashes the agent's identity key when there is one, so a workspace is one
 * colour however it was spelled; the path is all an entry without a key has.
 */
export function workspaceColorVar(path: string, identityKey?: string): string {
  return WORKSPACE_COLOR_VARS[hashPath(identityKey ?? path) % WORKSPACE_COLOR_VARS.length];
}

/**
 * Pinned first, each block keeping the list's own recency order. The
 * persisted order stays pure recency (see the agent's touchRecent) — pinning
 * is presentation, and lives here.
 */
export function sortWorkspaces(recents: readonly RecentWorkspace[]): RecentWorkspace[] {
  return [...recents.filter(r => r.pinned), ...recents.filter(r => !r.pinned)];
}

/**
 * Case-insensitive match on the label first, then anywhere in the path, so
 * typing a project name ranks its workspace above one that merely lives
 * under a directory of that name. Preserves the input order within each
 * rank, so a pinned-first list stays pinned-first.
 */
export function filterWorkspaces(
  recents: readonly RecentWorkspace[], query: string,
): RecentWorkspace[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...recents];
  const labelMatch = recents.filter(r => basename(r.path).toLowerCase().includes(q));
  const pathOnly = recents.filter(
    r => !basename(r.path).toLowerCase().includes(q) && r.path.toLowerCase().includes(q),
  );
  return [...labelMatch, ...pathOnly];
}
