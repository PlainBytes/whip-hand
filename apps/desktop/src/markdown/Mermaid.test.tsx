import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Markdown } from './Markdown.tsx';

// mermaid is never loaded for real under jsdom: it needs layout APIs jsdom
// doesn't implement, and the point of the lazy import is that a document
// without a diagram never pays for it.
//
// The mock's `render` models one specific, verified-against-the-installed-
// mermaid behaviour rather than a plain reject: mermaid 11.17.2 appends a
// temp `<div id="d<id>">` directly to document.body *before* a parse
// failure is thrown, and only removes it first when `suppressErrorRendering`
// was set on `initialize` (mermaid.core.mjs ~1317-1322 in 11.17.2 — a parse
// exception is caught, and the temp node is removed only inside that
// `if (config.suppressErrorRendering)` branch, before rethrowing).
// Reproducing that here means the "no leaked node" test below actually
// exercises whether Mermaid.tsx requests the flag, rather than asserting
// against a fantasy of mermaid's behaviour.
const mermaidState = vi.hoisted(() => ({ suppressErrorRendering: false }));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn((config: { suppressErrorRendering?: boolean }) => {
      mermaidState.suppressErrorRendering = config.suppressErrorRendering === true;
    }),
    render: vi.fn(async (id: string, code: string) => {
      // mermaid.render() opens with removeExistingElements(document, id,
      // 'd' + id, 'i' + id) — three document-wide
      // `getElementById(...)?.remove()` calls (mermaid.core.mjs:1256,
      // called from :1302 in 11.17.2). Reproduced here because it is the
      // whole hazard: our sanitize schema keeps `clobber: []`, so an
      // artifact's own ids reach the DOM unprefixed, and a guessable
      // diagram id would let a document hand mermaid a React-owned node to
      // delete.
      for (const candidate of [id, `d${id}`, `i${id}`]) document.getElementById(candidate)?.remove();
      if (code.includes('not a diagram')) {
        if (!mermaidState.suppressErrorRendering) {
          const leaked = document.createElement('div');
          leaked.id = `d${id}`;
          document.body.appendChild(leaked);
        }
        throw new Error('Parse error');
      }
      return { svg: '<svg data-testid="diagram"></svg>' };
    }),
  },
}));

describe('mermaid fences', () => {
  // vitest doesn't reset mock call history or mermaidState between tests on
  // its own (no clearMocks/restoreMocks configured), so without this the
  // suite's pass/fail would depend on running in file order.
  beforeEach(async () => {
    const mermaid = (await import('mermaid')).default;
    vi.mocked(mermaid.initialize).mockClear();
    vi.mocked(mermaid.render).mockClear();
    mermaidState.suppressErrorRendering = false;
    document.querySelectorAll('[id^="dmermaid-"]').forEach(node => node.remove());
    document.querySelectorAll('[data-decoy="true"]').forEach(node => node.remove());
  });

  it('renders a diagram', async () => {
    render(<Markdown text={'```mermaid\ngraph LR\n  a --> b\n```'} />);
    expect(await screen.findByTestId('diagram')).toBeInTheDocument();
  });

  it('falls back to a code block when the diagram will not parse, and does not leak mermaid\'s temp node into the document', async () => {
    const { container } = render(<Markdown text={'```mermaid\nnot a diagram\n```'} />);
    await waitFor(() => expect(container.querySelector('code')?.textContent).toContain('not a diagram'));
    expect(screen.getByText(/could not render this diagram/i)).toBeInTheDocument();
    // The leaked node (see the mock above) is appended straight to
    // document.body, outside this component's own container — testing
    // library's cleanup() only unmounts the container it rendered, so it
    // would never remove a stray sibling. Only Mermaid.tsx requesting
    // suppressErrorRendering keeps this at zero.
    expect(document.querySelectorAll('[id^="dmermaid-"]').length).toBe(0);
  });

  it('cannot have its diagram id guessed by the document it is rendering', async () => {
    // React 18's useId is a module-global counter rendered in base 32
    // (":r0:", ":r1:", …), so the id was `mermaid-r<n>` and an artifact
    // could simply write `<div id="mermaid-r0">` next to a fence and have
    // mermaid delete a node React owns — which throws NotFoundError on the
    // next reconcile of that subtree. Planting the whole low range rather
    // than a single id because the counter's value here depends on how many
    // useId calls this file has already made.
    const decoyIds = Array.from({ length: 256 }, (_, i) => `mermaid-r${i.toString(32)}`);
    for (const id of decoyIds) {
      const decoy = document.createElement('div');
      decoy.id = id;
      decoy.dataset.decoy = 'true';
      document.body.appendChild(decoy);
    }

    render(<Markdown text={'```mermaid\ngraph LR\n  a --> b\n```'} />);
    // The diagram really rendered, so the mock's removeExistingElements
    // (see above) really ran — this is not passing on an absence.
    expect(await screen.findByTestId('diagram')).toBeInTheDocument();

    const survivors = decoyIds.filter(id => document.getElementById(id) !== null);
    expect(survivors).toHaveLength(decoyIds.length);
  });

  it('does not touch mermaid for a document with no diagram', async () => {
    const mermaid = (await import('mermaid')).default;
    render(<Markdown text={'```ts\nconst x = 1;\n```'} />);
    // Positive proof the fence actually took the CodeBlock path (the
    // language bar renders the fence's language), not merely an absence
    // check on mermaid.
    expect(screen.getByText('ts')).toBeInTheDocument();
    // render() flushes React effects synchronously, but Mermaid's effect
    // only reaches mermaid.render() after `await import('mermaid')`
    // resolves — at least one microtask later. Asserting on the very next
    // line (as a prior version of this test did) would pass whether or not
    // this fence were mis-routed to <Mermaid>, since mermaid.render()
    // wouldn't have had a chance to run yet either way. Flushing a real
    // tick first was confirmed to matter: temporarily routing the 'ts'
    // fence to <Mermaid> made this assertion fail only after this await was
    // added, and passed regardless of routing without it.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mermaid.render).not.toHaveBeenCalled();
  });
});
