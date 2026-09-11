/**
 * Server-side history of what a job printed, so a client that attaches partway
 * through a run sees the transcript rather than an empty terminal.
 *
 * Before this existed, PTY output went straight from pty.ts to the wire and was
 * buffered ONLY in the desktop webview's zustand store. That is fine for the
 * one client that was watching from the start, and useless for any other: open
 * the browser ten minutes into a run and the terminal is blank, because the
 * history lives in another process's memory.
 *
 * Not part of jobs.ts on purpose. A Job is the run-control record — the abort
 * controller, the promise, the live pty handle — and it stops being interesting
 * the moment the run ends. Scrollback has to OUTLIVE that, because reading the
 * transcript of a finished run is the normal case. Two different lifetimes and
 * two different eviction rules do not belong in one object; keying by jobId
 * associates them without coupling them.
 *
 * `record()` both appends and stamps `seq`. That pairing is the point: `seq` is
 * the chunk's absolute position in this pty session, and it is what lets a
 * late-attaching client splice a snapshot together with the notifications
 * already arriving. If the two were assigned in different places they could
 * disagree, and the symptom would be a silently corrupted terminal.
 */
import type { AwaitReason } from './protocol.ts';

/**
 * Same budget the desktop store already used (PTY_DATA_BUFFER_CAP_CHARS),
 * measured the same way — summed base64 length, no decoding just to size it.
 */
export const PTY_SCROLLBACK_CAP_CHARS = 2_000_000;
/** Matches the desktop store's LOG_TAIL_CAP. */
export const LOG_SCROLLBACK_CAP_LINES = 2_000;
/**
 * How many jobs keep a transcript. Worst case is roughly
 * MAX_TRACKED_JOBS × (2MB of base64 + 2000 lines) — call it 20MB in an agent
 * that has been up all day, and typically far less.
 */
export const MAX_TRACKED_JOBS = 8;

export interface PtyScrollback {
  stepId: string;
  cols: number;
  rows: number;
  /** Absolute index of chunks[0]; chunks[i] is absolute chunk baseIndex + i. */
  baseIndex: number;
  /** True once anything has been dropped off the front of this session. */
  trimmed: boolean;
  /** base64, arrival order. */
  chunks: string[];
  exited: boolean;
  exitCode?: number;
  exitReason?: 'exit' | 'ended';
  awaiting?: { stepId: string; reason: AwaitReason };
}

export interface LogScrollback {
  baseIndex: number;
  trimmed: boolean;
  lines: Array<{ stream: 'stdout' | 'stderr'; line: string }>;
}

export interface JobScrollback {
  /** null when this job has never opened an interactive session. */
  pty: PtyScrollback | null;
  logs: LogScrollback;
}

export interface Scrollback {
  /**
   * Records one outbound notification and returns the params to actually send.
   * ptyData and stepLog come back with `seq` attached; everything else is
   * returned untouched.
   */
  record(method: string, params: unknown): unknown;
  snapshot(jobId: string): JobScrollback | null;
  /** Job ids with a transcript, most recently active last. */
  trackedJobs(): string[];
}

interface Entry extends JobScrollback {
  lastActivity: number;
}

function emptyEntry(now: number): Entry {
  return { pty: null, logs: { baseIndex: 0, trimmed: false, lines: [] }, lastActivity: now };
}

/**
 * Trims from the front until the total is back under the cap, never dropping
 * the newest chunk even if that one chunk alone exceeds it. Deliberately the
 * same algorithm as capPtyDataBuffer in the desktop store — the two cap
 * independently, and absolute indices stay coherent because `seq` is assigned
 * here, once, and never renumbered.
 */
function capChunks(pty: PtyScrollback): void {
  let total = 0;
  for (const chunk of pty.chunks) total += chunk.length;
  let start = 0;
  while (total > PTY_SCROLLBACK_CAP_CHARS && start < pty.chunks.length - 1) {
    total -= pty.chunks[start]!.length;
    start += 1;
  }
  if (start === 0) return;
  pty.chunks = pty.chunks.slice(start);
  pty.baseIndex += start;
  pty.trimmed = true;
}

