import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { countOccurrences, rehypeFindHighlight } from './find.ts';

function highlight(html: string, query: string, activeIndex = 0): string {
  return unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeFindHighlight, { query, activeIndex })
    .use(rehypeStringify)
    .processSync(html)
    .toString();
}

describe('rehypeFindHighlight', () => {
  it('marks every match', () => {
    const out = highlight('<p>PKCE and more PKCE</p>', 'pkce');
    expect(out.match(/<mark/g)).toHaveLength(2);
  });

  it('matches case-insensitively without changing the text', () => {
    const out = highlight('<p>Pkce</p>', 'pkce');
    expect(out).toContain('>Pkce</mark>');
  });

  it('numbers matches in document order', () => {
    const out = highlight('<p>a</p><p>a</p>', 'a');
    expect(out).toContain('data-find-index="0"');
    expect(out).toContain('data-find-index="1"');
  });

  it('flags the active match and only that one', () => {
    const out = highlight('<p>a a a</p>', 'a', 1);
    expect(out.match(/data-find-active="true"/g)).toHaveLength(1);
    expect(out).toContain('data-find-index="1" data-find-active="true"');
  });

  it('leaves the tree alone for an empty query', () => {
    expect(highlight('<p>text</p>', '')).toBe('<p>text</p>');
  });

  it('does not match inside a script element', () => {
    // rehype-parse keeps its contents as a text node; marking it would
    // corrupt the element.
    expect(highlight('<script>var color = 1;</script>', 'color')).not.toContain('<mark');
  });

  it('does not match inside a style element', () => {
    expect(highlight('<style>.a { color: red }</style>', 'color')).not.toContain('<mark');
  });

  it('does not match inside a textarea element', () => {
    expect(highlight('<textarea>color</textarea>', 'color')).not.toContain('<mark');
  });

  it('does not match inside a title element', () => {
    expect(highlight('<title>color</title>', 'color')).not.toContain('<mark');
  });

  it('treats regex metacharacters in the query as literal text', () => {
    expect(highlight('<p>cost is $5.00</p>', '$5.00')).toContain('<mark');
    expect(highlight('<p>plain</p>', '.*')).not.toContain('<mark');
  });

  it('splits a text node into before/match/after rather than dropping context', () => {
    expect(highlight('<p>xxPKCExx</p>', 'pkce')).toBe(
      '<p>xx<mark data-find-index="0" data-find-active="true">PKCE</mark>xx</p>',
    );
  });

  it('does not match inside a fenced code block (pre > code)', () => {
    // Markdown.tsx's fence branch does String(children) to hand the source to
    // CodeBlock/Mermaid; a split text node here would corrupt that. CodeBlock
    // also renders via dangerouslySetInnerHTML, so a <mark> inside would
    // never reach the DOM but would still be counted, breaking the total.
    expect(highlight('<pre><code>alert(1)</code></pre>', 'alert')).not.toContain('<mark');
  });

  it('still matches inside inline code (a code element with no pre ancestor)', () => {
    expect(highlight('<p>Use <code>alert</code> now</p>', 'alert')).toContain('<mark');
  });

  it("does not skip a sibling's match when resuming traversal after a splice", () => {
    // Regression pin for the visitor's return-index contract. A text node
    // that is *entirely* consumed by one match (no leading/trailing
    // remainder) replaces 1 child with 1 <mark> child, so the correct resume
    // index equals the original index unchanged. An off-by-one
    // (`index + parts.length + 1`) instead resumes one position too far,
    // skipping the very next sibling — here <em>a</em> — without visiting it
    // or its descendants, silently losing the match inside it. This fixture
    // is chosen deliberately: an intervening sibling with no match of its
    // own (e.g. <em>x</em>) would not expose the bug, since skipping it has
    // no observable effect.
    const out = highlight('<p>a<em>a</em>b</p>', 'a');
    expect(out.match(/<mark/g)).toHaveLength(2);
    expect(out).toContain('data-find-index="0"');
    expect(out).toContain('data-find-index="1"');
  });
});

describe('countOccurrences', () => {
  // The find bar counts a view the plugin cannot mark (the raw source) with
  // this, so it has to agree with the plugin about what a match is — or the
  // number on screen would not match the marks the reader steps through.
  it('counts every occurrence, ignoring case', () => {
    expect(countOccurrences('Pkce and pkce and PKCE', 'pkce')).toBe(3);
  });

  it('counts non-overlapping matches, as the plugin marks them', () => {
    // 'aaaa' holds three overlapping 'aa's but only two the plugin can mark:
    // each mark consumes its own characters.
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
  });

  it('treats the query as literal text, not a pattern', () => {
    expect(countOccurrences('a.b and axb', 'a.b')).toBe(1);
  });

  it('counts nothing for an empty query', () => {
    expect(countOccurrences('anything', '')).toBe(0);
  });
});
