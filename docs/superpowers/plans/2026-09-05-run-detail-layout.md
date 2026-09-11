# Run Detail Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `RunDetailPage` into a fixed-height frame with sticky chrome and Terminal / Artifacts / Logs tabs, and make artifacts editable through a new `writeArtifact` RPC.

**Architecture:** The agent grows a symmetric write door for artifacts, sharing one containment helper with `readArtifact`. The desktop app wraps those two RPCs in a `FileSystemPort` adapter, which lets the Artifacts tab reuse the Files page's `FileTree` and `FilePreview` verbatim. The page itself becomes a flex column that never scrolls; the active tab panel takes all remaining height.

**Tech Stack:** TypeScript, zod (protocol schemas), node:test (agent), React 18 + Fluent UI v9 + vitest/@testing-library (desktop), xterm.js.

**Spec:** `docs/superpowers/specs/2026-09-05-run-detail-layout-design.md`

## Global Constraints

- **Node >= 24**, ESM only, all relative imports carry the `.ts` / `.tsx` extension.
- **Agent tests** are `node:test`: `npm test` at the repo root.
- **Desktop tests** are vitest: `npm run test -w desktop`.
- **Full gate** is `npm run verify` (typecheck, agent tests, parity, desktop tests, desktop build, cargo check).
- **No `@tauri-apps` import may enter the desktop test graph** — `vitest.config.ts` deliberately excludes it. New desktop modules talk to seams (`FileSystemPort`, `AgentClient`), never to Tauri.
- **`parity/` is not touched.** The new RPC has no CLI counterpart.
- **Artifacts stay name-addressed.** No handler may accept a client-supplied filesystem path.
- **`MAX_ARTIFACT_BYTES`** is `2 * 1024 * 1024` and applies to reads *and* writes.

## Two deviations from the spec, decided while planning

1. **The artifact tree is built directly, not through `applyDirListing`.** The spec named that helper, but it derives child paths with `joinPath(dirPath, name)`, which is only equal to the artifact's real `path` when artifacts sit directly in the run dir. Building nodes straight from the manifest's `{name, path}` pairs keeps the node path and the artifact name in guaranteed correspondence, which is what the `ArtifactFileSystem` lookup depends on. `makeRootNode` is still reused.
2. **No explicit "refit on becoming visible" call.** `ResizeObserver` already fires when an element leaves `display: none` and regains a non-zero box, so the zero-size guard alone covers both directions. An extra manual refit would be dead code.

## Known gap this plan does not close

An unsaved artifact edit survives a tab switch (panels stay mounted) but is lost if the user leaves the Run Detail page entirely. The Files page guards that case through `filesDirty` in the store and `App.tsx`'s `UnsavedChangesDialog`; wiring artifacts into the same guard is a separate change, and Task 9 passes a no-op `onDirtyChange` deliberately rather than half-wiring it. Raise it after this lands.

---

### Task 1: Protocol schemas for artifact read/write

**Files:**
- Modify: `packages/agent/src/protocol.ts:166-169` (result schema), `:220-243` (methods map), `:275-276` (type exports)
- Test: `packages/agent/src/protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `readArtifactResult` = `{ content: string; size: number; mtimeMs: number }`; `writeArtifactParams` = `{ workdir: string; runId: string; name: string; content: string; expectedMtimeMs?: number }`; `writeArtifactResult` = `{ mtimeMs: number }`; types `WriteArtifactParams`, `WriteArtifactResult`; `methods.writeArtifact`.

- [ ] **Step 1: Write the failing test**

Append to `packages/agent/src/protocol.test.ts`:

```ts
test('readArtifactResult carries the stat fields the editor needs', () => {
  const parsed = readArtifactResult.parse({ content: 'hi', size: 2, mtimeMs: 1725000000000 });
  assert.deepEqual(parsed, { content: 'hi', size: 2, mtimeMs: 1725000000000 });
  assert.throws(() => readArtifactResult.parse({ content: 'hi' }));
});

test('writeArtifactParams accepts a name-addressed write, with expectedMtimeMs optional', () => {
  const base = { workdir: '/ws', runId: 'run-1', name: 'review.md', content: '# hi' };
  assert.deepEqual(writeArtifactParams.parse(base), { ...base });
  assert.equal(writeArtifactParams.parse({ ...base, expectedMtimeMs: 5 }).expectedMtimeMs, 5);
  // Empty content is a legitimate write; an empty name is not.
  assert.equal(writeArtifactParams.parse({ ...base, content: '' }).content, '');
  assert.throws(() => writeArtifactParams.parse({ ...base, name: '' }));
});

test('writeArtifact is registered in the methods map', () => {
  assert.ok('writeArtifact' in methods);
});
```

Add `readArtifactResult`, `writeArtifactParams`, `methods` to the existing import from `./protocol.ts` at the top of that file if they are not already there.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/agent/src/protocol.test.ts`
Expected: FAIL — `writeArtifactParams` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/agent/src/protocol.ts`, replace line 169 (`export const readArtifactResult = z.object({ content: z.string() });`) with:

```ts
/**
 * `size` and `mtimeMs` are what the desktop's FilePreview compares before
 * saving, so an artifact edited in the app can never silently clobber a write
 * the run itself made in the meantime.
 */
