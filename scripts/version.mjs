#!/usr/bin/env node
/**
 * `0.1.0` lives in six places that nothing keeps in sync automatically:
 * `apps/desktop/package.json`, the three `packages/{core,cli,agent}/package.json` files,
 * `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the literal
 * `CORE_VERSION` in `packages/core/src/version.ts`. The Tauri updater compares
 * `tauri.conf.json`'s version against `latest.json`, and `whiphand --version`
 * prints `CORE_VERSION` — so a release where these disagree is a bug class,
 * not untidiness. `Cargo.lock`'s own `desktop` entry is a seventh, mechanical
 * location: not a place a human would edit, but one `cargo` will flag as
 * stale if it drifts.
 *
 * `packages/cli/package.json` also pins `"@whiphand/core": "0.1.0"` exactly rather
 * than a workspace range — left stale, `npm ci` resolves it against the
 * registry instead of the sibling package once core's real version moves
 * past it. Not one of the plan's six, but the same bug class, so it is kept
 * in sync here too.
 *
 * `package-lock.json` records each workspace's version and that same pin
 * again. `npm ci` tolerates it lagging, but the next `npm install` rewrites
 * it, so a bump that skips it leaves a stray lockfile diff for whoever
 * installs next. It is edited as parsed JSON rather than by running
 * `npm install --package-lock-only`: same bytes as npm writes (checked), with
 * no network and no npm version in the loop.
 *
 * Usage:
 *   npm run bump -- <x.y.z>                     # the same as the first line below
 *   node scripts/version.mjs <x.y.z>            # write the new version everywhere
 *   node scripts/version.mjs --check <x.y.z>    # assert everything agrees; exits 1 and lists mismatches otherwise
 *   node scripts/version.mjs --check-release    # assert no updater placeholder is still unresolved
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+$/;

const PACKAGE_JSON_FILES = [
  'apps/desktop/package.json',
  'packages/core/package.json',
  'packages/cli/package.json',
  'packages/agent/package.json',
];
const CARGO_TOML = 'apps/desktop/src-tauri/Cargo.toml';
const CARGO_LOCK = 'apps/desktop/src-tauri/Cargo.lock';
const TAURI_CONF = 'apps/desktop/src-tauri/tauri.conf.json';
const CORE_INDEX = 'packages/core/src/version.ts';
const CLI_PACKAGE_JSON = 'packages/cli/package.json';
const PACKAGE_LOCK = 'package-lock.json';
/** The `packages` keys under which package-lock.json records a workspace — the same four as PACKAGE_JSON_FILES. */
const LOCK_WORKSPACES = PACKAGE_JSON_FILES.map(file => path.posix.dirname(file));

/**
 * The updater's public key ships as a placeholder on purpose: generating the
 * signing key is an operator step on an operator's machine (`tauri signer
 * generate` — see README), and it cannot be filled in by CI or by an agent.
 *
 * A release built with it still installs fine and then silently cannot update:
 * any manifest that arrives could never be verified. That is invisible until
 * the *next* release fails to reach anyone, so it is checked before a tag
 * spends any build minutes rather than discovered later.
 *
 * The endpoint URLs (`tauri.conf.json`'s `plugins.updater.endpoints`,
 * `updater.ts`'s `RELEASE_PAGE_URL`) are not guarded here: both are already
 * resolved to the repo's real owner, so there is nothing left to guard — a
 * wrong owner would be a typo, not an unfilled blank, and updater.test.ts
 * pins the string against that.
 */
const RELEASE_PLACEHOLDERS = [
  [TAURI_CONF, 'REPLACE_WITH_OPERATOR_GENERATED_PUBKEY', 'the updater signing key (plugins.updater.pubkey)'],
];

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}
function write(relPath, content) {
  fs.writeFileSync(path.join(repoRoot, relPath), content);
}

