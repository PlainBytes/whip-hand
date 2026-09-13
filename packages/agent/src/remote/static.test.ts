import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { contentTypeFor, resolveStatic, safeResolve, sendStatic } from './static.ts';

const ROOT = '/srv/web';

test('safeResolve accepts paths inside the root', () => {
  assert.equal(safeResolve(ROOT, '/'), resolve(ROOT));
  assert.equal(safeResolve(ROOT, '/index.html'), join(resolve(ROOT), 'index.html'));
  assert.equal(safeResolve(ROOT, '/assets/app-a1b2.js'), join(resolve(ROOT), 'assets', 'app-a1b2.js'));
  assert.equal(safeResolve(ROOT, '/assets/x.js?v=1'), join(resolve(ROOT), 'assets', 'x.js'), 'query stripped');
  assert.equal(safeResolve(ROOT, '/a%20b.css'), join(resolve(ROOT), 'a b.css'), 'percent-decoded');
});

test('safeResolve rejects every traversal shape', () => {
  const rejected = [
    '/../../etc/passwd',
    '/..%2f..%2fetc/passwd',
    '/%2e%2e%2f%2e%2e%2fetc/passwd',   // decoding must happen BEFORE the check
    '/assets/../../etc/passwd',
    '/..',
    '/etc/passwd\0.js',                 // NUL truncation
    '/..\\..\\windows\\system32',       // backslash is a separator on Windows
    '/%',                               // malformed escape: decodeURIComponent throws
    'index.html',                       // not rooted
    '',
  ];
  for (const path of rejected) {
    assert.equal(safeResolve(ROOT, path), null, `expected rejection: ${JSON.stringify(path)}`);
  }
});

test('safeResolve keeps a dotfile that does not escape', () => {
  assert.equal(safeResolve(ROOT, '/.well-known/x'), join(resolve(ROOT), '.well-known', 'x'));
});

test('contentTypeFor covers the bundle and defaults to octet-stream', () => {
  assert.equal(contentTypeFor('/x/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('/x/app.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('/x/app.css'), 'text/css; charset=utf-8');
  assert.equal(contentTypeFor('/x/f.woff2'), 'font/woff2');
  assert.equal(contentTypeFor('/x/f.unknown'), 'application/octet-stream');
});

test('resolveStatic serves files, falls back to the shell, and 404s missing assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whiphand-web-'));
  await writeFile(join(root, 'index.html'), '<!doctype html>', 'utf8');
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)', 'utf8');

  const shell = await resolveStatic(root, '/');
  assert.equal(shell?.isShell, true);
  assert.equal(shell?.contentType, 'text/html; charset=utf-8');

  const asset = await resolveStatic(root, '/assets/app.js');
  assert.equal(asset?.isShell, false);
  assert.equal(asset?.path, join(root, 'assets', 'app.js'));

  // A client-side route the SPA handles itself.
  const route = await resolveStatic(root, '/runs/abc');
  assert.equal(route?.isShell, true);

  // A missing CHUNK must 404, not return HTML the browser would try to execute.
  assert.equal(await resolveStatic(root, '/assets/missing.js'), null);
  assert.equal(await resolveStatic(root, '/../../etc/passwd'), null);
});

test('resolveStatic returns null when the bundle was never built', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whiphand-web-empty-'));
  assert.equal(await resolveStatic(root, '/'), null);
  assert.equal(await resolveStatic(root, '/anything'), null);
});

test('sendStatic sets a CSP header, since this build has no tauri.conf.json to carry one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whiphand-web-csp-'));
  const file = join(root, 'index.html');
  await writeFile(file, '<!doctype html>', 'utf8');

  let headers: Record<string, string> = {};
  const sink = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const res = Object.assign(sink, {
    writeHead: (_status: number, h: Record<string, string>) => { headers = h; },
  }) as unknown as Parameters<typeof sendStatic>[0];

  sendStatic(res, { path: file, contentType: 'text/html; charset=utf-8', isShell: true });
  await new Promise(resolve => sink.on('finish', resolve));

  assert.match(headers['Content-Security-Policy'] ?? '', /default-src 'self'/);
  assert.doesNotMatch(headers['Content-Security-Policy'] ?? '', /unsafe-eval/);
});
