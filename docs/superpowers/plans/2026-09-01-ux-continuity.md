# UX Continuity (F1–F10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop app remember state across launches (recent workspaces, window, theme, inputs), notify on run completion, and add welcome/scaffolding flows — all features F1–F10 of the product definition.

**Architecture:** A versioned JSON app-state file in the OS data dir, owned by `@wp/agent` behind purposeful RPCs (`getAppState`, `touchRecentWorkspace`, `setUiState`, `listRecentRuns`); the webview consumes it via the existing `AgentClient` and never touches the filesystem. Scaffolding (workspace init, workflow template) lives in `@wp/core` and is exposed through **both** the CLI (`mc init`, `mc new-workflow`) and agent RPCs, keeping CLI↔UI parity structural. Tauri-only concerns (window geometry, native notifications, window title) are isolated in guard-wrapped `lib/` modules, mirroring the `TauriTransport` pattern so vitest never loads `@tauri-apps/*`.

**Tech Stack:** Node ≥24 native TS (no build step), zod v4, `node --test` for packages, vitest + Testing Library (jsdom) for `apps/desktop`, Tauri 2 (+ new `tauri-plugin-notification`), Fluent UI v9, zustand.

**Spec:** `docs/product-definition.md`

## Global Constraints

- Node ≥ 24; TypeScript imported directly with explicit `.ts`/`.tsx` extensions (no build step, no `tsc` emit).
- Package tests run with `node --test` + `node:assert/strict`; desktop tests run with `vitest` + `@testing-library/react`. Match the style of the sibling `*.test.ts(x)` file in whichever directory you touch.
- The webview never gets filesystem or arbitrary-path access: all disk I/O goes through `@wp/agent` RPCs (see `packages/agent/src/handlers.ts` readArtifact comments for the posture).
- The app-state file is a convenience cache: corrupt/missing file must degrade to defaults, never crash or block the UI.
- No new npm dependencies except `@tauri-apps/plugin-notification` (Task 8). zod and yaml come via `@wp/core`.
- This machine has **no Rust toolchain**. Rust/Cargo/capability changes are verified by `cargo check` in CI only; `scripts/verify.sh` already warns-and-skips. Never block on compiling `src-tauri` locally.
- Gate for every task: the commands you ran pass. Final gate: `npm run verify` (typecheck, package tests, parity tests, desktop tests, desktop build).
- New CLI surface (Task 11) MUST ship in the same commit as its `apps/desktop/src/parity/ui-actions.ts` entries, or `npm run test:parity` fails.
- Commit after every task; small messages in the repo's existing `feat(scope):` / `fix(scope):` style.

---

### Task 1: App-state module in `@wp/agent`

The persistence foundation: schema, platform path resolution, atomic load/save store, and the pure list-manipulation helpers every later task leans on.

**Files:**
- Create: `packages/agent/src/app-state.ts`
- Test: `packages/agent/src/app-state.test.ts`

