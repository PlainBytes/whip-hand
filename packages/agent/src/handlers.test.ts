import { test, before, after } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RunJournal } from '@whiphand/core';
import { createHandlers } from './handlers.ts';
import { JobManager } from './jobs.ts';
import { AppStateStore, EMPTY_APP_STATE } from './app-state.ts';

// configGet/configSet (and startRun's config load) now also consult the
// global config-home — point it at a temp directory so nothing here ever
// touches the real developer/CI machine's global config.yaml.
let prevConfigHome: string | undefined;
before(async () => {
  prevConfigHome = process.env.WHIPHAND_CONFIG_HOME;
  process.env.WHIPHAND_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'whiphand-config-home-'));
});
after(() => {
  if (prevConfigHome === undefined) delete process.env.WHIPHAND_CONFIG_HOME;
  else process.env.WHIPHAND_CONFIG_HOME = prevConfigHome;
});

/**
 * Unit-level coverage for readArtifact — the RPC the desktop app's artifact
 * viewer uses instead of giving the webview direct filesystem access (see
 * apps/desktop/src/pages/RunDetailPage.tsx). The key security property under
 * test: the handler only ever reads a file whose *name* getRun's own
 * directory listing already vouches for — a client can never supply a path.
 */

async function tempAppState(): Promise<AppStateStore> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-handlers-'));
  return new AppStateStore(join(dir, 'app-state.json'));
}

async function setup() {
  return createHandlers({ jobs: new JobManager(), notify: () => {}, appState: await tempAppState() });
}

async function fixtureRun(): Promise<{ workdir: string; runId: string }> {
  const workdir = await mkdtemp(join(tmpdir(), 'whiphand-handlers-'));
  const runId = 'run-1';
  const runDir = join(workdir, '.whiphand', 'runs', runId);
  await mkdir(runDir, { recursive: true });

  const journal = new RunJournal({
    runDir, runId, workflow: 'demo', workdir, dryRun: false,
    inputs: {}, sessionIds: {}, steps: [{ id: 'a', kind: 'agent', runner: 'fake', mode: 'headless' }],
  });
  journal.record({ type: 'run:start', runId, workflow: 'demo' });
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:artifact', stepId: 'a', path: join(runDir, 'review.md') });
  journal.record({ type: 'step:done', stepId: 'a', exitCode: 0 });
  journal.record({ type: 'run:done', runId, ok: true });
  await journal.flush();

  await writeFile(join(runDir, 'review.md'), '# Review\n\nVERDICT: PASS\n', 'utf8');
  return { workdir, runId };
}

