import { describe, expect, it } from 'vitest';
import {
  isLineEndingsOnly, parsePatch, toRows, toUnifiedRows, type Row,
} from './parse-patch.ts';

/** A patch as core hands it over: header noise, then hunks. */
function patch(...body: string[]): string {
  return ['diff --git a/x.ts b/x.ts', 'index 111..222 100644', '--- a/x.ts', '+++ b/x.ts', ...body].join('\n');
}

const changes = (rows: Row[]): Row[] => rows.filter(r => r.kind === 'change');

describe('parsePatch', () => {
  it('numbers both sides through a single hunk', () => {
    const { hunks } = parsePatch(patch('@@ -10,3 +10,3 @@', ' a', '-b', '+B', ' c'));
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      { kind: 'context', text: 'a', oldLine: 10, newLine: 10 },
      { kind: 'del', text: 'b', oldLine: 11 },
      { kind: 'add', text: 'B', newLine: 11 },
      { kind: 'context', text: 'c', oldLine: 12, newLine: 12 },
    ]);
  });

  it('treats a header with no counts as a single line', () => {
    const { hunks } = parsePatch(patch('@@ -1 +1 @@', '-a', '+b'));
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].newStart).toBe(1);
  });

  it('captures a heading that itself contains @@', () => {
    // Splitting on '@@' instead of capturing to end of line would truncate this.
    const { hunks } = parsePatch(patch('@@ -1,1 +1,1 @@ fn foo() { /* @@ */', '-a', '+b'));
    expect(hunks[0].heading).toBe('fn foo() { /* @@ */');
  });

  it('restarts numbering at each hunk header', () => {
    const { hunks } = parsePatch(patch(
      '@@ -1,1 +1,1 @@', '-a', '+A',
      '@@ -50,1 +50,1 @@', '-b', '+B',
    ));
    expect(hunks).toHaveLength(2);
    expect(hunks[1].lines[0].oldLine).toBe(50);
    expect(hunks[1].lines[1].newLine).toBe(50);
  });

  it('attaches "no newline" to the preceding line on each side', () => {
    const { hunks } = parsePatch(patch(
      '@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b', '\\ No newline at end of file',
    ));
    expect(hunks[0].lines[0]).toMatchObject({ kind: 'del', noNewline: true });
    expect(hunks[0].lines[1]).toMatchObject({ kind: 'add', noNewline: true });
  });

  it('keeps a carriage return out of the text but records it', () => {
    const { hunks } = parsePatch(patch('@@ -1 +1 @@', '-a\r', '+a'));
    expect(hunks[0].lines[0]).toMatchObject({ text: 'a', crlf: true });
    expect(hunks[0].lines[1].crlf).toBeUndefined();
  });

  it('returns no hunks for a patch with no textual change', () => {
    // A mode change or a pure rename: real output, and it must not throw.
    const parsed = parsePatch([
      'diff --git a/x.ts b/x.ts', 'old mode 100644', 'new mode 100755',
    ].join('\n'));
    expect(parsed.hunks).toEqual([]);
    expect(parsed.unsupported).toBeUndefined();
  });

  it('refuses a combined diff rather than misreading it', () => {
    // Parsed as ordinary hunks every line would silently lose a content
    // character and still look plausible.
    const parsed = parsePatch(patch('@@@ -1,1 -1,1 +1,1 @@@', '- a', ' +b'));
    expect(parsed.unsupported).toBe('combined');
    expect(parsed.hunks).toEqual([]);
  });

  it('ignores everything before the first hunk header', () => {
    const { hunks } = parsePatch(patch(
      'similarity index 80%', 'rename from y.ts', 'rename to x.ts', '@@ -1 +1 @@', '+a',
    ));
    expect(hunks[0].lines).toHaveLength(1);
  });
});

