/**
 * The one markdown renderer in the app.
 *
 * Every capability it needs from outside — resolving a relative path,
 * navigating, loading image bytes, opening a URL — arrives as an optional
 * prop, so this component imports nothing from Tauri, and a consumer that
 * can't offer a capability gets inert text instead of a broken affordance.
 * The one exception is the theme store: a ```mermaid fence renders an SVG
 * with colours baked in at draw time rather than styled by CSS variable, so
 * Mermaid.tsx reads the app's theme (via useDarkTheme, the same value
 * FluentProvider renders with) to pick a matching mermaid theme.
 */
import { useEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import type { PluggableList } from 'unified';
import { CodeBlock } from './CodeBlock.tsx';
import { Mermaid } from './Mermaid.tsx';
import { MarkdownImage } from './MarkdownImage.tsx';
import { countOccurrences, rehypeFindHighlight } from './find.ts';
import { REHYPE_PLUGINS, REMARK_PLUGINS } from './pipeline.ts';
import { isExternal } from './resolve.ts';
import type { MarkdownProps } from './types.ts';

export type { DocResolution, FindMatchCounts, FindState, MarkdownProps } from './types.ts';

export function Markdown({ text, resolve, onNavigate, loadImage, openExternal, find }: MarkdownProps) {
  const components = useMemo<Components>(() => ({
    table: ({ node, ...props }) => (
      <div className="whiphand-markdown-table-scroll">
        <table {...props} />
      </div>
    ),
    // A fenced block arrives as <pre><code class="language-x">. Rendering our
    // own <pre> inside CodeBlock means the wrapper <pre> has to get out of the
    // way, or the block ends up nested two deep.
    pre: ({ children }) => <>{children}</>,
    code: ({ node, className, children, ...props }) => {
      const match = /language-(\w+)/.exec(className ?? '');
      const isFence = className !== undefined || String(children).includes('\n');
      if (!isFence) return <code className={className} {...props}>{children}</code>;
      const language = match?.[1] ?? '';
      if (language === 'mermaid') return <Mermaid code={String(children)} />;
      return <CodeBlock language={language} code={String(children)} />;
    },
    a: ({ node, href, children, ...props }) => {
      // An in-page fragment (including the heading anchors pipeline.ts
      // appends) is not a file to resolve — pass the remaining props through
      // so className/aria-hidden/tabIndex survive.
      if (href?.startsWith('#')) return <a href={href} {...props}>{children}</a>;

      if (href && isExternal(href)) {
        if (!openExternal) return <span data-inert="true">{children}</span>;
        return (
          <a
            href={href}
            {...props}
            onClick={event => {
              // Without preventDefault the webview navigates away from the
              // app to the target itself, and there is no way back.
              event.preventDefault();
              openExternal(href);
            }}
            // Middle-click fires auxclick, not click — React's onClick above
            // never sees it, so without this the anchor's default
            // new-window behaviour goes unchecked and the raw href opens.
            onAuxClick={event => event.preventDefault()}
          >
            {children}
            <span aria-hidden="true"> ↗</span>
          </a>
        );
      }

      const target = href ? resolve?.(href) ?? null : null;
      if (!target || !onNavigate) return <span data-inert="true">{children}</span>;
      return (
        <a
          href={href}
          {...props}
          onClick={event => {
            // Without preventDefault the webview navigates away from the app
            // to the file itself, and there is no way back.
            event.preventDefault();
            onNavigate(target.path);
          }}
          // See the external branch above: auxclick (middle-click) bypasses
          // onClick entirely and would otherwise follow the raw href.
          onAuxClick={event => event.preventDefault()}
        >
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => {
      const source = typeof src === 'string' ? src : '';
      // Remote images already have a usable src; only relative ones need reading.
      if (isExternal(source)) return <img src={source} alt={alt ?? ''} />;
      return <MarkdownImage src={source} alt={alt ?? ''} resolve={resolve} loadImage={loadImage} />;
    },
  }), [resolve, onNavigate, loadImage, openExternal]);

  // A copy, never REHYPE_PLUGINS itself — that array is module scope and
  // shared. The highlighter must run last: rehypeSanitize would strip its
  // data-find-* attributes if it ran after.
  const findQuery = find?.query ?? '';
  const findActiveIndex = find?.activeIndex ?? 0;
  const rehypePlugins = useMemo<PluggableList>(() => (
    findQuery === ''
      ? REHYPE_PLUGINS
      : [...REHYPE_PLUGINS, [rehypeFindHighlight, { query: findQuery, activeIndex: findActiveIndex }]]
  ), [findQuery, findActiveIndex]);

  // Reads the DOM after each render to report what the query found, and to
  // bring the current match into view. Reading only — the marks themselves
  // come from the hast tree, because mutating nodes React owns can make it
  // throw on the next reconcile.
  const containerRef = useRef<HTMLDivElement>(null);
  const onMatchCount = find?.onMatchCount;
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onMatchCount) return;

    // Fenced code is deliberately unmarked (see find.ts), so counting only
    // the marks would under-report without saying so. The <pre>s are right
    // here in the DOM, so the shortfall is measured rather than guessed —
    // no second markdown parse, and it cannot drift from what is on screen.
    // `:not([data-fallback-for])` excludes a mermaid fence's stand-in code
    // block, which exists only until the diagram resolves (and permanently
    // if it will not parse). This effect does not re-run when the SVG
    // replaces it, so counting it would make the answer depend on whether
    // the reader pressed Ctrl/Cmd-F before or after the diagram drew — the
    // same document reporting "+1 in code blocks" or nothing, by timing.
    // The deliberate consequence: diagram *source* is never advertised as
    // findable in the rendered view, before or after render. It is not
    // findable there in any case (the SVG shows labels, not source), and
    // the Source view still finds it. One conservative answer, always.
    let unreachable = 0;
    for (const pre of container.querySelectorAll('pre:not([data-fallback-for])')) {
      unreachable += countOccurrences(pre.textContent ?? '', findQuery);
    }
    onMatchCount({ total: container.querySelectorAll('mark[data-find-index]').length, unreachable });

    const active = container.querySelector('mark[data-find-active="true"]');
    // jsdom doesn't implement scrollIntoView; this is a real-browser nicety,
    // the same guard RunDetailPage uses for scrollTo.
    if (active instanceof HTMLElement && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'center' });
    }
  }, [text, findQuery, findActiveIndex, onMatchCount]);

  return (
    <div className="whiphand-markdown" ref={containerRef}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