test('readArtifact: happy path returns the artifact content getRun listed', async () => {
  const { readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();

  const result = await readArtifact({ workdir, runId, name: 'review.md' }, { notify: () => {} }) as { content: string };
  assert.equal(result.content, '# Review\n\nVERDICT: PASS\n');
});

test('readArtifact: a traversal attempt in `name` is rejected, not resolved against disk', async () => {
  const { readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();

  await assert.rejects(
    async () => { await readArtifact({ workdir, runId, name: '../../../../../../etc/passwd' }, { notify: () => {} }); },
    /unknown artifact/,
  );
});

test('readArtifact: an absolute-path `name` is rejected the same way', async () => {
  const { readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();

  await assert.rejects(
    async () => { await readArtifact({ workdir, runId, name: '/etc/passwd' }, { notify: () => {} }); },
    /unknown artifact/,
  );
});

test('readArtifact: unknown runId is rejected', async () => {
  const { readArtifact } = await setup();
  const { workdir } = await fixtureRun();

  await assert.rejects(
    async () => { await readArtifact({ workdir, runId: 'no-such-run', name: 'review.md' }, { notify: () => {} }); },
    /unknown run/,
  );
});

test('readArtifact: unknown artifact name for a real run is rejected', async () => {
  const { readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();

  await assert.rejects(
    async () => { await readArtifact({ workdir, runId, name: 'does-not-exist.md' }, { notify: () => {} }); },
    /unknown artifact/,
  );
});

test('readArtifact: a traversal runId can no longer reach a file outside the artifacts dir', async () => {
  // Mirrors the reviewer's probe: getRun(workdir, config, '../../../secret')
  // used to return a listing of an arbitrary directory (status 'unknown',
  // artifacts populated), and readArtifact would then happily serve any file
  // it listed because its containment check compared against that same
  // traversed runDir. With getRun's runId validation in place this must be
  // refused before any directory outside the run tree is ever listed.
  const { readArtifact } = await setup();
  const { workdir } = await fixtureRun();

  const secretDir = await mkdtemp(join(tmpdir(), 'whiphand-handlers-secret-'));
  await writeFile(join(secretDir, 'secret.txt'), 'top secret', 'utf8');
  const runId = join('..', '..', '..', secretDir.split('/').pop()!);

  await assert.rejects(
    async () => { await readArtifact({ workdir, runId, name: 'secret.txt' }, { notify: () => {} }); },
    /unknown run/,
  );
});

test('readArtifact: a symlink inside the run dir pointing outside it is refused', async () => {
  const { readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();
  const runDir = join(workdir, '.whiphand', 'runs', runId);

  const secretDir = await mkdtemp(join(tmpdir(), 'whiphand-handlers-secret-'));
  const secretPath = join(secretDir, 'secret.txt');
  await writeFile(secretPath, 'top secret', 'utf8');

  // A symlink planted inside the (otherwise legitimate) run dir, pointing
  // outside it. Its name shows up in getRun's directory listing exactly like
  // a real artifact, so the containment check must catch it via realpath.
  await symlink(secretPath, join(runDir, 'escape.txt'));

  await assert.rejects(
    async () => { await readArtifact({ workdir, runId, name: 'escape.txt' }, { notify: () => {} }); },
    /resolves outside its run directory/,
  );
});

test('readArtifact: refuses a file larger than the size cap', async () => {
  const { readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();
  const runDir = join(workdir, '.whiphand', 'runs', runId);
  // Overwrite the fixture artifact with something past the 2MB cap.
  await writeFile(join(runDir, 'review.md'), 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8');

  await assert.rejects(
    async () => { await readArtifact({ workdir, runId, name: 'review.md' }, { notify: () => {} }); },
    /too large/,
  );
});

test('getAppState returns empty state on first call', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  assert.deepEqual(await handlers.getAppState({}, { notify: () => {} }), EMPTY_APP_STATE);
});

test('touchRecentWorkspace records an existing directory and rejects a non-directory', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));

  const result = await handlers.touchRecentWorkspace({ path: ws }, { notify: () => {} }) as
    { recentWorkspaces: { path: string }[] };
  assert.equal(result.recentWorkspaces[0].path, resolve(ws));

  await assert.rejects(
    () => Promise.resolve(handlers.touchRecentWorkspace({ path: join(ws, 'nope') }, { notify: () => {} })),
    /not an existing directory/,
  );
});

test('getAppState prunes recent workspaces whose directory vanished', async () => {
  const appState = await tempAppState();
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
  await appState.mutate(s => ({
    ...s,
    recentWorkspaces: [
      { path: ws, lastOpenedAt: 'now' },
      { path: join(ws, 'gone'), lastOpenedAt: 'now' },
    ],
  }));
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const state = await handlers.getAppState({}, { notify: () => {} }) as { recentWorkspaces: { path: string }[] };
  assert.deepEqual(state.recentWorkspaces.map(r => r.path), [ws]);
});

test('setWorkspacePinned sets and clears the flag, and ignores an unknown path', async () => {
  const appState = await tempAppState();
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
  await appState.mutate(s => ({ ...s, recentWorkspaces: [{ path: ws, lastOpenedAt: 'now' }] }));
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const call = (path: string, pinned: boolean) =>
    handlers.setWorkspacePinned({ path, pinned }, { notify: () => {} }) as
      Promise<{ recentWorkspaces: { path: string; pinned?: boolean }[] }>;

  assert.equal((await call(ws, true)).recentWorkspaces[0].pinned, true);
  assert.equal((await call(ws, false)).recentWorkspaces[0].pinned, undefined);

  // Unknown path: a no-op that still reports the current list rather than throwing.
  const after = await call(join(ws, 'never-listed'), true);
  assert.deepEqual(after.recentWorkspaces.map(r => r.path), [ws]);
  assert.equal(after.recentWorkspaces[0].pinned, undefined);
});

test('getAppState keeps a pinned workspace whose directory vanished', async () => {
  const appState = await tempAppState();
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
  const pinnedGone = join(ws, 'unmounted');
  await appState.mutate(s => ({
    ...s,
    recentWorkspaces: [
      { path: ws, lastOpenedAt: 'now' },
      { path: pinnedGone, lastOpenedAt: 'now', pinned: true },
      { path: join(ws, 'gone'), lastOpenedAt: 'now' },
    ],
  }));
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const state = await handlers.getAppState({}, { notify: () => {} }) as { recentWorkspaces: { path: string }[] };
  assert.deepEqual(state.recentWorkspaces.map(r => r.path), [ws, pinnedGone]);
});

test('getAppState prunes a recent workspace whose path was replaced by a regular file', async () => {
  const appState = await tempAppState();
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
  const replacedPath = join(ws, 'was-a-dir-now-a-file');
  await writeFile(replacedPath, 'not a directory', 'utf8');
  await appState.mutate(s => ({
    ...s,
    recentWorkspaces: [
      { path: ws, lastOpenedAt: 'now' },
      { path: replacedPath, lastOpenedAt: 'now' },
    ],
  }));
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const state = await handlers.getAppState({}, { notify: () => {} }) as { recentWorkspaces: { path: string }[] };
  assert.deepEqual(state.recentWorkspaces.map(r => r.path), [ws]);
});

/**
 * Builds a finished run (via RunJournal, same as fixtureRun above) inside
 * `workdir`, with `startedAt` overridden after construction so tests can
 * control sort order — RunJournal.record() never touches startedAt after
 * the constructor seeds it, so this is safe to set once up front.
 */
async function fixtureRunAt(workdir: string, runId: string, startedAt: string): Promise<void> {
  const runDir = join(workdir, '.whiphand', 'runs', runId);
  await mkdir(runDir, { recursive: true });

  const journal = new RunJournal({
    runDir, runId, workflow: 'demo', workdir, dryRun: false,
    inputs: {}, sessionIds: {}, steps: [{ id: 'a', kind: 'agent', runner: 'fake', mode: 'headless' }],
  });
  journal.manifest.startedAt = startedAt;
  journal.record({ type: 'run:start', runId, workflow: 'demo' });
  journal.record({ type: 'step:start', stepId: 'a', kind: 'agent', runner: 'fake', mode: 'headless' });
  journal.record({ type: 'step:done', stepId: 'a', exitCode: 0 });
  journal.record({ type: 'run:done', runId, ok: true });
  await journal.flush();
}

test('listRecentRuns merges runs across recent workspaces, newest first', async () => {
  const appState = await tempAppState();
  const wsA = await mkdtemp(join(tmpdir(), 'whiphand-recent-'));
  const wsB = await mkdtemp(join(tmpdir(), 'whiphand-recent-'));
  await fixtureRunAt(wsA, 'run-a', '2026-01-02T00:00:00Z');
  await fixtureRunAt(wsB, 'run-b', '2026-01-03T00:00:00Z');
  await appState.mutate(s => ({
    ...s,
    recentWorkspaces: [
      { path: wsA, lastOpenedAt: 'x' },
      { path: wsB, lastOpenedAt: 'x' },
      { path: '/definitely/missing', lastOpenedAt: 'x' },
    ],
  }));
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const runs = await handlers.listRecentRuns({}, { notify: () => {} }) as { runId: string; workspace: string }[];
  assert.deepEqual(runs.map(r => r.runId), ['run-b', 'run-a']);
  assert.equal(runs[0].workspace, wsB);
});

test('listRecentRuns respects the limit parameter', async () => {
  const appState = await tempAppState();
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-recent-'));
  await fixtureRunAt(ws, 'run-a', '2026-01-01T00:00:00Z');
  await fixtureRunAt(ws, 'run-b', '2026-01-02T00:00:00Z');
  await appState.mutate(s => ({ ...s, recentWorkspaces: [{ path: ws, lastOpenedAt: 'x' }] }));
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const runs = await handlers.listRecentRuns({ limit: 1 }, { notify: () => {} }) as { runId: string }[];
  assert.deepEqual(runs.map(r => r.runId), ['run-b']);
});

test('initWorkspace then createWorkflow scaffold a usable workspace', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-init-'));

  const init = await handlers.initWorkspace({ workdir: ws }, { notify: () => {} }) as { created: string[] };
  assert.equal(init.created.length, 4);

  const rec = await handlers.createWorkflow({ workdir: ws, name: 'review-pr' }, { notify: () => {} }) as { path: string };
  const listed = await handlers.listWorkflows({ workdir: ws }, { notify: () => {} }) as { name: string }[];
  assert.deepEqual(listed.map(r => r.name).sort(), ['feature', 'feature-development', 'review-pr', 'spec-driven']);
  assert.ok(rec.path.endsWith(join('.whiphand', 'workflows', 'review-pr.yaml')));
});

test('updateWorkflow overwrites an existing workflow and getWorkflow reflects the change', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-update-'));
  await handlers.initWorkspace({ workdir: ws }, { notify: () => {} });

  const workflow = await handlers.getWorkflow({ workdir: ws, name: 'feature' }, { notify: () => {} }) as {
    name: string; steps: unknown[];
  };

  const updated = await handlers.updateWorkflow(
    { workdir: ws, name: 'feature', workflow: { ...workflow, description: 'Edited via handler' } },
    { notify: () => {} },
  ) as { path: string };
  assert.ok(updated.path.endsWith(join('.whiphand', 'workflows', 'feature.yaml')));

  const reread = await handlers.getWorkflow({ workdir: ws, name: 'feature' }, { notify: () => {} }) as {
    description?: string;
  };
  assert.equal(reread.description, 'Edited via handler');
});

test('deleteWorkflow removes a workflow so listWorkflows no longer shows it', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-delete-'));
  await handlers.createWorkflow({ workdir: ws, name: 'doomed' }, { notify: () => {} });

  const result = await handlers.deleteWorkflow({ workdir: ws, name: 'doomed' }, { notify: () => {} });
  assert.deepEqual(result, { deleted: true });

  const listed = await handlers.listWorkflows({ workdir: ws }, { notify: () => {} }) as { name: string }[];
  assert.ok(!listed.some(r => r.name === 'doomed'));
});

