/**
 * The HTTP + WebSocket server that lets a browser on the LAN drive this agent.
 *
 * Shape, and why:
 *   - Static SPA on GET, unauthenticated (see static.ts for the reasoning).
 *   - GET /api/ping, token-authenticated, so the web client can validate a
 *     token BEFORE mounting React and show a "rescan" screen instead of an
 *     endless reconnect spinner. This is why AgentClient needs no changes.
 *   - GET /ws, the RPC channel. A browser WebSocket cannot set headers, so the
 *     token arrives as ?t=; the Host and Origin checks in auth.ts do the rest.
 *
 * The Host/Origin check is applied to EVERY request, not just the authenticated
 * ones. Serving the shell to any Host would technically be harmless (the files
 * are inert), but then reaching the app by some other hostname would load a
 * page that silently fails to open its socket. A 403 naming the reason is far
 * easier to act on than a spinner.
 *
 * `noServer: true` plus a manual 'upgrade' handler is deliberate: it lets a
 * refused upgrade be an actual HTTP 401 that shows up in devtools, rather than
 * a handshake we complete and then immediately close.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Dispatcher } from '../rpc.ts';
import type { NotifyFn } from '../frontend.ts';
import { FailureThrottle, checkHostAndOrigin, localAddresses, tokenMatches } from './auth.ts';
import { resolveStatic, sendStatic } from './static.ts';

/**
 * One frame cannot exceed this. ptyInput is keystrokes; the one legitimate
 * large frame is a startRun carrying base64 attachments, which this caps at
 * roughly 750 KB of files (see remoteStartRunParams in methods.ts).
 */
const MAX_FRAME_BYTES = 1 << 20;

export interface RemoteServerDeps {
  /**
   * Builds a dispatcher for one connection. Per-connection rather than shared
   * so ctx.clientId identifies the caller — see pty-sizes.ts for the one
   * handler that needs to tell two simultaneous clients apart. The method and
   * handler maps are the same filtered partition every time; only the id
   * differs.
   */
  makeDispatcher: (clientId: string) => Dispatcher;
  /** Absolute path of the built SPA, or null when it was never built. */
  webRoot: () => string | null;
  /** Called whenever listening/error/clientCount changes, so a notification can fan out. */
  onStatusChange?: () => void;
  /** Called when a client's socket closes, so per-client state can be dropped. */
  onClientGone?: (clientId: string) => void;
}

export interface RemoteServerStatus {
  listening: boolean;
  error: string | null;
  clientCount: number;
  port: number;
}

export interface RemoteServer {
  /** Idempotent: starting on the port already bound is a no-op. */
  start(port: number, token: string): Promise<void>;
  stop(): Promise<void>;
  /** Serialize once, deliver to every open socket. */
  broadcast: NotifyFn;
  /** Close every socket, e.g. after the token is rotated. */
  dropClients(reason: string): void;
  status(): RemoteServerStatus;
}

/** WebSocket close code for "your token is no longer valid" (application range). */
export const CLOSE_TOKEN_REVOKED = 4001;

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
    'Connection: close\r\n' +
    'Content-Length: 0\r\n' +
    '\r\n',
  );
  socket.destroy();
}

