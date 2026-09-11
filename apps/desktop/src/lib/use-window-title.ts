/**
 * Keeps the window title in step with the jobs running in the *open*
 * workspace, so the taskbar carries the attention badge (F10) even when the
 * window is behind something else. A job started in another workspace still
 * lives in the store — Activity reports it — but it must not make this
 * workspace's title claim a run it isn't hosting.
 */
import { useEffect } from 'react';
import { useAppStore } from '../state/store.ts';
import { applyWindowTitle, formatWindowTitle } from './window-state.ts';

export function useWindowTitle(): void {
  const jobs = useAppStore(state => state.jobs);
  const workspacePath = useAppStore(state => state.workspacePath);
  useEffect(() => {
    const active = Object.values(jobs).filter(j => !j.finished && j.workdir === workspacePath);
    applyWindowTitle(formatWindowTitle(active.length, active.filter(j => j.awaiting).length));
  }, [jobs, workspacePath]);
}
