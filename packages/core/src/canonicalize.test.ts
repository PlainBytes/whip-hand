import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENGINE_PATH_BUDGET, WINDOWS_MAX_PATH, WorkspaceRefusal, assertNotUnc, headroomWarning, openWorkspace,
} from './canonicalize.ts';
import { artifactPath } from './engine/artifacts.ts';
import { samePath } from './path-form.ts';
import type { Frame } from './types.ts';

test('a typed UNC workspace is refused by string, with the fix named; mapped drives and extended paths are not UNC', () => {
  assert.throws(() => assertNotUnc('\\\\server\\share\\proj'), (e: Error) => e instanceof WorkspaceRefusal && /Map the share to a drive letter/.test(e.message));
  assert.throws(() => assertNotUnc('//server/share/proj'), WorkspaceRefusal);
  assert.doesNotThrow(() => assertNotUnc('Z:\\proj'));
  assert.doesNotThrow(() => assertNotUnc('\\\\?\\C:\\proj'));
  assert.doesNotThrow(() => assertNotUnc('/home/u/proj'));
});

test('root is what the user typed and identityKey is the canonical, case-folded form — two values, side by side', async () => {
  const opened = await openWorkspace('C:\\Users\\Me\\Proj', {
    platform: 'win32', canonicalize: async () => 'C:\\Users\\ME\\PROJ',
  });
  assert.equal(opened.root, 'C:\\Users\\Me\\Proj', 'the operational path keeps its casing (and would keep a subst drive)');
  assert.equal(opened.identityKey, 'c:/users/me/proj');
  assert.deepEqual(opened.degradations, []);
});

test('C:\\Proj and c:\\proj — and a subst alias of the same folder — share one identity key', async () => {
  const canonical = async (): Promise<string> => 'C:\\Proj';
  const a = await openWorkspace('C:\\Proj', { platform: 'win32', canonicalize: canonical });
  const b = await openWorkspace('c:\\proj', { platform: 'win32', canonicalize: canonical });
  // `subst X: C:\Proj`: a different root (everything still operates on it), the same place.
  const c = await openWorkspace('X:\\', { platform: 'win32', canonicalize: canonical });
  assert.equal(a.identityKey, b.identityKey);
  assert.equal(a.identityKey, c.identityKey);
  assert.equal(c.root, 'X:\\', 'subst keeps working: operations use root, never the canonical form');
});

test('an 8.3 short name and its long form are the same place once canonicalized', async () => {
  const short = await openWorkspace('C:\\PROGRA~1\\Tool', { platform: 'win32', canonicalize: async () => 'C:\\Program Files\\Tool' });
  const long = await openWorkspace('C:\\Program Files\\Tool', { platform: 'win32', canonicalize: async p => p });
  assert.equal(short.identityKey, long.identityKey);
});

test('a canonicalization that fails (EPERM, a disconnected share) falls back to the lexical form and records a degradation — it never throws the workspace shut', async () => {
  const opened = await openWorkspace('D:\\Proj', {
    platform: 'win32', canonicalize: async () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); },
  });
  assert.equal(opened.identityKey, 'd:/proj');
  assert.equal(opened.degradations.length, 1);
  assert.equal(opened.degradations[0].capability, 'workspace-identity');
  assert.match(opened.degradations[0].reason, /EPERM/);
});

test('a real directory canonicalizes through a symlink to the same identity key', async () => {
  const base = await mkdtemp(join(tmpdir(), 'whiphand-ws-'));
  await mkdir(join(base, 'real'));
  await symlink(join(base, 'real'), join(base, 'alias'), 'dir');
  const real = await openWorkspace(join(base, 'real'));
  const alias = await openWorkspace(join(base, 'alias'));
  assert.equal(alias.identityKey, real.identityKey);
  assert.equal(alias.root.endsWith('alias'), true, 'root stays as opened');
});

test('long-path headroom: warns before the run starts, with the subst escape hatch named', () => {
  const ok = 'C:\\Users\\me\\proj';
  assert.equal(headroomWarning(ok), null);
  const deep = `C:\\${'x'.repeat(WINDOWS_MAX_PATH - ENGINE_PATH_BUDGET - 3)}`;
  assert.equal(headroomWarning(deep) === null, false);
  assert.match(headroomWarning(deep)!, /subst/);
  assert.match(headroomWarning(deep)!, /ENAMETOOLONG/);
});

test('the headroom check reads root, and only on Windows', async () => {
  const deep = `C:\\${'x'.repeat(200)}`;
  assert.equal((await openWorkspace(deep, { platform: 'win32', canonicalize: async p => p })).warnings.length, 1);
  assert.deepEqual((await openWorkspace('/tmp', { platform: 'linux' })).warnings, []);
});

test('the segments we mint stay under ~120 characters below the workspace root, over the deepest path the engine can construct', () => {
  // The bound is on what *we* mint — `.whiphand/runs/<run id>/`, `iter-N`,
  // `attempt-N`, the `.{step}.{suffix}` state files — not on names an author
  // chose, which the segment validator polices but cannot shorten. So the
  // authored parts are one-character placeholders, and the shape is the deepest
  // the schema allows: a loop inside a stage inside a loop, at high counts.
  const outer = { id: 'a', iteration: 99, maxIterations: 99 } as unknown as Frame;
  const stage = {
    kind: 'stages', id: 'b', attempt: 99, maxAttempts: 99, parent: outer,
    stage: { index: 99, total: 99, id: 'c', title: 't', path: 'p' },
  } as unknown as Frame;
  const inner = { id: 'd', iteration: 99, maxIterations: 99, parent: stage } as unknown as Frame;
  const root = '/w';
  const runDir = join(root, '.whiphand', 'runs', '20260919-101648-42c2');
  const below = artifactPath(runDir, { output: 'e' }, inner).slice(root.length + 1);
  assert.ok(below.length <= ENGINE_PATH_BUDGET, `${below.length} characters: ${below}`);
  // Leaves headroom for real names: authored ids and outputs get the rest of the budget.
  assert.ok(ENGINE_PATH_BUDGET - below.length >= 40, `only ${ENGINE_PATH_BUDGET - below.length} characters left for authored names`);
  // The state files kept beside a run's artifacts: the longest suffix we mint, on a 1-character step id.
  for (const suffix of ['system-prompt.md', 'opencode-plugin.mjs', 'harvest-prompt', 'settings.json']) {
    assert.ok(join(runDir, `.s.${suffix}`).slice(root.length + 1).length <= ENGINE_PATH_BUDGET, suffix);
  }
});

test('identity comparison is the pure comparator applied to identity keys', () => {
  assert.equal(samePath('c:/users/me/proj', 'C:\\Users\\Me\\Proj'), true);
});
