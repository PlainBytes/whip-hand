import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppStateStore, EMPTY_APP_STATE, MAX_RECENT_WORKSPACES,
  rememberRun, resolveAppStatePath, touchRecent, type AppState, type RecentWorkspace,
} from './app-state.ts';

test('resolveAppStatePath honors WHIPHAND_APP_STATE_FILE override', () => {
  assert.equal(
    resolveAppStatePath({ WHIPHAND_APP_STATE_FILE: '/x/state.json' }, 'linux', '/home/u'),
    '/x/state.json',
  );
});

test('resolveAppStatePath uses XDG_DATA_HOME on linux, ~/.local/share fallback', () => {
  assert.equal(
    resolveAppStatePath({ XDG_DATA_HOME: '/xdg' }, 'linux', '/home/u'),
    join('/xdg', 'whiphand', 'app-state.json'),
  );
  assert.equal(
    resolveAppStatePath({}, 'linux', '/home/u'),
    join('/home/u', '.local', 'share', 'whiphand', 'app-state.json'),
  );
});

test('resolveAppStatePath picks platform dirs on darwin and win32', () => {
  assert.equal(
    resolveAppStatePath({}, 'darwin', '/Users/u'),
    join('/Users/u', 'Library', 'Application Support', 'whiphand', 'app-state.json'),
  );
  assert.equal(
    resolveAppStatePath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'),
    join('C:\\Users\\u\\AppData\\Roaming', 'whiphand', 'app-state.json'),
  );
});

test('touchRecent prepends, dedupes by path, and caps the list', () => {
  const t1 = touchRecent([], '/a', '2026-01-01T00:00:00Z');
  assert.deepEqual(t1, [{ path: '/a', lastOpenedAt: '2026-01-01T00:00:00Z' }]);

  const t2 = touchRecent(t1, '/b', '2026-01-02T00:00:00Z');
  const t3 = touchRecent(t2, '/a', '2026-01-03T00:00:00Z');
  assert.deepEqual(t3.map(r => r.path), ['/a', '/b']);
  assert.equal(t3[0].lastOpenedAt, '2026-01-03T00:00:00Z');

  let list = t3;
  for (let i = 0; i < MAX_RECENT_WORKSPACES + 3; i++) {
    list = touchRecent(list, `/ws-${i}`, '2026-01-04T00:00:00Z');
  }
  assert.equal(list.length, MAX_RECENT_WORKSPACES);
});

test('touchRecent preserves an existing entry pinned flag when it is re-opened', () => {
  const list = [
    { path: '/a', lastOpenedAt: '2026-01-01T00:00:00Z', pinned: true },
    { path: '/b', lastOpenedAt: '2026-01-02T00:00:00Z' },
  ];
  const next = touchRecent(list, '/a', '2026-01-03T00:00:00Z');
  assert.deepEqual(next[0], { path: '/a', lastOpenedAt: '2026-01-03T00:00:00Z', pinned: true });
});

test('touchRecent caps unpinned entries only, never dropping a pinned workspace', () => {
  let list: RecentWorkspace[] = [
    { path: '/pin-1', lastOpenedAt: '2026-01-01T00:00:00Z', pinned: true },
    { path: '/pin-2', lastOpenedAt: '2026-01-01T00:00:00Z', pinned: true },
    { path: '/pin-3', lastOpenedAt: '2026-01-01T00:00:00Z', pinned: true },
  ];
  for (let i = 0; i < MAX_RECENT_WORKSPACES + 2; i++) {
    list = touchRecent(list, `/ws-${i}`, '2026-01-02T00:00:00Z');
  }
  assert.equal(list.filter(r => r.pinned).length, 3);
  assert.equal(list.filter(r => !r.pinned).length, MAX_RECENT_WORKSPACES);
});

