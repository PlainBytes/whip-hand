import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { createDispatcher } from '../rpc.ts';
import { createNotifyHub } from '../notify-hub.ts';
import { CLOSE_TOKEN_REVOKED, createRemoteServer, lanAddresses, remoteUrl } from './server.ts';
import { REMOTE_METHODS, pickRemoteHandlers } from './methods.ts';

const TOKEN = 'a'.repeat(43);

interface Harness {
  port: number;
  server: ReturnType<typeof createRemoteServer>;
  hub: ReturnType<typeof createNotifyHub>;
  seenClientIds: string[];
  goneClientIds: string[];
  close: () => Promise<void>;
}

async function harness(webRoot: string | null = null): Promise<Harness> {
  const hub = createNotifyHub();
  const handlers = pickRemoteHandlers({
    hello: async () => ({ version: 'test', protocolVersion: 1 }),
    doctor: async () => [{ id: 'fake' }],
    remoteAccessSet: async () => assert.fail('a desktop-only handler must be unreachable'),
  });
  const seenClientIds: string[] = [];
  const goneClientIds: string[] = [];
  const server = createRemoteServer({
    makeDispatcher: clientId => {
      seenClientIds.push(clientId);
      return createDispatcher(REMOTE_METHODS, handlers, hub.notify, clientId);
    },
    webRoot: () => webRoot,
    onClientGone: clientId => goneClientIds.push(clientId),
  });
  hub.addSink(server.broadcast);
  await server.start(0, TOKEN);
  return {
    port: server.status().port,
    server,
    hub,
    seenClientIds,
    goneClientIds,
    close: () => server.stop(),
  };
}

function connect(port: number, token: string, options: Record<string, unknown> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Matches ws-transport.ts's real client: PROTOCOL_NAME alongside the
    // token-bearing entry, so the server has a non-secret value to echo back.
    const protocols = token ? ['whiphand', `whiphand.token.${token}`] : [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, options);
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

/** Sends one request and resolves with the matching response. */
function call(ws: WebSocket, id: number, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const onMessage = (raw: Buffer): void => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg.id === id) {
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false },
      res => {
        let body = '';
        res.on('data', c => { body += String(c); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('a valid token opens the channel and dispatches a request', async () => {
  const h = await harness();
  try {
    const ws = await connect(h.port, TOKEN);
    const response = await call(ws, 1, 'hello');
    assert.deepEqual(response, { id: 1, result: { version: 'test', protocolVersion: 1 } });
    ws.close();
  } finally {
    await h.close();
  }
});

test('the token travels as a Sec-WebSocket-Protocol offer, never in the URL', async () => {
  const h = await harness();
  try {
    const ws = await connect(h.port, TOKEN);
    assert.equal(ws.url, `ws://127.0.0.1:${h.port}/ws`);
    ws.close();
  } finally {
    await h.close();
  }
});

test('the handshake response echoes the fixed protocol name, never the token', async () => {
  const h = await harness();
  try {
    const ws = await connect(h.port, TOKEN);
    assert.equal(ws.protocol, 'whiphand');
    ws.close();
  } finally {
    await h.close();
  }
});

test('a bad token is refused at the upgrade, as a real 401', async () => {
  const h = await harness();
  try {
    await assert.rejects(() => connect(h.port, 'wrong'), /HTTP 401/);
    await assert.rejects(() => connect(h.port, ''), /HTTP 401/);
  } finally {
    await h.close();
  }
});

test('a foreign Origin is refused even with the right token (WS bypasses CORS)', async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () => connect(h.port, TOKEN, { origin: 'http://evil.example' }),
      /HTTP 403/,
    );
    // The origin we actually serve is fine.
    const ws = await connect(h.port, TOKEN, { origin: `http://127.0.0.1:${h.port}` });
    ws.close();
  } finally {
    await h.close();
  }
});

test('a rebound Host is refused before the handshake', async () => {
  const h = await harness();
  try {
    const res = await rawGet(h.port, '/api/ping', {
      host: `evil.example:${h.port}`,
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /evil\.example/);
  } finally {
    await h.close();
  }
});

test('desktop-only methods are not dispatchable remotely', async () => {
  const h = await harness();
  try {
    const ws = await connect(h.port, TOKEN);
    const response = await call(ws, 7, 'remoteAccessSet', { enabled: false });
    assert.equal((response.error as { code: number }).code, -32601, 'MethodNotFound');
    ws.close();
  } finally {
    await h.close();
  }
});

test('two connections may both use request id 1 without interfering', async () => {
  const h = await harness();
  try {
    const [a, b] = await Promise.all([connect(h.port, TOKEN), connect(h.port, TOKEN)]);
    // Same id, different methods, sent concurrently. Responses are routed on
    // the socket the request arrived on, so the correlation cannot cross over.
    const [ra, rb] = await Promise.all([call(a, 1, 'hello'), call(b, 1, 'doctor')]);
    assert.deepEqual(ra.result, { version: 'test', protocolVersion: 1 });
    assert.deepEqual(rb.result, [{ id: 'fake' }]);
    a.close();
    b.close();
  } finally {
    await h.close();
  }
});

test('notifications fan out to every connected client', async () => {
  const h = await harness();
  try {
    const [a, b] = await Promise.all([connect(h.port, TOKEN), connect(h.port, TOKEN)]);
    const received = (ws: WebSocket): Promise<unknown> => new Promise(resolve => {
      ws.once('message', raw => resolve(JSON.parse(raw.toString())));
    });
    const both = Promise.all([received(a), received(b)]);
    h.hub.notify('ptyData', { jobId: 'j1', data: 'AA' });
    const [ma, mb] = await both;
    assert.deepEqual(ma, { method: 'ptyData', params: { jobId: 'j1', data: 'AA' } });
    assert.deepEqual(mb, ma);
    a.close();
    b.close();
  } finally {
    await h.close();
  }
});

test('/api/ping gates on the token so the client can validate before mounting', async () => {
  const h = await harness();
  try {
    const host = `127.0.0.1:${h.port}`;
    assert.equal((await rawGet(h.port, '/api/ping', { host })).status, 401);
    assert.equal((await rawGet(h.port, '/api/ping', { host, authorization: 'Bearer nope' })).status, 401);
    const ok = await rawGet(h.port, '/api/ping', { host, authorization: `Bearer ${TOKEN}` });
    assert.equal(ok.status, 200);
    // No WWW-Authenticate, or the browser opens its own basic-auth dialog.
    const unauthorized = await rawGet(h.port, '/api/ping', { host });
    assert.equal(unauthorized.status, 401);
  } finally {
    await h.close();
  }
});

test('an unbuilt web root answers 503 with something actionable', async () => {
  const h = await harness(null);
  try {
    const res = await rawGet(h.port, '/', { host: `127.0.0.1:${h.port}` });
    assert.equal(res.status, 503);
    assert.match(res.body, /build:web/);
  } finally {
    await h.close();
  }
});

test('dropClients closes every socket with the revoked code', async () => {
  const h = await harness();
  try {
    const ws = await connect(h.port, TOKEN);
    const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)));
    h.server.dropClients('token rotated');
    assert.equal(await closed, CLOSE_TOKEN_REVOKED);
    assert.equal(h.server.status().clientCount, 0);
  } finally {
    await h.close();
  }
});

