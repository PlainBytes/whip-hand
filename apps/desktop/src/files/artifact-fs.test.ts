import { describe, expect, it, vi } from 'vitest';
import { ArtifactFileSystem } from './artifact-fs.ts';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';

const ARTIFACTS = [{ name: 'review.md', path: '/ws/.whiphand/runs/run-1/review.md' }];

function setup() {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  const fs = new ArtifactFileSystem(client, '/ws', 'run-1', ARTIFACTS);
  return { transport, fs };
}

interface FakeStatResult {
  size: number;
  mtimeMs: number;
}

type FakeClient = AgentClient & {
  request: ReturnType<typeof vi.fn>;
  setResponse(next: FakeStatResult): void;
};

/**
 * A minimal AgentClient stand-in for the watchFile() tests below: it skips
 * the MockTransport request/response dance (awkward to interleave with fake
 * timers) and just resolves every statArtifact-shaped request() with a
 * swappable canned result. `request` is a vi.fn so tests can assert on
 * whether, and with what, it was called.
 */
function fakeClient(initial: FakeStatResult): FakeClient {
  let response = initial;
  const request = vi.fn(async () => response);
  return Object.assign(
    { request },
    { setResponse(next: FakeStatResult) { response = next; } },
  ) as unknown as FakeClient;
}

/** Lets the client's queued send reach the transport before we inspect it. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** Answers the Nth request sent so far with `result`, asserting its method. */
function answer(transport: MockTransport, index: number, method: string, result: unknown) {
  const req = transport.sentRequest(index);
  expect(req.method).toBe(method);
  transport.emitLine({ id: req.id, result });
  return req;
}

