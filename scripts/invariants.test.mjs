/**
 * The invariants are enforced, not merely agreed. Rules 1-5 of the Windows plan
 * are only worth having if the next person in a hurry cannot bypass them —
 * including us, six weeks from now — so each mechanically checkable one is a
 * test here, against one checked-in allowlist (scripts/platform-gates.json).
 * This file is in the root `test` glob, so both CI legs (Linux and Windows) run
 * it.
 *
 * Deliberately grep-shaped, and deliberately limited to what grep can decide:
 *
 *   1. Every skip in a test file is on the gate allowlist, and every temporary
 *      entry names the PR that removes it. Every skip in the tree is already the
 *      `test(name, { skip: <reason> }, fn)` form, with no `describe.skip` or
 *      `skipIf` anywhere, so one scan covers the whole surface.
 *   2. An assertion that can only hold on POSIX lives inside a gate with a named
 *      reason — never inside a bare `if (process.platform …)` in a test that
 *      otherwise reports green.
 *   3. No `shell: true`.
 *   4. No `child_process` value import outside the launch seam
 *      (scripts/lib/exec.mjs).
 *   5. No rename-with-retry in JS: durable writes are the agent's
 *      (crates/whiphand-core/src/durable_fs.rs).
 *   6. No `continue-on-error` in the CI workflow: a red leg must be red.
 *
 * There is no check for raw `===` path comparison: it cannot be done reliably,
 * and pretending otherwise would weaken the checks above. The path brands cover
 * the emit boundary instead (`npm run typecheck`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatesFile = path.join(root, 'scripts/platform-gates.json');

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'dist-web', 'target', '.git', '.whiphand', '.worktrees', 'gen', 'binaries', 'resources',
]);
const CODE = /\.(?:ts|tsx|mjs|js|cjs)$/;
const TEST_FILE = /\.test\.(?:ts|tsx|mjs)$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (CODE.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = file => path.relative(root, file).split(path.sep).join('/');
const files = walk(root).map(rel).sort();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

/** Comment lines are prose about the rule, not violations of it. */
function codeLines(text) {
  return text.split('\n').map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(?:\/\/|\/\*|\*)/.test(line));
}

// ---------------------------------------------------------------------------
// 1 & 2. The skip allowlist
// ---------------------------------------------------------------------------

/** The string literals in a `skip:` expression — its named reason. */
function reasonOf(expression) {
  const literals = [...expression.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)]
    .map(m => m[1] ?? m[2] ?? m[3]);
  return literals.length > 0 ? literals[literals.length - 1] : expression.trim();
}

/** Every `skip:` gate in the tree, as `{ file, reason }` (deduplicated per file). */
export function collectGates() {
  const seen = new Map();
  for (const file of files.filter(f => TEST_FILE.test(f) && f !== 'scripts/invariants.test.mjs')) {
    for (const { line } of codeLines(read(file))) {
      const match = /\bskip:\s*(.+?)\s*(?:\}|,\s*(?:async|\(|function)|$)/.exec(line);
      if (match === null) continue;
      seen.set(`${file}::${reasonOf(match[1])}`, { file, reason: reasonOf(match[1]) });
    }
  }
  return [...seen.values()];
}

const allowlist = JSON.parse(fs.readFileSync(gatesFile, 'utf8'));

test('every platform gate in a test file is on the checked-in allowlist, and none of the entries is stale', () => {
  const actual = new Set(collectGates().map(g => `${g.file}::${g.reason}`));
  const listed = new Set(allowlist.gates.map(g => `${g.file}::${g.reason}`));
  const unlisted = [...actual].filter(key => !listed.has(key));
  const stale = [...listed].filter(key => !actual.has(key));
  assert.deepEqual(unlisted, [],
    'a gate was added without an allowlist entry — add it to scripts/platform-gates.json with a reason, or fix the test instead');
  assert.deepEqual(stale, [],
    'an allowlist entry no longer matches a gate — the gate was removed or reworded; drop the entry (that is the point of the list)');
});

test('every allowlist entry has a kind, and every temporary one names the PR that removes it', () => {
  for (const gate of allowlist.gates) {
    assert.ok(['asymmetry', 'temporary', 'capability'].includes(gate.kind), `${gate.file}: unknown kind '${gate.kind}'`);
    if (gate.kind === 'temporary') {
      assert.ok(typeof gate.removal === 'string' && gate.removal.trim() !== '',
        `${gate.file} (${gate.reason}): a temporary gate must carry a removal pointer naming the phase/PR that removes it`);
    }
    if (gate.kind === 'asymmetry') {
      assert.ok(typeof gate.counterpart === 'string' && gate.counterpart.trim() !== '',
        `${gate.file} (${gate.reason}): a genuine platform asymmetry needs a named counterpart test asserting the other behaviour`);
    }
  }
});