test('createWorkflow/updateWorkflow/getWorkflow honor an explicit global scope', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-global-scope-'));

  const created = await handlers.createWorkflow(
    { workdir: ws, name: 'shared', scope: 'global' }, { notify: () => {} },
  ) as { path: string };
  assert.ok(!created.path.startsWith(ws));

  const listed = await handlers.listWorkflows({ workdir: ws }, { notify: () => {} }) as
    Array<{ name: string; source: string }>;
  assert.deepEqual(listed.map(r => [r.name, r.source]), [['shared', 'global']]);

  const workflow = await handlers.getWorkflow(
    { workdir: ws, name: 'shared', scope: 'global' }, { notify: () => {} },
  ) as { name: string };
  assert.equal(workflow.name, 'shared');

  const updated = await handlers.updateWorkflow(
    { workdir: ws, name: 'shared', workflow: { ...workflow, description: 'edited' }, scope: 'global' },
    { notify: () => {} },
  ) as { path: string };
  assert.equal(updated.path, created.path);

  const reread = await handlers.getWorkflow(
    { workdir: ws, name: 'shared', scope: 'global' }, { notify: () => {} },
  ) as { description?: string };
  assert.equal(reread.description, 'edited');
});

test('configGet with no workdir returns only the global layer', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });

  const result = await handlers.configGet({}, { notify: () => {} }) as {
    config: { defaults: { runner: string } }; global: { exists: boolean }; project?: unknown;
  };
  assert.equal(result.config.defaults.runner, 'claude');
  assert.equal(result.global.exists, false);
  assert.equal(result.project, undefined);
});

