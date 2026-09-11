import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createDispatcher } from './rpc.ts';
import { ErrorCode } from './protocol.ts';

function setup() {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const methodSpecs = {
    echo: { params: z.object({ text: z.string() }) },
    boom: { params: z.object({}) },
    ping: { params: z.object({}) },
  };
  const handlers = {
    echo: (params: unknown) => ({ echoed: (params as { text: string }).text }),
    boom: () => { throw new Error('kaboom'); },
    ping: (_params: unknown, ctx: { notify: (m: string, p: unknown) => void }) => {
      ctx.notify('pong', { at: 1 });
      return { ok: true };
    },
  };
  const dispatcher = createDispatcher(methodSpecs, handlers, (method, params) => {
    notifications.push({ method, params });
  });
  return { dispatcher, notifications };
}

test('routes a valid request to its handler and returns the result', async () => {
  const { dispatcher } = setup();
  const line = JSON.stringify({ id: 1, method: 'echo', params: { text: 'hi' } });
  const response = JSON.parse(await dispatcher.handleLine(line));
  assert.deepEqual(response, { id: 1, result: { echoed: 'hi' } });
});

test('unknown method -> -32601', async () => {
  const { dispatcher } = setup();
  const line = JSON.stringify({ id: 2, method: 'nope', params: {} });
  const response = JSON.parse(await dispatcher.handleLine(line));
  assert.equal(response.id, 2);
  assert.equal(response.error.code, ErrorCode.MethodNotFound);
});

test('invalid params -> -32602', async () => {
  const { dispatcher } = setup();
  const line = JSON.stringify({ id: 3, method: 'echo', params: { text: 42 } });
  const response = JSON.parse(await dispatcher.handleLine(line));
  assert.equal(response.id, 3);
  assert.equal(response.error.code, ErrorCode.InvalidParams);
});

test('invalid params message is a compact path: message list, not zod\'s pretty-printed JSON', async () => {
  const { dispatcher } = setup();
  const line = JSON.stringify({ id: 3, method: 'echo', params: { text: 42 } });
  const response = JSON.parse(await dispatcher.handleLine(line));
  assert.match(response.error.message, /^invalid params: text: /);
  assert.ok(!response.error.message.includes('"origin"'), 'must not be zod\'s raw JSON issue dump');
  assert.ok(!response.error.message.trim().endsWith('['), 'must not open a JSON array');
});

test('missing required params -> -32602', async () => {
  const { dispatcher } = setup();
  const line = JSON.stringify({ id: 4, method: 'echo', params: {} });
  const response = JSON.parse(await dispatcher.handleLine(line));
  assert.equal(response.error.code, ErrorCode.InvalidParams);
});

test('handler throw -> -32000 with the thrown message', async () => {
  const { dispatcher } = setup();
  const line = JSON.stringify({ id: 5, method: 'boom', params: {} });
  const response = JSON.parse(await dispatcher.handleLine(line));
  assert.equal(response.id, 5);
  assert.equal(response.error.code, ErrorCode.ServerError);
  assert.match(response.error.message, /kaboom/);
});

test('unparseable line -> best-effort id:null parse error', async () => {
  const { dispatcher } = setup();
  const response = JSON.parse(await dispatcher.handleLine('{not json'));
  assert.equal(response.id, null);
  assert.equal(response.error.code, ErrorCode.ParseError);
});

test('malformed envelope (missing method) -> parse error, id preserved if present', async () => {
  const { dispatcher } = setup();
  const response = JSON.parse(await dispatcher.handleLine(JSON.stringify({ id: 7 })));
  assert.equal(response.id, 7);
  assert.equal(response.error.code, ErrorCode.ParseError);
});

test('handler can emit notifications via ctx.notify before responding', async () => {
  const { dispatcher, notifications } = setup();
  const response = JSON.parse(await dispatcher.handleLine(JSON.stringify({ id: 8, method: 'ping', params: {} })));
  assert.deepEqual(response, { id: 8, result: { ok: true } });
  assert.deepEqual(notifications, [{ method: 'pong', params: { at: 1 } }]);
});
