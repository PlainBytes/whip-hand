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