test('configSet with scope global writes only the diff from DEFAULT_CONFIG, and configGet reflects it everywhere', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const fullConfig = {
    defaults: { runner: 'copilot' }, on_findings: 'report' as const,
    loop: { max_iterations: 3 }, artifacts_dir: '.whiphand/runs', runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
  };

  await handlers.configSet({ config: fullConfig, scope: 'global' }, { notify: () => {} });

  const globalOnly = await handlers.configGet({}, { notify: () => {} }) as {
    config: { defaults: { runner: string } }; global: { config: Record<string, unknown> };
  };
  assert.equal(globalOnly.config.defaults.runner, 'copilot');
  // Only the field that actually differs from DEFAULT_CONFIG is on disk.
  assert.deepEqual(globalOnly.global.config, { defaults: { runner: 'copilot' } });

  const ws = await mkdtemp(join(tmpdir(), 'whiphand-global-config-'));
  const perWorkspace = await handlers.configGet({ workdir: ws }, { notify: () => {} }) as {
    config: { defaults: { runner: string } };
  };
  assert.equal(perWorkspace.config.defaults.runner, 'copilot');
});

test('configSet with scope project writes only what differs from the merged layer beneath it', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  await handlers.configSet({
    config: {
      defaults: { runner: 'copilot' }, on_findings: 'report', loop: { max_iterations: 3 },
      artifacts_dir: '.whiphand/runs', runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
    },
    scope: 'global',
  }, { notify: () => {} });

  const ws = await mkdtemp(join(tmpdir(), 'whiphand-project-config-'));
  await handlers.configSet({
    workdir: ws,
    config: {
      defaults: { runner: 'copilot' }, on_findings: 'loop', loop: { max_iterations: 3 },
      artifacts_dir: '.whiphand/runs', runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
    },
  }, { notify: () => {} });

  const result = await handlers.configGet({ workdir: ws }, { notify: () => {} }) as {
    project: { config: Record<string, unknown> };
  };
  // defaults.runner matches the global layer already, so it's not repeated
  // in the project file — only the genuine override (on_findings) is.
  assert.deepEqual(result.project.config, { on_findings: 'loop' });
});

