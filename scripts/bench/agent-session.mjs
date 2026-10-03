/**
 * One live whiphand-agent over its stdio NDJSON protocol, for the bench: a
 * request() that correlates by id, and a notification tap. smoke.mjs's
 * request() is one-shot (spawn, ask, kill); the bench needs many requests
 * against one warm process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnRunner } from '../../packages/core/src/exec.ts';
import { streamNdjson, terminate } from '../package/smoke.mjs';

/**
 * Env that keeps the agent off the real user's state: app state, config and
 * remote-access config all live in `stateDir`. Without the last one an
 * enabled remote access on this machine would bind its LAN port.
 */
export function isolatedEnv(stateDir, extra = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    ...process.env,
    WHIPHAND_APP_STATE_FILE: path.join(stateDir, 'app-state.json'),
    WHIPHAND_CONFIG_HOME: path.join(stateDir, 'config'),
    WHIPHAND_REMOTE_CONFIG_FILE: path.join(stateDir, 'remote-access.json'),
    ...extra,
  };
}

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `whiphand-bench-${prefix}-`));
}

export class AgentSession {
  /** `argv` is the agent command line: `[node, main.ts]` or `[dist/whiphand-agent]`. */
  constructor(argv, env) {
    this.child = spawnRunner(argv, { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.stderr = '';
    this.child.stderr.on('data', chunk => {
      this.stderr += chunk;
      if (this.stderr.length > 64_000) this.stderr = this.stderr.slice(-32_000);
    });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.exited.then(() => {
      for (const { reject } of this.pending.values()) reject(new Error(`agent exited; stderr: ${this.stderr}`));
      this.pending.clear();
    });
    streamNdjson(this.child, message => {
      if ('id' in message && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}`));
        else resolve(message.result);
      } else if ('method' in message) {
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  get pid() {
    return this.child.pid;
  }

  request(method, params = {}, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms; stderr: ${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Resolves with the first notification `predicate` accepts. */
  waitFor(predicate, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`notification not seen within ${timeoutMs}ms; stderr: ${this.stderr}`));
      }, timeoutMs);
      const listener = message => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message);
      };
      this.listeners.add(listener);
    });
  }

  async stop() {
    this.child.stdin.end();
    const graceful = await Promise.race([this.exited.then(() => true), new Promise(resolve => setTimeout(resolve, 3_000, false))]);
    if (!graceful) await terminate(this.child);
  }
}
