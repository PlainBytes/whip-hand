import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { TerminalPanel } from './TerminalPanel.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore, type JobState } from '../state/store.ts';
import { encodeToBase64 } from '../lib/base64.ts';
import { createTerminal, type TerminalHandle } from './xterm-runtime.ts';

/** A full JobState with sane defaults, for tests that need to seed the store's job shape directly (e.g. an already-trimmed ptyDataBuffer) rather than build it up through reducer calls. */
function baseJob(jobId: string, overrides: Partial<JobState> = {}): JobState {
  return {
    jobId,
    finished: false,
    stepOrder: [],
    steps: {},
    currentExecution: {},
    events: [],
    logTail: [], activityTail: [], hasNarrated: false,
    ptyActive: true,
    ptyDataBuffer: [],
    ptyDataBaseIndex: 0,
    ptyDataTrimmed: false,
    ptyExited: false,
    ...overrides,
  };
}

vi.mock('./xterm-runtime.ts', () => ({ createTerminal: vi.fn() }));

/**
 * Fake xterm Terminal/FitAddon: TerminalPanel talks to xterm-runtime.ts only
 * through the shape asserted here, so this stands in for the whole library —
 * jsdom can't do the real canvas rendering xterm needs (see xterm-runtime.ts).
 */
function makeFakeHandle() {
  let dataCb: ((data: string) => void) | undefined;
  let cols = 80;
  let rows = 24;
  const term = {
    get cols() { return cols; },
    get rows() { return rows; },
    options: {} as { disableStdin?: boolean },
    open: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => {
      dataCb = cb;
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    dispose: vi.fn(),
  };
  const fitAddon = {
    fit: vi.fn(() => {
      cols = 100;
      rows = 30;
    }),
  };
  return {
    term,
    fitAddon,
    emitData: (data: string) => dataCb?.(data),
  };
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
}

function renderPanel(jobId: string, onResize = vi.fn()) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  const result = render(
    <AgentClientProvider client={client}>
      <TerminalPanel jobId={jobId} onResize={onResize} />
    </AgentClientProvider>,
  );
  // jsdom reports every element as 0x0, which is exactly the shape the panel
  // now treats as "hidden". Give the container a realistic box so the resize
  // tests exercise the visible path; the hidden case sets it back to zero.
  const container = result.getByTestId('terminal-container');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  return { transport, client, onResize, unmount: result.unmount, container };
}