/** Replaces exactly one `"version": "..."` occurrence — every file here has exactly one that matters. */
function replaceJsonVersion(content, version, relPath) {
  const pattern = /"version":\s*"(\d+\.\d+\.\d+)"/;
  if (!pattern.test(content)) throw new Error(`no "version" field found in ${relPath}`);
  return content.replace(pattern, `"version": "${version}"`);
}

function readJsonVersion(content, relPath) {
  const match = content.match(/"version":\s*"(\d+\.\d+\.\d+)"/);
  if (!match) throw new Error(`no "version" field found in ${relPath}`);
  return match[1];
}

/** Scoped to the `[package]` table's own `version` line — Cargo.toml has exactly one before its first `[dependencies...]` header. */
function replaceCargoTomlVersion(content, version) {
  const pattern = /^version = "(\d+\.\d+\.\d+)"/m;
  if (!pattern.test(content)) throw new Error(`no [package] version found in ${CARGO_TOML}`);
  return content.replace(pattern, `version = "${version}"`);
}

/** Scoped to the `[[package]] name = "whiphand"` stanza, so no dependency's version is touched. */
function replaceCargoLockVersion(content, version) {
  const pattern = /(name = "whiphand"\nversion = )"(\d+\.\d+\.\d+)"/;
  if (!pattern.test(content)) throw new Error(`no 'whiphand' package stanza found in ${CARGO_LOCK}`);
  return content.replace(pattern, `$1"${version}"`);
}

function replaceCoreVersion(content, version) {
  const pattern = /export const CORE_VERSION = '(\d+\.\d+\.\d+)';/;
  if (!pattern.test(content)) throw new Error(`CORE_VERSION not found in ${CORE_INDEX}`);
  return content.replace(pattern, `export const CORE_VERSION = '${version}';`);
}

/** The one dependency pin, distinct from the package's own `"version"` field above it. */
function replaceCliCoreDependency(content, version) {
  const pattern = /"@whiphand\/core":\s*"(\d+\.\d+\.\d+)"/;
  if (!pattern.test(content)) throw new Error(`"@whiphand/core" dependency not found in ${CLI_PACKAGE_JSON}`);
  return content.replace(pattern, `"@whiphand/core": "${version}"`);
}

