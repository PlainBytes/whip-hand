import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contains, isUncPath, isWindowsAbsolute, samePath, sameWorkspace, findWorkspaceKey, shQuote, toFwd, toFwdAbs, toNative, toRunRel, toWorkspace, pathKey,
} from './path-form.ts';

test('samePath ignores case, separators, dots and dot-dots on Windows-shaped paths', () => {
  assert.equal(samePath('C:\\Proj', 'c:\\proj'), true);
  assert.equal(samePath('C:\\Proj\\', 'C:/Proj'), true);
  assert.equal(samePath('C:\\Proj\\a\\..\\b', 'c:/proj/b'), true);
  assert.equal(samePath('C:\\Proj\\.', 'C:\\proj'), true);
  assert.equal(samePath('C:\\Proj', 'D:\\Proj'), false);
  assert.equal(samePath('C:\\Proj', 'C:\\Proj2'), false);
});

test('POSIX paths stay case- and backslash-sensitive', () => {
  assert.equal(samePath('/home/A/proj', '/home/a/proj', { platform: 'linux' }), false);
  assert.equal(samePath('/home/a/proj/', '/home/a/./proj', { platform: 'linux' }), true);
  assert.equal(samePath('/tmp/a\\b', '/tmp/a/b', { platform: 'linux' }), false);
});

test('contains works on paths that do not exist and compares whole segments', () => {
  assert.equal(contains('C:\\Proj', 'c:\\proj\\.whiphand\\runs\\r1'), true);
  assert.equal(contains('C:\\Proj', 'C:\\Proj'), true);
  assert.equal(contains('C:\\Proj', 'C:\\Project\\x'), false);
  assert.equal(contains('C:\\Proj', 'C:\\Proj\\..\\Other'), false);
  assert.equal(contains('C:\\Proj', 'D:\\Proj\\x'), false);
  assert.equal(contains('/a/b', '/a/b/c', { platform: 'linux' }), true);
  assert.equal(contains('/a/b', '/a/bc', { platform: 'linux' }), false);
  assert.equal(contains('/', '/anything', { platform: 'linux' }), true);
});

test('the extended-length prefix names the same place', () => {
  assert.equal(samePath('\\\\?\\C:\\Proj', 'C:\\proj'), true);
  assert.equal(contains('C:\\Proj', '\\\\?\\c:\\proj\\a'), true);
  assert.equal(pathKey('\\\\?\\C:\\Proj'), pathKey('C:/proj'));
});

test('a relative path with a leading .. never counts as contained', () => {
  assert.equal(contains('a/b', 'a/b/../c', { platform: 'linux' }), false);
  assert.equal(contains('../x', '../x/y', { platform: 'linux' }), false);
});

test('UNC detection is by string, and the extended prefix is not UNC', () => {
  assert.equal(isUncPath('\\\\server\\share\\proj'), true);
  assert.equal(isUncPath('//server/share/proj'), true);
  assert.equal(isUncPath('\\\\?\\C:\\proj'), false);
  assert.equal(isUncPath('C:\\proj'), false);
  assert.equal(isWindowsAbsolute('C:\\x'), true);
  assert.equal(isWindowsAbsolute('/x'), false);
});

test('toWorkspace emits relative /-form, keeping the original casing, and one absolute fallback', () => {
  assert.equal(toWorkspace('C:\\Proj\\.whiphand\\Runs\\r1\\plan.md', 'c:\\proj'), '.whiphand/Runs/r1/plan.md');
  assert.equal(toWorkspace('C:\\Proj', 'C:\\Proj'), '.');
  assert.equal(toWorkspace('D:\\other\\x.md', 'C:\\Proj'), 'D:/other/x.md');
  assert.equal(toWorkspace('/home/u/x/plan.md', '/home/u/x'), 'plan.md');
  assert.equal(toWorkspace('/etc/hosts', '/home/u/x'), '/etc/hosts');
});