test('configSet: explicitKeys pins a project override that coincides with the global value', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const base = {
    defaults: { runner: 'claude' }, on_findings: 'report' as const, loop: { max_iterations: 3 },
    artifacts_dir: '.whiphand/runs',
  };
  await handlers.configSet(
    { config: { ...base, runs: { max_retained: 10 } }, scope: 'global' }, { notify: () => {} },
  );

  const ws = await mkdtemp(join(tmpdir(), 'whiphand-project-config-'));
  // The workspace picks the same cap the global layer already has. Without
  // the pin this is a no-op diff: nothing is written, the settings page's
  // override checkbox unticks itself on refetch, and raising the global cap
  // later silently raises this workspace too.
  await handlers.configSet({
    workdir: ws,
    config: { ...base, runs: { max_retained: 10 } },
    explicitKeys: ['runs.max_retained'],
  }, { notify: () => {} });

  const pinned = await handlers.configGet({ workdir: ws }, { notify: () => {} }) as {
    project: { config: Record<string, unknown> };
  };
  assert.deepEqual(pinned.project.config, { runs: { max_retained: 10 } });

  // Raising the global cap leaves the pinned workspace where it was.
  await handlers.configSet(
    { config: { ...base, runs: { max_retained: 50 } }, scope: 'global' }, { notify: () => {} },
  );
  const after = await handlers.configGet({ workdir: ws }, { notify: () => {} }) as {
    config: { runs: { max_retained: number | null } };
  };
  assert.equal(after.config.runs.max_retained, 10);
});

test('configSet: without explicitKeys the same write stays a no-op diff', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  const base = {
    defaults: { runner: 'claude' }, on_findings: 'report' as const, loop: { max_iterations: 3 },
    artifacts_dir: '.whiphand/runs',
  };
  await handlers.configSet(
    { config: { ...base, runs: { max_retained: 10, auto_name: false, max_attachment_mb: 25 } }, scope: 'global' },
    { notify: () => {} },
  );
  const ws = await mkdtemp(join(tmpdir(), 'whiphand-project-config-'));
  await handlers.configSet(
    { workdir: ws, config: { ...base, runs: { max_retained: 10, auto_name: false, max_attachment_mb: 25 } } },
    { notify: () => {} },
  );
  const result = await handlers.configGet({ workdir: ws }, { notify: () => {} }) as {
    project: { config: Record<string, unknown> };
  };
  assert.deepEqual(result.project.config, {});
});

test('setUiState patch-merges and clears with null', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  await handlers.setUiState({ theme: 'dark', lastPage: 'workflows' }, { notify: () => {} });
  await handlers.setUiState({ window: { width: 100, height: 80, x: 1, y: 2 } }, { notify: () => {} });
  let state = await appState.get();
  assert.equal(state.theme, 'dark');
  assert.equal(state.lastPage, 'workflows');
  assert.deepEqual(state.window, { width: 100, height: 80, x: 1, y: 2 });

  await handlers.setUiState({ window: null }, { notify: () => {} });
  state = await appState.get();
  assert.equal(state.window, null);
  assert.equal(state.theme, 'dark'); // untouched by the partial patch
});

test('setUiState patches runsRetention', async () => {
  const appState = await tempAppState();
  const handlers = createHandlers({ jobs: new JobManager(), notify: () => {}, appState });
  assert.equal((await appState.get()).runsRetention.maxPerWorkspace, 0);

  await handlers.setUiState({ runsRetention: { maxPerWorkspace: 10 } }, { notify: () => {} });
  assert.equal((await appState.get()).runsRetention.maxPerWorkspace, 10);
});

