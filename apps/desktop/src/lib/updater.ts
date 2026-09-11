/**
 * Auto-update seam: tests inject a mock; production uses the Tauri updater,
 * process, and shell plugins. Mirrors notifier.ts's pattern — the
 * `__TAURI_INTERNALS__` guard plus dynamic `import()` keeps `@tauri-apps/*`
 * out of anything vitest loads, since jsdom never has that global.
 *
 * `installKind()` exists because the updater plugin can tell every install
 * that a new version exists, but only two shapes have anywhere to put it:
 * Tauri's updater cannot install into a `.deb` — that install kind gets a
 * link to the release page instead of a button that would fail.
 */
/**
 * Where a `.deb` install is sent instead of self-updating. updater.test.ts pins
 * the string so changing it is a deliberate edit rather than a drive-by.
 *
 * The owner is the account the repo lives under today; it moves when the repo
 * does, and GitHub redirects the old slug in the meantime. Keep it in step with
 * `plugins.updater.endpoints` in tauri.conf.json — that one is the endpoint an
 * already-installed client polls, so it going stale is the expensive half. See
 * README, "Releases and auto-update".
 */
export const RELEASE_PAGE_URL = 'https://github.com/PlainBytes/whip-hand/releases/latest';

export type InstallKind = 'appimage' | 'nsis' | 'deb';

export interface AvailableUpdate {
  version: string;
  /** Downloads, installs, and relaunches the app. Never resolves on success — the process restarts. */
  install(): Promise<void>;
}

export interface Updater {
  installKind(): Promise<InstallKind>;
  /** `null` means already up to date. */
  check(): Promise<AvailableUpdate | null>;
  /** The `.deb` install's alternative to `install()` — a link, not an in-place update. */
  openReleasePage(): Promise<void>;
}

export const noopUpdater: Updater = {
  async installKind() {
    return 'deb';
  },
  async check() {
    return null;
  },
  async openReleasePage() {},
};

export function createTauriUpdater(): Updater {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return noopUpdater;

  return {
    async installKind(): Promise<InstallKind> {
      const { invoke } = await import('@tauri-apps/api/core');
      return (await invoke('install_kind')) as InstallKind;
    },

    async check(): Promise<AvailableUpdate | null> {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) return null;
      return {
        version: update.version,
        async install(): Promise<void> {
          await update.downloadAndInstall();
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        },
      };
    },

    async openReleasePage(): Promise<void> {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(RELEASE_PAGE_URL);
    },
  };
}