describe('toRows (side by side)', () => {
  it('pairs an edited line opposite its replacement', () => {
    const rows = changes(toRows(parsePatch(patch('@@ -1,1 +1,1 @@', '-old', '+new'))));
    expect(rows).toEqual([
      { kind: 'change', left: { kind: 'del', text: 'old', oldLine: 1 }, right: { kind: 'add', text: 'new', newLine: 1 } },
    ]);
  });

  it('leaves the right side empty when deletions outnumber additions', () => {
    const rows = changes(toRows(parsePatch(patch('@@ -1,3 +1,1 @@', '-a', '-b', '-c', '+A'))));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ left: { text: 'a' }, right: { text: 'A' } });
    expect((rows[1] as { right?: unknown }).right).toBeUndefined();
    expect((rows[2] as { right?: unknown }).right).toBeUndefined();
  });

  it('leaves the left side empty when additions outnumber deletions', () => {
    const rows = changes(toRows(parsePatch(patch('@@ -1,1 +1,3 @@', '-a', '+A', '+B', '+C'))));
    expect(rows).toHaveLength(3);
    expect((rows[1] as { left?: unknown }).left).toBeUndefined();
    expect((rows[2] as { left?: unknown }).left).toBeUndefined();
  });

  it('gives a pure insertion no left side at all', () => {
    const rows = changes(toRows(parsePatch(patch('@@ -0,0 +1,2 @@', '+a', '+b'))));
    expect(rows).toHaveLength(2);
    expect(rows.every(r => (r as { left?: unknown }).left === undefined)).toBe(true);
  });

  it('does not pair across a context line', () => {
    // The deletion and the addition are separate edits; pairing them would
    // claim one became the other.
    const rows = changes(toRows(parsePatch(patch('@@ -1,3 +1,3 @@', '-a', ' keep', '+b'))));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ left: { text: 'a' } });
    expect((rows[0] as { right?: unknown }).right).toBeUndefined();
    expect(rows[1]).toMatchObject({ right: { text: 'b' } });
  });

  it('starts a new block when an addition is followed by a deletion', () => {
    const rows = changes(toRows(parsePatch(patch('@@ -1,2 +1,2 @@', '-a', '+A', '-b', '+B'))));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ left: { text: 'a' }, right: { text: 'A' } });
    expect(rows[1]).toMatchObject({ left: { text: 'b' }, right: { text: 'B' } });
  });

  it('emits a hunk row per hunk so the separator lives in the same grid', () => {
    const rows = toRows(parsePatch(patch('@@ -1,1 +1,1 @@ ctx', '-a', '+b')));
    expect(rows[0]).toEqual({ kind: 'hunk', heading: 'ctx', oldStart: 1, newStart: 1 });
  });
});

describe('toUnifiedRows', () => {
  it('keeps patch order with one line per row', () => {
    const rows = toUnifiedRows(parsePatch(patch('@@ -1,2 +1,2 @@', ' a', '-b', '+B')));
    expect(rows.map(r => r.kind)).toEqual(['hunk', 'context', 'change', 'change']);
    expect((rows[2] as { left?: { text: string } }).left?.text).toBe('b');
    expect((rows[3] as { right?: { text: string } }).right?.text).toBe('B');
  });
});

describe('isLineEndingsOnly', () => {
  it('recognises a file that only changed its line endings', () => {
    const rows = toRows(parsePatch(patch('@@ -1,2 +1,2 @@', '-a\r', '-b\r', '+a', '+b')));
    expect(isLineEndingsOnly(rows)).toBe(true);
  });

  it('is false when any line really changed', () => {
    const rows = toRows(parsePatch(patch('@@ -1,2 +1,2 @@', '-a\r', '-b\r', '+a', '+B')));
    expect(isLineEndingsOnly(rows)).toBe(false);
  });

  it('is false for a patch with no changes at all', () => {
    expect(isLineEndingsOnly(toRows(parsePatch(patch('@@ -1,1 +1,1 @@', ' a'))))).toBe(false);
  });
});
