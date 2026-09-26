/**
 * Naming for opencode's own interactive support files — the guidance
 * instruction and the await-state/session-capture plugin, both delivered via
 * `SpawnSpec.files`. Kept apart from the adapter so manifest.ts (which hides
 * them from artifact lists, exactly like `.done` and `.await`) does not have
 * to import an adapter module to do it.
 */
import { stepStateFile } from './session-end.ts';
import { join } from 'node:path';

// Neither needs clearing before a spawn: writeSpecFiles rewrites both from the
// spec every time, so there is never a stale copy for a session to read.
const guidance = stepStateFile('guidance.md');

/**
 * OpenCode 2.0+ requires plugins to be directories containing an index.mjs.
 * The plugin directory name pattern for a step.
 */
const pluginDirPrefix = '.opencode-plugin-';
const pluginDirName = (stepId: string): string => `${pluginDirPrefix}${stepId}`;
const pluginDirPath = (runDir: string, stepId: string): string => join(runDir, pluginDirName(stepId));
const pluginIndexPath = (runDir: string, stepId: string): string => join(pluginDirPath(runDir, stepId), 'index.mjs');

export const opencodeGuidanceName = guidance.name;
export const opencodeGuidancePath = guidance.path;
export const opencodePluginName = pluginDirName;
export const opencodePluginPath = pluginDirPath;
export const opencodePluginIndexPath = pluginIndexPath;
/** True for any name opencodeGuidanceName/opencodePluginName could have produced — hidden from artifact lists. */
export function isOpencodeSupportFileName(name: string): boolean {
  return guidance.isName(name) || name.startsWith(pluginDirPrefix);
}