test('endSession ends only the live interactive session, and says so when there is none', async () => {
  const appState = await tempAppState();
  const jobs = new JobManager();
  const handlers = createHandlers({ jobs, notify: () => {}, appState });
  const ctx = { notify: () => {} };

  assert.deepEqual(await handlers.endSession({ jobId: 'nope' }, ctx), { ok: false });

  const job = jobs.create('/ws');
  // A job with no interactive step running has nothing to end; that is a race
  // with the session closing itself, not a client error.
  assert.deepEqual(await handlers.endSession({ jobId: job.jobId }, ctx), { ok: false });

  const reasons: string[] = [];
  job.endSession = reason => reasons.push(reason);
  assert.deepEqual(await handlers.endSession({ jobId: job.jobId }, ctx), { ok: true });
  assert.deepEqual(reasons, ['user']);
  // The run itself is untouched: only the session ends, then harvest runs.
  assert.equal(job.controller.signal.aborted, false);
});

test('ptyInput clears the bell latch: someone is evidently at the keyboard', async () => {
  const appState = await tempAppState();
  const jobs = new JobManager();
  const handlers = createHandlers({ jobs, notify: () => {}, appState });
  const job = jobs.create('/ws');
  let cleared = 0;
  job.pty = { write: () => {}, resize: () => {}, kill: () => {} };
  job.clearBell = () => { cleared += 1; };

  await handlers.ptyInput({ jobId: job.jobId, data: 'aGk=' }, { notify: () => {} });

  assert.equal(cleared, 1);
});

