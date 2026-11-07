import { useEffect, useRef, useState } from 'react';
import {
  Button, Field, Input, MessageBar, MessageBarBody, Text,
} from '@fluentui/react-components';
import { useAgentClient } from '../agent/agent-context.tsx';
import { errorMessage } from '../lib/error-message.ts';
import { DangerButton } from './DangerButton.tsx';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function nameProblem(name: string): string | undefined {
  if (name === '' || NAME.test(name)) return undefined;
  return "Use letters, digits and '_', not starting with a digit.";
}

/**
 * The workspace's secrets, which a workflow's MCP servers reference as `${NAME}`. Saves on
 * its own, apart from the settings form above it. The agent only ever answers with names, so
 * a value exists here just while it is being typed.
 */
export function WorkspaceSecretsSection({ workdir }: { workdir: string }) {
  const client = useAgentClient();
  const [names, setNames] = useState<string[] | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const valueInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setNames(null);
    setError(null);
    setUnavailable(false);
    client.request('listSecrets', { workdir })
      .then(result => {
        if (cancelled) return;
        setNames(result.names);
        setPath(result.path);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A browser on the LAN isn't served these methods at all.
        if (/method not found/i.test(errorMessage(err))) setUnavailable(true);
        else setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, workdir]);

  async function run(action: () => Promise<{ names: string[]; path: string }>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setNames(result.names);
      setPath(result.path);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    const saved = await run(() => client.request('setSecret', { workdir, name, value }));
    // On failure the value stays, so a retry doesn't mean pasting it again.
    if (saved) {
      setName('');
      setValue('');
    }
  }

  async function remove(target: string): Promise<void> {
    setConfirmingDelete(null);
    await run(() => client.request('deleteSecret', { workdir, name: target }));
  }

  const problem = nameProblem(name);
  const replacing = names?.includes(name) ?? false;

  return (
    <section
      aria-label="Secrets"
      data-testid="workspace-secrets"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480, marginTop: 24 }}
    >
      <Text weight="semibold" size={400}>Secrets</Text>
      <Text size={200}>
        Values for workflow MCP servers. In a server&apos;s env or headers, write <code>{'${NAME}'}</code>; runs in
        this workspace fill it in, and neither the workflow file nor the run keeps the value.
      </Text>
      {unavailable && (
        <MessageBar intent="info">
          <MessageBarBody>Secrets are managed from the desktop app on the host machine.</MessageBarBody>
        </MessageBar>
      )}
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {names !== null && (
        <>
          {names.length === 0 && (
            <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>No secrets yet.</Text>
          )}
          {names.map(secret => (
            <div key={secret} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <code style={{ flex: 1, overflowWrap: 'anywhere' }}>{secret}</code>
              {confirmingDelete === secret ? (
                <>
                  <DangerButton
                    size="small"
                    aria-label={`Confirm delete ${secret}`}
                    disabled={busy}
                    onClick={() => void remove(secret)}
                  >
                    Delete
                  </DangerButton>
                  <Button size="small" appearance="subtle" onClick={() => setConfirmingDelete(null)}>Keep</Button>
                </>
              ) : (
                <>
                  <Button
                    size="small"
                    appearance="subtle"
                    aria-label={`Replace ${secret}`}
                    onClick={() => {
                      setName(secret);
                      setValue('');
                      valueInput.current?.focus();
                    }}
                  >
                    Replace
                  </Button>
                  <DangerButton
                    size="small"
                    variant="subtle"
                    appearance="subtle"
                    aria-label={`Delete ${secret}`}
                    onClick={() => setConfirmingDelete(secret)}
                  >
                    Delete
                  </DangerButton>
                </>
              )}
            </div>
          ))}
          <Field label="Name" validationMessage={problem} validationState={problem ? 'error' : 'none'}>
            <Input value={name} placeholder="API_TOKEN" onChange={(_e, data) => setName(data.value.trim())} />
          </Field>
          <Field label="Value">
            <Input
              ref={valueInput}
              type="password"
              autoComplete="new-password"
              value={value}
              onChange={(_e, data) => setValue(data.value)}
            />
          </Field>
          <Button
            appearance="secondary"
            disabled={busy || name === '' || value === '' || problem !== undefined}
            onClick={() => void save()}
            style={{ alignSelf: 'flex-start' }}
          >
            {replacing ? 'Replace secret' : 'Add secret'}
          </Button>
          <Text size={200} style={{ color: 'var(--colorNeutralForeground3)', overflowWrap: 'anywhere' }}>
            Kept outside the repository in {path}, readable by your user account but not encrypted. Agents running as
            you could read it.
          </Text>
        </>
      )}
    </section>
  );
}
