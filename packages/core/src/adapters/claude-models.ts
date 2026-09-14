/**
 * Claude's own model list, live-probed through its control protocol and
 * merged with a static alias fallback. Wired into `claudeAdapter.listModels`
 * (claude.ts) — kept in its own module because the probe needs to talk to a
 * live child process rather than run one `--version` and read its exit code,
 * which is everything else in this package's adapters do.
 */
import { tmpdir } from 'node:os';
import type { ModelInfo, ModelList } from '../types.ts';
import { isRecord, parseJsonRecord } from '../engine/progress.ts';
import { spawnRunner } from '../exec.ts';
import { PROBE_TIMEOUT_MS } from '../tools.ts';

/**
 * Aliases `claude --model` accepts that the live probe does not itself name
 * (see this file's header comment on `parseInitializeReply`): bare `opus`
 * (the probe only ever offers `opus[1m]`), `fable`, and `opusplan`, plus
 * `default`, `sonnet` and `haiku` again so the list is usable even when the
 * live probe fails outright. Also what `packages/core/src/scaffold.ts`'s
 * built-in workflow templates use — merging them in is what keeps a stock
 * workflow's `model: opus` from ever showing as a typo.
 */
const STATIC_ALIASES: readonly ModelInfo[] = [
  { id: 'default' },
  { id: 'opus' },
  { id: 'sonnet' },
  { id: 'haiku' },
  { id: 'fable' },
  { id: 'opusplan' },
];

const FALLBACK: ModelList = {
  source: 'fallback',
  models: STATIC_ALIASES.slice(),
  note: "couldn't query claude; showing built-in aliases",
};

const REQUEST_ID = 'req_1';

function initializeRequestLine(): string {
  return `${JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize' } })}\n`;
}

/**
 * One NDJSON line -> the models claude's `initialize` control_response
 * carries, or null when this line is not a usable answer to our request (a
 * different line entirely, a mismatched request_id, or a reply with no
 * `models` array). Never reads `.account` off the reply, even though it is
 * right there beside `.models` — account details have no reason to leave this
 * process, and the whole point of probing live is the model list, not who is
 * logged in.
 */
export function parseInitializeReply(line: string): ModelInfo[] | null {
  const parsed = parseJsonRecord(line);
  if (parsed === null || parsed.type !== 'control_response') return null;
  const response = parsed.response;
  if (!isRecord(response) || response.request_id !== REQUEST_ID) return null;
  const inner = response.response;
  if (!isRecord(inner) || !Array.isArray(inner.models)) return null;

  const models: ModelInfo[] = [];
  for (const raw of inner.models) {
    if (!isRecord(raw) || typeof raw.value !== 'string') continue;
    const info: ModelInfo = { id: raw.value };
    if (typeof raw.displayName === 'string') info.label = raw.displayName;
    if (typeof raw.description === 'string') info.description = raw.description;
    if (typeof raw.resolvedModel === 'string') info.resolves = raw.resolvedModel;
    models.push(info);
  }
  return models;
}

/** Live entries win: an alias also present live (e.g. `sonnet`) keeps the live entry's label/description. */
export function mergeWithAliases(live: ModelInfo[]): ModelInfo[] {
  const seen = new Set(live.map(m => m.id));
  return [...live, ...STATIC_ALIASES.filter(alias => !seen.has(alias.id))];
}

export interface ProbeClaudeModelsOptions {
  /** Overridable only for tests exercising the hang/timeout path without a real 5s wait. */
  timeoutMs?: number;
}

/**
 * Spawns `claude` with no workspace and asks it one `initialize` control
 * request, reading NDJSON off stdout until the matching `control_response`
 * arrives. Never rejects: every failure path (spawn error, non-zero exit,
 * malformed or missing `models`, or the timeout) resolves to the
 * static-alias `FALLBACK` instead.
 *
 * `CLAUDE_CODE_SAFE_MODE=1` is load-bearing, not a nicety: without it this
 * probe would fire the user's own SessionStart hooks on every editor mount.
 * `cwd` is the OS temp dir, not a workspace — the probe answers "what models
 * does this account have", which has nothing to do with whichever workspace
 * happens to be open, and running it there would be a lie anyway (it is
 * prefetched before any workspace-specific step exists).
 */
export function probeClaudeModels(opts: ProbeClaudeModelsOptions = {}): Promise<ModelList> {
  return new Promise<ModelList>(resolvePromise => {
    let child: ReturnType<typeof spawnRunner>;
    try {
      child = spawnRunner(
        [
          'claude', '-p', '--no-session-persistence',
          '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        ],
        {
          cwd: tmpdir(),
          env: { ...process.env, CLAUDE_CODE_SAFE_MODE: '1' },
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      );
    } catch {
      resolvePromise(FALLBACK);
      return;
    }

    let settled = false;
    let buffer = '';

    const finish = (result: ModelList): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners('error');
      child.removeAllListeners('close');
      child.stdout?.removeAllListeners('data');
      child.kill();
      resolvePromise(result);
    };

    const timer = setTimeout(() => finish(FALLBACK), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.on('error', () => finish(FALLBACK));
    // 'close', not 'exit': Node's docs warn stdio can still be open when
    // 'exit' fires, and claude's own stdout write can still be in flight
    // right after it replies (stdin is ended immediately after the request,
    // so it exits soon after answering) — 'close' waits for the stdio
    // streams to finish, so a reply already on the wire is never lost to the
    // fallback because the process happened to exit first.
    child.on('close', () => finish(FALLBACK));

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (line.trim() === '') continue;
        const models = parseInitializeReply(line);
        if (models !== null) {
          finish({ source: 'live', models: mergeWithAliases(models) });
          return;
        }
      }
    });

    child.stdin?.write(initializeRequestLine());
    child.stdin?.end();
  });
}
