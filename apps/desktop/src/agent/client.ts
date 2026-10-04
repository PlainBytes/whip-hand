import type { Transport } from './transport.ts';
import { perfEnabled, recordRpc } from '../lib/perf-probe.ts';
import type {
  MethodMap,
  MethodName,
  NotificationMap,
  NotificationName,
} from '../shared/protocol.gen.ts';

export type { RunDetail, RunSummary } from '../shared/core-types.ts';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'down';

export interface AgentClientOptions {
  /** How long a single request() waits for a response before rejecting. Default 30s. */
  requestTimeoutMs?: number;
  /** How many consecutive respawn failures before giving up (status 'down'). Default 5. */
  maxRetries?: number;
  /** Base delay for the exponential backoff between respawn attempts. Default 500ms. */
  baseDelayMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Set only while the perf probe is on (lib/perf-probe.ts). */
  perf?: { method: string; startedAt: number };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 500;

/**
 * Correlation + supervision layer over a Transport (the in-process agent, a
 * WebSocket, or a MockTransport in tests). Owns request ids,
 * response/notification routing, per-request timeouts, and reconnect-with-
 * backoff when the connection ends. Never touches `@tauri-apps/*`
 * directly — that's InProcessTransport's job — so this file is safe to import
 * from vitest.
 */
export class AgentClient {
  private readonly transport: Transport;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly statusHandlers = new Set<(status: ConnectionStatus) => void>();

  private currentStatus: ConnectionStatus = 'connecting';
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(transport: Transport, options: AgentClientOptions = {}) {
    this.transport = transport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

    this.transport.onLine(line => this.handleLine(line));
    this.transport.onExit(code => this.handleExit(code));
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  /**
   * Start the transport and fire the initial hello handshake. Resolves once
   * the transport is up (or has failed and entered the supervised retry
   * loop) — never rejects, since failures thereafter are the retry loop's
   * job and are visible via onStatusChange()/status.
   */
  async connect(): Promise<void> {
    try {
      await this.establishConnection();
    } catch {
      this.handleExit(null);
    }
  }

  request<M extends MethodName>(method: M, params: MethodMap[M]['params']): Promise<MethodMap[M]['result']> {
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params });
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request "${method}" timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      const perf = perfEnabled() ? { method, startedAt: performance.now() } : undefined;
      this.pending.set(id, { resolve, reject, timer, perf });
      this.transport.send(line);
    });
    return promise as Promise<MethodMap[M]['result']>;
  }

  onNotification<N extends NotificationName>(method: N, cb: (params: NotificationMap[N]) => void): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    const handler = cb as (params: unknown) => void;
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  onStatusChange(cb: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(cb);
    return () => this.statusHandlers.delete(cb);
  }

  /** Stop retrying and kill the transport. The client is not usable after this. */
  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.rejectAllPending(new Error('agent client disposed'));
    this.transport.kill();
  }

  private async establishConnection(): Promise<void> {
    this.setStatus(this.retries > 0 ? 'reconnecting' : 'connecting');
    await this.transport.start();
    if (this.disposed) return;
    this.retries = 0;
    this.setStatus('connected');
    // Best-effort liveness/version handshake: a slow or failing hello
    // shouldn't block the UI from treating the transport as up, and its
    // own failure doesn't warrant tearing the connection down again.
    void this.request('hello', {}).catch(() => {});
  }

  private handleExit(code: number | null): void {
    this.rejectAllPending(new Error(`agent transport exited (code ${code ?? 'unknown'})`));
    if (this.disposed) return;

    if (this.retries >= this.maxRetries) {
      this.setStatus('down');
      return;
    }

    this.setStatus('reconnecting');
    const delay = this.baseDelayMs * 2 ** this.retries;
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      this.establishConnection().catch(() => this.handleExit(null));
    }, delay);
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return; // malformed line from the agent; nothing sane to correlate it to
    }
    if (!value || typeof value !== 'object') return;

    if ('method' in value) {
      const { method, params } = value as { method: string; params: unknown };
      const handlers = this.notificationHandlers.get(method);
      handlers?.forEach(cb => cb(params));
      return;
    }

    if ('id' in value) {
      const { id } = value as { id: number | null };
      if (id === null) return;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (entry.perf) recordRpc(entry.perf.method, performance.now() - entry.perf.startedAt);
      if ('error' in value) {
        const { error } = value as { error: { message: string } };
        entry.reject(new Error(error.message));
      } else {
        entry.resolve((value as unknown as { result: unknown }).result);
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.statusHandlers.forEach(cb => cb(status));
  }
}
