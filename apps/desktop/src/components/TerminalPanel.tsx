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
 * xterm.js wired to a job's PTY: outgoing keystrokes go out as ptyInput,
 * incoming ptyData is written to the terminal, and container resizes are
 * fitted and reported as ptyResize (debounced). Actual xterm construction
 * goes through xterm-runtime.ts's createTerminal() — see that module for why
 * (jsdom test boundary).
 *
 * ptyData/ptyExit reach this component indirectly: AgentClientProvider
 * already routes both into the zustand store unconditionally (so nothing is
 * lost if this panel isn't mounted yet), and this component just reacts to
 * the store's per-job ptyDataBuffer/ptyExited/ptyExitCode — which also gives
 * us "replay everything buffered so far" for free on mount.
 */
export function TerminalPanel({ jobId, cols, rows, onResize }: TerminalPanelProps) {
  const client = useAgentClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<TerminalHandle | null>(null);
  // Absolute chunk index (not a plain buffer array index): ptyDataBuffer can
  // be trimmed from the front once it's grown past its cap (see store.ts),
  // so "how many chunks have we written" has to survive buffer[0] no longer
  // being chunk #0. ptyDataBaseIndex (below) is what buffer[0] currently
  // represents; buffer[i] is always absolute chunk (ptyDataBaseIndex + i).
  // This ref is the single source of truth for the "already trimmed, show
  // the marker" decision too (see the replay effect) — deliberately not a
  // separate mount-time-only flag: TauriTransport can dispatch many NDJSON
  // lines synchronously within one stdout 'data' event, which React batches
  // into a single render/effect pass, so a trim can jump straight past
  // chunks this panel never got an individual turn to write — not just
  // chunks trimmed before it ever mounted.
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

  // Mount/unmount xterm exactly once per jobId.
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
  // as they arrive — same code path handles both. Converts the absolute
  // "chunks written so far" count to a local buffer index via
  // ptyDataBaseIndex, so this stays correct whether or not a trim happened
  // since the last time this effect ran (batched trims included).
  //
  // ptyDataBaseIndex > writtenAbsoluteRef.current means the buffer's front
  // has been trimmed past chunks this panel never wrote — whether that's
  // because they were trimmed before this instance ever mounted
  // (writtenAbsoluteRef.current starts at 0) or because several ptyData
  // notifications (one of which triggered a trim) landed in one batched
  // update before this effect got a turn to run. Either way, show the
  // marker once. This condition self-disarms after the loop below catches
  // writtenAbsoluteRef.current back up to ptyDataBaseIndex + buffer.length —
  // no separate "already shown" flag needed.
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
  // This line is the only place the panel reports the exit, and it reports
  // only the session: the terminal's business ends where the session does.
  // What happens *next* — the harvest pass that writes the step's artifact —
  // belongs to the step, and the step's own pill says it (see
  // lib/step-phase.ts), so a
  // deliberate end needs no wording of its own here beyond withholding the
  // exit code that would read like a crash.
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
