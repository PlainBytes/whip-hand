import { useEffect, useRef } from 'react';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { decodeBase64ToBytes, encodeToBase64 } from '../lib/base64.ts';
import { createTerminal, type TerminalHandle } from './xterm-runtime.ts';

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

    const dataSub = handle.term.onData(data => {
      void client.request('ptyInput', { jobId, data: encodeToBase64(data) });
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
  // as they arrive via the same loop. Converts the absolute "chunks written"
  // count to a local buffer index via ptyDataBaseIndex, so this stays correct
  // across trims (including several batched into one render pass).
  //
  // ptyDataBaseIndex > writtenAbsoluteRef.current means the buffer's front was
  // trimmed past chunks this panel never wrote — before mount, or via a
  // batched update this effect hasn't run for yet. Show the marker once; the
  // condition self-disarms once the loop below catches writtenAbsoluteRef.current
  // up to ptyDataBaseIndex + buffer.length.
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    if (ptyDataBaseIndex > writtenAbsoluteRef.current) {
      handle.term.write('\x1b[2m[earlier output truncated]\x1b[0m\r\n');
    }
    const localStart = Math.max(writtenAbsoluteRef.current, ptyDataBaseIndex) - ptyDataBaseIndex;
    for (let i = localStart; i < ptyDataBuffer.length; i += 1) {
      handle.term.write(decodeBase64ToBytes(ptyDataBuffer[i]));
    }
    writtenAbsoluteRef.current = ptyDataBaseIndex + ptyDataBuffer.length;
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, height: '100%', minHeight: 0 }}>
      <div
        ref={containerRef}
        data-testid="terminal-container"
        style={{
          border: '1px solid var(--colorNeutralStroke2)',
          borderRadius: 4,
          padding: 4,
          flex: 1,
          minHeight: 0,
        }}
      />
    </div>
  );
}
