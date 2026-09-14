/**
 * Naming for opencode's own interactive support files — the guidance
 * instruction and the await-state/session-capture plugin, both delivered via
 * `SpawnSpec.files`. Kept apart from the adapter so manifest.ts (which hides
 * them from artifact lists, exactly like `.done` and `.await`) does not have
 * to import an adapter module to do it.
 */
import { join } from 'node:path';
import { sanitizeStepId } from './session-end.ts';

export function opencodeGuidanceName(stepId: string): string {
  return `.${sanitizeStepId(stepId)}.guidance.md`;
}
export function opencodeGuidancePath(runDir: string, stepId: string): string {
  return join(runDir, opencodeGuidanceName(stepId));
}
export function opencodePluginName(stepId: string): string {
  return `.${sanitizeStepId(stepId)}.opencode-plugin.mjs`;
}
export function opencodePluginPath(runDir: string, stepId: string): string {
  return join(runDir, opencodePluginName(stepId));
}
/** True for any name opencodeGuidanceName/opencodePluginName could have produced — hidden from artifact lists. */
export function isOpencodeSupportFileName(name: string): boolean {
  return /^\..+\.guidance\.md$/.test(name) || /^\..+\.opencode-plugin\.mjs$/.test(name);
}
