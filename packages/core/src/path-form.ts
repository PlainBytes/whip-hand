/**
 * One path representation (invariant 2), one pure comparator (invariant 4,
 * containment half) and the one POSIX quoting helper (invariant 8).
 *
 * Every path whiphand *emits* is workspace-relative with `/`. Where no relative
 * form exists — another drive, a resolved binary, a home-rooted settings path —
 * the single fallback is an absolute path with `/` (`C:/Program Files/Git/bin/sh.exe`).
 * A native absolute form exists only at the moment a path is handed to the OS.
 * The relative form gives MSYS path mangling nothing to mangle, which is what
 * makes running everything through one POSIX shell safe.
 *
 * Node-free on purpose (`node:path` is not available to the desktop webview,
 * which bundles this module): everything here is string logic, and the
 * Windows rules apply to any path that *looks* like a Windows path, so the
 * whole module is exercised on Linux.
 */

/** Workspace-relative, `/`-separated. The form prompts, guidance, event payloads and the UI use. */
export type WsPath = string & { readonly __brand: 'WsPath' };
/** Run-directory-relative, `/`-separated. The form `run.json` stores on disk. */
export type RunPath = string & { readonly __brand: 'RunPath' };
/** Absolute, `/`-separated. The single fallback when no relative form exists. */
export type FwdAbsPath = string & { readonly __brand: 'FwdAbsPath' };

export interface PathOpts {
  /** Defaults to the host. Only decides case folding and separators for paths that do not look Windows-shaped. */
  platform?: string;
}

function hostPlatform(): string {
  return typeof process !== 'undefined' && typeof process.platform === 'string' ? process.platform : 'linux';
}

const DRIVE_ABS = /^[A-Za-z]:[\\/]/;
const DRIVE_ONLY = /^[A-Za-z]:$/;
const UNC = /^[\\/]{2}(?![?.][\\/])[^\\/]+[\\/]+[^\\/]+/;
const EXTENDED = /^[\\/]{2}[?.][\\/]/;

/** True for `C:\x`, `C:/x`, `\\server\share`, and `\\?\C:\x`. */
export function isWindowsAbsolute(p: string): boolean {
  return DRIVE_ABS.test(p) || DRIVE_ONLY.test(p) || UNC.test(p) || EXTENDED.test(p);
}

/** True for any absolute path on any platform. */
export function isAbsoluteAnyPlatform(p: string): boolean {
  return isWindowsAbsolute(p) || p.startsWith('/');
}

/** A typed UNC path (`\\server\share\…`), which workspaces refuse. `\\?\` and `\\.\` are not UNC. */
export function isUncPath(p: string): boolean {
  return UNC.test(p) && !EXTENDED.test(p);
}

interface Parsed {
  /** Root, case-folded when comparing: `c:`, `//server/share`, `/`, or `` (relative). */
  root: string;
  /** The same root with its original casing, for output. */
  rootText: string;
  /** Segments with the original casing; comparison folds them. */
  segments: string[];
  windows: boolean;
}

/** Lexical parse: unify separators (only for Windows-shaped paths), drop `.`, resolve `..`. Never touches the disk. */
function parse(p: string, opts: PathOpts): Parsed {
  let windows = (opts.platform ?? hostPlatform()) === 'win32' || isWindowsAbsolute(p);
  let text = p;
  if (windows) {
    text = text.replace(/\\/g, '/');
    // `\\?\C:\x` and `\\.\C:\x` name the same file as `C:\x`.
    const extended = /^\/\/[?.]\/(.*)$/.exec(text);
    if (extended !== null) text = extended[1].replace(/^UNC\//i, '//');
  }
  let root = '';
  let rootText = '';
  let rest = text;
  const drive = /^([A-Za-z]:)(?:\/|$)/.exec(text);
  if (drive !== null) {
    root = drive[1].toLowerCase();
    rootText = drive[1];
    rest = text.slice(2);
    windows = true;
  } else if (windows && text.startsWith('//')) {
    const unc = /^\/\/([^/]+)\/+([^/]+)/.exec(text);
    if (unc !== null) {
      root = `//${unc[1].toLowerCase()}/${unc[2].toLowerCase()}`;
      rootText = `//${unc[1]}/${unc[2]}`;
      rest = text.slice(unc[0].length);
    }
  } else if (text.startsWith('/')) {
    root = '/';
    rootText = '/';
  }
  const absolute = root !== '';
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (!absolute) segments.push('..');
      continue;
    }
    segments.push(segment);
  }
  return { root, rootText, segments, windows };
}

function fold(segment: string, windows: boolean): string {
  return windows ? segment.toLowerCase() : segment;
}

/** Lexical resolution to a canonical comparison key. No I/O, so it works on paths that do not exist yet. */
export function pathKey(p: string, opts: PathOpts = {}): string {
  const parsed = parse(p, opts);
  return `${parsed.root}/${parsed.segments.map(s => fold(s, parsed.windows)).join('/')}`;
}

/**
 * Whether two paths name the same place: case-folded when Windows-shaped,
 * separators unified, `.`/`..` resolved lexically. The comparator for
 * *containment* questions; workspace *identity* compares `identityKey`s
 * (canonicalize.ts) with this same function.
 */
export function samePath(a: string, b: string, opts: PathOpts = {}): boolean {
  const windows = (opts.platform ?? hostPlatform()) === 'win32' || isWindowsAbsolute(a) || isWindowsAbsolute(b);
  const mode: PathOpts = { platform: windows ? 'win32' : opts.platform };
  return pathKey(a, mode) === pathKey(b, mode);
}