/** npm writes the lockfile as two-space JSON with a trailing newline, and so does this. */
function replacePackageLockVersions(content, version) {
  const lock = JSON.parse(content);
  for (const workspace of LOCK_WORKSPACES) {
    const entry = lock.packages?.[workspace];
    if (!entry) throw new Error(`no "${workspace}" workspace entry found in ${PACKAGE_LOCK}`);
    entry.version = version;
  }
  const cliDeps = lock.packages[path.posix.dirname(CLI_PACKAGE_JSON)].dependencies;
  if (!cliDeps?.['@whiphand/core']) throw new Error(`"@whiphand/core" dependency not found in ${PACKAGE_LOCK}`);
  cliDeps['@whiphand/core'] = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function writeVersion(version) {
  for (const relPath of PACKAGE_JSON_FILES) {
    write(relPath, replaceJsonVersion(read(relPath), version, relPath));
  }
  write(CLI_PACKAGE_JSON, replaceCliCoreDependency(read(CLI_PACKAGE_JSON), version));
  write(CARGO_TOML, replaceCargoTomlVersion(read(CARGO_TOML), version));
  write(CARGO_LOCK, replaceCargoLockVersion(read(CARGO_LOCK), version));
  write(TAURI_CONF, replaceJsonVersion(read(TAURI_CONF), version, TAURI_CONF));
  write(CORE_INDEX, replaceCoreVersion(read(CORE_INDEX), version));
  write(PACKAGE_LOCK, replacePackageLockVersions(read(PACKAGE_LOCK), version));
}

function collectVersions() {
  const found = [];
  for (const relPath of PACKAGE_JSON_FILES) {
    found.push([relPath, readJsonVersion(read(relPath), relPath)]);
  }
  const cliContent = read(CLI_PACKAGE_JSON);
  const cliCoreDep = cliContent.match(/"@whiphand\/core":\s*"(\d+\.\d+\.\d+)"/);
  found.push([`${CLI_PACKAGE_JSON} (@whiphand/core dependency)`, cliCoreDep?.[1] ?? '(missing)']);

  const cargoToml = read(CARGO_TOML);
  found.push([CARGO_TOML, cargoToml.match(/^version = "(\d+\.\d+\.\d+)"/m)?.[1] ?? '(missing)']);

  const cargoLock = read(CARGO_LOCK);
  found.push([CARGO_LOCK, cargoLock.match(/name = "whiphand"\nversion = "(\d+\.\d+\.\d+)"/)?.[1] ?? '(missing)']);

  found.push([TAURI_CONF, readJsonVersion(read(TAURI_CONF), TAURI_CONF)]);

  const coreIndex = read(CORE_INDEX);
  found.push([CORE_INDEX, coreIndex.match(/CORE_VERSION = '(\d+\.\d+\.\d+)'/)?.[1] ?? '(missing)']);

  const lock = JSON.parse(read(PACKAGE_LOCK));
  for (const workspace of LOCK_WORKSPACES) {
    found.push([`${PACKAGE_LOCK} (${workspace})`, lock.packages?.[workspace]?.version ?? '(missing)']);
  }
  const lockCliDep = lock.packages?.[path.posix.dirname(CLI_PACKAGE_JSON)]?.dependencies?.['@whiphand/core'];
  found.push([`${PACKAGE_LOCK} (${CLI_PACKAGE_JSON} @whiphand/core dependency)`, lockCliDep ?? '(missing)']);

  return found;
}

function checkVersion(expected) {
  const found = collectVersions();
  const mismatches = found.filter(([, version]) => version !== expected);
  if (mismatches.length === 0) {
    process.stdout.write(`ok: every location agrees on ${expected}\n`);
    return true;
  }
  process.stderr.write(`version mismatch: expected ${expected}\n`);
  for (const [relPath, version] of mismatches) {
    process.stderr.write(`  ${relPath}: ${version}\n`);
  }
  return false;
}

/** Every unresolved release placeholder still in the tree, as printable lines. */
function findReleasePlaceholders() {
  return RELEASE_PLACEHOLDERS
    .filter(([relPath, marker]) => read(relPath).includes(marker))
    .map(([relPath, marker, what]) => `  ${relPath}: ${what} is still ${marker}`);
}

function checkRelease() {
  const unresolved = findReleasePlaceholders();
  if (unresolved.length === 0) {
    process.stdout.write('ok: no unresolved release placeholders\n');
    return true;
  }
  process.stderr.write('unresolved release placeholders — this tag would ship a broken updater:\n');
  for (const line of unresolved) process.stderr.write(`${line}\n`);
  process.stderr.write('see README, "Releases and auto-update", for the operator steps\n');
  return false;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--check-release') {
    process.exit(checkRelease() ? 0 : 1);
  }
  const checkIndex = args.indexOf('--check');
  const isCheck = checkIndex !== -1;
  const version = isCheck ? args[checkIndex + 1] : args[0];

  if (!version || !SEMVER.test(version)) {
    process.stderr.write(
      'usage: node scripts/version.mjs <x.y.z>\n'
      + '       node scripts/version.mjs --check <x.y.z>\n'
      + '       node scripts/version.mjs --check-release\n',
    );
    process.exit(1);
  }

  if (isCheck) {
    process.exit(checkVersion(version) ? 0 : 1);
  }

  writeVersion(version);
  process.stdout.write(`version set to ${version} in ${collectVersions().length} places\n`);
}

if (import.meta.filename === process.argv[1]) main();

export { writeVersion, checkVersion, checkRelease, findReleasePlaceholders };
