import { describe, expect, it } from 'vitest';
import {
  basename, filterWorkspaces, sortWorkspaces, workspaceColorVar,
} from './workspace-identity.ts';

const ws = (path: string, pinned?: boolean) => ({
  path, lastOpenedAt: '2026-01-01T00:00:00Z', ...(pinned ? { pinned } : {}),
});

describe('basename', () => {
  it('takes the last segment, tolerating trailing and mixed separators', () => {
    expect(basename('/home/u/acme-api')).toBe('acme-api');
    expect(basename('/home/u/acme-api/')).toBe('acme-api');
    expect(basename('C:\\Users\\u\\acme-api')).toBe('acme-api');
    expect(basename('/')).toBe('/');
  });
});

describe('workspaceColorVar', () => {
  it('is stable for a given path', () => {
    // Pinned literals: an accidental reorder of the palette silently
    // rebrands every workspace, which a "returns some token" test misses.
    expect(workspaceColorVar('/home/u/proj')).toBe(workspaceColorVar('/home/u/proj'));
    expect(workspaceColorVar('/home/u/proj')).toMatchInlineSnapshot(`"--colorPalettePinkBorderActive"`);
  });

  it('distinguishes workspaces that share a basename', () => {
    expect(workspaceColorVar('/a/api')).not.toBe(workspaceColorVar('/b/api'));
  });

  it('always names a palette custom property', () => {
    for (const p of ['/a', '/b/c', '/x/y/z', '', 'relative/path']) {
      expect(workspaceColorVar(p)).toMatch(/^--colorPalette[A-Za-z]+BorderActive$/);
    }
  });
});

describe('sortWorkspaces', () => {
  it('puts pinned first and keeps recency within each block', () => {
    const list = [ws('/r1'), ws('/p1', true), ws('/r2'), ws('/p2', true)];
    expect(sortWorkspaces(list).map(r => r.path)).toEqual(['/p1', '/p2', '/r1', '/r2']);
  });
});

describe('filterWorkspaces', () => {
  it('returns everything for an empty query', () => {
    const list = [ws('/a/one'), ws('/b/two')];
    expect(filterWorkspaces(list, '  ')).toHaveLength(2);
  });

  it('is case-insensitive and ranks a label match above a path-only match', () => {
    const list = [ws('/acme/web'), ws('/dev/acme-api')];
    expect(filterWorkspaces(list, 'ACME').map(r => r.path)).toEqual(['/dev/acme-api', '/acme/web']);
  });

  it('drops workspaces that match neither label nor path', () => {
    expect(filterWorkspaces([ws('/a/one'), ws('/b/two')], 'zzz')).toEqual([]);
  });
});
