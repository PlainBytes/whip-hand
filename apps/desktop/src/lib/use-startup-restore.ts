/**
 * One-shot startup restore (F1): once the agent connects, load the app
 * state, adopt theme/page/workspace from it, and flip restoreDone so the
 * welcome page (F3) knows "no workspace" is a real answer rather than
 * "still loading".
 *
 * The saved New-run drafts and run tabs come back after the page, once, and
 * only then does their saving start, so restoring does not write them back.
 *
 * Restore deliberately bypasses openWorkspace: filesDirty is false at
 * startup and the slices a switch would clear are already empty.
 */
import { useEffect, useRef } from 'react';
import type { AgentClient } from '../agent/client.ts';
import { useAppStore } from '../state/store.ts';
import { startWindowStatePersistence } from './window-state.ts';
import { restoreDraftsAndTabs, startDraftSync, type DraftSync } from './draft-sync.ts';
import { sameWorkspace } from '../shared/path-form.ts';
import type { AppState } from '../shared/protocol.gen.ts';
import { resolvePersistedPage, type NavCapabilities } from '../nav.ts';

export function useStartupRestore(client: AgentClient, caps?: NavCapabilities): void {
  const agentStatus = useAppStore(state => state.agentStatus);
  const started = useRef(false);
  const sync = useRef<DraftSync | null>(null);

  useEffect(() => () => sync.current?.dispose(), []);

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
        if (!store().workspacePath && latest) store().setWorkspacePath(latest.path, latest.identityKey);
        await restoreDrafts(client, state);
      } catch {
        // No app state (old agent, broken disk): behave exactly like today.
      } finally {
        sync.current = startDraftSync(client);
        store().setRestoreDone();
      }
    })();
  }, [agentStatus, client]);
}

/**
 * Puts the saved drafts and tabs into the store. Anything the person already
 * opened while this ran stays, and keeps the active tab.
 */
async function restoreDrafts(client: AgentClient, state: AppState): Promise<void> {
  const restored = await restoreDraftsAndTabs(client, state);
  const now = useAppStore.getState();
  const drafts = { ...restored.drafts, ...now.drafts };
  const tabs = [...restored.tabs, ...now.tabs.filter(tab => !restored.tabs.some(other => other.key === tab.key))];
  const activeTabKey = now.activeTabKey ?? restored.activeTabKey;
  // Restore bypasses openWorkspace, so land on the workspace the active tab is
  // in. Switching clears the active tab, hence before it is set.
  const shown = tabs.find(tab => tab.key === activeTabKey);
  const draft = shown?.kind === 'draft' ? drafts[shown.key] : undefined;
  const target = shown?.kind === 'run' ? { path: shown.workdir, identityKey: shown.identityKey }
    : draft && { path: draft.workdir, identityKey: draft.identityKey };
  if (target && now.workspacePath !== null
    && !sameWorkspace(target, { path: now.workspacePath, identityKey: now.workspaceIdentityKey ?? undefined })) {
    now.setWorkspacePath(target.path, target.identityKey);
  }
  useAppStore.setState({ drafts, tabs, activeTabKey });
}
