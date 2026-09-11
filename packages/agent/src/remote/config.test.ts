import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_REMOTE_PORT, RemoteAccessStore, defaultRemoteConfig, resolveRemoteConfigPath,
} from './config.ts';

async function tempStore(): Promise<RemoteAccessStore> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-remote-'));
  return new RemoteAccessStore(join(dir, 'remote-access.json'));
}

test('WHIPHAND_REMOTE_CONFIG_FILE overrides the resolved path', () => {
  assert.equal(resolveRemoteConfigPath({ WHIPHAND_REMOTE_CONFIG_FILE: '/tmp/x.json' }), '/tmp/x.json');
});

// `platform` picks the directory convention; the separator is always the
// host's, because this only ever resolves a path for the machine it runs on.
// Expectations join the same way, so what is asserted is the convention.
test('resolves beside app-state, per platform', () => {
  assert.equal(
    resolveRemoteConfigPath({ XDG_DATA_HOME: '/data' }, 'linux', '/home/u'),
    join('/data', 'whiphand', 'remote-access.json'),
  );
  assert.equal(
    resolveRemoteConfigPath({}, 'darwin', '/Users/u'),
    join('/Users/u', 'Library', 'Application Support', 'whiphand', 'remote-access.json'),
  );
  assert.equal(
    resolveRemoteConfigPath({ APPDATA: 'C:\\AppData' }, 'win32', 'C:\\u'),
    join('C:\\AppData', 'whiphand', 'remote-access.json'),
  );
});

test('defaults are off, on the non-Vite port, with a fresh token', () => {
  const a = defaultRemoteConfig();
  assert.equal(a.enabled, false, 'must default to OFF');
  assert.equal(a.port, DEFAULT_REMOTE_PORT);
  assert.notEqual(a.token, defaultRemoteConfig().token, 'each default gets its own token');
});

test('a missing file yields defaults without throwing', async () => {
  const store = await tempStore();
  const config = await store.get();
  assert.equal(config.enabled, false);
  assert.equal(config.port, DEFAULT_REMOTE_PORT);
});

test('mutate persists atomically and 0600, and survives a reload', async () => {
  const store = await tempStore();
  const saved = await store.mutate(c => ({ ...c, enabled: true, port: 62000 }));
  assert.equal(saved.enabled, true);

  // The token is a credential; 0600 is the point of not putting it in
  // app-state. POSIX only: Windows has no permission bits for fs.chmod to set
  // — it only toggles the read-only attribute — so the file lands 0666 there
  // and this guarantee simply does not hold. Restricting it on Windows means
  // an ACL, which is a change to the product, not to this test.
  if (process.platform !== 'win32') {
    const stats = await stat(store.filePath);
    assert.equal(stats.mode & 0o777, 0o600, 'token file must not be world-readable');
  }

  const reloaded = await new RemoteAccessStore(store.filePath).get();
  assert.deepEqual(reloaded, saved);
});

test('an invalid config fails CLOSED rather than leaving a port open', async () => {
  const store = await tempStore();
  await store.mutate(c => ({ ...c, enabled: true }));
  await writeFile(store.filePath, '{"schemaVersion":1,"enabled":true}', 'utf8');

  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const reloaded = await new RemoteAccessStore(store.filePath).get();
    assert.equal(reloaded.enabled, false, 'a corrupt config must not stay enabled');
    assert.equal(errors.length, 1, 'and it must say so loudly');
  } finally {
    console.error = originalError;
  }
});

test('unparseable JSON is treated the same way', async () => {
  const store = await tempStore();
  await store.mutate(c => ({ ...c, enabled: true }));
  await writeFile(store.filePath, 'not json at all', 'utf8');
  const reloaded = await new RemoteAccessStore(store.filePath).get();
  assert.equal(reloaded.enabled, false);
});

test('mutate rejects a config the schema refuses, leaving the file untouched', async () => {
  const store = await tempStore();
  await store.mutate(c => ({ ...c, port: 62000 }));
  await assert.rejects(() => store.mutate(c => ({ ...c, port: 80 })), /port/i);

  const onDisk = JSON.parse(await readFile(store.filePath, 'utf8')) as { port: number };
  assert.equal(onDisk.port, 62000, 'the rejected write must not have landed');
});

test('concurrent mutates do not interleave a stale read-modify-write', async () => {
  const store = await tempStore();
  await Promise.all([
    store.mutate(c => ({ ...c, enabled: true })),
    store.mutate(c => ({ ...c, port: 62001 })),
  ]);
  const final = await store.get();
  assert.equal(final.enabled, true, 'the first write must not be lost');
  assert.equal(final.port, 62001);
});
