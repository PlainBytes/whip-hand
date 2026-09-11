import { useEffect, useState } from 'react';
import {
  Checkbox, Dropdown, Field, MessageBar, MessageBarBody, Option, SpinButton,
} from '@fluentui/react-components';
import { useAgentClient } from '../agent/agent-context.tsx';
import { RemoteAccessCard } from '../components/RemoteAccessCard.tsx';
import { useAppStore } from '../state/store.ts';
import type { ConfigGetResult } from '../../../../packages/agent/src/protocol.ts';

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
  const patchAppState = useAppStore(state => state.patchAppState);
  const workspacePath = useAppStore(state => state.workspacePath);

  const [globalConfig, setGlobalConfig] = useState<ConfigGetResult | null>(null);
  const [retentionError, setRetentionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.request('configGet', {})
      .then(result => {
        if (!cancelled) setGlobalConfig(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setRetentionError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

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
      setRetentionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
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
              const next = data.value ?? (data.displayValue ? Number(data.displayValue) : undefined);
              if (typeof next === 'number' && Number.isFinite(next) && next >= 1) void setMaxRetained(next);
            }}
          />
        )}
      </Field>
      {retentionError && <MessageBar intent="error"><MessageBarBody>{retentionError}</MessageBarBody></MessageBar>}

      <RemoteAccessCard />
    </div>
  );
}
