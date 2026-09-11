/**
 * Owns the remote channel's state: the persisted config, the server, and the
 * three RPCs that manage them. handlers.ts delegates here so it stays free of
 * transport concerns, exactly as its own header promises.
 *
 * The server is injected via useServer() rather than constructed here, because
 * the dependency graph is genuinely circular: the handlers need this controller,
 * the remote dispatcher needs those handlers, and the server needs that
 * dispatcher. One explicit setter, called once by main.ts, is easier to follow
 * than a lazy getter threaded through three constructors.
 */
import type { NotifyFn } from '../frontend.ts';
import type { RemoteAccessState } from '../protocol.ts';
import { generateToken } from './auth.ts';
import type { RemoteAccessStore } from './config.ts';
import { lanAddresses, type RemoteServer } from './server.ts';

export interface RemoteControllerDeps {
  store: RemoteAccessStore;
  webRoot: () => string | null;
  notify: NotifyFn;
}

export interface RemoteController {
  useServer(server: RemoteServer): void;
  /** Bring the server in line with the persisted config. Safe to call repeatedly. */
  applyConfig(): Promise<RemoteAccessState>;
  getState(): Promise<RemoteAccessState>;
  set(params: { enabled?: boolean; port?: number }): Promise<RemoteAccessState>;
  rotateToken(): Promise<RemoteAccessState>;
  /** Fan out the current state, minus the token. */
  publishState(): void;
  stop(): Promise<void>;
}

export function createRemoteController(deps: RemoteControllerDeps): RemoteController {
  let server: RemoteServer | null = null;
  let lastError: string | null = null;

  async function buildState(): Promise<RemoteAccessState> {
    const config = await deps.store.get();
    const status = server?.status() ?? { listening: false, error: null, clientCount: 0, port: config.port };
    return {
      enabled: config.enabled,
      port: config.port,
      token: config.token,
      listening: status.listening,
      error: status.error ?? lastError,
      clientCount: status.clientCount,
      // Only meaningful while listening: a stale address for a stopped server
      // would look like something the user could hand out.
      addresses: status.listening ? lanAddresses() : [],
      webRootPresent: deps.webRoot() !== null,
    };
  }

  function publish(state: RemoteAccessState): void {
    const { token: _token, ...withoutToken } = state;
    // Notifications fan out to every client INCLUDING the remote one, so the
    // token must never ride along.
    deps.notify('remoteAccessChanged', withoutToken);
  }

  async function sync(): Promise<RemoteAccessState> {
    const config = await deps.store.get();
    if (!server) return buildState();

    if (!config.enabled) {
      lastError = null;
      await server.stop();
      return buildState();
    }
    try {
      await server.start(config.port, config.token);
      lastError = null;
    } catch (e) {
      // Reported, never thrown onward: a failed bind is a routine user-facing
      // condition, and main.ts's uncaughtException handler exits the process.
      lastError = e instanceof Error ? e.message : String(e);
      console.error('[whiphand-agent] remote access failed to start:', lastError);
    }
    return buildState();
  }

  return {
    useServer(next) {
      server = next;
    },

    /**
     * Startup only. Deliberately does NOT publish: a notification means
     * something CHANGED, and at startup nothing has — clients read the initial
     * state with remoteAccessGet. Emitting one here also put an unsolicited
     * line on stdout before the first response, which is exactly the kind of
     * thing a reader of this protocol should never have to tolerate.
     */
    async applyConfig() {
      return sync();
    },

    getState: buildState,

    async set(params) {
      await deps.store.mutate(c => ({
        ...c,
        ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
        ...(params.port === undefined ? {} : { port: params.port }),
      }));
      // A port change has to land as a rebind, not just a config write.
      if (params.port !== undefined && server?.status().listening) await server.stop();
      const state = await sync();
      publish(state);
      return state;
    },

    async rotateToken() {
      const next = await deps.store.mutate(c => ({ ...c, token: generateToken() }));
      // Every existing client authenticated with the old token; rotation means
      // nothing, if they get to keep their already-open socket.
      server?.dropClients('token rotated');
      const state = await sync();
      publish({ ...state, token: next.token });
      return state;
    },

    publishState() {
      void buildState().then(publish).catch(err =>
        console.error('[whiphand-agent] could not publish remote access state:', err));
    },

    async stop() {
      await server?.stop();
    },
  };
}
