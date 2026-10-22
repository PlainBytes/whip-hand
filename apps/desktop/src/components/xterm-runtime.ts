import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';

/**
 * Thin factory around `@xterm/xterm` + its addons, kept in its own
 * module so TerminalPanel.tsx never imports xterm directly: jsdom can't do
 * real canvas rendering, so TerminalPanel's tests mock this module boundary
 * (`vi.mock('./xterm-runtime.ts')`) instead of fighting xterm's DOM/canvas
 * requirements. xterm-runtime.test.ts covers this module's own wiring (the
 * options and addons that make xterm agree with a real pty's output), with
 * fixed options chosen to read well embedded in either Fluent light or dark
 * surroundings.
 *
 * Fidelity to a real pty (ConPTY especially) rests on two choices: no
 * `convertEol` (the pty's own line discipline already maps LF; forcing CR LF
 * breaks LF-as-"down, same column"), and the Unicode 11 width table, which
 * matches ConPTY and Claude for glyphs like ⏺, spinner frames and emoji.
 */
export interface TerminalHandle {
  term: Terminal;
  fitAddon: FitAddon;
}

// A dark terminal surface regardless of the app's Fluent theme — the
// conventional choice (matches VS Code's integrated terminal, which stays
// dark in a light IDE theme too) and it avoids needing two xterm themes kept
// in sync with Fluent's design tokens.
export const TERMINAL_BACKGROUND = '#1e1e1e';

const TERMINAL_THEME = {
  background: TERMINAL_BACKGROUND,
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  selectionBackground: '#264f78',
};

export function createTerminal(initial: { cols?: number; rows?: number }): TerminalHandle {
  const term = new Terminal({
    cols: initial.cols,
    rows: initial.rows,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    theme: TERMINAL_THEME,
    // Required by the Unicode11 addon's `term.unicode` API.
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  return { term, fitAddon };
}
