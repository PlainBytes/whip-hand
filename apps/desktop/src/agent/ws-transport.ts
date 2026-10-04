/**
 * Transport over a WebSocket, for the browser host.
 *
 * The mapping onto the Transport contract is the reason this feature is small:
 * `start()` is "open the socket", `kill()` is "close it", and `onExit` fires
 * when it closes however it closes — which is exactly the shape AgentClient
 * already handles, including its reconnect-with-backoff. A dropped Wi-Fi
 * connection therefore behaves like a crashed agent, and needs no new code.
 *
 * Deliberately free of any @tauri-apps import (like MockTransport, unlike
 * InProcessTransport) so it stays in the vitest graph and can be exercised against
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

/** Matches TOKEN_PROTOCOL_PREFIX in packages/agent/src/remote/auth.ts. */
const TOKEN_PROTOCOL_PREFIX = 'whiphand.token.';

/** Matches PROTOCOL_NAME in packages/agent/src/remote/auth.ts. */
const PROTOCOL_NAME = 'whiphand';

export interface WebSocketTransportOptions {
  /** Where the agent listens. Defaults to this page's own origin. */
  url?: string;
  /** Injected in tests; defaults to the global constructor. */
  socketFactory?: (url: string, protocols?: string[]) => WebSocket;
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
  private readonly factory: (url: string, protocols?: string[]) => WebSocket;

  constructor(private readonly getToken: () => string | null, options: WebSocketTransportOptions = {}) {
    this.baseUrl = options.url ?? defaultUrl();
    this.factory = options.socketFactory ?? ((url, protocols) => new WebSocket(url, protocols));
  }

  async start(): Promise<void> {
    // A browser WebSocket cannot set request headers, but it can set
    // Sec-WebSocket-Protocol — the one handshake header exposed to callers —
    // so the token rides there instead of in the URL. The agent checks Host
    // and Origin as well — see packages/agent/src/remote/auth.ts.
    //
    // PROTOCOL_NAME rides alongside the token so the server has a non-secret
    // value to echo back: the handshake response must repeat one of the
    // offered protocols verbatim, and without a second option that would be
    // the token itself.
    const token = this.getToken();
    const protocols = token ? [PROTOCOL_NAME, `${TOKEN_PROTOCOL_PREFIX}${token}`] : undefined;
    const socket = this.factory(this.baseUrl, protocols);
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
