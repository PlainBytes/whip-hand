/**
 * Object URLs for the thumbnails of pasted images, by stash path. Session-only:
 * a draft restored after a restart has none, and its chip loads the stashed
 * file instead. Kept out of the draft so the draft stays plain, persistable data.
 */
const urls = new Map<string, string>();

export function thumbnailFor(path: string): string | undefined {
  return urls.get(path);
}

export function rememberThumbnail(path: string, url: string): void {
  const previous = urls.get(path);
  if (previous !== undefined && previous !== url) URL.revokeObjectURL(previous);
  urls.set(path, url);
}

export function releaseThumbnail(path: string): void {
  const url = urls.get(path);
  if (url === undefined) return;
  urls.delete(path);
  URL.revokeObjectURL(url);
}