describe('ArtifactFileSystem', () => {
  it('reads a file by mapping its path back to the artifact name, asking for base64', async () => {
    const { transport, fs } = setup();
    const pending = fs.readFile('/ws/.whiphand/runs/run-1/review.md');
    await flush();

    const req = answer(transport, 0, 'readArtifact', { content: btoa('# hi'), size: 4, mtimeMs: 10 });
    expect(req.params).toEqual({ workdir: '/ws', runId: 'run-1', name: 'review.md', encoding: 'base64' });
    expect(new TextDecoder().decode(await pending)).toBe('# hi');
  });

  it('returns a binary artifact byte for byte', async () => {
    // A PNG's signature is the classic casualty of a text round trip: 0x89
    // is not valid UTF-8 on its own, and \r\n and \x1a are exactly the bytes
    // a line-ending or EOF conversion would rewrite.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
    const transport = new MockTransport();
    const fs = new ArtifactFileSystem(new AgentClient(transport), '/ws', 'run-1', [
      { name: 'attachments/bug.png', path: '/ws/.whiphand/runs/run-1/attachments/bug.png' },
    ]);
    const pending = fs.readFile('/ws/.whiphand/runs/run-1/attachments/bug.png');
    await flush();

    answer(transport, 0, 'readArtifact', {
      content: btoa(String.fromCharCode(...png)), size: png.length, mtimeMs: 10,
    });
    expect(await pending).toEqual(png);
  });

  it('stats through statArtifact, without reading the content', async () => {
    const { transport, fs } = setup();
    const pending = fs.stat('/ws/.whiphand/runs/run-1/review.md');
    await flush();

    const req = answer(transport, 0, 'statArtifact', { size: 4, mtimeMs: 10 });
    expect(req.params).toEqual({ workdir: '/ws', runId: 'run-1', name: 'review.md' });
    expect(await pending).toEqual({ size: 4, mtimeMs: 10, isDirectory: false });
  });

  it('passes the mtime the caller last stat-ed as the write guard', async () => {
    const { transport, fs } = setup();
    const statting = fs.stat('/ws/.whiphand/runs/run-1/review.md');
    await flush();
    answer(transport, 0, 'statArtifact', { size: 4, mtimeMs: 10 });
    await statting;

    const writing = fs.writeTextFile('/ws/.whiphand/runs/run-1/review.md', 'edited');
    await flush();
    const req = answer(transport, 1, 'writeArtifact', { mtimeMs: 20 });
    expect(req.params).toEqual({
      workdir: '/ws', runId: 'run-1', name: 'review.md', content: 'edited', expectedMtimeMs: 10,
    });
    await writing;
  });

  it('refuses a path that is not an artifact of this run', async () => {
    const { fs } = setup();
    await expect(fs.readFile('/etc/passwd')).rejects.toThrow(/not an artifact/);
  });

  it('rejects the directory and mutation methods it cannot honour', async () => {
    const { fs } = setup();
    await expect(fs.readDir('/ws/.whiphand/runs/run-1')).rejects.toThrow(/not supported/);
    await expect(fs.mkdir('/ws/.whiphand/runs/run-1/x')).rejects.toThrow(/not supported/);
    await expect(fs.rename('a', 'b')).rejects.toThrow(/not supported/);
    await expect(fs.remove('a')).rejects.toThrow(/not supported/);
    await expect(fs.watch('/ws', () => {})).rejects.toThrow(/not supported/);
  });

  it('answers exists() from the manifest listing without an RPC', async () => {
    const { transport, fs } = setup();
    expect(await fs.exists('/ws/.whiphand/runs/run-1/review.md')).toBe(true);
    expect(await fs.exists('/ws/.whiphand/runs/run-1/nope.md')).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  it('polls for changes to one artifact and reports them', async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient({ size: 2, mtimeMs: 1 });
      const fs = new ArtifactFileSystem(client, '/ws', 'r1', [{ name: 'plan.md', path: '/runs/r1/plan.md' }]);
      const onChange = vi.fn();
      const stop = await fs.watchFile('/runs/r1/plan.md', onChange);

      await vi.advanceTimersByTimeAsync(3000);
      expect(onChange).not.toHaveBeenCalled(); // nothing changed yet

      client.setResponse({ size: 2, mtimeMs: 2 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(onChange).toHaveBeenCalledTimes(1);

      stop();
      client.setResponse({ size: 2, mtimeMs: 3 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(onChange).toHaveBeenCalledTimes(1); // stopped means stopped

      // Every poll was a stat: content is the caller's to fetch, once
      // onChange says there is something new to fetch.
      const methods = client.request.mock.calls.map(call => (call as unknown[])[0]);
      expect(methods.length).toBeGreaterThan(0);
      expect(new Set(methods)).toEqual(new Set(['statArtifact']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call onChange for a poll already in flight when stop() runs', async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient({ size: 2, mtimeMs: 1 });
      const fs = new ArtifactFileSystem(client, '/ws', 'r1', [{ name: 'plan.md', path: '/runs/r1/plan.md' }]);

      // Seed the mtime baseline the same way a real caller would: FilePreview
      // stats the file before it starts watching it.
      await fs.stat('/runs/r1/plan.md');

      // Make the *next* request() (the first poll) hang until we resolve it
      // ourselves, so we can call stop() while it's still in flight.
      let resolvePoll: ((value: FakeStatResult) => void) | undefined;
      client.request.mockImplementationOnce(() => new Promise<FakeStatResult>(resolve => {
        resolvePoll = resolve;
      }));

      const onChange = vi.fn();
      const stop = await fs.watchFile('/runs/r1/plan.md', onChange);

      vi.advanceTimersByTime(2000); // fires the poll; its request() is now pending
      expect(resolvePoll).toBeDefined();

      stop(); // unwatch while that poll is still awaiting its response

      // Resolve with a different mtime than the seeded baseline (1) — if the
      // stopped-check were missing, this would trigger onChange().
      resolvePoll?.({ size: 2, mtimeMs: 2 });
      await Promise.resolve();
      await Promise.resolve();

      expect(onChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('polling does not disturb the mtime cached for the write guard', async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient({ size: 2, mtimeMs: 1 });
      const fs = new ArtifactFileSystem(client, '/ws', 'r1', [{ name: 'plan.md', path: '/runs/r1/plan.md' }]);

      await fs.stat('/runs/r1/plan.md'); // seeds the write-guard cache at mtime 1

      const stop = await fs.watchFile('/runs/r1/plan.md', vi.fn());
      // The poll observes a newer mtime than the write-guard cache; polling
      // must not silently refresh that cache to this value.
      client.setResponse({ size: 2, mtimeMs: 2 });
      await vi.advanceTimersByTimeAsync(2000);
      stop();

      await fs.writeTextFile('/runs/r1/plan.md', 'edited');
      const writeCall = client.request.mock.calls.at(-1) as [string, { expectedMtimeMs?: number }];
      expect(writeCall[0]).toBe('writeArtifact');
      expect(writeCall[1].expectedMtimeMs).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report a change for a path that is not an artifact, and never polls', async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient({ size: 0, mtimeMs: 1 });
      const fs = new ArtifactFileSystem(client, '/ws', 'r1', []);
      const stop = await fs.watchFile('/runs/r1/nope.md', vi.fn());
      expect(typeof stop).toBe('function'); // refuses quietly; never throws at a caller mid-render

      await vi.advanceTimersByTimeAsync(10_000); // long enough for several poll intervals, if any were scheduled
      expect(client.request).not.toHaveBeenCalled(); // proves no polling ever started
    } finally {
      vi.useRealTimers();
    }
  });
});
