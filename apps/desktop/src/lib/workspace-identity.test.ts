import { describe, expect, it } from 'vitest';
import {
  basename, filterWorkspaces, nthPinnedWorkspace, previousWorkspace, sortWorkspaces, workspaceColorVar,
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

  it('follows the identity key, so one workspace is one colour however it was spelled', () => {
    const key = 'c:/program files/proj';
    expect(workspaceColorVar('C:\\PROGRA~1\\Proj', key)).toBe(workspaceColorVar('C:\\Program Files\\Proj', key));
    expect(workspaceColorVar('/a', key)).toBe(workspaceColorVar('/b', key));
    // No key (an entry written before keys existed): the path is all there is.
    expect(workspaceColorVar('/home/u/proj')).toBe(workspaceColorVar('/home/u/proj', undefined));
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

describe('previousWorkspace', () => {
  it('skips the open workspace', () => {
    expect(previousWorkspace([ws('/a'), ws('/b'), ws('/c')], { path: '/a' })?.path).toBe('/b');
    expect(previousWorkspace([ws('/a'), ws('/b')], null)?.path).toBe('/a');
  });
  it('is undefined with no other entry', () => {
    expect(previousWorkspace([ws('/a')], { path: '/a' })).toBeUndefined();
    expect(previousWorkspace([], null)).toBeUndefined();
  });
});

describe('nthPinnedWorkspace', () => {
  const recents = [ws('/a'), ws('/x', true), ws('/b'), ws('/y', true)];
  it('counts pinned entries in switcher order', () => {
    expect(nthPinnedWorkspace(recents, 2, null)?.path).toBe('/y');
  });
  it('is undefined when missing or already open', () => {
    expect(nthPinnedWorkspace(recents, 3, null)).toBeUndefined();
    expect(nthPinnedWorkspace(recents, 1, { path: '/x' })).toBeUndefined();
  });
});
