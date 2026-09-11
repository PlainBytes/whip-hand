import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG, diffConfigLayer, loadConfigLayer, loadGlobalConfig, loadWorkspaceConfig, mergeConfig,
  partialConfigSchema,
} from './config.ts';
import { WorkflowError } from './schema.ts';

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

test('missing config yields defaults', async () => {
  await withConfigHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
    const cfg = await loadWorkspaceConfig(dir);
    assert.deepEqual(cfg, {
      defaults: { runner: 'claude' },
      on_findings: 'report',
      loop: { max_iterations: 3 },
      artifacts_dir: '.whiphand/runs',
      runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
    });
  });
});

test('partial config merges over defaults', async () => {
  await withConfigHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
    await mkdir(join(dir, '.whiphand'));
    await writeFile(join(dir, '.whiphand', 'config.yaml'), 'on_findings: loop\nloop: { max_iterations: 5 }\n');
    const cfg = await loadWorkspaceConfig(dir);
    assert.equal(cfg.on_findings, 'loop');
    assert.equal(cfg.loop.max_iterations, 5);
    assert.equal(cfg.defaults.runner, 'claude');
  });
});

test('runs.max_retained: a positive number and null both round-trip; absent stays null', async () => {
  await withConfigHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
    await mkdir(join(dir, '.whiphand'));

    await writeFile(join(dir, '.whiphand', 'config.yaml'), 'runs: { max_retained: 5 }\n');
    assert.equal((await loadWorkspaceConfig(dir)).runs.max_retained, 5);

    await writeFile(join(dir, '.whiphand', 'config.yaml'), 'runs: { max_retained: null }\n');
    assert.equal((await loadWorkspaceConfig(dir)).runs.max_retained, null);

    await writeFile(join(dir, '.whiphand', 'config.yaml'), 'on_findings: loop\n');
    assert.equal((await loadWorkspaceConfig(dir)).runs.max_retained, null);
  });
});

test('runs.max_retained: a legacy 0 loads and normalizes to null, but a negative still errors', async () => {
  await withConfigHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
    await mkdir(join(dir, '.whiphand'));

    // The pre-scopes settings page wrote `0` for "keep everything" (its
    // SpinButton had min={0}), so these files exist. Rejecting them would
    // break `whiphand run`, configGet and startRun in that workspace with nothing
    // to migrate them — so 0 is read, and normalized to the null that means
    // the same thing. Normalized in the *layer* too, not just the merge, so
    // a settings page reading the raw layer never sees the retired spelling.
    const path = join(dir, '.whiphand', 'config.yaml');
    await writeFile(path, 'runs: { max_retained: 0 }\n');
    assert.equal((await loadWorkspaceConfig(dir)).runs.max_retained, null);
    assert.deepEqual(await loadConfigLayer(path), { runs: { max_retained: null } });

    // A 0 is only tolerated because it once had a meaning. A negative never did.
    await writeFile(path, 'runs: { max_retained: -1 }\n');
    await assert.rejects(() => loadWorkspaceConfig(dir), WorkflowError);
  });
});

test('a 0 in the global layer inherits as null rather than capping every workspace at zero', async () => {
  await withConfigHome(async configHome => {
    await writeFile(join(configHome, 'config.yaml'), 'runs: { max_retained: 0 }\n');
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
    assert.equal((await loadWorkspaceConfig(dir)).runs.max_retained, null);
  });
});

test('invalid config throws WorkflowError', async () => {
  await withConfigHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
    await mkdir(join(dir, '.whiphand'));
    await writeFile(join(dir, '.whiphand', 'config.yaml'), 'on_findings: explode\n');
    await assert.rejects(loadWorkspaceConfig(dir), WorkflowError);
  });
});

test('global config.yaml is inherited when the project has no config of its own', async () => {
  await withConfigHome(async configHome => {
    await writeFile(join(configHome, 'config.yaml'), 'defaults: { runner: copilot }\n');
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
    const cfg = await loadWorkspaceConfig(dir);
    assert.equal(cfg.defaults.runner, 'copilot');
  });
});

