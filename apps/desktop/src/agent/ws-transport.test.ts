import { describe, expect, it, vi } from 'vitest';
import { CLOSE_TOKEN_REVOKED, WebSocketTransport } from './ws-transport.ts';

/** Minimal stand-in for the browser's WebSocket, driven by the test. */
class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }

  open(): void { this.readyState = 1; this.onopen?.(); }
  fail(): void { this.onerror?.(); }
  emit(data: unknown): void { this.onmessage?.({ data }); }
  remoteClose(code = 1006): void { this.readyState = 3; this.onclose?.({ code }); }
}

function makeTransport(token: string | null = 'tok') {
  let socket: FakeSocket | undefined;
  const transport = new WebSocketTransport(() => token, {
    url: 'ws://host:61338/ws',
    socketFactory: url => {
      socket = new FakeSocket(url);
      return socket as unknown as WebSocket;
    },
  });
  return { transport, socket: () => socket!, };
}

describe('WebSocketTransport', () => {
  it('carries the token in the query, because a browser cannot set headers', async () => {
    const { transport, socket } = makeTransport('a b/c');
    const started = transport.start();
    socket().open();
    await started;
    expect(socket().url).toBe('ws://host:61338/ws?t=a%20b%2Fc');
  });

  it('omits the parameter entirely when there is no token', async () => {
    const { transport, socket } = makeTransport(null);
    const started = transport.start();
    socket().open();
    await started;
    expect(socket().url).toBe('ws://host:61338/ws');
  });

  it('start() rejects when the handshake fails', async () => {
    const { transport, socket } = makeTransport();
    const started = transport.start();
    socket().fail();
    await expect(started).rejects.toThrow(/could not connect/i);
  });

  it('start() rejects when the socket closes before opening', async () => {
    const { transport, socket } = makeTransport();
    const started = transport.start();
    socket().remoteClose(1006);
    await expect(started).rejects.toThrow(/could not connect/i);
  });

  it('delivers each frame as one line, ignoring blank ones', async () => {
    const { transport, socket } = makeTransport();
    const lines: string[] = [];
    transport.onLine(l => lines.push(l));
    const started = transport.start();
    socket().open();
    await started;

    socket().emit('{"id":1,"result":{}}');
    socket().emit('   ');
    socket().emit('');
    socket().emit('{"method":"ptyData"}');

    expect(lines).toEqual(['{"id":1,"result":{}}', '{"method":"ptyData"}']);
  });

  it('reports a close AFTER opening as an exit, which is what drives reconnect', async () => {
    const { transport, socket } = makeTransport();
    const onExit = vi.fn();
    transport.onExit(onExit);
    const started = transport.start();
    socket().open();
    await started;

    socket().remoteClose(1006);
    expect(onExit).toHaveBeenCalledWith(1006);
  });

  it('passes the token-revoked close code through, so a shell can stop retrying', async () => {
    const { transport, socket } = makeTransport();
    const onExit = vi.fn();
    transport.onExit(onExit);
    const started = transport.start();
    socket().open();
    await started;

    socket().remoteClose(CLOSE_TOKEN_REVOKED);
    expect(onExit).toHaveBeenCalledWith(CLOSE_TOKEN_REVOKED);
  });

  it('drops sends while the socket is not open rather than throwing', async () => {
    const { transport, socket } = makeTransport();
    transport.send('{"id":1}');
    const started = transport.start();
    socket().open();
    await started;

    transport.send('{"id":2}');
    expect(socket().sent).toEqual(['{"id":2}']);
  });

  it('kill() closes the socket', async () => {
    const { transport, socket } = makeTransport();
    const started = transport.start();
    socket().open();
    await started;

    transport.kill();
    expect(socket().closed).toBe(true);
  });
});