test('status tracks listening and client count', async () => {
  const h = await harness();
  try {
    assert.equal(h.server.status().listening, true);
    assert.equal(h.server.status().error, null);
    const ws = await connect(h.port, TOKEN);
    await call(ws, 1, 'hello');
    assert.equal(h.server.status().clientCount, 1);
    ws.close();
  } finally {
    await h.close();
    assert.equal(h.server.status().listening, false);
  }
});

test('a port already in use is reported, never thrown past the caller', async () => {
  const h = await harness();
  try {
    const second = createRemoteServer({
      makeDispatcher: () => createDispatcher({}, {}, () => {}),
      webRoot: () => null,
    });
    await assert.rejects(() => second.start(h.port, TOKEN), /already in use/);
    assert.match(second.status().error ?? '', /already in use/);
    assert.equal(second.status().listening, false);
  } finally {
    await h.close();
  }
});

test('lanAddresses never returns an empty list', () => {
  const addresses = lanAddresses();
  assert.ok(addresses.length > 0);
  assert.ok(!addresses.includes('localhost'), 'a browser on another machine cannot use localhost');
});

test('remoteUrl puts the token in the fragment, never the path or query', () => {
  const url = remoteUrl('192.168.1.20', 61338, 'tok');
  assert.equal(url, 'http://192.168.1.20:61338/#t=tok');
  // A fragment is never transmitted, so the token stays out of access logs.
  assert.equal(new URL(url).search, '');
  assert.equal(new URL(url).hash, '#t=tok');
});

test('each connection gets its own client id, released when it closes', async () => {
  const h = await harness();
  try {
    const a = await connect(h.port, TOKEN);
    const b = await connect(h.port, TOKEN);
    await Promise.all([call(a, 1, 'hello'), call(b, 1, 'hello')]);

    // Distinct ids are what let ptyResize tell two watchers apart.
    assert.equal(h.seenClientIds.length, 2);
    assert.notEqual(h.seenClientIds[0], h.seenClientIds[1]);

    const closed = new Promise(resolve => a.once('close', resolve));
    a.close();
    await closed;
    // Without this, a closed browser would keep constraining the terminal
    // size forever.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(h.goneClientIds, [h.seenClientIds[0]]);

    b.close();
  } finally {
    await h.close();
  }
});
