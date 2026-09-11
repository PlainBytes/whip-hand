/// <reference types="vite/client" />

/**
 * Injected by vite.config.ts's `define` — absolute path to the @whiphand/agent
 * sidecar entry point, resolved from the app dir at config time. Only
 * referenced by TauriTransport (never bundled into code paths vitest loads).
 */
declare const __AGENT_ENTRY_PATH__: string;

/**
 * Injected by vite.config.ts's `define` — 'sidecar' in a packaged bundle,
 * 'node' during `tauri dev`. Chooses how TauriTransport starts the agent.
 */
declare const __AGENT_SPAWN_MODE__: 'node' | 'sidecar';

/**
 * Injected by vite.config.ts's `define` — absolute path to the browser SPA's
 * dev build (apps/desktop/dist-web), handed to the sidecar as WHIPHAND_WEB_ROOT so
 * remote access can serve a page under `tauri dev`. A packaged build resolves
 * the equivalent Tauri resource directory at runtime instead.
 */
declare const __WEB_DIST_PATH__: string;