describe('TerminalPanel', () => {
  let handle: ReturnType<typeof makeFakeHandle>;

  beforeEach(() => {
    handle = makeFakeHandle();
    // The fake only implements the slice of Terminal/FitAddon TerminalPanel
    // actually uses (see makeFakeHandle above) — not the full xterm.js
    // surface, hence the cast.
    vi.mocked(createTerminal).mockReturnValue(handle as unknown as TerminalHandle);
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    useAppStore.setState({ jobs: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useAppStore.setState({ jobs: {} });
  });

  it('mounts the terminal into the container and disposes it on unmount', () => {
    const { unmount } = renderPanel('job-1');
    expect(handle.term.open).toHaveBeenCalledTimes(1);
    unmount();
    expect(handle.term.dispose).toHaveBeenCalledTimes(1);
  });

  it('sends ptyInput with correctly base64-encoded (unicode-safe) data on term.onData', async () => {
    const { transport } = renderPanel('job-2');

    act(() => handle.emitData('héllo→🚀'));

    const sent = transport.sent.map(line => JSON.parse(line) as { method: string; params: unknown });
    const req = sent.find(r => r.method === 'ptyInput');
    expect(req?.params).toEqual({ jobId: 'job-2', data: encodeToBase64('héllo→🚀') });
  });

  it('replays buffered ptyData already in the store on mount, in order, decoded to bytes', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'job-3', stepId: 'triage', cols: 80, rows: 24 });
    useAppStore.getState().applyPtyData({ jobId: 'job-3', data: encodeToBase64('hello ') });
    useAppStore.getState().applyPtyData({ jobId: 'job-3', data: encodeToBase64('world') });

    renderPanel('job-3');

    const writes = handle.term.write.mock.calls.map(call => Array.from(call[0] as Uint8Array));
    expect(writes[0]).toEqual(Array.from(new TextEncoder().encode('hello ')));
    expect(writes[1]).toEqual(Array.from(new TextEncoder().encode('world')));
  });

  it('writes newly arriving ptyData live, after already-replayed chunks', () => {
    renderPanel('job-4');
    useAppStore.getState().applyPtyStarted({ jobId: 'job-4', stepId: 'triage', cols: 80, rows: 24 });

    act(() => {
      useAppStore.getState().applyPtyData({ jobId: 'job-4', data: encodeToBase64('a') });
    });
    act(() => {
      useAppStore.getState().applyPtyData({ jobId: 'job-4', data: encodeToBase64('b') });
    });

    const writes = handle.term.write.mock.calls.map(call => Array.from(call[0] as Uint8Array));
    expect(writes[0]).toEqual(Array.from(new TextEncoder().encode('a')));
    expect(writes[1]).toEqual(Array.from(new TextEncoder().encode('b')));
  });

  it('replays the remaining buffer plus a truncation marker when mounting onto an already-trimmed session', () => {
    useAppStore.setState({
      jobs: {
        'job-trim-mount': baseJob('job-trim-mount', {
          ptyDataBuffer: [encodeToBase64('mid'), encodeToBase64('end')],
          ptyDataBaseIndex: 3, // chunks 0, 1, 2 were trimmed from the front before this panel ever mounted
          ptyDataTrimmed: true,
        }),
      },
    });

    renderPanel('job-trim-mount');

    const writes = handle.term.write.mock.calls;
    expect(writes).toHaveLength(3);
    expect(String(writes[0][0])).toMatch(/earlier output truncated/i);
    expect(Array.from(writes[1][0] as Uint8Array)).toEqual(Array.from(new TextEncoder().encode('mid')));
    expect(Array.from(writes[2][0] as Uint8Array)).toEqual(Array.from(new TextEncoder().encode('end')));
  });

  it('keeps live writes correct across a trim that happens while mounted — no duplicate write, no marker for an in-session trim', () => {
    renderPanel('job-10');
    useAppStore.getState().applyPtyStarted({ jobId: 'job-10', stepId: 'triage', cols: 80, rows: 24 });

    act(() => {
      useAppStore.getState().applyPtyData({ jobId: 'job-10', data: encodeToBase64('c0') });
    });
    act(() => {
      useAppStore.getState().applyPtyData({ jobId: 'job-10', data: encodeToBase64('c1') });
    });
    expect(handle.term.write).toHaveBeenCalledTimes(2);

    // Simulate the store trimming c0 out from under the still-mounted panel,
    // the way a real trim (store.ts's capPtyDataBuffer) would once the
    // buffer's total size exceeds its cap.
    act(() => {
      useAppStore.setState(state => ({
        jobs: {
          ...state.jobs,
          'job-10': { ...state.jobs['job-10'], ptyDataBuffer: [encodeToBase64('c1')], ptyDataBaseIndex: 1, ptyDataTrimmed: true },
        },
      }));
    });
    // No re-write of c1, and no truncation marker — this instance already
    // wrote c0/c1 to the terminal's own scrollback before the trim.
    expect(handle.term.write).toHaveBeenCalledTimes(2);

    act(() => {
      useAppStore.getState().applyPtyData({ jobId: 'job-10', data: encodeToBase64('c2') });
    });

    expect(handle.term.write).toHaveBeenCalledTimes(3);
    expect(Array.from(handle.term.write.mock.calls[2][0] as Uint8Array)).toEqual(Array.from(new TextEncoder().encode('c2')));
  });

  it('shows the truncated marker (and continues correctly) when a batched update trims chunks this panel never got a turn to write', () => {
    // Regression for: TauriTransport can dispatch many NDJSON lines
    // synchronously within one stdout 'data' event, and React batches them
    // into a single render/effect pass — so a trim can jump straight past
    // chunks the panel never individually caught up on, not just chunks
    // trimmed before it ever mounted.
    renderPanel('job-11');
    useAppStore.getState().applyPtyStarted({ jobId: 'job-11', stepId: 'triage', cols: 80, rows: 24 });

    // Each chunk's raw text is 600,000 ASCII chars, which base64-encodes to
    // exactly 800,000 chars (600,000 is a multiple of 3, so no padding) —
    // against store.ts's 2,000,000-char (of base64 text) cap: two chunks fit
    // (1,600,000), a third pushes the total to 2,400,000 and trims 'a' back
    // out to 1,600,000, before this already-mounted panel ever wrote it.
    const rawChunk = (id: string) => id.repeat(600_000);
    act(() => {
      useAppStore.getState().applyPtyData({ jobId: 'job-11', data: encodeToBase64(rawChunk('a')) });
      useAppStore.getState().applyPtyData({ jobId: 'job-11', data: encodeToBase64(rawChunk('b')) });
      useAppStore.getState().applyPtyData({ jobId: 'job-11', data: encodeToBase64(rawChunk('c')) });
    });

    const writes = handle.term.write.mock.calls;
    expect(writes).toHaveLength(3); // marker + 'b' + 'c' — 'a' was trimmed before this panel wrote it
    expect(String(writes[0][0])).toMatch(/earlier output truncated/i);
    // Decode back to a string for comparison rather than a deep-equal over
    // 600,000-element byte arrays, which is needlessly slow for what's just a
    // content check.
    expect(new TextDecoder().decode(writes[1][0] as Uint8Array)).toBe(rawChunk('b'));
    expect(new TextDecoder().decode(writes[2][0] as Uint8Array)).toBe(rawChunk('c'));

    // A subsequent chunk continues normally, without repeating the marker.
    act(() => {
      useAppStore.getState().applyPtyData({ jobId: 'job-11', data: encodeToBase64('d') });
    });

    expect(handle.term.write).toHaveBeenCalledTimes(4);
    expect(Array.from(handle.term.write.mock.calls[3][0] as Uint8Array)).toEqual(Array.from(new TextEncoder().encode('d')));
  });

  it('goes read-only and writes an exit line when the store reports ptyExit', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'job-5', stepId: 'triage', cols: 80, rows: 24 });
    renderPanel('job-5');

    act(() => {
      useAppStore.getState().applyPtyExit({ jobId: 'job-5', exitCode: 0 });
    });

    // Said once, in the terminal's own voice, on the channel the session's
    // output arrived on — not also as a Fluent <Text> under the box.
    expect(handle.term.options.disableStdin).toBe(true);
    expect(handle.term.write).toHaveBeenCalled();
    const lastWrite = handle.term.write.mock.calls.at(-1)?.[0] as string;
    expect(String(lastWrite)).toMatch(/session ended/i);
    expect(screen.queryByText(/session ended/i)).not.toBeInTheDocument();
  });

  it('reports a nonzero exit code, which points at a session that died on its own', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'job-exit', stepId: 'plan', cols: 80, rows: 24 });
    renderPanel('job-exit');

    act(() => {
      useAppStore.getState().applyPtyExit({ jobId: 'job-exit', exitCode: 3, reason: 'exit' });
    });

    // The exit code goes into the buffer line; "read-only" is not prose to
    // assert on but a property of the terminal, so assert the property.
    expect(String(handle.term.write.mock.calls.at(-1)?.[0])).toMatch(/\(exit 3\)/);
    expect(handle.term.options.disableStdin).toBe(true);
  });

  it('says what happens next, not "exit 0", when whiphand closed the session itself', () => {
    useAppStore.getState().applyPtyStarted({ jobId: 'job-ended', stepId: 'plan', cols: 80, rows: 24 });
    renderPanel('job-ended');

    act(() => {
      useAppStore.getState().applyPtyExit({ jobId: 'job-ended', exitCode: 0, reason: 'ended' });
    });

    // A session whiphand closed on purpose always exits 0; reporting
    // that code would read like a crash, so the line reports no code at all.
    // What happens *next* is the step's business, not the terminal's: the page
    // says "generating artifact" for as long as the harvest runs.
    const lastWrite = String(handle.term.write.mock.calls.at(-1)?.[0]);
    expect(lastWrite).toMatch(/session ended/i);
    expect(lastWrite).not.toMatch(/exit/);
    expect(screen.queryByText(/exit 0/)).not.toBeInTheDocument();
  });

  it('sends an initial resize right after the first fit, then debounces subsequent container resizes ~100ms', () => {
    vi.useFakeTimers();
    const { onResize } = renderPanel('job-6');

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(100, 30);

    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer).toBeDefined();

    // Two rapid-fire resize notifications should coalesce into a single debounced call.
    act(() => observer!.callback([], observer as unknown as ResizeObserver));
    act(() => observer!.callback([], observer as unknown as ResizeObserver));
    expect(onResize).toHaveBeenCalledTimes(1); // still just the initial call — debounce pending

    act(() => vi.advanceTimersByTime(99));
    expect(onResize).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1));
    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenLastCalledWith(100, 30);
  });

  it('clears a pending debounced resize timer on unmount (no leaked timer fires after unmount)', () => {
    vi.useFakeTimers();
    const { unmount, onResize } = renderPanel('job-7');
    onResize.mockClear();

    const observer = FakeResizeObserver.instances.at(-1)!;
    act(() => observer.callback([], observer as unknown as ResizeObserver));
    unmount();

    act(() => vi.advanceTimersByTime(200));
    expect(onResize).not.toHaveBeenCalled();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not report a size while its container is hidden (zero-sized)', () => {
    vi.useFakeTimers();
    const { onResize, container } = renderPanel('job-fit');
    // The mount-time fit already reported once; watch only what a
    // display:none-shaped resize does after that.
    onResize.mockClear();
    handle.fitAddon.fit.mockClear();

    Object.defineProperty(container, 'clientWidth', { value: 0, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 0, configurable: true });

    const observer = FakeResizeObserver.instances.at(-1)!;
    act(() => observer.callback([], observer as unknown as ResizeObserver));
    act(() => vi.advanceTimersByTime(200));

    expect(handle.fitAddon.fit).not.toHaveBeenCalled();
    expect(onResize).not.toHaveBeenCalled();
  });

  it('replays a scrollback snapshot applied WHILE mounted, without rewriting what it already drew', () => {
    // The mid-run attach race: the socket delivers live chunks into the store
    // first, then getJobScrollback answers with the earlier history. The panel
    // is already mounted and has already drawn the live chunks.
    const handle = makeFakeHandle();
    vi.mocked(createTerminal).mockReturnValue(handle as unknown as TerminalHandle);

    useAppStore.setState({
      jobs: {
        j1: baseJob('j1', {
          ptyStepId: 's1',
          ptyDataBuffer: [encodeToBase64('<<LIVE4>>'), encodeToBase64('<<LIVE5>>')],
          ptyDataBaseIndex: 3,
          ptyDataTrimmed: true,
        }),
      },
    });
    renderPanel('j1');

    const drawnFirst = handle.term.write.mock.calls.length;
    expect(drawnFirst).toBeGreaterThan(0);

    act(() => {
      useAppStore.getState().applyScrollbackSnapshot('j1', {
        pty: {
          stepId: 's1', cols: 80, rows: 24, baseIndex: 0, trimmed: false,
          chunks: [encodeToBase64('<<OLD1>>'), encodeToBase64('<<OLD2>>'), encodeToBase64('<<OLD3>>')],
          exited: false,
        },
        logs: { baseIndex: 0, trimmed: false, lines: [] },
      });
    });

    const decoded = handle.term.write.mock.calls
      .map(([arg]) => (typeof arg === 'string' ? arg : new TextDecoder().decode(arg as Uint8Array)))
      .join('');

    // Distinctive tokens, so the marker text cannot be miscounted as payload.
    // The live chunks were already on screen and must not be drawn twice.
    expect(decoded.split('<<LIVE4>>').length - 1).toBe(1);
    expect(decoded.split('<<LIVE5>>').length - 1).toBe(1);
    // The earlier history is not re-drawn either: the panel had already
    // advanced past those absolute positions, and the terminal has no way to
    // insert text above what is already rendered.
    expect(decoded).not.toContain('<<OLD1>>');
    // The panel's marker is driven by baseIndex, and the merge lowered it to 0,
    // so no further truncation notice is added on top of the one already shown.
    expect(decoded.match(/earlier output truncated/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
