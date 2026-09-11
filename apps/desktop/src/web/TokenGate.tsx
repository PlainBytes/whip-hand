import { useState } from 'react';
import {
  Button, Field, Input, MessageBar, MessageBarBody, Spinner, Text,
} from '@fluentui/react-components';

/**
 * Stands between the page loading and the app mounting.
 *
 * It exists so an authentication failure is a distinct, actionable screen
 * rather than an endless reconnect spinner: AgentClient's job is to survive a
 * flaky network by retrying, which is exactly the wrong response to a token
 * that will never be accepted again. Validating with GET /api/ping up front
 * separates the two, and is why AgentClient itself needed no changes at all.
 */
export function TokenGate(
  { onToken, checking, error }: {
    onToken: (token: string) => void;
    checking: boolean;
    error: string | null;
  },
) {
  const [value, setValue] = useState('');

  if (checking) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spinner label="Connecting…" />
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', padding: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: 'min(420px, 100%)' }}>
        <div>
          <Text size={600} weight="semibold">Whiphand</Text>
          <br />
          <Text>This device needs an access token to connect.</Text>
        </div>

        {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}

        <Field
          label="Access token"
          hint="Preferences → Remote access on the host computer shows the token and a QR code."
        >
          <Input
            value={value}
            type="password"
            autoFocus
            onChange={(_e, data) => setValue(data.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && value.trim()) onToken(value.trim());
            }}
          />
        </Field>

        <Button appearance="primary" disabled={!value.trim()} onClick={() => onToken(value.trim())}>
          Connect
        </Button>
      </div>
    </div>
  );
}
