/**
 * The gate before the TS agent goes (Phase 3 of docs/migration.md): every
 * scenario in agent-corpus.ts, played against the TS agent and the Rust one
 * in the same directory, must produce the same transcript.
 *
 * The Rust agent is `target/release/whiphand-agent`
 * (`cargo build --release -p whiphand-agent`), or `WHIPHAND_PARITY_AGENT`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from './agent-transcript.ts';
import { SCENARIOS } from './agent-corpus.ts';
import { methods } from '../packages/agent/src/protocol.ts';

const TS_AGENT = fileURLToPath(new URL('../packages/agent/src/main.ts', import.meta.url));
const RUST_AGENT = process.env.WHIPHAND_PARITY_AGENT
  ?? fileURLToPath(new URL(`../target/release/whiphand-agent${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));

/** A port free right now, for the remote-access scenario. */
async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

process.env.PARITY_REMOTE_PORT ??= String(await freePort());

test('agent parity: the scenarios call every method', () => {
  const called = new Set(SCENARIOS.flatMap(s => s.steps.flatMap(step => ('call' in step ? [step.call] : []))));
  assert.deepEqual(Object.keys(methods).filter(m => !called.has(m)), []);
});

for (const scenario of SCENARIOS) {
  test(`agent parity: ${scenario.name}`, { timeout: 120_000 }, async () => {
    assert.ok(existsSync(RUST_AGENT), `build the Rust agent first: cargo build --release -p whiphand-agent (${RUST_AGENT})`);
    const root = mkdtempSync(path.join(tmpdir(), 'whiphand-agent-parity-'));
    try {
      const ts = await runScenario(scenario, [process.execPath, [TS_AGENT]], path.join(root, 's'));
      const rust = await runScenario(scenario, [RUST_AGENT, []], path.join(root, 's'));
      // PARITY_DUMP=<dir> keeps both transcripts, for a diff tool.
      const dump = process.env.PARITY_DUMP;
      if (dump) {
        mkdirSync(dump, { recursive: true });
        const base = path.join(dump, scenario.name.replace(/[^a-z0-9]+/gi, '-'));
        writeFileSync(`${base}.ts.json`, `${JSON.stringify(ts, null, 2)}\n`);
        writeFileSync(`${base}.rust.json`, `${JSON.stringify(rust, null, 2)}\n`);
      }
      assert.deepEqual(rust.responses, ts.responses, 'responses');
      assert.deepEqual(rust.notifications, ts.notifications, 'notifications');
      assert.deepEqual(rust.terminals, ts.terminals, 'terminal output');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
