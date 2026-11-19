#!/usr/bin/env node
/**
 * Phone check: opens every screen of the web build at 390×844 (touch, 3×,
 * light) and reports what overflows the viewport. The web build is the
 * remote-access page a phone opens; this reuses the README screenshots'
 * setup (scripts/screenshots/web-session.mjs): a real agent over the demo
 * workspace, driven by Playwright.
 *
 *   npm run mobile-check                          # every scene
 *   npm run mobile-check -- --only runs,doctor    # some scenes
 *   npm run mobile-check -- --headed              # watch it
 *
 * Each scene is `clean` (must not overflow: a failure here is a regression) or
 * `known-broken` (offenders are printed; flip it to `clean` once its layout is
 * fixed — the run says so when a known-broken scene passes). A scene whose
 * `prepare` throws fails the run either way. Screenshots go to
 * target/mobile-check/<scene>.png, never into docs/screenshots.
 *
 * Needs the release agent (`npm run build:parity`) and Chromium
 * (`npx playwright install chromium`), so it is not part of `npm test`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { repoRoot } from './package/common.mjs';
import { DEMO_NOW, DETAIL_RUN_NAME } from './screenshots/demo-workspace.mjs';
import { settled, startWebSession, withDemoWorkspace } from './screenshots/web-session.mjs';

export const OUT_DIR = path.join(repoRoot, 'target/mobile-check');
export const STATUSES = ['clean', 'known-broken'];
export const MAX_OFFENDERS = 5;
const CONTEXT = {
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
  colorScheme: 'light', timezoneId: 'UTC', locale: 'en-US',
};
const REVIEW_RUN_NAME = 'money in cents';
const NAV_BUTTON = 'Open navigation';

/** Taps; falls back to a DOM click when the layout puts the target out of Playwright's reach. */
async function tap(locator) {
  try {
    await locator.tap({ timeout: 5_000 });
  } catch {
    await locator.dispatchEvent('click');
  }
}

/**
 * Navigates by label. Today's sidebar is always on screen; once the phone
 * layout hides it behind an "Open navigation" button, that button is tapped
 * first. Both shapes go through here, so scenes never care which one is live.
 */
export async function goTo(page, label) {
  const open = page.getByRole('button', { name: NAV_BUTTON });
  const drawer = await open.first().isVisible();
  if (drawer) await open.first().tap();
  const item = page.getByRole('button', { name: label, exact: true })
    .or(page.getByRole('link', { name: label, exact: true })).first();
  await tap(item);
  // The drawer hides the page from role queries until its exit finishes and
  // the focus manager has lifted aria-hidden off the app root.
  if (drawer) {
    await page.getByRole('navigation').waitFor({ state: 'detached' });
    await page.locator('#root:not([aria-hidden])').waitFor({ state: 'attached' });
  }
}

/**
 * The Runs list: the nav item, then back to the list from a run or New run
 * tab. Wide: the strip's Runs tab. Narrow: the strip is one Menu button
 * (named for the active tab) whose "All runs" entry is the list.
 */
async function goToRuns(page) {
  await goTo(page, 'Runs');
  const strip = page.getByTestId('run-tab-strip-narrow');
  if (await strip.count()) {
    await tap(strip.getByRole('button').first());
    await tap(page.getByRole('menuitem', { name: 'All runs', exact: true }));
    return;
  }
  const tab = page.getByRole('tab', { name: 'Runs', exact: true });
  if (await tab.count()) await tap(tab.first());
}

/** A run in the list: a grid row on wide screens, a card (one button named for the run) on narrow ones. */
export function runEntry(page, text) {
  return page.getByRole('row').filter({ hasText: text })
    .or(page.getByTestId('page-body').getByRole('button', { name: text }))
    .first();
}

async function openRun(page, text) {
  await goToRuns(page);
  await tap(runEntry(page, text));
  await page.getByTestId('run-panel-terminal').waitFor({ state: 'attached' });
}

