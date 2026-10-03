/**
 * UI scenarios for scripts/bench.mjs: Playwright + Chromium against the web
 * build (dist-web), served by a real agent's remote-access server over the
 * synthesized workspace. Chromium stands in for WebKitGTK/WebView2 here — see
 * docs/benchmarks.md for why that is acceptable and for the manual Tauri
 * cross-check.
 *
 * Numbers come from the page's own probe (apps/desktop/src/lib/perf-probe.ts,
 * enabled through localStorage before the app boots): rAF frame times, Long
 * Tasks, per-method RPC latency, and the terminal's flush marks.
 *
 * The same agent process serves the page AND takes this script's stdio
 * requests, so the bench can start runs the page then watches.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runSync } from '../../packages/core/src/exec.ts';
import { repoRoot } from '../package/sea.mjs';
import { discard } from '../package/smoke.mjs';
import { AgentSession, tempDir } from './agent-session.mjs';
import { benchPath, seedAppState, LARGE_RUN_NAME } from './fixtures.mjs';
import { median, summarize } from './stats.mjs';

const WEB_ROOT = path.join(repoRoot, 'apps/desktop/dist-web');
const REPEATS = Number(process.env.WHIPHAND_BENCH_UI_REPEATS ?? 3);
const SCROLL_MS = 5_000;
const LIVE_WINDOW_MS = 4_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${url} did not answer within ${timeoutMs}ms`);
}

/**
 * Scrolls the element matching `selector` (or the nearest scrollable ancestor
 * of it) from one end to the other over `ms`, one step per frame, and returns
 * the probe's frame stats for that window. In-page rather than mouse.wheel:
 * a wheel per Playwright round trip measures the protocol, not the page.
 */
