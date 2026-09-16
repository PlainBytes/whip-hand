import { execFile } from 'node:child_process';
import { matchesGlob } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function snapshotTree(workdir: string): Promise<string | null> {
  try {
    const { stdout } = await run(
      'git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: workdir });
    return stdout.split('\n').filter(Boolean).sort().join('\n');
  } catch {
    return null; // not a git repo (or git missing): guard disabled
  }
}

export function diffSnapshots(before: string, after: string): string[] {
  const beforeSet = new Set(before.split('\n').filter(Boolean));
  return after
    .split('\n')
    .filter(Boolean)
    .filter(line => !beforeSet.has(line))
    .filter(line => !line.includes('.whiphand/'));
}

/**
 * The current commit whiphand is running against, or `null` outside a git
 * repo (or with git missing) — the same "guard disabled" posture snapshotTree
 * takes, for the same reason: `run:env` reports the machine honestly rather
 * than failing the run over a fact it cannot get.
 */
export async function headSha(workdir: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: workdir });
    return stdout.trim();
  } catch {
    return null;
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
