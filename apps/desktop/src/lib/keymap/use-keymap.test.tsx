import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AgentClient } from '../../agent/client.ts';
import { MockTransport } from '../../agent/transport.ts';
import { useAppStore } from '../../state/store.ts';
import { EMPTY_APP_STATE } from '../../test/app-state.ts';
import { setKeybindings, useKeymap } from './use-keymap.ts';

describe('useKeymap', () => {
  afterEach(() => useAppStore.setState({ appState: null }));

  it('is the defaults before app-state loads, then follows the overrides', () => {
    const { result } = renderHook(() => useKeymap());
    expect(result.current.get('tabs.close')).toBe('Mod+Alt+KeyW');
    act(() => useAppStore.setState({ appState: { ...EMPTY_APP_STATE, keybindings: { 'tabs.close': 'Mod+KeyQ', 'tabs.newRun': null } } }));
    expect(result.current.get('tabs.close')).toBe('Mod+KeyQ');
    expect(result.current.get('tabs.newRun')).toBeNull();
  });
});

describe('setKeybindings', () => {
  afterEach(() => useAppStore.setState({ appState: null }));

  it('patches the store and sends the whole map in setUiState', () => {
    useAppStore.setState({ appState: { ...EMPTY_APP_STATE } });
    const transport = new MockTransport();
    setKeybindings(new AgentClient(transport), { 'tabs.close': 'Mod+KeyQ', 'tabs.newRun': null });
    expect(useAppStore.getState().appState?.keybindings).toEqual({ 'tabs.close': 'Mod+KeyQ', 'tabs.newRun': null });
    expect(transport.sentRequest(0)).toMatchObject({
      method: 'setUiState',
      params: { keybindings: { 'tabs.close': 'Mod+KeyQ', 'tabs.newRun': null } },
    });
  });
});
