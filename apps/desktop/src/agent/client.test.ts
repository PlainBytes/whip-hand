import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentClient } from './client.ts';
import { MockTransport } from './transport.ts';

function respondHello(transport: MockTransport, index = 0): void {
  const req = transport.sentRequest(index);
  expect(req.method).toBe('hello');
  transport.emitLine({ id: req.id, result: { version: '0.1.0', protocolVersion: 1 } });
}

describe('AgentClient', () => {
  let transport: MockTransport;
  let client: AgentClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = new AgentClient(transport);
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  it('sends a hello handshake on connect and reports connected status', async () => {
    const statuses: string[] = [];
    client.onStatusChange(s => statuses.push(s));

    await client.connect();

    expect(client.status).toBe('connected');
    // 'connecting' is the client's initial status (not a change from itself),
    // so only the transition into 'connected' is observed here.
    expect(statuses).toEqual(['connected']);
    respondHello(transport); // clears the pending hello request cleanly
  });

  it('correlates concurrent requests to their responses by incrementing id', async () => {
    await client.connect();
    respondHello(transport);

    const p1 = client.request('doctor', {});
    const p2 = client.request('doctor', {});
    const req1 = transport.sentRequest(1);
    const req2 = transport.sentRequest(2);
    expect(req2.id).toBeGreaterThan(req1.id);

    // Respond out of order — correlation must be by id, not arrival order.
    transport.emitLine({ id: req2.id, result: [{ id: 'claude', installed: true }] });
    transport.emitLine({ id: req1.id, result: [{ id: 'git', installed: false }] });

    await expect(p2).resolves.toEqual([{ id: 'claude', installed: true }]);
    await expect(p1).resolves.toEqual([{ id: 'git', installed: false }]);
  });

  it('rejects a request when the response carries an rpc error', async () => {
    await client.connect();
    respondHello(transport);

    const p = client.request('doctor', {});
    const req = transport.sentRequest(1);
    transport.emitLine({ id: req.id, error: { code: -32000, message: 'adapter probe failed' } });

    await expect(p).rejects.toThrow('adapter probe failed');
  });

  it('rejects a request that times out with no response', async () => {
    vi.useFakeTimers();
    const c = new AgentClient(transport, { requestTimeoutMs: 30_000 });
    await c.connect();
    respondHello(transport);

    const p = c.request('doctor', {});
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    c.dispose();
  });

  it('dispatches notifications to handlers registered for that method', async () => {
    await client.connect();
    respondHello(transport);

    const received: unknown[] = [];
    const unsubscribe = client.onNotification('whiphandEvent', params => received.push(params));

    transport.emitLine({
      method: 'whiphandEvent',
      params: { jobId: 'j1', event: { type: 'run:start', runId: 'r1', workflow: 'demo' }, ts: '2026-01-01T00:00:00Z' },
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ jobId: 'j1' });

    unsubscribe();
    transport.emitLine({
      method: 'whiphandEvent',
      params: { jobId: 'j2', event: { type: 'run:start', runId: 'r2', workflow: 'demo' }, ts: '2026-01-01T00:00:01Z' },
    });
    expect(received).toHaveLength(1); // unsubscribed handler saw nothing further
  });

  it('does not dispatch a notification to a handler for a different method', async () => {
    await client.connect();
    respondHello(transport);

    const stepLog = vi.fn();
    client.onNotification('stepLog', stepLog);
    transport.emitLine({ method: 'runStateChanged', params: { jobId: 'j1', status: 'running' } });

    expect(stepLog).not.toHaveBeenCalled();
  });

  it('rejects all pending requests and flips status when the transport exits', async () => {
    await client.connect();
    respondHello(transport);

    const p1 = client.request('doctor', {});
    const p2 = client.request('listWorkflows', { workdir: '/tmp/ws' });

    transport.emitExit(1);

    await expect(p1).rejects.toThrow(/exited/);
    await expect(p2).rejects.toThrow(/exited/);
    expect(client.status).toBe('reconnecting');
  });

  it('auto-restarts after exit with exponential backoff and resets retry count on success', async () => {
    vi.useFakeTimers();
    const c = new AgentClient(transport, { maxRetries: 5, baseDelayMs: 100 });
    await c.connect();
    respondHello(transport);

    const statuses: string[] = [];
    c.onStatusChange(s => statuses.push(s));

    transport.emitExit(1);
    expect(c.status).toBe('reconnecting');
    expect(transport.startCalls).toBe(1); // no immediate respawn — backoff first

    await vi.advanceTimersByTimeAsync(100);
    expect(transport.startCalls).toBe(2);
    respondHello(transport, transport.sent.length - 1);
    await vi.advanceTimersByTimeAsync(0);

    expect(c.status).toBe('connected');
    expect(statuses).toEqual(['reconnecting', 'connected']);

    c.dispose();
  });

  it('gives up and reports "down" after exceeding max retries', async () => {
    vi.useFakeTimers();
    transport.startImpl = () => Promise.reject(new Error('spawn ENOENT'));
    const c = new AgentClient(transport, { maxRetries: 2, baseDelayMs: 10 });

    // First connect attempt itself fails (startImpl always rejects); connect()
    // never rejects — it hands off to the same supervised retry loop that
    // handles a mid-session exit.
    await c.connect();
    expect(c.status).toBe('reconnecting');

    // retry 1 (still fails)
    await vi.advanceTimersByTimeAsync(10);
    expect(c.status).toBe('reconnecting');
    // retry 2, delay doubled (still fails) — retries now exhausted
    await vi.advanceTimersByTimeAsync(20);
    expect(c.status).toBe('down');

    c.dispose();
  });
});
