/**
 * Resolves node-pty from a real directory on disk, rather than importing it
 * statically.
 *
 * node-pty's Windows implementation spawns a worker thread from a file path
 * (`lib/windowsConoutConnection.js`) and `fork()`s a helper script on the kill
 * path (`lib/windowsPtyAgent.js`) — both need `__dirname` to point at a real,
 * on-disk `node-pty` package. Inside a single executable neither is true:
 * `__dirname` is the directory of `process.execPath`, and a SEA ignores an
 * argv script and re-runs its own embedded main instead of the forked one.
 * `module.createRequire()` sidesteps this entirely by giving back a real,
 * disk-backed `require` — so node-pty resolves its own assets exactly as it
 * expects, on both platforms.
 *
 * Three ways to find the directory, tried in order:
 *  1. `WHIPHAND_NODE_PTY_DIR` — an explicit override. Packaging and the packaging
 *     smoke tests set this to the assembled resource tree / the repo's
 *     `node_modules/node-pty`.
 *  2. `WHIPHAND_NODE_PTY_DIR_DEFAULT` — an esbuild `define`, the same shape as the
 *     desktop build's `__AGENT_ENTRY_PATH__`, baked in at packaging time.
 *  3. Plain module resolution from this file's own location. Taken when
 *     neither of the above is set, which is every unbundled run — `node
 *     --test`, `tauri dev`'s `node <agent entry>` — where node-pty is just
 *     another dependency in `node_modules` and needs no help finding itself.
 *     This is what makes dev and the unit suite keep working exactly as
 *     before this file existed.
 */
import { createRequire } from 'node:module';

declare const WHIPHAND_NODE_PTY_DIR_DEFAULT: string | undefined;

// esbuild replaces this identifier with a string literal at bundle time; an
// unbundled run never defines it, so the reference has to be guarded rather
// than read directly (typeof on an undeclared identifier is safe; reading it
// bare would throw ReferenceError).
const buildTimeDefault = typeof WHIPHAND_NODE_PTY_DIR_DEFAULT === 'undefined' ? undefined : WHIPHAND_NODE_PTY_DIR_DEFAULT;

/** The subset of node-pty's `IPty` that pty.ts actually uses. */
export interface NativePty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface NodePtyModule {
  /**
   * `args` as a string is node-pty's Windows-only command-line mode: it quotes
   * `file` and appends the string verbatim, instead of building the command
   * line from an array. pty.ts needs that to hand cmd.exe a line it built
   * itself; unixTerminal throws on it, which is why the caller gates on the
   * same win32 branch `resolveExecutable` does.
   */
  spawn(file: string, args: string[] | string, options: Record<string, unknown>): NativePty;
}

let cached: NodePtyModule | undefined;

export function resolveNodePty(): NodePtyModule {
  if (!cached) {
    const dir = process.env.WHIPHAND_NODE_PTY_DIR ?? buildTimeDefault;
    // createRequire needs a filename to resolve relative to. `import.meta.url`
    // is only real in an unbundled ESM run (dev, `node --test`) — esbuild's
    // `format: 'cjs'` bundle (every packaged build) leaves it undefined, which
    // is exactly the case `dir` covers. `${dir}/package.json` is a plain
    // string anchor that works either way, and always exists — the one file
    // node-pty-resource.mjs and a real `npm install` both guarantee.
    const requireFn = dir ? createRequire(`${dir}/package.json`) : createRequire(import.meta.url);
    // `require('node-pty')` is a bare specifier: Node resolves it by walking
    // `node_modules` directories upward from the anchor, and never treats the
    // anchor's own directory as the package. `dir` *is* the node-pty package
    // directory (not a `node_modules` containing it), so requiring the bare
    // specifier only happens to work when `dir` sits inside a `node_modules`
    // — which the assembled resource tree never does. `requireFn(dir)`
    // resolves `dir`'s own `package.json#main`/`exports` directly instead.
    // The no-`dir` branch keeps the bare specifier: there, the anchor's own
    // node_modules chain is where node-pty actually lives.
    cached = (dir ? requireFn(dir) : requireFn('node-pty')) as NodePtyModule;
  }
  return cached;
}
