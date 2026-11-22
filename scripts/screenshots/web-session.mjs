/**
 * The setup shared by every script that drives the web build of the desktop
 * app (apps/desktop/vite.web.config.ts) in Chromium: the README screenshots
 * (desktop.mjs) and the phone check (scripts/mobile-check.mjs).
 *
 * `withDemoWorkspace` builds the bundle, locks the fixed demo root and makes
 * the demo workspace plus a pristine copy of it. `startWebSession` then gives
 * one fresh, isolated agent over a restored copy, with remote access seeded on,
 * and the URL that signs a page in. `settled` waits for a page to stop moving.
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
import { createDemoWorkspace } from './demo-workspace.mjs';

export const WEB_ROOT = path.join(repoRoot, 'apps/desktop/dist-web');
export const exe = name => path.join(repoRoot, 'target/release', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
/** Fixed, so the workspace path the sidebar shows is the same on every regeneration. */
export const DEMO_ROOT = path.join(os.tmpdir(), 'whiphand-demo');

/**
 * DEMO_ROOT is one fixed path for every checkout, so a second capture would
 * delete the first one's workspace under its agent. `<DEMO_ROOT>.lock` (made
 * atomically, holding the owner's pid) keeps it to one capture at a time; a
 * lock whose process is gone is stale and taken over.
 */
export function lockDemoRoot() {
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

/**
 * Builds the web bundle, then runs `fn({ workspace, pristine })` with the demo
 * workspace made under the locked DEMO_ROOT; everything is removed afterwards.
 * `label` prefixes the progress lines.
 */
export async function withDemoWorkspace({ log, label }, fn) {
  for (const binary of ['whiphand', 'whiphand-agent']) {
    if (!fs.existsSync(exe(binary))) throw new Error(`${path.relative(repoRoot, exe(binary))} is missing — run \`npm run build:parity\` first`);
  }
  log(`${label}: building the web bundle`);
  runSync(['npm', 'run', 'build:web', '-w', 'desktop'], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'], check: true });

  const root = DEMO_ROOT;
  const release = lockDemoRoot();
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  try {
    log(`${label}: making the demo workspace`);
    const stateDir = path.join(root, 'cli-state');
    const workspace = createDemoWorkspace(path.join(root, 'shop'), {
      cli: exe('whiphand'),
      env: isolatedEnv(stateDir, { TZ: 'UTC' }),
    });
    const pristine = path.join(root, 'pristine');
    fs.cpSync(workspace, pristine, { recursive: true });
    return await fn({ workspace, pristine });
  } finally {
    discard(root);
    release();
  }
}

/**
 * A fresh agent serving the web build over `workspace`, restored from
 * `pristine` at the same path its runs were made at (so their workdir still
 * matches). Returns `{ session, origin, token, url, stop }`; `url` signs a page
 * in, and `stop` ends the agent and removes its state.
 */
export async function startWebSession({ name, workspace, pristine, theme }) {
  const stateDir = tempDir(name);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.cpSync(pristine, workspace, { recursive: true });

  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  fs.writeFileSync(path.join(stateDir, 'remote-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true, port, token }));
  seedAppState(path.join(stateDir, 'app-state.json'), workspace, { theme });

  const session = new AgentSession([exe('whiphand-agent')], isolatedEnv(stateDir, { WHIPHAND_WEB_ROOT: WEB_ROOT, TZ: 'UTC' }));
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    await session.stop();
    discard(stateDir);
  };
  try {
    await session.request('hello', { protocolVersion: 1 });
    await waitForHttp(`${origin}/`);
  } catch (error) {
    await stop();
    throw error;
  }
  return { session, origin, token, url: `${origin}/#t=${token}`, stop };
}

/** Waits for fonts and two frames, so the shot is of a settled page. */
export async function settled(page) {
  const { width, height } = page.viewportSize();
  // Off anything hoverable: a click leaves the pointer on its target, tooltip and all.
  await page.mouse.move(width - 2, height / 2);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.waitForTimeout(300);
}
