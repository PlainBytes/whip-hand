/**
 * The real Transport: starts the @whiphand/agent sidecar via the Tauri shell plugin
 * and wires its stdio to the Transport contract. In a packaged bundle that is
 * the shipped `whiphand-agent` binary; under `tauri dev` it is `node <agent entry>`.
 *
 * One of only two files that import `@tauri-apps/plugin-shell` (main.tsx
 * imports `open` for external links); like main.tsx, nothing vitest loads
 * (AgentClient, MockTransport, and anything that only imports those) ever
 * pulls this module in, so the test suite never needs a Tauri runtime.
 */
import { Command, type Child } from '@tauri-apps/plugin-shell';
import { join, resourceDir } from '@tauri-apps/api/path';
import type { Transport } from './transport.ts';

export class TauriTransport implements Transport {
  private child: Child | undefined;
  private lineCb: ((line: string) => void) | undefined;
  private exitCb: ((code: number | null) => void) | undefined;
  private buffer = '';

  async start(): Promise<void> {
    // Two ways in, chosen at build time by vite.config.ts. Both scope entries
    // live in src-tauri/capabilities/default.json.
    //
    // 'sidecar': a packaged bundle ships the agent as an externalBin, because
    // there is no repo on an installed machine and no guarantee of a system
    // node. Command.sidecar resolves the binary next to the app.
    //
    // 'node': `tauri dev`. 'run-agent-sidecar' is the SCOPE ENTRY NAME — the
    // plugin looks the first argument up by name (ShellScope::prepare) and runs
    // the entry's `cmd` (node).
    //
    // `env: {}` is load-bearing either way: omitting env makes the plugin
    // env_clear() the child, leaving the agent without PATH.
    //
    // The sidecar's node-pty is a bundle resource, not baked into the binary
    // (see packages/agent/src/native.ts and scripts/package/node-pty-resource.mjs)
    // — `resourceDir()` is the "second, different lookup" the standalone-
    // binaries design flagged as missing for exactly this. `tauri dev`'s
    // 'node' mode needs no such hand-off: node-pty sits in node_modules right
    // next to the agent's own source, resolved the same way it always was.
    //
    // WHIPHAND_WEB_ROOT is the same hand-off as WHIPHAND_NODE_PTY_DIR, for the same
    // reason: the sidecar is a plain Node process with no Tauri APIs, so a
    // resolved directory path is the only way to tell it where the browser
    // bundle lives (see packages/agent/src/remote/web-root.ts). Packaged, that
    // is a bundle resource; in dev it is the repo's dist-web.
    const command =
      __AGENT_SPAWN_MODE__ === 'sidecar'
        ? Command.sidecar('binaries/whiphand-agent', [], {
            env: {
              WHIPHAND_NODE_PTY_DIR: await join(await resourceDir(), 'resources', 'node-pty'),
              WHIPHAND_WEB_ROOT: await join(await resourceDir(), 'resources', 'web'),
            },
          })
        : Command.create('run-agent-sidecar', [__AGENT_ENTRY_PATH__], {
            env: { WHIPHAND_WEB_ROOT: __WEB_DIST_PATH__ },
          });

    command.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.lineCb?.(trimmed);
      }
    });

    command.stderr.on('data', (chunk: string) => {
      // Sidecar logging only, per packages/agent/src/main.ts's contract
      // (stdout carries protocol traffic only). Surface it for diagnosis.
      console.error('[whiphand-agent]', chunk);
    });

    command.on('close', payload => {
      this.exitCb?.(payload.code);
    });
    command.on('error', error => {
      console.error('[whiphand-agent] spawn error:', error);
      this.exitCb?.(null);
    });

    this.child = await command.spawn();
  }

  send(line: string): void {
    void this.child?.write(`${line}\n`);
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  kill(): void {
    void this.child?.kill();
  }
}
