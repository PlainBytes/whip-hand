/**
 * Shared pipeline for both binaries: esbuild bundle -> SEA blob -> postject.
 *
 * `format: 'cjs'` is not a preference. Node rejects an ESM main script for a
 * single executable application, so the bundle must be CommonJS even though
 * every source file is ESM with `.ts` specifiers. esbuild resolves and converts
 * both; `erasableSyntaxOnly` in tsconfig.json already guarantees the type
 * syntax it has to strip.
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planLaunch, runSync, verbatim } from '../../packages/core/src/exec.ts';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const distDir = path.join(repoRoot, 'dist');

/** postject's sentinel, fixed by Node's SEA implementation. */
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function log(step, detail) {
  process.stdout.write(`  ${step.padEnd(9)} ${detail}\n`);
}

/**
 * Node ships `node.exe` signed. Injecting the SEA blob into it leaves that
 * signature invalid, so it has to come off first — `signtool` is not on the
 * runner's PATH, it lives under a version-numbered Windows Kits directory.
 * Fails loudly rather than silently shipping a binary with a broken signature.
 */
function findSigntool() {
  const kitsBin = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (!fs.existsSync(kitsBin)) {
    throw new Error(`signtool not found: ${kitsBin} does not exist. Install the Windows 10/11 SDK.`);
  }
  const versions = fs.readdirSync(kitsBin, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
    .reverse();
  for (const version of versions) {
    const candidate = path.join(kitsBin, version, 'x64', 'signtool.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`signtool.exe not found under any version in ${kitsBin} — is the Windows SDK installed?`);
}

/**
 * Resolves an argv through core's launch plan and prepares the spawn
 * options that make cmd.exe (if one turns out to be needed) receive it
 * unwrapped, instead of Node's own `shell: true` — which joins file and args
 * with a bare space and no quoting (DEP0190) and would break on any argument
 * containing a space. Every spawn in this file goes through this, so a
 * resolved `.bat`/`.cmd` on Windows never sees a raw, unresolved command
 * string. `deps` is exposed only so sea.test.mjs can exercise the Windows
 * path (`platform: 'win32'`) without a Windows host.
 */
export function planExec(argv, deps = {}) {
  const plan = planLaunch(argv, deps);
  return { file: plan.file, args: plan.args, options: verbatim(plan.invocation) };
}

/**
 * The "design for signing later" seam: unset today, so this is a no-op on
 * every build until an operator sets it. Its installer-side twin is Tauri's
 * own `bundle.windows.signCommand`. Whatever command is set is expected to
 * sign in place and exit non-zero on failure.
 *
 * WHIPHAND_SIGN_COMMAND must name a single executable, not a full command
 * line with its own arguments (see README): resolving it through planExec is
 * what stops shell metacharacters in an operator-supplied command string from
 * injecting arbitrary commands, and a multi-word command line has nowhere to
 * be split back apart once it is treated as a single executable name.
 */
export function runSignCommand(binary) {
  const command = process.env.WHIPHAND_SIGN_COMMAND;
  if (!command) return;
  runSync([command, binary], { check: true });
  log('sign', 'WHIPHAND_SIGN_COMMAND applied');
}

/**
 * @param {object} options
 * @param {string} options.name        output binary name, written to dist/
 * @param {string} options.entry       absolute path to the TypeScript entry point
 * @param {Record<string,string>} [options.assets]  SEA assets, keyed by lookup name
 * @param {import('esbuild').Plugin[]} [options.plugins]
 * @param {Record<string,string>} [options.define]
 * @param {string[]} [options.external]  modules left as a runtime `require`, not bundled
 * @returns {Promise<string>} absolute path to the built binary
 */
export async function buildSingleExecutable({ name, entry, assets = {}, plugins = [], define = {}, external = [] }) {
  const work = path.join(distDir, '.build', name);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });

  const bundle = path.join(work, 'bundle.cjs');
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    sourcemap: false,
    absWorkingDir: repoRoot,
    plugins,
    define,
    external,
    logLevel: 'warning',
    // native.ts's `import.meta.url` fallback is unreachable once `define`
    // supplies WHIPHAND_NODE_PTY_DIR_DEFAULT (every packaged build does) — esbuild
    // cannot see that and warns anyway, since "import.meta" is empty under
    // `format: 'cjs'`. Silencing the one rule, not warnings in general.
    logOverride: { 'empty-import-meta': 'silent' },
  });
  log('bundle', `${path.relative(repoRoot, bundle)} (${(fs.statSync(bundle).size / 1024).toFixed(0)} KB)`);

  const blob = path.join(work, 'sea.blob');
  const config = path.join(work, 'sea-config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: true, assets }, null, 2),
  );
  // stderr captured, not inherited: the blob builder announces itself on every
  // run, which is noise the surrounding log already covers. Kept for failures.
  try {
    runSync([process.execPath, '--experimental-sea-config', config], { stdio: ['ignore', 'ignore', 'pipe'], check: true });
  } catch (error) {
    process.stderr.write(String(error.stderr ?? ''));
    throw error;
  }
  log('blob', `${(fs.statSync(blob).size / 1024 / 1024).toFixed(1)} MB`);

  // A copy of *this* machine's node. It is injectable because this build is
  // static: process.config.variables.node_shared === false.
  const isWindows = process.platform === 'win32';
  const binary = path.join(distDir, isWindows ? `${name}.exe` : name);
  fs.copyFileSync(process.execPath, binary);
  fs.chmodSync(binary, 0o755);

  if (isWindows) {
    runSync([findSigntool(), 'remove', '/s', binary], { stdio: ['ignore', 'ignore', 'pipe'], check: true });
    log('unsign', "removed node.exe's original signature");
  }

  // On Windows, npm writes three shims into .bin for every binary; the
  // extensionless `postject` is a sh script that execFileSync cannot launch
  // without a shell (the same CVE-2024-27980 refusal resolveExecutable exists
  // to work around) — `postject.cmd` is the one Windows can run directly.
  // Routed through planExec rather than `shell: isWindows`: it reads through
  // the .cmd shim to invoke node directly when it can, falling back to a
  // properly-quoted cmd.exe wrapper otherwise, so a repoRoot or blob path
  // containing a space survives either way.
  const postject = path.join(repoRoot, 'node_modules/.bin', isWindows ? 'postject.cmd' : 'postject');
  runSync([postject, binary, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE], {
    stdio: ['ignore', 'ignore', 'pipe'], cwd: repoRoot, check: true,
  });
  log('inject', `${path.relative(repoRoot, binary)} (${(fs.statSync(binary).size / 1024 / 1024).toFixed(0)} MB)`);

  runSignCommand(binary);

  fs.rmSync(work, { recursive: true, force: true });
  // Leave dist/ holding artifacts only — the scratch parent goes too, once the
  // other binary (if it is being built in the same run) has finished with it.
  try {
    fs.rmdirSync(path.dirname(work));
  } catch {
    // Still in use by a concurrent build, or already gone. Either is fine.
  }
  return binary;
}

/** Refuses to continue on a Node build that cannot carry a SEA blob. */
export function assertInjectableNode() {
  if (process.config.variables.node_shared) {
    throw new Error(
      'This node is a shared-library build and cannot host a single executable application.\n' +
        'Install an official Node 24 tarball or nvm build and re-run.',
    );
  }
}
