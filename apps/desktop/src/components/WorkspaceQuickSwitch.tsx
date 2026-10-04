import { useState } from 'react';
import {
  Button, Dialog, DialogBody, DialogContent, DialogSurface, DialogTitle, Input, Text,
} from '@fluentui/react-components';
import { PinFilled, PinRegular } from '@fluentui/react-icons';
import { useAppStore } from '../state/store.ts';
import { useAgentClient } from '../agent/agent-context.tsx';
import { openWorkspace } from '../lib/workspace-switch.ts';
import { basename, filterWorkspaces, sortWorkspaces } from '../lib/workspace-identity.ts';
import { WorkspaceDot } from './WorkspaceDot.tsx';
import type { RecentWorkspace } from '../shared/protocol.gen.ts';
import { errorMessage } from '../lib/error-message.ts';

const EMPTY_RECENTS: RecentWorkspace[] = [];

export interface WorkspaceQuickSwitchProps {
  onClose: () => void;
}

/** Type-to-filter workspace switcher, raised by Ctrl/Cmd+K. */
export function WorkspaceQuickSwitch({ onClose }: WorkspaceQuickSwitchProps) {
  const client = useAgentClient();
  const recents = useAppStore(state => state.appState?.recentWorkspaces ?? EMPTY_RECENTS);
  const patchAppState = useAppStore(state => state.patchAppState);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const matches = filterWorkspaces(sortWorkspaces(recents), query);
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));

  async function openAt(index: number): Promise<void> {
    const entry = matches[index];
    if (!entry) return;
    setError(null);
    try {
      // Returns false when the unsaved-edits guard was answered "keep
      // editing" — leave the dialog up rather than closing on a non-switch.
      if (await openWorkspace(client, entry.path)) onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function togglePin(entry: RecentWorkspace): Promise<void> {
    setError(null);
    try {
      const result = await client.request('setWorkspacePinned', {
        path: entry.path, pinned: !entry.pinned,
      });
      patchAppState({ recentWorkspaces: result.recentWorkspaces });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Dialog open onOpenChange={(_event, data) => { if (!data.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Switch workspace</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Input
                autoFocus
                aria-label="Filter workspaces"
                placeholder="Type to filter…"
                value={query}
                onChange={(_e, data) => { setQuery(data.value); setActive(0); }}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setActive(i => Math.min(i + 1, matches.length - 1));
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setActive(i => Math.max(i - 1, 0));
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    void openAt(activeIndex);
                  }
                }}
              />
              {error && (
                <Text size={200} style={{ color: 'var(--colorPaletteRedForeground1)' }}>{error}</Text>
              )}
              {matches.length === 0 ? (
                <Text>No workspace matches “{query}”.</Text>
              ) : (
                <div role="listbox" aria-label="Workspaces" style={{ display: 'flex', flexDirection: 'column' }}>
                  {matches.map((entry, index) => (
                    <div
                      key={entry.path}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        borderRadius: 4,
                        background: index === activeIndex ? 'var(--colorNeutralBackground2)' : undefined,
                      }}
                    >
                      <Button
                        appearance="subtle"
                        role="option"
                        aria-selected={index === activeIndex}
                        onClick={() => void openAt(index)}
                        style={{ flex: 1, justifyContent: 'flex-start', minWidth: 0 }}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <WorkspaceDot path={entry.path} identityKey={entry.identityKey} />
                          <Text weight="semibold">{basename(entry.path)}</Text>
                          <Text size={100} truncate wrap={false} style={{ color: 'var(--colorNeutralForeground3)' }}>
                            {entry.path}
                          </Text>
                        </span>
                      </Button>
                      <Button
                        appearance="transparent"
                        aria-label={entry.pinned ? `Unpin ${basename(entry.path)}` : `Pin ${basename(entry.path)}`}
                        icon={entry.pinned ? <PinFilled /> : <PinRegular />}
                        onClick={event => {
                          // Pinning is a list edit, not a navigation — never
                          // let it open the workspace it is pinning.
                          event.stopPropagation();
                          void togglePin(entry);
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