/** The run-detail scenes share one open run; each leaves the page on its own panel. */
async function openDetailTab(page, name, panel) {
  await openRun(page, DETAIL_RUN_NAME);
  await tap(page.getByRole('tab', { name }));
  await page.getByTestId(panel).waitFor({ state: 'visible' });
}

async function openReview(page, { session, workspace }) {
  if (!openReview.started) {
    const parked = session.waitFor(m => m.method === 'manualRequest', 30_000);
    const started = session.waitFor(m => m.method === 'whiphandEvent' && m.params?.event?.type === 'run:start', 30_000);
    await session.request('startRun', {
      workdir: workspace, workflow: path.join(workspace, '.whiphand/workflows/review.yaml'), name: REVIEW_RUN_NAME,
    });
    await started;
    await parked;
    openReview.started = true;
  }
  await openRun(page, REVIEW_RUN_NAME);
  await page.getByTestId('review-overlay').waitFor({ timeout: 30_000 });
}

/**
 * `prepare(page, ctx)` leaves the page showing what the scene is named for;
 * `ctx` is `{ session, workspace, origin, url }`. Scenes run in this order on
 * one page, each starting from a navigation of its own, so a scene that starts
 * a run (the review) goes last.
 */
export const SCENES = [
  {
    name: 'token-gate',
    status: 'clean',
    async prepare(page, { origin }) {
      // Only the hash changes, so the page has to be reloaded to read it.
      await page.goto(`${origin}/#t=not-a-token`);
      await page.reload();
      await page.getByText('This link is no longer valid', { exact: false }).waitFor();
    },
  },
  {
    name: 'runs',
    status: 'clean',
    async prepare(page, { url }) {
      // The token gate cleared the stored token; sign in again.
      await page.goto(url);
      await page.reload();
      await runEntry(page, DETAIL_RUN_NAME).waitFor();
    },
  },
  {
    name: 'activity',
    status: 'clean',
    async prepare(page) {
      await goTo(page, 'Activity');
      await page.getByTestId('page-header').filter({ hasText: 'Activity' }).first().waitFor();
    },
  },
  {
    name: 'workspaces',
    status: 'clean',
    async prepare(page) {
      await goTo(page, 'Workspaces');
      await page.getByTestId('page-header').filter({ hasText: 'Workspaces' }).first().waitFor();
    },
  },
  {
    name: 'doctor',
    status: 'clean',
    async prepare(page) {
      await goTo(page, 'Doctor');
      await page.getByTestId('page-header').filter({ hasText: 'Doctor' }).first().waitFor();
    },
  },
  {
    name: 'preferences',
    status: 'clean',
    async prepare(page) {
      await goTo(page, 'Preferences');
      await page.getByTestId('page-header').filter({ hasText: 'Preferences' }).first().waitFor();
    },
  },
  {
    name: 'workspace-settings',
    status: 'clean',
    async prepare(page) {
      await goTo(page, 'Settings');
      await page.getByTestId('page-header').filter({ hasText: 'Settings' }).first().waitFor();
    },
  },
  {
    name: 'workflows',
    status: 'known-broken',
    async prepare(page) {
      await goTo(page, 'Workflows');
      await page.getByRole('button', { name: 'Edit' }).first().waitFor();
    },
  },
  {
    name: 'workflow-editor',
    status: 'known-broken',
    async prepare(page) {
      await goTo(page, 'Workflows');
      await tap(page.getByRole('button', { name: 'Edit' }).first());
      await page.getByText('test-fix').first().waitFor();
    },
  },
  {
    name: 'new-run',
    status: 'clean',
    async prepare(page) {
      await goToRuns(page);
      await tap(page.getByRole('button', { name: 'New run' }).first());
      await page.getByText('Choose a workflow').first().waitFor();
    },
  },
  {
    name: 'run-terminal',
    status: 'known-broken',
    async prepare(page) {
      await openRun(page, DETAIL_RUN_NAME);
    },
  },
  {
    name: 'run-artifacts',
    status: 'clean',
    async prepare(page) {
      await openDetailTab(page, /Artifacts/, 'run-panel-artifacts');
      await page.getByRole('treeitem', { name: /plan\.md/ }).waitFor();
    },
  },
  {
    name: 'run-artifact-open',
    status: 'clean',
    async prepare(page) {
      await openDetailTab(page, /Artifacts/, 'run-panel-artifacts');
      await tap(page.getByRole('treeitem', { name: /plan\.md/ }));
      // Attached, not visible: the squeezed preview pane can have no width at all.
      await page.getByRole('heading', { name: 'Plan: one-page checkout' }).waitFor({ state: 'attached' });
    },
  },
  {
    name: 'run-logs',
    status: 'clean',
    async prepare(page) {
      await openDetailTab(page, /Logs/, 'run-panel-logs');
    },
  },
  {
    name: 'review-files',
    status: 'known-broken',
    async prepare(page, ctx) {
      await openReview(page, ctx);
      await page.getByRole('listbox', { name: 'Changed files' }).waitFor({ timeout: 30_000 });
    },
  },
  {
    name: 'review-diff',
    status: 'known-broken',
    async prepare(page, ctx) {
      await openReview(page, ctx);
      await page.getByRole('listbox', { name: 'Changed files' }).waitFor({ timeout: 30_000 });
      await tap(page.getByRole('option').first());
      await page.locator('[data-testid=diff-grid] [data-row]').first().waitFor({ timeout: 30_000 });
    },
  },
];

