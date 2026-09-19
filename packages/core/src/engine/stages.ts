/**
 * Which stage files a `kind: stages` step will iterate, in what order, and
 * which one runs next. Pure discovery — no execution, no schema, no events;
 * the runner (a later task) drives a stage's body once this says what and
 * in what order.
 */
import { glob, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Stage } from '../types.ts';
import { validateSegment } from '../segment.ts';

export class StageError extends Error {}

/** Extra attempts a failing stage gets when its `stages` step sets no `max_retries`. */
export const DEFAULT_STAGE_RETRIES = 2;

/** Characters that would corrupt a `stage:<id>` execution key or a path segment. */
const UNSAFE_ID_CHARS = /[@#/\\]/;

/** `NN-slug` (with an optional letter suffix, e.g. `03a-api`) sorts predictably. */
const CONVENTIONAL_ID = /^\d+[a-z]*-/;

/**
 * The first `# heading` in a stage file, else `fallback` (the id) — most
 * plans open with one, and falling back to the id rather than erroring keeps
 * a heading-less file usable instead of blocking the whole run over it.
 */
export function stageTitleOf(text: string, fallback: string): string {
  const m = text.match(/^#\s+(.+?)\s*$/m);
  return m?.[1] ?? fallback;
}

/**
 * Resolves `pattern` against `workdir` (never `process.cwd()` — a run's
 * plan lives wherever its workdir says, not wherever whiphand happened to be
 * launched from) and returns one `Stage` per match.
 *
 * Order is the workdir-relative path compared with plain `<`, not
 * `localeCompare`: locale/numeric collation would sort `03a-api` after
 * `04-ui` (treating "3a" as bigger than "4"), which defeats the entire point
 * of letter-suffixed insertions landing between two numbered stages.
 *
 * `stage.id` is the whole basename minus extension, not the slug with the
 * ordinal stripped: stripping ordinals would collide `01-api` and
 * `03a-api` on `api`, and the runner picks the next stage as "the first id
 * not yet completed" — so the second file would silently never run. The
 * price is that renumbering an already-completed stage file makes it run
 * again, which is an acceptable, visible surprise next to a stage that
 * never runs at all.
 */
export async function discoverStages(workdir: string, pattern: string): Promise<Stage[]> {
  const relPaths: string[] = [];
  // glob yields native separators; '/' keeps the order and the paths named in
  // errors the same on every platform, and matches how the pattern was written.
  for await (const p of glob(pattern, { cwd: workdir })) relPaths.push(p.replace(/\\/g, '/'));
  relPaths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const stages = await Promise.all(relPaths.map(async (relPath) => {
    const path = resolve(workdir, relPath);
    const file = basename(path);
    const id = file.replace(/\.[^.]+$/, '');
    if (UNSAFE_ID_CHARS.test(id)) {
      throw new StageError(
        `stage file '${file}': a stage name cannot contain '@', '#', '/' or '\\'`);
    }
    // A stage id becomes a directory in the run (invariant 3), so it is held to
    // what Windows accepts on every platform.
    const segment = validateSegment(id);
    if (!segment.ok) throw new StageError(`stage file '${file}': its id '${id}' ${segment.reason}`);
    // The plan directory is the author's, and it may change mid-run: a match
    // that is a directory, or a file removed between the glob and this read,
    // is a problem with the plan to name, not a crash.
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === undefined) throw e;
      const why = code === 'EISDIR' ? 'is a directory, not a stage file'
        : code === 'ENOENT' ? 'disappeared before it could be read'
          : `could not be read (${code})`;
      throw new StageError(`stage file '${relPath}' ${why}`);
    }
    return { id, title: stageTitleOf(text, id), path };
  }));

  return stages.map((s, i) => ({ index: i + 1, total: stages.length, id: s.id, title: s.title, path: s.path }));
}

/** The first stage (in order) whose id is not in `completed`. */
export function nextStage(stages: Stage[], completed: ReadonlySet<string>): Stage | undefined {
  return stages.find(s => !completed.has(s.id));
}

/**
 * Ids that don't read as `NN-slug` — reported by the runner as
 * `guard:warning`, not a failure: the `NN-` convention is what keeps
 * ordering predictable (see discoverStages), so a stray file breaking it is
 * worth flagging, but not worth stopping a run over.
 */
export function oddStageNames(stages: Stage[]): string[] {
  return stages.filter(s => !CONVENTIONAL_ID.test(s.id)).map(s => s.id);
}
