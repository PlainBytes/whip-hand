import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static contract between TauriTransport and the Tauri capability file.
 * Neither vitest nor cargo check can exercise the shell plugin's runtime ACL,
 * and a mismatch fails silently in release builds (the agent just never
 * spawns), so this test pins the three facts that bit us:
 *   1. spawn/stdin_write/kill are each SEPARATE permissions in
 *      tauri-plugin-shell v2 — allow-execute does not cover Command.spawn().
 *   2. Command.create()'s first argument is looked up as the scope entry's
 *      NAME (ShellScope::prepare matches `s.name == command_name`), not the
 *      program; the entry's `cmd` is what actually runs.
 *   3. Omitting CommandOptions.env makes the plugin env_clear() the child;
 *      PASSING an env object — empty or populated — is what inherits the
 *      parent environment and then adds to it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const capabilityPath = path.resolve(here, '../../src-tauri/capabilities/default.json');
const transportPath = path.resolve(here, 'tauri-transport.ts');

interface ScopedPermission {
  identifier: string;
  allow?: Array<{ name?: string; cmd?: string; sidecar?: boolean }>;
}
type Permission = string | ScopedPermission;

const capability = JSON.parse(readFileSync(capabilityPath, 'utf8')) as { permissions: Permission[] };
const transportSource = readFileSync(transportPath, 'utf8');

function scopedPermission(identifier: string): ScopedPermission | undefined {
  return capability.permissions.find(
    (p): p is ScopedPermission => typeof p === 'object' && p.identifier === identifier,
  );
}

describe('TauriTransport ↔ capability contract', () => {
  it('grants shell:allow-spawn with a scoped command entry (execute does not cover spawn())', () => {
    const spawn = scopedPermission('shell:allow-spawn');
    expect(spawn, 'shell:allow-spawn scoped permission missing from default.json').toBeDefined();
    expect(spawn!.allow?.length).toBeGreaterThan(0);
  });

  it('grants stdin-write and kill, which child.write()/kill() require', () => {
    const flat = capability.permissions.filter((p): p is string => typeof p === 'string');
    expect(flat).toContain('shell:allow-stdin-write');
    expect(flat).toContain('shell:allow-kill');
  });

  it('grants shell:allow-open, which the markdown renderer needs to reach the browser', () => {
    // plugin-shell's open() is refused without it, and the refusal is silent
    // in the UI: an external markdown link would simply do nothing.
    const flat = capability.permissions.filter((p): p is string => typeof p === 'string');
    expect(flat).toContain('shell:allow-open');
  });

  it("Command.create()'s first argument is the scope entry NAME, and the entry runs node", () => {
    const spawn = scopedPermission('shell:allow-spawn');
    const entry = spawn?.allow?.[0];
    expect(entry?.name, 'scope entry must have a name').toBeTruthy();
    expect(entry?.cmd).toBe('node');
    expect(
      transportSource,
      `TauriTransport must spawn via the scope entry name '${entry?.name}', not the program`,
    ).toContain(`Command.create('${entry!.name}'`);
  });

  /**
   * Was `env: {}` exactly, until the sidecar needed WHIPHAND_WEB_ROOT as well as
   * WHIPHAND_NODE_PTY_DIR. What the plugin actually keys on is whether `env` is
   * PRESENT: omitted, it env_clear()s the child and the agent loses PATH;
   * supplied — empty or populated — std::process::Command's inherited
   * environment survives and the given pairs are added to it. The packaged
   * sidecar branch has always relied on that, since it has always passed
   * WHIPHAND_NODE_PTY_DIR. So the contract is "env is passed", not "env is empty".
   */
  it('passes an env option in BOTH spawn modes, so the agent keeps its environment', () => {
    for (const spawn of ['Command.create', 'Command.sidecar']) {
      const call = transportSource.slice(transportSource.indexOf(spawn));
      expect(call, `${spawn} must pass an env option`).toMatch(/\benv:\s*\{/);
    }
  });

  it('hands the sidecar both resource directories it cannot resolve for itself', () => {
    // A plain Node process has no Tauri APIs, so resourceDir() has to be
    // resolved here and passed across.
    expect(transportSource).toMatch(/WHIPHAND_NODE_PTY_DIR:\s*await join\(await resourceDir\(\)/);
    expect(transportSource).toMatch(/WHIPHAND_WEB_ROOT:\s*await join\(await resourceDir\(\)/);
  });
});
