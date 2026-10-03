/**
 * Opt-in performance probe for scripts/bench (Playwright, against the web
 * build) and the manual check in the Tauri app (docs/benchmarks.md).
 *
 * Inert unless `localStorage['whiphand.perf'] === '1'` when the page loads:
 * the flag is read once, so the hot paths that call into here (every
 * AgentClient.request) pay one boolean test and nothing else. Enabled, it
 * exposes `window.__whiphandPerf` for a script or a devtools console to read.
 */

const FLAG_KEY = 'whiphand.perf';

export interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  /** Frames that missed two 60 Hz vsyncs — the jank a person notices. */
  over33: number;
  /** Summed duration of the Long Tasks API entries that started in the window. */
  longTaskMs: number;
  durationMs: number;
}

export interface PerfProbe {
  startFrames(): void;
  stopFrames(): FrameStats;
  /** Per-method request→response latencies, in ms, oldest first. */
  rpc(): Record<string, number[]>;
  clearRpc(): void;
  mark(name: string): void;
  marks(): Record<string, number[]>;
}

function readFlag(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage?.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

const enabled = readFlag();

const rpcSamples = new Map<string, number[]>();
const markTimes = new Map<string, number[]>();
const longTasks: { start: number; duration: number }[] = [];
/** A ring per method would be tidier; a cap keeps a forgotten flag from leaking. */
const MAX_SAMPLES_PER_KEY = 10_000;

function push(map: Map<string, number[]>, key: string, value: number): void {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  if (list.length < MAX_SAMPLES_PER_KEY) list.push(value);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function perfEnabled(): boolean {
  return enabled;
}

/** Callers check perfEnabled() first, so the disabled path never reaches here. */
export function recordRpc(method: string, ms: number): void {
  push(rpcSamples, method, ms);
}

export function perfMark(name: string): void {
  if (enabled) push(markTimes, name, performance.now());
}

function install(): void {
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // WebKitGTK has no Long Tasks API; frame stats still work without it.
    }
  }

  let deltas: number[] = [];
  let last = 0;
  let windowStart = 0;
  let raf: number | null = null;
  const tick = (now: number) => {
    if (last !== 0) deltas.push(now - last);
    last = now;
    raf = requestAnimationFrame(tick);
  };

  const probe: PerfProbe = {
    startFrames() {
      if (raf !== null) cancelAnimationFrame(raf);
      deltas = [];
      last = 0;
      windowStart = performance.now();
      raf = requestAnimationFrame(tick);
    },
    stopFrames() {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      const end = performance.now();
      const sorted = [...deltas].sort((a, b) => a - b);
      const longTaskMs = longTasks
        .filter(task => task.start >= windowStart && task.start <= end)
        .reduce((sum, task) => sum + task.duration, 0);
      return {
        frames: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
        over33: sorted.filter(d => d > 33.4).length,
        longTaskMs,
        durationMs: end - windowStart,
      };
    },
    rpc: () => Object.fromEntries(rpcSamples),
    clearRpc: () => rpcSamples.clear(),
    mark: perfMark,
    marks: () => Object.fromEntries(markTimes),
  };
  (window as unknown as { __whiphandPerf: PerfProbe }).__whiphandPerf = probe;
}

if (enabled) install();
