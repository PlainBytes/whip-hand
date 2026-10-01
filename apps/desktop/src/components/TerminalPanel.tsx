import { useEffect, useRef } from 'react';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { decodeBase64ToBytes, encodeToBase64 } from '../lib/base64.ts';
import { createTerminal, TERMINAL_BACKGROUND, type TerminalHandle } from './xterm-runtime.ts';
import { perfEnabled, perfMark } from '../lib/perf-probe.ts';

export interface TerminalPanelProps {
  /** The job whose interactive PTY this panel mounts for. */
  jobId: string;
  /** The PTY's current size (in cells), as reported by the ptyStarted notification. */
  cols?: number;
  rows?: number;
  /** Called with the new terminal size (in cells) whenever the user resizes it — wired to ptyResize. */
  onResize: (cols: number, rows: number) => void;
}

const RESIZE_DEBOUNCE_MS = 100;
const EMPTY_BUFFER: string[] = [];
/** Base64 chars of pty output written per replay slice — about 190 KB of terminal bytes. */
const REPLAY_SLICE_CHARS = 256_000;

/**
 * What a "newline, don't submit" key sends to the CLI: ESC CR, which is what
 * xterm already sends for Alt+Enter, so both combos reach the CLI as the same
 * bytes. One sequence for every CLI on purpose — no per-adapter overrides.
 */
export const NEWLINE_SEQUENCE = '\x1b\r';

/**
 * xterm 5.5 sends a bare CR for Shift+Enter, indistinguishable from Enter, and
 * has no kitty keyboard protocol to say otherwise — so Shift+Enter is remapped
 * here. Alt+Enter is left to xterm (it already sends NEWLINE_SEQUENCE), as are
 * Ctrl/Meta chords and anything typed through an IME composition.
 */
export function isShiftEnter(event: KeyboardEvent): boolean {
  return (
    event.key === 'Enter' &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing
  );
}

/**
 * xterm.js wired to a job's PTY: keystrokes out as ptyInput, ptyData written
 * to the terminal, and resizes reported as ptyResize (debounced). Actual
 * construction goes through xterm-runtime.ts's createTerminal() (jsdom test boundary).
 * The store buffers ptyData/ptyExit unconditionally, whether or not this panel is
 * mounted, so mounting always replays everything the job has produced so far.
 */