export const readArtifactResult = z.object({
  content: z.string(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
});

/**
 * The symmetric write door. `name` is resolved exactly the way readArtifact
 * resolves it — against the run's own listing, never as a client path — so
 * this widens what may be done to an artifact, never which files are reachable.
 */
export const writeArtifactParams = z.object({
  workdir: z.string().min(1), runId: z.string().min(1), name: z.string().min(1),
  content: z.string(),
  /** Rejects the write when the file changed since the client last read it. */
  expectedMtimeMs: z.number().nonnegative().optional(),
});
export const writeArtifactResult = z.object({ mtimeMs: z.number().nonnegative() });
```

In the `methods` map, directly after the `readArtifact` line:

```ts
  writeArtifact: { params: writeArtifactParams, result: writeArtifactResult },
```

With the other type exports, after `ReadArtifactResult`:

```ts
export type WriteArtifactParams = z.infer<typeof writeArtifactParams>;
export type WriteArtifactResult = z.infer<typeof writeArtifactResult>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/agent/src/protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/protocol.ts packages/agent/src/protocol.test.ts
git commit -m "feat(agent): protocol schemas for artifact stat fields and writeArtifact"
```

---

### Task 2: Shared containment helper, and readArtifact returns stat fields

**Files:**
- Modify: `packages/agent/src/handlers.ts:232-271` (readArtifact)
- Test: `packages/agent/src/handlers.test.ts`

**Interfaces:**
- Consumes: `readArtifactResult` from Task 1.
- Produces: module-private `resolveArtifactPath(workdir: string, runId: string, name: string): Promise<string>` — returns the realpath of the named artifact, throwing if the run or name is unknown or the path escapes the run directory. Task 3 calls it.

- [ ] **Step 1: Write the failing test**

Append to `packages/agent/src/handlers.test.ts`:

```ts
test('readArtifact: reports the size and mtime of the file it read', async () => {
  const { readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();

  const onDisk = await stat(join(workdir, '.mc', 'runs', runId, 'review.md'));
  const result = await readArtifact({ workdir, runId, name: 'review.md' }, { notify: () => {} }) as
    { content: string; size: number; mtimeMs: number };

  assert.equal(result.size, onDisk.size);
  assert.equal(result.mtimeMs, onDisk.mtimeMs);
});
```

Add `stat` to the `node:fs/promises` import at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/agent/src/handlers.test.ts`
Expected: FAIL — `result.size` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `packages/agent/src/handlers.ts`, add this helper next to `MAX_ARTIFACT_BYTES` (module scope, above `createHandlers`):

```ts
/**
 * Resolves an artifact *name* to a real path inside its run directory, or
 * throws. The single place both readArtifact and writeArtifact get their
 * containment from: two hand-written copies of this check would drift, and
 * the copy that drifts is the one nobody re-reads.
 */
async function resolveArtifactPath(workdir: string, runId: string, name: string): Promise<string> {
  const resolved = resolve(workdir);
  const config = await loadWorkspaceConfig(resolved);
  const detail = await coreGetRun(resolved, config, runId);
  if (!detail) throw new Error(`unknown run '${runId}'`);

  // `name` is looked up against getRun's own directory listing — never a
  // client-supplied path — so a client can only ever name a file that's
  // actually present in this run's directory in the first place.
  const artifact = detail.artifacts.find(a => a.name === name);
  if (!artifact) throw new Error(`unknown artifact '${name}' for run '${runId}'`);

  // Defense in depth: even though artifact.path is derived from that same
  // listing, never touch a resolved path that isn't actually inside the run's
  // own directory. Compare *realpaths* (not just resolve()'d ones) so a
  // symlink planted inside the run dir that points outside it cannot slip
  // through the containment check.
  let runDirReal: string;
  let resolvedPath: string;
  try {
    runDirReal = await realpath(detail.runDir);
    resolvedPath = await realpath(resolve(artifact.path));
  } catch {
    // The artifact existed when getRun listed the directory but is gone (or
    // unreadable) now — report it the same way as never having existed.
    throw new Error(`unknown artifact '${name}' for run '${runId}'`);
  }
  if (resolvedPath !== runDirReal && !resolvedPath.startsWith(runDirReal + sep)) {
    throw new Error(`artifact '${name}' resolves outside its run directory`);
  }
  return resolvedPath;
}
```

Then replace the whole body of the `readArtifact` handler with:

```ts
  const readArtifact: Handler = async (params): Promise<ReadArtifactResult> => {
    const { workdir, runId, name } = params as ReadArtifactParams;
    const resolvedPath = await resolveArtifactPath(workdir, runId, name);

    const stats = await stat(resolvedPath);
    if (stats.size > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `artifact '${name}' is too large to preview (${stats.size} bytes, max ${MAX_ARTIFACT_BYTES})`,
      );
    }
    const content = await readFile(resolvedPath, 'utf8');
    return { content, size: stats.size, mtimeMs: stats.mtimeMs };
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/agent/src/handlers.test.ts`
Expected: PASS — the new test, plus all pre-existing `readArtifact` containment tests still green (they now exercise the helper).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/handlers.ts packages/agent/src/handlers.test.ts
git commit -m "refactor(agent): extract resolveArtifactPath; readArtifact reports size and mtime"
```

---

### Task 3: writeArtifact handler

**Files:**
- Modify: `packages/agent/src/handlers.ts` (new handler + import + return object)
- Test: `packages/agent/src/handlers.test.ts`

**Interfaces:**
- Consumes: `resolveArtifactPath` (Task 2), `WriteArtifactParams` / `WriteArtifactResult` (Task 1).
- Produces: handler `writeArtifact` on the object returned by `createHandlers`.

- [ ] **Step 1: Write the failing test**

Append to `packages/agent/src/handlers.test.ts`:

```ts
test('writeArtifact: writes an artifact getRun listed and returns its new mtime', async () => {
  const { writeArtifact, readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();

  const result = await writeArtifact(
    { workdir, runId, name: 'review.md', content: '# Edited\n' }, { notify: () => {} },
  ) as { mtimeMs: number };

  const after = await readArtifact({ workdir, runId, name: 'review.md' }, { notify: () => {} }) as
    { content: string; mtimeMs: number };
  assert.equal(after.content, '# Edited\n');
  assert.equal(after.mtimeMs, result.mtimeMs);
});

test('writeArtifact: refuses a name getRun never listed', async () => {
  const { writeArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();

  await assert.rejects(
    async () => { await writeArtifact({ workdir, runId, name: 'planted.md', content: 'x' }, { notify: () => {} }); },
    /unknown artifact/,
  );
});

test('writeArtifact: a traversal attempt in `name` is rejected, not resolved against disk', async () => {
  const { writeArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();

  await assert.rejects(
    async () => {
      await writeArtifact(
        { workdir, runId, name: '../../../../../../etc/passwd', content: 'x' }, { notify: () => {} },
      );
    },
    /unknown artifact/,
  );
});

test('writeArtifact: rejects content over the artifact size cap', async () => {
  const { writeArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();

  await assert.rejects(
    async () => {
      await writeArtifact(
        { workdir, runId, name: 'review.md', content: 'x'.repeat(2 * 1024 * 1024 + 1) },
        { notify: () => {} },
      );
    },
    /too large/,
  );
});

test('writeArtifact: rejects a stale expectedMtimeMs rather than clobbering', async () => {
  const { writeArtifact, readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();

  const before = await readArtifact({ workdir, runId, name: 'review.md' }, { notify: () => {} }) as
    { content: string; mtimeMs: number };

  await assert.rejects(
    async () => {
      await writeArtifact(
        { workdir, runId, name: 'review.md', content: 'clobber', expectedMtimeMs: before.mtimeMs - 1000 },
        { notify: () => {} },
      );
    },
    /changed on disk/,
  );

  const after = await readArtifact({ workdir, runId, name: 'review.md' }, { notify: () => {} }) as { content: string };
  assert.equal(after.content, before.content, 'the rejected write must not have touched the file');
});

test('writeArtifact: accepts a matching expectedMtimeMs', async () => {
  const { writeArtifact, readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();

  const before = await readArtifact({ workdir, runId, name: 'review.md' }, { notify: () => {} }) as { mtimeMs: number };
  await writeArtifact(
    { workdir, runId, name: 'review.md', content: 'fresh', expectedMtimeMs: before.mtimeMs },
    { notify: () => {} },
  );

  const after = await readArtifact({ workdir, runId, name: 'review.md' }, { notify: () => {} }) as { content: string };
  assert.equal(after.content, 'fresh');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/agent/src/handlers.test.ts`
Expected: FAIL — `writeArtifact is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/agent/src/handlers.ts`, add `WriteArtifactParams, WriteArtifactResult` to the type import from `./protocol.ts`. `writeFile` and `stat` are already imported from `node:fs/promises`.

Add the handler immediately after `readArtifact`:

```ts
  const writeArtifact: Handler = async (params): Promise<WriteArtifactResult> => {
    const { workdir, runId, name, content, expectedMtimeMs } = params as WriteArtifactParams;
    const resolvedPath = await resolveArtifactPath(workdir, runId, name);

    // Cap what comes *in*, not just what goes out: the read cap is no limit
    // on how large a client could make the file.
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `artifact '${name}' is too large to save (${bytes} bytes, max ${MAX_ARTIFACT_BYTES})`,
      );
    }

    // Closes the gap between the client's freshness check and this write: a
    // run writing its own artifact in between must lose the race visibly,
    // not silently.
    if (expectedMtimeMs !== undefined) {
      const current = await stat(resolvedPath);
      if (current.mtimeMs !== expectedMtimeMs) {
        throw new Error(`artifact '${name}' changed on disk since it was read`);
      }
    }

    await writeFile(resolvedPath, content, 'utf8');
    const after = await stat(resolvedPath);
    return { mtimeMs: after.mtimeMs };
  };
```

Add `writeArtifact` to the returned object, next to `readArtifact`:

```ts
    startRun, cancelRun, endSession, resolveManual, listRuns, getRun, readArtifact, writeArtifact,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/agent/src/handlers.test.ts`
Expected: PASS — all six new tests plus the existing suite.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/handlers.ts packages/agent/src/handlers.test.ts
git commit -m "feat(agent): writeArtifact with containment, size cap and mtime guard"
```

---

### Task 4: ArtifactFileSystem adapter

**Files:**
- Create: `apps/desktop/src/files/artifact-fs.ts`
- Create: `apps/desktop/src/files/artifact-fs.test.ts`
- Modify: `apps/desktop/src/agent/client.ts:92` (method typing)

**Interfaces:**
- Consumes: `readArtifact` / `writeArtifact` RPCs (Tasks 1-3), `FileSystemPort` from `./fs-port.ts`.
- Produces: `class ArtifactFileSystem implements FileSystemPort`, constructed as
  `new ArtifactFileSystem(client: AgentClient, workdir: string, runId: string, artifacts: ReadonlyArray<{ name: string; path: string }>)`. Task 9 constructs it.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/files/artifact-fs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ArtifactFileSystem } from './artifact-fs.ts';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';

const ARTIFACTS = [{ name: 'review.md', path: '/ws/.mc/runs/run-1/review.md' }];

function setup() {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  const fs = new ArtifactFileSystem(client, '/ws', 'run-1', ARTIFACTS);
  return { transport, fs };
}

/** Answers the Nth request sent so far with `result`, asserting its method. */
function answer(transport: MockTransport, index: number, method: string, result: unknown) {
  const req = transport.sentRequest(index);
  expect(req.method).toBe(method);
  transport.emitLine({ id: req.id, result });
  return req;
}

describe('ArtifactFileSystem', () => {
  it('reads a file by mapping its path back to the artifact name', async () => {
    const { transport, fs } = setup();
    const pending = fs.readFile('/ws/.mc/runs/run-1/review.md');
    await new Promise(resolve => setTimeout(resolve, 0));

    const req = answer(transport, 0, 'readArtifact', { content: '# hi', size: 4, mtimeMs: 10 });
    expect(req.params).toEqual({ workdir: '/ws', runId: 'run-1', name: 'review.md' });
    expect(new TextDecoder().decode(await pending)).toBe('# hi');
  });

  it('reports size and mtime from the same RPC for stat', async () => {
    const { transport, fs } = setup();
    const pending = fs.stat('/ws/.mc/runs/run-1/review.md');
    await new Promise(resolve => setTimeout(resolve, 0));

    answer(transport, 0, 'readArtifact', { content: '# hi', size: 4, mtimeMs: 10 });
    expect(await pending).toEqual({ size: 4, mtimeMs: 10, isDirectory: false });
  });

  it('passes the mtime the caller last stat-ed as the write guard', async () => {
    const { transport, fs } = setup();
    const statting = fs.stat('/ws/.mc/runs/run-1/review.md');
    await new Promise(resolve => setTimeout(resolve, 0));
    answer(transport, 0, 'readArtifact', { content: '# hi', size: 4, mtimeMs: 10 });
    await statting;

    const writing = fs.writeTextFile('/ws/.mc/runs/run-1/review.md', 'edited');
    await new Promise(resolve => setTimeout(resolve, 0));
    const req = answer(transport, 1, 'writeArtifact', { mtimeMs: 20 });
    expect(req.params).toEqual({
      workdir: '/ws', runId: 'run-1', name: 'review.md', content: 'edited', expectedMtimeMs: 10,
    });
    await writing;
  });

  it('refuses a path that is not an artifact of this run', async () => {
    const { fs } = setup();
    await expect(fs.readFile('/etc/passwd')).rejects.toThrow(/not an artifact/);
  });

  it('rejects the directory and mutation methods it cannot honour', async () => {
    const { fs } = setup();
    await expect(fs.readDir('/ws/.mc/runs/run-1')).rejects.toThrow(/not supported/);
    await expect(fs.mkdir('/ws/.mc/runs/run-1/x')).rejects.toThrow(/not supported/);
    await expect(fs.rename('a', 'b')).rejects.toThrow(/not supported/);
    await expect(fs.remove('a')).rejects.toThrow(/not supported/);
    await expect(fs.watch('/ws', () => {})).rejects.toThrow(/not supported/);
  });

  it('answers exists() from the manifest listing without an RPC', async () => {
    const { transport, fs } = setup();
    expect(await fs.exists('/ws/.mc/runs/run-1/review.md')).toBe(true);
    expect(await fs.exists('/ws/.mc/runs/run-1/nope.md')).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w desktop -- artifact-fs`
Expected: FAIL — cannot resolve `./artifact-fs.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/files/artifact-fs.ts`:

```tsx
/**
 * A FileSystemPort backed by the agent's artifact RPCs, so the Artifacts tab
 * can reuse the Files page's FilePreview verbatim instead of growing a second
 * viewer.
 *
 * Deliberately not a filesystem: artifacts are addressed by *name* against
 * one run's manifest listing, and this adapter is what preserves that. Paths
 * only appear here because FilePreview is path-shaped; every one of them is
 * translated back to a name that the manifest already vouches for, and a path
 * that isn't in the manifest is refused outright.
 */
import type { AgentClient } from '../agent/client.ts';
import type { DirEntry } from './tree-model.ts';
import type { FileStat, FileSystemPort } from './fs-port.ts';

export interface ArtifactRef {
  name: string;
  path: string;
}

export class ArtifactFileSystem implements FileSystemPort {
  /**
   * The mtime this adapter last reported from stat(), per path. FilePreview
   * stats immediately before saving and compares that value itself; handing
   * the same value back to the server as expectedMtimeMs closes the window
   * between its check and the actual write.
   */
  private readonly lastStatMtime = new Map<string, number>();

  constructor(
    private readonly client: AgentClient,
    private readonly workdir: string,
    private readonly runId: string,
    private readonly artifacts: ReadonlyArray<ArtifactRef>,
  ) {}

  private nameFor(path: string): string {
    const artifact = this.artifacts.find(a => a.path === path);
    if (!artifact) throw new Error(`not an artifact of this run: ${path}`);
    return artifact.name;
  }

  private read(path: string): Promise<{ content: string; size: number; mtimeMs: number }> {
    return this.client.request('readArtifact', {
      workdir: this.workdir, runId: this.runId, name: this.nameFor(path),
    });
  }

  /** No-op: the agent's own containment is the boundary, not a granted scope. */
  async ensureGranted(): Promise<void> {}

  async readFile(path: string): Promise<Uint8Array> {
    const { content } = await this.read(path);
    return new TextEncoder().encode(content);
  }

  /**
   * Always a fresh RPC — never cached alongside readFile's. FilePreview's
   * stale-write guard *is* this call, so serving it from a cache would defeat
   * the very check it exists for.
   */
  async stat(path: string): Promise<FileStat> {
    const { size, mtimeMs } = await this.read(path);
    this.lastStatMtime.set(path, mtimeMs);
    return { size, mtimeMs, isDirectory: false };
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    const expectedMtimeMs = this.lastStatMtime.get(path);
    const { mtimeMs } = await this.client.request('writeArtifact', {
      workdir: this.workdir, runId: this.runId, name: this.nameFor(path), content: contents,
      ...(expectedMtimeMs === undefined ? {} : { expectedMtimeMs }),
    });
    this.lastStatMtime.set(path, mtimeMs);
  }

  async exists(path: string): Promise<boolean> {
    return this.artifacts.some(a => a.path === path);
  }

  // Unreachable from the Artifacts tab: the tree is built from the manifest
  // and rendered without row actions, so nothing offers to list, create,
  // rename or delete. They throw rather than no-op so a future caller finds
  // out immediately instead of silently getting nothing.
  async readDir(): Promise<DirEntry[]> { throw new Error('readDir is not supported for artifacts'); }
  async mkdir(): Promise<void> { throw new Error('mkdir is not supported for artifacts'); }
  async rename(): Promise<void> { throw new Error('rename is not supported for artifacts'); }
  async remove(): Promise<void> { throw new Error('remove is not supported for artifacts'); }
  async watch(): Promise<() => void> { throw new Error('watch is not supported for artifacts'); }
}
```

In `apps/desktop/src/agent/client.ts`, add `WriteArtifactParams, WriteArtifactResult` to the type import from the protocol module, and add this line directly after the `readArtifact` entry (line 92) in the method map:

```ts
  writeArtifact: { params: WriteArtifactParams; result: WriteArtifactResult };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w desktop -- artifact-fs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/files/artifact-fs.ts apps/desktop/src/files/artifact-fs.test.ts apps/desktop/src/agent/client.ts
git commit -m "feat(desktop): ArtifactFileSystem port over the artifact RPCs"
```

---

### Task 5: TerminalPanel fills its container

**Files:**
- Modify: `apps/desktop/src/components/TerminalPanel.tsx:75-95` (resize observer), `:152-166` (render)
- Test: `apps/desktop/src/components/TerminalPanel.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TerminalPanel` renders at `height: 100%` instead of a fixed 320 px, and never reports a size for a zero-sized container. Props are unchanged.

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level `describe` in `apps/desktop/src/components/TerminalPanel.test.tsx`:

```ts
it('does not report a size while its container is hidden (zero-sized)', async () => {
  const { handle } = renderPanel('job-fit');
  const onResize = vi.fn();
  // The panel reported its initial fit on mount; ignore that and watch what
  // a display:none-shaped resize does.
  onResize.mockClear();

  act(() => {
    Object.defineProperty(screen.getByTestId('terminal-container'), 'clientWidth', { value: 0, configurable: true });
    Object.defineProperty(screen.getByTestId('terminal-container'), 'clientHeight', { value: 0, configurable: true });
    triggerResizeObserver();
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });

  expect(handle.fitAddon.fit).not.toHaveBeenCalledTimes(2);
  expect(onResize).not.toHaveBeenCalled();
});
```

Reuse the file's existing helpers for rendering and for firing the observed `ResizeObserver` callback; if the suite does not already expose a `triggerResizeObserver`, add one next to the existing `ResizeObserver` stub that invokes the registered callback.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w desktop -- TerminalPanel`
Expected: FAIL — the fit runs and a size is reported for a 0×0 container.

- [ ] **Step 3: Write minimal implementation**

In `apps/desktop/src/components/TerminalPanel.tsx`, replace the `ResizeObserver` construction with:

```ts
    const resizeObserver = new ResizeObserver(() => {
      // A hidden panel (the inactive tab is display:none) measures 0×0.
      // Fitting to that would report a nonsense size to the PTY — and the
      // observer fires again with the real box when the tab comes back, so
      // skipping is not a missed refit.
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      if (resizeTimerRef.current !== undefined) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = undefined;
        handle.fitAddon.fit();
        onResize(handle.term.cols, handle.term.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
```

Replace the returned JSX with:

```tsx
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, height: '100%', minHeight: 0 }}>
      <div
        ref={containerRef}
        data-testid="terminal-container"
        style={{
          border: '1px solid var(--colorNeutralStroke2)',
          borderRadius: 4,
          padding: 4,
          flex: 1,
          minHeight: 0,
        }}
      />
      {readOnly && (
        <Text size={200} italic>
          {endedDeliberately
            ? 'Session ended — collecting the artifact.'
            : `Session ended${ptyExitCode !== undefined ? ` (exit ${ptyExitCode})` : ''}. This terminal is now read-only.`}
        </Text>
      )}
    </div>
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w desktop -- TerminalPanel`
Expected: PASS — the new test plus the existing suite.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/TerminalPanel.tsx apps/desktop/src/components/TerminalPanel.test.tsx
git commit -m "feat(desktop): terminal fills its container and ignores zero-size fits"
```

---

### Task 6: Collapsible stepper strip

**Files:**
- Modify: `apps/desktop/src/components/RunStepper.tsx:93-108` (props), `:112-203` (render)
- Test: `apps/desktop/src/components/RunStepper.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `RunStepperProps` gains `collapsed?: boolean` and `onToggleCollapse?: () => void`. When `collapsed` is true only the focus pill renders, followed by an "N of M" summary. The toggle button renders only when `onToggleCollapse` is given, and carries `data-testid="stepper-collapse-toggle"`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/RunStepper.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunStepper } from './RunStepper.tsx';
import type { StepState } from '../state/store.ts';

function steps(): StepState[] {
  return [
    { key: 'a', id: 'a', status: 'done' },
    { key: 'b', id: 'b', status: 'running' },
    { key: 'c', id: 'c', status: 'pending' },
  ] as StepState[];
}

describe('RunStepper', () => {
  it('shows every pill when expanded', () => {
    render(<RunStepper steps={steps()} focusStepId="b" />);
    expect(screen.getByTestId('step-card-a')).toBeInTheDocument();
    expect(screen.getByTestId('step-card-c')).toBeInTheDocument();
  });

  it('shows only the focus step, and how many there are, when collapsed', () => {
    render(<RunStepper steps={steps()} focusStepId="b" collapsed onToggleCollapse={vi.fn()} />);
    expect(screen.getByTestId('step-card-b')).toBeInTheDocument();
    expect(screen.queryByTestId('step-card-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-card-c')).not.toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
  });

  it('fires onToggleCollapse from the chevron', () => {
    const onToggleCollapse = vi.fn();
    render(<RunStepper steps={steps()} focusStepId="b" onToggleCollapse={onToggleCollapse} />);
    fireEvent.click(screen.getByTestId('stepper-collapse-toggle'));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('renders no chevron when collapsing is not offered', () => {
    render(<RunStepper steps={steps()} focusStepId="b" />);
    expect(screen.queryByTestId('stepper-collapse-toggle')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w desktop -- RunStepper`
Expected: FAIL — collapsed still renders every pill; no toggle exists.

- [ ] **Step 3: Write minimal implementation**

In `apps/desktop/src/components/RunStepper.tsx`, add to the icon import:

```ts
  ChevronUpRegular,
  ChevronDownRegular,
```

Add to `RunStepperProps`:

```ts
  /** Collapsed to the focus step alone — for workflows long enough to crowd out the panel below. */
  collapsed?: boolean;
  /** Renders the collapse chevron when provided; the page owns the state. */
  onToggleCollapse?: () => void;
```

Change the component signature to accept them, and inside it, before the return:

```tsx
  const focusIndex = steps.findIndex(step => (
    focusStepKey === undefined ? step.id === focusStepId : step.key === focusStepKey
  ));
  // Collapsed shows the step the run is actually on. With no focus step
  // (an empty run) there is nothing to show and nothing to collapse.
  const visible = collapsed && focusIndex !== -1 ? [steps[focusIndex]] : steps;
```

Then render `visible` instead of `steps` in the `.map(...)`, and note that the connector condition must key off the *rendered* list, so the collapsed single pill gets no leading connector — `index > 0` already does this correctly for `visible`.

After the `.map(...)` and still inside the flex row, add:

```tsx
      {collapsed && focusIndex !== -1 && (
        <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
          {focusIndex + 1} of {steps.length}
        </Text>
      )}
      {onToggleCollapse && (
        <Button
          appearance="subtle"
          size="small"
          data-testid="stepper-collapse-toggle"
          aria-label={collapsed ? 'Show all steps' : 'Collapse to the current step'}
          title={collapsed ? 'Show all steps' : 'Collapse to the current step'}
          icon={collapsed ? <ChevronDownRegular /> : <ChevronUpRegular />}
          onClick={onToggleCollapse}
          style={{ marginLeft: 'auto' }}
        />
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w desktop -- RunStepper`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/RunStepper.tsx apps/desktop/src/components/RunStepper.test.tsx
git commit -m "feat(desktop): collapsible run stepper strip"
```

---

### Task 7: Fixed-height page frame with sticky header

**Files:**
- Modify: `apps/desktop/src/pages/RunDetailPage.tsx:262-330` (header block), `:332-360` (stepper block)
- Test: `apps/desktop/src/pages/RunDetailPage.test.tsx`

**Interfaces:**
- Consumes: `PageHeader` from `../components/PageHeader.tsx`, `RunStepper`'s new collapse props (Task 6).
- Produces: the page's outer element is a full-height flex column carrying `data-testid="run-detail-frame"`; the chrome above the (still un-tabbed) body is sticky. No prop changes.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('RunDetailPage', ...)` in `apps/desktop/src/pages/RunDetailPage.test.tsx`:

```tsx
it('lays the page out as a full-height frame that does not scroll as a whole', async () => {
  const { transport } = renderRunDetail('job-frame');
  await respondGetRun(transport, { runId: 'run-frame', runDir: '/ws/.mc/runs/run-frame', status: 'running', artifacts: [] });

  const frame = screen.getByTestId('run-detail-frame');
  expect(frame).toHaveStyle({ height: '100%', flexDirection: 'column' });
});

it('collapses the stepper strip and brings it back', async () => {
  const { transport } = renderRunDetail('job-collapse');
  emitMcEvent(transport, 'job-collapse', 'run-collapse', { type: 'step:start', stepId: 'one', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
  await respondGetRun(transport, {
    runId: 'run-collapse', runDir: '/ws/.mc/runs/run-collapse', status: 'running', artifacts: [],
    steps: [{ id: 'one', status: 'running' }, { id: 'two', status: 'pending' }],
  });

  expect(await screen.findByTestId('step-card-two')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('stepper-collapse-toggle'));
  expect(screen.queryByTestId('step-card-two')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('stepper-collapse-toggle'));
  expect(screen.getByTestId('step-card-two')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w desktop -- RunDetailPage`
Expected: FAIL — no `run-detail-frame` element, no collapse toggle.

- [ ] **Step 3: Write minimal implementation**

In `apps/desktop/src/pages/RunDetailPage.tsx`:

Add the import and a collapse state hook alongside the other `useState` calls:

```tsx
import { PageHeader } from '../components/PageHeader.tsx';
```

```tsx
  /**
   * Per-sitting reaction to one workflow's length, not a preference — so it
   * lives here and is deliberately not persisted.
   */
  const [stepsCollapsed, setStepsCollapsed] = useState(false);
```

Replace the outer wrapper and header with:

```tsx
    <div
      data-testid="run-detail-frame"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <PageHeader>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button appearance="secondary" onClick={onBack}>
            Back to Runs
          </Button>
          <Text weight="semibold" size={500}>
            Run {effectiveRunId ?? effectiveJobId}
          </Text>
          {(job?.status ?? manifest?.status) && <StatusBadge status={job?.status ?? (manifest?.status as string)} />}
          {job?.awaiting && (
            // Not a StatusBadge: its fallback colour is grey, which is the wrong
            // affordance for the one thing on this page we want noticed.
            <Badge color="warning" appearance="filled" data-testid="run-awaiting">
              {AWAIT_LABEL[job.awaiting.reason]}
            </Badge>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {currentStep && (
            <Text data-testid="step-progress">
              Step {currentStepIndex + 1} of {steps.length} · {currentStep.id}
            </Text>
          )}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            {/* the End session / Cancel run / Run again blocks move here verbatim */}
          </div>
        </div>
      </PageHeader>
```

Move the existing `End session` button, the `Cancel run` `Dialog`, and the `Run again` button into that `marginLeft: 'auto'` div unchanged.

Replace the stepper block with a non-scrolling strip:

```tsx
      {manifestError && <Text>Could not load run details: {manifestError}</Text>}
      {runErrorMessage && <Text data-testid="run-error">Run error: {runErrorMessage}</Text>}

      <div style={{ flexShrink: 0, paddingTop: 8, paddingBottom: 8 }}>
        {steps.length === 0 && <Text>No steps yet.</Text>}
        <RunStepper
          steps={steps}
          focusStepId={focusStep?.id}
          collapsed={stepsCollapsed}
          onToggleCollapse={() => setStepsCollapsed(current => !current)}
          awaiting={
            job?.awaiting
              ? { stepId: job.awaiting.stepId, label: AWAIT_LABEL[job.awaiting.reason] }
              : undefined
          }
          nodeRef={(id, el) => { stepRefs.current[id] = el; }}
        />
        {focusStep && (
          <div data-testid={`step-detail-${focusStep.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <StepStatusIcon status={focusStep.status} />
            <Text weight="semibold">{focusStep.id}</Text>
            <StepDetails step={focusStep} />
          </div>
        )}
      </div>
```

Drop the now-unused `Card` / `CardHeader` imports if nothing else in the file uses them.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w desktop -- RunDetailPage`
Expected: PASS — the two new tests, and the whole existing suite still green (nothing has moved into a tab yet).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/pages/RunDetailPage.tsx apps/desktop/src/pages/RunDetailPage.test.tsx
git commit -m "feat(desktop): sticky header and step strip on the run detail page"
```

---

### Task 8: Terminal / Artifacts / Logs tabs

**Files:**
- Modify: `apps/desktop/src/pages/RunDetailPage.tsx` (body below the strip)
- Test: `apps/desktop/src/pages/RunDetailPage.test.tsx`

**Interfaces:**
- Consumes: `TabList`, `Tab` from `@fluentui/react-components`; `TerminalPanel` at `height: 100%` (Task 5).
- Produces: three panels under `data-testid="run-panel-terminal" | "run-panel-artifacts" | "run-panel-logs"`, all mounted, inactive ones `display: none`. Tabs carry `value` `terminal` / `artifacts` / `logs`. Task 9 fills the artifacts panel.

- [ ] **Step 1: Write the failing test**

Append inside `describe('RunDetailPage', ...)`:

```tsx
it('defaults to Logs, and moves to Terminal by itself when a session starts', async () => {
  const { transport } = renderRunDetail('job-tabs');
  emitMcEvent(transport, 'job-tabs', 'run-tabs', { type: 'step:start', stepId: 'triage', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
  await respondGetRun(transport, { runId: 'run-tabs', runDir: '/ws/.mc/runs/run-tabs', status: 'running', artifacts: [] });

  expect(screen.getByTestId('run-panel-logs')).toBeVisible();

  transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-tabs', stepId: 'triage', cols: 80, rows: 24 } });

  expect(await screen.findByTestId('terminal-panel-mock')).toBeVisible();
  expect(screen.getByTestId('run-panel-logs')).not.toBeVisible();
});

it('never overrides a tab the user picked themselves', async () => {
  const { transport } = renderRunDetail('job-tabs2');
  emitMcEvent(transport, 'job-tabs2', 'run-tabs2', { type: 'step:start', stepId: 'triage', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
  await respondGetRun(transport, { runId: 'run-tabs2', runDir: '/ws/.mc/runs/run-tabs2', status: 'running', artifacts: [] });

  fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));
  transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-tabs2', stepId: 'triage', cols: 80, rows: 24 } });

  await waitFor(() => expect(screen.getByTestId('run-panel-artifacts')).toBeVisible());
  expect(screen.getByTestId('run-panel-terminal')).not.toBeVisible();
});

it('keeps every panel mounted so switching tabs does not tear down the terminal', async () => {
  const { transport } = renderRunDetail('job-tabs3');
  emitMcEvent(transport, 'job-tabs3', 'run-tabs3', { type: 'step:start', stepId: 'triage', kind: 'agent', runner: 'claude', mode: 'interactive' }, 't1');
  await respondGetRun(transport, { runId: 'run-tabs3', runDir: '/ws/.mc/runs/run-tabs3', status: 'running', artifacts: [] });
  transport.emitLine({ method: 'ptyStarted', params: { jobId: 'job-tabs3', stepId: 'triage', cols: 80, rows: 24 } });

  const instance = (await screen.findByTestId('terminal-panel-mock')).getAttribute('data-instance');
  fireEvent.click(screen.getByRole('tab', { name: /logs/i }));
  fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));

  expect(screen.getByTestId('terminal-panel-mock').getAttribute('data-instance')).toBe(instance);
});
```

Update the existing artifact test (`renders an artifact's markdown content…`) and the log-tail assertions to click their tab first — e.g. `fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));` before querying inside that panel.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w desktop -- RunDetailPage`
Expected: FAIL — no tabs exist.

- [ ] **Step 3: Write minimal implementation**

Add to the Fluent import in `RunDetailPage.tsx`: `Tab, TabList`.

Add tab state next to `stepsCollapsed`:

```tsx
type RunTab = 'terminal' | 'artifacts' | 'logs';

/**
 * null means "the user hasn't chosen" — which is what lets a starting session
 * pull the view to the terminal without ever overriding a deliberate choice.
 */
const [chosenTab, setChosenTab] = useState<RunTab | null>(null);
```

Derive the active tab (after `ptyStep` is computed):

```tsx
  // Keyed on ptyStepId, not on the live ptyActive flag: once a session has
  // existed the terminal stays the sensible landing tab, and the view doesn't
  // jump back to Logs the moment the pty exits.
  const hadSession = job?.ptyStepId !== undefined;
  const activeTab: RunTab = chosenTab ?? (hadSession ? 'terminal' : 'logs');
```

Replace everything below the stepper strip (the manual card, pty notes, terminal, and the artifacts/log row) with:

```tsx
      {job?.pendingManual && effectiveJobId && (
        // Outside the tabs on purpose: the run is blocked until this is
        // answered, so it must not be possible to hide it behind a tab.
        <div style={{ flexShrink: 0, paddingBottom: 8 }}>
          <ManualStepCard
            request={job.pendingManual}
            onOpenArtifact={(name, path) => void openArtifact({ name, path })}
            onResolve={async (choice: ManualChoice, note?: string) => {
              const result = await client.request('resolveManual', {
                jobId: effectiveJobId,
                stepId: job.pendingManual!.stepId,
                choice,
                ...(note === undefined ? {} : { note }),
              });
              // The agent says no when nothing is waiting any more — the run was
              // cancelled, or another window answered first. Say so rather than
              // leaving a card that looks live but no longer is.
              if (!result.ok) throw new Error('This step is no longer waiting for an answer.');
            }}
          />
        </div>
      )}

      <TabList
        selectedValue={activeTab}
        onTabSelect={(_e, data) => setChosenTab(data.value as RunTab)}
        style={{ flexShrink: 0 }}
      >
        <Tab value="terminal">
          Terminal{job?.awaiting && job.awaiting.stepId === job.ptyStepId ? ' •' : ''}
        </Tab>
        <Tab value="artifacts">
          Artifacts{manifest && manifest.artifacts.length > 0 ? ` ${manifest.artifacts.length}` : ''}
        </Tab>
        <Tab value="logs">Logs</Tab>
      </TabList>

      <div style={{ flex: 1, minHeight: 0, paddingTop: 8 }}>
        <div
          data-testid="run-panel-terminal"
          style={{ display: activeTab === 'terminal' ? 'flex' : 'none', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}
        >
          {showTerminal && job?.awaiting && job.awaiting.stepId === job.ptyStepId && (
            <Text data-testid="pty-awaiting">{AWAIT_DETAIL[job.awaiting.reason]}</Text>
          )}
          {showTerminal && effectiveJobId ? (
            <TerminalPanel
              // Keyed on the pty step (not just jobId): a later interactive step
              // in the same job starts a fresh PTY session (store resets
              // ptyDataBuffer/ptyExited on the new ptyStarted) — a remount here
              // gives it a fresh terminal + write-count tracking too, instead of
              // reusing one whose internal buffer bookkeeping is for the last session.
              key={job?.ptyStepId ?? effectiveJobId}
              jobId={effectiveJobId}
              cols={job?.ptyCols}
              rows={job?.ptyRows}
              onResize={(cols, rows) => void client.request('ptyResize', { jobId: effectiveJobId, cols, rows })}
            />
          ) : showSessionEndedNote ? (
            <Text data-testid="pty-session-ended-note" italic>
              Interactive session ended.
            </Text>
          ) : (
            <Text italic>No interactive session for this run.</Text>
          )}
        </div>

        <div
          data-testid="run-panel-artifacts"
          style={{ display: activeTab === 'artifacts' ? 'flex' : 'none', height: '100%', minHeight: 0 }}
        >
          {/* Task 9 replaces this with the Files zone. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflow: 'auto' }}>
            {(manifest?.artifacts ?? []).map(artifact => (
              <Button key={artifact.path} appearance="subtle" onClick={() => void openArtifact(artifact)}>
                {artifact.name}
              </Button>
            ))}
            {manifest && manifest.artifacts.length === 0 && <Text>No artifacts yet.</Text>}
            {selectedArtifact && (
              <div style={{ marginTop: 12, border: '1px solid var(--colorNeutralStroke2)', borderRadius: 4, padding: 12 }}>
                <Text weight="semibold">{selectedArtifact.name}</Text>
                {artifactError && <Text>Could not read this artifact: {artifactError}</Text>}
                {artifactContent !== null && <ReactMarkdown>{artifactContent}</ReactMarkdown>}
              </div>
            )}
          </div>
        </div>

        <div
          data-testid="run-panel-logs"
          style={{ display: activeTab === 'logs' ? 'flex' : 'none', height: '100%', minHeight: 0 }}
        >
          <div
            ref={logRef}
            data-testid="log-tail"
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              fontFamily: 'monospace',
              fontSize: 12,
              background: 'var(--colorNeutralBackground3)',
              padding: 8,
              borderRadius: 4,
            }}
          >
            {(job?.logTail ?? []).map((entry, idx) => (
              <div key={idx} style={{ color: entry.stream === 'stderr' ? 'var(--colorPaletteRedForeground1)' : undefined }}>
                {entry.line}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w desktop -- RunDetailPage`
Expected: PASS — three new tests plus the updated existing suite.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/pages/RunDetailPage.tsx apps/desktop/src/pages/RunDetailPage.test.tsx
git commit -m "feat(desktop): Terminal / Artifacts / Logs tabs on the run detail page"
```

---

### Task 9: Artifacts tab reuses the Files zone

**Files:**
- Modify: `apps/desktop/src/pages/RunDetailPage.tsx` (artifacts panel; drop `openArtifact` and its three state hooks)
- Test: `apps/desktop/src/pages/RunDetailPage.test.tsx`

**Interfaces:**
- Consumes: `ArtifactFileSystem` (Task 4), `FileTree`, `FilePreview`, `FileSystemProvider`, `makeRootNode`, `TreeNodes`.
- Produces: nothing further; this is the last task.

- [ ] **Step 1: Write the failing test**

Replace the existing artifact test with:

```tsx
it('browses artifacts as a tree and renders the selected one through readArtifact (not direct filesystem access)', async () => {
  const { transport } = renderRunDetail('job-5');
  emitMcEvent(transport, 'job-5', 'run-5', { type: 'step:start', stepId: 'review', kind: 'agent', runner: 'claude', mode: 'headless' }, 't1');
  await respondGetRun(transport, {
    runId: 'run-5', runDir: '/ws/.mc/runs/run-5', status: 'succeeded',
    artifacts: [{ name: 'review.md', path: '/ws/.mc/runs/run-5/review.md' }],
  });

  fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));
  fireEvent.click(await screen.findByRole('treeitem', { name: /review\.md/ }));

  const req = await waitFor(() => {
    const parsed = transport.sentRequest(transport.sent.length - 1);
    if (parsed.method !== 'readArtifact') throw new Error('readArtifact not sent yet');
    return parsed;
  });
  expect(req.params).toEqual({ workdir: '/ws', runId: 'run-5', name: 'review.md' });

  transport.emitLine({ id: req.id, result: { content: '# Heading\n\nVERDICT: PASS', size: 27, mtimeMs: 10 } });

  expect(await screen.findByRole('heading', { name: 'Heading' })).toBeInTheDocument();
  expect(screen.getByText(/VERDICT: PASS/)).toBeInTheDocument();
});

it('offers no create, rename or delete actions on artifacts', async () => {
  const { transport } = renderRunDetail('job-5b');
  await respondGetRun(transport, {
    runId: 'run-5b', runDir: '/ws/.mc/runs/run-5b', status: 'succeeded',
    artifacts: [{ name: 'review.md', path: '/ws/.mc/runs/run-5b/review.md' }],
  });

  fireEvent.click(screen.getByRole('tab', { name: /artifacts/i }));
  await screen.findByRole('treeitem', { name: /review\.md/ });

  expect(screen.queryByRole('button', { name: /new file/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w desktop -- RunDetailPage`
Expected: FAIL — no `treeitem` role; the panel still renders plain buttons.

- [ ] **Step 3: Write minimal implementation**

Add to `RunDetailPage.tsx`:

```tsx
import { FileSystemProvider } from '../files/fs-context.tsx';
import { ArtifactFileSystem } from '../files/artifact-fs.ts';
import { makeRootNode, type TreeNodes } from '../files/tree-model.ts';
import { FileTree } from '../components/FileTree.tsx';
import { FilePreview } from '../components/FilePreview.tsx';
```

Remove the `selectedArtifact` / `artifactContent` / `artifactError` state, the `openArtifact` function, and the `ReactMarkdown` import — `FilePreview` owns all of that now. `ManualStepCard`'s `onOpenArtifact` becomes:

```tsx
            onOpenArtifact={(name, path) => {
              setChosenTab('artifacts');
              setSelectedArtifactPath(path);
              void name;
            }}
```

Add, next to the other state:

```tsx
  const [selectedArtifactPath, setSelectedArtifactPath] = useState<string | null>(null);
  const [artifactsExpanded, setArtifactsExpanded] = useState<string[]>([]);
```

Derive the tree and the adapter:

```tsx
  const artifacts = useMemo(() => manifest?.artifacts ?? [], [manifest]);
  const runDir = manifest?.runDir ?? '';

  /**
   * Built straight from the manifest's {name, path} pairs rather than through
   * applyDirListing: that helper derives child paths with joinPath, which only
   * matches the artifact's real path when artifacts sit directly in the run
   * dir. ArtifactFileSystem looks names up *by path*, so the two must agree
   * by construction.
   */
  const artifactNodes: TreeNodes = useMemo(() => {
    if (!runDir) return {};
    const nodes = makeRootNode(runDir);
    const children = artifacts.map(a => a.path);
    for (const artifact of artifacts) {
      nodes[artifact.path] = {
        path: artifact.path, name: artifact.name, kind: 'file', childrenLoaded: true,
      };
    }
    nodes[runDir] = { ...nodes[runDir], name: 'Artifacts', childrenLoaded: true, children };
    return nodes;
  }, [artifacts, runDir]);

  const artifactFs = useMemo(
    () => new ArtifactFileSystem(client, workspacePath ?? '', effectiveRunId ?? '', artifacts),
    [client, workspacePath, effectiveRunId, artifacts],
  );
```

Replace the artifacts panel's inner content with:

```tsx
          {artifacts.length === 0 ? (
            <Text>No artifacts yet.</Text>
          ) : (
            <FileSystemProvider fs={artifactFs}>
              <div style={{ display: 'flex', gap: 16, width: '100%', minHeight: 0 }}>
                <div style={{ width: 240, flexShrink: 0, overflow: 'auto' }}>
                  <FileTree
                    root={runDir}
                    nodes={artifactNodes}
                    expanded={artifactsExpanded}
                    selectedPath={selectedArtifactPath}
                    onToggle={path => setArtifactsExpanded(current => (
                      current.includes(path) ? current.filter(p => p !== path) : [...current, path]
                    ))}
                    onSelect={setSelectedArtifactPath}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
                  <FilePreview path={selectedArtifactPath} onDirtyChange={() => {}} />
                </div>
              </div>
            </FileSystemProvider>
          )}
```

Seed the tree open so the artifacts are visible without a click — add after the `artifactsExpanded` state:

```tsx
  // The run directory is the only folder here; there is nothing to gain from
  // making the user open it.
  useEffect(() => {
    if (runDir) setArtifactsExpanded(current => (current.includes(runDir) ? current : [...current, runDir]));
  }, [runDir]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w desktop -- RunDetailPage`
Expected: PASS.

- [ ] **Step 5: Run the whole gate**

Run: `npm run verify`
Expected: all checks pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/pages/RunDetailPage.tsx apps/desktop/src/pages/RunDetailPage.test.tsx
git commit -m "feat(desktop): artifacts tab reuses the Files tree and preview"
```

---

## Manual verification (requires the live app)

jsdom cannot check any of the layout facts this change is *for*. After Task 9, run the app (`npm run tauri dev -w desktop`) and confirm against a real interactive run:

- [ ] The header and step strip stay put while the log scrolls.
- [ ] The terminal fills the window, and grows when the window grows.
- [ ] Switching to Logs and back leaves the terminal's scrollback intact.
- [ ] The PTY's reported size tracks the panel — resize the window on the Terminal tab, then check the session's own `stty size`.
- [ ] Editing and saving an artifact writes to `.mc/runs/<id>/`, and a second save after an external change raises the conflict dialog rather than clobbering.
