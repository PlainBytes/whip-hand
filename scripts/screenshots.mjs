#!/usr/bin/env node
/**
 * Regenerates the README screenshots in docs/screenshots/: the desktop app
 * (web build + a real agent over a demo workspace) and the terminal UI (the
 * snapshot tests' screens), each in a light and a dark theme.
 *
 *   npm run screenshots                  # everything
 *   npm run screenshots -- --only tui    # or: desktop
 *   npm run screenshots -- --headed      # watch the desktop scenes
 *
 * Needs the release agent (`npm run build:parity`) and Chromium
 * (`npx playwright install chromium`). See docs/screenshots/README.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from './package/common.mjs';
import { captureTui } from './screenshots/tui.mjs';
import { captureDesktop } from './screenshots/desktop.mjs';

const PARTS = ['desktop', 'tui'];
const THEMES = ['light', 'dark'];
export const OUT_DIR = path.join(repoRoot, 'docs/screenshots');

const { values } = parseArgs({
  options: {
    only: { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});
const only = values.only?.split(',') ?? PARTS;
for (const part of only) {
  if (!PARTS.includes(part)) throw new Error(`--only takes ${PARTS.join(', ')}; got '${part}'`);
}

const log = message => console.error(message);

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  log('playwright-core is not installed — `npm ci` at the repo root');
  process.exit(1);
}
let browser;
try {
  browser = await chromium.launch({ headless: !values.headed });
} catch (error) {
  log(`Chromium did not launch (${error.message.split('\n')[0]}) — run \`npx playwright install chromium\``);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
try {
  if (only.includes('tui')) await captureTui({ browser, outDir: OUT_DIR, themes: THEMES, log });
  if (only.includes('desktop')) await captureDesktop({ browser, outDir: OUT_DIR, themes: THEMES, log });
} finally {
  await browser.close();
}
