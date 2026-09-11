import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import type { Root } from 'mdast';
import { remarkFrontmatterTable } from './frontmatter.ts';

function transform(markdown: string): Root {
  const processor = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkFrontmatterTable);
  return processor.runSync(processor.parse(markdown)) as Root;
}

describe('remarkFrontmatterTable', () => {
  it('turns a leading yaml block into a two-column table', () => {
    const tree = transform('---\nrun: oauth\nverdict: PASS\n---\n\n# Title\n');
    const table = tree.children[0];
    expect(table.type).toBe('table');
    // Header row plus one row per key.
    expect((table as any).children).toHaveLength(3);
    const firstValue = (table as any).children[1].children[1].children[0];
    expect(firstValue.value).toBe('oauth');
  });

  it('renders non-scalar values as compact JSON rather than [object Object]', () => {
    const tree = transform('---\nsteps: [plan, execute]\n---\n');
    const cell = (tree.children[0] as any).children[1].children[1].children[0];
    expect(cell.value).toBe('["plan","execute"]');
  });

  it('falls back to a code block when the yaml will not parse', () => {
    const tree = transform('---\n: : :\n---\n');
    expect(tree.children[0].type).toBe('code');
    expect((tree.children[0] as any).lang).toBe('yaml');
  });

  it('leaves an empty frontmatter block out of the document entirely', () => {
    const tree = transform('---\n---\n\nBody\n');
    expect(tree.children.map(n => n.type)).toEqual(['paragraph']);
  });

  it('ignores a yaml node that is not the first child', () => {
    // Nothing else produces a mid-document yaml node, but the guard keeps the
    // transform honest if some future plugin does.
    const tree = transform('# Title\n\n---\nrun: oauth\n---\n');
    expect(tree.children.some(n => n.type === 'table')).toBe(false);
  });
});
