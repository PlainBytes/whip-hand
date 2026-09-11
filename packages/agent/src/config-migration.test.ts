import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadGlobalConfig } from '@whiphand/core';
import { migrateRunsRetention } from './config-migration.ts';
import { AppStateStore, EMPTY_APP_STATE } from './app-state.ts';

async function withConfigHome<T>(fn: (configHome: string) => Promise<T>): Promise<T> {
  const configHome = await mkdtemp(join(tmpdir(), 'whiphand-config-home-'));
  const prev = process.env.WHIPHAND_CONFIG_HOME;
  process.env.WHIPHAND_CONFIG_HOME = configHome;
  try {
    return await fn(configHome);
  } finally {
    if (prev === undefined) delete process.env.WHIPHAND_CONFIG_HOME;
    else process.env.WHIPHAND_CONFIG_HOME = prev;
  }
}

async function appStateWithRetention(maxPerWorkspace: number): Promise<AppStateStore> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-migration-'));
  const store = new AppStateStore(join(dir, 'app-state.json'));
  await store.mutate(() => ({ ...EMPTY_APP_STATE, runsRetention: { maxPerWorkspace } }));
  return store;
}

test('migrates a positive maxPerWorkspace into global config.yaml', async () => {
  await withConfigHome(async configHome => {
    const appState = await appStateWithRetention(10);
    await migrateRunsRetention(appState);
    const layer = await loadGlobalConfig();
    assert.equal(layer.runs?.max_retained, 10);
    // Written to disk, not just held in memory.
    const onDisk = parseYaml(await readFile(join(configHome, 'config.yaml'), 'utf8'));
    assert.equal(onDisk.runs.max_retained, 10);
  });
});

test('does nothing when maxPerWorkspace is 0 ("keep everything", already the default)', async () => {
  await withConfigHome(async () => {
    const appState = await appStateWithRetention(0);
    await migrateRunsRetention(appState);
    assert.deepEqual(await loadGlobalConfig(), {});
  });
});

test('is idempotent: does not overwrite an already-set global runs.max_retained', async () => {
  await withConfigHome(async configHome => {
    await writeFile(join(configHome, 'config.yaml'), 'runs: { max_retained: 3 }\n');
    const appState = await appStateWithRetention(99);
    await migrateRunsRetention(appState);
    const layer = await loadGlobalConfig();
    assert.equal(layer.runs?.max_retained, 3);
  });
});

test('is a clean no-op against a malformed global config.yaml', async () => {
  await withConfigHome(async configHome => {
    await writeFile(join(configHome, 'config.yaml'), 'on_findings: explode\n');
    const appState = await appStateWithRetention(10);
    await assert.doesNotReject(() => migrateRunsRetention(appState));
    // Left untouched — did not clobber the bad file with a migration write.
    assert.equal(await readFile(join(configHome, 'config.yaml'), 'utf8'), 'on_findings: explode\n');
  });
});

test('preserves other fields already in the global layer', async () => {
  await withConfigHome(async () => {
    const path = join(process.env.WHIPHAND_CONFIG_HOME!, 'config.yaml');
    await writeFile(path, 'defaults: { runner: copilot }\n');
    const appState = await appStateWithRetention(5);
    await migrateRunsRetention(appState);
    const layer = await loadGlobalConfig();
    assert.equal(layer.defaults?.runner, 'copilot');
    assert.equal(layer.runs?.max_retained, 5);
  });
});
