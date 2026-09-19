import { useState } from 'react';
import {
  Button, Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger, Text,
} from '@fluentui/react-components';
import {
  ChevronUpDownRegular, FolderOpenRegular, PinOffRegular, PinRegular,
} from '@fluentui/react-icons';
import { useAppStore } from '../state/store.ts';
import { sameWorkspace } from '../../../../packages/core/src/path-form.ts';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useCapabilities } from '../capabilities.tsx';
import { OpenPathField } from './OpenPathField.tsx';
import { openWorkspace } from '../lib/workspace-switch.ts';
import { basename, sortWorkspaces } from '../lib/workspace-identity.ts';
import { WorkspaceDot } from './WorkspaceDot.tsx';
import { RowGlyph, RowTrailing, SIDEBAR_ROW_STYLE } from './sidebar-row.tsx';
import type { RecentWorkspace } from '../../../../packages/agent/src/app-state.ts';
import { errorMessage } from '../lib/error-message.ts';

// Stable reference so the zustand selector doesn't produce a fresh array on
// every render when appState is null — an inline `?? []` fallback there
// breaks React's referential-equality check and loops forever.
const EMPTY_RECENTS: RecentWorkspace[] = [];

/**
 * The sidebar's header: which workspace everything below it acts on, and
 * how to change it. Errors surface inline rather than being swallowed — a
 * pinned workspace survives the agent's prune while its drive is unmounted,
 * so "I clicked it and nothing happened" is a reachable state.
 */
export function WorkspaceSwitcher() {
  const client = useAgentClient();
  const { pickDirectory } = useCapabilities();
  const workspacePath = useAppStore(state => state.workspacePath);
  const identityKey = useAppStore(state => state.workspaceIdentityKey);
  const recents = useAppStore(state => state.appState?.recentWorkspaces ?? EMPTY_RECENTS);
  const patchAppState = useAppStore(state => state.patchAppState);
  const [error, setError] = useState<string | null>(null);
  const [promptingPath, setPromptingPath] = useState(false);

  const sorted = sortWorkspaces(recents);
  const current = workspacePath === null
    ? undefined
    : recents.find(r => sameWorkspace(r, { path: workspacePath, identityKey: identityKey ?? undefined }));

  async function switchTo(path: string): Promise<void> {
    setError(null);
    try {
      await openWorkspace(client, path);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function browse(): Promise<void> {
    if (!pickDirectory) return;
    const selected = await pickDirectory();
    if (selected) await switchTo(selected);
  }

  async function setPinned(path: string, pinned: boolean): Promise<void> {
    setError(null);
    try {
      const result = await client.request('setWorkspacePinned', { path, pinned });
      patchAppState({ recentWorkspaces: result.recentWorkspaces });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button
            appearance="subtle"
            style={SIDEBAR_ROW_STYLE}
          >
            {/* flex-start, not center: with the two-line name+path block, that
                puts the dot on the name's optical centre instead of floating
                between the two lines. */}
            <span style={{ display: 'flex', alignItems: 'flex-start', minWidth: 0, width: '100%' }}>
              <RowGlyph>
                {workspacePath && <WorkspaceDot path={workspacePath} identityKey={identityKey ?? current?.identityKey} />}
              </RowGlyph>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <Text weight="semibold" truncate wrap={false}>
                  {workspacePath ? basename(workspacePath) : 'Open workspace…'}
                </Text>
                {workspacePath && (
                  <Text size={100} truncate wrap={false} style={{ color: 'var(--colorNeutralForeground3)' }}>
                    {workspacePath}
                  </Text>
                )}
              </span>
              <RowTrailing>
                <ChevronUpDownRegular />
              </RowTrailing>
            </span>
          </Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {sorted.map(r => (
              <MenuItem
                key={r.path}
                icon={<WorkspaceDot path={r.path} identityKey={r.identityKey} />}
                secondaryContent={r.pinned ? 'Pinned' : undefined}
                onClick={() => void switchTo(r.path)}
              >
                {basename(r.path)}
              </MenuItem>
            ))}
            {sorted.length > 0 && <MenuDivider />}
            {workspacePath && (
              <MenuItem
                icon={current?.pinned ? <PinOffRegular /> : <PinRegular />}
                onClick={() => void setPinned(workspacePath, !current?.pinned)}
              >
                {current?.pinned ? 'Unpin this workspace' : 'Pin this workspace'}
              </MenuItem>
            )}
            {pickDirectory ? (
              <MenuItem icon={<FolderOpenRegular />} onClick={() => void browse()}>Browse…</MenuItem>
            ) : (
              <MenuItem icon={<FolderOpenRegular />} onClick={() => setPromptingPath(true)}>
                Open path…
              </MenuItem>
            )}
          </MenuList>
        </MenuPopover>
      </Menu>
      {promptingPath && (
        <div style={{ padding: '4px 12px' }}>
          <OpenPathField
            onOpen={async path => {
              setPromptingPath(false);
              await switchTo(path);
            }}
          />
        </div>
      )}
      {error && (
        <Text size={100} style={{ color: 'var(--colorPaletteRedForeground1)', padding: '0 12px' }}>
          {error}
        </Text>
      )}
    </div>
  );
}