export function createScrollback(now: () => number = Date.now): Scrollback {
  const entries = new Map<string, Entry>();

  function touch(jobId: string): Entry {
    let entry = entries.get(jobId);
    if (!entry) {
      entry = emptyEntry(now());
      entries.set(jobId, entry);
      evict();
    }
    entry.lastActivity = now();
    return entry;
  }

  /** Least-recently-active first, and never a job whose pty is still live. */
  function evict(): void {
    while (entries.size > MAX_TRACKED_JOBS) {
      let victim: string | undefined;
      let oldest = Infinity;
      for (const [jobId, entry] of entries) {
        const live = entry.pty !== null && !entry.pty.exited;
        if (live) continue;
        if (entry.lastActivity < oldest) {
          oldest = entry.lastActivity;
          victim = jobId;
        }
      }
      // Everything left is a live session: keeping them all beats dropping the
      // transcript of a run that is still going.
      if (victim === undefined) return;
      entries.delete(victim);
    }
  }

  function record(method: string, params: unknown): unknown {
    if (!params || typeof params !== 'object') return params;
    const p = params as Record<string, unknown>;
    const jobId = typeof p.jobId === 'string' ? p.jobId : undefined;
    if (!jobId) return params;

    switch (method) {
      case 'ptyStarted': {
        const entry = touch(jobId);
        // A fresh session: whatever the previous one buffered no longer applies.
        entry.pty = {
          stepId: String(p.stepId ?? ''),
          cols: Number(p.cols ?? 80),
          rows: Number(p.rows ?? 24),
          baseIndex: 0,
          trimmed: false,
          chunks: [],
          exited: false,
        };
        return params;
      }
      case 'ptyData': {
        const entry = touch(jobId);
        const data = typeof p.data === 'string' ? p.data : '';
        // A ptyData with no ptyStarted before it should not happen, but losing
        // the output would be worse than synthesising a session for it.
        if (!entry.pty) {
          entry.pty = {
            stepId: '', cols: 80, rows: 24, baseIndex: 0, trimmed: false, chunks: [], exited: false,
          };
        }
        const seq = entry.pty.baseIndex + entry.pty.chunks.length;
        entry.pty.chunks.push(data);
        capChunks(entry.pty);
        return { ...p, seq };
      }
      case 'ptyExit': {
        const entry = touch(jobId);
        if (entry.pty) {
          entry.pty.exited = true;
          entry.pty.exitCode = typeof p.exitCode === 'number' ? p.exitCode : undefined;
          entry.pty.exitReason = p.reason === 'ended' || p.reason === 'exit' ? p.reason : undefined;
          entry.pty.awaiting = undefined;
        }
        return params;
      }
      case 'ptyAwait': {
        const entry = touch(jobId);
        if (entry.pty) {
          entry.pty.awaiting = p.awaiting && p.reason
            ? { stepId: String(p.stepId ?? ''), reason: p.reason as AwaitReason }
            : undefined;
        }
        return params;
      }
      case 'stepLog': {
        const entry = touch(jobId);
        const seq = entry.logs.baseIndex + entry.logs.lines.length;
        entry.logs.lines.push({
          stream: p.stream === 'stderr' ? 'stderr' : 'stdout',
          line: typeof p.line === 'string' ? p.line : '',
        });
        const overflow = entry.logs.lines.length - LOG_SCROLLBACK_CAP_LINES;
        if (overflow > 0) {
          entry.logs.lines.splice(0, overflow);
          entry.logs.baseIndex += overflow;
          entry.logs.trimmed = true;
        }
        return { ...p, seq };
      }
      default:
        return params;
    }
  }

  return {
    record,
    snapshot(jobId) {
      const entry = entries.get(jobId);
      if (!entry) return null;
      // Structured-cloned so a caller cannot mutate the live record, and so
      // serializing it cannot race an append.
      return {
        pty: entry.pty ? { ...entry.pty, chunks: [...entry.pty.chunks] } : null,
        logs: { ...entry.logs, lines: [...entry.logs.lines] },
      };
    },
    trackedJobs() {
      return [...entries.entries()]
        .sort((a, b) => a[1].lastActivity - b[1].lastActivity)
        .map(([jobId]) => jobId);
    },
  };
}
