import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { AgentClient } from './client.ts';
import { useAppStore, type HighRateNotification } from '../state/store.ts';

const AgentClientContext = createContext<AgentClient | null>(null);

/**
 * Minimum gap between store commits for the high-rate notifications. A command
 * step can write output far faster than the page can repaint, and Tauri hands
 * over one IPC event per line, so applying each one on arrival re-renders the
 * run page per line and freezes the UI.
 */
const HIGH_RATE_WINDOW_MS = 100;

/**
 * Leading-edge throttle for the notifications a running command floods us with
 * (stepLog, step:log events, ptyData). The first one after a quiet spell is
 * applied at once; the rest queue in arrival order and are applied together
 * when the window closes, as ONE store write (applyHighRateBatch) rather than
 * one per notification. flush() drains the queue early so nothing else can be
 * applied ahead of an older queued item.
 */
export function createHighRateQueue(apply: (items: HighRateNotification[]) => void) {
  let queue: HighRateNotification[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    apply(batch);
  };
  const onWindowClosed = () => {
    timer = null;
    if (queue.length === 0) return;
    flush();
    timer = setTimeout(onWindowClosed, HIGH_RATE_WINDOW_MS);
  };
  return {
    flush,
    push(item: HighRateNotification) {
      if (timer === null) {
        apply([item]);
        timer = setTimeout(onWindowClosed, HIGH_RATE_WINDOW_MS);
      } else {
        queue.push(item);
      }
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      flush();
    },
  };
}

/**
 * Wires one AgentClient instance into the tree: syncs its connection status
 * into the zustand store, subscribes once to every store-relevant
 * notification (whiphandEvent, runStateChanged, stepLog, ptyStarted, ptyExit,
 * remoteAccessChanged) so
 * pages never each set up their own listener, and kicks off connect() once
 * on mount. This is the testability seam pages rely on — production
 * (main.tsx) provides a client built on TauriTransport, tests provide one
 * built on MockTransport, and page components never construct a client
 * themselves.
 */
export function AgentClientProvider({ client, children }: { client: AgentClient; children: ReactNode }) {
  const setAgentStatus = useAppStore(state => state.setAgentStatus);
  const applyWhiphandEvent = useAppStore(state => state.applyWhiphandEvent);
  const applyHighRateBatch = useAppStore(state => state.applyHighRateBatch);
  const applyRunStateChanged = useAppStore(state => state.applyRunStateChanged);
  const applyPtyStarted = useAppStore(state => state.applyPtyStarted);
  const applyPtyExit = useAppStore(state => state.applyPtyExit);
  const applyPtyAwait = useAppStore(state => state.applyPtyAwait);
  const applyManualRequest = useAppStore(state => state.applyManualRequest);
  const applyManualResolved = useAppStore(state => state.applyManualResolved);
  const applyRemoteAccessChanged = useAppStore(state => state.applyRemoteAccessChanged);
  const setAppState = useAppStore(state => state.setAppState);

  useEffect(() => {
    setAgentStatus(client.status);
    const highRate = createHighRateQueue(applyHighRateBatch);
    // Anything not queued first drains the queue, so store writes keep the
    // order the notifications arrived in.
    const ordered = <P,>(apply: (params: P) => void) => (params: P) => {
      highRate.flush();
      apply(params);
    };
    const unsubscribers = [
      client.onStatusChange(setAgentStatus),
      client.onNotification('whiphandEvent', params => {
        if (params.event.type === 'step:log') highRate.push({ method: 'whiphandEvent', params });
        else ordered(applyWhiphandEvent)(params);
      }),
      client.onNotification('runStateChanged', ordered(applyRunStateChanged)),
      client.onNotification('stepLog', params => highRate.push({ method: 'stepLog', params })),
      client.onNotification('ptyStarted', ordered(applyPtyStarted)),
      client.onNotification('ptyData', params => highRate.push({ method: 'ptyData', params })),
      client.onNotification('ptyExit', ordered(applyPtyExit)),
      client.onNotification('ptyAwait', ordered(applyPtyAwait)),
      client.onNotification('manualRequest', ordered(applyManualRequest)),
      client.onNotification('manualResolved', ordered(applyManualResolved)),
      client.onNotification('remoteAccessChanged', ordered(applyRemoteAccessChanged)),
      // Emitted on every app-state write, whoever made it, so a desktop and a
      // browser converge instead of drifting until one restarts. Re-applying
      // one's own change is a no-op.
      client.onNotification('appStateChanged', setAppState),
    ];
    void client.connect();
    return () => {
      unsubscribers.forEach(unsubscribe => unsubscribe());
      highRate.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the apply*/setAgentStatus setters are stable zustand references
  }, [client]);

  return <AgentClientContext.Provider value={client}>{children}</AgentClientContext.Provider>;
}

export function useAgentClient(): AgentClient {
  const client = useContext(AgentClientContext);
  if (!client) throw new Error('useAgentClient() must be used within an AgentClientProvider');
  return client;
}
