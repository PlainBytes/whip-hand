#!/usr/bin/env node
/**
 * Performance baselines for the Rust migration (docs/migration.md, Phase 0;
 * method and results in docs/benchmarks.md). Every later phase re-runs this
 * and has to beat the numbers saved under the `phase0` label.
 *
 *   node scripts/bench.mjs                      # everything, print a summary
 *   node scripts/bench.mjs --only cli,rpc       # a subset: cli agent rpc sizes ui
 *   node scripts/bench.mjs --save phase0        # record into scripts/bench/results/<platform>-<arch>.json
 *   node scripts/bench.mjs --compare phase0     # print a markdown delta table against a saved label
 *   node scripts/bench.mjs --fixtures-only DIR  # just write the bench workspace (for the manual Tauri check)
 *
 * The packaged-binary rows need `npm run package` first; without it they are
 * recorded as null with a note, not silently skipped. Local only by design:
 * shared CI runners are too noisy to gate on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { runSync } from '../packages/core/src/exec.ts';
import { repoRoot, distDir } from './package/sea.mjs';
import { discard } from './package/smoke.mjs';
import { summarize, compare, formatCompare } from './bench/stats.mjs';
import { rssBytes } from './bench/rss.mjs';
import { AgentSession, isolatedEnv, tempDir } from './bench/agent-session.mjs';
import { createWorkspace, LARGE_RUN_ID } from './bench/fixtures.mjs';

const exeSuffix = process.platform === 'win32' ? '.exe' : '';
const CLI_DEV = [process.execPath, path.join(repoRoot, 'packages/cli/src/main.ts')];
const CLI_PACKAGED = path.join(distDir, `whiphand${exeSuffix}`);
const AGENT_DEV = [process.execPath, path.join(repoRoot, 'packages/agent/src/main.ts')];
const AGENT_PACKAGED = path.join(distDir, `whiphand-agent${exeSuffix}`);
const SECTIONS = ['cli', 'agent', 'rpc', 'sizes', 'ui'];
export const RESULTS_FILE = path.join(repoRoot, 'scripts/bench/results', `${process.platform}-${process.arch}.json`);

const notes = [];
const note = message => {
  notes.push(message);
  process.stderr.write(`  note: ${message}\n`);
};
const log = message => process.stderr.write(`${message}\n`);

function timeSync(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function timeCommand(argv, { runs, cwd, warmup = 2 }) {
  const samples = [];
  for (let i = 0; i < warmup + runs; i += 1) {
    const ms = timeSync(() => runSync(argv, { cwd, stdio: ['ignore', 'ignore', 'pipe'], check: true }));
    if (i >= warmup) samples.push(ms);
  }
  return summarize(samples);
}

/** The packaged agent bakes in a node-pty location; point it at the repo's, as smoke.mjs does. */
function agentEnv(stateDir, extra = {}) {
  return isolatedEnv(stateDir, { WHIPHAND_NODE_PTY_DIR: path.join(repoRoot, 'node_modules/node-pty'), ...extra });
}

// ---------------------------------------------------------------------------

function benchCli({ runs }) {
  log('cli: cold start');
  const workdir = tempDir('cli');
  const workflow = path.join(workdir, 'smoke.yaml');
  fs.copyFileSync(path.join(repoRoot, 'scripts/package/fixtures/smoke.yaml'), workflow);
  const commands = {
    help: ['--help'],
    version: ['--version'],
    dryRun: ['run', workflow, '--dry-run', '--input', 'subject=bench'],
  };
  const result = { dev: {}, packaged: {} };
  try {
    for (const [name, args] of Object.entries(commands)) {
      result.dev[name] = timeCommand([...CLI_DEV, ...args], { runs, cwd: workdir });
    }
    if (fs.existsSync(CLI_PACKAGED)) {
      for (const [name, args] of Object.entries(commands)) {
        result.packaged[name] = timeCommand([CLI_PACKAGED, ...args], { runs, cwd: workdir });
      }
    } else {
      result.packaged = null;
      note(`${path.relative(repoRoot, CLI_PACKAGED)} missing — run \`npm run package:cli\` for the packaged rows`);
    }
  } finally {
    discard(workdir);
  }
  return result;
}

