import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static contract between InProcessTransport, the Tauri commands and the
 * capability file. Neither vitest nor cargo check can exercise Tauri's IPC,
 * and a mismatch fails silently in a release build (the agent just never
 * answers), so this pins:
 *   1. every command the transport invokes is registered in lib.rs;
 *   2. the shell plugin grants nothing that could spawn a process, now the
 *      agent is in-process, but keeps `open`;
 *   3. no sidecar binary or node-pty resource is bundled.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const tauriDir = path.resolve(here, '../../src-tauri');
const read = (p: string): string => readFileSync(path.join(tauriDir, p), 'utf8');

const capability = JSON.parse(read('capabilities/default.json')) as { permissions: unknown[] };
const tauriConfig = JSON.parse(read('tauri.conf.json')) as {
  bundle: { externalBin?: string[]; resources?: string[] };
};
const libSource = read('src/lib.rs');
const transportSource = readFileSync(path.resolve(here, 'inprocess-transport.ts'), 'utf8');

const permissionIds = capability.permissions.map(p =>
  typeof p === 'string' ? p : (p as { identifier: string }).identifier,
);

describe('InProcessTransport ↔ Tauri contract', () => {
  it('invokes only commands lib.rs registers', () => {
    const invoked = [...transportSource.matchAll(/invoke\('(\w+)'/g)].map(m => m[1]);
    expect(invoked.sort()).toEqual(['agent_attach', 'agent_detach', 'agent_send']);
    const handler = libSource.slice(libSource.indexOf('generate_handler!['));
    for (const command of invoked) {
      expect(handler, `${command} missing from generate_handler!`).toMatch(new RegExp(`agent::${command}\\b`));
    }
  });

  it('grants the shell plugin no way to spawn or drive a process', () => {
    for (const id of ['shell:allow-spawn', 'shell:allow-execute', 'shell:allow-stdin-write', 'shell:allow-kill']) {
      expect(permissionIds).not.toContain(id);
    }
  });

  it('keeps shell:allow-open, which the markdown renderer and the updater need', () => {
    // plugin-shell's open() is refused without it, and the refusal is silent
    // in the UI: an external markdown link would simply do nothing.
    expect(permissionIds).toContain('shell:allow-open');
  });

  it('bundles no sidecar and no node-pty', () => {
    expect(tauriConfig.bundle.externalBin).toBeUndefined();
    expect(tauriConfig.bundle.resources).toEqual(['resources/web/**/*']);
  });
});