test('no test skips by any other route: describe.skip, test.skip, it.skip, skipIf, todo', () => {
  const offenders = [];
  for (const file of files.filter(f => TEST_FILE.test(f) && f !== 'scripts/invariants.test.mjs')) {
    for (const { line, n } of codeLines(read(file))) {
      if (/\b(?:describe|test|it)\.(?:skip|todo)\b|\bskipIf\b|\bxit\(|\bxdescribe\(/.test(line)) offenders.push(`${file}:${n}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('an assertion that can only hold on POSIX is never inside a bare `if (process.platform …)` in a passing test', () => {
  const offenders = [];
  for (const file of files.filter(f => TEST_FILE.test(f) && f !== 'scripts/invariants.test.mjs')) {
    for (const { line, n } of codeLines(read(file))) {
      if (/\bif\s*\(\s*process\.platform\b/.test(line)) offenders.push(`${file}:${n}`);
    }
  }
  assert.deepEqual(offenders, [],
    "move the assertion into its own test with `{ skip: process.platform … && '<named reason>' }` so the allowlist can see it");
});

// ---------------------------------------------------------------------------
// 3. shell: true
// ---------------------------------------------------------------------------

test('nothing passes `shell: true`', () => {
  const offenders = [];
  for (const file of files.filter(f => f !== 'scripts/invariants.test.mjs')) {
    for (const { line, n } of codeLines(read(file))) {
      if (/\bshell\s*:\s*true\b/.test(line)) offenders.push(`${file}:${n}`);
    }
  }
  assert.deepEqual(offenders, [], 'go through the launch seam (scripts/lib/exec.mjs) instead');
});

// ---------------------------------------------------------------------------
// 4. child_process outside the seam
// ---------------------------------------------------------------------------

/** Product code and scripts: tests drive real children as fixtures and are not the seam's subject. */
const isProduct = file => !TEST_FILE.test(file) && !file.startsWith('parity/') && !file.startsWith('packages/test-support/');

test('`child_process` is imported only by the launch seam (type-only imports aside)', () => {
  const offenders = [];
  for (const file of files.filter(f => isProduct(f) && f !== 'scripts/invariants.test.mjs')) {
    if (allowlist.childProcess.includes(file)) continue;
    for (const { line, n } of codeLines(read(file))) {
      if (/\bimport\s+type\b/.test(line)) continue;
      if (/from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)|import\(\s*['"](?:node:)?child_process['"]\s*\)/.test(line)) {
        offenders.push(`${file}:${n}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'every process started from Node goes through scripts/lib/exec.mjs (spawnRunner, runSync, runInherited)');
});

test('the child_process allowlist is exactly the seam, with no stale entries', () => {
  assert.deepEqual(allowlist.childProcess, ['scripts/lib/exec.mjs']);
  for (const file of allowlist.childProcess) assert.ok(fs.existsSync(path.join(root, file)), `${file} does not exist`);
});

// ---------------------------------------------------------------------------
// 5. One durable-write helper
// ---------------------------------------------------------------------------

test('there is one rename-with-retry, and it is not in JS: nothing names the transient error codes', () => {
  const offenders = [];
  for (const file of files.filter(f => isProduct(f) && f !== 'scripts/invariants.test.mjs')) {
    for (const { line, n } of codeLines(read(file))) {
      if (/['"]EBUSY['"]|TRANSIENT_RENAME_CODES\s*=/.test(line)) offenders.push(`${file}:${n}`);
    }
  }
  assert.deepEqual(offenders, [], 'durable writes belong to the agent: crates/whiphand-core/src/durable_fs.rs');
});

// ---------------------------------------------------------------------------
// 6. A red leg is red
// ---------------------------------------------------------------------------

test('the CI workflow has no `continue-on-error`', () => {
  const workflowDir = path.join(root, '.github/workflows');
  const offenders = [];
  for (const name of fs.existsSync(workflowDir) ? fs.readdirSync(workflowDir) : []) {
    const text = fs.readFileSync(path.join(workflowDir, name), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/^\s*continue-on-error\s*:/.test(line)) offenders.push(`.github/workflows/${name}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'a test job that can fail without failing the build is a scoreboard that lies');
});

// ---------------------------------------------------------------------------
// Bootstrap: `node scripts/invariants.test.mjs --print-gates`
// ---------------------------------------------------------------------------

if (process.argv.includes('--print-gates')) {
  console.log(JSON.stringify(collectGates(), null, 2));
}
