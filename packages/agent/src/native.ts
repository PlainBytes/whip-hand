/**
 * Resolves node-pty from a real directory on disk, rather than importing it
 * statically: its Windows implementation needs `__dirname` to point at an
 * on-disk package, which a single-executable build cannot give it directly.
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
  readonly pid: number;
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