/** The scenes `--only` names, in SCENES order; an unknown name is an error. */
export function selectScenes(scenes, only) {
  if (only === undefined) return scenes;
  const names = only.split(',').map(name => name.trim()).filter(Boolean);
  const known = scenes.map(scene => scene.name);
  for (const name of names) {
    if (!known.includes(name)) throw new Error(`--only takes ${known.join(', ')}; got '${name}'`);
  }
  return scenes.filter(scene => names.includes(scene.name));
}

/**
 * Runs in the page. Returns `{ pageOverflow, offenders }`: whether the
 * document scrolls sideways, and the outermost visible elements whose right
 * edge is more than 1px past the viewport, other than those inside a box that
 * scrolls horizontally on its own (and is at least half the viewport wide),
 * plus any `nav` wider than half the viewport. (The page clips at `body`, so anything else
 * out there is unreachable.) Self-contained: it is serialized into the page.
 */
export function measureOverflow() {
  const vw = window.innerWidth;
  const doc = document.documentElement;
  // A scroll area under half the viewport is a sliver, not somewhere to scroll to.
  const scrollsOnItsOwn = el => {
    const style = getComputedStyle(el);
    return /^(auto|scroll)$/.test(style.overflowX) && el.scrollWidth > el.clientWidth && el.clientWidth >= vw / 2;
  };
  const describe = el => {
    const name = el.getAttribute('data-testid') ?? el.getAttribute('aria-label');
    const role = el.getAttribute('role');
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
    const label = name ? `[${el.hasAttribute('data-testid') ? 'testid' : 'aria-label'}=${name}]`
      : role ? `[role=${role}${text ? ` "${text}"` : ''}]`
        : text ? ` "${text}"` : '';
    return `${el.tagName.toLowerCase()}${label}`;
  };
  const found = new Set();
  const offenders = [];
  for (const el of document.body.querySelectorAll('*')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.right <= vw + 1) continue;
    let covered = false;
    for (let up = el.parentElement; up && up !== doc; up = up.parentElement) {
      if (up !== document.body && scrollsOnItsOwn(up)) { covered = true; break; }
    }
    if (covered) continue;
    found.add(el);
    // A descendant of an offender overflows because its ancestor does; name the ancestor.
    let nested = false;
    for (let up = el.parentElement; up; up = up.parentElement) {
      if (found.has(up)) { nested = true; break; }
    }
    if (!nested) offenders.push({ what: describe(el), right: Math.round(rect.right) });
  }
  // A navigation that takes over half the screen leaves the page a sliver.
  for (const nav of document.querySelectorAll('nav')) {
    const rect = nav.getBoundingClientRect();
    if (rect.width > vw / 2 && getComputedStyle(nav).display !== 'none') {
      offenders.unshift({ what: `${describe(nav)} takes ${Math.round(rect.width)}px of ${vw}px`, right: Math.round(rect.right) });
    }
  }
  return {
    pageOverflow: doc.scrollWidth > vw,
    scrollWidth: doc.scrollWidth,
    viewport: vw,
    offenders,
  };
}

