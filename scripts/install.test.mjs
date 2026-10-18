import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnRunner } from './lib/exec.mjs';

// scripts/install/install.sh against a release served from here. A `uname`
// shell function says which machine this is, so every case runs the same
// on both CI legs (Git's sh on Windows).

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install/install.sh');
const ASSET = 'whiphand-linux-x86_64';
const BINARY = '#!/bin/sh\necho 1.2.3\n';

const sha256 = text => createHash('sha256').update(text).digest('hex');

/** Serves `files` (url path → body) on 127.0.0.1; 404 for anything else. */
async function serve(files) {
  const server = http.createServer((req, res) => {
    const body = files[req.url];
    res.writeHead(body === undefined ? 404 : 200);
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function release(prefix, { sums = `${sha256(BINARY)}  ${ASSET}\n` } = {}) {
  return { [`${prefix}/${ASSET}`]: BINARY, [`${prefix}/SHA256SUMS`]: sums };
}

/** Runs install.sh as a machine reporting `os`/`arch`; resolves `{ status, output, dir }`. */
async function install(base, { os: osName = 'Linux', arch = 'x86_64', env = {} } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'whiphand-install-'));
  const dir = path.join(scratch, 'bin');
  // A function, not a uname on PATH: Git's sh.exe puts its own /usr/bin first.
  const machine = `uname() { case "$1" in -s) echo ${osName} ;; -m) echo ${arch} ;; esac; }`;
  const child = spawnRunner(['sh', '-c', `${machine}; . "$0"`, script.split(path.sep).join('/')], {
    env: {
      ...process.env,
      WHIPHAND_RELEASES_URL: base,
      WHIPHAND_INSTALL_DIR: dir.split(path.sep).join('/'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const status = await new Promise(resolve => child.on('close', resolve));
  return { status, output, dir, cleanup: () => fs.rmSync(scratch, { recursive: true, force: true }) };
}

test('install.sh installs the latest release once its checksum matches', async () => {
  const server = await serve(release('/latest/download'));
  const run = await install(server.base);
  try {
    assert.equal(run.status, 0, run.output);
    assert.equal(fs.readFileSync(path.join(run.dir, 'whiphand'), 'utf8'), BINARY);
    assert.match(run.output, /installed .*whiphand \(1\.2\.3\)/);
  } finally {
    run.cleanup();
    server.close();
  }
});

test('install.sh installs the release WHIPHAND_VERSION names', async () => {
  const server = await serve(release('/download/v1.2.3'));
  const run = await install(server.base, { env: { WHIPHAND_VERSION: '1.2.3' } });
  try {
    assert.equal(run.status, 0, run.output);
    assert.ok(fs.existsSync(path.join(run.dir, 'whiphand')));
  } finally {
    run.cleanup();
    server.close();
  }
});

test('install.sh installs nothing when the checksum does not match', async () => {
  const server = await serve(release('/latest/download', { sums: `${sha256('something else')}  ${ASSET}\n` }));
  const run = await install(server.base);
  try {
    assert.notEqual(run.status, 0);
    assert.match(run.output, /checksum mismatch/);
    assert.ok(!fs.existsSync(path.join(run.dir, 'whiphand')));
  } finally {
    run.cleanup();
    server.close();
  }
});

test('install.sh refuses a machine there is no build for', async () => {
  const server = await serve(release('/latest/download'));
  try {
    for (const machine of [{ os: 'Darwin', arch: 'arm64', why: /Linux build/ }, { os: 'Linux', arch: 'aarch64', why: /only x86_64/ }]) {
      const run = await install(server.base, machine);
      try {
        assert.notEqual(run.status, 0);
        assert.match(run.output, machine.why);
        assert.ok(!fs.existsSync(path.join(run.dir, 'whiphand')));
      } finally {
        run.cleanup();
      }
    }
  } finally {
    server.close();
  }
});
