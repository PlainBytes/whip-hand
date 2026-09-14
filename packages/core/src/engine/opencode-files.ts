/**
 * Naming for opencode's own interactive support files — the guidance
 * instruction and the await-state/session-capture plugin, both delivered via
 * `SpawnSpec.files`. Kept apart from the adapter so manifest.ts (which hides
 * them from artifact lists, exactly like `.done` and `.await`) does not have
 * to import an adapter module to do it.
 */
import { stepStateFile } from './session-end.ts';

// Neither needs clearing before a spawn: writeSpecFiles rewrites both from the
// spec every time, so there is never a stale copy for a session to read.
const guidance = stepStateFile('guidance.md');
const plugin = stepStateFile('opencode-plugin.mjs');

export const opencodeGuidanceName: (stepId: string) => string = guidance.name;
export const opencodeGuidancePath: (runDir: string, stepId: string) => string = guidance.path;
export const opencodePluginName: (stepId: string) => string = plugin.name;
export const opencodePluginPath: (runDir: string, stepId: string) => string = plugin.path;
/** True for any name opencodeGuidanceName/opencodePluginName could have produced — hidden from artifact lists. */
export function isOpencodeSupportFileName(name: string): boolean {
  return guidance.isName(name) || plugin.isName(name);
}
