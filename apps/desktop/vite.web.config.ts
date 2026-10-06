import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, '../..');

/**
 * These three modules reach for `@tauri-apps/*` behind a dynamic import that a
 * runtime `__TAURI_INTERNALS__` check never lets execute in a browser. The
 * runtime guard does not satisfy the BUNDLER, which still resolves the
 * specifier to build the chunk — so they resolve to a throwing stub instead.
 *
 * An allow-list keyed on the importer, rather than a blanket alias: a blanket
 * alias would silently absorb a genuine mistake in some new file, which is
 * exactly what forbidTauri exists to prevent.
 */
const TAURI_GUARDED_IMPORTERS = [
  'src/lib/notifier.ts',
  'src/lib/window-state.ts',
  'src/lib/updater.ts',
].map(rel => path.resolve(appDir, rel));

const TAURI_STUB = path.resolve(appDir, 'src/web/tauri-unavailable.ts');

/**
 * NOT 'dist' — that is tauri.conf.json's frontendDist, and clobbering it would
 * make the desktop app boot the browser build.
 */
const WEB_OUT_DIR = 'dist-web';

/**
 * Fails the build if anything in the web graph reaches for a Tauri module.
 *
 * A lint rule or a test asserting "no @tauri-apps in the bundle" can be
 * disabled, skipped, or simply not run. This cannot: the bundle does not
 * exist unless the graph is clean, and the message names the offending
 * import instead of leaving a blank page and a console error about
 * __TAURI_INTERNALS__ at runtime.
 */
function forbidTauri(): Plugin {
  return {
    name: 'whiphand:forbid-tauri',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!id.startsWith('@tauri-apps/')) return null;
      if (importer && TAURI_GUARDED_IMPORTERS.includes(path.resolve(importer))) return TAURI_STUB;
      throw new Error(
        `the web bundle must not import '${id}'` +
        `${importer ? ` (from ${path.relative(repoRoot, importer)})` : ''}. ` +
        'Reach the desktop-only capability through capabilities.tsx instead.',
      );
    },
  };
}

/**
 * The entry HTML has to be called index.web.html in the source tree (index.html
 * is already the desktop's), but has to SHIP as index.html so the agent's
 * static server can serve it from the root without special-casing a name.
 *
 * Renamed on disk in closeBundle rather than rewritten in generateBundle:
 * rolldown emits the HTML asset after generateBundle runs, so a bundle-map
 * edit there silently loses the file — which is exactly what happened.
 */
function emitAsIndexHtml(): Plugin {
  // Read from the RESOLVED config, not from a constant: the packaging script
  // overrides the output with `--outDir`, and a hardcoded path silently left
  // the resource tree with an unrenamed index.web.html that the agent then
  // reported as "never built".
  let outDir = '';
  return {
    name: 'whiphand:index-html',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const from = path.join(outDir, 'index.web.html');
      const to = path.join(outDir, 'index.html');
      if (!fs.existsSync(from)) {
        throw new Error(`expected ${from} after the build; the web bundle has no entry HTML`);
      }
      fs.renameSync(from, to);
    },
  };
}

/**
 * The browser build of the same React app the desktop runs. Separate config
 * rather than a mode flag on vite.config.ts, for the same reason
 * vitest.config.ts is separate: the two have genuinely different entry points,
 * outputs and constraints, and a shared file with three conditionals in it is
 * harder to be sure about than two short ones.
 */
export default defineConfig({
  plugins: [forbidTauri(), react(), emitAsIndexHtml()],
  clearScreen: false,
  // Served from the root of the agent's HTTP server.
  base: '/',
  build: {
    outDir: WEB_OUT_DIR,
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(appDir, 'index.web.html') },
    /**
     * No chunkSizeWarningLimit here, deliberately. vite.config.ts raises it
     * because the desktop shell reads its bundle off local disk; this one is
     * served over the network by the agent's remote-access server to a real
     * browser, possibly a phone, so the 500 kB default is measuring something
     * true. It currently trips at ~1.7 MB for the entry chunk. Leave it
     * tripping: it is the standing reminder that the remote path pays for
     * every dependency the desktop app takes for granted.
     *
     * pdf.js is an expected lazy chunk (src/pdf/load-pdfjs.ts), fetched only
     * when a PDF is opened: ~430 kB, just under the limit, so a pdf.js upgrade
     * may well trip it — that one is known and fine. Its worker (~1.2 MB) is a
     * separate .mjs asset, which this warning does not measure at all.
     */
  },
});
