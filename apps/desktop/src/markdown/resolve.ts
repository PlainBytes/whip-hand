/**
 * What a relative link or image in a markdown document is allowed to point at.
 *
 * Pure on purpose: these are the rules that decide whether a document can
 * reach a file, and they should be testable without mounting anything.
 */
import { joinPath, separatorOf } from '../files/tree-model.ts';
import { isImagePath } from '../files/file-kind.ts';
import type { DocResolution } from './types.ts';

const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** True for anything carrying a scheme — those go to the system browser. */
export function isExternal(target: string): boolean {
  return EXTERNAL_SCHEME.test(target);
}

/**
 * Image by the same extension rule the Files preview uses, so a link the
 * document renders inline is exactly one the preview would render as an
 * image — including the dotfile rule: `.png` is a file with no extension.
 */
function kindOf(path: string): 'link' | 'image' {
  return isImagePath(path) ? 'image' : 'link';
}

/** Strips the query and fragment, and undoes percent-encoding. */
function cleanTarget(target: string): string {
  const withoutHash = target.split('#')[0].split('?')[0];
  try {
    return decodeURIComponent(withoutHash);
  } catch {
    // A stray '%' that isn't an escape — take it literally rather than throwing.
    return withoutHash;
  }
}

/**
 * Applies `.` and `..` segments textually. The result never contains a `..`,
 * which matters: TauriFileSystem.assertNoParentTraversal rejects any path that
 * does, so an unnormalized path would be refused by the port rather than
 * resolved.
 */
function normalize(path: string, sep: string): string {
  const [head, ...rest] = path.split(/[\\/]/);
  const out: string[] = [head];
  for (const segment of rest) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join(sep);
}

/**
 * Resolves against the open document's directory, refusing anything outside
 * the workspace. A leading '/' means the workspace root, not the disk root —
 * that is what an author writing `/docs/plan.md` in a repo means.
 */
export function resolveInWorkspace(baseDir: string, root: string, target: string): DocResolution | null {
  if (target.startsWith('#')) return null;
  const cleaned = cleanTarget(target);
  if (cleaned === '') return null;

  const sep = separatorOf(root);
  const startsAtRoot = cleaned.startsWith('/') || cleaned.startsWith('\\');
  const absolute = startsAtRoot
    ? joinPath(root, cleaned.replace(/^[\\/]+/, ''))
    : joinPath(baseDir, cleaned);
  const path = normalize(absolute, sep);

  const normalizedRoot = normalize(root, sep);
  if (path !== normalizedRoot && !path.startsWith(normalizedRoot + sep)) return null;

  return { path, kind: kindOf(path) };
}

/**
 * Resolves against a run's manifest by name. Anything that is not an artifact
 * of this run is refused — the same boundary ArtifactFileSystem.nameFor
 * enforces by throwing, surfaced here so the UI can render it as inert text.
 */
export function resolveInArtifacts(
  artifacts: ReadonlyArray<{ name: string; path: string }>,
  target: string,
): DocResolution | null {
  if (target.startsWith('#')) return null;
  const cleaned = cleanTarget(target).replace(/^\.\//, '');
  const artifact = artifacts.find(a => a.name === cleaned || a.path === cleaned);
  if (!artifact) return null;
  return { path: artifact.path, kind: kindOf(artifact.path) };
}
