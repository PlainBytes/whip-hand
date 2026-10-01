/**
 * Windowed rendering for the app's long lists (the Logs tab, a file's diff,
 * the file tree): only the rows near the viewport are in the DOM, measured as
 * they render, with spacers standing in for the rest. A thin layer over
 * @tanstack/react-virtual so the three lists share one set of defaults.
 *
 * The scroll container must carry VIRTUAL_SCROLLER_PROPS: the attribute is
 * how the test setup (src/test/setup.ts) gives jsdom, which lays nothing out,
 * a viewport to window against.
 *
 * Rows are laid out in normal flow between two spacers rather than absolutely
 * positioned, so a list keeps its own layout (the Logs tab's flex rows, the
 * diff's CSS grid) and only gains the spacers.
 */
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import type { RefObject } from 'react';

export const VIRTUAL_SCROLLER_PROPS = { 'data-virtual-scroller': '' } as const;

export interface VirtualRowsOptions {
  count: number;
  scrollRef: RefObject<HTMLElement | null>;
  /** A typical row's height in px; rows are measured once rendered. */
  estimateSize: number;
  /**
   * A stable identity per row. Required whenever rows can be inserted before
   * others (a "Load earlier" prepend): measured sizes are cached by key, and
   * an index-keyed cache would hand every shifted row its neighbour's height.
   */
  getItemKey?: (index: number) => string | number;
  overscan?: number;
}

export function useVirtualRows({ count, scrollRef, estimateSize, getItemKey, overscan = 12 }: VirtualRowsOptions) {
  return useVirtualizer<HTMLElement, HTMLElement>({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    ...(getItemKey === undefined ? {} : { getItemKey }),
    overscan,
  });
}

/** Heights of the spacers above and below the rendered window. */
export function spacerHeights(virtualizer: Virtualizer<HTMLElement, HTMLElement>): { before: number; after: number } {
  const items = virtualizer.getVirtualItems();
  if (items.length === 0) return { before: 0, after: 0 };
  return {
    before: items[0].start - (virtualizer.options.scrollMargin ?? 0),
    after: virtualizer.getTotalSize() - items[items.length - 1].end,
  };
}
