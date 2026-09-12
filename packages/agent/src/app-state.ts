/**
 * App-level persistence: recent workspaces, window/page/theme, and
 * per-workspace input history. This is a CONVENIENCE CACHE, never a source
 * of truth — everything authoritative stays in each workspace's .whiphand/
 * directory. Deleting this file must lose zero work, so every read path
 * degrades to EMPTY_APP_STATE instead of throwing.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const recentWorkspaceSchema = z.object({
  path: z.string().min(1),
  lastOpenedAt: z.string(),
  /**
   * Pinned workspaces sort to the top of the switcher and are exempt from
   * MAX_RECENT_WORKSPACES. Optional rather than .default(false) so a file
   * written before pinning existed keeps parsing untouched (a schemaVersion
   * bump would make load() discard it as EMPTY_APP_STATE), the on-disk JSON
   * doesn't grow a "pinned": false on every entry, and the inferred type
   * stays assignable from existing two-field literals.
   */
  pinned: z.boolean().optional(),
});
export type RecentWorkspace = z.infer<typeof recentWorkspaceSchema>;

export const windowStateSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  x: z.number().int(),
  y: z.number().int(),
});
export type WindowState = z.infer<typeof windowStateSchema>;

export const themePreferenceSchema = z.enum(['system', 'light', 'dark']);
export type ThemePreference = z.infer<typeof themePreferenceSchema>;

/**
 * Formerly the global default retention cap, applied to any workspace whose
 * own config.yaml didn't set `runs.max_retained`. Retired as a source of
 * truth now that global `config.yaml` layers over `.whiphand/config.yaml` for real
 * (see @whiphand/core's config.ts `mergeConfig`) — a retention policy that silently
 * deletes run history doesn't belong in a cache this header promises is safe
 * to delete. `config-migration.ts` copies a positive value here into global
 * config.yaml once at startup; the field stays in this schema, unread,
 * because dropping it would need a schemaVersion bump, and per this file's
 * header a version mismatch discards the whole file for no reason.
 */
export const runsRetentionSchema = z.object({
  maxPerWorkspace: z.number().int().nonnegative(),
});
export type RunsRetention = z.infer<typeof runsRetentionSchema>;

const workspaceMemorySchema = z.object({
  lastWorkflow: z.string().optional(),
  lastInputs: z.record(z.string(), z.record(z.string(), z.string())),
});
export type WorkspaceMemory = z.infer<typeof workspaceMemorySchema>;

export const appStateSchema = z.object({
  schemaVersion: z.literal(1),
  recentWorkspaces: z.array(recentWorkspaceSchema),
  window: windowStateSchema.nullable(),
  lastPage: z.string().nullable(),
  theme: themePreferenceSchema,
  workspaces: z.record(z.string(), workspaceMemorySchema),
  // .default() rather than .optional(): a file written before this preference
  // existed still parses, and gets the "keep everything" default rather than
  // discarding the whole file as EMPTY_APP_STATE would.
  runsRetention: runsRetentionSchema.default({ maxPerWorkspace: 0 }),
  // .default() rather than .optional(), per the comment above: a file written
  // before this preference existed keeps parsing instead of being discarded
  // wholesale as EMPTY_APP_STATE.
  showOngoingRuns: z.boolean().default(true),
});
export type AppState = z.infer<typeof appStateSchema>;

export const EMPTY_APP_STATE: AppState = {
  schemaVersion: 1,
  recentWorkspaces: [],
  window: null,
  lastPage: null,
  theme: 'system',
  workspaces: {},
  runsRetention: { maxPerWorkspace: 0 },
  showOngoingRuns: true,
};

export const MAX_RECENT_WORKSPACES = 10;

/**
 * Deliberately a near-duplicate of @whiphand/core's config-home.ts
 * `resolveConfigHome` (XDG_DATA_HOME here vs. XDG_CONFIG_HOME there,
 * `.local/share` vs. `.config`) rather than a shared helper — this answers
 * "where does app data live", config-home.ts answers "where does config
 * live", and they should be free to drift apart on purpose. See the comment
 * there for the other half of this cross-reference.
 */