/** A workspace as state stores it: the path it was opened by, and its `identityKey` when the agent supplied one. */
export interface WorkspaceRef {
  path: string;
  identityKey?: string | undefined;
}

/**
 * Whether two workspaces are the same one. Identity keys are canonicalized once
 * at workspace open (canonicalize.ts), so comparing them sees through 8.3 names,
 * `subst` drives and junctions; a side without a key (state written before keys
 * existed, an agent that predates them) can only be compared by path.
 */
export function sameWorkspace(a: WorkspaceRef, b: WorkspaceRef): boolean {
  if (a.identityKey !== undefined && b.identityKey !== undefined) return a.identityKey === b.identityKey;
  return samePath(a.path, b.path);
}

/** The key of the entry in `records` (keyed by the path each workspace was first seen under) that is `workspace`, if any. */
export function findWorkspaceKey(
  records: Record<string, { identityKey?: string | undefined }>, workspace: WorkspaceRef,
): string | undefined {
  return Object.keys(records).find(key => sameWorkspace({ path: key, identityKey: records[key]?.identityKey }, workspace));
}

/** Whether `child` is `parent` or lies inside it. Pure; cannot fail open when the disk is unreachable. */
export function contains(parent: string, child: string, opts: PathOpts = {}): boolean {
  return relativeWithin(parent, child, opts) !== null;
}

/** The segments of `child` below `parent` (original casing), or null when it is not inside. */
function relativeWithin(parent: string, child: string, opts: PathOpts): string[] | null {
  const windows = (opts.platform ?? hostPlatform()) === 'win32' || isWindowsAbsolute(parent) || isWindowsAbsolute(child);
  const mode: PathOpts = { platform: windows ? 'win32' : opts.platform };
  const p = parse(parent, mode);
  const c = parse(child, mode);
  if (p.root !== c.root) return null;
  if (p.root === '' && (p.segments.includes('..') || c.segments.includes('..'))) return null;
  if (p.segments.length > c.segments.length) return null;
  for (let i = 0; i < p.segments.length; i++) {
    if (fold(p.segments[i], windows) !== fold(c.segments[i], windows)) return null;
  }
  return c.segments.slice(p.segments.length);
}

// ---------------------------------------------------------------------------
// Emit-boundary conversions
// ---------------------------------------------------------------------------

/** Backslashes to `/`, nothing else. What `shellPath` used to be. */
export function toFwd(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Absolute, `/`-separated, with any `\\?\` prefix dropped. The one fallback form. */
export function toFwdAbs(nativeAbs: string): FwdAbsPath {
  const parsed = parse(nativeAbs, {});
  const fwd = toFwd(nativeAbs);
  if (parsed.windows) {
    const stripped = /^\/\/[?.]\/(.*)$/.exec(fwd);
    if (stripped !== null) return stripped[1].replace(/^UNC\//i, '//') as FwdAbsPath;
  }
  return fwd as FwdAbsPath;
}

function relativeOrFallback(nativeAbs: string, base: string): string {
  const inside = relativeWithin(base, nativeAbs, {});
  if (inside === null) return toFwdAbs(nativeAbs);
  return inside.length === 0 ? '.' : inside.join('/');
}

/** `nativeAbs` as workspace-relative `/`-form; the absolute `/` form when it is outside `root` or on another drive. */
export function toWorkspace(nativeAbs: string, root: string): WsPath | FwdAbsPath {
  return relativeOrFallback(nativeAbs, root) as WsPath | FwdAbsPath;
}

/** `nativeAbs` as run-dir-relative `/`-form, with the same absolute fallback. */
export function toRunRel(nativeAbs: string, runDir: string): RunPath | FwdAbsPath {
  return relativeOrFallback(nativeAbs, runDir) as RunPath | FwdAbsPath;
}

/**
 * The single moment a path becomes native: a relative `/`-form is resolved
 * against `base` (itself native), an absolute one is just re-separated.
 */
export function toNative(p: string, base: string, opts: PathOpts = {}): string {
  const windows = (opts.platform ?? hostPlatform()) === 'win32' || isWindowsAbsolute(base) || isWindowsAbsolute(p);
  const sep = windows ? '\\' : '/';
  const joined = isAbsoluteAnyPlatform(p) ? p : `${toFwd(base).replace(/\/+$/, '')}/${p}`;
  const parsed = parse(joined, { platform: windows ? 'win32' : opts.platform });
  const tail = parsed.segments.join(sep);
  if (parsed.root === '') return tail;
  if (parsed.root === '/') return `/${tail}`.replace(/\//g, sep);
  return tail === '' ? `${parsed.rootText}${sep}` : `${parsed.rootText}${sep}${tail}`;
}

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

/**
 * POSIX single-quoting: the only place quoting exists (invariant 8). Its
 * callers are strings *we* generate — the claude hook commands and permission
 * rule, `touch <marker>` in interactive guidance. A user's `run:` line never
 * passes through here; it references variables instead (template.ts).
 */
export function shQuote(value: string): string {
  if (value.includes('\0')) throw new Error('cannot quote a value containing a NUL character for a shell');
  // A value made only of characters no shell treats specially is left as it is,
  // so an ordinary path stays byte-identical to the unquoted form a runner's
  // permission rule was verified against; anything else is single-quoted.
  if (SAFE_UNQUOTED.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SAFE_UNQUOTED = /^[A-Za-z0-9_@%+=:,./-]+$/;
