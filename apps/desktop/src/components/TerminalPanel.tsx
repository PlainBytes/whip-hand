import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { decodeBase64ToBytes, encodeToBase64 } from '../lib/base64.ts';
import { createTerminal, TERMINAL_BACKGROUND, type TerminalHandle } from './xterm-runtime.ts';
import { matchesTerminalPassthrough } from '../lib/keymap/keymap.ts';
import { useKeymap } from '../lib/keymap/use-keymap.ts';
import { perfEnabled, perfMark } from '../lib/perf-probe.ts';

export interface TerminalPanelProps {
  /** The job whose interactive PTY this panel mounts for. */
  jobId: string;
  /** The PTY's current size (in cells), as reported by the ptyStarted notification. */
  cols?: number;
  rows?: number;
  /** Called with the new terminal size (in cells) whenever the user resizes it — wired to ptyResize. */
  onResize: (cols: number, rows: number) => void;
  /**
   * `fit` (default): xterm fills its box and the size is reported as ptyResize.
   * `follow`: a guest — xterm takes the PTY's own cols/rows, never reports a
   * size, and the panel scrolls sideways. For narrow screens, where fitting
   * would shrink the PTY the desktop is also showing.
   */
  sizing?: 'fit' | 'follow';
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
/** Follow mode: size xterm to the PTY. Unknown size keeps xterm's defaults, and nothing is reported. */
function adoptPtySize(handle: TerminalHandle, cols: number | undefined, rows: number | undefined): void {
  if (cols === undefined || rows === undefined || cols < 1 || rows < 1) return;
  if (handle.term.cols === cols && handle.term.rows === rows) return;
  handle.term.resize(cols, rows);
}

export interface TerminalPanelHandle {
  /** Puts the keyboard cursor in the terminal (xterm's helper textarea). */
  focus(): void;
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(function TerminalPanel(
  { jobId, cols, rows, onResize, sizing = 'fit' },
  ref,
) {
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
  // marker" decision (see the replay effect): the transport can dispatch many
  // lines within one task, which React batches into one
  // render/effect pass, so a trim can jump past chunks this panel never wrote
  // individually — not only chunks trimmed before mount.
  const writtenAbsoluteRef = useRef(0);
  /** What the replay pump reads; see the replay effect. */
  const latestBufferRef = useRef<{ buffer: readonly string[]; baseIndex: number }>({ buffer: EMPTY_BUFFER, baseIndex: 0 });
  /** True while a backlog slice is in xterm's queue and the next one waits on its callback. */
  const pumpingRef = useRef(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Read by the long-lived observer/mount closures, which must see a live mode switch.
  const sizingRef = useRef(sizing);
  sizingRef.current = sizing;
  const sizeProps = useRef({ cols, rows });
  sizeProps.current = { cols, rows };

  useImperativeHandle(ref, () => ({ focus: () => handleRef.current?.term.focus() }), []);

  // Read through a ref: the key handler is installed once per terminal, and a rebind must apply to it live.
  const keymap = useKeymap();
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;

  const ptyDataBuffer = useAppStore(state => state.jobs[jobId]?.ptyDataBuffer ?? EMPTY_BUFFER);
  const ptyDataBaseIndex = useAppStore(state => state.jobs[jobId]?.ptyDataBaseIndex ?? 0);
  const ptyExited = useAppStore(state => state.jobs[jobId]?.ptyExited ?? false);
  const ptyExitCode = useAppStore(state => state.jobs[jobId]?.ptyExitCode);
  const ptyExitReason = useAppStore(state => state.jobs[jobId]?.ptyExitReason);
  const windowsPty = useAppStore(state => state.agentWindowsPty);
  // A session whiphand closed on purpose always exits 0; reporting that
  // code would read like a crash, so say what actually happened instead.
  const endedDeliberately = ptyExitReason === 'ended';

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handle = createTerminal({ cols, rows });
    handle.term.open(container);
    if (sizingRef.current === 'fit') handle.fitAddon.fit();
    else adoptPtySize(handle, sizeProps.current.cols, sizeProps.current.rows);
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
      // Chords marked allowInTerminal (Ctrl+Tab / Ctrl+Shift+Tab switch run tabs). Returning false on every
      // event type keeps xterm from writing \t to the pty and from cancelling
      // the event, so it reaches the window-level shortcut.
      if (matchesTerminalPassthrough(keymapRef.current, event)) return false;
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
      if (sizingRef.current !== 'fit') return;
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      if (resizeTimerRef.current !== undefined) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = undefined;
        if (sizingRef.current !== 'fit') return;
        handle.fitAddon.fit();
        onResize(handle.term.cols, handle.term.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    // Report the size established by the first fit immediately, not debounced.
    if (sizingRef.current === 'fit') onResize(handle.term.cols, handle.term.rows);

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

  // A live mode switch (rotation, a window dragged across the breakpoint)
  // keeps the terminal. Entering `fit` fits and reports once, as a mount does;
  // entering `follow` stops reporting and takes the PTY's size.
  const appliedSizingRef = useRef(sizing);
  useEffect(() => {
    if (appliedSizingRef.current === sizing) return;
    appliedSizingRef.current = sizing;
    const handle = handleRef.current;
    if (!handle) return;
    if (resizeTimerRef.current !== undefined) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = undefined;
    }
    if (sizing === 'fit') {
      handle.fitAddon.fit();
      onResize(handle.term.cols, handle.term.rows);
    } else {
      adoptPtySize(handle, sizeProps.current.cols, sizeProps.current.rows);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizing]);

  // In follow mode the PTY's size (ptyStarted, attach snapshot) drives xterm.
  useEffect(() => {
    const handle = handleRef.current;
    if (handle && sizing === 'follow') adoptPtySize(handle, cols, rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, rows]);

  // Soft keyboard: tapping focuses xterm's helper textarea (xterm does this on
  // click); once it is focused, keep the cursor row above the keyboard.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || sizing !== 'follow') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      const textarea = container.querySelector('textarea');
      if (!textarea) return;
      textarea.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      const vv = window.visualViewport;
      if (!vv) return;
      const overlap = textarea.getBoundingClientRect().bottom - (vv.offsetTop + vv.height);
      if (overlap > 0) window.scrollBy(0, overlap + 8);
    };
    const onFocusIn = () => {
      reveal();
      // The keyboard animates in after focus; the viewport reports its final height later.
      clearTimeout(timer);
      timer = setTimeout(reveal, 300);
    };
    container.addEventListener('focusin', onFocusIn);
    window.visualViewport?.addEventListener('resize', reveal);
    return () => {
      container.removeEventListener('focusin', onFocusIn);
      window.visualViewport?.removeEventListener('resize', reveal);
      clearTimeout(timer);
    };
  }, [sizing, jobId]);

  // Tells xterm the pty is ConPTY so it handles its repaints and reflow. Live
  // option, so a hello that lands after mount still takes effect; jobId is a
  // dependency because the mount effect builds a fresh terminal per job.
  useEffect(() => {
    const handle = handleRef.current;
    if (handle) handle.term.options.windowsPty = windowsPty;
  }, [windowsPty, jobId]);

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

  const follow = sizing === 'follow';
  return (
    <div
      data-testid="terminal-scroller"
      style={{
        flex: 1,
        minHeight: 0,
        height: '100%',
        minWidth: 0,
        overflowX: follow ? 'auto' : 'hidden',
        background: TERMINAL_BACKGROUND,
        borderRadius: 4,
      }}
    >
      <div
        ref={containerRef}
        data-testid="terminal-container"
        style={{
          borderRadius: 4,
          padding: 8,
          background: TERMINAL_BACKGROUND,
          height: '100%',
          boxSizing: 'border-box',
          ...(follow ? { width: 'max-content', minWidth: '100%' } : {}),
        }}
      />
    </div>
  );
});
