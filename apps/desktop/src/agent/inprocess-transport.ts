/**
 * The real Transport: the agent runs inside the Tauri process (see
 * src-tauri/src/agent.rs), and this talks to it with three commands.
 *
 * - start() attaches with two Channels: protocol lines, and one message when
 *   the agent goes away. A reattach restarts an agent whose thread has died,
 *   so AgentClient's respawn-with-backoff works unchanged.
 * - send() batches: while one agent_send is in flight, later lines queue
 *   and go in the next call. Separate invokes can overtake each other, and
 *   keystrokes (ptyInput) must not.
 * - kill() detaches. The agent itself keeps running: remote clients and jobs
 *   do not depend on this window.
 *
 * Kept out of vitest's import graph, like every module that imports
 * `@tauri-apps/*` at module scope.
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import type { Transport } from './transport.ts';

export class InProcessTransport implements Transport {
  private lineCb: ((line: string) => void) | undefined;
  private exitCb: ((code: number | null) => void) | undefined;
  /** Bumped by every start() and kill(), so an old attachment's traffic is ignored. */
  private generation = 0;
  private queue: string[] = [];
  private sending = false;
  /** The latest agent_attach; lines wait for it rather than fail. */
  private attached: Promise<unknown> = Promise.resolve();

  async start(): Promise<void> {
    const generation = ++this.generation;
    const onLine = new Channel<string>();
    onLine.onmessage = line => {
      if (generation === this.generation) this.lineCb?.(line);
    };
    const onExit = new Channel<null>();
    onExit.onmessage = () => {
      if (generation === this.generation) this.exitCb?.(null);
    };
    this.attached = invoke('agent_attach', { onLine, onExit });
    await this.attached;
  }

  send(line: string): void {
    this.queue.push(line);
    if (!this.sending) void this.flush();
  }

  private async flush(): Promise<void> {
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        await this.attached.catch(() => {});
        const lines = this.queue;
        this.queue = [];
        if (lines.length === 0) continue;
        try {
          await invoke('agent_send', { lines });
        } catch (error) {
          // Not attached: AgentClient's request timeouts report it.
          console.error('[whiphand-agent] send failed:', error);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  kill(): void {
    this.generation += 1;
    this.queue = [];
    void invoke('agent_detach').catch(() => {});
  }
}
