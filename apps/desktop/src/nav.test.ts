import { describe, expect, it } from 'vitest';
import { PAGES, isPageAvailable, pageDef, pagesInGroup, requiresWorkspace, resolvePersistedPage } from './nav.ts';

describe('nav registry', () => {
  it('has unique page ids', () => {
    expect(new Set(PAGES.map(p => p.id)).size).toBe(PAGES.length);
  });

  it('gates every page that reads a workspace path', () => {
    expect(PAGES.filter(p => p.requiresWorkspace).map(p => p.id))
      .toEqual(['runs', 'workflows', 'files', 'workspace-settings']);
  });

  it('puts every page in exactly one group', () => {
    const grouped = [...pagesInGroup('workspace'), ...pagesInGroup('app')];
    expect(grouped).toHaveLength(PAGES.length);
    expect(new Set(grouped.map(p => p.id)).size).toBe(PAGES.length);
  });

  it('gates exactly the workspace group', () => {
    expect(pagesInGroup('workspace').every(p => p.requiresWorkspace)).toBe(true);
    expect(pagesInGroup('app').some(p => p.requiresWorkspace)).toBe(false);
  });

  it('fails closed for an id it does not know', () => {
    expect(pageDef('bogus')).toBeUndefined();
    expect(requiresWorkspace('bogus')).toBe(true);
  });

  it('resolves a persisted page, and reports nothing usable as null', () => {
    expect(resolvePersistedPage('workflows')).toBe('workflows');
    // 'settings' used to name the combined page; its bulk was the workspace
    // config form, so that is where it restores to.
    expect(resolvePersistedPage('settings')).toBe('workspace-settings');
    // 'recipes' is the page's pre-rename id.
    expect(resolvePersistedPage('recipes')).toBe('workflows');
    // 'new-run' was a tab once; it must not resurrect as a page id.
    expect(resolvePersistedPage('new-run')).toBeNull();
    expect(resolvePersistedPage(null)).toBeNull();
  });
});

const BROWSER = { localFiles: false } as const;

describe('capability filtering', () => {
  it('hides the Files page where there is no local filesystem', () => {
    const desktop = pagesInGroup('workspace').map(p => p.id);
    const browser = pagesInGroup('workspace', BROWSER).map(p => p.id);

    expect(desktop).toContain('files');
    expect(browser).not.toContain('files');
    // Nothing else changes: every other page reaches the agent over RPC.
    expect(browser).toEqual(desktop.filter(id => id !== 'files'));
  });

  it('leaves the app group alone', () => {
    expect(pagesInGroup('app', BROWSER)).toEqual(pagesInGroup('app'));
  });

  it('refuses to restore a persisted page this host cannot render', () => {
    // Both hosts write lastPage into the SAME app state, so a browser really
    // does get handed 'files' by the desktop.
    expect(resolvePersistedPage('files')).toBe('files');
    expect(resolvePersistedPage('files', BROWSER)).toBeNull();
    expect(resolvePersistedPage('runs', BROWSER)).toBe('runs');
  });

  it('isPageAvailable defaults to the desktop shape', () => {
    const files = pageDef('files')!;
    expect(isPageAvailable(files)).toBe(true);
    expect(isPageAvailable(files, BROWSER)).toBe(false);
  });
});

