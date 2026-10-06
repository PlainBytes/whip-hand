/**
 * The agent the stdio tests drive: `target/release/whiphand-agent`
 * (`cargo build --release -p whiphand-agent`), or the binary
 * `WHIPHAND_PARITY_AGENT` names.
 */
import { fileURLToPath } from 'node:url';

const AGENT = process.env.WHIPHAND_PARITY_AGENT
  ?? fileURLToPath(new URL(`../target/release/whiphand-agent${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));

/** `[command, ...args]` to spawn the agent with. */
export function agentCommand(): [string, string[]] {
  return [AGENT, []];
}
