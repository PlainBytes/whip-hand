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
import path from 'node:path';
import { repoRoot } from '../package/common.mjs';
import { DEMO_NOW, DETAIL_RUN_NAME } from './demo-workspace.mjs';
import { settled, startWebSession, withDemoWorkspace } from './web-session.mjs';

const VIEWPORT = { width: 1440, height: 900 };
const REVIEW_RUN_NAME = 'money in cents';

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

async function captureTheme({ browser, outDir, theme, workspace, pristine, log }) {
  const { session, url, stop } = await startWebSession({ name: `shots-${theme}`, workspace, pristine, theme });
  let context;
  try {
    context = await browser.newContext({
      viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: theme, timezoneId: 'UTC', locale: 'en-US',
    });
    await context.clock.setFixedTime(DEMO_NOW);
    const page = await context.newPage();
    await page.goto(url);
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
    await stop();
  }
}

export async function captureDesktop({ browser, outDir, themes, log }) {
  await withDemoWorkspace({ log, label: 'desktop' }, async ({ workspace, pristine }) => {
    for (const theme of themes) await captureTheme({ browser, outDir, theme, workspace, pristine, log });
  });
}
