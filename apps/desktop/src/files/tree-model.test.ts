import { describe, expect, it } from 'vitest';
import {
  applyDirError,
  applyDirListing,
  flattenVisible,
  visibleRowValue,
  type TreeNode,
  isHidden,
  joinPath,
  makeRootNode,
  MAX_DIR_ENTRIES,
  parentPath,
  validateName,
  type DirEntry,
  type TreeNodes,
} from './tree-model.ts';

const dir = (name: string): DirEntry => ({ name, isDirectory: true });
const file = (name: string): DirEntry => ({ name, isDirectory: false });

function rootWith(entries: DirEntry[], showHidden = false): TreeNodes {
  return applyDirListing(makeRootNode('/ws'), '/ws', entries, showHidden);
}

describe('joinPath / parentPath', () => {
  it('joins with the separator the parent already uses', () => {
    expect(joinPath('/ws', 'a.md')).toBe('/ws/a.md');
    expect(joinPath('C:\\ws', 'a.md')).toBe('C:\\ws\\a.md');
  });

  it('does not double the separator when the parent ends with one', () => {
    expect(joinPath('/ws/', 'a.md')).toBe('/ws/a.md');
  });

  it('returns the containing directory', () => {
    expect(parentPath('/ws/docs/a.md')).toBe('/ws/docs');
    expect(parentPath('C:\\ws\\a.md')).toBe('C:\\ws');
  });
});

describe('isHidden', () => {
  it('hides dotfiles and known heavy directories', () => {
    expect(isHidden('.git')).toBe(true);
    expect(isHidden('.env')).toBe(true);
    expect(isHidden('node_modules')).toBe(true);
    expect(isHidden('target')).toBe(true);
  });

  it('never hides .whiphand — it is the most relevant directory in the product', () => {
    expect(isHidden('.whiphand')).toBe(false);
  });

  it('does not hide ordinary names', () => {
    expect(isHidden('README.md')).toBe(false);
  });
});

describe('applyDirListing', () => {
  it('creates child nodes with directories first, then case-insensitive by name', () => {
    const nodes = rootWith([file('b.md'), dir('zeta'), file('A.md'), dir('alpha')]);
    expect(nodes['/ws'].children).toEqual(['/ws/alpha', '/ws/zeta', '/ws/A.md', '/ws/b.md']);
    expect(nodes['/ws'].childrenLoaded).toBe(true);
    expect(nodes['/ws/alpha'].kind).toBe('dir');
    expect(nodes['/ws/A.md'].kind).toBe('file');
  });

  it('filters hidden entries but keeps .whiphand when showHidden is false', () => {
    const nodes = rootWith([dir('.git'), dir('.whiphand'), dir('node_modules'), file('README.md')]);
    expect(nodes['/ws'].children).toEqual(['/ws/.whiphand', '/ws/README.md']);
  });

  it('keeps every entry when showHidden is true', () => {
    const nodes = rootWith([dir('.git'), dir('node_modules'), file('README.md')], true);
    expect(nodes['/ws'].children).toEqual(['/ws/.git', '/ws/node_modules', '/ws/README.md']);
  });

  it('preserves an already-loaded child subtree across a re-listing', () => {
    let nodes = rootWith([dir('docs')]);
    nodes = applyDirListing(nodes, '/ws/docs', [file('a.md')], false);
    nodes = applyDirListing(nodes, '/ws', [dir('docs'), file('new.md')], false);
    expect(nodes['/ws/docs'].childrenLoaded).toBe(true);
    expect(nodes['/ws/docs'].children).toEqual(['/ws/docs/a.md']);
    expect(nodes['/ws/docs/a.md']).toBeDefined();
  });

  it('drops a vanished child and every descendant it had', () => {
    let nodes = rootWith([dir('docs')]);
    nodes = applyDirListing(nodes, '/ws/docs', [file('a.md')], false);
    nodes = applyDirListing(nodes, '/ws', [], false);
    expect(nodes['/ws/docs']).toBeUndefined();
    expect(nodes['/ws/docs/a.md']).toBeUndefined();
    expect(nodes['/ws'].children).toEqual([]);
  });

  it('caps a huge directory and records how many were dropped', () => {
    const many = Array.from({ length: MAX_DIR_ENTRIES + 5 }, (_, i) => file(`f${String(i).padStart(5, '0')}.txt`));
    const nodes = rootWith(many);
    expect(nodes['/ws'].children).toHaveLength(MAX_DIR_ENTRIES);
    expect(nodes['/ws'].truncated).toBe(5);
  });

  it('clears a previous error when the directory becomes readable again', () => {
    let nodes = applyDirError(makeRootNode('/ws'), '/ws', 'permission denied');
    expect(nodes['/ws'].error).toBe('permission denied');
    nodes = applyDirListing(nodes, '/ws', [file('a.md')], false);
    expect(nodes['/ws'].error).toBeUndefined();
  });
});

