/**
 * Synthesizes the bench workspace: deterministic (seeded), so every phase
 * measures the same bytes.
 *
 *   - LARGE_RUN_ID: a finished run with a 50k-line run.log and an artifacts
 *     tree of 20 folders × 300 files (run artifacts auto-expand every folder
 *     in the run view, so this is the file tree's worst ordinary case).
 *   - SMALL_RUN_COUNT small finished runs, for listRuns and the Runs grid.
 *   - A git repo with one large uncommitted change, for the diff scenario.
 *   - flood.yaml / review.yaml under .whiphand/workflows, for the live and
 *     review scenarios.
 *
 * `buildLargeRunLog` and `smallRunManifest` are pure so bench.test.mjs can
 * check their shape without writing a workspace.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSync } from '../lib/exec.mjs';
import { formatLogLine } from '../../apps/desktop/src/shared/log-rows.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, 'fixtures');

export const LARGE_RUN_ID = '20260101-120000-bnch';
export const LARGE_RUN_NAME = 'bench-large';
export const LARGE_RUN_LOG_LINES = 50_000;
export const SMALL_RUN_COUNT = 500;
export const ARTIFACT_DIRS = 20;
export const ARTIFACT_FILES_PER_DIR = 300;
export const DIFF_FILE = 'src/big.txt';
export const DIFF_FILE_LINES = 6_000;

/** mulberry32: tiny, seedable, good enough to vary line lengths. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEPS = ['build', 'test', 'lint'];
const WORDS = 'the quick brown fox jumps over a lazy dog while compiling modules and running suites'.split(' ');

/** run.log lines, formatted by core's own formatter. */
export function buildLargeRunLog(lines = LARGE_RUN_LOG_LINES, seed = 1) {
  const random = rng(seed);
  const start = Date.parse('2026-01-01T12:00:00.000Z');
  const out = [];
  let seq = 0;
  // Each step brackets its body with a start and an end line; the last step
  // takes the remainder, so the file has exactly `lines` lines.
  const body = lines - 2 * STEPS.length;
  const perStep = Math.floor(body / STEPS.length);
  for (const [index, stepId] of STEPS.entries()) {
    const count = index === STEPS.length - 1 ? body - perStep * index : perStep;
    const ts = () => new Date(start + seq * 7).toISOString();
    seq += 1;
    out.push(formatLogLine({ seq, ts: ts(), kind: 'step:start', stepId, text: `step ${stepId} started` }));
    for (let i = 0; i < count; i += 1) {
      seq += 1;
      const roll = random();
      // Mostly short lines, some long enough to wrap, the odd stderr line.
      const wordCount = roll < 0.9 ? 3 + Math.floor(random() * 12) : 60 + Math.floor(random() * 120);
      const text = Array.from({ length: wordCount }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ');
      const stream = random() < 0.08 ? 'stderr' : 'stdout';
      out.push(formatLogLine({ seq, ts: ts(), kind: `step:log:${stream}`, stepId, text: `${i} ${text}` }));
    }
    seq += 1;
    out.push(formatLogLine({ seq, ts: ts(), kind: 'step:end', stepId, text: `step ${stepId} succeeded` }));
  }
  return out;
}

function runIdFor(index) {
  const minutes = index;
  const hh = String(Math.floor(minutes / 60) % 24).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  const day = String(1 + Math.floor(minutes / (60 * 24))).padStart(2, '0');
  return `202512${day}-${hh}${mm}00-${index.toString(36).padStart(4, '0')}`;
}

export function smallRunManifest(index, workdir) {
  const runId = runIdFor(index);
  const startedAt = `${runId.slice(0, 4)}-${runId.slice(4, 6)}-${runId.slice(6, 8)}T${runId.slice(9, 11)}:${runId.slice(11, 13)}:00.000Z`;
  const failed = index % 7 === 0;
  return {
    version: 2, runId, workflow: 'smoke', workdir, dryRun: index % 11 === 0,
    pid: 999_999, startedAt, updatedAt: startedAt, endedAt: startedAt,
    status: failed ? 'failed' : 'succeeded', ok: !failed,
    inputs: {}, sessionIds: {},
    steps: STEPS.map(id => ({ id, kind: 'command', status: failed && id === 'lint' ? 'failed' : 'succeeded', exitCode: failed && id === 'lint' ? 1 : 0 })),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function git(args, cwd) {
  runSync(['git', '-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd, stdio: ['ignore', 'ignore', 'inherit'], check: true,
  });
}

function bigFile(lines, variant) {
  const out = [];
  for (let i = 0; i < lines; i += 1) {
    out.push(variant && i % 2 === 1 ? `line ${i} changed in the working tree` : `line ${i} as committed`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Writes the whole workspace under `dir` (created; must not exist or be
 * empty). Returns the paths the bench needs.
 */
export function createWorkspace(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const runsDir = path.join(dir, '.whiphand', 'runs');

  // A git repo first, so the runs and workflows are ignored rather than diffed.
  fs.writeFileSync(path.join(dir, '.gitignore'), '.whiphand/\nflood.mjs\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, DIFF_FILE), bigFile(DIFF_FILE_LINES, false));
  git(['init', '-q', '-b', 'main'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'bench fixture'], dir);
  fs.writeFileSync(path.join(dir, DIFF_FILE), bigFile(DIFF_FILE_LINES, true));

  const workflowsDir = path.join(dir, '.whiphand', 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });
  for (const name of ['flood.yaml', 'review.yaml']) {
    fs.copyFileSync(path.join(FIXTURES_DIR, name), path.join(workflowsDir, name));
  }
  fs.copyFileSync(path.join(FIXTURES_DIR, 'flood.mjs'), path.join(dir, 'flood.mjs'));

  for (let i = 0; i < SMALL_RUN_COUNT; i += 1) {
    const manifest = smallRunManifest(i, dir);
    writeJson(path.join(runsDir, manifest.runId, 'run.json'), manifest);
  }

  const largeDir = path.join(runsDir, LARGE_RUN_ID);
  writeJson(path.join(largeDir, 'run.json'), {
    version: 2, runId: LARGE_RUN_ID, workflow: 'smoke', workdir: dir, dryRun: false,
    pid: 999_999, startedAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-01T12:06:00.000Z',
    endedAt: '2026-01-01T12:06:00.000Z', status: 'succeeded', ok: true,
    inputs: {}, sessionIds: {},
    steps: STEPS.map(id => ({ id, kind: 'command', status: 'succeeded', exitCode: 0 })),
  });
  fs.writeFileSync(path.join(largeDir, '.name'), LARGE_RUN_NAME);
  fs.writeFileSync(path.join(largeDir, 'workflow.yaml'), [
    'name: smoke',
    'steps:',
    ...STEPS.flatMap(id => [`  - id: ${id}`, '    kind: command', '    run: "true"']),
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(largeDir, 'run.log'), buildLargeRunLog().join(''));
  for (let d = 0; d < ARTIFACT_DIRS; d += 1) {
    const folder = path.join(largeDir, `out-${String(d).padStart(2, '0')}`);
    fs.mkdirSync(folder, { recursive: true });
    for (let f = 0; f < ARTIFACT_FILES_PER_DIR; f += 1) {
      fs.writeFileSync(path.join(folder, `file-${String(f).padStart(3, '0')}.txt`), `artifact ${d}/${f}\n`);
    }
  }

  return { workspace: dir, largeRunId: LARGE_RUN_ID, largeRunDir: largeDir };
}

/** The app-state the agent reads at startup: this workspace as the most recent one, on the Runs page. */
export function seedAppState(file, workspace) {
  writeJson(file, {
    schemaVersion: 1,
    recentWorkspaces: [{ path: workspace, lastOpenedAt: '2026-01-01T00:00:00.000Z' }],
    window: null,
    lastPage: 'runs',
    theme: 'light',
    workspaces: {},
    runsRetention: { maxPerWorkspace: 0 },
    showOngoingRuns: true,
  });
}

/** PATH with the bench's stub `claude` and this node first. */
export function benchPath() {
  return [path.join(FIXTURES_DIR, 'bin'), path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter);
}
