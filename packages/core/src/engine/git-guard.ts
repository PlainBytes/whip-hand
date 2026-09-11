import { execFile } from 'node:child_process';
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
