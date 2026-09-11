/**
 * The desktop host's capabilities. Imported only from main.tsx, and the Tauri
 * modules are pulled in DYNAMICALLY so that neither the web bundle nor the
 * vitest graph ever resolves `@tauri-apps/plugin-dialog` or
 * `@tauri-apps/api/webview` — which is what let WelcomePage and
 * WorkspaceSwitcher stop importing them at module scope.
 */
import { DESKTOP_DEFAULT_CAPABILITIES, type AppCapabilities } from '../capabilities.tsx';

export const tauriCapabilities: AppCapabilities = {
  ...DESKTOP_DEFAULT_CAPABILITIES,
  pickDirectory: async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true });
    return typeof picked === 'string' ? picked : null;
  },
  // Needs dialog:allow-open in src-tauri/capabilities/default.json, already
  // granted for pickDirectory. `multiple: true` is typed string[] | null, but
  // a lone string is normalized too rather than trusted never to arrive.
  pickFiles: async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple: true });
    if (picked === null) return [];
    return typeof picked === 'string' ? [picked] : picked;
  },
  // The webview's native drag-drop listener, because an HTML drop event never
  // exposes a file's path — and a path is what the agent copies from. Needs
  // tauri.conf.json to leave `dragDropEnabled` at its default (on); listening
  // is covered by core:default.
  onFileDrop: async handler => {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    return getCurrentWebview().onDragDropEvent(event => {
      const payload = event.payload;
      handler(payload.type === 'drop' ? { type: 'drop', paths: payload.paths } : { type: payload.type });
    });
  },
};