describe('validateName', () => {
  it('accepts an ordinary file name', () => {
    expect(validateName('notes.md')).toBeNull();
  });

  it('rejects empty, dot, dot-dot, separators and NUL', () => {
    expect(validateName('')).toMatch(/name is required/i);
    expect(validateName('   ')).toMatch(/name is required/i);
    expect(validateName('.')).toMatch(/cannot be/i);
    expect(validateName('..')).toMatch(/cannot be/i);
    expect(validateName('a/b')).toMatch(/cannot contain/i);
    expect(validateName('a\\b')).toMatch(/cannot contain/i);
    expect(validateName('a\0b')).toMatch(/cannot contain/i);
  });
});

describe('flattenVisible', () => {
  const node = (path: string, kind: 'dir' | 'file', extra: Partial<TreeNode> = {}): TreeNode => ({
    path, name: path.split('/').pop()!, kind, childrenLoaded: kind === 'dir', ...extra,
  });
  const nodes: TreeNodes = {
    '/ws': node('/ws', 'dir', { children: ['/ws/a', '/ws/b', '/ws/z.md'], truncated: 7 }),
    '/ws/a': node('/ws/a', 'dir', { children: ['/ws/a/1.md', '/ws/a/2.md'], truncated: 3 }),
    '/ws/a/1.md': node('/ws/a/1.md', 'file'),
    '/ws/a/2.md': node('/ws/a/2.md', 'file'),
    '/ws/b': node('/ws/b', 'dir', { error: 'EACCES' }),
    '/ws/z.md': node('/ws/z.md', 'file'),
  };
  const outline = (expanded: string[]) => flattenVisible(nodes, '/ws', expanded)
    .map(row => `${row.level} ${visibleRowValue(row)} ${row.posInSet}/${row.setSize}`);

  it('lists only the root\'s children while nothing is expanded', () => {
    expect(outline([])).toEqual(['1 /ws/a 1/3', '1 /ws/b 2/3', '1 /ws/z.md 3/3']);
  });

  it('puts an expanded folder\'s children under it, one level deeper, with its truncation note last', () => {
    expect(outline(['/ws/a'])).toEqual([
      '1 /ws/a 1/3', '2 /ws/a/1.md 1/3', '2 /ws/a/2.md 2/3', '2 /ws/a::truncated 3/3',
      '1 /ws/b 2/3', '1 /ws/z.md 3/3',
    ]);
  });

  it('shows an unreadable expanded folder as one error row', () => {
    expect(outline(['/ws/b'])).toEqual(['1 /ws/a 1/3', '1 /ws/b 2/3', '2 /ws/b::error 1/1', '1 /ws/z.md 3/3']);
    const error = flattenVisible(nodes, '/ws', ['/ws/b'])[2];
    expect(error).toMatchObject({ kind: 'error', parent: '/ws/b', message: 'EACCES' });
  });

  it('gives children their parent, and the root\'s children none', () => {
    const rows = flattenVisible(nodes, '/ws', ['/ws/a']);
    expect(rows[0]).toMatchObject({ kind: 'node', parent: undefined });
    expect(rows[1]).toMatchObject({ kind: 'node', parent: '/ws/a' });
  });
});
