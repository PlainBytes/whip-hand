/**
 * The `whiphand` binary the parity tests drive: the Rust CLI
 * (crates/whiphand-cli, docs/migration.md Phase 2), built with
 * `cargo build --release -p whiphand-cli`. `WHIPHAND_PARITY_CLI` points it at
 * another build.
 */
import { fileURLToPath } from 'node:url';

export const CLI = process.env.WHIPHAND_PARITY_CLI
  ?? fileURLToPath(new URL(`../target/release/whiphand${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
