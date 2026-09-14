/**
 * The Tauri auto-updater's UI. A dismissible banner, never a modal — an
 * update is not urgent enough to block the app the way AgentDownBanner's
 * "the agent is gone" state is.
 *
 * The install button is disabled while a run is active: a restart mid-run
 * would destroy the user's work, and long-running jobs are this app's whole
 * purpose. The banner still says an update is available either way — only
 * the button waits.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';
import { useAppStore } from '../state/store.ts';
import { createTauriUpdater, type AvailableUpdate, type InstallKind, type Updater } from '../lib/updater.ts';
import { errorMessage } from '../lib/error-message.ts';

/** Not instant: yields to startup work (workspace restore, agent connect) that matters more. */
const CHECK_DELAY_MS = 5000;

type Phase =
  | { kind: 'unchecked' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; manual: boolean }
  | { kind: 'available'; update: AvailableUpdate; installKind: InstallKind }
  | { kind: 'installing' }
  | { kind: 'error'; message: string };

export function UpdateBanner({
  updater = createTauriUpdater(),
  enabled = import.meta.env.PROD,
  checkDelayMs = CHECK_DELAY_MS,
}: { updater?: Updater; enabled?: boolean; checkDelayMs?: number } = {}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'unchecked' });
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const hasActiveRun = useAppStore(state => Object.values(state.jobs).some(job => job.status === 'running'));

  const runCheck = useCallback((manual: boolean) => {
    setPhase({ kind: 'checking' });
    void (async () => {
      try {
        const [update, installKind] = await Promise.all([updater.check(), updater.installKind()]);
        setPhase(update ? { kind: 'available', update, installKind } : { kind: 'up-to-date', manual });
      } catch (error) {
        setPhase({ kind: 'error', message: errorMessage(error) });
      }
    })();
  }, [updater]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => runCheck(false), checkDelayMs);
    return () => clearTimeout(timer);
    // Runs once per mount — a later manual check goes through runCheck directly, not this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!enabled) return null;

  // The automatic post-mount check stays invisible on a miss — a success bar
  // nobody asked for is exactly the nagging the PROD-only `enabled` guard
  // above exists to avoid. A manual check (Retry, today) still confirms.
  if (phase.kind === 'up-to-date' && !phase.manual) return null;

  if (phase.kind === 'up-to-date') {
    return (
      <MessageBar intent="success">
        <MessageBarBody>Whiphand is up to date.</MessageBarBody>
        <MessageBarActions
          containerAction={
            <Button
              appearance="transparent"
              icon={<Dismiss20Regular />}
              onClick={() => setPhase({ kind: 'unchecked' })}
            />
          }
        />
      </MessageBar>
    );
  }

  if (phase.kind === 'error') {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Could not check for updates</MessageBarTitle>
          {phase.message}
        </MessageBarBody>
        <MessageBarActions
          containerAction={
            <Button
              appearance="transparent"
              icon={<Dismiss20Regular />}
              onClick={() => setPhase({ kind: 'unchecked' })}
            />
          }
        >
          <Button size="small" onClick={() => runCheck(true)}>Retry</Button>
        </MessageBarActions>
      </MessageBar>
    );
  }

  if (phase.kind === 'installing') {
    return (
      <MessageBar intent="info">
        <MessageBarBody>Installing the update — Whiphand will restart shortly.</MessageBarBody>
      </MessageBar>
    );
  }

  if (phase.kind !== 'available') return null;
  if (dismissedVersion === phase.update.version) return null;

  const canInstall = phase.installKind === 'appimage' || phase.installKind === 'nsis';
  const onInstall = (): void => {
    setPhase({ kind: 'installing' });
    void phase.update.install().catch(error => {
      setPhase({ kind: 'error', message: errorMessage(error) });
    });
  };

  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>Update available</MessageBarTitle>
        Whiphand {phase.update.version} is available.
        {canInstall && hasActiveRun && ' Installing will wait until the current run finishes.'}
      </MessageBarBody>
      <MessageBarActions
        containerAction={
          <Button
            appearance="transparent"
            icon={<Dismiss20Regular />}
            onClick={() => setDismissedVersion(phase.update.version)}
          />
        }
      >
        {canInstall ? (
          <Button size="small" appearance="primary" disabled={hasActiveRun} onClick={onInstall}>
            Install and restart
          </Button>
        ) : (
          <Button size="small" onClick={() => void updater.openReleasePage()}>Open release page</Button>
        )}
      </MessageBarActions>
    </MessageBar>
  );
}
