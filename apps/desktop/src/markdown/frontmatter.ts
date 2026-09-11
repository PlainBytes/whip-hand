/**
 * Renders a document's leading YAML frontmatter as a metadata table.
 *
 * `remark-frontmatter` parses the block into a `yaml` node, and react-markdown
 * has no component key for one — so without this transform the frontmatter is
 * silently dropped. mdast-util-to-hast already knows how to turn `table` nodes
 * into `<table>`, so emitting mdast here is enough; no rehype work is needed.
 */
import type { Root, RootContent, TableCell, TableRow } from 'mdast';
import { parse as parseYaml } from 'yaml';

function cell(value: string): TableCell {
  return { type: 'tableCell', children: [{ type: 'text', value }] };
}

function row(cells: string[]): TableRow {
  return { type: 'tableRow', children: cells.map(cell) };
}

/** Scalars read as themselves; anything else as compact JSON, never "[object Object]". */
function display(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function remarkFrontmatterTable() {
  return (tree: Root): void => {
    const first = tree.children[0];
    // Only a *leading* block is frontmatter. A yaml node anywhere else is not
    // metadata about the document and is left alone.
    if (!first || first.type !== 'yaml') return;

    let parsed: unknown;
    try {
      parsed = parseYaml(first.value);
    } catch {
      // Showing the raw block beats swallowing it: whoever wrote the artifact
      // can see what failed to parse.
      const fallback: RootContent = { type: 'code', lang: 'yaml', value: first.value };
      tree.children[0] = fallback;
      return;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      tree.children.splice(0, 1);
      return;
    }

    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) {
      tree.children.splice(0, 1);
      return;
    }

    tree.children[0] = {
      type: 'table',
      align: [null, null],
      children: [row(['Key', 'Value']), ...entries.map(([key, value]) => row([key, display(value)]))],
    };
  };
}
