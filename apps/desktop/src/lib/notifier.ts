/** F6: native notification seam. Tests inject a spy; production uses the Tauri plugin. */
export type Notifier = (title: string, body: string) => void;

export const noopNotifier: Notifier = () => {};

export function createTauriNotifier(): Notifier {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return noopNotifier;
  let permitted: boolean | null = null;
  return (title, body) => {
    void (async () => {
      const api = await import('@tauri-apps/plugin-notification');
      if (permitted === null) {
        permitted = await api.isPermissionGranted();
        if (!permitted) permitted = (await api.requestPermission()) === 'granted';
      }
      if (permitted) api.sendNotification({ title, body });
    })().catch(() => {});
  };
}
