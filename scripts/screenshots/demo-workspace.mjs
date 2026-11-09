/**
 * The workspace the desktop screenshots show: a small `shop` repo with a few
 * finished runs, two workflows, and one uncommitted change for the diff.
 *
 * The runs are made by the real `whiphand` CLI (fixtures/runs/*.yaml: command
 * steps replaying canned output through fixtures/emit.mjs), not written by
 * hand, so their files always match the current run format. Afterwards
 * `retimeRun` puts each one on a fixed timeline (start time and every step's
 * duration) under a fixed id, so every regeneration shows the same dates,
 * durations and ids.
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
const RUN_ID = /^\d{8}-\d{6}-[0-9a-z]+$/;

/**
 * How long each step takes on the fixture timeline, in seconds. The CLI's
 * real durations vary run to run, and the Runs grid and the run view show
 * them, so every step is stretched to one of these instead.
 */
export const STEP_SECONDS = {
  plan: 252, implement: 655, tests: 41, review: 128,
  reproduce: 196, fix: 512, draft: 340, 'check-links': 17,
};

/** The run id for a run started at `startedAt` (UTC, as the CLI makes them under TZ=UTC). */
export function runIdAt(startedAt, suffix) {
  const d = new Date(startedAt);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${suffix}`;
}

/**
 * Anchor points `[recorded ms, fixture ms]`: the run's start at `newStart`,
 * then each step's start and end laid end to end, each step lasting its
 * STEP_SECONDS.
 */
export function timeline(manifest, newStart) {
  let cursor = Date.parse(newStart);
  const anchors = [[Date.parse(manifest.startedAt), cursor]];
  for (const step of manifest.steps ?? []) {
    if (!step.startedAt || !step.endedAt) continue;
    const seconds = STEP_SECONDS[step.id];
    if (seconds === undefined) throw new Error(`STEP_SECONDS has no duration for step '${step.id}'`);
    anchors.push([Date.parse(step.startedAt), cursor]);
    cursor += seconds * 1000;
    anchors.push([Date.parse(step.endedAt), cursor]);
  }
  anchors.sort((a, b) => a[0] - b[0]);
  // A step that ends in the millisecond the next starts gives two anchors at one time: keep the first.
  return anchors.filter((anchor, i) => i === 0 || anchor[0] !== anchors[i - 1][0]);
}

/**
 * `ms` on the fixture timeline: linear between the anchors around it, so log
 * lines keep their order and place within a step; shifted by the nearest
 * anchor outside them.
 */
export function mapTime(ms, anchors) {
  if (ms <= anchors[0][0]) return anchors[0][1] + (ms - anchors[0][0]);
  for (let i = 1; i < anchors.length; i += 1) {
    const [t1, n1] = anchors[i];
    if (ms <= t1) {
      const [t0, n0] = anchors[i - 1];
      return Math.round(n0 + ((ms - t0) / (t1 - t0)) * (n1 - n0));
    }
  }
  const [tn, nn] = anchors.at(-1);
  return nn + (ms - tn);
}

/** Every ISO timestamp in `text` mapped through `map` (ms → ms), and every `oldId` replaced by `newId`. */
export function retimeText(text, map, oldId, newId) {
  return text
    .replace(ISO, ts => new Date(map(Date.parse(ts))).toISOString())
    .replaceAll(oldId, newId);
}

/** Moves the run in `runDir` onto the fixture timeline from `newStart`, as id `<newStart>-<suffix>`; returns its new directory. */
export function retimeRun(runDir, newStart, suffix) {
  const oldId = path.basename(runDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const anchors = timeline(manifest, newStart);
  const newId = runIdAt(newStart, suffix);
  for (const entry of fs.readdirSync(runDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const text = fs.readFileSync(file, 'utf8');
    const next = retimeText(text, ms => mapTime(ms, anchors), oldId, newId);
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
