/**
 * The app's pages, as data. Replaces the ad-hoc PAGES array that used to
 * live in App.tsx, so nav rendering, the workspace gate and startup restore
 * all read one source instead of three hand-kept lists.
 */
import {
  BookRegular, FolderRegular, OptionsRegular, PlayRegular, PulseRegular,
  SettingsRegular, StethoscopeRegular, type FluentIcon,
} from '@fluentui/react-icons';

export type PageId =
  | 'runs' | 'workflows' | 'files' | 'workspace-settings'
  | 'activity' | 'doctor' | 'preferences';

/** Which block of the sidebar a page sits in: the workspace's, or the app's. */
export type NavGroup = 'workspace' | 'app';

export interface PageDef {
  readonly id: PageId;
  readonly label: string;
  readonly group: NavGroup;
  /**
   * False means the page reads no `workspacePath` and calls only
   * workspace-free RPCs (`doctor`, `getAppState`, `setUiState`,
   * `listRecentRuns`), so it works with no workspace open. This column
   * replaces the prose that used to justify each exemption inline in the
   * gate. It tracks `group` today, and is kept separate because it answers a
   * different question: `group` is where the item is drawn, this is whether
   * the page can run at all.
   */
  readonly requiresWorkspace: boolean;
  /**
   * True for a page that reads the LOCAL filesystem through the root
   * FileSystemPort, rather than reaching everything through the agent's RPC.
   * Such a page cannot work in a browser on another machine, so it is filtered
   * out of nav there rather than offered and then failing.
   */
  readonly requiresLocalFiles?: boolean;
  readonly icon: FluentIcon;
}

/**
 * The slice of AppCapabilities nav needs. Declared structurally rather than
 * imported from capabilities.tsx so this module stays free of React.
 */
export interface NavCapabilities {
  readonly localFiles: boolean;
}

const DESKTOP_NAV_CAPABILITIES: NavCapabilities = { localFiles: true };

export const PAGES: readonly PageDef[] = [
  { id: 'runs', label: 'Runs', group: 'workspace', requiresWorkspace: true, icon: PlayRegular },
  { id: 'workflows', label: 'Workflows', group: 'workspace', requiresWorkspace: true, icon: BookRegular },
  {
    id: 'files', label: 'Files', group: 'workspace',
    requiresWorkspace: true, requiresLocalFiles: true, icon: FolderRegular,
  },
  {
    id: 'workspace-settings', label: 'Settings', group: 'workspace',
    requiresWorkspace: true, icon: SettingsRegular,
  },
  { id: 'activity', label: 'Activity', group: 'app', requiresWorkspace: false, icon: PulseRegular },
  { id: 'doctor', label: 'Doctor', group: 'app', requiresWorkspace: false, icon: StethoscopeRegular },
  {
    id: 'preferences', label: 'Preferences', group: 'app',
    requiresWorkspace: false, icon: OptionsRegular,
  },
];

export const DEFAULT_PAGE: PageId = 'runs';

export function pageDef(id: string): PageDef | undefined {
  return PAGES.find(p => p.id === id);
}

/** Unknown ids fail closed: a page we can't vouch for is gated, not crashed. */
export function requiresWorkspace(id: string): boolean {
  return pageDef(id)?.requiresWorkspace ?? true;
}

export function isPageAvailable(def: PageDef, caps: NavCapabilities = DESKTOP_NAV_CAPABILITIES): boolean {
  return !def.requiresLocalFiles || caps.localFiles;
}

export function pagesInGroup(
  group: NavGroup, caps: NavCapabilities = DESKTOP_NAV_CAPABILITIES,
): readonly PageDef[] {
  return PAGES.filter(p => p.group === group && isPageAvailable(p, caps));
}

/**
 * Page ids that a previously persisted `lastPage` may still name. 'settings'
 * was the combined page whose bulk was the workspace config form — theme was
 * one dropdown bolted on top — so it restores to the workspace half. 'recipes'
 * is the page's pre-rename id (recipes → workflows).
 */
const RENAMED_PAGE_IDS: Record<string, PageId> = {
  settings: 'workspace-settings',
  recipes: 'workflows',
};

/**
 * null means "nothing usable persisted" — the caller keeps the store default.
 *
 * Capability-aware because both hosts write `lastPage` into the SAME app
 * state: a browser restoring a desktop-written `lastPage: 'files'` would
 * otherwise land on a page it cannot render.
 */
export function resolvePersistedPage(
  lastPage: string | null | undefined, caps: NavCapabilities = DESKTOP_NAV_CAPABILITIES,
): PageId | null {
  if (!lastPage) return null;
  const id = RENAMED_PAGE_IDS[lastPage] ?? pageDef(lastPage)?.id ?? null;
  if (id === null) return null;
  const def = pageDef(id);
  return def && isPageAvailable(def, caps) ? id : null;
}
