/** F6: native notification seam. Tests inject a spy; production uses the desktop shell's `notify` command. */
export type Notifier = (title: string, body: string, jobId?: string) => void;

export const noopNotifier: Notifier = () => {};

export function createTauriNotifier(): Notifier {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return noopNotifier;
  return (title, body, jobId) => {
    void (async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('notify', { title, body, jobId });
    })().catch(() => {});
  };
}

/** Subscribes to clicks on a notification; the callback gets the id of the job that sent it. Returns the unsubscribe. */
export type NotificationClicks = (onClick: (jobId: string) => void) => () => void;

export const noopNotificationClicks: NotificationClicks = () => () => {};

/** The desktop shell emits `notification-clicked { jobId }` after raising the window. */
export function createTauriNotificationClicks(): NotificationClicks {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return noopNotificationClicks;
  return onClick => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const detach = await listen<{ jobId?: string }>('notification-clicked', event => {
        const jobId = event.payload?.jobId;
        if (typeof jobId === 'string') onClick(jobId);
      });
      // Unsubscribed while listen() was still resolving: detach straight away.
      if (cancelled) detach();
      else unlisten = detach;
    })().catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
      unlisten = undefined;
    };
  };
}
