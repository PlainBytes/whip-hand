import { useEffect, useState } from 'react';
import {
  Checkbox, Dropdown, Field, Input, MessageBar, MessageBarBody, Option, SpinButton, Text,
} from '@fluentui/react-components';
import { useAgentClient } from '../agent/agent-context.tsx';
import { Page } from '../components/Page.tsx';
import { RemoteAccessCard } from '../components/RemoteAccessCard.tsx';
import { useAppStore } from '../state/store.ts';
import { spinInteger } from '../lib/spin-value.ts';
import type { ConfigGetResult, EditorPreference } from '../shared/protocol.gen.ts';
import { errorMessage } from '../lib/error-message.ts';
import { CUSTOM_EDITOR, DEFAULT_EDITOR, EDITOR_OPTIONS } from '../lib/editor.ts';

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

/** Seeded when the checkbox first turns on from "no limit". */
const DEFAULT_OVERRIDE_MAX_RETAINED = 10;

/**
 * App-level preferences: settings that belong to Whiphand itself
 * rather than to any workspace, and so stay reachable with none open.
 *
 * The retention control reads and writes the *global* config layer's
 * `runs.max_retained` (via configGet/configSet, scope: 'global') rather than
 * app-state's old `runsRetention` field — that field is retired as a source
 * of truth (kept in the app-state schema, but unread) now that a real global
 * config layer exists to hold it instead. `configGet` with no `workdir`
 * fetches exactly this layer, which is why this page can populate itself
 * with no workspace open.
 */
export function PreferencesPage() {
  const client = useAgentClient();
  const themePref = useAppStore(state => state.appState?.theme ?? 'system');
  const showOngoingRuns = useAppStore(state => state.appState?.showOngoingRuns ?? true);
  const editorPref = useAppStore(state => state.appState?.editor ?? DEFAULT_EDITOR);
  const patchAppState = useAppStore(state => state.patchAppState);
  const workspacePath = useAppStore(state => state.workspacePath);

  const [globalConfig, setGlobalConfig] = useState<ConfigGetResult | null>(null);
  // Picking "Custom command…" reveals the input before any command is saved.
  const [customChosen, setCustomChosen] = useState(false);
  const storedCommand = editorPref.kind === 'custom' ? editorPref.command : '';
  const [commandDraft, setCommandDraft] = useState(storedCommand);
  const [retentionError, setRetentionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.request('configGet', {})
      .then(result => {
        if (!cancelled) setGlobalConfig(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setRetentionError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const showCustom = customChosen || editorPref.kind === 'custom';
  const editorValue = showCustom ? CUSTOM_EDITOR : editorPref.kind;

  function saveEditor(editor: EditorPreference): void {
    patchAppState({ editor });
    void client.request('setUiState', { editor }).catch(() => {});
  }

  function commitCommand(): void {
    const command = commandDraft.trim();
    if (!command) return;
    setCommandDraft(command);
    if (command === storedCommand) return;
    saveEditor({ kind: 'custom', command });
  }

  const maxRetained = globalConfig?.config.runs.max_retained ?? null;

  async function setMaxRetained(next: number | null): Promise<void> {
    if (!globalConfig) return;
    setRetentionError(null);
    const nextConfig = {
      ...globalConfig.config,
      runs: { ...globalConfig.config.runs, max_retained: next },
    };
    try {
      await client.request('configSet', { config: nextConfig, scope: 'global' });
      setGlobalConfig(prev => (prev ? { ...prev, config: nextConfig } : prev));
      // Only the currently open workspace can be pruned right now — this is a
      // global default, so it can't reach into workspaces that aren't open. A
      // workspace whose own project layer sets runs.max_retained at all (even
      // to null, deliberately keeping everything) has its own opinion and is
      // unaffected.
      //
      // The project layer is fetched here rather than read off the store:
      // `state.config` is populated only by WorkspaceSettingsPage and cleared
      // on every workspace switch, so from this page it is usually null — and
      // `null?.project?.…` is `undefined`, which reads as "inherits" and would
      // prune a workspace that had explicitly opted out. Pruning deletes runs
      // irreversibly, so a failed lookup must skip it rather than guess.
      if (workspacePath && next !== null && next > 0) {
        void client.request('configGet', { workdir: workspacePath })
          .then(ws => {
            if (ws.project?.config.runs?.max_retained !== undefined) return;
            return client.request('pruneRuns', { workdir: workspacePath, max: next });
          })
          .catch(() => {});
      }
    } catch (err) {
      setRetentionError(errorMessage(err));
    }
  }

  return (
    <Page header={<Text weight="semibold" size={500}>Preferences</Text>}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
      <Checkbox
        label="Show ongoing runs in the sidebar"
        checked={showOngoingRuns}
        onChange={(_e, data) => {
          const next = Boolean(data.checked);
          patchAppState({ showOngoingRuns: next });
          void client.request('setUiState', { showOngoingRuns: next }).catch(() => {});
        }}
      />

      <Field label="Theme">
        <Dropdown
          aria-label="Theme"
          value={THEME_OPTIONS.find(o => o.value === themePref)?.label ?? 'System'}
          selectedOptions={[themePref]}
          onOptionSelect={(_e, data) => {
            const theme = data.optionValue as 'system' | 'light' | 'dark' | undefined;
            if (!theme) return;
            patchAppState({ theme });
            void client.request('setUiState', { theme }).catch(() => {});
          }}
        >
          {THEME_OPTIONS.map(o => (
            <Option key={o.value} value={o.value} text={o.label}>
              {o.label}
            </Option>
          ))}
        </Dropdown>
      </Field>

      <Field label="Editor">
        <Dropdown
          aria-label="Editor"
          value={EDITOR_OPTIONS.find(o => o.value === editorValue)?.label ?? 'Visual Studio Code'}
          selectedOptions={[editorValue]}
          onOptionSelect={(_e, data) => {
            const kind = data.optionValue;
            if (!kind) return;
            if (kind === CUSTOM_EDITOR) {
              setCustomChosen(true);
              return;
            }
            setCustomChosen(false);
            saveEditor({ kind } as EditorPreference);
          }}
        >
          {EDITOR_OPTIONS.map(o => (
            <Option key={o.value} value={o.value} text={o.label}>
              {o.label}
            </Option>
          ))}
        </Dropdown>
      </Field>
      {showCustom && (
        <Field label="Editor command" hint="One executable name or path, no arguments. The folder is passed as its only argument.">
          <Input
            value={commandDraft}
            onChange={(_e, data) => setCommandDraft(data.value)}
            onBlur={commitCommand}
            onKeyDown={e => {
              if (e.key === 'Enter') commitCommand();
            }}
          />
        </Field>
      )}

      <Field
        label="Maximum runs kept"
        hint="Global default, shared by every workspace on this machine. Applies to any workspace that doesn't set its own override."
      >
        <Checkbox
          label="Limit runs kept"
          checked={maxRetained !== null}
          disabled={!globalConfig}
          onChange={(_e, data) => void setMaxRetained(data.checked ? DEFAULT_OVERRIDE_MAX_RETAINED : null)}
        />
        {maxRetained !== null && (
          <SpinButton
            aria-label="Maximum runs kept per workspace"
            min={1}
            value={maxRetained}
            onChange={(_e, data) => {
              const next = spinInteger(data, { min: 1 });
              if (next !== undefined) void setMaxRetained(next);
            }}
          />
        )}
      </Field>
      {retentionError && <MessageBar intent="error"><MessageBarBody>{retentionError}</MessageBarBody></MessageBar>}

      <RemoteAccessCard />
    </div>
    </Page>
  );
}
