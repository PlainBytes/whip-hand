import { describe, expect, it } from 'vitest';
import { createTauriUpdater, noopUpdater, RELEASE_PAGE_URL } from './updater.ts';

describe('createTauriUpdater', () => {
  it('falls back to the no-op updater outside a Tauri webview (no __TAURI_INTERNALS__)', async () => {
    // jsdom gives us a real `window` but never `__TAURI_INTERNALS__` — the same
    // guard notifier.ts uses, so this never attempts to import a Tauri plugin
    // vitest has deliberately kept out of the test graph.
    const updater = createTauriUpdater();
    await expect(updater.check()).resolves.toBeNull();
    await expect(updater.installKind()).resolves.toBe('deb');
    await expect(updater.openReleasePage()).resolves.toBeUndefined();
  });
});

describe('noopUpdater', () => {
  it('reports up to date and a deb install, and does nothing on openReleasePage', async () => {
    await expect(noopUpdater.check()).resolves.toBeNull();
    await expect(noopUpdater.installKind()).resolves.toBe('deb');
    await expect(noopUpdater.openReleasePage()).resolves.toBeUndefined();
  });
});

describe('RELEASE_PAGE_URL', () => {
  it('still carries the <owner> placeholder, which only an operator can resolve', () => {
    // Deliberately pinned: the repo has no remote, so the real owner is not
    // knowable from here, and a release shipping this 404s for every `.deb`
    // user who clicks through. release.yml's guard job blocks a tag while it
    // is unresolved; this makes resolving it a visible, intentional change.
    expect(RELEASE_PAGE_URL).toBe('https://github.com/PlainBytes/whip-hand/releases/latest');
  });
});
