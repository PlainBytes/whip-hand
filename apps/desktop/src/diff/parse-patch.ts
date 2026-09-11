/**
 * One file's unified patch into rows a side-by-side view can draw.
 *
 * Pure and React-free on purpose: this is the logic worth testing. Core hands
 * over the patch text verbatim (packages/core/src/engine/diff.ts) and stops
 * there — deciding what a *row* is belongs to the thing that draws rows.
 */

export type LineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: LineKind;
  /** Prefix stripped, no trailing newline, and no `\r` — see `crlf`. */
  text: string;
  /** 1-based, and absent on the side where the line does not exist. */
  oldLine?: number;
  newLine?: number;
  /** This line carried the `\ No newline at end of file` marker. */
  noNewline?: boolean;
  /** The source line ended `\r\n`. Kept out of `text`, which would misalign. */
  crlf?: boolean;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  /** Whatever followed the closing `@@` — usually the enclosing function. */
  heading: string;
  lines: DiffLine[];
}

export type Row =
  /** The `@@` separator itself, drawn full width. */
  | { kind: 'hunk'; heading: string; oldStart: number; newStart: number }
  | { kind: 'context'; left: DiffLine; right: DiffLine }
  | { kind: 'change'; left?: DiffLine; right?: DiffLine };

export interface ParsedPatch {
  hunks: Hunk[];
  /**
   * A combined diff (`@@@`), which this parser cannot read. Set rather than
   * guessed: parsed as an ordinary hunk, every line silently loses its first
   * *content* character and the result looks entirely plausible. A review
   * after a failed merge is not hypothetical.
   */
  unsupported?: 'combined';
}

/**
 * Capture the heading greedily to end of line: the enclosing-function text
 * after the closing `@@` may itself contain `@@`, so splitting on the marker
 * is wrong. Counts are optional — `@@ -1 +1 @@` is legal and means 1.
 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Strip exactly one trailing `\r`, reporting whether there was one. */
function stripCr(line: string): { text: string; crlf: boolean } {
  return line.endsWith('\r')
    ? { text: line.slice(0, -1), crlf: true }
    : { text: line, crlf: false };
}

export function parsePatch(patch: string): ParsedPatch {
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split('\n')) {
    const { text: line, crlf } = stripCr(raw);

    if (line.startsWith('@@@')) return { hunks: [], unsupported: 'combined' };

    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number.parseInt(header[1], 10);
      newLine = Number.parseInt(header[3], 10);
      hunk = { oldStart: oldLine, newStart: newLine, heading: header[5] ?? '', lines: [] };
      hunks.push(hunk);
      continue;
    }

    // Everything before the first @@ is header noise: `index`, `--- a/x`,
    // `+++ b/x`, `similarity index`, `Binary files … differ`, mode lines.
    if (hunk === undefined) continue;

    if (line.startsWith('\\')) {
      // `\ No newline at end of file` qualifies the line just emitted, and can
      // appear twice in one hunk — once per side. Attaching it to the last
      // line emitted gets both right.
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }

    const prefix = line[0];
    const text = line.slice(1);
    if (prefix === '+') {
      hunk.lines.push({ kind: 'add', text, newLine: newLine++, ...(crlf ? { crlf } : {}) });
    } else if (prefix === '-') {
      hunk.lines.push({ kind: 'del', text, oldLine: oldLine++, ...(crlf ? { crlf } : {}) });
    } else if (prefix === ' ') {
      hunk.lines.push({
        kind: 'context', text, oldLine: oldLine++, newLine: newLine++, ...(crlf ? { crlf } : {}),
      });
    }
    // Anything else (a stray blank line at the end of the patch) is not a
    // content line and carries no position, so it is dropped rather than
    // guessed at.
  }

  return { hunks };
}

/**
 * Hunks into side-by-side rows.
 *
 * A run of consecutive deletions is zipped against the run of additions that
 * follows it, so an edited line sits opposite its replacement. Where the runs
 * are uneven the shorter side is simply absent, which is how a pure insertion
 * or deletion should read. Context lines are their own 1:1 rows and flush any
 * pending run.
 *
 * Git always emits every `-` before every `+` within a change block, so the
 * add→del flush below is defensive rather than load-bearing — but a patch from
 * elsewhere could interleave, and the rule costs one line.
 */
export function toRows(parsed: ParsedPatch): Row[] {
  const rows: Row[] = [];

  for (const hunk of parsed.hunks) {
    rows.push({
      kind: 'hunk', heading: hunk.heading, oldStart: hunk.oldStart, newStart: hunk.newStart,
    });

    let dels: DiffLine[] = [];
    let adds: DiffLine[] = [];
    const flush = (): void => {
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
        rows.push({
          kind: 'change',
          ...(dels[i] ? { left: dels[i] } : {}),
          ...(adds[i] ? { right: adds[i] } : {}),
        });
      }
      dels = [];
      adds = [];
    };

    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        flush();
        rows.push({ kind: 'context', left: line, right: line });
      } else if (line.kind === 'del') {
        if (adds.length > 0) flush(); // an add→del transition starts a new block
        dels.push(line);
      } else {
        adds.push(line);
      }
    }
    flush();
  }

  return rows;
}

/** Unified view: one column, in patch order, with both gutters. */
export function toUnifiedRows(parsed: ParsedPatch): Row[] {
  const rows: Row[] = [];
  for (const hunk of parsed.hunks) {
    rows.push({
      kind: 'hunk', heading: hunk.heading, oldStart: hunk.oldStart, newStart: hunk.newStart,
    });
    for (const line of hunk.lines) {
      if (line.kind === 'context') rows.push({ kind: 'context', left: line, right: line });
      else if (line.kind === 'del') rows.push({ kind: 'change', left: line });
      else rows.push({ kind: 'change', right: line });
    }
  }
  return rows;
}

/**
 * True when every changed line differs from its counterpart only by its line
 * ending. Worth calling out on its own: a file converted LF→CRLF reports every
 * line as changed with nothing visibly different, and a reviewer either
 * approves it blind or loses an hour working out why.
 */
export function isLineEndingsOnly(rows: Row[]): boolean {
  let sawChange = false;
  for (const row of rows) {
    if (row.kind !== 'change') continue;
    if (!row.left || !row.right) return false;      // a real insertion or deletion
    if (row.left.text !== row.right.text) return false;
    if (row.left.crlf === row.right.crlf) return false; // identical, so not this case
    sawChange = true;
  }
  return sawChange;
}