export function TerminalPanel({ jobId, cols, rows, onResize }: TerminalPanelProps) {
  const client = useAgentClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<TerminalHandle | null>(null);
  // Absolute chunk index, not a plain buffer array index: ptyDataBuffer can be
  // trimmed from the front once it grows past its cap (see store.ts), so "how
  // many chunks have we written" has to survive buffer[0] no longer being
  // chunk #0. ptyDataBaseIndex is what buffer[0] currently represents;
  // buffer[i] is always absolute chunk (ptyDataBaseIndex + i).
  //
  // Also the single source of truth for the "already trimmed, show the
  // marker" decision (see the replay effect): TauriTransport can dispatch many
  // NDJSON lines within one stdout event, which React batches into one
  // render/effect pass, so a trim can jump past chunks this panel never wrote
  // individually — not only chunks trimmed before mount.
  const writtenAbsoluteRef = useRef(0);
  /** What the replay pump reads; see the replay effect. */
  const latestBufferRef = useRef<{ buffer: readonly string[]; baseIndex: number }>({ buffer: EMPTY_BUFFER, baseIndex: 0 });
  /** True while a backlog slice is in xterm's queue and the next one waits on its callback. */
  const pumpingRef = useRef(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const ptyDataBuffer = useAppStore(state => state.jobs[jobId]?.ptyDataBuffer ?? EMPTY_BUFFER);
  const ptyDataBaseIndex = useAppStore(state => state.jobs[jobId]?.ptyDataBaseIndex ?? 0);
  const ptyExited = useAppStore(state => state.jobs[jobId]?.ptyExited ?? false);
  const ptyExitCode = useAppStore(state => state.jobs[jobId]?.ptyExitCode);
  const ptyExitReason = useAppStore(state => state.jobs[jobId]?.ptyExitReason);
  // A session whiphand closed on purpose always exits 0; reporting that
  // code would read like a crash, so say what actually happened instead.
  const endedDeliberately = ptyExitReason === 'ended';

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handle = createTerminal({ cols, rows });
    handle.term.open(container);
    handle.fitAddon.fit();
    handleRef.current = handle;
    writtenAbsoluteRef.current = 0;
    pumpingRef.current = false;

    const dataSub = handle.term.onData(data => {
      void client.request('ptyInput', { jobId, data: encodeToBase64(data) });
    });

    // Returning false tells xterm to skip the event, so it must cover every
    // event type of the key (keydown, keypress, keyup) or xterm would still
    // send its own CR alongside ours. Only keydown sends. Once the session has
    // exited (disableStdin) we send nothing: this handler would otherwise get
    // around xterm's own input blocking.
    handle.term.attachCustomKeyEventHandler(event => {
      if (!isShiftEnter(event)) return true;
      if (event.type === 'keydown' && !handle.term.options.disableStdin) {
        void client.request('ptyInput', { jobId, data: encodeToBase64(NEWLINE_SEQUENCE) });
      }
      return false;
    });

    const resizeObserver = new ResizeObserver(() => {
      // A hidden panel (the inactive tab is display:none) measures 0x0.
      // Fitting to that would report a nonsense size to the PTY — and the
      // observer fires again with the real box when the tab comes back, so
      // skipping is not a missed refit.
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      if (resizeTimerRef.current !== undefined) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = undefined;
        handle.fitAddon.fit();
        onResize(handle.term.cols, handle.term.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    // Report the size established by the first fit immediately, not debounced.
    onResize(handle.term.cols, handle.term.rows);

    return () => {
      dataSub.dispose();
      resizeObserver.disconnect();
      if (resizeTimerRef.current !== undefined) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = undefined;
      }
      handle.term.dispose();
      handleRef.current = null;
    };
    // Mount/unmount is keyed on jobId only: cols/rows are just the initial
    // size (the real size comes from fit()), onResize/client are stable
    // across a panel's lifetime in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Replay whatever the store already buffered, then keep writing new chunks
  // as they arrive via the same pump. Converts the absolute "chunks written"
  // count to a local buffer index via ptyDataBaseIndex, so this stays correct
  // across trims (including several batched into one render pass).
  //
  // ptyDataBaseIndex > writtenAbsoluteRef.current means the buffer's front was
  // trimmed past chunks this panel never wrote — before mount, or via a
  // batched update this effect hasn't run for yet. Show the marker once; the
  // condition self-disarms once the pump catches writtenAbsoluteRef.current
  // up to ptyDataBaseIndex + buffer.length.
  //
  // A backlog (a mount or reattach onto ~2MB of scrollback) goes over in
  // REPLAY_SLICE_CHARS slices, each started from the previous one's write
  // callback, so decoding never holds the main thread for the whole buffer in
  // one task. Live output is a slice's worth at most and goes in one pass.
  // The pump always reads the latest buffer (latestBufferRef), not the one
  // the slice was started with: a trim can land between two slices.
  useEffect(() => {
    latestBufferRef.current = { buffer: ptyDataBuffer, baseIndex: ptyDataBaseIndex };
    const handle = handleRef.current;
    if (!handle || pumpingRef.current) return;
    const pump = () => {
      const { buffer, baseIndex } = latestBufferRef.current;
      if (baseIndex > writtenAbsoluteRef.current) {
        handle.term.write('\x1b[2m[earlier output truncated]\x1b[0m\r\n');
        writtenAbsoluteRef.current = baseIndex;
      }
      let i = writtenAbsoluteRef.current - baseIndex;
      let budget = REPLAY_SLICE_CHARS;
      while (i < buffer.length && budget > 0) {
        handle.term.write(decodeBase64ToBytes(buffer[i]));
        budget -= buffer[i].length;
        i += 1;
      }
      writtenAbsoluteRef.current = baseIndex + i;
      if (i < buffer.length) {
        pumpingRef.current = true;
        handle.term.write('', () => {
          // Unmounted, or remounted on another session, since this slice.
          if (handleRef.current !== handle) return;
          pumpingRef.current = false;
          pump();
        });
        return;
      }
      // The callback runs once xterm has parsed everything queued before it.
      if (perfEnabled()) handle.term.write('', () => perfMark('terminal:flushed'));
    };
    pump();
  }, [ptyDataBuffer, ptyDataBaseIndex]);

  // Go read-only once the store reports the PTY exited.
  //
  // This reports only the session ending, not what happens next: the harvest
  // pass that writes the step's artifact belongs to the step, whose own pill
  // says so (see lib/step-phase.ts) — hence no wording here beyond withholding
  // the exit code that would read like a crash.
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle || !ptyExited) return;
    handle.term.options.disableStdin = true;
    const suffix = endedDeliberately || ptyExitCode === undefined ? '' : ` (exit ${ptyExitCode})`;
    handle.term.write(`\r\n\x1b[2m[session ended${suffix}]\x1b[0m\r\n`);
  }, [ptyExited, ptyExitCode, endedDeliberately]);

  return (
    <div
      ref={containerRef}
      data-testid="terminal-container"
      style={{
        borderRadius: 4,
        padding: 8,
        background: TERMINAL_BACKGROUND,
        flex: 1,
        minHeight: 0,
        height: '100%',
      }}
    />
  );
}