/** One scene's verdict: `overflow` is null when `prepare` threw. */
export function judge(scene, { error, overflow }) {
  if (error) return { ok: false, line: `ERROR  ${scene.name}: ${error}` };
  const broken = overflow.pageOverflow || overflow.offenders.length > 0;
  const lines = [];
  if (broken) {
    if (overflow.pageOverflow) lines.push(`    page scrolls sideways: scrollWidth ${overflow.scrollWidth} > ${overflow.viewport}`);
    for (const offender of overflow.offenders.slice(0, MAX_OFFENDERS)) lines.push(`    ${offender.what} ends at x=${offender.right}`);
    if (overflow.offenders.length > MAX_OFFENDERS) lines.push(`    … and ${overflow.offenders.length - MAX_OFFENDERS} more`);
  }
  if (!broken) {
    const hint = scene.status === 'known-broken' ? ' — passes now; flip its status to \'clean\'' : '';
    return { ok: true, line: `pass   ${scene.name}${hint}` };
  }
  if (scene.status === 'clean') return { ok: false, line: [`FAIL   ${scene.name}`, ...lines].join('\n') };
  return { ok: true, line: [`broken ${scene.name} (known)`, ...lines].join('\n') };
}

async function main() {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      headed: { type: 'boolean', default: false },
    },
  });
  const scenes = selectScenes(SCENES, values.only);
  const log = message => console.error(message);

  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    log('playwright-core is not installed — `npm ci` at the repo root');
    return 1;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: !values.headed });
  } catch (error) {
    log(`Chromium did not launch (${error.message.split('\n')[0]}) — run \`npx playwright install chromium\``);
    return 1;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let failed = false;
  try {
    await withDemoWorkspace({ log, label: 'mobile-check' }, async ({ workspace, pristine }) => {
      const web = await startWebSession({ name: 'mobile-check', workspace, pristine, theme: 'light' });
      let context;
      try {
        context = await browser.newContext(CONTEXT);
        await context.clock.setFixedTime(DEMO_NOW);
        const page = await context.newPage();
        // Signed in up front, so `--only` can start at any scene.
        await page.goto(web.url);
        // The phone layout has no nav until its menu button is tapped.
        await page.getByRole('navigation').or(page.getByRole('button', { name: NAV_BUTTON })).first().waitFor();
        for (const scene of scenes) {
          const result = { error: null, overflow: null };
          try {
            await scene.prepare(page, { session: web.session, workspace, origin: web.origin, url: web.url });
            await settled(page);
            result.overflow = await page.evaluate(measureOverflow);
          } catch (error) {
            result.error = error.message.split('\n')[0];
          }
          await page.screenshot({ path: path.join(OUT_DIR, `${scene.name}.png`), animations: 'disabled' })
            .catch(() => {});
          const verdict = judge(scene, result);
          if (!verdict.ok) failed = true;
          console.log(verdict.line);
        }
      } finally {
        await context?.close();
        await web.stop();
      }
    });
  } finally {
    await browser.close();
  }
  console.log(`screenshots: ${path.relative(repoRoot, OUT_DIR)}/`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main().catch(error => {
    console.error(error.message);
    return 1;
  });
}
