import { useState, type ReactElement } from 'react';
import { useAgentClient } from '../agent/agent-context.tsx';
import { draftHasContent, useAppStore } from '../state/store.ts';
import { sameWorkspace } from '../shared/path-form.ts';
import { openWorkspace } from '../lib/workspace-switch.ts';
import type { AnyTab } from '../lib/run-tabs.ts';
import { UnsavedChangesDialog } from './UnsavedChangesDialog.tsx';

/** Where a tab lives: a run tab carries it, a draft holds it in the store. */
export function tabWorkspace(tab: AnyTab): { path: string; identityKey: string | undefined } | undefined {
  if (tab.kind === 'run') return { path: tab.workdir, identityKey: tab.identityKey };
  const draft = useAppStore.getState().drafts[tab.key];
  return draft === undefined ? undefined : { path: draft.workdir, identityKey: draft.identityKey };
}

/** Whether the tab belongs to the current workspace. */
export function isTabHere(tab: AnyTab): boolean {
  const where = tabWorkspace(tab);
  const { workspacePath, workspaceIdentityKey } = useAppStore.getState();
  return where !== undefined
    && workspacePath !== null
    && sameWorkspace(where, { path: workspacePath, identityKey: workspaceIdentityKey ?? undefined });
}

/**
 * Closing a draft from anywhere: an untouched one goes at once, one with
 * something typed or attached asks first. Render `dialog` wherever the hook is
 * used; it is null unless a question is pending.
 */
export function useDiscardDraft(): {
  request: (draftId: string) => void;
  dialog: ReactElement | null;
  afterClose: (wasActive: boolean) => void;
} {
  const client = useAgentClient();
  const [pending, setPending] = useState<string | null>(null);

  /**
   * Closing the active tab hands focus to a neighbour, which may belong to
   * another workspace. Show the Runs list meanwhile, and switch through
   * `openWorkspace` so its guard applies; a refusal leaves the list showing.
   */
  function afterClose(wasActive: boolean): void {
    const { tabs, activeTabKey, activateTab } = useAppStore.getState();
    const neighbour = tabs.find(candidate => candidate.key === activeTabKey);
    if (!wasActive || neighbour === undefined || isTabHere(neighbour)) return;
    activateTab(null);
    const where = tabWorkspace(neighbour);
    if (where === undefined) return;
    void openWorkspace(client, where.path)
      .catch(() => false)
      .then(opened => {
        if (opened) useAppStore.getState().activateTab(neighbour.key);
      });
  }

  function discard(draftId: string): void {
    const wasActive = useAppStore.getState().activeTabKey === draftId;
    useAppStore.getState().discardDraft(draftId);
    afterClose(wasActive);
  }

  function request(draftId: string): void {
    const draft = useAppStore.getState().drafts[draftId];
    if (!draft || !draftHasContent(draft)) discard(draftId);
    else setPending(draftId);
  }

  const dialog = pending === null ? null : (
    <UnsavedChangesDialog
      onDiscard={() => {
        discard(pending);
        setPending(null);
      }}
      onKeepEditing={() => setPending(null)}
    />
  );
  return { request, dialog, afterClose };
}