export function createRemoteServer(deps: RemoteServerDeps): RemoteServer {
  let server: Server | null = null;
  let wss: WebSocketServer | null = null;
  let currentToken = '';
  let currentPort = 0;
  let error: string | null = null;
  const sockets = new Set<WebSocket>();
  let nextClientId = 1;
  const throttle = new FailureThrottle();

  function statusChanged(): void {
    deps.onStatusChange?.();
  }

  function authorized(req: IncomingMessage, provided: string | null): boolean {
    const ip = clientIp(req);
    if (throttle.blocked(ip)) return false;
    if (!tokenMatches(currentToken, provided)) {
      throttle.record(ip);
      return false;
    }
    throttle.clear(ip);
    return true;
  }

  function guardHeaders(req: IncomingMessage): string | null {
    const check = checkHostAndOrigin(req.headers, currentPort, localAddresses());
    return check.ok ? null : check.reason;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rejection = guardHeaders(req);
    if (rejection) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Refused: ${rejection}\n`);
      return;
    }

    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    if (path === '/api/ping') {
      const header = req.headers.authorization;
      const provided = typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
        ? header.slice(7).trim()
        : null;
      if (!authorized(req, provided)) {
        // No WWW-Authenticate: it would trigger the browser's native
        // basic-auth dialog, which cannot supply the token we want.
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"error":"unauthorized"}\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('{"ok":true}\n');
      return;
    }

    const root = deps.webRoot();
    if (!root) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('The remote UI has not been built. Run: npm run build:web -w desktop\n');
      return;
    }

    const hit = await resolveStatic(root, path);
    if (!hit) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
      return;
    }
    sendStatic(res, hit);
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const rejection = guardHeaders(req);
    if (rejection) {
      refuseUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      refuseUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!authorized(req, url.searchParams.get('t'))) {
      refuseUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    wss?.handleUpgrade(req, socket, head, ws => {
      sockets.add(ws);
      const clientId = `remote-${nextClientId++}`;
      const dispatcher = deps.makeDispatcher(clientId);
      statusChanged();

      ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const line = raw.toString().trim();
        if (!line) return;
        // Structurally identical to main.ts's rl.on('line'): the response goes
        // back only on the socket the request arrived on, which is exactly why
        // two clients can both use request id 1 without interfering.
        void dispatcher.handleLine(line)
          .then(response => {
            if (ws.readyState === ws.OPEN) ws.send(response);
          })
          .catch(err => console.error('[whiphand-agent] remote dispatch failure:', err));
      });

      const forget = (): void => {
        if (!sockets.delete(ws)) return;
        // Before the status change, so anything reacting to the new client
        // count already sees this client's state released.
        deps.onClientGone?.(clientId);
        statusChanged();
      };
      ws.on('close', forget);
      ws.on('error', err => {
        console.error('[whiphand-agent] remote socket error:', err);
        forget();
      });
    });
  }

  return {
    async start(port, token) {
      currentToken = token;
      if (server && (currentPort === port || port === 0)) return;
      if (server) await this.stop();

      const httpServer = createServer((req, res) => {
        void handleRequest(req, res).catch(err => {
          console.error('[whiphand-agent] remote request failure:', err);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal error\n');
        });
      });
      wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
      httpServer.on('upgrade', handleUpgrade);

      await new Promise<void>((resolveStart, rejectStart) => {
        // A bind failure must NEVER reach main.ts's uncaughtException handler,
        // which would process.exit(1) and take the whole sidecar — and the
        // desktop app's entire backend — down with it. EADDRINUSE is a routine
        // user-facing condition, reported through status().
        const onError = (err: NodeJS.ErrnoException): void => {
          error = err.code === 'EADDRINUSE'
            ? `Port ${port} is already in use`
            : (err.message || String(err));
          httpServer.removeListener('listening', onListening);
          httpServer.close();
          wss?.close();
          wss = null;
          server = null;
          statusChanged();
          rejectStart(new Error(error));
        };
        const onListening = (): void => {
          httpServer.removeListener('error', onError);
          // Past startup, an error must not reject a settled promise.
          httpServer.on('error', err => {
            console.error('[whiphand-agent] remote server error:', err);
          });
          error = null;
          server = httpServer;
          // Read the port back rather than trusting the argument: port 0 means
          // "any free port", and the Host check compares against the port we
          // are ACTUALLY on. Tests rely on this; so would any future ephemeral bind.
          const bound = httpServer.address();
          currentPort = typeof bound === 'object' && bound !== null ? bound.port : port;
          statusChanged();
          resolveStart();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, '0.0.0.0');
      });
    },

    async stop() {
      const httpServer = server;
      const wasActive = httpServer !== null || sockets.size > 0;
      server = null;
      for (const ws of sockets) ws.terminate();
      sockets.clear();
      wss?.close();
      wss = null;
      if (httpServer) {
        await new Promise<void>(done => httpServer.close(() => done()));
      }
      currentPort = 0;
      // Stopping something that was never running is not a state change, and
      // announcing it would put noise on the wire at every startup.
      if (wasActive) statusChanged();
    },

    broadcast(method, params) {
      if (sockets.size === 0) return;
      // Serialized once regardless of client count.
      const line = JSON.stringify({ method, params });
      for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) ws.send(line);
      }
    },

    dropClients(reason) {
      for (const ws of sockets) ws.close(CLOSE_TOKEN_REVOKED, reason);
      sockets.clear();
      statusChanged();
    },

    status() {
      return { listening: server !== null, error, clientCount: sockets.size, port: currentPort };
    },
  };
}

/**
 * The addresses to offer the user, loopback only as a fallback. Deliberately
 * NOT full URLs: a URL needs the token in its fragment, and this value travels
 * in the remoteAccessChanged notification, which every client receives.
 */
export function lanAddresses(): string[] {
  const lan = localAddresses().filter(a => !['localhost', '127.0.0.1', '::1'].includes(a));
  return lan.length > 0 ? lan : ['127.0.0.1'];
}

/**
 * The shareable URL, composed where the token is already known. The token
 * rides in the FRAGMENT: never sent to the server, so it stays out of access
 * logs and Referer headers, and the page strips it from the address bar on load.
 */
export function remoteUrl(address: string, port: number, token: string): string {
  return `http://${address}:${port}/#t=${token}`;
}
