import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWslLauncher, resolveShell, shellRefusal } from './shell.ts';

/** A fake Git for Windows layout, described as Windows paths and answered by name on any host. */
function layout(...present: string[]): { exists: (p: string) => boolean } {
  const files = new Set(present.map(p => p.toLowerCase()));
  return { exists: p => files.has(p.toLowerCase()) };
}

const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';

test('POSIX: /bin/sh, with nothing to discover', () => {
  assert.deepEqual(resolveShell({ platform: 'linux' }), { ok: true, path: '/bin/sh' });
  assert.deepEqual(resolveShell({ platform: 'darwin' }), { ok: true, path: '/bin/sh' });
});

test('Windows: derived from the resolved git, preferring sh.exe in usr\\bin, reported as an absolute forward-slash path', () => {
  const result = resolveShell({
    platform: 'win32', git: GIT,
    ...layout('C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'),
  });
  assert.deepEqual(result, { ok: true, path: 'C:/Program Files/Git/usr/bin/sh.exe' });
});

test('Windows: falls back through bin\\sh.exe, then bash.exe, in that order', () => {
  assert.deepEqual(resolveShell({ platform: 'win32', git: GIT, ...layout('C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\bash.exe') }),
    { ok: true, path: 'C:/Program Files/Git/bin/sh.exe' });
  assert.deepEqual(resolveShell({ platform: 'win32', git: GIT, ...layout('C:\\Program Files\\Git\\bin\\bash.exe') }),
    { ok: true, path: 'C:/Program Files/Git/bin/bash.exe' });
  assert.deepEqual(resolveShell({ platform: 'win32', git: GIT, ...layout('C:\\Program Files\\Git\\usr\\bin\\bash.exe') }),
    { ok: true, path: 'C:/Program Files/Git/usr/bin/bash.exe' });
});

test('Windows: git under mingw64\\bin still finds the install root', () => {
  const result = resolveShell({
    platform: 'win32', git: 'C:\\Git\\mingw64\\bin\\git.exe', ...layout('C:\\Git\\usr\\bin\\sh.exe'),
  });
  assert.deepEqual(result, { ok: true, path: 'C:/Git/usr/bin/sh.exe' });
});

test('Windows: a portable Git in a path with a space is found the same way', () => {
  const result = resolveShell({
    platform: 'win32', git: 'D:\\Tools and Things\\PortableGit\\cmd\\git.exe',
    ...layout('D:\\Tools and Things\\PortableGit\\usr\\bin\\sh.exe'),
  });
  assert.deepEqual(result, { ok: true, path: 'D:/Tools and Things/PortableGit/usr/bin/sh.exe' });
});

test('Windows: %PROGRAMFILES%\\Git is the last resort when git itself is elsewhere', () => {
  const result = resolveShell({
    platform: 'win32', git: 'E:\\scoop\\shims\\git.exe', env: { PROGRAMFILES: 'C:\\Program Files' },
    ...layout('C:\\Program Files\\Git\\usr\\bin\\sh.exe'),
  });
  assert.deepEqual(result, { ok: true, path: 'C:/Program Files/Git/usr/bin/sh.exe' });
});

test('Windows: never a bare PATH lookup for bash — System32\\bash.exe (the WSL launcher) is rejected by name even when present', () => {
  // git in System32 is contrived, but it is the only way derivation could land
  // on the launcher, and the rule is by name, not by luck of layout.
  const result = resolveShell({
    platform: 'win32', git: 'C:\\Windows\\System32\\git.exe', ...layout('C:\\Windows\\System32\\bash.exe', 'C:\\Windows\\bash.exe'),
    env: {},
  });
  assert.equal(result.ok, false);
  assert.equal(isWslLauncher('C:\\Windows\\System32\\bash.exe'), true);
  assert.equal(isWslLauncher('c:\\windows\\sysnative\\BASH.EXE'), true);
  assert.equal(isWslLauncher('C:\\Program Files\\Git\\bin\\bash.exe'), false);
});

test('Windows: PATH is not consulted for bash at all', () => {
  const result = resolveShell({
    platform: 'win32', git: GIT,
    env: { PATH: 'C:\\Windows\\System32' },
    ...layout('C:\\Windows\\System32\\bash.exe'),
  });
  assert.equal(result.ok, false);
});

test('Windows: no shell is a result with a reason and a remediation, not a throw', () => {
  const result = resolveShell({ platform: 'win32', git: GIT, env: {}, ...layout() });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /no POSIX shell found near git \(C:\/Program Files\/Git\/cmd\/git\.exe\)/);
  assert.match(result.remediation, /Install Git for Windows/);
  assert.match(shellRefusal(result), /Command steps are refused until a shell is found; agent steps still run/);
});

test('Windows: git missing altogether says so', () => {
  const result = resolveShell({ platform: 'win32', git: 'git', env: { PATH: '' }, ...layout() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /git was not found on PATH/);
});

test('Windows: resolution is fresh each call — a shell installed mid-session is found next time', () => {
  const files = new Set<string>();
  const exists = (p: string): boolean => files.has(p.toLowerCase());
  assert.equal(resolveShell({ platform: 'win32', git: GIT, env: {}, exists }).ok, false);
  files.add('c:\\program files\\git\\usr\\bin\\sh.exe');
  assert.equal(resolveShell({ platform: 'win32', git: GIT, env: {}, exists }).ok, true);
});
