import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'version.mjs');

const FILES = {
  'apps/desktop/package.json': '{\n  "name": "desktop",\n  "version": "0.1.0",\n  "type": "module"\n}\n',
  'packages/core/package.json': '{\n  "name": "@whiphand/core",\n  "version": "0.1.0"\n}\n',
  'packages/agent/package.json': '{\n  "name": "@whiphand/agent",\n  "version": "0.1.0"\n}\n',
  'apps/desktop/src-tauri/Cargo.toml':
    '[package]\nname = "whiphand"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = "1"\n',
  'apps/desktop/src-tauri/Cargo.lock':
    '[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "whiphand"\nversion = "0.1.0"\ndependencies = [\n "serde",\n]\n',
  'crates/whiphand-core/Cargo.toml':
    '[package]\nname = "whiphand-core"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\nregex = "1"\n',
  'crates/whiphand-cli/Cargo.toml':
    '[package]\nname = "whiphand-cli"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\nclap = "4"\n',
  'Cargo.lock':
    '[[package]]\nname = "whiphand-cli"\nversion = "0.1.0"\n\n[[package]]\nname = "whiphand-core"\nversion = "0.1.0"\n\n'
    + '[[package]]\nname = "whiphand-job"\nversion = "0.9.0"\n',
  'apps/desktop/src-tauri/tauri.conf.json':
    '{\n  "productName": "Whiphand",\n  "version": "0.1.0",' +
    '  "plugins": { "updater": {' +
    '    "pubkey": "REPLACE_WITH_OPERATOR_GENERATED_PUBKEY",' +
    '    "endpoints": ["https://github.com/PlainBytes/whip-hand/releases/latest/download/latest.json"]' +
    '  } }\n}\n',
  'apps/desktop/src/lib/updater.ts':
    "const RELEASE_PAGE_URL = 'https://github.com/PlainBytes/whip-hand/releases/latest';\n",
  'packages/core/src/version.ts': "export const CORE_VERSION = '0.1.0';\n",
  'packages/core/src/index.ts': "export { CORE_VERSION } from './version.ts';\nexport * from './types.ts';\n",
  'package-lock.json': `${JSON.stringify({
    name: 'whiphand',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'whiphand', workspaces: ['packages/*', 'apps/*'] },
      'apps/desktop': { version: '0.1.0' },
      'node_modules/commander': { version: '14.0.0', license: 'MIT' },
      'packages/agent': { name: '@whiphand/agent', version: '0.1.0', dependencies: { '@whiphand/core': '*' } },
      'packages/core': { name: '@whiphand/core', version: '0.1.0' },
    },
  }, null, 2)}\n`,
};

function makeFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whiphand-version-'));
  for (const [relPath, content] of Object.entries(FILES)) {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(scriptPath, path.join(root, 'scripts/version.mjs'));
  return root;
}

function run(root, args) {
  return execFileSync(process.execPath, [path.join(root, 'scripts/version.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('--check agrees when every location already matches', () => {
  const root = makeFixtureRepo();
  try {
    const out = run(root, ['--check', '0.1.0']);
    assert.match(out, /ok: every location agrees on 0\.1\.0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check exits non-zero and lists every mismatch', () => {
  const root = makeFixtureRepo();
  try {
    assert.throws(() => run(root, ['--check', '0.2.0']), (error) => {
      assert.equal(error.status, 1);
      const stderr = String(error.stderr);
      assert.match(stderr, /version mismatch: expected 0\.2\.0/);
      assert.match(stderr, /apps\/desktop\/package\.json: 0\.1\.0/);
      assert.match(stderr, /Cargo\.toml: 0\.1\.0/);
      assert.match(stderr, /src-tauri\/Cargo\.lock \(whiphand\): 0\.1\.0/);
      assert.match(stderr, /crates\/whiphand-core\/Cargo\.toml: 0\.1\.0/);
      assert.match(stderr, /^  Cargo\.lock \(whiphand-core\): 0\.1\.0/m);
      assert.match(stderr, /package-lock\.json \(packages\/core\): 0\.1\.0/);
      assert.match(stderr, /^  Cargo\.lock \(whiphand-cli\): 0\.1\.0/m);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writing a version updates every location, including Cargo.lock and package-lock.json', () => {
  const root = makeFixtureRepo();
  try {
    run(root, ['0.2.0']);

    const desktopPkg = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'));
    assert.equal(desktopPkg.version, '0.2.0');

    const cargoToml = fs.readFileSync(path.join(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
    assert.match(cargoToml, /version = "0\.2\.0"/);

    const cargoLock = fs.readFileSync(path.join(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8');
    assert.match(cargoLock, /name = "whiphand"\nversion = "0\.2\.0"/);
    assert.match(cargoLock, /name = "other"\nversion = "9\.9\.9"/);

    const coreToml = fs.readFileSync(path.join(root, 'crates/whiphand-core/Cargo.toml'), 'utf8');
    assert.match(coreToml, /version = "0\.2\.0"/);
    const workspaceLock = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
    assert.match(workspaceLock, /name = "whiphand-core"\nversion = "0\.2\.0"/);
    assert.match(workspaceLock, /name = "whiphand-cli"\nversion = "0\.2\.0"/);
    const cliToml = fs.readFileSync(path.join(root, 'crates/whiphand-cli/Cargo.toml'), 'utf8');
    assert.match(cliToml, /version = "0\.2\.0"/);
    assert.match(workspaceLock, /name = "whiphand-job"\nversion = "0\.9\.0"/);

    const tauriConf = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
    assert.equal(tauriConf.version, '0.2.0');

    const coreVersion = fs.readFileSync(path.join(root, 'packages/core/src/version.ts'), 'utf8');
    assert.match(coreVersion, /CORE_VERSION = '0\.2\.0'/);

    const lockText = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
    const lock = JSON.parse(lockText);
    for (const workspace of ['apps/desktop', 'packages/core', 'packages/agent']) {
      assert.equal(lock.packages[workspace].version, '0.2.0', workspace);
    }
    assert.equal(lock.packages['node_modules/commander'].version, '14.0.0');
    assert.equal(lock.packages['packages/agent'].dependencies['@whiphand/core'], '*');
    assert.equal(lockText, `${JSON.stringify(lock, null, 2)}\n`);

    const checkOut = run(root, ['--check', '0.2.0']);
    assert.match(checkOut, /ok: every location agrees on 0\.2\.0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a malformed version instead of writing a partial update', () => {
  const root = makeFixtureRepo();
  try {
    assert.throws(() => run(root, ['1.0']), (error) => {
      assert.equal(error.status, 1);
      return true;
    });
    const desktopPkg = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'));
    assert.equal(desktopPkg.version, '0.1.0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check-release refuses a tree whose updater is still a placeholder', () => {
  const root = makeFixtureRepo();
  try {
    assert.throws(() => run(root, ['--check-release']), error => {
      assert.equal(error.status, 1);
      const stderr = error.stderr.toString();
      assert.match(stderr, /plugins\.updater\.pubkey/);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check-release passes once the operator has filled every placeholder in', () => {
  const root = makeFixtureRepo();
  try {
    const conf = path.join(root, 'apps/desktop/src-tauri/tauri.conf.json');
    fs.writeFileSync(conf, fs.readFileSync(conf, 'utf8')
      .replace('REPLACE_WITH_OPERATOR_GENERATED_PUBKEY', 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu'));

    assert.match(run(root, ['--check-release']), /ok: no unresolved release placeholders/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
