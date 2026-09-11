/**
 * One file's changes, side by side or unified.
 *
 * The whole file is a *single* CSS grid — not one grid per hunk, and not a row
 * of paired divs. That is what makes the two sides share row boundaries by
 * construction: the taller cell in a row sets that row's height and the
 * shorter is padded, so a wrapped line can never make the columns drift. There
 * is nothing to measure and nothing to keep in sync.
 *
 * Lines wrap rather than scroll, which is the same answer CodeEditor reached
 * for the same question (see its LAYER_STYLE header): nothing scrolls
 * sideways, so there are no per-cell scrollbars, no sticky gutters and no
 * scroll-syncing between the two halves.
 *
 * Deliberately not syntax-highlighted. highlight.js carries no state between
 * calls, so a line inside a block comment or a template literal colours
 * wrongly — and a hunk starts mid-construct by definition, so the failure rate
 * is *higher* here than in a file view. On a screen where someone is
 * approving changes, colour is a channel they trust, and wrong colour is worse
 * than none. What actually carries the meaning — which side changed — is the
 * cell tint and the gutters.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { Switch, Text } from '@fluentui/react-components';
import {
  isLineEndingsOnly, parsePatch, toRows, toUnifiedRows, type DiffLine, type Row,
} from './parse-patch.ts';
import type { DiffFileEntry } from './types.ts';
import { EmptyState } from '../components/EmptyState.tsx';

/**
 * How many rows of one file we will draw. No virtualization library is
 * installed and the codebase's habit is to cap rather than virtualize
 * (MAX_DIR_ENTRIES, MAX_PREVIEW_BYTES): past this nobody is reading line by
 * line anyway, and the file is one click from the Files page.
 */
export const MAX_DIFF_ROWS = 2000;

/** A minified file is one line; without this it is one absurdly tall row. */
const MAX_LINE_CHARS = 2000;

const SPLIT_PREF_KEY = 'whiphand.diff.split';

/**
 * Everything the four columns must agree on. Same discipline as CodeEditor's
 * LAYER_STYLE: anything added to one has to be added to the others, or the
 * two sides stop lining up.
 */
const CELL_STYLE: CSSProperties = {
  fontFamily: 'var(--fontFamilyMonospace)',
  fontSize: 12,
  lineHeight: 1.5,
  tabSize: 2,
  padding: '0 8px',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  minWidth: 0,
};

const GUTTER_STYLE: CSSProperties = {
  ...CELL_STYLE,
  textAlign: 'right',
  userSelect: 'none',
  color: 'var(--colorNeutralForeground4)',
  background: 'var(--colorNeutralBackground2)',
  // So "12" sits beside the *first* visual line of a row that wrapped.
  alignSelf: 'start',
};

const TINT: Record<'add' | 'del' | 'context' | 'empty', string | undefined> = {
  add: 'var(--colorPaletteGreenBackground1)',
  del: 'var(--colorPaletteRedBackground1)',
  context: undefined,
  // An absent counterpart is not a change — it reads as background.
  empty: 'var(--colorNeutralBackground3)',
};

function clamp(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}

/** One side of one row: its gutter and its text. `undefined` renders as empty. */
function Side({ line, row, side }: { line: DiffLine | undefined; row: number; side: 'left' | 'right' }) {
  const kind = line === undefined ? 'empty' : line.kind;
  const number = line === undefined ? undefined : side === 'left' ? line.oldLine : line.newLine;
  const background = TINT[kind];
  const sign = kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';

  return (
    <>
      <div
        aria-hidden="true"
        data-row={row}
        data-kind={kind}
        style={{ ...GUTTER_STYLE, ...(background ? { background } : {}) }}
      >
        {number ?? ''}
      </div>
      <div
        data-row={row}
        data-kind={kind}
        data-side={side}
        style={{ ...CELL_STYLE, ...(background ? { background } : {}) }}
        title={line?.noNewline ? 'No newline at end of file' : undefined}
      >
        {line === undefined ? '' : `${sign}${clamp(line.text)}`}
        {line?.noNewline && (
          <Text size={100} style={{ color: 'var(--colorNeutralForeground4)' }}> ⏎̸ no newline</Text>
        )}
      </div>
    </>
  );
}

export interface DiffFileViewProps {
  file: DiffFileEntry;
}

