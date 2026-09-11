import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, methods } from '../protocol.ts';
import { createDispatcher } from '../rpc.ts';
import { DESKTOP_ONLY_METHODS, REMOTE_METHODS, REMOTE_METHOD_NAMES, pickRemoteHandlers } from './methods.ts';

/**
 * THE point of this file. If you added a method to protocol.ts and landed here,
 * that is working as intended: decide whether a browser on the LAN should be
 * able to call it, then add it to DESKTOP_ONLY_METHODS or leave it reachable.
 */
test('the partition covers every method exactly once', () => {
  const all = new Set(Object.keys(methods));
  const remote = new Set<string>(REMOTE_METHOD_NAMES);
  const desktop = new Set<string>(DESKTOP_ONLY_METHODS);

  for (const name of desktop) {
    assert.ok(all.has(name), `DESKTOP_ONLY_METHODS names '${name}', which is not a method`);
    assert.ok(!remote.has(name), `'${name}' is in both halves of the partition`);
  }
  assert.deepEqual(
    new Set([...remote, ...desktop]),
    all,
    'every method must be classified as remote-reachable or desktop-only',
  );
});

test('the remote spec map excludes exactly the desktop-only methods', () => {
  for (const name of DESKTOP_ONLY_METHODS) {
    assert.equal(REMOTE_METHODS[name], undefined, `'${name}' must not be dispatchable remotely`);
  }
  assert.equal(REMOTE_METHODS.listRuns, methods.listRuns);
  // Artifact RPCs stay reachable: RunDetailPage's ArtifactFileSystem is pure
  // RPC, and the Files page is excluded by nav, not by this list.
  assert.ok(REMOTE_METHODS.readArtifact, 'readArtifact must stay reachable');
  assert.ok(REMOTE_METHODS.writeArtifact, 'writeArtifact must stay reachable');
});

test('the remote channel can still drive and answer runs', () => {
  for (const name of ['startRun', 'cancelRun', 'resumeRun', 'resolveManual', 'ptyInput', 'ptyResize']) {
    assert.ok(REMOTE_METHODS[name], `'${name}' must be reachable for remote control`);
  }
});

test('pickRemoteHandlers drops the desktop-only handlers and keeps the rest', () => {
  const all = Object.fromEntries(
    Object.keys(methods).map(name => [name, async () => name]),
  );
  const picked = pickRemoteHandlers(all);

  for (const name of DESKTOP_ONLY_METHODS) {
    assert.equal(picked[name], undefined);
  }
  assert.equal(Object.keys(picked).length, REMOTE_METHOD_NAMES.length);
});

test('a handler map missing an allowed method simply omits it (not-found, never a crash)', () => {
  const picked = pickRemoteHandlers({});
  assert.deepEqual(picked, {});
});

test('statArtifact is reachable remotely, like the artifact reads it serves', () => {
  assert.ok(REMOTE_METHODS.statArtifact, 'statArtifact must stay reachable');
});

test('the remote dispatcher refuses a path attachment on startRun, and accepts bytes', async () => {
  const calls: unknown[] = [];
  const handlers = pickRemoteHandlers({ startRun: async params => { calls.push(params); return { jobId: 'j' }; } });
  const dispatcher = createDispatcher(REMOTE_METHODS, handlers, () => {});

  const byPath = JSON.parse(await dispatcher.handleLine(JSON.stringify({
    id: 1, method: 'startRun', params: { workdir: '/w', workflow: 'r', attachments: [{ path: '/etc/passwd' }] },
  })));
  assert.equal(byPath.error?.code, ErrorCode.InvalidParams);
  assert.equal(calls.length, 0, 'the handler never ran');

  const byBytes = JSON.parse(await dispatcher.handleLine(JSON.stringify({
    id: 2, method: 'startRun', params: { workdir: '/w', workflow: 'r', attachments: [{ name: 'a.png', base64: 'AA==' }] },
  })));
  assert.deepEqual(byBytes.result, { jobId: 'j' });

  // The desktop's own dispatcher is unaffected.
  assert.ok(methods.startRun.params.safeParse({ workdir: '/w', workflow: 'r', attachments: [{ path: '/a' }] }).success);
});
