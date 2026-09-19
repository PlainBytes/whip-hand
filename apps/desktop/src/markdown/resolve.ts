/**
 * What a relative link or image in a markdown document is allowed to point at.
 *
 * Pure on purpose: these are the rules that decide whether a document can
 * reach a file, and they should be testable without mounting anything.
 */
import { joinPath, separatorOf } from '../files/tree-model.ts';
import { isImagePath } from '../files/file-kind.ts';
import type { DocResolution } from './types.ts';
import { contains, isWindowsAbsolute } from '../../../../packages/core/src/path-form.ts';

const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A single ASCII letter, `:`, then a separator is a Windows drive path, not a
 * URL whose scheme is that letter. Two or more letters (`http:`, `file:`) never
 * match, and neither does `C:foo` (drive-relative, not something we emit).
 */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * True for anything carrying a scheme — those go to the system browser. Not a
 * Windows-absolute path: `C:/docs/plan.md` used to parse as scheme `c`, so an
 * absolute image or link in an artifact went to the browser and rendered broken
 * under the app's CSP. whiphand stops *emitting* such paths, but user-authored
 * markdown still contains them; they route to the file port instead.
 */
export function isExternal(target: string): boolean {
  return EXTERNAL_SCHEME.test(target) && !WINDOWS_DRIVE_PATH.test(target);
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
  // A Windows-absolute target is a whole path already; it is not joined under
  // anything, and it goes through the same containment check as the rest.
  const absolute = isWindowsAbsolute(cleaned)
    ? cleaned
    : startsAtRoot
      ? joinPath(root, cleaned.replace(/^[\\/]+/, ''))
      : joinPath(baseDir, cleaned);
  const path = normalize(absolute, sep);

  // The pure comparator (invariant 4): case-folded and separator-blind on a
  // Windows-shaped path, so `c:\proj` is inside `C:\Proj`; lexical, so it works
  // on a path that does not exist and cannot fail open.
  if (!contains(root, path)) return null;

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