**Interfaces:**
- Consumes: nothing new (zod via `@wp/core`'s dependency tree, `node:fs/promises`, `node:path`, `node:os`).
- Produces (later tasks import these exact names from `./app-state.ts`):
  - `appStateSchema`, `recentWorkspaceSchema`, `windowStateSchema`, `themePreferenceSchema` (zod schemas)
  - `type AppState`, `type RecentWorkspace`, `type WindowState`, `type ThemePreference`, `type WorkspaceMemory`
  - `EMPTY_APP_STATE: AppState`
  - `MAX_RECENT_WORKSPACES = 10`
  - `resolveAppStatePath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string`
  - `touchRecent(list: RecentWorkspace[], path: string, now: string): RecentWorkspace[]`
  - `rememberRun(state: AppState, workspace: string, workflow: string, inputs: Record<string, string>): AppState`
  - `class AppStateStore { constructor(filePath: string); readonly filePath: string; get(): Promise<AppState>; mutate(fn: (s: AppState) => AppState): Promise<AppState> }`

- [ ] **Step 1: Write the failing tests**

`packages/agent/src/app-state.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppStateStore, EMPTY_APP_STATE, MAX_RECENT_WORKSPACES,
  rememberRun, resolveAppStatePath, touchRecent,
} from './app-state.ts';

test('resolveAppStatePath honors MC_APP_STATE_FILE override', () => {
  assert.equal(
    resolveAppStatePath({ MC_APP_STATE_FILE: '/x/state.json' }, 'linux', '/home/u'),
    '/x/state.json',
  );
});

test('resolveAppStatePath uses XDG_DATA_HOME on linux, ~/.local/share fallback', () => {
  assert.equal(
    resolveAppStatePath({ XDG_DATA_HOME: '/xdg' }, 'linux', '/home/u'),
    join('/xdg', 'mission-control', 'app-state.json'),
  );
  assert.equal(
    resolveAppStatePath({}, 'linux', '/home/u'),
    join('/home/u', '.local', 'share', 'mission-control', 'app-state.json'),
  );
});

test('resolveAppStatePath picks platform dirs on darwin and win32', () => {
  assert.equal(
    resolveAppStatePath({}, 'darwin', '/Users/u'),
    join('/Users/u', 'Library', 'Application Support', 'mission-control', 'app-state.json'),
  );
  assert.equal(
    resolveAppStatePath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'),
    join('C:\\Users\\u\\AppData\\Roaming', 'mission-control', 'app-state.json'),
  );
});

test('touchRecent prepends, dedupes by path, and caps the list', () => {
  const t1 = touchRecent([], '/a', '2026-01-01T00:00:00Z');
  assert.deepEqual(t1, [{ path: '/a', lastOpenedAt: '2026-01-01T00:00:00Z' }]);

  const t2 = touchRecent(t1, '/b', '2026-01-02T00:00:00Z');
  const t3 = touchRecent(t2, '/a', '2026-01-03T00:00:00Z');
  assert.deepEqual(t3.map(r => r.path), ['/a', '/b']);
  assert.equal(t3[0].lastOpenedAt, '2026-01-03T00:00:00Z');

  let list = t3;
  for (let i = 0; i < MAX_RECENT_WORKSPACES + 3; i++) {
    list = touchRecent(list, `/ws-${i}`, '2026-01-04T00:00:00Z');
  }
  assert.equal(list.length, MAX_RECENT_WORKSPACES);
});

test('rememberRun records lastWorkflow and per-workflow inputs without clobbering other workflows', () => {
  let s = rememberRun(EMPTY_APP_STATE, '/ws', 'feature', { ticket: 'T-1' });
  s = rememberRun(s, '/ws', 'review', { pr: '42' });
  assert.equal(s.workspaces['/ws'].lastWorkflow, 'review');
  assert.deepEqual(s.workspaces['/ws'].lastInputs, {
    feature: { ticket: 'T-1' },
    review: { pr: '42' },
  });
  // input is not mutated
  assert.deepEqual(EMPTY_APP_STATE.workspaces, {});
});

test('AppStateStore round-trips through disk and creates parent dirs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mc-app-state-'));
  const store = new AppStateStore(join(dir, 'nested', 'app-state.json'));
  assert.deepEqual(await store.get(), EMPTY_APP_STATE);

  await store.mutate(s => ({ ...s, lastPage: 'workflows' }));
  const reread = new AppStateStore(store.filePath);
  assert.equal((await reread.get()).lastPage, 'workflows');
  // file is real JSON on disk
  const raw = JSON.parse(await readFile(store.filePath, 'utf8')) as { schemaVersion: number };
  assert.equal(raw.schemaVersion, 1);
});

test('AppStateStore treats a corrupt file as empty instead of throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mc-app-state-'));
  const file = join(dir, 'app-state.json');
  await writeFile(file, 'not json{{{', 'utf8');
  const store = new AppStateStore(file);
  assert.deepEqual(await store.get(), EMPTY_APP_STATE);
});

test('AppStateStore serializes concurrent mutations (no lost updates)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mc-app-state-'));
  const store = new AppStateStore(join(dir, 'app-state.json'));
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.mutate(s => ({ ...s, recentWorkspaces: touchRecent(s.recentWorkspaces, `/ws-${i}`, 'now') })),
    ),
  );
  const final = await store.get();
  assert.equal(final.recentWorkspaces.length, Math.min(20, MAX_RECENT_WORKSPACES));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test packages/agent/src/app-state.test.ts`
Expected: FAIL — module `./app-state.ts` not found.

- [ ] **Step 3: Implement `packages/agent/src/app-state.ts`**

```ts
/**
 * App-level persistence: recent workspaces, window/page/theme, and
 * per-workspace input history. This is a CONVENIENCE CACHE, never a source
 * of truth — everything authoritative stays in each workspace's .mc/
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
});
export type AppState = z.infer<typeof appStateSchema>;

export const EMPTY_APP_STATE: AppState = {
  schemaVersion: 1,
  recentWorkspaces: [],
  window: null,
  lastPage: null,
  theme: 'system',
  workspaces: {},
};

export const MAX_RECENT_WORKSPACES = 10;

export function resolveAppStatePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.MC_APP_STATE_FILE) return env.MC_APP_STATE_FILE;
  const dir =
    platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
    : (env.XDG_DATA_HOME ?? join(home, '.local', 'share'));
  return join(dir, 'mission-control', 'app-state.json');
}

/** Prepend `path` (deduped by exact path), newest first, capped. */
export function touchRecent(list: RecentWorkspace[], path: string, now: string): RecentWorkspace[] {
  return [{ path, lastOpenedAt: now }, ...list.filter(r => r.path !== path)]
    .slice(0, MAX_RECENT_WORKSPACES);
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
  private state: AppState | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath: string) {}

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
      if (!parsed.success) console.error(`[mc-agent] ignoring invalid app state at ${this.filePath}`);
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
```

Note one deliberate deviation from the spec's "unknown fields preserved on rewrite": zod strips unknown keys, and with a single writer plus `schemaVersion` gating future migrations, preservation buys nothing. Documented here so nobody "fixes" it back.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test packages/agent/src/app-state.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add packages/agent/src/app-state.ts packages/agent/src/app-state.test.ts
git commit -m "feat(agent): app-state store — versioned JSON cache in the OS data dir"
```

---

### Task 2: App-state RPCs — `getAppState`, `touchRecentWorkspace`, `setUiState`; auto-remember on `startRun`

**Files:**
- Modify: `packages/agent/src/protocol.ts` (new method schemas + `methods` map entries)
- Modify: `packages/agent/src/handlers.ts` (`HandlersDeps` gains `appState`, three new handlers, `startRun` persists inputs)
- Modify: `packages/agent/src/main.ts` (construct the store)
- Modify: `packages/agent/src/handlers.test.ts` (existing `createHandlers` calls need the new dep)
- Test: `packages/agent/src/handlers.test.ts` (new cases)

**Interfaces:**
- Consumes: Task 1's `AppStateStore`, `appStateSchema`, `recentWorkspaceSchema`, `windowStateSchema`, `themePreferenceSchema`, `touchRecent`, `rememberRun`.
- Produces RPC methods (used by Task 3's client):
  - `getAppState({}) → AppState` — prunes recent workspaces whose directory no longer exists (persisting the pruned list) before returning.
  - `touchRecentWorkspace({ path }) → { recentWorkspaces: RecentWorkspace[] }` — resolves the path, requires it to be an existing directory, prepends it.
  - `setUiState({ window?, lastPage?, theme? }) → { ok: true }` — patch-merge; `window`/`lastPage` accept `null` to clear.
  - `startRun` additionally persists `lastWorkflow` + `lastInputs` for the workspace (fire-and-forget).

- [ ] **Step 1: Add protocol schemas**

In `packages/agent/src/protocol.ts`, import from `./app-state.ts` and add below the existing method schemas (keep the import at the top with the others):

```ts
import {
  appStateSchema, recentWorkspaceSchema, themePreferenceSchema, windowStateSchema,
} from './app-state.ts';
```

```ts
export const getAppStateParams = z.object({}).default({});
export const getAppStateResult = appStateSchema;

export const touchRecentWorkspaceParams = z.object({ path: z.string().min(1) });
export const touchRecentWorkspaceResult = z.object({
  recentWorkspaces: z.array(recentWorkspaceSchema),
});

export const setUiStateParams = z.object({
  window: windowStateSchema.nullable().optional(),
  lastPage: z.string().nullable().optional(),
  theme: themePreferenceSchema.optional(),
});
export const setUiStateResult = z.object({ ok: z.literal(true) });
```

Register in the `methods` map:

```ts
  getAppState: { params: getAppStateParams, result: getAppStateResult },
  touchRecentWorkspace: { params: touchRecentWorkspaceParams, result: touchRecentWorkspaceResult },
  setUiState: { params: setUiStateParams, result: setUiStateResult },
```

And export the types next to the other `z.infer` exports:

```ts
export type GetAppStateParams = z.infer<typeof getAppStateParams>;
export type GetAppStateResult = z.infer<typeof getAppStateResult>;
export type TouchRecentWorkspaceParams = z.infer<typeof touchRecentWorkspaceParams>;
export type TouchRecentWorkspaceResult = z.infer<typeof touchRecentWorkspaceResult>;
export type SetUiStateParams = z.infer<typeof setUiStateParams>;
export type SetUiStateResult = z.infer<typeof setUiStateResult>;
```

- [ ] **Step 2: Write failing handler tests**

Append to `packages/agent/src/handlers.test.ts`, following the file's existing setup style but constructing deps with a temp-file store (adjust the shared helper if the file has one — every existing `createHandlers({ jobs, notify })` call site must become `createHandlers({ jobs, notify, appState })`):

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppStateStore, EMPTY_APP_STATE } from './app-state.ts';

async function tempAppState(): Promise<AppStateStore> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-handlers-'));
  return new AppStateStore(join(dir, 'app-state.json'));
}

test('getAppState returns empty state on first call', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  assert.deepEqual(await handlers.getAppState({}, ctx), EMPTY_APP_STATE);
});

test('touchRecentWorkspace records an existing directory and rejects a non-directory', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const ws = await mkdtemp(join(tmpdir(), 'mc-ws-'));

  const result = await handlers.touchRecentWorkspace({ path: ws }, ctx) as
    { recentWorkspaces: { path: string }[] };
  assert.equal(result.recentWorkspaces[0].path, resolve(ws));

  await assert.rejects(
    () => Promise.resolve(handlers.touchRecentWorkspace({ path: join(ws, 'nope') }, ctx)),
    /not an existing directory/,
  );
});

test('getAppState prunes recent workspaces whose directory vanished', async () => {
  const appState = await tempAppState();
  const ws = await mkdtemp(join(tmpdir(), 'mc-ws-'));
  await appState.mutate(s => ({
    ...s,
    recentWorkspaces: [
      { path: ws, lastOpenedAt: 'now' },
      { path: join(ws, 'gone'), lastOpenedAt: 'now' },
    ],
  }));
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const state = await handlers.getAppState({}, ctx) as { recentWorkspaces: { path: string }[] };
  assert.deepEqual(state.recentWorkspaces.map(r => r.path), [ws]);
});

test('setUiState patch-merges and clears with null', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  await handlers.setUiState({ theme: 'dark', lastPage: 'workflows' }, ctx);
  await handlers.setUiState({ window: { width: 100, height: 80, x: 1, y: 2 } }, ctx);
  let state = await appState.get();
  assert.equal(state.theme, 'dark');
  assert.equal(state.lastPage, 'workflows');
  assert.deepEqual(state.window, { width: 100, height: 80, x: 1, y: 2 });

  await handlers.setUiState({ window: null }, ctx);
  state = await appState.get();
  assert.equal(state.window, null);
  assert.equal(state.theme, 'dark'); // untouched by the partial patch
});
```

(`ctx` is `{ notify: () => {} }`, matching however the file already fakes `RpcContext`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test packages/agent/src/handlers.test.ts`
Expected: FAIL — `appState` not in `HandlersDeps`, handlers missing.

- [ ] **Step 4: Implement in `handlers.ts` and wire `main.ts`**

`handlers.ts` — extend deps and add handlers (plus the `startRun` persistence line):

```ts
import { AppStateStore, rememberRun, touchRecent } from './app-state.ts';
import type { SetUiStateParams, TouchRecentWorkspaceParams } from './protocol.ts';

export interface HandlersDeps {
  jobs: JobManager;
  notify: NotifyFn;
  appState: AppStateStore;
}
```

```ts
  const getAppState: Handler = async () => {
    const state = await deps.appState.get();
    const checks = await Promise.all(state.recentWorkspaces.map(r => fileExists(r.path)));
    const alive = state.recentWorkspaces.filter((_, i) => checks[i]);
    if (alive.length === state.recentWorkspaces.length) return state;
    return deps.appState.mutate(s => ({ ...s, recentWorkspaces: alive }));
  };

  const touchRecentWorkspace: Handler = async (params) => {
    const { path } = params as TouchRecentWorkspaceParams;
    const resolved = resolve(path);
    const stats = await stat(resolved).catch(() => null);
    if (!stats?.isDirectory()) throw new Error(`not an existing directory: ${resolved}`);
    const next = await deps.appState.mutate(s => ({
      ...s,
      recentWorkspaces: touchRecent(s.recentWorkspaces, resolved, new Date().toISOString()),
    }));
    return { recentWorkspaces: next.recentWorkspaces };
  };

  const setUiState: Handler = async (params) => {
    const patch = params as SetUiStateParams;
    await deps.appState.mutate(s => ({
      ...s,
      ...(patch.window !== undefined ? { window: patch.window } : {}),
      ...(patch.lastPage !== undefined ? { lastPage: patch.lastPage } : {}),
      ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
    }));
    return { ok: true as const };
  };
```

In `startRun`, right after `jobs.create(...)` (best-effort — a broken cache must never fail a run):

```ts
    void deps.appState
      .mutate(s => rememberRun(s, resolve(p.workdir), p.workflow, p.inputs ?? {}))
      .catch(() => {});
```

Add `getAppState, touchRecentWorkspace, setUiState` to the returned record. `main.ts`:

```ts
import { AppStateStore, resolveAppStatePath } from './app-state.ts';
// ...
const appState = new AppStateStore(resolveAppStatePath());
const handlers = createHandlers({ jobs, notify, appState });
```

- [ ] **Step 5: Run agent tests, typecheck, commit**

Run: `node --test "packages/agent/src/**/*.test.ts"` then `npm run typecheck`
Expected: PASS (including the pre-existing handlers/main tests you updated for the new dep).

```bash
git add packages/agent/src
git commit -m "feat(agent): getAppState/touchRecentWorkspace/setUiState RPCs; startRun remembers inputs"
```

---

### Task 3: Desktop plumbing — client methods and store slice

**Files:**
- Modify: `apps/desktop/src/agent/client.ts` (`MethodMap` entries)
- Modify: `apps/desktop/src/state/store.ts` (app-state slice; lift `page` into the store)
- Modify: `apps/desktop/src/App.tsx` (use store `page` instead of local `useState` — behavior otherwise unchanged)
- Test: `apps/desktop/src/state/store.test.ts` (new cases)

**Interfaces:**
- Consumes: Task 2's protocol types (`GetAppStateResult`, `TouchRecentWorkspaceParams/Result`, `SetUiStateParams/Result`) imported from `../../../../packages/agent/src/protocol.ts`, and `type AppState`/`RecentWorkspace`/`ThemePreference` from `../../../../packages/agent/src/app-state.ts`.
- Produces (store fields later tasks rely on — exact names):
  - `appState: AppState | null`, `setAppState(state: AppState | null)`
  - `patchAppState(patch: Partial<AppState>)` — shallow local mirror update (no RPC)
  - `restoreDone: boolean`, `setRestoreDone()`
  - `page: string` (default `'runs'`), `setPage(page: string)`
  - `rememberInputsLocal(workspace: string, workflow: string, inputs: Record<string, string>)` — local mirror of the agent's `rememberRun`
- Client: `client.request('getAppState', {})`, `client.request('touchRecentWorkspace', { path })`, `client.request('setUiState', {...})` typed.

- [ ] **Step 1: Write failing store tests**

Append to `apps/desktop/src/state/store.test.ts` (vitest style, matching the file):

```ts
import { EMPTY_APP_STATE } from '../../../../packages/agent/src/app-state.ts';

describe('app-state slice', () => {
  it('starts unrestored with no appState and the runs page', () => {
    const s = useAppStore.getState();
    expect(s.appState).toBeNull();
    expect(s.restoreDone).toBe(false);
    expect(s.page).toBe('runs');
  });

  it('patchAppState shallow-merges onto a loaded state', () => {
    useAppStore.getState().setAppState(EMPTY_APP_STATE);
    useAppStore.getState().patchAppState({ theme: 'dark' });
    expect(useAppStore.getState().appState?.theme).toBe('dark');
    expect(useAppStore.getState().appState?.recentWorkspaces).toEqual([]);
  });

  it('rememberInputsLocal mirrors the agent-side rememberRun shape', () => {
    useAppStore.getState().setAppState(EMPTY_APP_STATE);
    useAppStore.getState().rememberInputsLocal('/ws', 'feature', { ticket: 'T-1' });
    const memory = useAppStore.getState().appState?.workspaces['/ws'];
    expect(memory?.lastWorkflow).toBe('feature');
    expect(memory?.lastInputs.feature).toEqual({ ticket: 'T-1' });
  });
});
```

(If the file resets store state between tests, follow its existing `beforeEach`/`setState` reset pattern and reset the new fields too.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w desktop -- src/state/store.test.ts`
Expected: FAIL — new fields undefined.

- [ ] **Step 3: Implement the slice**

In `store.ts` add to `AppState` (the zustand interface — note the name collision with the agent's `AppState` type: import the agent one as `AppStateData`):

```ts
import type { AppState as AppStateData } from '../../../../packages/agent/src/app-state.ts';
```

```ts
  appState: AppStateData | null;
  setAppState: (state: AppStateData | null) => void;
  patchAppState: (patch: Partial<AppStateData>) => void;
  restoreDone: boolean;
  setRestoreDone: () => void;
  page: string;
  setPage: (page: string) => void;
  rememberInputsLocal: (workspace: string, workflow: string, inputs: Record<string, string>) => void;
```

```ts
  appState: null,
  setAppState: appState => set({ appState }),
  patchAppState: patch => set(state => ({
    appState: state.appState ? { ...state.appState, ...patch } : state.appState,
  })),
  restoreDone: false,
  setRestoreDone: () => set({ restoreDone: true }),
  page: 'runs',
  setPage: page => set({ page }),
  rememberInputsLocal: (workspace, workflow, inputs) => set(state => {
    if (!state.appState) return state;
    const memory = state.appState.workspaces[workspace] ?? { lastInputs: {} };
    return {
      appState: {
        ...state.appState,
        workspaces: {
          ...state.appState.workspaces,
          [workspace]: {
            ...memory,
            lastWorkflow: workflow,
            lastInputs: { ...memory.lastInputs, [workflow]: { ...inputs } },
          },
        },
      },
    };
  }),
```

In `client.ts`, extend `MethodMap`:

```ts
  getAppState: { params: GetAppStateParams; result: GetAppStateResult };
  touchRecentWorkspace: { params: TouchRecentWorkspaceParams; result: TouchRecentWorkspaceResult };
  setUiState: { params: SetUiStateParams; result: SetUiStateResult };
```

In `App.tsx`, replace `const [page, setPage] = useState<PageId>('runs')` with:

```ts
  const page = useAppStore(state => state.page) as PageId;
  const setPage = useAppStore(state => state.setPage);
```

- [ ] **Step 4: Run desktop tests, typecheck, commit**

Run: `npm run test -w desktop` and `npm run typecheck`
Expected: PASS (App.test.tsx keeps passing — page behavior is unchanged, only its home moved).

```bash
git add apps/desktop/src
git commit -m "feat(desktop): app-state store slice + typed app-state RPCs; page lifted to store"
```

---

### Task 4: F1 + F2 — startup restore and recent-workspaces menu

**Files:**
- Create: `apps/desktop/src/lib/use-startup-restore.ts`
- Modify: `apps/desktop/src/App.tsx` (WorkspacePicker → menu; mount the hook)
- Test: `apps/desktop/src/App.test.tsx` (new cases; follow the file's existing MockTransport harness)

**Interfaces:**
- Consumes: `client.request('getAppState'|'touchRecentWorkspace', …)` (Task 3), store fields `appState/setAppState/restoreDone/setRestoreDone/page/setPage/workspacePath/setWorkspacePath/agentStatus`.
- Produces:
  - `useStartupRestore(client: AgentClient): void` — App mounts it once.
  - `openWorkspace(client, path)` exported from the same file: `touchRecentWorkspace` RPC → `setWorkspacePath(resolvedPathFromResult)` + `patchAppState({ recentWorkspaces })`. The picker, welcome page (Task 5), and cross-workspace runs (Task 9) all call this one function.
  - Valid page ids: App passes `PAGES.map(p => p.id)` as the hook's `validPages` argument — no new export needed.

- [ ] **Step 1: Write failing App tests**

In `apps/desktop/src/App.test.tsx`, using the file's existing render/transport helpers (same `respond(transport, method, result)` idea as NewRunPage.test.tsx):

```tsx
it('restores the last workspace and page from getAppState on connect', async () => {
  const { transport } = renderApp();
  await respond(transport, 'hello', { version: '0.0.0', protocolVersion: 1 });
  await respond(transport, 'getAppState', {
    schemaVersion: 1,
    recentWorkspaces: [{ path: '/ws-a', lastOpenedAt: '2026-01-01T00:00:00Z' }],
    window: null,
    lastPage: 'workflows',
    theme: 'system',
    workspaces: {},
  });
  await waitFor(() => expect(useAppStore.getState().workspacePath).toBe('/ws-a'));
  expect(useAppStore.getState().page).toBe('workflows');
  // header shows the workspace by basename
  expect(await screen.findByText('ws-a', { exact: false })).toBeInTheDocument();
});

it('offers recent workspaces in the header menu and switches via touchRecentWorkspace', async () => {
  const { transport } = renderApp();
  await respond(transport, 'hello', { version: '0.0.0', protocolVersion: 1 });
  await respond(transport, 'getAppState', {
    schemaVersion: 1,
    recentWorkspaces: [
      { path: '/ws-a', lastOpenedAt: '2' },
      { path: '/ws-b', lastOpenedAt: '1' },
    ],
    window: null, lastPage: null, theme: 'system', workspaces: {},
  });
  await waitFor(() => expect(useAppStore.getState().workspacePath).toBe('/ws-a'));

  fireEvent.click(screen.getByRole('button', { name: /ws-a/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /ws-b/ }));
  await respond(transport, 'touchRecentWorkspace', {
    recentWorkspaces: [
      { path: '/ws-b', lastOpenedAt: '3' },
      { path: '/ws-a', lastOpenedAt: '2' },
    ],
  });
  await waitFor(() => expect(useAppStore.getState().workspacePath).toBe('/ws-b'));
});
```

(Reset new store fields in the file's `beforeEach`: `useAppStore.setState({ appState: null, restoreDone: false, page: 'runs', workspacePath: null })`.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w desktop -- src/App.test.tsx`
Expected: FAIL — no `getAppState` request is ever sent; no menu.

- [ ] **Step 3: Implement `lib/use-startup-restore.ts`**

```ts
/**
 * One-shot startup restore (F1): once the agent connects, load the app
 * state, adopt theme/page/workspace from it, and flip restoreDone so the
 * welcome page (F3) knows "no workspace" is a real answer rather than
 * "still loading". Also the single place any UI code goes through to open
 * a workspace, so the recent list stays consistent everywhere.
 */
import { useEffect, useRef } from 'react';
import type { AgentClient } from '../agent/client.ts';
import { useAppStore } from '../state/store.ts';

export function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

export async function openWorkspace(client: AgentClient, path: string): Promise<void> {
  const { recentWorkspaces } = await client.request('touchRecentWorkspace', { path });
  const store = useAppStore.getState();
  // The agent resolved the path; adopt its canonical form (list head).
  store.setWorkspacePath(recentWorkspaces[0]?.path ?? path);
  store.patchAppState({ recentWorkspaces });
}

export function useStartupRestore(client: AgentClient, validPages: string[]): void {
  const agentStatus = useAppStore(state => state.agentStatus);
  const started = useRef(false);

  useEffect(() => {
    if (agentStatus !== 'connected' || started.current) return;
    started.current = true;
    void (async () => {
      const store = useAppStore.getState;
      try {
        const state = await client.request('getAppState', {});
        store().setAppState(state);
        if (state.lastPage && validPages.includes(state.lastPage)) store().setPage(state.lastPage);
        const latest = state.recentWorkspaces[0];
        if (!store().workspacePath && latest) store().setWorkspacePath(latest.path);
      } catch {
        // No app state (old agent, broken disk): behave exactly like today.
      } finally {
        store().setRestoreDone();
      }
    })();
  }, [agentStatus, client, validPages]);
}
```

- [ ] **Step 4: Rework `WorkspacePicker` in `App.tsx`**

Replace the `Text` + `Button` pair with a Fluent `Menu`; keep the dialog import for Browse:

```tsx
import { Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider } from '@fluentui/react-components';
import { basename, openWorkspace, useStartupRestore } from './lib/use-startup-restore.ts';
import { useAgentClient } from './agent/agent-context.tsx';

function WorkspacePicker() {
  const client = useAgentClient();
  const workspacePath = useAppStore(state => state.workspacePath);
  const recents = useAppStore(state => state.appState?.recentWorkspaces ?? []);

  async function browse(): Promise<void> {
    const selected = await open({ directory: true });
    if (typeof selected === 'string') await openWorkspace(client, selected);
  }

  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button appearance="secondary">
          {workspacePath ? basename(workspacePath) : 'Open workspace…'}
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {recents.map(r => (
            <MenuItem
              key={r.path}
              secondaryContent={r.path}
              onClick={() => void openWorkspace(client, r.path)}
            >
              {basename(r.path)}
            </MenuItem>
          ))}
          {recents.length > 0 && <MenuDivider />}
          <MenuItem onClick={() => void browse()}>Browse…</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
```

In `App()` add `useStartupRestore(useAgentClient(), PAGES.map(p => p.id));` — App renders inside `AgentClientProvider` (see `main.tsx`), so `useAgentClient()` is available. If it is not (check `main.tsx`), mount the hook in a tiny `<StartupRestore />` child component instead.

Note for `openWorkspace` failures from the menu (workspace deleted since listed): wrap the call sites in `.catch(() => {})` — `getAppState`'s pruning will drop the entry on next launch; silently not switching is acceptable v1 behavior.

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npm run test -w desktop` and `npm run typecheck`
Expected: PASS, including the untouched App.test.tsx cases (they must still pass — the picker's accessible name changed from "Choose workspace…" to "Open workspace…"; update any test that referenced the old label).

```bash
git add apps/desktop/src
git commit -m "feat(desktop): restore last workspace/page on launch; recent-workspaces menu (F1, F2)"
```

---

### Task 5: F3 — Welcome page

**Files:**
- Create: `apps/desktop/src/pages/WelcomePage.tsx`
- Create: `apps/desktop/src/pages/WelcomePage.test.tsx`
- Modify: `apps/desktop/src/App.tsx` (render WelcomePage when no workspace)

**Interfaces:**
- Consumes: `openWorkspace`/`basename` (Task 4), `client.request('doctor', {})` (works with no workspace), store `appState/restoreDone/doctorResult/setDoctorResult`.
- Produces: `WelcomePage()` component, no props. App renders it in `<main>` when `restoreDone && !workspacePath`; before `restoreDone` it renders nothing in main (avoids a welcome flash during restore).

- [ ] **Step 1: Write failing tests**

`apps/desktop/src/pages/WelcomePage.test.tsx` (same harness pattern as NewRunPage.test.tsx):

```tsx
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomePage } from './WelcomePage.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { EMPTY_APP_STATE } from '../../../../packages/agent/src/app-state.ts';

function renderWelcome() {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  render(
    <AgentClientProvider client={client}>
      <WelcomePage />
    </AgentClientProvider>,
  );
  return { transport, client };
}

async function respond(transport: MockTransport, method: string, result: unknown) {
  const req = await waitFor(() => {
    const index = transport.sent.findIndex(line => (JSON.parse(line) as { method: string }).method === method);
    if (index === -1) throw new Error(`${method} not sent yet`);
    return transport.sentRequest(index);
  });
  transport.emitLine({ id: req.id, result });
}

describe('WelcomePage', () => {
  beforeEach(() => {
    useAppStore.setState({
      workspacePath: null, doctorResult: null,
      appState: {
        ...EMPTY_APP_STATE,
        recentWorkspaces: [{ path: '/ws-a', lastOpenedAt: '2026-01-01T00:00:00Z' }],
      },
      restoreDone: true,
    });
  });

  it('lists recent workspaces as clickable cards and opens one via touchRecentWorkspace', async () => {
    const { transport } = renderWelcome();
    fireEvent.click(await screen.findByRole('button', { name: /ws-a/ }));
    await respond(transport, 'touchRecentWorkspace', {
      recentWorkspaces: [{ path: '/ws-a', lastOpenedAt: 'now' }],
    });
    await waitFor(() => expect(useAppStore.getState().workspacePath).toBe('/ws-a'));
  });

  it('shows doctor status inline', async () => {
    const { transport } = renderWelcome();
    await respond(transport, 'doctor', [
      { id: 'claude', installed: true, version: '3.0.0' },
      { id: 'copilot', installed: false },
    ]);
    expect(await screen.findByText(/claude/)).toBeInTheDocument();
    expect(await screen.findByText(/not installed/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w desktop -- src/pages/WelcomePage.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `WelcomePage.tsx`**

```tsx
import { useEffect } from 'react';
import { Badge, Button, Card, CardHeader, Text } from '@fluentui/react-components';
import { open } from '@tauri-apps/plugin-dialog';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { basename, openWorkspace } from '../lib/use-startup-restore.ts';

/**
 * First screen when no workspace is open (F3): recent workspaces as cards,
 * browse, and runner health — instead of five tabs of "choose a workspace"
 * placeholders.
 */
export function WelcomePage() {
  const client = useAgentClient();
  const recents = useAppStore(state => state.appState?.recentWorkspaces ?? []);
  const doctorResult = useAppStore(state => state.doctorResult);
  const setDoctorResult = useAppStore(state => state.setDoctorResult);

  useEffect(() => {
    if (doctorResult !== null) return;
    client.request('doctor', {}).then(setDoctorResult).catch(() => {});
  }, [client, doctorResult, setDoctorResult]);

  async function browse(): Promise<void> {
    const selected = await open({ directory: true });
    if (typeof selected === 'string') await openWorkspace(client, selected).catch(() => {});
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 560, margin: '48px auto' }}>
      <div>
        <Text size={600} weight="semibold">Welcome to Mission Control</Text>
        <br />
        <Text>Open a workspace to run workflows against it.</Text>
      </div>

      {recents.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Text weight="semibold">Recent workspaces</Text>
          {recents.map(r => (
            <Card key={r.path} onClick={() => void openWorkspace(client, r.path).catch(() => {})}>
              <CardHeader
                header={<Button appearance="transparent">{basename(r.path)}</Button>}
                description={<Text size={200}>{r.path}</Text>}
              />
            </Card>
          ))}
        </div>
      )}

      <Button appearance="primary" onClick={() => void browse()}>
        Open workspace…
      </Button>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Text weight="semibold">Runners</Text>
        {(doctorResult ?? []).map(r => (
          <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Text>{r.id}</Text>
            {r.installed
              ? <Badge color="success" appearance="tint">{r.version ?? 'installed'}</Badge>
              : <Badge color="danger" appearance="tint">not installed</Badge>}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire into `App.tsx`**

In `<main>`, before the page switch:

```tsx
{!workspacePath ? (
  restoreDone ? <WelcomePage /> : null
) : runDetailTarget ? (
  /* existing RunDetailPage branch */
) : (
  /* existing page switch */
)}
```

(`workspacePath` and `restoreDone` read from the store at the top of `App()`.) Keep the TabList rendered but it's fine that pages behind it are replaced by Welcome when no workspace is open.

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npm run test -w desktop && npm run typecheck` — App.test.tsx cases that previously asserted per-page "Choose a workspace" placeholders may need updating to expect the welcome screen instead.

```bash
git add apps/desktop/src
git commit -m "feat(desktop): welcome page with recent workspaces and runner health (F3)"
```

---

### Task 6: F4 (part 1) — theme preference and last-page persistence

**Files:**
- Modify: `apps/desktop/src/App.tsx` (theme resolution; persist page on tab select)
- Modify: `apps/desktop/src/pages/SettingsPage.tsx` (app-level Appearance section above the workspace guard)
- Test: `apps/desktop/src/pages/SettingsPage.test.tsx`, `apps/desktop/src/App.test.tsx`

**Interfaces:**
- Consumes: `setUiState` RPC, store `appState/patchAppState/page/setPage`.
- Produces: theme behavior — `appState.theme === 'system'` follows `prefers-color-scheme` (today's behavior), otherwise forced; tab selection fires `setUiState({ lastPage })` best-effort.

- [ ] **Step 1: Write failing tests**

SettingsPage.test.tsx addition:

```tsx
it('offers an app-level theme preference even with no workspace and saves it via setUiState', async () => {
  useAppStore.setState({ workspacePath: null, appState: EMPTY_APP_STATE, restoreDone: true });
  const { transport } = renderSettingsPage(); // file's existing helper
  const dropdown = await screen.findByRole('combobox', { name: /theme/i });
  fireEvent.click(dropdown);
  fireEvent.click(await screen.findByRole('option', { name: 'Dark' }));

  const req = await waitFor(() => {
    const parsed = transport.sentRequest(transport.sent.length - 1);
    if (parsed.method !== 'setUiState') throw new Error('setUiState not sent yet');
    return parsed;
  });
  expect(req.params).toEqual({ theme: 'dark' });
  expect(useAppStore.getState().appState?.theme).toBe('dark');
});
```

App.test.tsx addition:

```tsx
it('persists the selected page via setUiState', async () => {
  const { transport } = renderApp();
  await respond(transport, 'hello', { version: '0.0.0', protocolVersion: 1 });
  await respond(transport, 'getAppState', EMPTY_APP_STATE);
  useAppStore.setState({ workspacePath: '/ws' });

  fireEvent.click(screen.getByRole('tab', { name: 'Workflows' }));
  await waitFor(() => {
    const found = transport.sent
      .map(line => JSON.parse(line) as { method: string; params?: unknown })
      .find(r => r.method === 'setUiState' && (r.params as { lastPage?: string }).lastPage === 'workflows');
    expect(found).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm run test -w desktop -- src/pages/SettingsPage.test.tsx src/App.test.tsx`; expected FAIL.

- [ ] **Step 3: Implement**

`App.tsx` theme resolution (replacing the direct `prefersDark` use):

```ts
  const prefersDark = usePrefersDarkMode();
  const themePref = useAppStore(state => state.appState?.theme ?? 'system');
  const dark = themePref === 'system' ? prefersDark : themePref === 'dark';
  // <FluentProvider theme={dark ? webDarkTheme : webLightTheme} ...>
```

Tab select handler gains persistence (client from `useAgentClient()`):

```ts
onTabSelect={(_event, data) => {
  setRunDetailTarget(null);
  setPage(data.value as PageId);
  void client.request('setUiState', { lastPage: data.value as string }).catch(() => {});
}}
```

`SettingsPage.tsx`: move the `if (!workspacePath)` guard so an "Appearance" block renders first, always:

```tsx
const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

// inside the returned JSX, above workspace settings:
<Field label="Theme">
  <Dropdown
    aria-label="Theme"
    value={THEME_OPTIONS.find(o => o.value === themePref)?.label ?? 'System'}
    selectedOptions={[themePref]}
    onOptionSelect={(_e, data) => {
      const theme = data.optionValue as 'system' | 'light' | 'dark' | undefined;
      if (!theme) return;
      patchAppState({ theme });
      void client.request('setUiState', { theme }).catch(() => {});
    }}
  >
    {THEME_OPTIONS.map(o => <Option key={o.value} value={o.value} text={o.label}>{o.label}</Option>)}
  </Dropdown>
</Field>
{!workspacePath ? (
  <Text>Choose a workspace to edit its settings.</Text>
) : /* existing workspace form */}
```

(`themePref = useAppStore(s => s.appState?.theme ?? 'system')`, `patchAppState` from the store.)

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
npm run test -w desktop && npm run typecheck
git add apps/desktop/src
git commit -m "feat(desktop): theme preference + last-page persistence (F4)"
```

---

### Task 7: F4 (part 2) — window geometry persistence

**Files:**
- Create: `apps/desktop/src/lib/window-state.ts`
- Create: `apps/desktop/src/lib/window-state.test.ts`
- Modify: `apps/desktop/src-tauri/capabilities/default.json` (window permissions)
- Modify: `apps/desktop/src/lib/use-startup-restore.ts` (kick off persistence after state load)

**Interfaces:**
- Consumes: `setUiState` RPC; `WindowState` type; saved `state.window` from the startup restore.
- Produces:
  - `debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void` (pure, tested)
  - `startWindowStatePersistence(client: AgentClient, saved: WindowState | null): Promise<void>` — no-ops outside Tauri (`'__TAURI_INTERNALS__' in window` guard, same idea as TauriTransport keeping `@tauri-apps/*` out of vitest via dynamic import).

- [ ] **Step 1: Write failing debounce test**

`window-state.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { debounce } from './window-state.ts';

describe('debounce', () => {
  it('collapses a burst into one trailing call with the last args', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const d = debounce(spy, 500);
    d(1); d(2); d(3);
    vi.advanceTimersByTime(499);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(3);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm run test -w desktop -- src/lib/window-state.test.ts`; FAIL (module missing).

- [ ] **Step 3: Implement `window-state.ts`**

```ts
/**
 * F4: restore window size/position on launch and persist changes (debounced)
 * via setUiState. All @tauri-apps/api access is behind a runtime guard +
 * dynamic import so vitest (jsdom) never loads it — same posture as
 * TauriTransport.
 */
import type { AgentClient } from '../agent/client.ts';
import type { WindowState } from '../../../../packages/agent/src/app-state.ts';

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...a), ms);
  };
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function startWindowStatePersistence(
  client: AgentClient, saved: WindowState | null,
): Promise<void> {
  if (!inTauri()) return;
  const { getCurrentWindow, PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();

  if (saved) {
    // Best-effort: an off-screen position (monitor unplugged) just lands the
    // window where the OS clamps it; not worth multi-monitor math in v1.
    await win.setSize(new PhysicalSize(saved.width, saved.height)).catch(() => {});
    await win.setPosition(new PhysicalPosition(saved.x, saved.y)).catch(() => {});
  }

  const save = debounce(() => {
    void (async () => {
      const [size, pos] = await Promise.all([win.innerSize(), win.outerPosition()]);
      await client.request('setUiState', {
        window: { width: size.width, height: size.height, x: pos.x, y: pos.y },
      });
    })().catch(() => {});
  }, 500);

  await win.onResized(save);
  await win.onMoved(save);
}
```

In `use-startup-restore.ts`, inside the `try` after `setAppState(state)`:

```ts
void startWindowStatePersistence(client, state.window).catch(() => {});
```

- [ ] **Step 4: Add capabilities**

In `apps/desktop/src-tauri/capabilities/default.json` `permissions`, append:

```json
    "core:window:allow-set-size",
    "core:window:allow-set-position",
    "core:window:allow-inner-size",
    "core:window:allow-outer-position",
    "core:window:allow-set-title"
```

(`allow-set-title` is used by Task 13; adding it here keeps this the only capabilities edit. Window `onResized`/`onMoved` events ride on `core:event:*` which `core:default` already includes. No Rust source changes; CI's `cargo check`/build validates the capability names.)

- [ ] **Step 5: Run tests, typecheck, commit**

```bash
npm run test -w desktop && npm run typecheck
git add apps/desktop/src apps/desktop/src-tauri/capabilities/default.json
git commit -m "feat(desktop): persist and restore window geometry (F4)"
```

---

### Task 8: F6 — desktop notifications when a run finishes or needs input

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (+`tauri-plugin-notification = "2"`), `apps/desktop/src-tauri/src/lib.rs` (+`.plugin(tauri_plugin_notification::init())`), `apps/desktop/src-tauri/capabilities/default.json` (+`"notification:default"`)
- Modify: `apps/desktop/package.json` (`npm install @tauri-apps/plugin-notification -w desktop`)
- Create: `apps/desktop/src/lib/notifier.ts`
- Create: `apps/desktop/src/components/NotificationBridge.tsx`
- Create: `apps/desktop/src/components/NotificationBridge.test.tsx`
- Modify: `apps/desktop/src/App.tsx`, `apps/desktop/src/main.tsx`

**Interfaces:**
- Consumes: `client.onNotification('runStateChanged' | 'ptyStarted' | 'mcEvent', …)`.
- Produces:
  - `type Notifier = (title: string, body: string) => void`; `noopNotifier: Notifier`; `createTauriNotifier(): Notifier` (guarded dynamic import; requests permission on first use; silently no-ops outside Tauri or when denied) — all in `lib/notifier.ts`.
  - `NotificationBridge({ notifier, isWindowFocused? })` component; `App` gains optional prop `notifier?: Notifier` (default `noopNotifier`) and renders the bridge; `main.tsx` passes `createTauriNotifier()`.
- Notification rules (exact copy):
  - `runStateChanged` with status `succeeded` → title `Run succeeded`, body `runId ?? jobId`; `failed` → `Run failed`; `cancelled` → nothing (the user did it).
  - `ptyStarted` → title `Run needs your input`, body `` `Step ${stepId} is waiting in the terminal` ``.
  - `mcEvent` with `event.type === 'run:error'` → title `Run error`, body `event.message`.
  - All suppressed while the window is focused (`isWindowFocused()` default `() => document.hasFocus()`).

- [ ] **Step 1: Rust shell + deps**

- `Cargo.toml` `[dependencies]`: add `tauri-plugin-notification = "2"`.
- `lib.rs`: add `.plugin(tauri_plugin_notification::init())` after the dialog plugin, and extend the header comment's plugin list.
- capabilities `permissions`: add `"notification:default"`.
- Run `npm install @tauri-apps/plugin-notification --workspace apps/desktop`.
- Do NOT attempt `cargo check` (no local toolchain — CI covers it).

- [ ] **Step 2: Write failing bridge tests**

`NotificationBridge.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { NotificationBridge } from './NotificationBridge.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';

function renderBridge(focused: boolean) {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  const notifier = vi.fn();
  render(
    <AgentClientProvider client={client}>
      <NotificationBridge notifier={notifier} isWindowFocused={() => focused} />
    </AgentClientProvider>,
  );
  return { transport, notifier };
}

describe('NotificationBridge', () => {
  it('notifies on run success/failure and pty start when unfocused', () => {
    const { transport, notifier } = renderBridge(false);
    transport.emitLine({ method: 'runStateChanged', params: { jobId: 'j1', runId: 'r1', status: 'succeeded' } });
    transport.emitLine({ method: 'runStateChanged', params: { jobId: 'j2', status: 'failed' } });
    transport.emitLine({ method: 'ptyStarted', params: { jobId: 'j3', stepId: 'plan', cols: 80, rows: 24 } });
    expect(notifier).toHaveBeenCalledWith('Run succeeded', 'r1');
    expect(notifier).toHaveBeenCalledWith('Run failed', 'j2');
    expect(notifier).toHaveBeenCalledWith('Run needs your input', 'Step plan is waiting in the terminal');
  });

  it('stays silent while focused, on running status, and on cancellation', () => {
    const { transport, notifier } = renderBridge(true);
    transport.emitLine({ method: 'runStateChanged', params: { jobId: 'j1', status: 'succeeded' } });
    expect(notifier).not.toHaveBeenCalled();

    const unfocused = renderBridge(false);
    unfocused.transport.emitLine({ method: 'runStateChanged', params: { jobId: 'j1', status: 'running' } });
    unfocused.transport.emitLine({ method: 'runStateChanged', params: { jobId: 'j1', status: 'cancelled' } });
    expect(unfocused.notifier).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify failure** — FAIL (component missing).

- [ ] **Step 4: Implement**

`lib/notifier.ts`:

```ts
/** F6: native notification seam. Tests inject a spy; production uses the Tauri plugin. */
export type Notifier = (title: string, body: string) => void;

export const noopNotifier: Notifier = () => {};

export function createTauriNotifier(): Notifier {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return noopNotifier;
  let permitted: boolean | null = null;
  return (title, body) => {
    void (async () => {
      const api = await import('@tauri-apps/plugin-notification');
      if (permitted === null) {
        permitted = await api.isPermissionGranted();
        if (!permitted) permitted = (await api.requestPermission()) === 'granted';
      }
      if (permitted) api.sendNotification({ title, body });
    })().catch(() => {});
  };
}
```

`components/NotificationBridge.tsx`:

```tsx
import { useEffect } from 'react';
import { useAgentClient } from '../agent/agent-context.tsx';
import type { Notifier } from '../lib/notifier.ts';

export interface NotificationBridgeProps {
  notifier: Notifier;
  /** Injectable for tests; production default asks the DOM. */
  isWindowFocused?: () => boolean;
}

/** Renders nothing; turns agent notifications into OS notifications (F6). */
export function NotificationBridge({
  notifier,
  isWindowFocused = () => document.hasFocus(),
}: NotificationBridgeProps) {
  const client = useAgentClient();

  useEffect(() => {
    const send = (title: string, body: string) => {
      if (!isWindowFocused()) notifier(title, body);
    };
    const unsubscribers = [
      client.onNotification('runStateChanged', p => {
        if (p.status === 'succeeded') send('Run succeeded', p.runId ?? p.jobId);
        if (p.status === 'failed') send('Run failed', p.runId ?? p.jobId);
      }),
      client.onNotification('ptyStarted', p => {
        send('Run needs your input', `Step ${p.stepId} is waiting in the terminal`);
      }),
      client.onNotification('mcEvent', p => {
        if (p.event.type === 'run:error') send('Run error', p.event.message);
      }),
    ];
    return () => unsubscribers.forEach(u => u());
  }, [client, notifier, isWindowFocused]);

  return null;
}
```

`App.tsx`: `export function App({ notifier = noopNotifier }: { notifier?: Notifier } = {})`, render `<NotificationBridge notifier={notifier} />` just inside `FluentProvider`. `main.tsx`: pass `notifier={createTauriNotifier()}`.

- [ ] **Step 5: Run tests, typecheck, commit**

```bash
npm run test -w desktop && npm run typecheck
git add apps/desktop package-lock.json
git commit -m "feat(desktop): native notifications for run completion and needed input (F6)"
```

---

### Task 9: F7 — recent runs across workspaces

**Files:**
- Modify: `packages/agent/src/protocol.ts`, `packages/agent/src/handlers.ts` (+`listRecentRuns`)
- Test: `packages/agent/src/handlers.test.ts`
- Modify: `apps/desktop/src/agent/client.ts` (MethodMap entry)
- Modify: `apps/desktop/src/pages/RunsPage.tsx` (+"All workspaces" toggle)
- Test: `apps/desktop/src/pages/RunsPage.test.tsx`

**Interfaces:**
- Consumes: `AppStateStore.get()`, `coreListRuns`, `loadWorkspaceConfig`, Task 4's `openWorkspace`.
- Produces: RPC `listRecentRuns({ limit? }) → Array<RunSummary & { workspace: string }>` — derived live from the recent-workspaces list (no persisted index; the spec's "run index" is implemented as this derivation, which the spec explicitly allows since authority stays with `run.json`). Sorted by `startedAt` descending; workspaces that fail to read are skipped. Default/max limit 20/100.
- Desktop `RunSummary` gains an optional `workspace?: string` via the existing catchall — client `MethodMap`: `listRecentRuns: { params: ListRecentRunsParams; result: (RunSummary & { workspace: string })[] }`.

- [ ] **Step 1: Protocol**

```ts
export const listRecentRunsParams = z.object({
  limit: z.number().int().positive().max(100).optional(),
}).default({});
export const listRecentRunsResult = z.array(runSummarySchema.extend({ workspace: z.string() }));
export type ListRecentRunsParams = z.infer<typeof listRecentRunsParams>;
```

Register `listRecentRuns: { params: listRecentRunsParams, result: listRecentRunsResult }` in `methods`.

- [ ] **Step 2: Failing handler test**

Add a fixture helper that builds a temp workspace containing one finished run. `coreListRuns` reads `<workdir>/.mc/runs/<runId>/run.json` (dir from `config.artifacts_dir`, default `.mc/runs`) validated against `runManifestSchema` (`packages/core/src/engine/manifest.ts`) — every field below is required by that schema:

```ts
async function makeWorkspaceWithRun(runId: string, startedAt: string): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'mc-recent-'));
  const runDir = join(ws, '.mc', 'runs', runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'run.json'), JSON.stringify({
    version: 1, runId, workflow: 'feature', workdir: ws, dryRun: false,
    pid: process.pid, startedAt, updatedAt: startedAt, endedAt: startedAt,
    status: 'succeeded', ok: true, inputs: {}, sessionIds: {}, steps: [],
  }), 'utf8');
  return ws;
}

test('listRecentRuns merges runs across recent workspaces, newest first', async () => {
  const appState = await tempAppState();
  const wsA = await makeWorkspaceWithRun('run-a', '2026-01-02T00:00:00Z'); // helper per manifest.test.ts fixtures
  const wsB = await makeWorkspaceWithRun('run-b', '2026-01-03T00:00:00Z');
  await appState.mutate(s => ({
    ...s,
    recentWorkspaces: [
      { path: wsA, lastOpenedAt: 'x' },
      { path: wsB, lastOpenedAt: 'x' },
      { path: '/definitely/missing', lastOpenedAt: 'x' },
    ],
  }));
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const runs = await handlers.listRecentRuns({}, ctx) as { runId: string; workspace: string }[];
  assert.deepEqual(runs.map(r => r.runId), ['run-b', 'run-a']);
  assert.equal(runs[0].workspace, wsB);
});
```

- [ ] **Step 3: Run to verify failure**, then implement the handler:

```ts
  const listRecentRuns: Handler = async (params) => {
    const { limit = 20 } = params as { limit?: number };
    const state = await deps.appState.get();
    const all: Array<Record<string, unknown>> = [];
    for (const ws of state.recentWorkspaces) {
      try {
        const config = await loadWorkspaceConfig(ws.path);
        for (const run of await coreListRuns(ws.path, config)) {
          all.push({ ...run, workspace: ws.path });
        }
      } catch {
        // unreadable/vanished workspace: it prunes on next getAppState; skip here
      }
    }
    all.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
    return all.slice(0, limit);
  };
```

Run: `node --test packages/agent/src/handlers.test.ts` — PASS.

- [ ] **Step 4: RunsPage toggle (failing test first)**

RunsPage.test.tsx addition (using the file's harness):

```tsx
it('switches to a cross-workspace list and opens a run in its own workspace', async () => {
  const { transport, onSelectRun } = renderRunsPage();
  await respond(transport, 'listRuns', []);

  fireEvent.click(screen.getByRole('switch', { name: /all workspaces/i }));
  await respond(transport, 'listRecentRuns', [
    { runId: 'r-other', runDir: '/other/.mc/runs/r-other', status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', workspace: '/other' },
  ]);
  fireEvent.click(await screen.findByText('r-other'));
  await respond(transport, 'touchRecentWorkspace', {
    recentWorkspaces: [{ path: '/other', lastOpenedAt: 'now' }],
  });
  await waitFor(() => expect(useAppStore.getState().workspacePath).toBe('/other'));
  await waitFor(() => expect(onSelectRun).toHaveBeenCalledWith('r-other'));
});
```

Implementation sketch for `RunsPage.tsx`: local `const [allWorkspaces, setAllWorkspaces] = useState(false)` + `const [recentRuns, setRecentRuns] = useState<(RunSummary & { workspace: string })[]>([])`; a `Switch` labeled "All workspaces"; when toggled on, `client.request('listRecentRuns', {})` fills `recentRuns`; render them with an extra Workspace column (`basename(entry.workspace)`); row click handler:

```ts
async function openRecentRun(entry: RunSummary & { workspace: string }): Promise<void> {
  if (entry.workspace !== workspacePath) await openWorkspace(client, entry.workspace).catch(() => {});
  onSelectRun(entry.runId);
}
```

- [ ] **Step 5: Run tests, typecheck, commit**

```bash
node --test "packages/agent/src/**/*.test.ts" && npm run test -w desktop && npm run typecheck
git add packages/agent/src apps/desktop/src
git commit -m "feat: recent runs across workspaces via listRecentRuns (F7)"
```

---

### Task 10: F5 — input prefill and “Run again”

**Files:**
- Modify: `apps/desktop/src/pages/NewRunPage.tsx` (prefill from app-state memory; consume a pending run-again request; local mirror after start)
- Modify: `apps/desktop/src/pages/RunDetailPage.tsx` (+"Run again" button)
- Modify: `apps/desktop/src/state/store.ts` (+`pendingRunAgain`)
- Modify: `apps/desktop/src/App.tsx` (route the callback)
- Test: `apps/desktop/src/pages/NewRunPage.test.tsx`, `apps/desktop/src/pages/RunDetailPage.test.tsx`

**Interfaces:**
- Consumes: store `appState.workspaces[workspacePath]` (`lastWorkflow`, `lastInputs`), `rememberInputsLocal` (Task 3); run manifest fields `workflow: string` and `inputs: Record<string, string>` (present on every known-shape `RunSummary`, see `packages/core/src/engine/manifest.ts`).
- Produces:
  - Store: `pendingRunAgain: { workflow: string; inputs: Record<string, string> } | null`, `setPendingRunAgain(v)`.
  - `RunDetailPage` new prop `onRunAgain: (workflow: string, inputs: Record<string, string>) => void`; App wires it to `setPendingRunAgain(...)` + `setPage('new-run')` + `setRunDetailTarget(null)`.
- Prefill precedence in NewRunPage's `selectWorkflow(name)`: workflow declared defaults ← remembered `lastInputs[name]` (only keys the workflow still declares) ← `pendingRunAgain.inputs` when it named this workflow. On mount with workflows loaded and nothing selected: auto-select `pendingRunAgain?.workflow ?? memory?.lastWorkflow` when present in the list; consume (clear) `pendingRunAgain` after applying.

- [ ] **Step 1: Failing NewRunPage tests**

```tsx
it('prefills inputs from the workspace memory for that workflow', async () => {
  useAppStore.setState({
    appState: {
      ...EMPTY_APP_STATE,
      workspaces: { '/ws': { lastWorkflow: 'ship-feature', lastInputs: { 'ship-feature': { ticket: 'T-9', gone: 'x' } } } },
    },
  });
  const { transport } = renderNewRunPage();
  await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
  await respond(transport, 'listRuns', []);
  // lastWorkflow auto-selected — no manual dropdown interaction
  expect(await screen.findByLabelText('Ticket ID', { exact: false })).toHaveValue('T-9');
  expect(screen.getByLabelText('branch', { exact: false })).toHaveValue('main'); // declared default kept
  expect(screen.queryByLabelText('gone', { exact: false })).toBeNull(); // undeclared key dropped
});

it('applies a pending run-again request over everything else and clears it', async () => {
  useAppStore.setState({
    appState: EMPTY_APP_STATE,
    pendingRunAgain: { workflow: 'ship-feature', inputs: { ticket: 'T-42', branch: 'hotfix' } },
  });
  const { transport } = renderNewRunPage();
  await respond(transport, 'listWorkflows', [SCRIPTED_WORKFLOW]);
  await respond(transport, 'listRuns', []);
  expect(await screen.findByLabelText('Ticket ID', { exact: false })).toHaveValue('T-42');
  expect(screen.getByLabelText('branch', { exact: false })).toHaveValue('hotfix');
  expect(useAppStore.getState().pendingRunAgain).toBeNull();
});
```

And a RunDetailPage test:

```tsx
it('offers Run again for a finished run with a known workflow', async () => {
  const onRunAgain = vi.fn();
  const { transport } = renderRunDetail({ runId: 'r1', onRunAgain }); // extend the file's helper
  await respond(transport, 'getRun', {
    runId: 'r1', runDir: '/ws/.mc/runs/r1', status: 'succeeded',
    workflow: 'ship-feature', inputs: { ticket: 'T-1' }, artifacts: [],
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Run again' }));
  expect(onRunAgain).toHaveBeenCalledWith('ship-feature', { ticket: 'T-1' });
});
```

- [ ] **Step 2: Run to verify failure**, then implement.

Store: add `pendingRunAgain: null` + setter. NewRunPage — replace `selectWorkflow` and add an auto-select effect:

```ts
  const memory = useAppStore(state =>
    state.workspacePath ? state.appState?.workspaces[state.workspacePath] : undefined);
  const pendingRunAgain = useAppStore(state => state.pendingRunAgain);
  const setPendingRunAgain = useAppStore(state => state.setPendingRunAgain);
  const rememberInputsLocal = useAppStore(state => state.rememberInputsLocal);

  function selectWorkflow(name: string, override?: Record<string, string>): void {
    setSelectedName(name);
    setStartError(null);
    const entry = workflows.find(r => r.name === name);
    const values: Record<string, string> = {};
    if (entry?.workflow?.inputs) {
      const remembered = memory?.lastInputs[name] ?? {};
      for (const [key, input] of Object.entries(entry.workflow.inputs)) {
        values[key] = override?.[key] ?? remembered[key] ?? input.default ?? '';
      }
    }
    setValues(values);
  }

  // Auto-select once workflows arrive: an explicit run-again beats the remembered workflow.
  useEffect(() => {
    if (selectedName || workflows.length === 0) return;
    if (pendingRunAgain && workflows.some(r => r.name === pendingRunAgain.workflow && !r.error)) {
      selectWorkflow(pendingRunAgain.workflow, pendingRunAgain.inputs);
      setPendingRunAgain(null);
    } else if (memory?.lastWorkflow && workflows.some(r => r.name === memory.lastWorkflow && !r.error)) {
      selectWorkflow(memory.lastWorkflow);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per workflows arrival
  }, [workflows]);
```

In `handleStart`, after a successful `startRun` (before `onStarted`): `if (workspacePath && selectedWorkflow) rememberInputsLocal(workspacePath, selectedWorkflow.name, values);` (the agent persisted the same thing server-side).

RunDetailPage: add `onRunAgain` to props; next to the Cancel button:

```tsx
{!isRunning && typeof manifest?.workflow === 'string' && (
  <Button
    appearance="secondary"
    onClick={() => onRunAgain(manifest.workflow as string, (manifest.inputs ?? {}) as Record<string, string>)}
  >
    Run again
  </Button>
)}
```

App.tsx wiring:

```tsx
<RunDetailPage
  /* existing props */
  onRunAgain={(workflow, inputs) => {
    useAppStore.getState().setPendingRunAgain({ workflow, inputs });
    setRunDetailTarget(null);
    setPage('new-run');
  }}
/>
```

- [ ] **Step 3: Run tests, typecheck, commit**

```bash
npm run test -w desktop && npm run typecheck
git add apps/desktop/src
git commit -m "feat(desktop): prefill last inputs and run-again (F5)"
```

---

### Task 11: F8 + F9 core & CLI — scaffold module, `mc init`, `mc new-workflow`, parity entries

**Files:**
- Create: `packages/core/src/scaffold.ts`, `packages/core/src/scaffold.test.ts`
- Modify: `packages/core/src/index.ts` (export `initWorkspace`, `createWorkflow`, `workflowTemplate`, `WORKFLOW_NAME_RE`)
- Modify: `packages/cli/src/program.ts` (two new commands)
- Modify: `apps/desktop/src/parity/ui-actions.ts` (entries for both commands — same commit, or parity fails)

**Interfaces:**
- Produces (exported from `@wp/core`):
  - `WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/`
  - `workflowTemplate(name: string): string` — commented YAML for the canonical plan→execute→review workflow; MUST parse via `parseWorkflow`.
  - `createWorkflow(workdir: string, name: string): Promise<{ path: string }>` — validates the name, `mkdir -p .mc/workflows`, refuses to overwrite (`wx` flag → error `workflow '<name>' already exists`).
  - `initWorkspace(workdir: string): Promise<{ created: string[] }>` — idempotent; writes `.mc/config.yaml` (from `DEFAULT_CONFIG`) if missing and a `feature` example workflow if `.mc/workflows` has no YAML files; `created` holds workdir-relative paths of what was actually written.

- [ ] **Step 1: Failing core tests**

`packages/core/src/scaffold.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflow, initWorkspace, workflowTemplate } from './scaffold.ts';
import { parseWorkflow } from './schema.ts';
import { loadWorkspaceConfig } from './config.ts';

test('workflowTemplate produces a parseable canonical workflow', () => {
  const workflow = parseWorkflow(workflowTemplate('my-flow'));
  assert.equal(workflow.name, 'my-flow');
  assert.equal(workflow.steps.length, 3);
  assert.equal(workflow.steps[0].mode, 'interactive');
  assert.equal(workflow.steps[2].verdict, true);
});

test('createWorkflow writes the file, refuses overwrite, validates the name', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'mc-scaffold-'));
  const { path } = await createWorkflow(ws, 'my-flow');
  assert.equal(path, join(ws, '.mc', 'workflows', 'my-flow.yaml'));
  parseWorkflow(await readFile(path, 'utf8')); // valid on disk

  await assert.rejects(() => createWorkflow(ws, 'my-flow'), /already exists/);
  await assert.rejects(() => createWorkflow(ws, 'Bad Name!'), /invalid workflow name/);
});

test('initWorkspace creates config + example workflow once, then is a no-op', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'mc-scaffold-'));
  const first = await initWorkspace(ws);
  assert.deepEqual(first.created.sort(), [
    join('.mc', 'config.yaml'),
    join('.mc', 'workflows', 'feature.yaml'),
  ]);
  await loadWorkspaceConfig(ws); // parses
  const second = await initWorkspace(ws);
  assert.deepEqual(second.created, []);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test packages/core/src/scaffold.test.ts`; FAIL.

- [ ] **Step 3: Implement `packages/core/src/scaffold.ts`**

```ts
/**
 * Workspace/workflow scaffolding (product def F8/F9). Shared by the CLI
 * (`mc init`, `mc new-workflow`) and the desktop app (via @wp/agent RPCs) so
 * the UI never grows an ability the CLI lacks.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { DEFAULT_CONFIG } from './config.ts';

export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function workflowTemplate(name: string): string {
  return `# ${name} — plan interactively, implement headlessly, review with a verdict.
# Reference: docs/design.md
name: ${name}
inputs:
  feature:
    required: true
    prompt: What are we building?
steps:
  - id: plan          # live terminal chat; artifact harvested afterwards
    runner: claude
    mode: interactive
    writes: false
    output: plan.md
    prompt: |
      We are planning: {{ inputs.feature }}. Work with me on a plan. Do not modify files.
  - id: execute       # headless; may write
    runner: claude
    mode: headless
    writes: true
    inputs: [plan]
    output: execute-report.md
    prompt: Implement the attached plan.
  - id: review        # headless, read-only, must end with VERDICT: PASS|FAIL
    runner: claude
    mode: headless
    writes: false
    verdict: true
    inputs: [plan]
    output: review.md
    prompt: Review the implementation against the attached plan.
`;
}

export async function createWorkflow(workdir: string, name: string): Promise<{ path: string }> {
  if (!WORKFLOW_NAME_RE.test(name)) {
    throw new Error(`invalid workflow name '${name}' (want ${WORKFLOW_NAME_RE})`);
  }
  const dir = join(workdir, '.mc', 'workflows');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.yaml`);
  try {
    await writeFile(path, workflowTemplate(name), { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`workflow '${name}' already exists at ${path}`);
    }
    throw e;
  }
  return { path };
}

export async function initWorkspace(workdir: string): Promise<{ created: string[] }> {
  const created: string[] = [];
  const configRel = join('.mc', 'config.yaml');
  await mkdir(join(workdir, '.mc'), { recursive: true });
  try {
    await writeFile(join(workdir, configRel), stringifyYaml(DEFAULT_CONFIG), { encoding: 'utf8', flag: 'wx' });
    created.push(configRel);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const hasWorkflows = await readdir(join(workdir, '.mc', 'workflows'))
    .then(entries => entries.some(f => f.endsWith('.yaml') || f.endsWith('.yml')))
    .catch(() => false);
  if (!hasWorkflows) {
    await createWorkflow(workdir, 'feature');
    created.push(join('.mc', 'workflows', 'feature.yaml'));
  }
  return { created };
}
```

Export from `packages/core/src/index.ts` alongside the existing exports. Run the tests — PASS. (If `parseWorkflow` rejects the template, fix the template until the test passes — the test is the contract.)

- [ ] **Step 4: CLI commands + parity entries (one commit)**

`packages/cli/src/program.ts` (imports: `initWorkspace`, `createWorkflow` from `@wp/core`; `resolve` from `node:path`):

```ts
  program.command('init')
    .description('initialize .mc/ (config + example workflow) in the working folder')
    .option('-C <dir>', 'working folder', process.cwd())
    .action(async (opts: { C: string }) => {
      const { created } = await initWorkspace(resolve(opts.C));
      console.log(created.length > 0
        ? created.map(p => `created ${p}`).join('\n')
        : 'workspace already initialized — nothing to do');
    });

  program.command('new-workflow')
    .description('scaffold a workflow into .mc/workflows/')
    .argument('<name>', 'workflow name (lowercase, digits, - and _)')
    .option('-C <dir>', 'working folder', process.cwd())
    .action(async (name: string, opts: { C: string }) => {
      const { path } = await createWorkflow(resolve(opts.C), name);
      console.log(`created ${path}`);
    });
```

`apps/desktop/src/parity/ui-actions.ts` (labels reference Task 12's UI, built next — the parity test only checks the mapping exists):

```ts
  init: {
    // WorkflowsPage empty state's "Set up this workspace" button (Task 12).
    _command: 'workflows:setUpWorkspaceButton',
    '-C': 'header:workspacePicker',
  },
  'new-workflow': {
    // WorkflowsPage's "New workflow" dialog (Task 12).
    _command: 'workflows:newWorkflowButton',
    '<name>': 'workflows:newWorkflowNameInput',
    '-C': 'header:workspacePicker',
  },
```

- [ ] **Step 5: Run all package + parity tests, typecheck, commit**

```bash
npm test && npm run test:parity && npm run typecheck
git add packages/core/src packages/cli/src apps/desktop/src/parity/ui-actions.ts
git commit -m "feat(core,cli): workspace init and workflow scaffolding — mc init, mc new-workflow (F8, F9)"
```

---

### Task 12: F8 + F9 agent & UI — RPCs and WorkflowsPage flows

**Files:**
- Modify: `packages/agent/src/protocol.ts`, `packages/agent/src/handlers.ts` (+`createWorkflow`, `initWorkspace`)
- Test: `packages/agent/src/handlers.test.ts`
- Modify: `apps/desktop/src/agent/client.ts` (MethodMap)
- Modify: `apps/desktop/src/pages/WorkflowsPage.tsx` (New-workflow dialog; set-up empty state)
- Test: `apps/desktop/src/pages/WorkflowsPage.test.tsx` (create if missing)

**Interfaces:**
- Consumes: `createWorkflow`/`initWorkspace` from `@wp/core` (Task 11).
- Produces RPCs:
  - `createWorkflow({ workdir, name }) → { path: string }`
  - `initWorkspace({ workdir }) → { created: string[] }`

- [ ] **Step 1: Protocol + failing handler tests**

Protocol:

```ts
export const createWorkflowParams = z.object({ workdir: z.string().min(1), name: z.string().min(1) });
export const createWorkflowResult = z.object({ path: z.string() });
export const initWorkspaceParams = z.object({ workdir: z.string().min(1) });
export const initWorkspaceResult = z.object({ created: z.array(z.string()) });
```

(+ `methods` entries + type exports, same pattern as Task 2.)

Handler tests:

```ts
test('initWorkspace then createWorkflow scaffold a usable workspace', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const ws = await mkdtemp(join(tmpdir(), 'mc-init-'));

  const init = await handlers.initWorkspace({ workdir: ws }, ctx) as { created: string[] };
  assert.equal(init.created.length, 2);

  const rec = await handlers.createWorkflow({ workdir: ws, name: 'review-pr' }, ctx) as { path: string };
  const listed = await handlers.listWorkflows({ workdir: ws }, ctx) as { name: string }[];
  assert.deepEqual(listed.map(r => r.name).sort(), ['feature', 'review-pr']);
  assert.ok(rec.path.endsWith(join('.mc', 'workflows', 'review-pr.yaml')));
});
```

- [ ] **Step 2: Verify failure, implement handlers**

```ts
import { createWorkflow as coreCreateWorkflow, initWorkspace as coreInitWorkspace } from '@wp/core';

  const createWorkflow: Handler = async (params) => {
    const { workdir, name } = params as { workdir: string; name: string };
    return coreCreateWorkflow(resolve(workdir), name);
  };

  const initWorkspace: Handler = async (params) => {
    const { workdir } = params as { workdir: string };
    return coreInitWorkspace(resolve(workdir));
  };
```

Add both to the returned record. Run agent tests — PASS.

- [ ] **Step 3: WorkflowsPage UI (failing tests first)**

Tests (create `WorkflowsPage.test.tsx` with the same harness shape as `NewRunPage.test.tsx`: a `renderWorkflowsPage()` helper rendering `<WorkflowsPage />` inside `AgentClientProvider` over a `MockTransport`, the same `respond()` helper, and `useAppStore.setState({ workspacePath: '/ws', workflows: [] })` in `beforeEach`). Fixture for these tests — note `respond()` resolves the *first* matching request, so for the post-setup refresh match by position or extend the helper to skip already-answered ids:

```tsx
const FEATURE_WORKFLOW = {
  name: 'feature',
  path: '/ws/.mc/workflows/feature.yaml',
  workflow: {
    name: 'feature',
    inputs: { feature: { required: true, prompt: 'What are we building?' } },
    steps: [
      { id: 'plan', runner: 'claude', mode: 'interactive', writes: false, prompt: 'p', output: 'plan.md' },
      { id: 'execute', runner: 'claude', mode: 'headless', writes: true, prompt: 'p', output: 'execute-report.md' },
      { id: 'review', runner: 'claude', mode: 'headless', writes: false, verdict: true, prompt: 'p', output: 'review.md' },
    ],
  },
};
```

```tsx
it('offers workspace setup when the workspace has no workflows', async () => {
  const { transport } = renderWorkflowsPage();
  await respond(transport, 'listWorkflows', []);
  fireEvent.click(await screen.findByRole('button', { name: /set up this workspace/i }));
  await respond(transport, 'initWorkspace', { created: ['.mc/config.yaml', '.mc/workflows/feature.yaml'] });
  // page refreshes the list afterwards — answer the SECOND listWorkflows request
  await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
  expect(await screen.findByText('feature', { exact: false })).toBeInTheDocument();
});

it('creates a workflow through the New workflow dialog', async () => {
  const { transport } = renderWorkflowsPage();
  await respond(transport, 'listWorkflows', [FEATURE_WORKFLOW]);
  fireEvent.click(screen.getByRole('button', { name: /new workflow/i }));
  fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: 'review-pr' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  const req = await waitFor(() => {
    const parsed = transport.sentRequest(transport.sent.length - 1);
    if (parsed.method !== 'createWorkflow') throw new Error('createWorkflow not sent yet');
    return parsed;
  });
  expect(req.params).toEqual({ workdir: '/ws', name: 'review-pr' });
});
```

Implementation: add to WorkflowsPage a header row (`New workflow` Button + Dialog holding a name `Input` labeled "Name", `Create`/`Cancel`; on create → `client.request('createWorkflow', {workdir, name})`, close, re-run the existing `listWorkflows` effect via a `reloadKey` state bumped on success; show RPC errors in a `MessageBar` inside the dialog). Replace the `workflows.length === 0` return with:

```tsx
  if (workflows.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
        <Text>No workflows found in this workspace.</Text>
        <Button appearance="primary" onClick={() => void setUp()}>
          Set up this workspace
        </Button>
        {setupError && <MessageBar intent="error"><MessageBarBody>{setupError}</MessageBarBody></MessageBar>}
      </div>
    );
  }
```

where `setUp()` calls `initWorkspace` then bumps `reloadKey` (add `reloadKey` to the list-effect deps).

- [ ] **Step 4: Run everything, typecheck, commit**

```bash
node --test "packages/agent/src/**/*.test.ts" && npm run test -w desktop && npm run typecheck && npm run test:parity
git add packages/agent/src apps/desktop/src
git commit -m "feat(agent,desktop): workspace setup and new-workflow flows in the UI (F8, F9)"
```

---

### Task 13: F10 — window-title attention indicator

**Files:**
- Modify: `apps/desktop/src/lib/window-state.ts` (+`formatWindowTitle`, `applyWindowTitle`)
- Test: `apps/desktop/src/lib/window-state.test.ts`
- Modify: `apps/desktop/src/App.tsx` (effect computing counts from `jobs`)

**Interfaces:**
- Consumes: store `jobs` (`JobState.finished`, `JobState.ptyActive`); `core:window:allow-set-title` capability (added in Task 7).
- Produces:
  - `formatWindowTitle(running: number, needsInput: number): string` — `'Mission Control'` when both 0; `` `⌨ input needed — Mission Control` `` when `needsInput > 0`; else `` `▶ ${running} running — Mission Control` ``.
  - `applyWindowTitle(title: string): void` — guarded `getCurrentWindow().setTitle(title)`, no-op outside Tauri.

- [ ] **Step 1: Failing test**

```ts
import { formatWindowTitle } from './window-state.ts';

describe('formatWindowTitle', () => {
  it('reflects idle, running, and needs-input states', () => {
    expect(formatWindowTitle(0, 0)).toBe('Mission Control');
    expect(formatWindowTitle(2, 0)).toBe('▶ 2 running — Mission Control');
    expect(formatWindowTitle(2, 1)).toBe('⌨ input needed — Mission Control');
  });
});
```

- [ ] **Step 2: Verify failure, implement**

```ts
export function formatWindowTitle(running: number, needsInput: number): string {
  if (needsInput > 0) return '⌨ input needed — Mission Control';
  if (running > 0) return `▶ ${running} running — Mission Control`;
  return 'Mission Control';
}

export function applyWindowTitle(title: string): void {
  if (!inTauri()) return;
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
    .catch(() => {});
}
```

App.tsx effect:

```ts
  const jobs = useAppStore(state => state.jobs);
  useEffect(() => {
    const active = Object.values(jobs).filter(j => !j.finished);
    applyWindowTitle(formatWindowTitle(active.length, active.filter(j => j.ptyActive).length));
  }, [jobs]);
```

- [ ] **Step 3: Run tests, typecheck, commit**

```bash
npm run test -w desktop && npm run typecheck
git add apps/desktop/src
git commit -m "feat(desktop): window-title attention indicator for active runs (F10)"
```

---

### Task 14: Full gate and documentation sync

**Files:**
- Modify: `README.md` (mention `mc init` / `mc new-workflow` under Quickstart)
- Modify: `docs/product-definition.md` (status line: implemented, note the two documented deviations — no unknown-field preservation in app-state; F7 derives from recent workspaces instead of a persisted index)

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`
Expected: typecheck, all package tests, parity tests, desktop tests, and the desktop vite build all pass; cargo step warns-and-skips (no local Rust). Fix anything red before proceeding.

- [ ] **Step 2: Update docs**

README Quickstart gains:

```bash
mc init                                # scaffold .mc/ (config + example workflow) in this folder
mc new-workflow review-pr                # scaffold .mc/workflows/review-pr.yaml
```

Product definition header: change `Status: draft for iteration` to `Status: implemented (see docs/superpowers/plans/2026-09-01-ux-continuity.md); deviations noted inline`, and add the two deviation notes at the relevant sections.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/product-definition.md
git commit -m "docs: UX continuity features shipped; note plan deviations"
```

- [ ] **Step 4: Report the CI-deferred items**

Tell the human partner explicitly: Tauri-side changes (notification plugin registration, new capabilities, window APIs) have **not** been compiled or exercised locally — they need CI's `cargo check` plus one real `npm run tauri dev -w desktop` session to verify: window geometry restore, a native notification firing, the title indicator, and the notification permission prompt.
