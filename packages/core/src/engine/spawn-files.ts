/**
 * The per-step files a spawn reads instead of an argv element (spec §3, §7).
 *
 * Prompt *content* never rides on argv: it is written by core, before the
 * spawn, into the run dir through the existing `SpawnSpec.files`, and the
 * runner is pointed at it — by stdin where the runner is verified to read a
 * piped prompt (claude's `-p`), by a short fixed argv sentence naming the file
 * everywhere else. That one move takes `%VAR%` expansion, cmd.exe's 8191-char
 * cap, its quote-beside-metacharacter refusal and half of the interactive/
 * headless divergence off the table at once, and it holds for shim shapes we
 * have never seen. Claude's settings object leaves argv the same way and is
 * passed by path.
 *
 * Step ids are validated segments, so `.{step}.{suffix}` uses the id verbatim;
 * every name here is hidden from artifact lists (manifest.ts) like the end
 * marker and the await-state file beside it.
 */
import { writeFile } from 'node:fs/promises';
import type { SpawnSpec } from '../types.ts';
import { ensureArtifactDir } from './artifacts.ts';
import { stepStateFile } from './session-end.ts';

const prompt = stepStateFile('prompt');
const harvestPrompt = stepStateFile('harvest-prompt');
const systemPrompt = stepStateFile('system-prompt.md');
const settings = stepStateFile('settings.json');

/** `.{step}.prompt` — the step's task prompt (and, for runners with no system-prompt file, the guidance ahead of it). */
export const promptPath: (runDir: string, stepId: string) => string = prompt.path;
/** `.{step}.harvest-prompt` — what a resume-based harvest sends. */
export const harvestPromptPath: (runDir: string, stepId: string) => string = harvestPrompt.path;
/** `.{step}.system-prompt.md` — the interactive guidance, for a runner that takes a system-prompt *file*. */
export const systemPromptPath: (runDir: string, stepId: string) => string = systemPrompt.path;
/** `.{step}.settings.json` — claude's settings object, passed by path. */
export const settingsPath: (runDir: string, stepId: string) => string = settings.path;

/** True for any of the names above — hidden from artifact lists. */
export function isSpawnFileName(name: string): boolean {
  return prompt.isName(name) || harvestPrompt.isName(name) || systemPrompt.isName(name) || settings.isName(name);
}

/** Removes every leftover so a spawn never reads a stale copy of a file the adapter no longer emits. Never throws. */
export async function clearSpawnFiles(runDir: string, stepId: string): Promise<void> {
  await Promise.all([prompt, harvestPrompt, systemPrompt, settings].map(file => file.clear(runDir, stepId)));
}

/** Where auto-naming keeps the prompt it asks a runner (it has no step to hang a `.{step}.` name on). */
export const SUGGEST_PROMPT_NAME = '.name.suggest-prompt';

/** A spawn file that could not be written — the caller fails the step with `message`, which names the file. */
export class SpawnFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnFilesError';
  }
}

/**
 * Writes a spawn's files before the spawn, so adapters themselves stay pure —
 * they only ever describe what to write, never touch the filesystem. LF, UTF-8,
 * no BOM. A failure is loud and names the file (invariant 7): a prompt or a
 * settings object that could not be written must fail the step, never be
 * replaced by a silent `[]` or an empty prompt. Throws `SpawnFilesError`.
 */
export async function writeSpecFiles(spec: SpawnSpec): Promise<void> {
  for (const file of spec.files ?? []) {
    try {
      await ensureArtifactDir(file.path);
      await writeFile(file.path, file.content, 'utf8');
    } catch (error) {
      throw new SpawnFilesError(`could not write ${file.path}, which the runner needs to start: ${(error as Error).message}`);
    }
  }
}
