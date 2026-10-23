import { beforeEach, describe, expect, it, vi } from 'vitest';

const terminalOptions: Array<Record<string, unknown>> = [];
const loadedAddons: unknown[] = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    unicode = { activeVersion: '6' };
    constructor(options: Record<string, unknown>) {
      terminalOptions.push(options);
    }
    loadAddon(addon: unknown) {
      loadedAddons.push(addon);
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class FitAddon {} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class Unicode11Addon {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { createTerminal } from './xterm-runtime.ts';

describe('createTerminal', () => {
  beforeEach(() => {
    terminalOptions.length = 0;
    loadedAddons.length = 0;
  });

  it('does not convert EOL: the pty already owns line discipline', () => {
    createTerminal({ cols: 80, rows: 24 });
    expect(terminalOptions[0]).not.toHaveProperty('convertEol');
  });

  it('allows the proposed API the unicode addon needs', () => {
    createTerminal({});
    expect(terminalOptions[0]?.allowProposedApi).toBe(true);
  });

  it('passes the initial size through', () => {
    createTerminal({ cols: 100, rows: 30 });
    expect(terminalOptions[0]).toMatchObject({ cols: 100, rows: 30 });
  });

  it('loads the fit and unicode11 addons and activates Unicode 11 widths', () => {
    const { term, fitAddon } = createTerminal({});
    expect(fitAddon).toBeInstanceOf(FitAddon);
    expect(loadedAddons.some((a) => a instanceof FitAddon)).toBe(true);
    expect(loadedAddons.some((a) => a instanceof Unicode11Addon)).toBe(true);
    expect(term.unicode.activeVersion).toBe('11');
  });
});
