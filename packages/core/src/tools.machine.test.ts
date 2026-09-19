import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTools, machineChecks, workspaceChecks } from './tools.ts';

const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
const layout = (...present: string[]) => ({ exists: (p: string) => present.map(x => x.toLowerCase()).includes(p.toLowerCase()) });

test('doctor: on POSIX the shell row is green and names /bin/sh; nothing Windows-specific appears', () => {
  const rows = machineChecks({ platform: 'linux' });
  assert.deepEqual(rows.map(r => [r.id, r.installed]), [['posix-shell', true]]);
  assert.match(rows[0].notes![0], /\/bin\/sh/);
});

test('doctor: no POSIX shell on Windows is RED, names why, and says command steps will refuse', () => {
  const rows = machineChecks({ platform: 'win32', git: GIT, env: {}, ...layout() });
  const shell = rows.find(r => r.id === 'posix-shell')!;
  assert.equal(shell.installed, false);
  assert.equal(shell.optional, false, 'required: not a shrug-worthy amber');
  assert.match(shell.notes!.join(' '), /Install Git for Windows/);
  assert.match(shell.notes!.join(' '), /Command steps are refused/);
});

test('doctor: a found shell is reported by its resolved absolute forward-slash path', () => {
  const rows = machineChecks({ platform: 'win32', git: GIT, env: {}, ...layout('C:\\Program Files\\Git\\usr\\bin\\sh.exe') });
  const shell = rows.find(r => r.id === 'posix-shell')!;
  assert.equal(shell.installed, true);
  assert.deepEqual(shell.notes, ['command steps run through C:/Program Files/Git/usr/bin/sh.exe']);
});

test('doctor: on Windows the remote token file mode gap is stated, not invisible', () => {
  const rows = machineChecks({ platform: 'win32', git: GIT, env: {}, ...layout() });
  const mode = rows.find(r => r.id === 'token-file-mode')!;
  assert.ok(mode, 'a Windows-side counterpart to the POSIX-only 0600 assertion');
  assert.equal(mode.installed, false);
  assert.match(mode.notes![0], /cannot be made 0600/);
  assert.equal(machineChecks({ platform: 'linux' }).some(r => r.id === 'token-file-mode'), false);
});

const OWNERSHIP = Object.assign(new Error('Command failed'), {
  code: 128,
  stderr: "fatal: detected dubious ownership in repository at 'C:/Users/me/proj'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory C:/Users/me/proj\n",
});
const NOT_A_REPO = Object.assign(new Error('Command failed'), { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' });
const okGit = async () => {};
const failGit = (error: Error) => async () => { throw error; };

test('doctor: a workspace whose repo git refuses (dubious ownership) is a RED row with the safe.directory remediation', async () => {
  const rows = await workspaceChecks('C:\\Users\\me\\proj', { platform: 'win32', git: failGit(OWNERSHIP) });
  const row = rows.find(r => r.id === 'git-ownership')!;
  assert.ok(row, 'the git-ownership row exists');
  assert.equal(row.installed, false);
  assert.equal(row.optional, false, 'guarded steps fail on it, so it is red, not amber');
  assert.equal(row.group, 'support');
  assert.match(row.notes!.join('\n'), /dubious ownership/);
  assert.match(row.notes!.join('\n'), /git config --global --add safe\.directory C:\/Users\/me\/proj/);
});

test('doctor: a healthy repo, a non-repo and a missing git each stay silent about ownership', async () => {
  for (const git of [okGit, failGit(NOT_A_REPO), failGit(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))]) {
    const rows = await workspaceChecks('/work/proj', { platform: 'linux', git });
    assert.deepEqual(rows, []);
  }
});

test('doctor: a Windows workspace too deep for the engine gets an amber long-path row naming subst', async () => {
  const deep = `C:\\${'a'.repeat(200)}`;
  const rows = await workspaceChecks(deep, { platform: 'win32', git: okGit });
  const row = rows.find(r => r.id === 'long-path')!;
  assert.ok(row);
  assert.equal(row.installed, false);
  assert.equal(row.optional, true, 'amber: the run may still work');
  assert.match(row.notes!.join('\n'), /subst/);
  assert.match(row.notes!.join('\n'), /260/);
});

test('doctor: a short Windows workspace, and any POSIX workspace, has no long-path row', async () => {
  assert.deepEqual(await workspaceChecks('C:\\proj', { platform: 'win32', git: okGit }), []);
  assert.deepEqual(await workspaceChecks(`/${'a'.repeat(300)}`, { platform: 'linux', git: okGit }), []);
});

test('doctor: detectTools appends the workspace rows only when it is given a workspace', async () => {
  const registry = { list: () => [], has: () => false, get: () => { throw new Error('unused'); } } as never;
  const rowsFor = async (workdir?: string) => (await detectTools(registry, { tools: [] }, {
    probe: async () => ({ installed: true }), machine: () => [],
    ...(workdir === undefined ? {} : { workdir, workspace: async () => [{ id: 'long-path', label: 'x', group: 'support' as const, runner: false, optional: true, installed: false }] }),
  })).map(r => r.id);
  assert.equal((await rowsFor()).includes('long-path'), false);
  assert.equal((await rowsFor('/w')).includes('long-path'), true);
});
