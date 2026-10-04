/**
 * The agent the stdio tests drive: the TS agent by default, or the Rust
 * `whiphand-agent` binary (crates/whiphand-agent, Phase 3 of
 * docs/migration.md) when `WHIPHAND_PARITY_AGENT` names it. Built with
 * `cargo build --release -p whiphand-agent`.
 */
import { fileURLToPath } from 'node:url';

const TS_AGENT = fileURLToPath(new URL('../packages/agent/src/main.ts', import.meta.url));

/** `[command, ...args]` to spawn the agent with. */
export function agentCommand(): [string, string[]] {
  const rust = process.env.WHIPHAND_PARITY_AGENT;
  return rust ? [rust, []] : [process.execPath, [TS_AGENT]];
}
