import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { clearStaleBundles, collectBundles } from './package/desktop.mjs';

// Tauri never clears src-tauri/target/release/bundle/<format>/, so after a
// version bump the previous version's bundle sits next to the new one. Before
// these helpers existed, reinstall.mjs took the first `.deb` it was handed —
// `Whiphand_0.1.0_amd64.deb` sorts before `Whiphand_0.1.3_amd64.deb` — and
// silently installed yesterday's build.

function scratch() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'whiphand-desktop-'));
  const bundleRoot = path.join(root, 'bundle');
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  return { root, bundleRoot, distDir };
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

const linux = {
  productName: 'Whiphand',
  bundleFormats: ['deb', 'appimage'],
  bundleExtensions: ['deb', 'AppImage', 'AppImage.sig'],
};

test('clearStaleBundles empties the bundle format directories an earlier build left behind', () => {
  const { root, bundleRoot, distDir } = scratch();
  try {
    touch(path.join(bundleRoot, 'deb/Whiphand_0.1.0_amd64.deb'));
    touch(path.join(bundleRoot, 'appimage/Whiphand_0.1.0_amd64.AppImage'));

    clearStaleBundles({ bundleRoot, distDir, ...linux });

    assert.equal(fs.existsSync(path.join(bundleRoot, 'deb')), false);
    assert.equal(fs.existsSync(path.join(bundleRoot, 'appimage')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clearStaleBundles removes earlier desktop bundles from dist/ but leaves the CLI and agent binaries', () => {
  const { root, bundleRoot, distDir } = scratch();
  try {
    for (const name of ['Whiphand_0.1.0_amd64.deb', 'Whiphand_0.1.0_amd64.AppImage', 'Whiphand_0.1.0_amd64.AppImage.sig', 'whiphand', 'whiphand-agent']) {
      touch(path.join(distDir, name));
    }

    clearStaleBundles({ bundleRoot, distDir, ...linux });

    assert.deepEqual(fs.readdirSync(distDir).sort(), ['whiphand', 'whiphand-agent']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clearStaleBundles on Windows does not mistake the CLI .exe binaries for installers', () => {
  const { root, bundleRoot, distDir } = scratch();
  try {
    for (const name of ['Whiphand_0.1.0_x64-setup.exe', 'Whiphand_0.1.0_x64-setup.exe.sig', 'whiphand.exe', 'whiphand-agent.exe']) {
      touch(path.join(distDir, name));
    }

    clearStaleBundles({ bundleRoot, distDir, productName: 'Whiphand', bundleFormats: ['nsis'], bundleExtensions: ['exe', 'exe.sig'] });

    assert.deepEqual(fs.readdirSync(distDir).sort(), ['whiphand-agent.exe', 'whiphand.exe']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectBundles copies only the current version into dist/ and refuses a bundle of any other version', () => {
  const { root, bundleRoot, distDir } = scratch();
  try {
    touch(path.join(bundleRoot, 'deb/Whiphand_0.1.3_amd64.deb'));
    touch(path.join(bundleRoot, 'appimage/Whiphand_0.1.3_amd64.AppImage'));

    const collected = collectBundles({ bundleRoot, distDir, version: '0.1.3', isWindows: false, ...linux });
    assert.deepEqual(collected.map(file => path.basename(file)).sort(), ['Whiphand_0.1.3_amd64.AppImage', 'Whiphand_0.1.3_amd64.deb']);

    touch(path.join(bundleRoot, 'deb/Whiphand_0.1.0_amd64.deb'));
    assert.throws(
      () => collectBundles({ bundleRoot, distDir, version: '0.1.3', isWindows: false, ...linux }),
      /Whiphand_0\.1\.0_amd64\.deb.*0\.1\.3/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
