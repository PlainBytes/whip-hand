/**
 * Transport over a WebSocket, for the browser host.
 *
 * The mapping onto the Transport contract is the reason this feature is small:
 * `start()` is "open the socket", `kill()` is "close it", and `onExit` fires
 * when it closes however it closes — which is exactly the shape AgentClient
 * already handles, including its reconnect-with-backoff. A dropped Wi-Fi
 * connection therefore behaves like a crashed sidecar, and needs no new code.
 *
 * Deliberately free of any @tauri-apps import (like MockTransport, unlike
 * TauriTransport) so it stays in the vitest graph and can be exercised against
 * a fake global WebSocket.
 *
 * The close code the agent uses for a rotated token is 4001; it is surfaced to
 * onExit so the shell can tell "your token was revoked" apart from "the
 * network blipped", rather than reconnecting forever against a token that will
 * never be accepted again.
 */
import type { Transport } from './transport.ts';

/** Matches CLOSE_TOKEN_REVOKED in packages/agent/src/remote/server.ts. */
export const CLOSE_TOKEN_REVOKED = 4001;

export interface WebSocketTransportOptions {
  /** Where the agent listens. Defaults to this page's own origin. */
  url?: string;
  /** Injected in tests; defaults to the global constructor. */
  socketFactory?: (url: string) => WebSocket;
}

function defaultUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws`;
}

export class WebSocketTransport implements Transport {
  private socket: WebSocket | undefined;
  private lineCb: ((line: string) => void) | undefined;
  private exitCb: ((code: number | null) => void) | undefined;
  private readonly baseUrl: string;
  private readonly factory: (url: string) => WebSocket;

  constructor(private readonly getToken: () => string | null, options: WebSocketTransportOptions = {}) {
    this.baseUrl = options.url ?? defaultUrl();
    this.factory = options.socketFactory ?? (url => new WebSocket(url));
  }

  async start(): Promise<void> {
    // A browser WebSocket cannot set request headers, so the token has to be a
    // query parameter. It never leaves this origin, and the agent checks Host
    // and Origin as well — see packages/agent/src/remote/auth.ts.
    const token = this.getToken();
    const url = token ? `${this.baseUrl}?t=${encodeURIComponent(token)}` : this.baseUrl;
    const socket = this.factory(url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.onopen = () => {
        settled = true;
        resolve();
      };
      socket.onerror = () => {
        // A failed handshake surfaces only as a generic error event; the agent
        // answered 401 or 403, but the browser will not tell us which.
        if (!settled) {
          settled = true;
          reject(new Error('could not connect to Whiphand'));
        }
      };
      socket.onclose = event => {
        if (!settled) {
          settled = true;
          reject(new Error('could not connect to Whiphand'));
          return;
        }
        this.socket = undefined;
        this.exitCb?.(event.code);
      };
      socket.onmessage = event => {
        // One JSON value per frame — the agent sends exactly what it would
        // have written as one NDJSON line, so no reassembly is needed here.
        const line = typeof event.data === 'string' ? event.data.trim() : '';
        if (line) this.lineCb?.(line);
      };
    });
  }

  send(line: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(line);
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  kill(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}
