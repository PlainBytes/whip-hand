import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifyHub } from './notify-hub.ts';

test('delivers every notification to every sink, in registration order', () => {
  const hub = createNotifyHub();
  const seen: string[] = [];
  hub.addSink((m) => void seen.push(`a:${m}`));
  hub.addSink((m) => void seen.push(`b:${m}`));

  hub.notify('ptyData', { jobId: 'j1' });

  assert.deepEqual(seen, ['a:ptyData', 'b:ptyData']);
});

test('unsubscribe stops delivery to that sink only', () => {
  const hub = createNotifyHub();
  const kept: string[] = [];
  const off = hub.addSink(() => assert.fail('removed sink was still called'));
  hub.addSink((m) => void kept.push(m));
  off();

  hub.notify('whiphandEvent', {});

  assert.deepEqual(kept, ['whiphandEvent']);
});

test('the tap rewrites params for every sink, so buffer index and wire seq cannot diverge', () => {
  let n = 0;
  const hub = createNotifyHub((method, params) =>
    method === 'ptyData' ? { ...(params as object), seq: n++ } : params);
  const a: unknown[] = [];
  const b: unknown[] = [];
  hub.addSink((_m, p) => void a.push(p));
  hub.addSink((_m, p) => void b.push(p));

  hub.notify('ptyData', { jobId: 'j1', data: 'AA' });
  hub.notify('ptyData', { jobId: 'j1', data: 'BB' });

  assert.deepEqual(a, [{ jobId: 'j1', data: 'AA', seq: 0 }, { jobId: 'j1', data: 'BB', seq: 1 }]);
  // Both sinks must see the SAME stamped value; a per-sink tap would renumber.
  assert.deepEqual(b, a);
});

test('a tap returning undefined leaves params untouched', () => {
  const hub = createNotifyHub(() => undefined);
  const seen: unknown[] = [];
  hub.addSink((_m, p) => void seen.push(p));

  hub.notify('stepLog', { line: 'x' });

  assert.deepEqual(seen, [{ line: 'x' }]);
});

test('a throwing sink cannot cut off the others', () => {
  const hub = createNotifyHub();
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    hub.addSink(() => { throw new Error('socket is gone'); });
    const survived: string[] = [];
    hub.addSink((m) => void survived.push(m));

    hub.notify('runStateChanged', {});

    // The desktop's own feed must not depend on a remote client's health.
    assert.deepEqual(survived, ['runStateChanged']);
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalError;
  }
});
