import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkflowPath, parseInputPairs, listWorkflows } from './workspace.ts';

/**
 * Everything here hinges on WHIPHAND_CONFIG_HOME pointing at a temp directory: no
 * test may touch the real home directory's global workflows.
 */
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

test('resolveWorkflowPath: bare name resolves to .whiphand/workflows/<name>.yaml, checking existence', async () => {
  await withConfigHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    await mkdir(join(dir, '.whiphand', 'workflows'), { recursive: true });
    await writeFile(join(dir, '.whiphand', 'workflows', 'feature.yaml'), 'name: feature\n');
    const { path, source } = await resolveWorkflowPath('feature', dir);
    assert.equal(path, join(dir, '.whiphand', 'workflows', 'feature.yaml'));
    assert.equal(source, 'project');
  });
});

test('resolveWorkflowPath: existing path is used as-is, scoped as project', async () => {
  await withConfigHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    await writeFile(join(dir, 'custom.yaml'), 'name: x\n');
    const { path, source } = await resolveWorkflowPath('custom.yaml', dir);
    assert.equal(path, join(dir, 'custom.yaml'));
    assert.equal(source, 'project');
  });
});

test('resolveWorkflowPath: a bare name with no project file falls back to global', async () => {
  await withConfigHome(async configHome => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    await mkdir(join(configHome, 'workflows'), { recursive: true });
    await writeFile(join(configHome, 'workflows', 'feature.yaml'), 'name: feature\n');
    const { path, source } = await resolveWorkflowPath('feature', dir);
    assert.equal(path, join(configHome, 'workflows', 'feature.yaml'));
    assert.equal(source, 'global');
  });
});

test('resolveWorkflowPath: project shadows global when both exist', async () => {
  await withConfigHome(async configHome => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    await mkdir(join(dir, '.whiphand', 'workflows'), { recursive: true });
    await writeFile(join(dir, '.whiphand', 'workflows', 'feature.yaml'), 'name: feature\n');
    await mkdir(join(configHome, 'workflows'), { recursive: true });
    await writeFile(join(configHome, 'workflows', 'feature.yaml'), 'name: feature\n');
    const { source } = await resolveWorkflowPath('feature', dir);
    assert.equal(source, 'project');
  });
});

test('resolveWorkflowPath: explicit global:/project: selectors, parsed before any path attempt', async () => {
  await withConfigHome(async configHome => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    await mkdir(join(dir, '.whiphand', 'workflows'), { recursive: true });
    await writeFile(join(dir, '.whiphand', 'workflows', 'feature.yaml'), 'name: feature\n');
    await mkdir(join(configHome, 'workflows'), { recursive: true });
    await writeFile(join(configHome, 'workflows', 'feature.yaml'), 'name: feature\n');

    const project = await resolveWorkflowPath('project:feature', dir);
    assert.equal(project.source, 'project');
    assert.equal(project.path, join(dir, '.whiphand', 'workflows', 'feature.yaml'));

    const global = await resolveWorkflowPath('global:feature', dir);
    assert.equal(global.source, 'global');
    assert.equal(global.path, join(configHome, 'workflows', 'feature.yaml'));
  });
});

test('resolveWorkflowPath: explicit selector errors when the named scope lacks it', async () => {
  await withConfigHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    await assert.rejects(() => resolveWorkflowPath('global:nope', dir), /nope.*not found|not found.*global/i);
  });
});

test('resolveWorkflowPath: not found names both locations searched', async () => {
  await withConfigHome(async configHome => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    await assert.rejects(
      () => resolveWorkflowPath('missing', dir),
      (e: Error) => e.message.includes(join(dir, '.whiphand', 'workflows', 'missing.yaml'))
        && e.message.includes(join(configHome, 'workflows', 'missing.yaml')),
    );
  });
});

test('parseInputPairs: parses repeatable key=value pairs', () => {
  const result = parseInputPairs(['feature=widgets', 'owner=alice']);
  assert.deepEqual(result, { feature: 'widgets', owner: 'alice' });
});

test('parseInputPairs: throws on malformed pair', () => {
  assert.throws(() => parseInputPairs(['noequalsign']), /--input expects key=value/);
});

test('listWorkflows: missing dirs on both sides returns empty array', async () => {
  await withConfigHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    const result = await listWorkflows(dir);
    assert.deepEqual(result, []);
  });
});

