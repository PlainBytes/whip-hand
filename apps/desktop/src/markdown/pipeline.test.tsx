// apps/desktop/src/markdown/pipeline.test.tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import { REHYPE_PLUGINS, REMARK_PLUGINS } from './pipeline.ts';

function html(markdown: string): string {
  const { container } = render(
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>{markdown}</ReactMarkdown>,
  );
  return container.innerHTML;
}

describe('markdown pipeline', () => {
  it('renders GFM tables', () => {
    expect(html('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>');
  });

  it('renders task lists as disabled checkboxes', () => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {'- [x] done\n- [ ] todo'}
      </ReactMarkdown>,
    );
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
  });

  it('renders strikethrough and autolinks', () => {
    expect(html('~~gone~~')).toContain('<del>');
    expect(html('see https://example.com now')).toContain('href="https://example.com"');
  });

  it('keeps a footnote link pointing at a target that exists', () => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {'Uses PKCE.[^1]\n\n[^1]: RFC 7636\n'}
      </ReactMarkdown>,
    );
    const link = container.querySelector('a[href^="#"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    // The whole point of clobber: [] — the anchor must resolve.
    expect(container.querySelector(link.getAttribute('href')!)).not.toBeNull();
  });

  it('gives headings a slug id', () => {
    expect(html('## The Approach')).toContain('id="the-approach"');
  });

  it('appends an anchor link to each heading', () => {
    const out = html('## The Approach');
    expect(out).toContain('href="#the-approach"');
    expect(out).toContain('whiphand-markdown-anchor');
  });

  it('takes the heading anchor out of the accessibility tree and tab order', () => {
    // The anchor carries no aria-label of its own, so it can never announce
    // and can never pollute the heading's accessible name — see the
    // equivalent assertion in Markdown.test.tsx for the full rationale.
    const { container } = render(
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {'## The Approach'}
      </ReactMarkdown>,
    );
    const anchor = container.querySelector('.whiphand-markdown-anchor');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveAttribute('aria-hidden', 'true');
    expect(anchor).toHaveAttribute('tabindex', '-1');
    expect(anchor).not.toHaveAttribute('aria-label');
  });

  it('links an in-page anchor to a heading that exists', () => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {'## The Approach\n\n[jump](#the-approach)'}
      </ReactMarkdown>,
    );
    expect(container.querySelector('#the-approach')).not.toBeNull();
  });

  it('keeps details/summary from raw HTML', () => {
    const out = html('<details><summary>More</summary>\n\nhidden\n\n</details>');
    expect(out).toContain('<details>');
    expect(out).toContain('<summary>');
  });

  it('strips a script tag from raw HTML', () => {
    // Sanitize must run AFTER raw. If it ran first the tag would survive as
    // text and rehype-raw would then parse it into a live element.
    const out = html('before<script>window.pwned = 1</script>after');
    expect(out).not.toContain('<script');
    expect(window).not.toHaveProperty('pwned');
  });

  it('strips event handlers and javascript: urls', () => {
    expect(html('<img src="x" onerror="window.pwned = 1">')).not.toContain('onerror');
    expect(html('[click](javascript:alert(1))')).not.toContain('javascript:');
  });

  it('strips an iframe', () => {
    expect(html('<iframe src="https://example.com"></iframe>')).not.toContain('<iframe');
  });

  it('leaves a relative href untouched', () => {
    // react-markdown's defaultUrlTransform only filters URLs that carry a
    // scheme, so relative targets already survive — no override needed. This
    // test exists so a future react-markdown upgrade cannot quietly break it.
    expect(html('[review](./review.md)')).toContain('href="./review.md"');
  });

  it('renders frontmatter as a table', () => {
    expect(html('---\nrun: oauth\n---\n\nBody')).toContain('<table>');
  });

  it('keeps the language class on a fenced code block', () => {
    // Task 4 reads the language off this class to pick a highlighter. If the
    // sanitize schema ever drops it, fences silently lose highlighting and the
    // failure looks like a highlighter bug three tasks away from the cause.
    expect(html('```ts\nconst x = 1;\n```')).toContain('language-ts');
  });

  it('strips a data: srcset on a picture source', () => {
    // srcSet isn't in defaultSchema.protocols by default, unlike every other
    // URL-bearing attribute — this pins the explicit protocols override.
    expect(html('<picture><source srcset="data:text/html,x"></picture>')).not.toContain('data:');
  });

  it('keeps an https srcset on a picture source', () => {
    expect(html('<picture><source srcset="https://example.com/a.png"></picture>')).toContain(
      'https://example.com/a.png',
    );
  });

  it('strips a base tag', () => {
    expect(html('<base href="https://evil.example">')).not.toContain('<base');
  });

  it('strips a form tag', () => {
    expect(html('<form action="https://evil.example"><input type="text"></form>')).not.toContain('<form');
  });

  it('strips a style attribute', () => {
    expect(html('<p style="position:fixed;inset:0">x</p>')).not.toContain('style=');
  });

  it('strips a data: href on a link', () => {
    expect(html('[click](data:text/html,<script>x</script>)')).not.toContain('data:');
  });
});
