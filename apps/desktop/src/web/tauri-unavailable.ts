/**
 * Stand-in for the Tauri modules in the web bundle, substituted by
 * vite.web.config.ts for files that dynamic-import `@tauri-apps/*` behind a
 * runtime guard. Every export throws, so a weakened guard fails loudly.
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
