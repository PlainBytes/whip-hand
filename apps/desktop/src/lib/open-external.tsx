/**
 * How the app hands an http(s) target to the system browser.
 *
 * A context rather than a prop because the pages that render documents
 * (FilesPage, RunDetailPage, ManualStepCard) are several levels below
 * App.tsx, and threading an `openExternal` prop through every one of them
 * would put a Tauri concern in the signature of components that have no
 * other reason to know about it. main.tsx supplies the real implementation;
 * everything else — tests, non-Tauri renders — gets the no-op default.
 */
import { createContext, useContext, type ReactNode } from 'react';

/** No-op by default so tests and non-Tauri renders need no provider. */
const OpenExternalContext = createContext<(url: string) => void>(() => {});

export function OpenExternalProvider(
  { open, children }: { open: (url: string) => void; children: ReactNode },
) {
  return <OpenExternalContext.Provider value={open}>{children}</OpenExternalContext.Provider>;
}

export function useOpenExternal(): (url: string) => void {
  return useContext(OpenExternalContext);
}
