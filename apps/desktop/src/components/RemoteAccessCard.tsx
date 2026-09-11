import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import {
  Button, Field, MessageBar, MessageBarBody, MessageBarTitle, Spinner, SpinButton, Switch, Text,
} from '@fluentui/react-components';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import type { RemoteAccessGetResult } from '../../../../packages/agent/src/protocol.ts';

// Only pulled in once the user actually turns remote access on, so the QR
// renderer stays out of the initial bundle for everyone who never does.
const QRCodeSVG = lazy(async () => ({ default: (await import('qrcode.react')).QRCodeSVG }));

/** The shareable link. The token rides in the fragment — see remote/server.ts. */
function remoteUrl(address: string, port: number, token: string): string {
  return `http://${address}:${port}/#t=${token}`;
}

/**
 * Turns the remote channel on and off, and shows what to point a browser at.
 *
 * Lives on Preferences rather than in a page of its own because it is exactly
 * what that page is for: something belonging to Whiphand itself rather
 * than to any workspace, reachable with none open.
 *
 * The token comes from remoteAccessGet (a desktop-only method) and never from
 * the remoteAccessChanged notification, which deliberately omits it. So live
 * updates refresh everything EXCEPT the token, and the token is re-read only
 * when this card acts.
 */
export function RemoteAccessCard() {
  const client = useAgentClient();
  const live = useAppStore(state => state.remoteAccess);
  const [state, setState] = useState<RemoteAccessGetResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await client.request('remoteAccessGet', {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // The notification carries everything but the token, so merge rather than
  // replace: overwriting would blank the token the user is reading.
  const view = state && live ? { ...state, ...live } : state;

  async function act(fn: () => Promise<RemoteAccessGetResult>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setState(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!view) {
    return <Field label="Remote access"><Spinner size="tiny" label="Loading…" /></Field>;
  }

  const url = view.token && view.addresses[0]
    ? remoteUrl(view.addresses[0], view.port, view.token)
    : null;

  return (
    <Field
      label="Remote access"
      hint="Open Whiphand in a browser on another computer on this network."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Switch
          label={view.listening ? 'On' : 'Off'}
          checked={view.enabled}
          disabled={busy}
          onChange={(_e, data) => void act(() => client.request('remoteAccessSet', { enabled: data.checked }))}
        />

        {view.enabled && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Anyone with this link can run commands on this computer.</MessageBarTitle>
              {' '}The connection is unencrypted, so use it only on a network you trust.
            </MessageBarBody>
          </MessageBar>
        )}

        {view.error && (
          <MessageBar intent="error"><MessageBarBody>{view.error}</MessageBarBody></MessageBar>
        )}

        {view.enabled && !view.webRootPresent && (
          <MessageBar intent="warning">
            <MessageBarBody>
              The browser interface has not been built, so the address below will not load a page.
              Run <code>npm run build:web -w desktop</code>.
            </MessageBarBody>
          </MessageBar>
        )}

        {view.listening && url && (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <Suspense fallback={<Spinner size="tiny" />}>
                <div style={{ background: '#fff', padding: 8, borderRadius: 4, lineHeight: 0 }}>
                  <QRCodeSVG value={url} size={180} />
                </div>
              </Suspense>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
                {view.addresses.map(address => (
                  <div key={address} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Text font="monospace">{`${address}:${view.port}`}</Text>
                    <Button
                      size="small"
                      appearance="subtle"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(remoteUrl(address, view.port, view.token ?? ''))
                          .catch(() => {});
                      }}
                    >
                      Copy link
                    </Button>
                  </div>
                ))}
                <Text size={200}>
                  {view.clientCount === 1 ? '1 device connected' : `${view.clientCount} devices connected`}
                </Text>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button size="small" appearance="subtle" onClick={() => setRevealed(r => !r)}>
                {revealed ? 'Hide token' : 'Show token'}
              </Button>
              {revealed && (
                <Text font="monospace" size={200} style={{ wordBreak: 'break-all' }}>{view.token}</Text>
              )}
            </div>

            {confirmingRotate ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  Rotating disconnects every device using the current link. Continue?
                  <Button
                    size="small"
                    style={{ marginLeft: 8 }}
                    disabled={busy}
                    onClick={() => {
                      setConfirmingRotate(false);
                      void act(() => client.request('remoteAccessRotateToken', {}));
                    }}
                  >
                    Rotate
                  </Button>
                  <Button size="small" appearance="subtle" onClick={() => setConfirmingRotate(false)}>
                    Cancel
                  </Button>
                </MessageBarBody>
              </MessageBar>
            ) : (
              <Button size="small" appearance="subtle" onClick={() => setConfirmingRotate(true)}>
                Rotate token
              </Button>
            )}
          </>
        )}

        <Field label="Port" hint="Takes effect immediately; the link changes with it.">
          <SpinButton
            aria-label="Remote access port"
            min={1024}
            max={65535}
            value={view.port}
            disabled={busy}
            onChange={(_e, data) => {
              const next = data.value ?? (data.displayValue ? Number(data.displayValue) : undefined);
              if (typeof next !== 'number' || !Number.isFinite(next) || next < 1024 || next > 65535) return;
              if (next === view.port) return;
              void act(() => client.request('remoteAccessSet', { port: next }));
            }}
          />
        </Field>

        {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      </div>
    </Field>
  );
}
