/**
 * Plays an agent scenario over stdio and records what came back, for the
 * TS-vs-Rust agent gate (Phase 3 of docs/migration.md, parity/agent.test.ts).
 *
 * A scenario is a list of steps run one at a time: each request is sent only
 * once the previous one has been answered, because the TS agent serves
 * requests concurrently and pipelining would make the order a race. Every
 * response is recorded against its step. Notifications are recorded per
 * method, in arrival order: the order WITHIN a method is behavior (a run's
 * events, a terminal's output), while the interleaving of different methods
 * (an appStateChanged against a response) is a scheduling detail.
 *
 * A terminal's output is compared as the text it carried, not its chunking,
 * which belongs to the pty library.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeText } from './store-probe.ts';

export type Message = Record<string, any>;

export interface Ctx {
  /** The scenario's root: workspace, config home, app state, stubs. */
  root: string;
  ws: string;
  /** Values steps remember for later ones (a jobId, a runId). */
  vars: Record<string, any>;
  /** Every message so far. */
  messages: Message[];
}

type Params = unknown | ((ctx: Ctx) => unknown);

export type Step =
  | { call: string; params?: Params; label?: string; keep?: (result: any, ctx: Ctx) => void }
  /** A raw line; its response is the next one with a matching or null id. */
  | { raw: string; label?: string }
  /** Waits for a notification, which is recorded with the others. */
  | { until: (m: Message, ctx: Ctx) => boolean; label: string; timeoutMs?: number }
  | { act: (ctx: Ctx) => void | Promise<void>; label: string };

export interface Scenario {
  name: string;
  /** Files under the scenario root, written before the agent starts. */
  files?: Record<string, string>;
  /** Extra environment; `PATH` may name `<ROOT>` for stubs written above. */
  env?: (ctx: Ctx) => Record<string, string>;
  steps: Step[];
}

export interface Transcript {
  responses: Array<{ step: string; response: unknown }>;
  notifications: Record<string, unknown[]>;
  /** Each job's terminal text, decoded and joined. */
  terminals: Record<string, string>;
}

/** The environment every scenario runs in: nothing of the real machine's whiphand state. */
function baseEnv(ctx: Ctx): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('WHIPHAND_')) env[k] = v;
  }
  return {
    ...env,
    WHIPHAND_CONFIG_HOME: path.join(ctx.root, 'home'),
    WHIPHAND_APP_STATE_FILE: path.join(ctx.root, 'app-state.json'),
    WHIPHAND_REMOTE_CONFIG_FILE: path.join(ctx.root, 'remote-access.json'),
    WHIPHAND_WEB_ROOT: path.join(ctx.root, 'no-web-root'),
  };
}

const STEP_TIMEOUT_MS = 30_000;

/** Runs `scenario` against `[command, args]` in `root`, which it empties first. */
export async function runScenario(scenario: Scenario, command: [string, string[]], root: string): Promise<Transcript> {
  rmSync(root, { recursive: true, force: true });
  const ws = path.join(root, 'ws');
  mkdirSync(ws, { recursive: true });
  const ctx: Ctx = { root, ws, vars: {}, messages: [] };
  for (const [rel, body] of Object.entries(scenario.files ?? {})) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }

  const child = spawn(command[0], command[1], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: ws,
    env: { ...baseEnv(ctx), ...(scenario.env?.(ctx) ?? {}) },
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += String(d); });
  const waiters: Array<{ pred: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.trim()) return;
    const m = JSON.parse(line) as Message;
    ctx.messages.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(m)) waiters.splice(i, 1)[0]!.resolve(m);
    }
  });
  const waitFor = (pred: (m: Message) => boolean, label: string, timeoutMs = STEP_TIMEOUT_MS): Promise<Message> => {
    const seen = ctx.messages.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `${scenario.name}: timed out at '${label}'\nstderr:\n${stderr}\nlast messages:\n${
          ctx.messages.slice(-5).map(x => JSON.stringify(x).slice(0, 300)).join('\n')}`)), timeoutMs);
      waiters.push({ pred, resolve: m => { clearTimeout(timer); resolve(m); } });
    });
  };

  const responses: Transcript['responses'] = [];
  let nextId = 1;
  try {
    for (const step of scenario.steps) {
      if ('call' in step) {
        const id = nextId++;
        const params = typeof step.params === 'function' ? (step.params as (c: Ctx) => unknown)(ctx) : step.params;
        child.stdin.write(`${JSON.stringify({ id, method: step.call, ...(params === undefined ? {} : { params }) })}\n`);
        const res = await waitFor(m => m.id === id && !('method' in m), step.label ?? step.call);
        responses.push({ step: step.label ?? step.call, response: 'error' in res ? { error: res.error } : { result: res.result } });
        if ('result' in res) step.keep?.(res.result, ctx);
      } else if ('raw' in step) {
        const before = ctx.messages.length;
        child.stdin.write(`${step.raw}\n`);
        const res = await waitFor(m => ctx.messages.indexOf(m) >= before && 'error' in m, step.label ?? step.raw);
        responses.push({ step: step.label ?? step.raw, response: { id: res.id, error: res.error } });
      } else if ('until' in step) {
        await waitFor(m => 'method' in m && step.until(m, ctx), step.label, step.timeoutMs);
      } else {
        await step.act(ctx);
      }
    }
  } finally {
    child.stdin.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10_000);
      child.on('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  const notifications: Record<string, unknown[]> = {};
  const terminals: Record<string, string> = {};
  // Jobs are numbered by first output, so two terminals stay apart once ids are normalized.
  const jobs = new Map<string, string>();
  for (const m of ctx.messages) {
    if (!('method' in m)) continue;
    if (m.method === 'ptyData') {
      const id = String(m.params.jobId);
      if (!jobs.has(id)) jobs.set(id, `job${jobs.size + 1}`);
      const job = jobs.get(id)!;
      terminals[job] = (terminals[job] ?? '') + Buffer.from(m.params.data, 'base64').toString('utf8');
      continue;
    }
    (notifications[m.method] ??= []).push(m.params);
  }
  return normalize({ responses, notifications, terminals }, root);
}

