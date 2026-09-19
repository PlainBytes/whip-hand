/**
 * Persistence for remote access: whether it is on, which port, and the shared
 * token.
 *
 * This is deliberately NOT part of app-state.json. app-state.ts's header
 * promises it is "a CONVENIENCE CACHE, never a source of truth" whose deletion
 * "must lose zero work", and its loader silently discards the whole file on a
 * schemaVersion mismatch. A credential whose loss unpairs every device does not
 * belong under that contract. Keeping it separate also means:
 *   - it can be written 0600, where app-state is 0644;
 *   - the token never appears in a getAppState result, and therefore never in
 *     a log line or a devtools snapshot of app state.
 *
 * Failure is CLOSED. An unreadable or unparseable file yields defaults with
 * enabled:false — the one thing this file must never do is fail open and leave
 * a port listening with a token nobody knows.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '@whiphand/core';
import { generateToken } from './auth.ts';

/** 61337 is the Vite dev server (see apps/desktop/vite.config.ts), so: the next one. */
export const DEFAULT_REMOTE_PORT = 61338;

export const remoteAccessConfigSchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535),
  token: z.string().min(32),
});
export type RemoteAccessConfig = z.infer<typeof remoteAccessConfigSchema>;

/** Sibling of resolveAppStatePath(); see app-state.ts for why the directory is chosen this way. */
export function resolveRemoteConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.WHIPHAND_REMOTE_CONFIG_FILE) return env.WHIPHAND_REMOTE_CONFIG_FILE;
  const dir =
    platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
    : (env.XDG_DATA_HOME ?? join(home, '.local', 'share'));
  return join(dir, 'whiphand', 'remote-access.json');
}

export function defaultRemoteConfig(): RemoteAccessConfig {
  return { schemaVersion: 1, enabled: false, port: DEFAULT_REMOTE_PORT, token: generateToken() };
}

/**
 * Lazily-loaded, write-serialized JSON store, mirroring AppStateStore's
 * chaining so concurrent mutate() calls cannot interleave a stale
 * read-modify-write.
 */
export class RemoteAccessStore {
  readonly filePath: string;
  #config: RemoteAccessConfig | null = null;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async get(): Promise<RemoteAccessConfig> {
    const result = this.#chain.then(() => this.#load());
    this.#chain = result.catch(() => {});
    return result;
  }

  async mutate(fn: (c: RemoteAccessConfig) => RemoteAccessConfig): Promise<RemoteAccessConfig> {
    const result = this.#chain.then(async () => {
      const next = remoteAccessConfigSchema.parse(fn(await this.#load()));
      await this.#persist(next);
      this.#config = next;
      return next;
    });
    this.#chain = result.catch(() => {});
    return result;
  }

  async #load(): Promise<RemoteAccessConfig> {
    if (this.#config) return this.#config;
    try {
      const parsed = remoteAccessConfigSchema.safeParse(
        JSON.parse(await readFile(this.filePath, 'utf8')),
      );
      if (parsed.success) {
        this.#config = parsed.data;
      } else {
        // Loud, and off: a corrupt config must not leave a port open.
        console.error(
          `[whiphand-agent] remote access config at ${this.filePath} is invalid; ` +
          'remote access is disabled and a new token has been generated',
        );
        this.#config = defaultRemoteConfig();
      }
    } catch {
      this.#config = defaultRemoteConfig();
    }
    return this.#config;
  }

  async #persist(next: RemoteAccessConfig): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // The mode goes on the temp file because rename() preserves it; chmod-ing
    // after the rename would leave a window where the token is world-readable.
    // (Not enforceable on Windows, where fs modes only toggle read-only — doctor
    // says so; see remoteTokenModeNote.)
    await writeFileAtomic(this.filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }
}