test('project overrides one field without wiping a global-set sibling field', async () => {
  await withConfigHome(async configHome => {
    await writeFile(
      join(configHome, 'config.yaml'),
      'defaults: { runner: copilot }\nloop: { max_iterations: 7 }\n',
    );
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
    await mkdir(join(dir, '.whiphand'));
    // Project sets only defaults.runner — loop.max_iterations must still come
    // from the global layer, not fall back past it to DEFAULT_CONFIG.
    await writeFile(join(dir, '.whiphand', 'config.yaml'), 'defaults: { runner: claude }\n');
    const cfg = await loadWorkspaceConfig(dir);
    assert.equal(cfg.defaults.runner, 'claude');
    assert.equal(cfg.loop.max_iterations, 7);
  });
});

test('loadGlobalConfig reads WHIPHAND_CONFIG_HOME/config.yaml, empty layer when absent', async () => {
  await withConfigHome(async configHome => {
    assert.deepEqual(await loadGlobalConfig(), {});
    await writeFile(join(configHome, 'config.yaml'), 'on_findings: interactive\n');
    assert.deepEqual(await loadGlobalConfig(), { on_findings: 'interactive' });
  });
});

test('loadConfigLayer throws WorkflowError on a malformed layer, same as loadWorkspaceConfig', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
  const path = join(dir, 'config.yaml');
  await writeFile(path, 'on_findings: explode\n');
  await assert.rejects(loadConfigLayer(path), WorkflowError);
});

test('mergeConfig: absent-vs-null on runs.max_retained — absent inherits, null is terminal', () => {
  const withGlobalCap = mergeConfig(DEFAULT_CONFIG, { runs: { max_retained: 10 } });
  assert.equal(withGlobalCap.runs.max_retained, 10);

  // Project layer sets nothing for `runs` at all: inherits the global cap.
  const projectAbsent = mergeConfig(withGlobalCap, {});
  assert.equal(projectAbsent.runs.max_retained, 10);

  // Project layer explicitly asks to keep everything: overrides, does not
  // fall through to the global cap the way `??` would.
  const projectNull = mergeConfig(withGlobalCap, { runs: { max_retained: null } });
  assert.equal(projectNull.runs.max_retained, null);
});

test('mergeConfig: a layer touching only one field leaves every other leaf from the base untouched', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { defaults: { runner: 'copilot' } });
  assert.deepEqual(merged, { ...DEFAULT_CONFIG, defaults: { runner: 'copilot' } });
});

test('diffConfigLayer: only fields that differ from the base are written', () => {
  const base = mergeConfig(DEFAULT_CONFIG, { defaults: { runner: 'copilot' } });
  const full = { ...base, on_findings: 'loop' as const };
  assert.deepEqual(diffConfigLayer(full, base), { on_findings: 'loop' });
});

test('diffConfigLayer: a value equal to the base produces an empty layer (round-trips through mergeConfig)', () => {
  const base = DEFAULT_CONFIG;
  const layer = diffConfigLayer(base, base);
  assert.deepEqual(layer, {});
  assert.deepEqual(mergeConfig(base, layer), base);
});

test('diffConfigLayer: emits runs.auto_name, and both runs leaves survive together', () => {
  const base = DEFAULT_CONFIG;
  const on = { ...base, runs: { ...base.runs, auto_name: true } };
  assert.deepEqual(diffConfigLayer(on, base), { runs: { auto_name: true } });

  // One `runs` object, not two assignments where the second wins.
  const both = { ...base, runs: { ...base.runs, max_retained: 5, auto_name: true } };
  assert.deepEqual(diffConfigLayer(both, base), { runs: { max_retained: 5, auto_name: true } });

  // And it round-trips: what configSet writes is what configGet reads back.
  assert.equal(mergeConfig(base, diffConfigLayer(on, base)).runs.auto_name, true);
});

