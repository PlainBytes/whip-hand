import { useEffect } from 'react';
import { Badge, Button, Card, CardHeader, Text } from '@fluentui/react-components';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useCapabilities } from '../capabilities.tsx';
import { OpenPathField } from '../components/OpenPathField.tsx';
import { useAppStore } from '../state/store.ts';
import { openWorkspace } from '../lib/workspace-switch.ts';
import { basename } from '../lib/workspace-identity.ts';
import type { RecentWorkspace } from '../shared/protocol.gen.ts';

// Stable reference so the zustand selector below doesn't produce a fresh
// array on every render when appState is null — an inline `?? []` fallback
// there breaks React's referential-equality check and loops forever (see
// App.tsx's EMPTY_RECENTS for the same fix applied there first).
const EMPTY_RECENTS: RecentWorkspace[] = [];

/**
 * First screen when no workspace is open (F3): recent workspaces as cards,
 * browse, and runner health — instead of five tabs of "choose a workspace"
 * placeholders.
 */
export function WelcomePage() {
  const client = useAgentClient();
  const { pickDirectory } = useCapabilities();
  const recents = useAppStore(state => state.appState?.recentWorkspaces ?? EMPTY_RECENTS);
  const doctorResult = useAppStore(state => state.doctorResult);
  const setDoctorResult = useAppStore(state => state.setDoctorResult);

  useEffect(() => {
    if (doctorResult !== null) return;
    client.request('doctor', {}).then(setDoctorResult).catch(() => {});
  }, [client, doctorResult, setDoctorResult]);

  async function browse(): Promise<void> {
    if (!pickDirectory) return;
    const selected = await pickDirectory();
    if (selected) await openWorkspace(client, selected).catch(() => {});
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 560, margin: '48px auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {/*
          * Decorative: the heading beside it already names the product, so a
          * repeated alt would just be read out twice.
          */}
        <img src="/logo.png" alt="" width={64} height={64} style={{ flexShrink: 0 }} />
        <div>
          <Text size={600} weight="semibold">Welcome to Whiphand</Text>
          <br />
          <Text>Open a workspace to run workflows against it.</Text>
        </div>
      </div>

      {recents.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Text weight="semibold">Recent workspaces</Text>
          {recents.map(r => (
            <Card key={r.path} onClick={() => void openWorkspace(client, r.path).catch(() => {})}>
              <CardHeader
                header={<Button appearance="transparent">{basename(r.path)}</Button>}
                description={<Text size={200}>{r.path}</Text>}
              />
            </Card>
          ))}
        </div>
      )}

      {/* No native picker in a browser: type the path instead of offering a
          button that cannot open anything. */}
      {pickDirectory ? (
        <Button appearance="primary" onClick={() => void browse()}>
          Open workspace…
        </Button>
      ) : (
        <OpenPathField
          onOpen={path => void openWorkspace(client, path).catch(() => {})}
          label="Open workspace"
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Text weight="semibold">Runners</Text>
        {/* Runners, not every tool doctor reports — the Doctor page is where
            support tools and undrivable harnesses belong. */}
        {(doctorResult ?? []).filter(r => r.runner).map(r => (
          <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Text>{r.label}</Text>
            {r.installed
              ? <Badge color="success" appearance="tint">{r.version ?? 'installed'}</Badge>
              : <Badge color="danger" appearance="tint">not installed</Badge>}
          </div>
        ))}
      </div>
    </div>
  );
}