export function resolveAppStatePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.WHIPHAND_APP_STATE_FILE) return env.WHIPHAND_APP_STATE_FILE;
  const dir =
    platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
    : (env.XDG_DATA_HOME ?? join(home, '.local', 'share'));
  return join(dir, 'whiphand', 'app-state.json');
}

/**
 * Prepend `path` (deduped by exact path), newest first. The cap applies to
 * unpinned entries only — pinning a workspace is a promise that it stays in
 * the list however many others you open. Order stays pure recency; showing
 * pinned entries first is presentation, and lives in the frontend's
 * sortWorkspaces().
 */
export function touchRecent(list: RecentWorkspace[], path: string, now: string): RecentWorkspace[] {
  const existing = list.find(r => r.path === path);
  const head: RecentWorkspace = {
    path, lastOpenedAt: now, ...(existing?.pinned ? { pinned: true } : {}),
  };
  const kept: RecentWorkspace[] = [];
  let unpinned = head.pinned ? 0 : 1;
  for (const r of list) {
    if (r.path === path) continue;
    if (r.pinned) kept.push(r);
    else if (unpinned < MAX_RECENT_WORKSPACES) {
      kept.push(r);
      unpinned += 1;
    }
  }
  return [head, ...kept];
}

/** Record that `workflow` just ran in `workspace` with `inputs` (immutable update). */
export function rememberRun(
  state: AppState, workspace: string, workflow: string, inputs: Record<string, string>,
): AppState {
  const memory = state.workspaces[workspace] ?? { lastInputs: {} };
  return {
    ...state,
    workspaces: {
      ...state.workspaces,
      [workspace]: {
        ...memory,
        lastWorkflow: workflow,
        lastInputs: { ...memory.lastInputs, [workflow]: { ...inputs } },
      },
    },
  };
}

/**
 * Lazily-loaded, write-serialized JSON store. Writes are atomic
 * (tmp file + rename) and chained so concurrent mutate() calls can't
 * interleave a stale read-modify-write. A missing or unparseable file is
 * simply EMPTY_APP_STATE (logged to stderr, never thrown): losing this
 * cache is by design cheaper than any failure mode that surfaces to the UI.
 */
export class AppStateStore {
  readonly filePath: string;
  private state: AppState | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * Called after every successful write. Exists because app state is now
   * shared by more than one client: with a browser attached, whichever client
   * changed the theme or reordered the recents is the only one that knows,
   * and the other would keep showing stale values until it restarted.
   * mutate() is the single funnel for every write, so one hook here covers
   * every mutation there will ever be.
   */
  private onChange: ((state: AppState) => void) | undefined;

  constructor(filePath: string, onChange?: (state: AppState) => void) {
    this.filePath = filePath;
    this.onChange = onChange;
  }

  async get(): Promise<AppState> {
    const result = this.chain.then(() => this.load());
    this.chain = result.catch(() => {});
    return result;
  }

  async mutate(fn: (s: AppState) => AppState): Promise<AppState> {
    const result = this.chain.then(async () => {
      const next = fn(await this.load());
      await this.persist(next);
      this.state = next;
      // After the write lands, so a listener never sees state that failed to
      // persist. Never allowed to break the mutation it is reporting.
      try {
        this.onChange?.(next);
      } catch (e) {
        console.error('[whiphand-agent] app state change listener failed:', e);
      }
      return next;
    });
    this.chain = result.catch(() => {});
    return result;
  }

  private async load(): Promise<AppState> {
    if (this.state) return this.state;
    try {
      const parsed = appStateSchema.safeParse(JSON.parse(await readFile(this.filePath, 'utf8')));
      this.state = parsed.success ? parsed.data : structuredClone(EMPTY_APP_STATE);
      if (!parsed.success) console.error(`[whiphand-agent] ignoring invalid app state at ${this.filePath}`);
    } catch {
      this.state = structuredClone(EMPTY_APP_STATE);
    }
    return this.state;
  }

  private async persist(next: AppState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, this.filePath);
  }
}
