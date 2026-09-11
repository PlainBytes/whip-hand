import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, '../..');

/**
 * Absolute path (dev machine, computed at config time) to the @whiphand/agent
 * sidecar entry point. Injected as a global constant so TauriTransport can
 * spawn `node <AGENT_ENTRY_PATH>` without hardcoding a path.
 */
const agentEntryPath = path.resolve(repoRoot, 'packages/agent/src/main.ts');

/**
 * How TauriTransport should start the sidecar. A packaged bundle has no repo to
 * point `node` at, so `npm run package:desktop` sets WHIPHAND_PACKAGE=1 and the app
 * spawns the bundled `whiphand-agent` binary instead. `tauri dev` leaves it unset and
 * keeps the fast path: edit the agent's TypeScript, restart, no rebuild.
 */
const agentSpawnMode = process.env.WHIPHAND_PACKAGE === '1' ? 'sidecar' : 'node';

/**
 * Where `npm run build:web -w desktop` puts the browser bundle. Passed to the
 * sidecar as WHIPHAND_WEB_ROOT in dev mode so remote access serves a real page from
 * a repo checkout; a packaged build reads the bundled resource instead.
 */
const webDistPath = path.resolve(appDir, 'dist-web');

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    /**
     * dist/ is read off local disk by the Tauri shell (`frontendDist: "../dist"`),
     * never over a network, so the 500 kB default — a web-performance heuristic —
     * measures nothing here. Raised rather than switched off, so genuine growth
     * still trips it. The browser-served bundle keeps the default on purpose;
     * see vite.web.config.ts.
     */
    chunkSizeWarningLimit: 2000,
    rolldownOptions: {
      /**
       * The `await import()` calls in src/lib/updater.ts are an isolation
       * device, not a code-splitting one: createTauriUpdater() returns
       * noopUpdater when `__TAURI_INTERNALS__` is absent, so vitest/jsdom never
       * loads `@tauri-apps/*` at all, and vite.web.config.ts's forbidTauri
       * rewrites the same specifiers to a throwing stub for the browser bundle.
       *
       * Rolldown is right that it cannot move those modules into their own
       * chunk — the desktop shell also imports them statically (api/core from
       * files/tauri-fs.ts, plugin-shell from agent/tauri-transport.ts and
       * main.tsx). That costs nothing, since a desktop build needs them eagerly
       * regardless. But it is a warning no one can ever act on, and a build that
       * always prints un-actionable warnings trains people to skim past the
       * ones that matter.
       *
       * Scoped to the `@tauri-apps` namespace, and to this warning code. Not
       * scoped to updater.ts as the importer: rolldown reports one warning per
       * imported MODULE, listing dynamic importers first in `ids` and static
       * ones after, with no marker between them — so "updater.ts is the dynamic
       * importer" cannot actually be asserted, only guessed at from position.
       * A narrower-looking check on `ids[0]` was tried and kept matching once a
       * second dynamic importer was added, which is worse than no check: it
       * reads as a guard while guarding nothing.
       *
       * Exempting the whole namespace is the honest scope anyway. A desktop
       * build links `@tauri-apps/*` eagerly by construction — that is what the
       * shell is — so an ineffective-dynamic-import report about it can never
       * carry information we have not already accepted.
       *
       * Every other module still warns. Verified by adding a reachable
       * `import('@fluentui/react-components')` to main.tsx, which reports as it
       * should. Note the probe has to be REACHABLE: an unused exported function
       * is tree-shaken out of the entry, never enters the graph, and produces no
       * warning — which looks exactly like a filter that is too broad.
       */
      onwarn(warning, defaultHandler) {
        const { code, id } = warning as { code?: string; id?: string };
        if (code === 'INEFFECTIVE_DYNAMIC_IMPORT' && id?.includes('/@tauri-apps/')) return;
        defaultHandler(warning);
      },
    },
  },
  server: {
    port: 61337,
    strictPort: true,
    fs: {
      // The webview does type-only imports from packages outside apps/desktop
      // (packages/agent/src/protocol.ts, @whiphand/core) — allow vite dev-server
      // file access to the whole repo, not just apps/desktop.
      allow: [repoRoot],
    },
  },
  define: {
    __AGENT_ENTRY_PATH__: JSON.stringify(agentEntryPath),
    __AGENT_SPAWN_MODE__: JSON.stringify(agentSpawnMode),
    __WEB_DIST_PATH__: JSON.stringify(webDistPath),
  },
});
