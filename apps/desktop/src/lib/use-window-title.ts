/**
 * Keeps the window title in step with the jobs running in the *open*
 * workspace, so the taskbar carries the attention badge (F10) even when the
 * window is behind something else. A job started in another workspace still
 * lives in the store — Activity reports it — but it must not make this
 * workspace's title claim a run it isn't hosting.
 */
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { jobInWorkspace, useAppStore } from '../state/store.ts';
import { applyWindowTitle, formatWindowTitle } from './window-state.ts';

export function useWindowTitle(): void {
  // Two counts, not `jobs`: selecting jobs re-ran this on every pty chunk.
  const [active, awaiting] = useAppStore(useShallow(state => {
    const workspace = state.workspacePath === null
      ? null
      : { path: state.workspacePath, identityKey: state.workspaceIdentityKey ?? undefined };
    const live = Object.values(state.jobs).filter(j => !j.finished && workspace !== null && jobInWorkspace(j, workspace));
    return [live.length, live.filter(j => j.awaiting).length];
  }));
  useEffect(() => {
    applyWindowTitle(formatWindowTitle(active, awaiting));
  }, [active, awaiting]);
}
