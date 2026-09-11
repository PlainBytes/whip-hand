/**
 * The root FileSystemPort in a browser, where there is no local filesystem.
 *
 * Every method throws, and none of them should ever be called: the only
 * consumer of the ROOT port is the Files page, which nav.ts filters out of the
 * sidebar and PageContent refuses to render when `localFiles` is false. This
 * exists so `useFileSystem()`'s "must be used within a FileSystemProvider"
 * invariant holds without every caller learning about a null case.
 *
 * Note this does NOT affect run artifacts: RunDetailPage provides its own
 * ArtifactFileSystem (files/artifact-fs.ts), which is pure RPC and works over
 * the network unchanged.
 */
import type { FileStat, FileSystemPort } from './fs-port.ts';
import type { DirEntry } from './tree-model.ts';

const MESSAGE = 'The local filesystem is only available in the desktop app.';

function unavailable(): never {
  throw new Error(MESSAGE);
}

export class UnavailableFileSystem implements FileSystemPort {
  async ensureGranted(): Promise<void> { unavailable(); }
  async readDir(): Promise<DirEntry[]> { unavailable(); }
  async readFile(): Promise<Uint8Array> { unavailable(); }
  async writeTextFile(): Promise<void> { unavailable(); }
  async stat(): Promise<FileStat> { unavailable(); }
  async exists(): Promise<boolean> { unavailable(); }
  async mkdir(): Promise<void> { unavailable(); }
  async rename(): Promise<void> { unavailable(); }
  async remove(): Promise<void> { unavailable(); }
  async watch(): Promise<() => void> { unavailable(); }
  async watchFile(): Promise<() => void> { unavailable(); }
}
