#!/usr/bin/env node
/**
 * Entry point: an NDJSON RPC server over stdio. stdout carries protocol
 * traffic only (responses and notifications) — every other message, in
 * particular all logging, goes to stderr.
 */
import { createInterface } from 'node:readline';
import { methods } from './protocol.ts';
import { createDispatcher } from './rpc.ts';
import { createHandlers } from './handlers.ts';
import { JobManager } from './jobs.ts';
import { migrateLegacyStateDirs } from '@whiphand/core';
import { AppStateStore, resolveAppStatePath } from './app-state.ts';
import { migrateRunsRetention } from './config-migration.ts';
import { createNotifyHub } from './notify-hub.ts';
import { createScrollback } from './scrollback.ts';
import { createPtySizes } from './pty-sizes.ts';
import { RemoteAccessStore, resolveRemoteConfigPath } from './remote/config.ts';
import { createRemoteController } from './remote/controller.ts';
import { createRemoteServer } from './remote/server.ts';
import { REMOTE_METHODS, pickRemoteHandlers } from './remote/methods.ts';
import { resolveWebRoot } from './remote/web-root.ts';

function writeLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Every notification goes through the hub, which fans it out to stdio (the
 * desktop) and, when remote access is on, to every connected browser. Nothing
 * downstream of here knows how many clients there are.
 *
 * The scrollback is wired in as the hub's TAP, so recording a pty chunk and
 * stamping its `seq` happen in one place — see notify-hub.ts for why that
 * matters.
 */
const scrollback = createScrollback();
const hub = createNotifyHub((method, params) => scrollback.record(method, params));
hub.addSink((method, params) => writeLine({ method, params }));
const notify = hub.notify;

const jobs = new JobManager();

/**
 * Startup, in an async function rather than at the top level: this file is
 * bundled to CommonJS for the sidecar binary, and CommonJS has no top-level
 * await. The ordering below is the same one the await always enforced, now
 * stated structurally.
 */
async function main(): Promise<void> {
  // Strictly before anything resolves a state path: the rename has to land
  // while the resolvers are still unread, or we would open the new location,
  // find it empty, and write a fresh file next to the one we were about to
  // move. Never throws — see migrateLegacyStateDirs.
  await migrateLegacyStateDirs();

  const appState = new AppStateStore(resolveAppStatePath(), state => notify('appStateChanged', state));
  // Awaited before the dispatcher exists and stdin starts being read, so a
  // configGet/configSet racing this at startup is impossible rather than a
  // millisecond-wide window: readline can't hand us a line to dispatch before
  // this resolves.
  await migrateRunsRetention(appState).catch(err => console.error('[whiphand-agent] retention migration failed:', err));

  // The graph here is circular by nature: handlers need the controller, the
  // remote dispatcher needs those handlers, and the server needs that
  // dispatcher. Built in that order, with useServer() closing the loop.
  const remote = createRemoteController({
    store: new RemoteAccessStore(resolveRemoteConfigPath()),
    webRoot: () => resolveWebRoot(),
    notify,
  });
  const ptySizes = createPtySizes();
  const handlers = createHandlers({ jobs, notify, appState, remote, scrollback, ptySizes });
  const dispatcher = createDispatcher(methods, handlers, notify);
  // A SECOND dispatcher over the filtered method partition is the whole
  // enforcement mechanism for what a browser may call — see remote/methods.ts.
  const remoteHandlers = pickRemoteHandlers(handlers);
  const server = createRemoteServer({
    // One dispatcher per connection, over the same filtered partition, so
    // ctx.clientId can tell two simultaneous clients apart.
    makeDispatcher: clientId => createDispatcher(REMOTE_METHODS, remoteHandlers, notify, clientId),
    webRoot: () => resolveWebRoot(),
    onStatusChange: () => remote.publishState(),
    onClientGone: clientId => ptySizes.forget(clientId),
  });
  remote.useServer(server);
  remoteControl = remote;
  hub.addSink(server.broadcast);
  // Off unless the user explicitly enabled it in a previous session. A failure
  // here is reported through remoteAccessGet, never fatal.
  await remote.applyConfig().catch(err =>
    console.error('[whiphand-agent] remote access could not be applied:', err));

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    dispatcher.handleLine(trimmed)
      .then(response => process.stdout.write(`${response}\n`))
      .catch(err => console.error('[whiphand-agent] dispatcher failure:', err));
  });

  rl.on('close', () => {
    void shutdown(0);
  });
}

/** How long a shutdown waits for in-flight runs to write their terminal state. */
const SHUTDOWN_GRACE_MS = 3_000;

let shuttingDown = false;

/** Set once main() has built it, so shutdown can close the listening socket. */
let remoteControl: { stop: () => Promise<void> } | undefined;

/**
 * Aborts every in-flight run and gives it a moment to finish writing run.json
 * before we go. Without this, a plain `kill` leaves each run's manifest at
 * 'running' and readers have to fall back to interrupted-detection to work out
 * what happened. This cannot help the desktop's exit path — tauri-plugin-shell
 * SIGKILLs its children on RunEvent::Exit, and nothing survives that — so
 * interrupted-detection in core remains the backstop, not this.
 */
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await remoteControl?.stop().catch(() => {});
  const live = jobs.list().filter(job => job.status === 'running');
  for (const job of live) job.controller.abort();
  if (live.length > 0) {
    await Promise.race([
      Promise.allSettled(live.map(job => job.promise)),
      new Promise(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
    ]);
  }
  process.exit(code);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(0);
  });
}

process.on('uncaughtException', err => {
  console.error('[whiphand-agent] uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', err => {
  console.error('[whiphand-agent] unhandled rejection:', err);
  process.exit(1);
});

void main();