test('diffConfigLayer: distinguishes an explicit null override from inheriting the base', () => {
  const base = mergeConfig(DEFAULT_CONFIG, { runs: { max_retained: 10 } });
  const full = { ...base, runs: { ...base.runs, max_retained: null } };
  assert.deepEqual(diffConfigLayer(full, base), { runs: { max_retained: null } });
});

test('a malformed layer names the file that has to be fixed, for both YAML and schema errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
  const path = join(dir, 'config.yaml');

  // A schema failure: one bad global config.yaml fails the load in every
  // workspace on the machine, so "which of the two files?" has to be answerable.
  await writeFile(path, 'on_findings: explode\n');
  await assert.rejects(loadConfigLayer(path), (e: unknown) => {
    assert.ok(e instanceof WorkflowError);
    assert.match(e.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });

  // A YAML syntax error used to escape as a raw YAMLParseError, past every
  // caller that handles WorkflowError.
  await writeFile(path, 'on_findings: [unclosed\n');
  await assert.rejects(loadConfigLayer(path), (e: unknown) => {
    assert.ok(e instanceof WorkflowError);
    assert.match(e.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
});

test('a malformed global config.yaml fails loadWorkspaceConfig naming the global path', async () => {
  await withConfigHome(async configHome => {
    const globalPath = join(configHome, 'config.yaml');
    await writeFile(globalPath, 'loop: { max_iterations: nope }\n');
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
    await assert.rejects(loadWorkspaceConfig(dir), (e: unknown) => {
      assert.ok(e instanceof WorkflowError);
      assert.ok(e.message.includes(globalPath), `expected the global path in: ${e.message}`);
      return true;
    });
  });
});

test('diffConfigLayer: an explicit key is written even when it equals the base', () => {
  const base = mergeConfig(DEFAULT_CONFIG, { runs: { max_retained: 10 } });
  const full = { ...base, runs: { ...base.runs, max_retained: 10 } };

  // Without the pin this is a no-op diff, and the workspace silently follows
  // the next change to the layer beneath.
  assert.deepEqual(diffConfigLayer(full, base), {});
  assert.deepEqual(diffConfigLayer(full, base, ['runs.max_retained']), { runs: { max_retained: 10 } });

  // The pin survives a later global change: the workspace stays at 10.
  const raised = mergeConfig(DEFAULT_CONFIG, { runs: { max_retained: 50 } });
  const pinned = diffConfigLayer(full, base, ['runs.max_retained']);
  assert.equal(mergeConfig(raised, pinned).runs.max_retained, 10);
});

test('diffConfigLayer: pinning one key leaves every other leaf out of the layer', () => {
  const base = mergeConfig(DEFAULT_CONFIG, { defaults: { runner: 'copilot' } });
  assert.deepEqual(diffConfigLayer(base, base, ['on_findings']), { on_findings: base.on_findings });
});

test('runs.max_attachment_mb defaults to 25, merges per leaf, and diffs on its own', () => {
  assert.equal(DEFAULT_CONFIG.runs.max_attachment_mb, 25);
  const merged = mergeConfig(DEFAULT_CONFIG, { runs: { max_attachment_mb: 50 } }, { runs: { auto_name: true } });
  assert.deepEqual(merged.runs, { max_retained: null, auto_name: true, max_attachment_mb: 50 });
  assert.deepEqual(diffConfigLayer(merged, DEFAULT_CONFIG), { runs: { auto_name: true, max_attachment_mb: 50 } });
});

test('a config layer rejects a max_attachment_mb that is not positive', () => {
  assert.equal(partialConfigSchema.safeParse({ runs: { max_attachment_mb: 0 } }).success, false);
  assert.equal(partialConfigSchema.safeParse({ runs: { max_attachment_mb: 0.5 } }).success, true);
});
