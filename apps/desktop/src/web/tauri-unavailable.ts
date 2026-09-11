/**
 * Stand-in for the Tauri modules in the web bundle.
 *
 * Three files — lib/notifier.ts, lib/window-state.ts and lib/updater.ts —
 * reach for `@tauri-apps/*` through a DYNAMIC import guarded at runtime by
 * `__TAURI_INTERNALS__`, so none of them ever executes in a browser. The
 * runtime guard does not help the bundler, though: rolldown still has to
 * resolve the specifier to build the chunk. This module is what it resolves
 * to, and vite.web.config.ts substitutes it only for those three importers —
 * any NEW Tauri import still fails the build.
 *
 * Every export throws rather than silently returning undefined. Nothing here
 * should ever run; if one of the runtime guards is ever weakened, a thrown
 * error naming this file is a far better outcome than a mysterious no-op.
 */
function unavailable(name: string): never {
  throw new Error(`${name}() is a desktop-only Tauri API and is not available in the browser`);
}

// @tauri-apps/plugin-notification
export const isPermissionGranted = (): never => unavailable('isPermissionGranted');
export const requestPermission = (): never => unavailable('requestPermission');
export const sendNotification = (): never => unavailable('sendNotification');

// @tauri-apps/api/window
export const getCurrentWindow = (): never => unavailable('getCurrentWindow');
export const PhysicalPosition = function PhysicalPosition(): never {
  return unavailable('PhysicalPosition');
} as unknown as new (x: number, y: number) => never;
export const PhysicalSize = function PhysicalSize(): never {
  return unavailable('PhysicalSize');
} as unknown as new (w: number, h: number) => never;

// @tauri-apps/api/core
export const invoke = (): never => unavailable('invoke');

// @tauri-apps/plugin-updater
export const check = (): never => unavailable('check');

// @tauri-apps/plugin-process
export const relaunch = (): never => unavailable('relaunch');

// @tauri-apps/plugin-shell
export const open = (): never => unavailable('open');
