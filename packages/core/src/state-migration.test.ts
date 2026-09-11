import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrateLegacyStateDirs } from './state-migration.ts';

/** A home with `<root>/mission-control/<file>` already in it. */
async function homeWith(root: string[], file: string, body: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'whiphand-state-migration-'));
  const dir = join(home, ...root, 'mission-control');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), body, 'utf8');
  return home;
}

async function isDir(path: string): Promise<boolean> {
  return stat(path).then(s => s.isDirectory(), () => false);
}

test('moves the old linux config directory, contents intact', async () => {
  const home = await homeWith(['.config'], 'config.yaml', 'runs:\n  max_retained: 7\n');
  await migrateLegacyStateDirs({}, 'linux', home);

  const moved = join(home, '.config', 'whiphand', 'config.yaml');
  assert.equal(await readFile(moved, 'utf8'), 'runs:\n  max_retained: 7\n');
  assert.equal(await isDir(join(home, '.config', 'mission-control')), false);
});

test('moves config and data separately on linux, since they are different roots', async () => {
  const home = await homeWith(['.config'], 'config.yaml', 'cfg');
  const data = join(home, '.local', 'share', 'mission-control');
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'remote-access.json'), '{"token":"keep-me"}', 'utf8');

  await migrateLegacyStateDirs({}, 'linux', home);

  assert.equal(await readFile(join(home, '.config', 'whiphand', 'config.yaml'), 'utf8'), 'cfg');
  const token = join(home, '.local', 'share', 'whiphand', 'remote-access.json');
  assert.equal(await readFile(token, 'utf8'), '{"token":"keep-me"}');
});

test('darwin keeps one shared root, so a single move carries both files', async () => {
  const root = ['Library', 'Application Support'];
  const home = await homeWith(root, 'config.yaml', 'cfg');
  await writeFile(join(home, ...root, 'mission-control', 'app-state.json'), '{}', 'utf8');

  await migrateLegacyStateDirs({}, 'darwin', home);

  assert.equal(await readFile(join(home, ...root, 'whiphand', 'config.yaml'), 'utf8'), 'cfg');
  assert.equal(await readFile(join(home, ...root, 'whiphand', 'app-state.json'), 'utf8'), '{}');
});

test('is a no-op when there is nothing to move', async () => {
  const home = await mkdtemp(join(tmpdir(), 'whiphand-state-migration-empty-'));
  await migrateLegacyStateDirs({}, 'linux', home);
  assert.equal(await isDir(join(home, '.config', 'whiphand')), false);
});

test('leaves both alone when the new directory already exists — never merges', async () => {
  const home = await homeWith(['.config'], 'config.yaml', 'old');
  const current = join(home, '.config', 'whiphand');
  await mkdir(current, { recursive: true });
  await writeFile(join(current, 'config.yaml'), 'new', 'utf8');

  await migrateLegacyStateDirs({}, 'linux', home);

  assert.equal(await readFile(join(current, 'config.yaml'), 'utf8'), 'new');
  assert.equal(await readFile(join(home, '.config', 'mission-control', 'config.yaml'), 'utf8'), 'old');
});

test('running twice is the same as running once', async () => {
  const home = await homeWith(['.config'], 'config.yaml', 'cfg');
  await migrateLegacyStateDirs({}, 'linux', home);
  await migrateLegacyStateDirs({}, 'linux', home);
  assert.equal(await readFile(join(home, '.config', 'whiphand', 'config.yaml'), 'utf8'), 'cfg');
});

test('an explicit state override means the default locations are not ours to touch', async () => {
  for (const name of ['WHIPHAND_CONFIG_HOME', 'WHIPHAND_APP_STATE_FILE', 'WHIPHAND_REMOTE_CONFIG_FILE']) {
    const home = await homeWith(['.config'], 'config.yaml', 'cfg');
    await migrateLegacyStateDirs({ [name]: '/somewhere/else' }, 'linux', home);
    assert.equal(
      await isDir(join(home, '.config', 'mission-control')),
      true,
      `${name} should have suppressed the move`,
    );
    assert.equal(await isDir(join(home, '.config', 'whiphand')), false);
  }
});

test('a rename that cannot happen is swallowed, not thrown', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const home = await homeWith(['.config'], 'config.yaml', 'cfg');
  const parent = join(home, '.config');
  await chmod(parent, 0o500); // read+execute: the rename cannot create an entry here
  try {
    await migrateLegacyStateDirs({}, 'linux', home);
  } finally {
    await chmod(parent, 0o700);
  }
  // Startup survived, and the old directory is still there to be recovered.
  assert.equal(await isDir(join(home, '.config', 'mission-control')), true);
});

test('moves the intermediate whip-hand name too', async () => {
  const home = await mkdtemp(join(tmpdir(), 'whiphand-state-migration-mid-'));
  const dir = join(home, '.config', 'whip-hand');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.yaml'), 'cfg', 'utf8');

  await migrateLegacyStateDirs({}, 'linux', home);

  assert.equal(await readFile(join(home, '.config', 'whiphand', 'config.yaml'), 'utf8'), 'cfg');
  assert.equal(await isDir(join(home, '.config', 'whip-hand')), false);
});

test('a machine carrying both legacy names ends up on the newer one', async () => {
  // The rename landed in two steps, so both can be sitting there. Oldest is
  // tried first and wins the empty destination; the newer one is then left
  // alone rather than merged, for a human to reconcile.
  const home = await homeWith(['.config'], 'config.yaml', 'from-mission-control');
  const mid = join(home, '.config', 'whip-hand');
  await mkdir(mid, { recursive: true });
  await writeFile(join(mid, 'config.yaml'), 'from-whip-hand', 'utf8');

  await migrateLegacyStateDirs({}, 'linux', home);

  assert.equal(
    await readFile(join(home, '.config', 'whiphand', 'config.yaml'), 'utf8'),
    'from-mission-control',
  );
  assert.equal(await readFile(join(mid, 'config.yaml'), 'utf8'), 'from-whip-hand');
});
