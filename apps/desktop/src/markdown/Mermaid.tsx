/**
 * A ```mermaid fence, rendered as a diagram.
 *
 * mermaid is imported lazily: it is by far the heaviest dependency in the
 * app, and most documents contain no diagram at all. A diagram that fails to
 * parse falls back to the source — an artifact with a typo in it should still
 * show you what it says.
 */
import { useEffect, useId, useState } from 'react';
import { useDarkTheme } from '../lib/use-dark-theme.ts';
import { CodeBlock } from './CodeBlock.tsx';

/**
 * A per-instance random suffix for the diagram id.
 *
 * mermaid.render() begins by calling removeExistingElements(document, id,
 * 'd'+id, 'i'+id), which is document-wide getElementById(...)?.remove()
 * (mermaid.core.mjs:1256, called at :1302). Our sanitize schema keeps
 * `clobber: []`, so an artifact's own `id` attributes reach the DOM
 * unprefixed — meaning a document that pairs a mermaid fence with, say,
 * `<div id="mermaid-r0">` would have mermaid delete a node React owns, and
 * React throws NotFoundError on the next reconcile of that subtree. useId
 * alone is deterministic ("r0", "r1", …) and so trivially guessable; this is
 * what an artifact cannot predict.
 */
function idNonce(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues === 'function') {
    const bytes = webCrypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export function Mermaid({ code }: { code: string }) {
  const dark = useDarkTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // mermaid.render needs a DOM id unique per diagram; useId gives a stable one,
  // but its raw value contains ":" which is invalid in a CSS selector.
  const reactId = useId().replace(/[:]/g, '');
  // Generated once per component instance (lazy useState initialiser, so it
  // survives every re-render) — the id has to stay stable across renders or
  // the render effect below would re-run and redraw the diagram. useId keeps
  // it collision-free between instances; the nonce keeps it unguessable from
  // outside. See idNonce above for why that matters.
  const [nonce] = useState(idNonce);
  const id = `mermaid-${reactId}-${nonce}`;

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          // Diagram text comes from an LLM-written artifact: no click handlers,
          // no raw HTML in labels.
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
          // On a parse failure, mermaid 11 builds its own "Syntax error"
          // graphic, serializes it, and only then throws — after the point
          // where it would otherwise remove the temp DOM node it drew into.
          // Without this flag that node (appended straight to
          // document.body, not into this component's tree) leaks
          // permanently; with it, mermaid removes the node before
          // rethrowing (verified against the installed version).
          suppressErrorRendering: true,
        });
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => { cancelled = true; };
  }, [code, dark, id]);

  if (failed) {
    return (
      <div>
        <div className="whiphand-markdown-diagram-error">Could not render this diagram.</div>
        <CodeBlock language="mermaid" code={code} fallbackFor="diagram" />
      </div>
    );
  }
  if (!svg) return <CodeBlock language="mermaid" code={code} fallbackFor="diagram" />;
  // The SVG is mermaid's own output, built from text it parsed itself under
  // securityLevel: 'strict' — not artifact markup passed through.
  return <div className="whiphand-markdown-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
