import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { KeyboardShortcutsSection } from './KeyboardShortcutsSection.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { ACTIONS } from '../lib/keymap/actions.ts';
import { useShortcut } from '../lib/use-global-shortcut.ts';
import { useAppStore } from '../state/store.ts';
import { EMPTY_APP_STATE } from '../test/app-state.ts';
import type { KeymapOverrides } from '../lib/keymap/keymap.ts';

let transport: MockTransport;

function Probe({ onFire }: { onFire: () => void }) {
  useShortcut('workspace.quickSwitch', onFire);
  return null;
}

function setup(keybindings: KeymapOverrides = {}, onQuickSwitch = () => {}) {
  useAppStore.setState({ appState: { ...EMPTY_APP_STATE, keybindings } });
  transport = new MockTransport();
  render(
    <AgentClientProvider client={new AgentClient(transport)}>
      <Probe onFire={onQuickSwitch} />
      <KeyboardShortcutsSection />
    </AgentClientProvider>,
  );
}

function row(id: string) {
  return within(screen.getByTestId(`shortcut-${id}`));
}

function lastKeybindings() {
  const sent = transport.sent.map((_, i) => transport.sentRequest(i)).filter(r => r.method === 'setUiState');
  return (sent.at(-1)?.params as { keybindings: KeymapOverrides }).keybindings;
}

function record(id: string, label: string, init: KeyboardEventInit) {
  fireEvent.click(row(id).getByRole('button', { name: `Record shortcut for ${label}` }));
  fireEvent.keyDown(window, init);
}

describe('KeyboardShortcutsSection', () => {
  afterEach(() => useAppStore.setState({ appState: null }));

  it('lists every catalogue action under group headings', () => {
    setup();
    for (const action of ACTIONS) expect(row(action.id).getByText(action.label)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Tabs' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Files' })).toBeTruthy();
    expect(screen.getByText(/Ctrl\+W and Ctrl\+T/)).toBeTruthy();
  });

  it('records a chord, saves only the override and marks the row changed', () => {
    setup();
    expect(row('tabs.close').queryByText('changed')).toBeNull();
    record('tabs.close', 'Close tab', { key: 'W', code: 'KeyW', ctrlKey: true, shiftKey: true });
    expect(lastKeybindings()).toEqual({ 'tabs.close': 'Mod+Shift+KeyW' });
    expect(row('tabs.close').getByText('Ctrl+Shift+W')).toBeTruthy();
    expect(row('tabs.close').getByText('changed')).toBeTruthy();
  });

  it('fires the shortcut when not recording', () => {
    let fired = 0;
    setup({}, () => { fired += 1; });
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(fired).toBe(1);
  });

  it('records a bound chord instead of firing its shortcut', () => {
    let fired = 0;
    setup({}, () => { fired += 1; });
    record('tabs.newRun', 'New run', { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(fired).toBe(0);
    expect(lastKeybindings()).toEqual({ 'tabs.newRun': 'Mod+KeyK', 'workspace.quickSwitch': null });
  });

  it('moves a chord from the action that had it and names that action', () => {
    setup();
    record('tabs.close', 'Close tab', { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true });
    expect(lastKeybindings()).toEqual({ 'tabs.close': 'Mod+Alt+KeyN', 'tabs.newRun': null });
    expect(screen.getByText('Removed from New run')).toBeTruthy();
    expect(row('tabs.newRun').getByText('Unbound')).toBeTruthy();
  });

  it('rejects a plain letter and a bare modifier, saving nothing', () => {
    setup();
    record('tabs.close', 'Close tab', { key: 'a', code: 'KeyA' });
    expect(screen.getByText(/needs Ctrl, Alt or Cmd/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    expect(transport.sent).toHaveLength(0);
  });

  it('accepts F5 without a modifier', () => {
    setup();
    record('tabs.close', 'Close tab', { key: 'F5', code: 'F5' });
    expect(lastKeybindings()).toEqual({ 'tabs.close': 'F5' });
  });

  it('leaves the binding unchanged on Escape', () => {
    setup();
    record('tabs.close', 'Close tab', { key: 'Escape', code: 'Escape' });
    expect(transport.sent).toHaveLength(0);
    expect(row('tabs.close').queryByText('Press keys…')).toBeNull();
    expect(row('tabs.close').getByText('Record')).toBeTruthy();
  });

  it('treats Ctrl+Tab and Mod+Tab as one chord on non-mac', () => {
    setup();
    record('tabs.newRun', 'New run', { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(lastKeybindings()).toEqual({ 'tabs.newRun': 'Mod+Tab', 'tabs.nextInWorkspace': null });
    expect(screen.getByText(/Removed from Next tab in this workspace/)).toBeTruthy();
  });

  it('removes the key when Ctrl+Tab is recorded back onto its Ctrl+Tab default', () => {
    setup({ 'tabs.nextInWorkspace': 'Mod+KeyQ' });
    record('tabs.nextInWorkspace', 'Next tab in this workspace', { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(lastKeybindings()).toEqual({});
  });

  it('removes the key when the recorded chord is the default', () => {
    setup({ 'tabs.close': 'Mod+KeyQ' });
    record('tabs.close', 'Close tab', { key: 'w', code: 'KeyW', ctrlKey: true, altKey: true });
    expect(lastKeybindings()).toEqual({});
  });

  it('unbinds with null, resets by removing the key, and resets all', () => {
    setup({ 'tabs.newRun': 'Mod+KeyQ' });
    fireEvent.click(row('tabs.close').getByRole('button', { name: 'Unbind Close tab' }));
    expect(lastKeybindings()).toEqual({ 'tabs.newRun': 'Mod+KeyQ', 'tabs.close': null });
    fireEvent.click(row('tabs.close').getByRole('button', { name: 'Reset Close tab' }));
    expect(lastKeybindings()).toEqual({ 'tabs.newRun': 'Mod+KeyQ' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset all shortcuts' }));
    expect(lastKeybindings()).toEqual({});
  });
});