test('listWorkflows: returns valid workflows, broken file yields error entry (not throw)', async () => {
  await withConfigHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    const workflowsDir = join(dir, '.whiphand', 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, 'good.yaml'), 'name: good\nsteps:\n  - id: a\n    runner: claude\n    mode: headless\n    writes: false\n    output: a.md\n    prompt: p\n');
    await writeFile(join(workflowsDir, 'broken.yaml'), 'name: broken\nsteps: []\n');

    const result = await listWorkflows(dir);
    assert.equal(result.length, 2);

    const good = result.find(r => r.name === 'good');
    assert.ok(good);
    assert.equal(good.path, join(workflowsDir, 'good.yaml'));
    assert.equal(good.source, 'project');
    assert.equal(good.workflow?.name, 'good');
    assert.equal(good.error, undefined);

    const broken = result.find(r => r.name === 'broken');
    assert.ok(broken);
    assert.equal(broken.workflow, undefined);
    assert.ok(typeof broken.error === 'string' && broken.error.length > 0);
  });
});

test('listWorkflows: merges both scopes, sorted by name, project before global on a tie', async () => {
  await withConfigHome(async configHome => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    const projectDir = join(dir, '.whiphand', 'workflows');
    const globalDir = join(configHome, 'workflows');
    await mkdir(projectDir, { recursive: true });
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(projectDir, 'shared.yaml'), 'name: shared\nsteps:\n  - id: a\n    runner: claude\n    mode: headless\n    writes: false\n    output: a.md\n    prompt: p\n');
    await writeFile(join(globalDir, 'shared.yaml'), 'name: shared\nsteps:\n  - id: a\n    runner: claude\n    mode: headless\n    writes: false\n    output: a.md\n    prompt: p\n');
    await writeFile(join(globalDir, 'only-global.yaml'), 'name: only-global\nsteps:\n  - id: a\n    runner: claude\n    mode: headless\n    writes: false\n    output: a.md\n    prompt: p\n');

    const result = await listWorkflows(dir);
    assert.deepEqual(result.map(r => [r.name, r.source, !!r.shadowed]), [
      ['only-global', 'global', false],
      ['shared', 'project', false],
      ['shared', 'global', true],
    ]);
  });
});

test('listWorkflows: an unreadable global directory surfaces one error entry, not a throw', async () => {
  await withConfigHome(async configHome => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    const globalDir = join(configHome, 'workflows');
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, 'blocked.yaml'), 'name: blocked\n');
    await chmod(globalDir, 0o000);
    try {
      // Running as root (some CI/sandbox setups) ignores permission bits
      // entirely; skip the assertion rather than fail on an environment quirk.
      const result = await listWorkflows(dir);
      const globalErrors = result.filter(r => r.source === 'global' && r.error !== undefined);
      if (process.getuid?.() !== 0) {
        assert.equal(globalErrors.length, 1);
      }
    } finally {
      await chmod(globalDir, 0o700);
    }
  });
});

test('resolveWorkflowPath: a scope selector cannot escape its scope directory', async () => {
  await withConfigHome(async configHome => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    await mkdir(join(dir, '.whiphand', 'workflows'), { recursive: true });

    // Plant a readable file just outside each scope root. Resolving to either
    // one would mean the selector's name was joined in unvalidated — the
    // agent's getWorkflow hands this string straight through from the webview.
    await writeFile(join(dir, 'outside.yaml'), 'name: outside\n');
    await writeFile(join(configHome, 'outside.yaml'), 'name: outside\n');

    for (const ref of [
      'global:../outside',
      'project:../../outside',
      'global:../../../etc/passwd',
      'project:sub/nested',
      'global:.',
    ]) {
      await assert.rejects(
        resolveWorkflowPath(ref, dir),
        /invalid workflow name/,
        `expected '${ref}' to be rejected as a name, not resolved`,
      );
    }
  });
});

test('resolveWorkflowPath: a bare ref that is neither a real path nor a valid name is not looked up', async () => {
  await withConfigHome(async configHome => {
    const dir = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    await mkdir(join(dir, '.whiphand', 'workflows'), { recursive: true });
    // A traversal that happens to name a real file under a scope dir must not
    // resolve: only a genuine path (step 2) or a valid name (steps 3-4) may.
    await writeFile(join(configHome, 'workflows-escape.yaml'), 'name: x\n');
    await assert.rejects(
      resolveWorkflowPath('../workflows-escape', dir),
      /not found/,
    );
  });
});

test('resolveWorkflowPath: a real relative path still resolves, traversal and all', async () => {
  await withConfigHome(async () => {
    // Step 2 is deliberately exempt from the name check — `whiphand run
    // examples/cycle.yaml` and friends are paths on purpose, resolved against
    // the caller's own workdir rather than joined into a shared scope root.
    const parent = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
    const dir = join(parent, 'nested');
    await mkdir(dir);
    await writeFile(join(parent, 'sibling.yaml'), 'name: sibling\n');
    const { path, source } = await resolveWorkflowPath('../sibling.yaml', dir);
    assert.equal(path, join(parent, 'sibling.yaml'));
    assert.equal(source, 'project');
  });
});
