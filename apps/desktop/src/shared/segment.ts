/**
 * The one segment validator (invariant 3), as whiphand-core's segment.rs has
 * it: anything that becomes a file or directory name passes through it. The
 * webview uses it for its New file and Rename inputs; core-goldens.test.ts
 * checks it against core's goldens.
 *
 * It rejects what Windows rejects, on every platform, and it never sanitizes.
 * Rejecting only on Windows would make the Windows user eat an error for
 * someone else's authoring choice; sanitizing would quietly make artifacts
 * differ across platforms. It also rejects *only* what Windows rejects, so the
 * blast radius on existing Linux workflows is exactly the set that was already
 * broken on Windows.
 */

export type SegmentResult = { ok: true } | { ok: false; reason: string };

const OK: SegmentResult = { ok: true };

/** `\ / : * ? " < > |` — what NTFS refuses in a name — plus the C0 control characters. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * Device names Windows resolves in every directory. The check is on the part
 * before the first dot, so `nul.txt` and `nul.tar.gz` are the NUL device too.
 */
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function fail(reason: string): SegmentResult {
  return { ok: false, reason };
}

function show(name: string): string {
  return JSON.stringify(name);
}

/** Validates one path segment — a file or directory name, never a path. */
export function validateSegment(name: string): SegmentResult {
  if (name === '') return fail('is empty');
  const illegal = ILLEGAL_CHARS.exec(name);
  if (illegal !== null) {
    const ch = illegal[0];
    const shown = ch.charCodeAt(0) < 0x20 ? `control character U+${ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}` : `'${ch}'`;
    return fail(`contains ${shown}, which Windows does not allow in a file name`);
  }
  if (name.endsWith('.') || name.endsWith(' ')) {
    return fail(`ends with a ${name.endsWith('.') ? 'dot' : 'space'}, which Windows silently strips`);
  }
  // Trailing spaces before the extension are stripped by Windows too (`nul .txt` is NUL).
  const stem = name.split('.')[0].replace(/ +$/, '');
  if (RESERVED_DEVICE.test(stem)) {
    return fail(`'${stem}' is a reserved device name on Windows`);
  }
  return OK;
}

/** True when `name` is a legal segment. */
export function isValidSegment(name: string): boolean {
  return validateSegment(name).ok;
}

/** Throws with `label` and the reason; for callers that have no better error type. */
export function assertSegment(name: string, label: string): void {
  const result = validateSegment(name);
  if (!result.ok) throw new Error(`invalid ${label} ${show(name)}: ${result.reason}`);
}

/**
 * Validates a relative path made of `/`-separated segments — a step `output`
 * like `reports/plan.md`. Subdirectories are fine; `..`, an absolute path, a
 * backslash and an empty or `.` segment are not, and every segment goes
 * through `validateSegment`.
 */
export function validateRelativePath(p: string): SegmentResult {
  if (p === '') return fail('is empty');
  if (p.includes('\\')) return fail("contains '\\'; write paths with '/'");
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return fail('is an absolute path; it must be relative');
  for (const segment of p.split('/')) {
    if (segment === '') return fail('has an empty path segment');
    if (segment === '.') return fail("has a '.' path segment");
    if (segment === '..') return fail("has a '..' path segment, which would escape the run directory");
    const result = validateSegment(segment);
    if (!result.ok) return fail(`segment ${show(segment)} ${result.reason}`);
  }
  return OK;
}