test('an app-state file written before pinning existed still parses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-app-state-'));
  const file = join(dir, 'app-state.json');
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    recentWorkspaces: [{ path: '/a', lastOpenedAt: '2026-01-01T00:00:00Z' }],
    window: null, lastPage: 'runs', theme: 'dark', workspaces: {},
  }), 'utf8');
  const state = await new AppStateStore(file).get();
  assert.deepEqual(state.recentWorkspaces, [{ path: '/a', lastOpenedAt: '2026-01-01T00:00:00Z' }]);
  assert.equal(state.theme, 'dark');
  // Written before runsRetention existed too: it must default to "keep
  // everything" rather than the whole file being discarded as EMPTY_APP_STATE.
  assert.deepEqual(state.runsRetention, { maxPerWorkspace: 0 });
  // Same story for showOngoingRuns: a file written before it existed still
  // parses, defaulting to "show it" rather than being discarded wholesale.
  assert.equal(state.showOngoingRuns, true);
});

test('rememberRun records lastWorkflow and per-workflow inputs without clobbering other workflows', () => {
  let s = rememberRun(EMPTY_APP_STATE, '/ws', 'feature', { ticket: 'T-1' });
  s = rememberRun(s, '/ws', 'review', { pr: '42' });
  assert.equal(s.workspaces['/ws'].lastWorkflow, 'review');
  assert.deepEqual(s.workspaces['/ws'].lastInputs, {
    feature: { ticket: 'T-1' },
    review: { pr: '42' },
  });
  // input is not mutated
  assert.deepEqual(EMPTY_APP_STATE.workspaces, {});
});

test('AppStateStore round-trips through disk and creates parent dirs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-app-state-'));
  const store = new AppStateStore(join(dir, 'nested', 'app-state.json'));
  assert.deepEqual(await store.get(), EMPTY_APP_STATE);

  await store.mutate(s => ({ ...s, lastPage: 'workflows' }));
  const reread = new AppStateStore(store.filePath);
  assert.equal((await reread.get()).lastPage, 'workflows');
  // file is real JSON on disk
  const raw = JSON.parse(await readFile(store.filePath, 'utf8')) as { schemaVersion: number };
  assert.equal(raw.schemaVersion, 1);
});

test('AppStateStore treats a corrupt file as empty instead of throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-app-state-'));
  const file = join(dir, 'app-state.json');
  await writeFile(file, 'not json{{{', 'utf8');
  const store = new AppStateStore(file);
  assert.deepEqual(await store.get(), EMPTY_APP_STATE);
});

test('AppStateStore serializes concurrent mutations (no lost updates)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-app-state-'));
  const store = new AppStateStore(join(dir, 'app-state.json'));
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.mutate(s => ({ ...s, recentWorkspaces: touchRecent(s.recentWorkspaces, `/ws-${i}`, 'now') })),
    ),
  );
  const final = await store.get();
  assert.equal(final.recentWorkspaces.length, Math.min(20, MAX_RECENT_WORKSPACES));
});

test('mutate reports every write, so a second client cannot go stale', async () => {
  const store = new AppStateStore(
    join(await mkdtemp(join(tmpdir(), 'whiphand-appstate-')), 'app-state.json'),
    state => seen.push(state),
  );
  const seen: AppState[] = [];

  await store.mutate(s => ({ ...s, theme: 'dark' }));
  await store.mutate(s => ({ ...s, lastPage: 'runs' }));

  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.theme, 'dark');
  assert.equal(seen[1]?.lastPage, 'runs');
  // Reported AFTER the write lands: a listener must never see state that
  // failed to persist.
  assert.deepEqual(seen[1], await store.get());
});

test('a throwing listener cannot break the mutation it is reporting', async () => {
  const store = new AppStateStore(
    join(await mkdtemp(join(tmpdir(), 'whiphand-appstate-')), 'app-state.json'),
    () => { throw new Error('a client went away mid-notify'); },
  );
  const originalError = console.error;
  console.error = () => {};
  try {
    const next = await store.mutate(s => ({ ...s, theme: 'light' }));
    assert.equal(next.theme, 'light');
    assert.equal((await store.get()).theme, 'light');
  } finally {
    console.error = originalError;
  }
});