test('toRunRel is relative to the run directory', () => {
  assert.equal(toRunRel('/w/.whiphand/runs/r1/attachments/a.png', '/w/.whiphand/runs/r1'), 'attachments/a.png');
  assert.equal(toRunRel('C:\\w\\.whiphand\\runs\\r1\\x.md', 'C:\\w\\.whiphand\\runs\\r1'), 'x.md');
  assert.equal(toRunRel('/somewhere/else', '/w/r1'), '/somewhere/else');
});

test('toFwdAbs and toFwd', () => {
  assert.equal(toFwdAbs('C:\\Program Files\\Git\\bin\\sh.exe'), 'C:/Program Files/Git/bin/sh.exe');
  assert.equal(toFwdAbs('\\\\?\\C:\\proj'), 'C:/proj');
  assert.equal(toFwd('a\\b/c'), 'a/b/c');
});

test('toNative is the only place a path becomes native', () => {
  assert.equal(toNative('.whiphand/runs/r1', 'C:\\Proj'), 'C:\\Proj\\.whiphand\\runs\\r1');
  assert.equal(toNative('C:/x/y', 'C:\\Proj'), 'C:\\x\\y');
  assert.equal(toNative('a/b', '/w', { platform: 'linux' }), '/w/a/b');
  assert.equal(toNative('/x/y', '/w', { platform: 'linux' }), '/x/y');
  assert.equal(toNative('../z', 'C:\\Proj\\sub'), 'C:\\Proj\\z');
});

test('shQuote makes any value inert in a POSIX shell', () => {
  assert.equal(shQuote('plain'), 'plain', 'a value with nothing special is left as it is');
  assert.equal(shQuote('/w/.whiphand/runs/r1/.plan.done'), '/w/.whiphand/runs/r1/.plan.done');
  assert.equal(shQuote('C:/Users/me/My Docs/x'), `'C:/Users/me/My Docs/x'`, 'a space needs quoting');
  assert.equal(shQuote(''), "''");
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  assert.equal(shQuote('a b; rm -rf ~ $(x) `y` "z"'), `'a b; rm -rf ~ $(x) \`y\` "z"'`);
  assert.throws(() => shQuote('a\0b'), /NUL/);
});

test('sameWorkspace compares identity keys when both sides have one, and falls back to the path otherwise', () => {
  const short = { path: 'C:\\PROGRA~1\\Proj', identityKey: 'c:/program files/proj' };
  const long = { path: 'C:\\Program Files\\Proj', identityKey: 'c:/program files/proj' };
  assert.equal(sameWorkspace(short, long), true, 'two spellings of one directory share a key');
  assert.equal(sameWorkspace(short, { path: 'C:\\PROGRA~1\\Proj', identityKey: 'c:/elsewhere' }), false,
    'the keys decide, even when the spelling matches');
  assert.equal(sameWorkspace({ path: 'C:\\Proj' }, { path: 'c:\\proj', identityKey: 'c:/proj' }), true,
    'an entry with no key falls back to the pure path comparator');
  assert.equal(sameWorkspace({ path: 'C:\\PROGRA~1\\Proj' }, long), false, 'and cannot see an alias it has no key for');
  assert.equal(sameWorkspace({ path: '/a' }, { path: '/b' }), false);
});

test('findWorkspaceKey finds the record entry for a workspace under whichever spelling it was first stored', () => {
  const records = { 'C:\\PROGRA~1\\Proj': { identityKey: 'c:/program files/proj' }, '/legacy': {} };
  assert.equal(findWorkspaceKey(records, { path: 'C:\\Program Files\\Proj', identityKey: 'c:/program files/proj' }), 'C:\\PROGRA~1\\Proj');
  assert.equal(findWorkspaceKey(records, { path: '/legacy', identityKey: '/real/legacy' }), '/legacy');
  assert.equal(findWorkspaceKey(records, { path: '/elsewhere', identityKey: '/elsewhere' }), undefined);
});
