/**
 * TUI README screenshots: the insta snapshot tests already build every screen
 * from fixed models (crates/whiphand-tui/tests/snapshots.rs); with
 * WHIPHAND_TUI_SHOTS set they also dump each one, styles included, as JSON.
 * This renders the ones listed in SCENES as a terminal window and
 * screenshots it in each theme.
 *
 * To publish another screen, add its snapshot name here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runSync } from '../lib/exec.mjs';
import { discard } from '../lib/child.mjs';
import { repoRoot } from '../package/common.mjs';
import { tempDir } from '../bench/agent-session.mjs';
import { terminalHtml } from './terminal-html.mjs';

/** `file` is the PNG's base name; `snapshot` is the name passed to `snapshot()` in snapshots.rs. */
export const SCENES = [
  { file: 'tui-runs', snapshot: 'runs' },
  { file: 'tui-run-detail', snapshot: 'detail_log' },
];

export async function captureTui({ browser, outDir, themes, log }) {
  const dumpDir = tempDir('tui-shots');
  try {
    log('tui: drawing the snapshot screens');
    runSync(['cargo', 'test', '-q', '-p', 'whiphand-tui', '--test', 'snapshots'], {
      cwd: repoRoot,
      env: { ...process.env, WHIPHAND_TUI_SHOTS: dumpDir },
      stdio: ['ignore', 'ignore', 'inherit'],
      check: true,
    });
    for (const theme of themes) {
      const context = await browser.newContext({ deviceScaleFactor: 2, colorScheme: theme });
      try {
        const page = await context.newPage();
        for (const scene of SCENES) {
          const dump = path.join(dumpDir, `${scene.snapshot}.json`);
          if (!fs.existsSync(dump)) throw new Error(`snapshots.rs drew no screen called '${scene.snapshot}'`);
          await page.setContent(terminalHtml(JSON.parse(fs.readFileSync(dump, 'utf8')), theme));
          await page.evaluate(() => document.fonts.ready);
          const file = path.join(outDir, `${scene.file}-${theme}.png`);
          await page.locator('body').screenshot({ path: file, omitBackground: true });
          log(`tui: ${path.relative(repoRoot, file)}`);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    discard(dumpDir);
  }
}
