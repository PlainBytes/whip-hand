/**
 * The run name: an optional human label shown wherever the run id is shown.
 * A marker file (like run-lock.ts) rather than a run.json field, since
 * RunJournal rewrites the whole manifest on every event.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const NAME_MARKER_NAME = '.name';

/**
 * Where auto-naming captures the runner's reply before folding it into the
 * marker. Lives here rather than in auto-name.ts so `isBookkeepingFile` can
 * know about it without pulling the adapter registry into manifest.ts's
 * import graph.
 */
export const SUGGEST_CAPTURE_NAME = '.name.suggest';

/** Long enough for a sentence fragment, short enough to fit a grid cell. */
export const RUN_NAME_MAX = 80;

/** How much of a name survives into a slug — a branch name, in practice. */
export const RUN_SLUG_MAX = 48;

/** Absolute path of a run's name marker. */
export function namePath(runDir: string): string {
  return join(runDir, NAME_MARKER_NAME);
}

export async function readRunName(runDir: string): Promise<string | undefined> {
  try {
    return normalizeRunName(await readFile(namePath(runDir), 'utf8')) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Writes or clears the name marker. Idempotent either way. */
export async function setRunName(runDir: string, name: string | null): Promise<void> {
  const normalized = name === null ? null : normalizeRunName(name);
  if (normalized === null) {
    await rm(namePath(runDir), { force: true });
  } else {
    await writeFile(namePath(runDir), normalized, 'utf8');
  }
}

/**
 * A name is arbitrary human text, but it ends up in a grid cell, a page title
 * and an OS notification — so it is one line, trimmed, free of control
 * characters, and bounded. Nothing usable left means "no name", which is how
 * clearing a name is spelled.
 */
export function normalizeRunName(raw: string): string | null {
  const collapsed = raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RUN_NAME_MAX)
    .trim();
  return collapsed.length === 0 ? null : collapsed;
}

/**
 * The name as a single path/ref-safe token. Produces the same shape
 * WORKFLOW_NAME_RE validates, which is already git-ref safe: no dots (so no
 * `.lock` suffix and no `..`), no leading or trailing dash, no `@{`.
 *
 * Returns '' when the name held nothing usable (all punctuation, all emoji);
 * callers fall back to the run id rather than emitting an empty segment.
 */
export function slugifyRunName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, RUN_SLUG_MAX)
    .replace(/-+$/, '');
}

/** The slug a run's templates and env vars see: its name's, else its id. */
export function runSlugFor(runId: string, name: string | undefined): string {
  if (name === undefined) return runId;
  const slug = slugifyRunName(name);
  return slug.length === 0 ? runId : slug;
}
