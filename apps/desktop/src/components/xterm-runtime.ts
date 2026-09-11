import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * Thin factory around `@xterm/xterm` + `@xterm/addon-fit`, kept in its own
 * module so TerminalPanel.tsx never imports xterm directly: jsdom can't do
 * real canvas rendering, so TerminalPanel's tests mock this module boundary
 * (`vi.mock('./xterm-runtime.ts')`) instead of fighting xterm's DOM/canvas
 * requirements. Nothing here needs its own tests — it's a direct pass-through
 * to the library, with fixed options chosen to read well embedded in either
 * Fluent light or dark surroundings.
 */
export interface TerminalHandle {
  term: Terminal;
  fitAddon: FitAddon;
}

// A dark terminal surface regardless of the app's Fluent theme — the
// conventional choice (matches VS Code's integrated terminal, which stays
// dark in a light IDE theme too) and it avoids needing two xterm themes kept
// in sync with Fluent's design tokens.
const TERMINAL_THEME = {
  background: '#1e1e1e',
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
    convertEol: true,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  return { term, fitAddon };
}
