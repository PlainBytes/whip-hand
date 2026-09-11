import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { AgentClient } from './client.ts';
import { useAppStore } from '../state/store.ts';

const AgentClientContext = createContext<AgentClient | null>(null);

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
  const applyRunStateChanged = useAppStore(state => state.applyRunStateChanged);
  const applyStepLog = useAppStore(state => state.applyStepLog);
  const applyPtyStarted = useAppStore(state => state.applyPtyStarted);
  const applyPtyData = useAppStore(state => state.applyPtyData);
  const applyPtyExit = useAppStore(state => state.applyPtyExit);
  const applyPtyAwait = useAppStore(state => state.applyPtyAwait);
  const applyManualRequest = useAppStore(state => state.applyManualRequest);
  const applyManualResolved = useAppStore(state => state.applyManualResolved);
  const applyRemoteAccessChanged = useAppStore(state => state.applyRemoteAccessChanged);
  const setAppState = useAppStore(state => state.setAppState);

  useEffect(() => {
    setAgentStatus(client.status);
    const unsubscribers = [
      client.onStatusChange(setAgentStatus),
      client.onNotification('whiphandEvent', applyWhiphandEvent),
      client.onNotification('runStateChanged', applyRunStateChanged),
      client.onNotification('stepLog', applyStepLog),
      client.onNotification('ptyStarted', applyPtyStarted),
      client.onNotification('ptyData', applyPtyData),
      client.onNotification('ptyExit', applyPtyExit),
      client.onNotification('ptyAwait', applyPtyAwait),
      client.onNotification('manualRequest', applyManualRequest),
      client.onNotification('manualResolved', applyManualResolved),
      client.onNotification('remoteAccessChanged', applyRemoteAccessChanged),
      // Emitted on every app-state write, whoever made it, so a desktop and a
      // browser converge instead of drifting until one restarts. Re-applying
      // one's own change is a no-op.
      client.onNotification('appStateChanged', setAppState),
    ];
    void client.connect();
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the apply*/setAgentStatus setters are stable zustand references
  }, [client]);

  return <AgentClientContext.Provider value={client}>{children}</AgentClientContext.Provider>;
}

export function useAgentClient(): AgentClient {
  const client = useContext(AgentClientContext);
  if (!client) throw new Error('useAgentClient() must be used within an AgentClientProvider');
  return client;
}
