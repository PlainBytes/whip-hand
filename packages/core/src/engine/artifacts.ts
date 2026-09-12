import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { LoopFrame } from '../types.ts';

export class ArtifactError extends Error {
  /** Which of assertArtifact's two checks failed — what lets a caller emit `step:artifact-missing` distinctly from a crash. */
  reason: 'absent' | 'empty';
  constructor(message: string, reason: 'absent' | 'empty') {
    super(message);
    this.name = 'ArtifactError';
    this.reason = reason;
  }
}

export async function createRunDir(
  workdir: string, artifactsDir: string,
): Promise<{ runId: string; runDir: string }> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const runId = `${stamp}-${randomBytes(2).toString('hex')}`;
  const runDir = resolve(workdir, artifactsDir, runId);
  await mkdir(runDir, { recursive: true });
  return { runId, runDir };
}

/**
 * Where a step's artifact lands. Top-level steps keep the original flat
 * `<runDir>/<output>`; a step running inside a loop gets its own directory per
 * iteration, so iteration 2 can no longer silently overwrite what iteration 1
 * produced — the history is what makes a cycle reviewable afterwards.
 */
export function artifactPath(
  runDir: string, step: { output: string }, frame?: LoopFrame,
): string {
  if (frame === undefined) return join(runDir, step.output);
  return join(runDir, frame.id, `iter-${frame.iteration}`, step.output);
}

/** Creates the directory an artifact is about to be written into. */
export async function ensureArtifactDir(artifact: string): Promise<void> {
  await mkdir(dirname(artifact), { recursive: true });
}

export async function assertArtifact(path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ArtifactError(`expected artifact was not written: ${path}`, 'absent');
  }
  if (text.trim().length === 0) throw new ArtifactError(`artifact is empty: ${path}`, 'empty');
}
