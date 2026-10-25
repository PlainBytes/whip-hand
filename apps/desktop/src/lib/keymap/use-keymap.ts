import { useMemo } from 'react';
import { useAppStore } from '../../state/store.ts';
import type { AgentClient } from '../../agent/client.ts';
import { resolveKeymap, type Keymap, type KeymapOverrides } from './keymap.ts';

/** The effective keymap: defaults plus the overrides in app-state, live as they change. */
export function useKeymap(): Keymap {
  const keybindings = useAppStore(state => state.appState?.keybindings);
  return useMemo(() => resolveKeymap(keybindings ?? {}), [keybindings]);
}

/** Saves the whole override map: into the store now, to the agent in the background. */
export function setKeybindings(client: AgentClient, keybindings: KeymapOverrides): void {
  useAppStore.getState().patchAppState({ keybindings });
  void client.request('setUiState', { keybindings }).catch(() => {});
}
