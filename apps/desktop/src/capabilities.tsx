import { createContext, useContext, type ReactNode } from 'react';

/**
 * What this host can do that the other cannot.
 *
 * The same React tree runs in two places: the Tauri desktop shell, and a plain
 * browser on another machine talking to the agent over a WebSocket. Almost
 * everything is identical, because the UI already talks only to the agent's
 * RPC — but a browser has no native folder picker and no access to the local
 * filesystem.
 *
 * ONE MECHANISM, NOT TWO. A capability is a function whose ABSENCE is the flag.
 * Carrying both a `pickDirectory` and a separate `canPickDirectory` boolean is
 * precisely how the two drift apart, and the drift is silent.
 *
 * The default is the DESKTOP shape rather than the restrictive one, so every
 * existing test renders unchanged; only the web entry point overrides it.
 */
export interface AppCapabilities {
  readonly host: 'desktop' | 'browser';
  /**
   * Opens a native folder picker. Undefined in a browser, where the UI hides
   * the affordance instead of offering one that cannot work.
   */
  readonly pickDirectory?: () => Promise<string | null>;
  /**
   * Opens a native multi-file picker and resolves to the chosen absolute
   * paths — empty when cancelled. Undefined in a browser: a path on the
   * browser's machine means nothing to the agent, which is why the New Run
   * dialog renders no attach field at all without it.
   */
  readonly pickFiles?: () => Promise<string[]>;
  /**
   * Subscribes to files dragged over and dropped on the window, with their
   * real paths — something a webview's own drop event never exposes. Resolves
   * to the unsubscribe function. Undefined in a browser, for the same reason
   * as pickFiles.
   */
  readonly onFileDrop?: (handler: (event: FileDropEvent) => void) => Promise<() => void>;
  /** Whether the local filesystem — and therefore the Files page — is reachable. */
  readonly localFiles: boolean;
}

/**
 * Files moving over the window: `enter`/`over` while they hover, `leave` when
 * the drag is abandoned or leaves the window, and `drop` with their paths.
 */
export type FileDropEvent =
  | { readonly type: 'enter' | 'over' | 'leave' }
  | { readonly type: 'drop'; readonly paths: readonly string[] };

export const DESKTOP_DEFAULT_CAPABILITIES: AppCapabilities = { host: 'desktop', localFiles: true };

const CapabilitiesContext = createContext<AppCapabilities>(DESKTOP_DEFAULT_CAPABILITIES);

export function CapabilitiesProvider(
  { value, children }: { value: AppCapabilities; children: ReactNode },
) {
  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}

export function useCapabilities(): AppCapabilities {
  return useContext(CapabilitiesContext);
}