export function DiffFileView({ file }: DiffFileViewProps) {
  /**
   * A per-sitting preference, remembered the way use-file-tree remembers
   * `showHidden`. Reading in the initialiser so a re-render never re-reads it.
   */
  const [split, setSplit] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SPLIT_PREF_KEY) !== 'false';
    } catch {
      return true; // a private window, or storage the browser refused
    }
  });

  // Keyed on the patch, not on `file`: the rail hands back a fresh object on
  // every poll, and re-parsing on each keystroke in the decision bar's note
  // field is exactly the cost this avoids.
  const parsed = useMemo(() => parsePatch(file.patch ?? ''), [file.patch]);
  const rows = useMemo(
    () => (split ? toRows(parsed) : toUnifiedRows(parsed)),
    [parsed, split],
  );
  // Always from the paired rows, never from `rows`: unified rows are one-sided
  // by construction, so deriving this from the current view would make the
  // warning vanish whenever someone turned the toggle off — and this is a fact
  // about the file, not about how it is being looked at.
  const lineEndingsOnly = useMemo(() => isLineEndingsOnly(toRows(parsed)), [parsed]);

  const shown = rows.slice(0, MAX_DIFF_ROWS);
  const hidden = rows.length - shown.length;

  function chooseSplit(next: boolean): void {
    setSplit(next);
    try {
      localStorage.setItem(SPLIT_PREF_KEY, String(next));
    } catch { /* storage refused; the choice still holds for this sitting */ }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
          padding: '4px 8px', borderBottom: '1px solid var(--colorNeutralStroke2)',
        }}
      >
        <Text
          weight="semibold"
          data-testid="diff-file-path"
          style={{ fontFamily: 'var(--fontFamilyMonospace)', wordBreak: 'break-all' }}
        >
          {file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
        </Text>
        <Text size={200} style={{ color: 'var(--colorPaletteGreenForeground2)' }}>+{file.additions}</Text>
        <Text size={200} style={{ color: 'var(--colorPaletteRedForeground2)' }}>−{file.deletions}</Text>
        <div style={{ marginLeft: 'auto' }}>
          <Switch
            checked={split}
            label="Side by side"
            data-testid="diff-split-toggle"
            onChange={(_e, data) => chooseSplit(data.checked)}
          />
        </div>
      </div>

      {lineEndingsOnly && (
        // Every line reports as changed with nothing visibly different, which
        // is the one diff a reviewer cannot read without being told.
        <Text
          data-testid="diff-line-endings-only"
          size={200}
          style={{ flexShrink: 0, padding: '4px 8px', color: 'var(--colorNeutralForeground3)' }}
        >
          Line endings only — the text is unchanged.
        </Text>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {file.binary ? (
          <EmptyState>Binary file — {file.status}. Nothing to show line by line.</EmptyState>
        ) : file.truncated ? (
          <EmptyState>
            Too large to show here ({file.additions} added, {file.deletions} removed).
            Open it from the Files page.
          </EmptyState>
        ) : parsed.unsupported === 'combined' ? (
          <EmptyState>
            This file is mid-merge, and a combined diff can&apos;t be shown side by side.
          </EmptyState>
        ) : file.patch === undefined ? (
          // Counts but no patch, and not flagged `truncated`: core's pairing
          // guard fired, dropping every patch rather than risk showing one
          // file's changes under another's name. Saying "no textual changes"
          // here would be a lie about the one screen that must not tell one.
          <EmptyState>
            {file.additions + file.deletions > 0
              ? `Couldn't show this file's changes (+${file.additions} −${file.deletions}). `
                + 'Open it from the Files page.'
              : `No textual changes — ${file.status}.`}
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState>No textual changes — {file.status}.</EmptyState>
        ) : (
          <div
            data-testid="diff-grid"
            style={{
              display: 'grid',
              // numL, textL, numR, textR. One grid for the whole file, so both
              // sides share every row boundary without any measurement.
              gridTemplateColumns: split
                ? 'auto minmax(0,1fr) auto minmax(0,1fr)'
                : 'auto auto minmax(0,1fr)',
            }}
          >
            {shown.map((row, index) => (
              <RowCells key={index} row={row} index={index} split={split} />
            ))}
          </div>
        )}
        {hidden > 0 && (
          <Text
            data-testid="diff-row-cap"
            style={{ display: 'block', padding: 8, color: 'var(--colorNeutralForeground3)' }}
          >
            …and {hidden} more lines. Open the file to see the rest.
          </Text>
        )}
      </div>
    </div>
  );
}

function RowCells({ row, index, split }: { row: Row; index: number; split: boolean }) {
  if (row.kind === 'hunk') {
    return (
      <div
        data-row={index}
        data-kind="hunk"
        style={{
          gridColumn: '1 / -1',
          ...CELL_STYLE,
          background: 'var(--colorNeutralBackground3)',
          color: 'var(--colorNeutralForeground3)',
        }}
      >
        {`@@ −${row.oldStart} +${row.newStart} @@${row.heading ? ` ${row.heading}` : ''}`}
      </div>
    );
  }

  if (!split) {
    // Unified: both gutters, then the single text column.
    const line = row.kind === 'context' ? row.left : (row.left ?? row.right)!;
    const kind = line.kind;
    const background = TINT[kind];
    const sign = kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';
    return (
      <>
        <div aria-hidden="true" data-row={index} data-kind={kind} style={GUTTER_STYLE}>
          {line.oldLine ?? ''}
        </div>
        <div aria-hidden="true" data-row={index} data-kind={kind} style={GUTTER_STYLE}>
          {line.newLine ?? ''}
        </div>
        <div
          data-row={index}
          data-kind={kind}
          style={{ ...CELL_STYLE, ...(background ? { background } : {}) }}
        >
          {`${sign}${clamp(line.text)}`}
        </div>
      </>
    );
  }

  return (
    <>
      <Side line={row.left} row={index} side="left" />
      <Side line={row.right} row={index} side="right" />
    </>
  );
}
