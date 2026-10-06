/**
 * Transport abstraction between AgentClient and wherever the agent runs. This
 * is the testability seam: AgentClient only ever talks to this interface,
 * never to `@tauri-apps/*` directly, so it can be exercised in vitest (jsdom,
 * no Tauri runtime) via MockTransport. The desktop's implementation,
 * InProcessTransport, lives in its own file (./inprocess-transport.ts) so
 * nothing that vitest loads ever imports `@tauri-apps/*` at module scope.
 */
export interface Transport {
  /** Connect to the agent. May be called again after kill()/exit to reconnect. */
  start(): Promise<void>;
  /** Send one protocol line (no trailing newline). */
  send(line: string): void;
  /** Register the handler invoked for each line from the agent. Last registration wins. */
  onLine(cb: (line: string) => void): void;
  /** Register the handler invoked when the connection ends, however it ends. Last registration wins. */
  onExit(cb: (code: number | null) => void): void;
  /** Disconnect, if connected. */
  kill(): void;
}

/**
 * Scriptable Transport for tests: records every line handed to send(), and
 * exposes emitLine()/emitExit() so a test can drive AgentClient's reaction to
 * inbound protocol traffic and process lifecycle events without any real I/O.
 */
export class MockTransport implements Transport {
  readonly sent: string[] = [];
  startCalls = 0;
  killCalls = 0;
  /** Test hook: override to simulate start() failing (e.g. repeated respawn failure). */
  startImpl: (() => Promise<void>) | undefined;
  private running = false;
  private lineCb: ((line: string) => void) | undefined;
  private exitCb: ((code: number | null) => void) | undefined;

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startImpl) {
      await this.startImpl();
    }
    this.running = true;
  }

  send(line: string): void {
    this.sent.push(line);
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  kill(): void {
    this.killCalls += 1;
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Test helper: parse the nth (0-based) sent line as JSON. */
  sentRequest(index: number): { id: number; method: string; params?: unknown } {
    return JSON.parse(this.sent[index]) as { id: number; method: string; params?: unknown };
  }

  /** Test helper: deliver one NDJSON line to AgentClient, as if read from stdout. */
  emitLine(value: unknown): void {
    this.lineCb?.(JSON.stringify(value));
  }

  /** Test helper: simulate the child process exiting. */
  emitExit(code: number | null = 1): void {
    this.running = false;
    this.exitCb?.(code);
  }
}
