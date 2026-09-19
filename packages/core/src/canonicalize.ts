/**
 * Workspace open (invariant 4, the identity half).
 *
 * Case is the easy half of "is this the same folder": Windows also aliases one
 * directory as an 8.3 short name (`C:\PROGRA~1\Git`), a `subst` drive, a
 * junction, a redirected `%LOCALAPPDATA%`, a mapped drive and its UNC target.
 * Canonicalizing answers all of them but is I/O — it can fail on EPERM or a
 * disconnected share, and it cannot answer for a path we are *about to create*,
 * which is most containment questions. So there are two functions with
 * different jobs, and no third:
 *
 *  - **Containment** ("is this inside that", the write-guard's question) is the
 *    *pure* comparator in path-form.ts: case-fold, unify separators, resolve
 *    `.`/`..` lexically, no I/O. A security check must not fail open when the
 *    disk is unreachable.
 *  - **Workspace identity** ("is this the same place", where being wrong means
 *    duplicate state) canonicalizes *once, at workspace open* — here — stores the
 *    canonical form, and every later comparison is the pure one against it.
 *
 * Two values are produced side by side. `root` is the path **as the user opened
 * it**, lexically normalized only, and it is the operational path for everything
 * (spawn `cwd`, fs grants, run dirs, relative-path emission, containment): so
 * `subst` and mapped drives keep working, because no operation ever uses the
 * canonical form. `identityKey` is `realpath.native` of it, case-folded, used
 * **only** to answer "same workspace?". If canonicalization fails the key falls
 * back to the lexical form and a `workspace-identity` degradation is recorded; it
 * never throws the workspace shut.
 */
import { realpath } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DegradationId } from './degradations.ts';
import { isUncPath, pathKey, toFwdAbs } from './path-form.ts';

/** Windows' classic MAX_PATH, terminator included. */
export const WINDOWS_MAX_PATH = 260;

/**
 * How much the engine may add below the workspace root: the deepest path it can
 * construct — `.whiphand/runs/<run id>/` plus nested stage and loop frames,
 * `attempt-N` and `iter-N` segments, and a step output — stays under this many
 * characters when the *authored* names are ordinary. A number, not "stay short",
 * because only a number is checkable (canonicalize.test.ts builds that path).
 */
export const ENGINE_PATH_BUDGET = 120;

export class WorkspaceRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRefusal';
  }
}

export interface OpenedWorkspace {
  /** As the user opened it, lexically normalized. The operational path for everything. */
  root: string;
  /** `realpath.native`, case-folded (or the lexical fallback). Compared with `samePath`/`===` on the key. */
  identityKey: string;
  /** Recorded when canonicalization failed and the key fell back to the lexical form. */
  degradations: Array<{ capability: DegradationId; reason: string }>;
  /** Legible warnings to show before the run starts — the long-path headroom check. */
  warnings: string[];
}

export interface OpenWorkspaceDeps {
  platform?: NodeJS.Platform;
  /** Substituted by tests: `realpath.native` in production. */
  canonicalize?: (p: string) => Promise<string>;
}

/**
 * A typed UNC workspace (`\\server\share\proj`) is refused, by string, with a
 * clear message rather than half-working. Mapped drive letters still work.
 * Detecting *redirection* (a Folder-Redirected profile that is UNC behind the
 * scenes) would need canonicalization and would refuse to run on a large share
 * of corporate machines, so it is deliberately not attempted.
 */
export function assertNotUnc(input: string): void {
  if (isUncPath(input)) {
    throw new WorkspaceRefusal(
      `'${input}' is a network (UNC) path, which whiphand does not support as a workspace. `
      + 'Map the share to a drive letter (`net use Z: \\\\server\\share`) and open it as Z:\\… instead.');
  }
}

/** Headroom warning, or null: the deepest engine path must fit under MAX_PATH from this root. */
export function headroomWarning(root: string, budget = ENGINE_PATH_BUDGET): string | null {
  const used = root.length + 1 + budget;
  if (used < WINDOWS_MAX_PATH) return null;
  return `this workspace path is ${root.length} characters; whiphand's deepest artifact paths add up to `
    + `${budget} more, which is over Windows' ${WINDOWS_MAX_PATH}-character limit — a run may fail with ENAMETOOLONG `
    + 'from whichever file operation happens to be first. Open the project through a shorter path (`subst X: <folder>` '
    + 'gives it a drive letter).';
}

export async function openWorkspace(input: string, deps: OpenWorkspaceDeps = {}): Promise<OpenedWorkspace> {
  const platform = deps.platform ?? process.platform;
  assertNotUnc(input);
  const root = (platform === 'win32' ? path.win32 : path).resolve(input);
  const degradations: OpenedWorkspace['degradations'] = [];
  let identityKey: string;
  try {
    identityKey = pathKey(await (deps.canonicalize ?? promisify(realpath.native))(root));
  } catch (error) {
    identityKey = pathKey(root);
    degradations.push({
      capability: 'workspace-identity',
      reason: `could not canonicalize ${toFwdAbs(root)} (${(error as Error).message}); comparing it by its lexical form`,
    });
  }
  const warning = platform === 'win32' ? headroomWarning(root) : null;
  return { root, identityKey, degradations, warnings: warning === null ? [] : [warning] };
}
