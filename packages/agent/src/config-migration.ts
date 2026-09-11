/**
 * One-time migration of the app-state retention preference into global
 * config.yaml. Lives here (not in @whiphand/core's config load path) because it
 * writes, and core's loaders are read-only. Runs once at agent startup;
 * idempotent thereafter — once global config.yaml has its own
 * `runs.max_retained` (set by this migration or by a human), it never runs
 * again.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { globalConfigPath, loadGlobalConfig } from '@whiphand/core';
import type { AppStateStore } from './app-state.ts';

export async function migrateRunsRetention(appState: AppStateStore): Promise<void> {
  // A clean no-op against a global config.yaml that's malformed: don't let a
  // bad file block startup, and don't clobber it with a migration write.
  const global = await loadGlobalConfig().catch(() => undefined);
  if (global === undefined) return;
  // Already has its own opinion — set by an earlier migration run, or by a
  // human — so there's nothing left to migrate.
  if (global.runs?.max_retained !== undefined) return;

  const { maxPerWorkspace } = (await appState.get()).runsRetention;
  // 0 means "keep everything" in the old field, which is already
  // DEFAULT_CONFIG's behavior for an absent max_retained — nothing to write.
  if (maxPerWorkspace <= 0) return;

  const path = globalConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml({ ...global, runs: { max_retained: maxPerWorkspace } }), 'utf8');
}
