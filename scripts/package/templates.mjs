/**
 * The workflows `whiphand init` ships (packages/core/templates/*.yaml), embedded
 * as SEA assets under `templates/<name>.yaml` — the key
 * packages/core/src/templates.ts reads them back by. The agent sidecar
 * scaffolds through its RPCs; the Rust CLI compiles the same files in
 * (crates/whiphand-core/src/scaffold.rs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './sea.mjs';

export const TEMPLATES_DIR = path.join(repoRoot, 'packages/core/templates');

/** The `assets` entries for buildSingleExecutable: one per template file. */
export function templateAssets() {
  return Object.fromEntries(
    fs.readdirSync(TEMPLATES_DIR)
      .filter(file => file.endsWith('.yaml'))
      .map(file => [`templates/${file}`, path.join(TEMPLATES_DIR, file)]),
  );
}
