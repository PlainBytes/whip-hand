/**
 * The remark/rehype stack, built once at module scope. Artifacts are written
 * by LLM CLI runners and tauri.conf.json sets `csp: null`, so the sanitize
 * schema below is the security boundary, not a formality.
 */
import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { remarkFrontmatterTable } from './frontmatter.ts';

export const SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  // Every one of these is already in defaultSchema.tagNames today — this is
  // belt-and-braces, not a widening of what's allowed. Restating them here
  // means a future defaultSchema that drops one (e.g. `details`) fails our
  // own tests instead of silently breaking rendering.
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'kbd', 'sub', 'sup', 'picture'],
  /*
   * `href` is narrowed to what the app can actually open. defaultSchema also
   * allows irc/ircs/xmpp, but Tauri's shell-plugin scope is roughly
   * `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+`, so those schemes rendered
   * as live external links that did nothing when clicked and rejected inside
   * the plugin. Stripping the href here makes Markdown.tsx render them inert
   * instead — an affordance the app cannot honour should not look like one.
   * (`tel:` is left out: the shell scope would take it, but nothing in a
   * plan or a run artifact wants to dial a phone, and the narrower list is
   * the one that cannot surprise us.)
   *
   * `srcSet` is filtered because defaultSchema.protocols covers
   * cite/href/longDesc/src but not srcSet, even though `source` (inside
   * `picture`) allows one. Note what this does *not* do: srcset is a
   * comma-separated candidate list and hast-util-sanitize only tests the
   * start of the attribute value, so `srcset="https://ok.png 1x,
   * https://evil/x 2x"` still passes in full. It stops a `data:`/`javascript:`
   * srcset outright and nothing more — the remaining candidates are the same
   * accepted outbound-fetch risk already recorded for `<img src>` under
   * csp: null, not a closed gap.
   */
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    srcSet: ['http', 'https'],
  },
  /*
   * hast-util-sanitize prefixes every `id` with `user-content-` but leaves
   * `href="#…"` fragments alone — and GFM footnotes already emit that prefix,
   * so the default double-prefixes the target and every in-page anchor dies.
   * Disabling it accepts a small DOM-clobbering risk in exchange for working
   * footnotes and heading anchors.
   *
   * The invariant that keeps this safe is a rule about *our* code, not a
   * claim about the document: ids in the rendered tree are attacker-
   * controlled, so nothing in this app may look a node up by an id it did
   * not itself generate unguessably. That rule is easy to break
   * transitively — mermaid.render() opens with a document-wide
   * getElementById(id)?.remove(), which is why Mermaid.tsx mixes a random
   * nonce into the diagram id rather than using useId's guessable "r0".
   * The same rule is what makes an artifact author supplying their own ids
   * (rehype-slug skips a node that already has one) harmless here.
   */
  clobber: [],
};

export const REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  [remarkFrontmatter, ['yaml']],
  remarkFrontmatterTable,
];

/*
 * Order is load-bearing:
 *   rehypeRaw      parses raw HTML in the source into real nodes
 *   rehypeSanitize removes what we won't allow — must see those real nodes,
 *                  or hostile markup passes through as text and gets parsed
 *                  afterwards
 *   rehypeSlug     runs after sanitize; it skips any heading that already has
 *                  an id, so a raw `<h2 id="...">` written by an artifact
 *                  keeps the author's id rather than getting one of ours.
 *                  That's fine under the same rule as `clobber: []` above:
 *                  ids here are attacker-controlled, and no code in this app
 *                  may look a node up by an id it did not itself generate
 *                  unguessably.
 */
export const REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
  rehypeSlug,
  // Runs after slug (it needs the ids) and after sanitize (so its own markup
  // isn't stripped). The anchor is a pointer-only affordance: aria-hidden and
  // tabIndex: -1 take it out of the accessibility tree and the tab order, so
  // it never pollutes the heading's own accessible name and never leaves a
  // screen-reader user tabbing onto a control that announces nothing.
  // Keyboard and screen-reader users navigate by the heading's id instead,
  // via rehype-slug above.
  [rehypeAutolinkHeadings, {
    behavior: 'append',
    properties: { className: 'whiphand-markdown-anchor', ariaHidden: true, tabIndex: -1 },
    content: { type: 'text', value: '¶' },
  }],
];
