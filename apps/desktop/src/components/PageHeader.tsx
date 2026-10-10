import { useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * The vertical padding of the scroll container pages render into —
 * App.tsx's `<main style={{ flex: 1, overflow: 'auto', padding: 16 }}>`.
 *
 * This matters because a scroll container clips overflow at its *padding
 * box*, while `position: sticky; top: 0` pins to its *content box* — 16px
 * lower. That difference leaves a band at each end of the scrollport where
 * scrolling content stays visible past the sticky bar. PageHeader and
 * PageFooter cancel it by sticking that much further out and padding the
 * distance back in, so the bars reach the real clip edge.
 *
 * Keep in sync with `<main>`'s padding in App.tsx. The top edge is the one
 * exception — see SCROLLPORT_PADDING_TOP.
 */
export const SCROLLPORT_PADDING = 16;

/**
 * The scroll container's *top* padding, which is half the other three — and
 * therefore visually equal to them. The space above a page's title is paid
 * twice: once by <main>'s padding and once by PageHeader padding the same
 * distance back in (it sticks that far past the content box, see above). So
 * this doubles to SCROLLPORT_PADDING, and the gap above a page title matches
 * the gap at its sides.
 *
 * Whatever this is, PageHeader sticks at -this and pads +this; a descendant
 * that docks its own sticky header below it subtracts it the same way. Keep
 * in sync with <main>'s paddingTop in App.tsx.
 */
export const SCROLLPORT_PADDING_TOP = SCROLLPORT_PADDING / 2;

/**
 * CSS custom property carrying PageHeader's *measured* height, published on
 * its parent element so a descendant can dock its own sticky header exactly
 * below it. Measured rather than hardcoded because the real height depends on
 * font metrics and on whatever the caller puts in the header — a guessed
 * constant silently misaligns by a few pixels. Nothing docks against it right
 * now, but the mechanism stays available for the next thing that needs it.
 */
export const PAGE_HEADER_HEIGHT_VAR = '--whiphand-page-header-height';

/**
 * Icon convention for buttons placed in a PageHeader or PageFooter (or in a
 * header/footer-shaped action row that doesn't yet use these components):
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
 * Sticky page-level header (name + critical info) for the scroll container
 * in App.tsx's <main>. Pure CSS position: sticky — no scroll container of
 * its own, so it composes with any ancestor's scrolling.
 *
 * No rule underneath: the opaque background alone is enough to tell the bar
 * from the content sliding beneath it, and vertical space at the top of a
 * page is worth more than the line.
 *
 * Deliberately no margin: a margin on a sticky element scrolls along with
 * it (staying fixed on screen) rather than with the content, which leaves a
 * transparent gap the scrolling content shows through. Callers space the
 * non-sticky body content instead (e.g. paddingTop).
 */
export function PageHeader({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;

    const publish = () => parent.style.setProperty(PAGE_HEADER_HEIGHT_VAR, `${el.offsetHeight}px`);
    publish();

    // jsdom (vitest) has no ResizeObserver; the one-shot measurement above
    // is enough there, and the fallback covers layout-less environments.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: 'sticky',
        top: -SCROLLPORT_PADDING_TOP,
        zIndex: 2,
        boxSizing: 'border-box',
        background: 'var(--colorNeutralBackground1)',
        // Exactly the distance the bar sticks past the content box (see
        // above): any less and the header's own content lands off-screen when
        // it is stuck, any more is dead space above every page title.
        paddingTop: SCROLLPORT_PADDING_TOP,
        paddingBottom: 4,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        gap: 4,
      }}
    >
      {children}
    </div>
  );
}