async function startAgent(argv, stateDir, extraEnv) {
  const start = process.hrtime.bigint();
  const session = new AgentSession(argv, agentEnv(stateDir, extraEnv));
  await session.request('hello', { protocolVersion: 1 });
  return { session, startupMs: Number(process.hrtime.bigint() - start) / 1e6 };
}

/** Pages backwards through the whole run.log, as "Load earlier" does, 2000 lines at a time. */
async function pageThroughLog(session, workdir, runId) {
  let page = await session.request('readRunLog', { workdir, runId, fromEnd: true, limit: 2000 });
  let lines = page.lines.length;
  while (!page.atStart) {
    page = await session.request('readRunLog', { workdir, runId, beforeByte: page.startByte, limit: 2000 });
    lines += page.lines.length;
  }
  return lines;
}

async function benchAgent({ runs, workspace }) {
  log('agent: startup and RSS');
  const variants = { dev: AGENT_DEV };
  if (fs.existsSync(AGENT_PACKAGED)) variants.packaged = [AGENT_PACKAGED];
  else note(`${path.relative(repoRoot, AGENT_PACKAGED)} missing — run \`npm run package:agent\` for the packaged rows`);

  const result = { dev: null, packaged: null };
  for (const [name, argv] of Object.entries(variants)) {
    const startups = [];
    for (let i = 0; i < Math.max(5, Math.floor(runs / 2)); i += 1) {
      const stateDir = tempDir('agent');
      const { session, startupMs } = await startAgent(argv, stateDir);
      startups.push(startupMs);
      await session.stop();
      discard(stateDir);
    }
    const stateDir = tempDir('agent');
    const { session } = await startAgent(argv, stateDir);
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      const idle = rssBytes(session.pid);
      await session.request('getRun', { workdir: workspace, runId: LARGE_RUN_ID });
      await pageThroughLog(session, workspace, LARGE_RUN_ID);
      const afterLargeRun = rssBytes(session.pid);
      await session.request('listRuns', { workdir: workspace });
      const afterListRuns = rssBytes(session.pid);
      result[name] = { startupMs: summarize(startups), rssBytes: { idle, afterLargeRun, afterListRuns } };
    } finally {
      await session.stop();
      discard(stateDir);
    }
  }
  return result;
}

async function timeRequests(session, count, method, params) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const start = process.hrtime.bigint();
    await session.request(method, params);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return summarize(samples);
}

async function benchRpc({ runs, workspace }) {
  log('rpc: stdio round trips (dev agent)');
  const stateDir = tempDir('rpc');
  const { session } = await startAgent(AGENT_DEV, stateDir);
  try {
    await timeRequests(session, 50, 'hello', { protocolVersion: 1 }); // warm the JIT
    const replay = [];
    for (let i = 0; i < Math.max(3, Math.floor(runs / 4)); i += 1) {
      const start = process.hrtime.bigint();
      await pageThroughLog(session, workspace, LARGE_RUN_ID);
      replay.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    return {
      hello: await timeRequests(session, 1000, 'hello', { protocolVersion: 1 }),
      listRuns500: await timeRequests(session, runs, 'listRuns', { workdir: workspace }),
      getRunLarge: await timeRequests(session, runs, 'getRun', { workdir: workspace, runId: LARGE_RUN_ID }),
      readRunLogTail: await timeRequests(session, runs, 'readRunLog', { workdir: workspace, runId: LARGE_RUN_ID, fromEnd: true, limit: 2000 }),
      replayFullLog: summarize(replay),
    };
  } finally {
    await session.stop();
    discard(stateDir);
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name));
}

