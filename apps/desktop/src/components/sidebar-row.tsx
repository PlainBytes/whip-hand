import type { CSSProperties, ReactNode } from 'react';

/**
 * Fluent's medium `Button` geometry — border 1px, padding `12px` horizontal,
 * 32px min-height — is what nav items already get for free from Fluent itself.
 * Every other sidebar row spreads this in explicitly so all five row types
 * share one rail instead of each hand-rolling its own numbers.
 */
export const SIDEBAR_ROW_STYLE: CSSProperties = {
  boxSizing: 'border-box',
  justifyContent: 'flex-start',
  // A property of the rail, not of any one row: Fluent's Button defaults to
  // `text-align: center` (the UA stylesheet, not an author rule — the
  // compiled button styles carry zero `text-align` declarations), and every
  // rail row that lands a text column narrower than its Button needs this to
  // keep its label on the shared label column instead of centred within it.
  textAlign: 'left',
  minHeight: 32,
  // The vertical padding is trimmed below Fluent's own 5px so a 24px status
  // marker (the trailing badge or spinner) fits without growing the row:
  // 24 + 3·2 + 1·2 = 32px. Horizontal stays 12px, matching Fluent's Button.
  padding: '3px 12px',
  border: '1px solid transparent',
  borderRadius: 4,
};

/** Gap between rows within one block (a nav group, the ongoing-runs list). */
export const SIDEBAR_ROW_GAP = 2;
/** Gap between blocks (workspace switcher, nav groups, runs, remote indicator). */
export const SIDEBAR_GROUP_GAP = 12;

/**
 * The row's leading 20×20 slot, matching `.fui-Button__icon` so a dot's
 * centre lands on the same column as a nav icon's. Rendered with no
 * children, it is what puts a glyph-less row (the "+N more" row, or a job
 * with no workdir) on the same label column as its siblings.
 */
export function RowGlyph({ children }: { children?: ReactNode }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, flexShrink: 0, marginRight: 6,
      }}
    >
      {children}
    </span>
  );
}

/**
 * The row's trailing 24×24 slot — sized for the large status marker it holds
 * (a 24px badge or spinner) — flush to the content's right edge.
 */
export function RowTrailing({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 24, flexShrink: 0, marginLeft: 'auto',
      }}
    >
      {children}
    </span>
  );
}
