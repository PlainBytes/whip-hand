/**
 * The workspace the desktop screenshots show: a small `shop` repo with a few
 * finished runs, two workflows, and one uncommitted change for the diff.
 *
 * The runs are made by the real `whiphand` CLI (fixtures/runs/*.yaml: command
 * steps replaying canned output through fixtures/emit.mjs), not written by
 * hand, so their files always match the current run format. Afterwards
 * `retimeRun` moves each one to a fixed point in time and a fixed id, so
 * every regeneration shows the same dates and ids.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSync } from '../lib/exec.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** What the page's clock is frozen at; the runs below are placed relative to it. */
export const DEMO_NOW = '2026-03-12T15:00:00.000Z';

const HOUR = 3_600_000;

/** Oldest first: the order they are run in, and so the order of the run dirs. */
export const DEMO_RUNS = [
  { workflow: 'docs', story: 'api-reference', name: 'api reference', ago: 50 * HOUR },
  { workflow: 'bugfix', story: 'flaky-login', name: 'flaky login test', ago: 27 * HOUR },
  { workflow: 'feature', story: 'coupon-codes', name: 'coupon codes', ago: 23 * HOUR },
  { workflow: 'bugfix', story: 'cart-rounding', name: 'cart rounding', ago: 5 * HOUR },
  { workflow: 'feature', story: 'checkout-flow', name: 'one-page checkout', ago: 2 * HOUR },
];

/** The run the run-detail scene opens. */
export const DETAIL_RUN_NAME = 'one-page checkout';

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const RUN_ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([0-9a-z]+)$/;

/** A run id's clock part read as if it were UTC (ids use the machine's local time). */
function idClock(runId) {
  const m = RUN_ID.exec(runId);
  if (!m) throw new Error(`not a run id: '${runId}'`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function formatIdClock(ms, suffix) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${suffix}`;
}

/**
 * The id a run started at `startedAt` gets once moved to `newStart`: the same
 * local-time offset, the clock part moved, and `suffix` in place of the random one.
 */
export function retimedId(runId, startedAt, newStart, suffix = RUN_ID.exec(runId)[7]) {
  const offset = idClock(runId) - Math.floor(Date.parse(startedAt) / 1000) * 1000;
  return formatIdClock(Date.parse(newStart) + offset, suffix);
}

/** Every ISO timestamp in `text` moved by `deltaMs`, and every `oldId` replaced by `newId`. */
export function retimeText(text, deltaMs, oldId, newId) {
  return text
    .replace(ISO, ts => new Date(Date.parse(ts) + deltaMs).toISOString())
    .replaceAll(oldId, newId);
}

/** Moves the run in `runDir` to start at `newStart` (and onto `suffix`, if given); returns its new directory. */
export function retimeRun(runDir, newStart, suffix) {
  const oldId = path.basename(runDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const delta = Date.parse(newStart) - Date.parse(manifest.startedAt);
  const newId = retimedId(oldId, manifest.startedAt, newStart, suffix);
  for (const entry of fs.readdirSync(runDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const text = fs.readFileSync(file, 'utf8');
    const next = retimeText(text, delta, oldId, newId);
    if (next !== text) fs.writeFileSync(file, next);
  }
  const target = path.join(path.dirname(runDir), newId);
  fs.renameSync(runDir, target);
  return target;
}

function git(args, cwd) {
  runSync(['git', '-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd, stdio: ['ignore', 'ignore', 'inherit'], check: true,
  });
}

function runDirs(runsDir) {
  return fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(name => RUN_ID.test(name)).sort() : [];
}

/**
 * Writes the demo workspace at `dir` (must not exist), making its runs with
 * the CLI at `cli` under `env` (keep it isolated: see isolatedEnv).
 */
export function createDemoWorkspace(dir, { cli, env }) {
  fs.cpSync(path.join(FIXTURES, 'shop'), dir, { recursive: true, filter: src => !src.endsWith('.changed.ts') });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.whiphand/\n.demo/\n');
  git(['init', '-q', '-b', 'main'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'Shop: cart and checkout'], dir);

  fs.cpSync(path.join(FIXTURES, 'workflows'), path.join(dir, '.whiphand', 'workflows'), { recursive: true });
  const demoDir = path.join(dir, '.demo');
  fs.cpSync(path.join(FIXTURES, 'runs'), demoDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'emit.mjs'), path.join(demoDir, 'emit.mjs'));

  const runsDir = path.join(dir, '.whiphand', 'runs');
  for (const run of DEMO_RUNS) {
    const before = new Set(runDirs(runsDir));
    // Not `check`: the cart-rounding story is meant to fail.
    runSync([cli, 'run', path.join(demoDir, `${run.workflow}.yaml`), '-C', dir, '--name', run.name,
      '--input', `story=${run.story}`, '--yes'], { cwd: dir, env, stdio: ['ignore', 'ignore', 'inherit'] });
    const made = runDirs(runsDir).filter(name => !before.has(name));
    if (made.length !== 1) throw new Error(`expected '${run.name}' to make one run, found ${made.length}`);
    // The id's suffix is random; one derived from the name keeps ids, and the shots, stable.
    const suffix = createHash('sha256').update(run.name).digest('hex').slice(0, 4);
    retimeRun(path.join(runsDir, made[0]), new Date(Date.parse(DEMO_NOW) - run.ago).toISOString(), suffix);
  }

  // Left uncommitted: the review scene's diff.
  fs.copyFileSync(path.join(FIXTURES, 'shop/src/cart.changed.ts'), path.join(dir, 'src/cart.ts'));
  return dir;
}
