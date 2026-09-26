import { matchesGlob } from 'node:path';
import { execRunner } from '../exec.ts';
import { samePath } from '../path-form.ts';

/**
 * What asking git about a workspace can come back as — three answers, not two
 * (invariant 7). "Not a repository" is a fact about the workspace; "unavailable"
 * is git having been *expected to work and not working*: not on PATH, a
 * `.cmd` wrapper it cannot run, a timeout, or `detected dubious ownership` (a
 * repo owned by another user, which on Windows is routine on a shared or
 * network profile). Collapsing the second into the first is what let a
 * `writes: false` step lose its protection with nobody finding out.
 */
export type GitResult<T> =
  | ({ kind: 'ok' } & T)
  | { kind: 'not-a-repo' }
  | { kind: 'unavailable'; reason: string };

export type TreeSnapshot = GitResult<{ tree: string }>;
export type HeadResult = GitResult<{ sha: string }>;
/** `sha: null` is a repository with no commits yet — a fact about it, not a failure to read it. */
export type HeadPosition = GitResult<{ sha: string | null }>;

/**
 * The classification allowlist has exactly one entry: exit 128 **and** stderr
 * `not a git repository`. The seam runs git under `LC_ALL=C`/`LANGUAGE=C`, so
 * the wording cannot be localized away. Never classify on the exit code alone —
 * 128 is also what git says for dubious ownership and half its other fatals.
 */
export function classifyGitFailure(error: unknown): { kind: 'not-a-repo' } | { kind: 'unavailable'; reason: string } {
  const e = error as { code?: number | string; stderr?: string; message?: string };
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  if (e.code === 128 && /not a git repository/i.test(stderr)) return { kind: 'not-a-repo' };
  const detail = stderr.trim() !== '' ? stderr.trim() : (e.message ?? String(error));
  const cause = e.code === undefined ? '' : ` (${typeof e.code === 'number' ? `exit ${e.code}` : e.code})`;
  return { kind: 'unavailable', reason: `git failed${cause}: ${detail.split('\n')[0]}` };
}

export class GitUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GitUnavailableError';
  }
}

export async function snapshotTree(workdir: string): Promise<TreeSnapshot> {
  try {
    const { stdout } = await execRunner(
      ['git', 'status', '--porcelain=v1', '--untracked-files=all'], { cwd: workdir });
    return { kind: 'ok', tree: stdout.split('\n').filter(Boolean).sort().join('\n') };
  } catch (error) {
    return classifyGitFailure(error);
  }
}

export function diffSnapshots(before: string, after: string): string[] {
  const beforeSet = new Set(before.split('\n').filter(Boolean));
  return after
    .split('\n')
    .filter(Boolean)
    .filter(line => !beforeSet.has(line))
    // Whiphand's own bookkeeping directory, wherever it sits — compared by
    // segment with the pure comparator, so `.WhipHand/` is the same directory on
    // Windows and a name that merely *contains* the text is not.
    .filter(line => !pathsFromStatusLines([line]).some(p => p.split('/').some(segment => samePath(segment, '.whiphand'))));
}

/**
 * The current commit whiphand is running against — reported by `run:env`, which
 * carries on without it rather than failing the run over a fact it cannot get.
 * Still three answers, so the caller can tell the two absences apart.
 */
export async function headSha(workdir: string): Promise<HeadResult> {
  try {
    const { stdout } = await execRunner(['git', 'rev-parse', 'HEAD'], { cwd: workdir });
    return { kind: 'ok', sha: stdout.trim() };
  } catch (error) {
    return classifyGitFailure(error);
  }
}

/**
 * Where HEAD points, for the check that an agent step did not commit. Unlike
 * `headSha` it tells a repository with no commits yet apart from git failing:
 * `--verify --quiet` exits 1 with no output for an unborn HEAD, where every
 * real fatal (not a repository, dubious ownership) exits 128 and says why. A
 * fresh `git init` is exactly where an agent's first commit must still be seen.
 * (Git cannot tell an unborn HEAD from a branch ref whose file is unreadable
 * either — it answers both the same way — so neither can this.)
 */
export async function headPosition(workdir: string): Promise<HeadPosition> {
  try {
    const { stdout } = await execRunner(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: workdir });
    return { kind: 'ok', sha: stdout.trim() };
  } catch (error) {
    const e = error as { code?: number | string; stderr?: string };
    if (e.code === 1 && (typeof e.stderr !== 'string' || e.stderr.trim() === '')) return { kind: 'ok', sha: null };
    return classifyGitFailure(error);
  }
}

/**
 * Strips a `git status --porcelain` line (or a rename's `old -> new`) down to
 * the bare path(s) it names — what `step:tree-delta` wants to show, as
 * opposed to diffSnapshots' own callers, which print the status code too.
 */
export function pathsFromStatusLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const rest = line.slice(3); // porcelain v1: two status chars + one space
    const arrow = rest.indexOf(' -> ');
    if (arrow === -1) out.push(rest);
    else out.push(rest.slice(0, arrow), rest.slice(arrow + 4));
  }
  return out;
}

/**
 * `allow_paths` enforcement: which of a `writes: true` step's changed paths
 * (already the bare paths from `pathsFromStatusLines`) no declared glob
 * covers. Order-preserving, so the failure message lists them the same way
 * `step:tree-delta` did.
 */
export function pathsOutside(paths: string[], globs: string[]): string[] {
  return paths.filter(p => !globs.some(g => matchesGlob(p, g)));
}
