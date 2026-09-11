import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPtySizes } from './pty-sizes.ts';

test('a single client gets exactly what it asked for', () => {
  const sizes = createPtySizes();
  assert.deepEqual(sizes.report('j1', 'local', { cols: 120, rows: 40 }), { cols: 120, rows: 40 });
});

test('two watchers settle on the smallest size, whichever reports last', () => {
  const sizes = createPtySizes();
  sizes.report('j1', 'desktop', { cols: 120, rows: 40 });
  // A pty sized for the desktop would wrap unreadably in the browser window.
  assert.deepEqual(sizes.report('j1', 'remote-1', { cols: 80, rows: 24 }), { cols: 80, rows: 24 });
  // And the desktop re-fitting must not take it back.
  assert.deepEqual(sizes.report('j1', 'desktop', { cols: 120, rows: 40 }), { cols: 80, rows: 24 });
});

test('the minimum is taken per dimension', () => {
  const sizes = createPtySizes();
  sizes.report('j1', 'a', { cols: 200, rows: 20 });
  assert.deepEqual(sizes.report('j1', 'b', { cols: 80, rows: 60 }), { cols: 80, rows: 20 });
});

test('jobs are independent', () => {
  const sizes = createPtySizes();
  sizes.report('j1', 'a', { cols: 80, rows: 24 });
  assert.deepEqual(sizes.report('j2', 'b', { cols: 200, rows: 50 }), { cols: 200, rows: 50 });
});

test('a disconnected client stops constraining the terminal', () => {
  const sizes = createPtySizes();
  sizes.report('j1', 'desktop', { cols: 120, rows: 40 });
  sizes.report('j1', 'remote-1', { cols: 80, rows: 24 });

  sizes.forget('remote-1');

  // Without this the terminal would stay boxed to a window nobody is looking
  // at, with no way back short of restarting the agent.
  assert.deepEqual(sizes.report('j1', 'desktop', { cols: 120, rows: 40 }), { cols: 120, rows: 40 });
});

test('forgetting a client clears it from every job it was watching', () => {
  const sizes = createPtySizes();
  sizes.report('j1', 'remote-1', { cols: 80, rows: 24 });
  sizes.report('j2', 'remote-1', { cols: 80, rows: 24 });
  sizes.report('j1', 'desktop', { cols: 200, rows: 50 });
  sizes.report('j2', 'desktop', { cols: 200, rows: 50 });

  sizes.forget('remote-1');

  assert.deepEqual(sizes.report('j1', 'desktop', { cols: 200, rows: 50 }), { cols: 200, rows: 50 });
  assert.deepEqual(sizes.report('j2', 'desktop', { cols: 200, rows: 50 }), { cols: 200, rows: 50 });
});

test('forgetting an unknown client is harmless', () => {
  const sizes = createPtySizes();
  sizes.report('j1', 'a', { cols: 80, rows: 24 });
  sizes.forget('never-connected');
  assert.deepEqual(sizes.report('j1', 'a', { cols: 80, rows: 24 }), { cols: 80, rows: 24 });
});

test('forgetJob drops a finished job entirely', () => {
  const sizes = createPtySizes();
  sizes.report('j1', 'a', { cols: 80, rows: 24 });
  sizes.forgetJob('j1');
  assert.deepEqual(sizes.report('j1', 'b', { cols: 200, rows: 50 }), { cols: 200, rows: 50 });
});