function benchSizes() {
  log('sizes');
  const installers = {};
  for (const name of fs.existsSync(distDir) ? fs.readdirSync(distDir) : []) {
    const match = /^Whiphand_[^_]+_.*?\.(deb|AppImage|exe|msi|dmg)$/.exec(name);
    if (match) installers[match[1]] = fileSize(path.join(distDir, name));
  }
  if (Object.keys(installers).length === 0) note('no installers in dist/ — run `npm run package` for installer sizes');
  const web = path.join(repoRoot, 'apps/desktop/dist-web');
  const webFiles = walkFiles(web);
  if (webFiles.length === 0) note('apps/desktop/dist-web missing — run `npm run build:web -w desktop` for web bundle sizes');
  const js = webFiles.filter(file => file.endsWith('.js'));
  return {
    cliBytes: fileSize(CLI_PACKAGED),
    agentBytes: fileSize(AGENT_PACKAGED),
    installerBytes: installers,
    webBundle: webFiles.length === 0 ? null : {
      totalBytes: webFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0),
      jsBytes: js.reduce((sum, file) => sum + fs.statSync(file).size, 0),
      jsGzipBytes: js.reduce((sum, file) => sum + gzipSync(fs.readFileSync(file)).length, 0),
    },
  };
}

// ---------------------------------------------------------------------------

function readResults() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function meta() {
  const commit = runSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).stdout.trim();
  const dirty = runSync(['git', 'status', '--porcelain'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).stdout.trim() !== '';
  return {
    date: new Date().toISOString(),
    commit: dirty ? `${commit}+dirty` : commit,
    node: process.version,
    os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cpus: os.cpus().length,
    memBytes: os.totalmem(),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      runs: { type: 'string', default: '20' },
      save: { type: 'string' },
      compare: { type: 'string' },
      json: { type: 'boolean', default: false },
      'fixtures-only': { type: 'string' },
      headed: { type: 'boolean', default: false },
    },
  });

  if (values['fixtures-only']) {
    const dir = path.resolve(values['fixtures-only']);
    const { workspace } = createWorkspace(dir);
    log(`bench workspace written to ${workspace}`);
    return;
  }

  const sections = values.only ? values.only.split(',').map(s => s.trim()) : SECTIONS;
  for (const section of sections) {
    if (!SECTIONS.includes(section)) throw new Error(`unknown section '${section}' (one of ${SECTIONS.join(', ')})`);
  }
  const runs = Number(values.runs);
  const workspaceRoot = tempDir('ws');
  const workspace = path.join(workspaceRoot, 'workspace');
  log(`fixtures: ${workspace}`);
  createWorkspace(workspace);

  const metrics = {};
  try {
    if (sections.includes('cli')) metrics.cli = benchCli({ runs });
    if (sections.includes('agent')) metrics.agent = await benchAgent({ runs, workspace });
    if (sections.includes('rpc')) metrics.rpc = await benchRpc({ runs, workspace });
    if (sections.includes('sizes')) metrics.sizes = benchSizes();
    if (sections.includes('ui')) {
      const { benchUi } = await import('./bench/ui.mjs');
      metrics.ui = await benchUi({ workspace, headed: values.headed, note, log, agentEnv });
    }
  } finally {
    discard(workspaceRoot);
  }

  const record = { meta: meta(), notes, metrics };
  if (values.json) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);

  if (values.save) {
    const all = readResults();
    // A partial run (--only) updates its own sections and keeps the rest.
    const previous = all[values.save]?.metrics ?? {};
    all[values.save] = { meta: record.meta, notes, metrics: { ...previous, ...metrics } };
    fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
    fs.writeFileSync(RESULTS_FILE, `${JSON.stringify(all, null, 2)}\n`);
    log(`saved as '${values.save}' in ${path.relative(repoRoot, RESULTS_FILE)}`);
  }

  if (values.compare) {
    const base = readResults()[values.compare];
    if (!base) throw new Error(`no saved results labelled '${values.compare}' in ${path.relative(repoRoot, RESULTS_FILE)}`);
    const subset = Object.fromEntries(Object.keys(metrics).map(key => [key, base.metrics[key]]));
    process.stdout.write(`${formatCompare(compare(subset, metrics), [values.compare, 'current'])}\n`);
  } else if (!values.json) {
    process.stdout.write(`${formatCompare(compare({}, metrics), ['—', 'current'])}\n`);
  }
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
