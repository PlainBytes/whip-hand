/**
 * Desktop README screenshots: the web build of the desktop app (the same
 * React app, see apps/desktop/vite.web.config.ts) served by a real agent's
 * remote-access server over the demo workspace, driven by Playwright — the
 * setup scripts/bench/ui.mjs uses. Chromium stands in for the Tauri webview.
 *
 * Each theme gets a fresh agent and the workspace restored from a pristine
 * copy, so a scene that starts a run cannot leak it into the other theme.
 *
 * To add a screen, add an entry to SCENES.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runSync } from '../lib/exec.mjs';
import { discard } from '../lib/child.mjs';
import { freePort, waitForHttp } from '../lib/http.mjs';
import { repoRoot } from '../package/common.mjs';
import { AgentSession, isolatedEnv, tempDir } from '../bench/agent-session.mjs';
import { seedAppState } from '../bench/fixtures.mjs';
import { createDemoWorkspace, DEMO_NOW, DETAIL_RUN_NAME } from './demo-workspace.mjs';

const WEB_ROOT = path.join(repoRoot, 'apps/desktop/dist-web');
const exe = name => path.join(repoRoot, 'target/release', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
const VIEWPORT = { width: 1440, height: 900 };
const REVIEW_RUN_NAME = 'money in cents';
/** Fixed, so the workspace path the sidebar shows is the same on every regeneration. */
const DEMO_ROOT = path.join(os.tmpdir(), 'whiphand-demo');

async function openRun(page, text) {
  await page.getByText(text, { exact: true }).first().click();
  await page.getByTestId('run-panel-terminal').waitFor({ state: 'attached' });
}

/**
 * `prepare(page, ctx)` leaves the page showing what the shot should show;
 * `ctx` is `{ session, workspace }`. Scenes run in this order on one page, so
 * a scene that starts a run goes last.
 */
export const SCENES = [
  {
    file: 'desktop-runs',
    async prepare(page) {
      await page.getByText(DETAIL_RUN_NAME, { exact: true }).first().waitFor();
    },
  },
  {
    file: 'desktop-run-detail',
    async prepare(page) {
      await openRun(page, DETAIL_RUN_NAME);
      await page.getByRole('tab', { name: /Artifacts/ }).click();
      await page.getByRole('treeitem', { name: /plan\.md/ }).click();
      await page.getByRole('heading', { name: 'Plan: one-page checkout' }).waitFor();
    },
  },
  {
    file: 'desktop-workflow-editor',
    async prepare(page) {
      await page.getByRole('link', { name: 'Workflows' }).or(page.getByRole('button', { name: 'Workflows' })).first().click();
      await page.getByRole('button', { name: 'Edit' }).first().click();
      await page.getByText('test-fix').first().waitFor();
    },
  },
  {
    file: 'desktop-review',
    async prepare(page, { session, workspace }) {
      const parked = session.waitFor(m => m.method === 'manualRequest', 30_000);
      const started = session.waitFor(m => m.method === 'whiphandEvent' && m.params?.event?.type === 'run:start', 30_000);
      await session.request('startRun', {
        workdir: workspace, workflow: path.join(workspace, '.whiphand/workflows/review.yaml'), name: REVIEW_RUN_NAME,
      });
      await started;
      await parked;
      await page.getByRole('link', { name: 'Runs' }).or(page.getByRole('button', { name: 'Runs' })).first().click();
      await openRun(page, REVIEW_RUN_NAME);
      await page.getByTestId('review-overlay').waitFor({ timeout: 30_000 });
      await page.locator('[data-testid=diff-grid] [data-row]').first().waitFor({ timeout: 30_000 });
    },
  },
];

/**
 * DEMO_ROOT is one fixed path for every checkout, so a second capture would
 * delete the first one's workspace under its agent. `<DEMO_ROOT>.lock` (made
 * atomically, holding the owner's pid) keeps it to one capture at a time; a
 * lock whose process is gone is stale and taken over.
 */
function lockDemoRoot() {
  const lock = `${DEMO_ROOT}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      return () => fs.rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(path.join(lock, 'pid'), { encoding: 'utf8', flag: 'a+' }));
      let alive = false;
      try {
        alive = pid > 0 && process.kill(pid, 0);
      } catch (probe) {
        alive = probe.code === 'EPERM';
      }
      if (alive) throw new Error(`another screenshot capture (pid ${pid}) is using ${DEMO_ROOT}; wait for it to finish`);
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
  throw new Error(`could not lock ${DEMO_ROOT}`);
}

/** Waits for fonts and two frames, so the shot is of a settled page. */
async function settled(page) {
  // Off anything hoverable: a click leaves the pointer on its target, tooltip and all.
  await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height / 2);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.waitForTimeout(300);
}

async function captureTheme({ browser, outDir, theme, workspace, pristine, log }) {
  const stateDir = tempDir(`shots-${theme}`);
  // Restored at the path its runs were made at, so their workdir still matches.
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.cpSync(pristine, workspace, { recursive: true });

  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  fs.writeFileSync(path.join(stateDir, 'remote-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true, port, token }));
  seedAppState(path.join(stateDir, 'app-state.json'), workspace, { theme });

  const session = new AgentSession([exe('whiphand-agent')], isolatedEnv(stateDir, { WHIPHAND_WEB_ROOT: WEB_ROOT, TZ: 'UTC' }));
  let context;
  try {
    await session.request('hello', { protocolVersion: 1 });
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(`${origin}/`);
    context = await browser.newContext({
      viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: theme, timezoneId: 'UTC', locale: 'en-US',
    });
    await context.clock.setFixedTime(DEMO_NOW);
    const page = await context.newPage();
    await page.goto(`${origin}/#t=${token}`);
    for (const scene of SCENES) {
      try {
        await scene.prepare(page, { session, workspace });
      } catch (error) {
        throw new Error(`desktop scene '${scene.file}' (${theme}): ${error.message.split('\n')[0]}`);
      }
      await settled(page);
      const file = path.join(outDir, `${scene.file}-${theme}.png`);
      // Frozen: the parked step's spinner would otherwise differ frame to frame.
      await page.screenshot({ path: file, animations: 'disabled' });
      log(`desktop: ${path.relative(repoRoot, file)}`);
    }
  } finally {
    await context?.close();
    await session.stop();
    discard(stateDir);
  }
}

export async function captureDesktop({ browser, outDir, themes, log }) {
  for (const binary of ['whiphand', 'whiphand-agent']) {
    if (!fs.existsSync(exe(binary))) throw new Error(`${path.relative(repoRoot, exe(binary))} is missing — run \`npm run build:parity\` first`);
  }
  log('desktop: building the web bundle');
  runSync(['npm', 'run', 'build:web', '-w', 'desktop'], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'], check: true });

  const root = DEMO_ROOT;
  const release = lockDemoRoot();
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  try {
    log('desktop: making the demo workspace');
    const stateDir = path.join(root, 'cli-state');
    const workspace = createDemoWorkspace(path.join(root, 'shop'), {
      cli: exe('whiphand'),
      env: isolatedEnv(stateDir, { TZ: 'UTC' }),
    });
    const pristine = path.join(root, 'pristine');
    fs.cpSync(workspace, pristine, { recursive: true });
    for (const theme of themes) await captureTheme({ browser, outDir, theme, workspace, pristine, log });
  } finally {
    discard(root);
    release();
  }
}
