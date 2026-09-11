/**
 * Provides the one FileSystemPort instance to the Files page, mirroring
 * agent-context.tsx: production (main.tsx) supplies TauriFileSystem, tests
 * supply FakeFileSystem, and no component constructs either itself.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { FileSystemPort } from './fs-port.ts';

const FileSystemContext = createContext<FileSystemPort | null>(null);

export function FileSystemProvider({ fs, children }: { fs: FileSystemPort; children: ReactNode }) {
  return <FileSystemContext.Provider value={fs}>{children}</FileSystemContext.Provider>;
}

export function useFileSystem(): FileSystemPort {
  const fs = useContext(FileSystemContext);
  if (!fs) throw new Error('useFileSystem() must be used within a FileSystemProvider');
  return fs;
}
