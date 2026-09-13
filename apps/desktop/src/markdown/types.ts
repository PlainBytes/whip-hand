/** Shared types for the markdown renderer. Imports nothing, so nothing cycles. */

/** Where a relative href or src points, once the consumer has resolved it. */
export interface DocResolution {
  path: string;
  kind: 'link' | 'image';
}

/**
 * What a find query actually found in the rendered document.
 *
 * Two numbers, not one: text inside a fenced code block can't be
 * highlighted (CodeBlock renders via dangerouslySetInnerHTML, so a <mark>
 * there would be counted but never appear). `unreachable` surfaces that gap
 * instead of letting `total` silently mean different things in the source
 * view and the rendered one.
 */
export interface FindMatchCounts {
  /** Highlighted matches, and the range next/previous steps through. */
  total: number;
  /** Occurrences inside fenced code, which the rendered view cannot mark. */
  unreachable: number;
}

/** Owned by the pane's find bar; the renderer only reads it. */
export interface FindState {
  query: string;
  /** Zero-based index of the match to scroll to and mark current. */
  activeIndex: number;
  /**
   * Called after each render with what the rendered document contains. Must
   * be identity-stable, or the renderer's reporting effect re-fires on every
   * render.
   */
  onMatchCount: (counts: FindMatchCounts) => void;
}

export interface MarkdownProps {
  text: string;
  /** How a non-absolute href/src resolves. Returning null renders inert text. */
  resolve?: (target: string) => DocResolution | null;
  /** Follow an in-app link. Absent → links resolve but don't navigate. */
  onNavigate?: (path: string) => void;
  /** Load bytes for a relative image. Absent → images render as a placeholder. */
  loadImage?: (path: string) => Promise<Uint8Array>;
  /** Open an http(s) target. Absent → external links are inert. */
  openExternal?: (url: string) => void;
  /** Active find query; matches are highlighted, the current one scrolled to. */
  find?: FindState;
}