test('readArtifact: reports the size and mtime of the file it read', async () => {
  const { readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();

  const onDisk = await stat(join(workdir, '.whiphand', 'runs', runId, 'review.md'));
  const result = await readArtifact({ workdir, runId, name: 'review.md' }, { notify: () => {} }) as
    { content: string; size: number; mtimeMs: number };

  assert.equal(result.size, onDisk.size);
  assert.equal(result.mtimeMs, onDisk.mtimeMs);
});

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

/** A run fixture that never gets a run:done — stays 'running' on disk. */
async function fixtureRunningRun(): Promise<{ workdir: string; runId: string }> {
  const workdir = await mkdtemp(join(tmpdir(), 'whiphand-handlers-'));
  const runId = 'run-running';
  const runDir = join(workdir, '.whiphand', 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const journal = new RunJournal({
    runDir, runId, workflow: 'demo', workdir, dryRun: false,
    inputs: {}, sessionIds: {}, steps: [{ id: 'a', kind: 'agent', runner: 'fake', mode: 'headless' }],
  });
  journal.record({ type: 'run:start', runId, workflow: 'demo' });
  await journal.flush();
  return { workdir, runId };
}

test('deleteRun: happy path removes the run directory', async () => {
  const { deleteRun } = await setup();
  const { workdir, runId } = await fixtureRun();

  const result = await deleteRun({ workdir, runId }, { notify: () => {} });
  assert.deepEqual(result, { deleted: true });
  await assert.rejects(() => stat(join(workdir, '.whiphand', 'runs', runId)));
});

test('deleteRun: refuses a locked run', async () => {
  const { deleteRun, setRunLocked } = await setup();
  const { workdir, runId } = await fixtureRun();

  assert.deepEqual(await setRunLocked({ workdir, runId, locked: true }, { notify: () => {} }), { locked: true });
  const result = await deleteRun({ workdir, runId }, { notify: () => {} });
  assert.deepEqual(result, { deleted: false, reason: 'locked' });
  await stat(join(workdir, '.whiphand', 'runs', runId)); // still there
});

test('deleteRun: refuses a still-running run', async () => {
  const { deleteRun } = await setup();
  const { workdir, runId } = await fixtureRunningRun();

  const result = await deleteRun({ workdir, runId }, { notify: () => {} });
  assert.deepEqual(result, { deleted: false, reason: 'running' });
});

test('deleteRun: reports missing for an unknown runId', async () => {
  const { deleteRun } = await setup();
  const { workdir } = await fixtureRun();

  const result = await deleteRun({ workdir, runId: 'no-such-run' }, { notify: () => {} });
  assert.deepEqual(result, { deleted: false, reason: 'missing' });
});

test('setRunLocked: sets and clears the lock, visible via getRun', async () => {
  const { setRunLocked, getRun } = await setup();
  const { workdir, runId } = await fixtureRun();

  assert.deepEqual(await setRunLocked({ workdir, runId, locked: true }, { notify: () => {} }), { locked: true });
  assert.equal((await getRun({ workdir, runId }, { notify: () => {} }) as { locked: boolean }).locked, true);

  assert.deepEqual(await setRunLocked({ workdir, runId, locked: false }, { notify: () => {} }), { locked: false });
  assert.equal((await getRun({ workdir, runId }, { notify: () => {} }) as { locked: boolean }).locked, false);
});

test('setRunLocked: an unknown runId is rejected', async () => {
  const { setRunLocked } = await setup();
  const { workdir } = await fixtureRun();

  await assert.rejects(
    async () => { await setRunLocked({ workdir, runId: 'no-such-run', locked: true }, { notify: () => {} }); },
    /unknown run/,
  );
});

test('pruneRuns: deletes oldest-first once the count exceeds max', async () => {
  const { pruneRuns } = await setup();
  const workdir = await mkdtemp(join(tmpdir(), 'whiphand-handlers-'));
  await fixtureRunAt(workdir, 'run-a', '2026-01-01T00:00:00Z');
  await fixtureRunAt(workdir, 'run-b', '2026-01-02T00:00:00Z');
  await fixtureRunAt(workdir, 'run-c', '2026-01-03T00:00:00Z');

  const result = await pruneRuns({ workdir, max: 2 }, { notify: () => {} });
  assert.deepEqual(result, { deleted: ['run-a'] });
  await assert.rejects(() => stat(join(workdir, '.whiphand', 'runs', 'run-a')));
  await stat(join(workdir, '.whiphand', 'runs', 'run-b'));
  await stat(join(workdir, '.whiphand', 'runs', 'run-c'));
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

/**
 * getWorkingDiff — the RPC behind the desktop's review screen. Unlike
 * readArtifact this runs git in a client-named directory (the same trust
 * startRun takes), so what is under test here is the wiring and the two
 * answers a caller has to tell apart: `null` for "not a git repo" versus an
 * empty list for "a repo with nothing changed".
 */
async function runGit(cwd: string, args: string[]): Promise<void> {
  await promisify(execFile)('git', args, { cwd });
}

async function gitWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-agent-diff-'));
  await runGit(dir, ['init', '-b', 'main']);
  await writeFile(join(dir, 'tracked.txt'), 'one\n');
  await runGit(dir, ['add', '.']);
  await runGit(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']);
  return dir;
}

test('getWorkingDiff returns null for a directory that is not a repo', async () => {
  const handlers = await setup();
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-agent-plain-'));
  assert.equal(await handlers.getWorkingDiff({ workdir: dir }, { notify: () => {} }), null);
});

test('getWorkingDiff distinguishes a clean repo from a missing one', async () => {
  const handlers = await setup();
  const dir = await gitWorkspace();
  const result = await handlers.getWorkingDiff({ workdir: dir }, { notify: () => {} }) as {
    files: unknown[];
  };
  assert.deepEqual(result, { files: [] });
});

test('getWorkingDiff reports a modified file and an untracked one', async () => {
  // The untracked half is the bug this RPC exists to fix: `git diff HEAD`,
  // which the CLI still prints, omits a file a step just created entirely.
  const handlers = await setup();
  const dir = await gitWorkspace();
  await writeFile(join(dir, 'tracked.txt'), 'two\n');
  await writeFile(join(dir, 'created-by-a-step.ts'), 'export const x = 1;\n');

  const result = await handlers.getWorkingDiff({ workdir: dir }, { notify: () => {} }) as {
    files: Array<{ path: string; status: string; patch?: string }>;
  };
  const byPath = new Map(result.files.map(f => [f.path, f]));
  assert.equal(byPath.get('tracked.txt')?.status, 'modified');
  assert.equal(byPath.get('created-by-a-step.ts')?.status, 'added');
  assert.ok(byPath.get('created-by-a-step.ts')?.patch?.includes('+export const x = 1;'));
});

// ---------------------------------------------------------------------------
// Attachments: startRun validates before a job exists; artifacts come back as bytes
// ---------------------------------------------------------------------------

/** A workspace with one workflow that reads attachments and one that does not. */
async function attachWorkspace(): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), 'whiphand-handlers-attach-'));
  await mkdir(join(workdir, '.whiphand', 'workflows'), { recursive: true });
  await writeFile(join(workdir, '.whiphand', 'workflows', 'triage.yaml'),
    'name: triage\nsteps:\n  - id: look\n    kind: command\n    inputs: [attachments]\n    run: "true"\n');
  await writeFile(join(workdir, '.whiphand', 'workflows', 'plain.yaml'),
    'name: plain\nsteps:\n  - id: look\n    kind: command\n    run: "true"\n');
  return workdir;
}