async function scrollAndMeasure(page, selector, { ms = SCROLL_MS, direction = 'down' } = {}) {
  return page.evaluate(async ({ selector, ms, direction }) => {
    let el = document.querySelector(selector);
    while (el && !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) {
      el = el.parentElement;
    }
    if (!el) throw new Error(`no scrollable container for ${selector}`);
    const probe = window.__whiphandPerf;
    el.scrollTop = direction === 'down' ? 0 : el.scrollHeight;
    await new Promise(requestAnimationFrame);
    probe.startFrames();
    const start = performance.now();
    await new Promise(resolve => {
      const step = now => {
        const t = Math.min(1, (now - start) / ms);
        // Recomputed every frame: a virtualized list's scrollHeight settles as rows are measured.
        const max = el.scrollHeight - el.clientHeight;
        el.scrollTop = direction === 'down' ? t * max : (1 - t) * max;
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    return probe.stopFrames();
  }, { selector, ms, direction });
}

async function measureFor(page, ms) {
  await page.evaluate(() => window.__whiphandPerf.startFrames());
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__whiphandPerf.stopFrames());
}

function pageStats(page) {
  return page.evaluate(() => ({
    domNodes: document.getElementsByTagName('*').length,
    jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
  }));
}

/** Resolves once `count()` has stopped changing for `quietMs`. */
async function settle(page, count, { quietMs = 400, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const now = await count();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return now;
    }
    await page.waitForTimeout(50);
  }
  return last;
}

/** Only the numbers a phase is compared on: no frame counts or durations, which are not "lower is better". */
function frameMetrics(stats) {
  const round = value => Math.round(value * 10) / 10;
  return { p50: round(stats.p50), p95: round(stats.p95), max: round(stats.max), over33: stats.over33, longTaskMs: Math.round(stats.longTaskMs) };
}

/** Median of each numeric leaf across repeated scenario results. */
function foldRepeats(results) {
  const first = results[0];
  if (first === null || typeof first !== 'object') return median(results);
  return Object.fromEntries(Object.keys(first).map(key => [key, foldRepeats(results.map(r => r?.[key] ?? null))]));
}

/** Every page's own request→response latencies, merged across scenarios. */
const rpcSamples = {};

let shot = 0;

async function closePage(page) {
  // Debugging aid: what the page showed when its scenario ended (or failed).
  if (process.env.WHIPHAND_BENCH_SHOTS) {
    shot += 1;
    await page.screenshot({ path: path.join(process.env.WHIPHAND_BENCH_SHOTS, `page-${shot}.png`) }).catch(() => {});
  }
  try {
    const rpc = await page.evaluate(() => window.__whiphandPerf?.rpc() ?? {});
    for (const [method, samples] of Object.entries(rpc)) (rpcSamples[method] ??= []).push(...samples);
  } catch {
    // a page that crashed has nothing to report
  }
  await page.close();
}

// ---------------------------------------------------------------------------

async function openApp(context, url) {
  const page = await context.newPage();
  await page.goto(url);
  // Restored straight onto the Runs page of the seeded workspace.
  await page.getByText(LARGE_RUN_NAME, { exact: true }).first().waitFor({ timeout: 30_000 });
  return page;
}

async function openRun(page, text) {
  const t0 = await page.evaluate(() => performance.now());
  await page.getByText(text, { exact: true }).first().click();
  // Attached, not visible: a parked review covers the tabs.
  await page.getByTestId('run-panel-terminal').waitFor({ state: 'attached' });
  return t0;
}

async function scenarioLogs(context, url) {
  const page = await openApp(context, url);
  try {
    await openRun(page, LARGE_RUN_NAME);
    const t0 = await page.evaluate(() => performance.now());
    await page.getByRole('tab', { name: 'Logs' }).click();
    await page.locator('[data-testid=log-row]').first().waitFor();
    const firstRowMs = (await page.evaluate(() => performance.now())) - t0;

    const loadEarlier = [];
    for (let i = 0; i < 5; i += 1) {
      // The button sits above the first row: scroll up to it, as a reader would.
      await page.getByTestId('log-tail').evaluate(el => { el.scrollTop = 0; });
      const button = page.getByTestId('log-load-earlier');
      try {
        await button.waitFor({ timeout: 5_000 });
      } catch {
        break; // at the start of the log
      }
      const before = await page.evaluate(() => performance.now());
      await button.click();
      // Done when the button is gone (start of log) or reads "Load earlier" again.
      await page.waitForFunction(
        () => !document.querySelector('[data-testid=log-load-earlier]')?.textContent?.includes('Loading'),
        null, { timeout: 30_000 },
      );
      await page.evaluate(() => new Promise(requestAnimationFrame));
      loadEarlier.push((await page.evaluate(() => performance.now())) - before);
    }
    const scroll = await scrollAndMeasure(page, '[data-testid=log-tail]', { direction: 'up' });
    // A sanity check, not a cost: both builds must have loaded the same pages.
    const loadedRows = Number((await page.getByTestId('log-filter-count').textContent())?.match(/of ([\d,]+)/)?.[1].replace(/,/g, ''));
    return {
      loadedRows,
      firstRowMs: Math.round(firstRowMs),
      loadEarlierMs: Math.round(median(loadEarlier) ?? 0),
      scroll: frameMetrics(scroll),
      ...(await pageStats(page)),
    };
  } finally {
    await closePage(page);
  }
}

async function scenarioFileTree(context, url) {
  const page = await openApp(context, url);
  try {
    await openRun(page, LARGE_RUN_NAME);
    const t0 = await page.evaluate(() => performance.now());
    await page.getByRole('tab', { name: /Artifacts/ }).click();
    await page.getByRole('treeitem').first().waitFor();
    await settle(page, () => page.getByRole('treeitem').count());
    const settleMs = (await page.evaluate(() => performance.now())) - t0;
    const scroll = await scrollAndMeasure(page, '[role=tree]');
    return { settleMs: Math.round(settleMs), scroll: frameMetrics(scroll), ...(await pageStats(page)) };
  } finally {
    await closePage(page);
  }
}

async function startRunAndGetId(session, workspace, workflow) {
  const started = session.waitFor(m => m.method === 'whiphandEvent' && m.params?.event?.type === 'run:start', 30_000);
  const { jobId } = await session.request('startRun', { workdir: workspace, workflow });
  const event = await started;
  return { jobId, runId: event.params.event.runId ?? event.params.runId };
}

async function scenarioLive(context, url, session, workspace) {
  const page = await openApp(context, url);
  let jobId;
  try {
    const ptyStarted = session.waitFor(m => m.method === 'ptyStarted', 120_000);
    const run = await startRunAndGetId(session, workspace, path.join(workspace, '.whiphand/workflows/flood.yaml'));
    jobId = run.jobId;
    // Phase 1: the command step's flood, seen from the Runs page and then from the run itself.
    const runsPage = await measureFor(page, LIVE_WINDOW_MS);
    await openRun(page, run.runId);
    await page.getByRole('tab', { name: 'Logs' }).click();
    const logsTab = await measureFor(page, LIVE_WINDOW_MS);

    // Phase 2: the interactive step writes ~2 MB into the pty, then idles.
    await ptyStarted;
    await page.getByRole('tab', { name: /Terminal/ }).click();
    const terminal = await measureFor(page, LIVE_WINDOW_MS);
    await page.waitForTimeout(2_000);

    // Phase 3: reload and attach again — the getJobScrollback replay.
    await page.reload();
    await page.getByText(LARGE_RUN_NAME, { exact: true }).first().waitFor({ timeout: 30_000 });
    await page.evaluate(() => window.__whiphandPerf.startFrames());
    const t0 = await openRun(page, run.runId);
    await page.getByRole('tab', { name: /Terminal/ }).click();
    await page.waitForFunction(() => (window.__whiphandPerf.marks()['terminal:flushed'] ?? []).length > 0, null, { timeout: 30_000 });
    await settle(page, () => page.evaluate(() => (window.__whiphandPerf.marks()['terminal:flushed'] ?? []).length), { quietMs: 1_000 });
    const replay = await page.evaluate(() => window.__whiphandPerf.stopFrames());
    const lastFlush = await page.evaluate(() => window.__whiphandPerf.marks()['terminal:flushed'].at(-1));
    return {
      runsPageDuringFlood: frameMetrics(runsPage),
      logsTabDuringFlood: frameMetrics(logsTab),
      terminalDuringPty: frameMetrics(terminal),
      reattachReplayMs: Math.round(lastFlush - t0),
      reattachLongTaskMs: Math.round(replay.longTaskMs),
    };
  } finally {
    if (jobId) await session.request('cancelRun', { jobId }).catch(() => {});
    await closePage(page);
  }
}

async function scenarioDiff(context, url, session, workspace) {
  const page = await openApp(context, url);
  let jobId;
  try {
    const parked = session.waitFor(m => m.method === 'manualRequest', 30_000);
    const run = await startRunAndGetId(session, workspace, path.join(workspace, '.whiphand/workflows/review.yaml'));
    jobId = run.jobId;
    await parked;
    const t0 = await openRun(page, run.runId);
    await page.getByTestId('review-overlay').waitFor({ timeout: 30_000 });
    // The only changed file is selected on open.
    await page.locator('[data-testid=diff-grid] [data-row]').first().waitFor({ timeout: 30_000 });
    await settle(page, () => page.locator('[data-testid=diff-grid] [data-row]').count());
    const renderMs = (await page.evaluate(() => performance.now())) - t0;
    const scroll = await scrollAndMeasure(page, '[data-testid=diff-grid]');
    return { renderMs: Math.round(renderMs), scroll: frameMetrics(scroll), ...(await pageStats(page)) };
  } finally {
    if (jobId) await session.request('cancelRun', { jobId }).catch(() => {});
    await closePage(page);
  }
}

// ---------------------------------------------------------------------------

export async function benchUi({ workspace, headed, note, log, agentEnv }) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    note('playwright-core is not installed — `npm ci` at the repo root');
    return null;
  }

  log('ui: building the web bundle');
  runSync(['npm', 'run', 'build:web', '-w', 'desktop'], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'], check: true });

  const stateDir = tempDir('ui');
  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  fs.writeFileSync(path.join(stateDir, 'remote-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true, port, token }));
  seedAppState(path.join(stateDir, 'app-state.json'), workspace);

  const session = new AgentSession(
    [process.execPath, path.join(repoRoot, 'packages/agent/src/main.ts')],
    agentEnv(stateDir, { WHIPHAND_WEB_ROOT: WEB_ROOT, PATH: benchPath() }),
  );
  let browser;
  try {
    await session.request('hello', { protocolVersion: 1 });
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(`${origin}/`);
    try {
      browser = await chromium.launch({ headless: !headed });
    } catch (error) {
      note(`Chromium did not launch (${error.message.split('\n')[0]}) — run \`npx playwright install chromium\``);
      return null;
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => window.localStorage.setItem('whiphand.perf', '1'));
    const url = `${origin}/#t=${token}`;

    const result = {};
    const scenarios = {
      logs: () => scenarioLogs(context, url),
      fileTree: () => scenarioFileTree(context, url),
      live: () => scenarioLive(context, url, session, workspace),
      diff: () => scenarioDiff(context, url, session, workspace),
    };
    const only = process.env.WHIPHAND_BENCH_UI_ONLY?.split(',');
    for (const [name, run] of Object.entries(scenarios)) {
      if (only && !only.includes(name)) continue;
      log(`ui: ${name}`);
      const repeats = [];
      for (let i = 0; i < REPEATS; i += 1) {
        try {
          repeats.push(await run());
        } catch (error) {
          note(`ui scenario '${name}' failed: ${error.message.split('\n')[0]}`);
          break;
        }
      }
      result[name] = repeats.length === 0 ? null : foldRepeats(repeats);
    }

    // The webview→agent round trip as the page saw it, across every scenario.
    result.rpc = Object.fromEntries(Object.entries(rpcSamples).sort().map(([method, samples]) => [method, summarize(samples)]));
    return result;
  } finally {
    await browser?.close();
    await session.stop();
    discard(stateDir);
  }
}
