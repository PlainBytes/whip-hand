/**
 * One-shot startup restore (F1): once the agent connects, load the app
 * state, adopt theme/page/workspace from it, and flip restoreDone so the
 * welcome page (F3) knows "no workspace" is a real answer rather than
 * "still loading".
 *
 * Restore deliberately bypasses openWorkspace: filesDirty is false at
 * startup and the slices a switch would clear are already empty.
 */
import { useEffect, useRef } from 'react';
import type { AgentClient } from '../agent/client.ts';
import { useAppStore } from '../state/store.ts';
import { startWindowStatePersistence } from './window-state.ts';
import { resolvePersistedPage, type NavCapabilities } from '../nav.ts';

export function useStartupRestore(client: AgentClient, caps?: NavCapabilities): void {
  const agentStatus = useAppStore(state => state.agentStatus);
  const started = useRef(false);

  useEffect(() => {
    if (agentStatus !== 'connected' || started.current) return;
    started.current = true;
    void (async () => {
      const store = useAppStore.getState;
      try {
        const state = await client.request('getAppState', {});
        store().setAppState(state);
        void startWindowStatePersistence(client, state.window).catch(() => {});
        // An unrecognised lastPage (a removed or renamed page) resolves to
        // null and leaves the store default in place.
        // Both hosts write lastPage into the same app state, so a browser
        // can be handed 'files' by the desktop; resolvePersistedPage rejects
        // a page this host cannot render.
        const restored = resolvePersistedPage(state.lastPage, caps);
        if (restored) store().setPage(restored);
        const latest = state.recentWorkspaces[0];
        if (!store().workspacePath && latest) store().setWorkspacePath(latest.path);
      } catch {
        // No app state (old agent, broken disk): behave exactly like today.
      } finally {
        store().setRestoreDone();
      }
    })();
  }, [agentStatus, client]);
}
