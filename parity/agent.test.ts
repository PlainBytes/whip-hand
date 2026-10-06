/**
 * The agent's regression check: every scenario in agent-corpus.ts, played
 * against the Rust agent, must produce the transcript recorded in
 * fixtures/agent. The transcripts were first recorded while the TS agent was
 * still the reference and both agents answered every scenario identically
 * (Phase 3 of docs/migration.md); they are frozen now. A platform without a
 * recorded set fails rather than passing untested.
 *
 * The agent is `target/release/whiphand-agent`
 * (`cargo build --release -p whiphand-agent`), or `WHIPHAND_PARITY_AGENT`.
 * `PARITY_RECORD=1` rewrites the transcripts instead of comparing; review the
 * diff, since a recorded change is a change in behavior. CI uploads what a
 * failing run produced (`PARITY_DUMP`), which is how the Windows set is kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from './agent-transcript.ts';
import { SCENARIOS } from './agent-corpus.ts';
import { agentCommand } from './agent-command.ts';

/**
 * Windows answers differently in substance (cmd.exe command lines, the
 * session hooks' commands, ConPTY's terminal output), so it has its own set.
 */
const FIXTURES = fileURLToPath(new URL(`./fixtures/agent/${process.platform === 'win32' ? 'win32' : 'posix'}`, import.meta.url));
const PROTOCOL = fileURLToPath(new URL('../apps/desktop/src/shared/protocol.gen.ts', import.meta.url));
const RECORD = process.env.PARITY_RECORD === '1';

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

/** Every method `protocol.gen.ts` (generated from whiphand-protocol) lists. */
function protocolMethods(): string[] {
  const text = readFileSync(PROTOCOL, 'utf8');
  const body = /export interface MethodMap \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? '';
  return [...body.matchAll(/^\s*(\w+): \{/gm)].map(m => m[1]!);
}

const fixtureFile = (name: string): string => path.join(FIXTURES, `${name.replace(/[^a-z0-9]+/gi, '-')}.json`);

test('agent regression: the scenarios call every method', () => {
  const methods = protocolMethods();
  assert.equal(methods.length, 41);
  const called = new Set(SCENARIOS.flatMap(s => s.steps.flatMap(step => ('call' in step ? [step.call] : []))));
  assert.deepEqual(methods.filter(m => !called.has(m)), []);
});

for (const scenario of SCENARIOS) {
  test(`agent regression: ${scenario.name}`, { timeout: 120_000 }, async () => {
    const command = agentCommand();
    assert.ok(existsSync(command[0]), `build the agent first: cargo build --release -p whiphand-agent (${command[0]})`);
    const root = mkdtempSync(path.join(tmpdir(), 'whiphand-agent-parity-'));
    try {
      const got = await runScenario(scenario, command, path.join(root, 's'));
      const file = fixtureFile(scenario.name);
      if (RECORD) {
        mkdirSync(FIXTURES, { recursive: true });
        writeFileSync(file, `${JSON.stringify(got, null, 2)}\n`);
        return;
      }
      assert.ok(existsSync(file), `no recorded transcript; record one with PARITY_RECORD=1 (${file})`);
      const want = JSON.parse(readFileSync(file, 'utf8')) as typeof got;
      // PARITY_DUMP=<dir> keeps what this run produced, for a diff tool.
      const dump = process.env.PARITY_DUMP;
      if (dump) {
        mkdirSync(dump, { recursive: true });
        writeFileSync(path.join(dump, path.basename(file)), `${JSON.stringify(got, null, 2)}\n`);
      }
      assert.deepEqual(got.responses, want.responses, 'responses');
      assert.deepEqual(got.notifications, want.notifications, 'notifications');
      assert.deepEqual(got.terminals, want.terminals, 'terminal output');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