/** The 8-byte PNG signature plus a few bytes no UTF-8 decode would survive. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);

test('startRun: an attachment problem is the call\'s error, and no job is created', async () => {
  const jobs = new JobManager();
  const { startRun } = createHandlers({ jobs, notify: () => {}, appState: await tempAppState() });
  const workdir = await attachWorkspace();
  await writeFile(join(workdir, 'a.log'), 'x');

  await assert.rejects(
    async () => { await startRun({ workdir, workflow: 'plain', attachments: [{ path: join(workdir, 'a.log') }] }, { notify: () => {} }); },
    /no step reads `attachments`/);
  await assert.rejects(
    async () => { await startRun({ workdir, workflow: 'triage', attachments: [{ path: join(workdir, 'gone.png') }] }, { notify: () => {} }); },
    /attachment not found/);
  assert.deepEqual(jobs.list(), []);
});

test('startRun: a base64 source is decoded and copied into the run byte for byte', async () => {
  const jobs = new JobManager();
  const { startRun, getRun } = createHandlers({ jobs, notify: () => {}, appState: await tempAppState() });
  const workdir = await attachWorkspace();

  const { jobId } = await startRun({
    workdir, workflow: 'triage', attachments: [{ name: 'clipboard.png', base64: PNG_BYTES.toString('base64') }],
  }, { notify: () => {} }) as { jobId: string };
  const job = jobs.get(jobId)!;
  await job.promise;
  assert.equal(job.status, 'succeeded');

  const detail = await getRun({ workdir, runId: job.runId }, { notify: () => {} }) as {
    runDir: string; attachments: Array<{ name: string; source: string }>;
  };
  assert.deepEqual(detail.attachments.map(a => [a.name, a.source]), [['pasted-1.png', 'pasted']]);
  assert.deepEqual(await readFile(join(detail.runDir, 'attachments', 'pasted-1.png')), PNG_BYTES);
});

test('readArtifact: a PNG survives encoding base64 byte for byte', async () => {
  const { readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();
  await writeFile(join(workdir, '.whiphand', 'runs', runId, 'shot.png'), PNG_BYTES);

  const result = await readArtifact(
    { workdir, runId, name: 'shot.png', encoding: 'base64' }, { notify: () => {} }) as { content: string; size: number };
  assert.deepEqual(Buffer.from(result.content, 'base64'), PNG_BYTES);
  assert.equal(result.size, PNG_BYTES.length);
});

test('readArtifact: the 2 MB cap is for text; base64 goes up to runs.max_attachment_mb', async () => {
  const { readArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();
  const runDir = join(workdir, '.whiphand', 'runs', runId);
  await writeFile(join(runDir, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 1));

  await assert.rejects(
    async () => { await readArtifact({ workdir, runId, name: 'big.bin' }, { notify: () => {} }); },
    /too large/);
  const result = await readArtifact(
    { workdir, runId, name: 'big.bin', encoding: 'base64' }, { notify: () => {} }) as { size: number };
  assert.equal(result.size, 3 * 1024 * 1024);

  await mkdir(join(workdir, '.whiphand'), { recursive: true });
  await writeFile(join(workdir, '.whiphand', 'config.yaml'), 'runs:\n  max_attachment_mb: 1\n');
  await assert.rejects(
    async () => { await readArtifact({ workdir, runId, name: 'big.bin', encoding: 'base64' }, { notify: () => {} }); },
    /too large/, 'the attachment cap bounds it');
});

test('statArtifact: reports size and mtime without the content', async () => {
  const { statArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();
  const path = join(workdir, '.whiphand', 'runs', runId, 'review.md');

  const result = await statArtifact({ workdir, runId, name: 'review.md' }, { notify: () => {} });
  const st = await stat(path);
  assert.deepEqual(result, { size: st.size, mtimeMs: st.mtimeMs });
});

test('statArtifact: the same containment as readArtifact, symlink escape included', async () => {
  const { statArtifact } = await setup();
  const { workdir, runId } = await fixtureRun();
  const runDir = join(workdir, '.whiphand', 'runs', runId);
  const secretDir = await mkdtemp(join(tmpdir(), 'whiphand-handlers-secret-'));
  await writeFile(join(secretDir, 'secret.txt'), 'top secret', 'utf8');
  await symlink(join(secretDir, 'secret.txt'), join(runDir, 'escape.txt'));

  await assert.rejects(
    async () => { await statArtifact({ workdir, runId, name: '../../../../etc/passwd' }, { notify: () => {} }); },
    /unknown artifact/);
  await assert.rejects(
    async () => { await statArtifact({ workdir, runId, name: 'escape.txt' }, { notify: () => {} }); },
    /resolves outside its run directory/);
});