const RUN_ENV_LINE = /^<TS> {2}\d+ {2}run:env {2}/;
const LOG_SEQ = /^<TS> {2}\d+ {2}/;

const isRunList = (v: unknown[]): boolean =>
  v.length > 1 && v.every(x => typeof x === 'object' && x !== null && 'runId' in x && 'runDir' in x);

const isRunEnv = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && (v as { event?: { type?: string } }).event?.type === 'run:env';

/**
 * `run:env` comes from a probe both engines fire and forget, and is emitted
 * at whichever event follows its answer: where it lands, and so every later
 * event's journal ordinal and run.log byte offset, is a race in both, and a
 * run that ends first drops it. It is compared by its distinct contents, on
 * its own; the other events by their order.
 */
function runEnvApart(t: Transcript): Transcript {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const out = v
        .filter(x => !isRunEnv(x) && !(typeof x === 'string' && RUN_ENV_LINE.test(x)))
        .map(x => (typeof x === 'string' ? x.replace(LOG_SEQ, '<TS>  #  ') : walk(x)));
      // Runs started in the same second order by their random id suffix.
      return isRunList(out) ? out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : out;
    }
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  const events = t.notifications.whiphandEvent ?? [];
  // Distinct contents only: a run that ends quickly (a cancel) drops a probe
  // that has not answered yet, so whether one is emitted at all is a race too.
  const runEnv = [...new Map(events.filter(isRunEnv).map(e => [JSON.stringify(e), e])).values()];
  const out = walk(t) as Transcript;
  if (runEnv.length > 0) out.notifications['whiphandEvent run:env'] = runEnv;
  return out;
}

const RUN_ID = /\b\d{8}-\d{6}-[0-9a-f]{4}\b/g;
const TOKEN = /"token":"[A-Za-z0-9_-]{43}"/g;
const BASE64_TOKEN_PROTOCOL = /whiphand\.token\.[A-Za-z0-9_-]+/g;
/** The JSON parser's own wording, like a YAML syntax error's (docs/migration.md, Phase 3). */
const PARSE_ERROR = /"parse error: [^"]*"/g;
/** The Rust engine has no Node to report (docs/migration.md, Phase 2). */
const NODE_VERSION = /"nodeVersion":"[^"]*"/g;
const NODE_IN_LOG = /, node [^,]*, /g;

/**
 * What legitimately differs between two runs: the root path (identical for
 * the two agents, but not across machines), timestamps, ids, pids, tokens,
 * mtimes, the LAN addresses, and the remote port.
 */
function normalize(t: Transcript, root: string): Transcript {
  const port = process.env.PARITY_REMOTE_PORT;
  const replacer = function (this: Record<string, unknown>, key: string, value: unknown): unknown {
    if (key === 'mtimeMs' || key === 'expectedMtimeMs' || key === 'heartbeatAt') return '<MS>';
    // An event's journal ordinal: see runEnvApart.
    if (key === 'seq' && 'event' in this) return undefined;
    if (key === 'startByte') return '<BYTE>';
    if (key === 'addresses' && Array.isArray(value)) return value.length === 0 ? [] : ['<ADDR>'];
    if (key === 'pid' && typeof value === 'number') return '<PID>';
    return value;
  };
  let text = normalizeText(JSON.stringify(t, replacer), root)
    .replace(RUN_ID, '<RUN>')
    .replace(TOKEN, '"token":"<TOKEN>"')
    .replace(BASE64_TOKEN_PROTOCOL, 'whiphand.token.<TOKEN>')
    .replace(PARSE_ERROR, '"parse error: <detail>"')
    .replace(NODE_VERSION, '"nodeVersion":"<NODE>"')
    .replace(NODE_IN_LOG, ', node <NODE>, ');
  if (port) text = text.split(`"port":${port}`).join('"port":"<PORT>"').split(`:${port}`).join(':<PORT>');
  const parsed = runEnvApart(JSON.parse(text) as Transcript);
  return parsed;
}
