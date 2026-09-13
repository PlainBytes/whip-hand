/**
 * Highlights find matches by splitting text nodes in the hast tree before
 * React renders it, rather than mutating the rendered DOM — which React owns
 * and can throw on when it next reconciles.
 */
import { visitParents } from 'unist-util-visit-parents';
import type { Element, Root, Text } from 'hast';

/**
 * How many times `query` occurs in `text`, by the same rule the plugin marks
 * by: literal (a query is text, not a pattern), case-insensitive, and
 * non-overlapping. Exported so the count a caller shows and the marks it
 * steps through can never disagree about what a match is.
 */
export function countOccurrences(text: string, query: string): number {
  if (query === '') return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let total = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    total += 1;
  }
  return total;
}

/** Their contents are text nodes but not prose; marking them corrupts the element. */
const OPAQUE = new Set(['script', 'style', 'textarea', 'title']);

function markElement(value: string, index: number, active: boolean): Element {
  return {
    type: 'element',
    tagName: 'mark',
    properties: {
      'data-find-index': String(index),
      ...(active ? { 'data-find-active': 'true' } : {}),
    },
    children: [{ type: 'text', value }],
  };
}

export function rehypeFindHighlight(options: { query: string; activeIndex: number }) {
  const { query, activeIndex } = options;

  return (tree: Root): void => {
    if (query === '') return;
    const needle = query.toLowerCase();
    let counter = 0;

    // visitParents (not plain unist-util-visit) so we can see the whole
    // ancestor chain: a direct-parent check can't tell that a text node's
    // parent `code` sits inside a `pre` a level up.
    visitParents(tree, 'text', (node: Text, ancestors) => {
      const parent = ancestors[ancestors.length - 1];
      if (!parent || parent.type !== 'element') return;
      if (OPAQUE.has(parent.tagName)) return;

      // Fenced code blocks (and the <code> inside them) are off-limits:
      // Markdown.tsx's fence branch does String(children) to hand the source
      // to CodeBlock/Mermaid, and splitting the text node here would turn
      // that into "...[object Object]...", corrupting the block. CodeBlock
      // also renders via dangerouslySetInnerHTML, so a <mark> here would
      // never reach the DOM anyway — it would still be counted, throwing off
      // the match total and next/prev stepping. Inline code (no <pre>
      // ancestor) renders as ordinary children, so it stays markable.
      if (ancestors.some((ancestor) => ancestor.type === 'element' && (ancestor as Element).tagName === 'pre')) {
        return;
      }

      const index = parent.children.indexOf(node);
      if (index === -1) return;

      // Case-insensitive lookup, but the haystack is only used to find
      // offsets — slices always come from the original `node.value` so the
      // <mark> keeps the source casing.
      //
      // Hazard: toLowerCase() can change a string's length (İ, U+0130,
      // becomes "i" + a combining dot above, U+0307). If that character
      // precedes a match in the same text node, haystack offsets drift from
      // node.value offsets by one and the mark covers the wrong characters.
      // Accepted: no crash, no text lost (slices stay contiguous and
      // clamped), and it is vanishingly rare prose. Not fixed here — flagged
      // for whoever next touches this slicing arithmetic.
      const haystack = node.value.toLowerCase();
      if (!haystack.includes(needle)) return;

      const parts: Array<Text | Element> = [];
      let cursor = 0;
      for (;;) {
        // indexOf, not a RegExp: a query is literal text, and a user typing
        // ".*" means those two characters.
        const at = haystack.indexOf(needle, cursor);
        if (at === -1) break;
        if (at > cursor) parts.push({ type: 'text', value: node.value.slice(cursor, at) });
        parts.push(markElement(node.value.slice(at, at + needle.length), counter, counter === activeIndex));
        counter += 1;
        cursor = at + needle.length;
      }
      if (cursor < node.value.length) parts.push({ type: 'text', value: node.value.slice(cursor) });

      parent.children.splice(index, 1, ...parts);
      // Skip past what we just inserted; visiting our own <mark> text would loop.
      return index + parts.length;
    });
  };
}
