/**
 * The recessed panel a run's output sits on — the log tail, the activity
 * feed, the artifact preview (and the Files page's, and the review screen's),
 * and the Terminal tab's placeholders. One constant rather than copies of the
 * same three properties, because the point of it is that they match: a tab or
 * pane is the same panel whether or not anything is running in it, so an
 * empty one reads as "nothing here yet" rather than as a tab that failed to
 * render. It is also the *only* boundary these screens draw — no lines, per
 * the run detail tabs' layout rule — so an adjacent column sits on the page
 * background with a gap before this surface, not a border against it.
 */
export const RECESSED_SURFACE = {
  background: 'var(--colorNeutralBackground3)',
  padding: 8,
  borderRadius: 4,
} as const;
