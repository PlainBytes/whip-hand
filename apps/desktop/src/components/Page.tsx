import type { ReactNode } from 'react';

/**
 * Icon convention for buttons placed in a Page header (or in a header-shaped
 * action row that doesn't use this component):
 * one verb -> one icon, everywhere in the app, so the same action never
 * looks different depending on which page it's on.
 *
 *   Edit                        -> Edit20Regular
 *   Save                        -> Save20Regular
 *   Cancel / dismiss an edit    -> Dismiss20Regular
 *   Stop a running thing        -> Stop20Regular      (distinct from Dismiss)
 *   Delete                      -> Delete20Regular
 *   Duplicate / Clone           -> Copy20Regular
 *   Create (untyped)            -> Add20Regular
 *   Create (typed)              -> DocumentAdd* / FolderAdd* (already in use)
 *   Go back                     -> ArrowLeft20Regular
 *   Refresh / re-check          -> ArrowClockwise20Regular
 *   Re-run something that finished -> Replay20Regular (not ArrowClockwise —
 *                                     that already means "refresh" here)
 *   End an interactive session  -> PlugDisconnected20Regular
 *
 * Delete (and other destructive actions) is always a DangerButton: filled
 * for page-header and confirm-dialog actions, subtle for list rows and
 * icon-only buttons.
 *
 * Sizing: 20px icons on default-size buttons, 16px icons on size="small"
 * buttons. A button whose label swaps while working (e.g. "Saving...")
 * swaps its icon slot to <Spinner size="tiny" /> for the duration instead
 * of adding a second one.
 *
 * Icons are imported directly at each call site (no shared re-export
 * module) — this comment is the source of truth for the convention.
 */

/**
 * A page: a header that never moves above a body that owns its scrolling.
 *
 * <main> in App.tsx does not scroll; each page renders into it through this
 * component. The header sits outside the scrolling region, so it cannot move
 * with the content — by construction, not by sticky-positioning tricks.
 *
 *  - `body="scroll"` (default): the body is the page's scroll container.
 *  - `body="fill"`: the body is a padded flex column with no overflow of its
 *    own, for pages that manage internal scrollers (Run Detail, Files).
 */
export function Page({
  header, body = 'scroll', children,
}: {
  header: ReactNode;
  body?: 'scroll' | 'fill';
  children: ReactNode;
}) {
  return (
    <div
      data-testid="page"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div
        data-testid="page-header"
        style={{
          flexShrink: 0,
          boxSizing: 'border-box',
          padding: '12px 16px',
          background: 'var(--colorNeutralBackground2)',
          borderBottom: '1px solid var(--colorNeutralStroke2)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          gap: 4,
        }}
      >
        {header}
      </div>
      <div
        data-testid="page-body"
        data-body={body}
        style={
          body === 'scroll'
            ? { flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }
            : { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 16 }
        }
      >
        {children}
      </div>
    </div>
  );
}
