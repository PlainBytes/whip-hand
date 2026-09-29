/**
 * The workflows `whiphand init` ships, as plain YAML files under
 * `packages/core/templates/`. A source checkout reads them from disk; a packaged
 * build (SEA) carries them as assets named `templates/<name>.yaml` — see
 * scripts/package/templates.mjs — because a single executable has no files
 * beside it to read.
 */
import { readFileSync } from 'node:fs';

/** Every shipped template, in the order `initWorkspace` writes them. */
export const SHIPPED_TEMPLATES = [
  'feature', 'feature-development', 'spec-driven', 'staged-feature-development', 'research', 'bugfix',
] as const;

export type ShippedTemplate = typeof SHIPPED_TEMPLATES[number];

/** The template's text, byte for byte as it is in `packages/core/templates/`. */
export function readTemplate(name: ShippedTemplate): string {
  const asset = readSeaAsset(`templates/${name}.yaml`);
  if (asset !== undefined) return asset;
  return readFileSync(new URL(`../templates/${name}.yaml`, import.meta.url), 'utf8');
}

function readSeaAsset(key: string): string | undefined {
  // node:sea is only meaningful inside a single-executable application.
  const sea = process.getBuiltinModule?.('node:sea') as
    { isSea?: () => boolean; getAsset?: (key: string, encoding: string) => string } | undefined;
  if (sea?.isSea?.() !== true || sea.getAsset === undefined) return undefined;
  return sea.getAsset(key, 'utf8');
}
