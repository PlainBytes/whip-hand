import { useEffect, useState } from 'react';
import {
  Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Field, MessageBar, MessageBarBody, Radio, RadioGroup, Spinner, Text,
} from '@fluentui/react-components';
import { useNarrowDialogStyles } from '../lib/use-narrow-dialog-styles.ts';
import { useAgentClient } from '../agent/agent-context.tsx';
import type { Scope } from '../shared/types.ts';
import type { ShippedWorkflowEntry, ShippedWorkflowStatus } from '../shared/protocol.gen.ts';
import { errorMessage } from '../lib/error-message.ts';

export interface RestoreWorkflowsDialogProps {
  workdir: string;
  /** The scope picked when the dialog opens. */
  defaultScope: Scope;
  onRestored: () => void;
  onDismiss: () => void;
}

const SCOPE_LABEL: Record<Scope, string> = {
  project: "Project (this repo's .whiphand)",
  workspace: 'Workspace (my user folder)',
  global: 'Global (every workspace)',
};

const STATUS_BADGE: Record<ShippedWorkflowStatus, { label: string; color: 'danger' | 'success' | 'warning' }> = {
  missing: { label: 'Missing', color: 'danger' },
  stock: { label: 'Up to date', color: 'success' },
  modified: { label: 'Modified', color: 'warning' },
};

/** Missing ones are ticked, up-to-date and modified ones are not. */
function defaultTicks(entries: ShippedWorkflowEntry[]): Set<string> {
  return new Set(entries.filter(e => e.status === 'missing').map(e => e.name));
}

/**
 * Brings back the starter workflows whiphand ships: writes the missing ones
 * into the chosen scope and, only when ticked, resets edited ones to stock.
 * Mounted only while open (a closed-but-mounted Fluent Dialog is still a live
 * Modalizer), which is also what resets the scope and ticks for the next open.
 *
 * Replacing a modified file throws away the user's edits, so a Restore that
 * would replace anything first switches the dialog to a confirmation naming
 * those workflows; nothing is sent until it is accepted.
 */
export function RestoreWorkflowsDialog({ workdir, defaultScope, onRestored, onDismiss }: RestoreWorkflowsDialogProps) {
  const narrowDialog = useNarrowDialogStyles();
  const client = useAgentClient();
  const [scope, setScope] = useState<Scope>(defaultScope);
  /** null while the list for `scope` is loading. */
  const [entries, setEntries] = useState<ShippedWorkflowEntry[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setTicked(new Set());
    setError(null);
    client
      .request('listShippedWorkflows', { workdir, scope })
      .then(result => {
        if (cancelled) return;
        setEntries(result.workflows);
        setTicked(defaultTicks(result.workflows));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEntries([]);
        setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, workdir, scope]);

  const toReplace = (entries ?? []).filter(e => e.status === 'modified' && ticked.has(e.name)).map(e => e.name);
  const names = (entries ?? []).filter(e => ticked.has(e.name)).map(e => e.name);

  function toggle(name: string, on: boolean): void {
    setTicked(prev => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  async function restore(): Promise<void> {
    if (toReplace.length > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.request('restoreWorkflows', { workdir, scope, names, replace: toReplace });
      onRestored();
    } catch (err) {
      // Back to the list, so the error sits next to what was asked for.
      setConfirming(false);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const quoted = toReplace.map(n => `'${n}'`).join(', ');

  const confirmation = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="restore-confirmation">
      <Text>{`Your changes to ${quoted} will be lost: ${toReplace.length === 1 ? 'it is' : 'they are'} replaced with the starter version.`}</Text>
      {scope === 'global' && (
        <Text>Global workflows are read by every workspace on this machine, so all of them will run the starter version.</Text>
      )}
    </div>
  );

  let list;
  if (entries === null) {
    list = <Spinner size="tiny" label="Loading starter workflows…" />;
  } else if (entries.length === 0) {
    list = error ? null : <Text>No starter workflows to restore.</Text>;
  } else {
    list = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} role="group" aria-label="Starter workflows">
        {entries.map(entry => {
          const badge = STATUS_BADGE[entry.status];
          const isTicked = ticked.has(entry.name);
          return (
            <div key={entry.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 4, minWidth: 0 }}>
              <Checkbox
                checked={isTicked}
                disabled={entry.status === 'stock' || busy}
                onChange={(_e, data) => toggle(entry.name, data.checked === true)}
                aria-label={entry.name}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, paddingTop: 6 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                  <Text weight="semibold" style={{ overflowWrap: 'anywhere' }}>{entry.name}</Text>
                  <Badge appearance="tint" color={badge.color}>{badge.label}</Badge>
                  {entry.status === 'modified' && isTicked && (
                    <Badge appearance="filled" color="danger">Will be replaced</Badge>
                  )}
                </div>
                {entry.description && (
                  <Text size={200} style={{ overflowWrap: 'anywhere' }}>{entry.description}</Text>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(_event, data) => {
        // A restoreWorkflows already issued can't be un-issued.
        if (!data.open && !busy) onDismiss();
      }}
    >
      <DialogSurface style={narrowDialog.surface}>
        <DialogBody>
          <DialogTitle>{confirming ? 'Replace modified workflows?' : 'Restore built-in workflows'}</DialogTitle>
          <DialogContent>
            {confirming ? confirmation : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Field label="Restore into">
                  <RadioGroup value={scope} onChange={(_e, data) => setScope(data.value as Scope)} disabled={busy}>
                    {(['project', 'workspace', 'global'] as const).map(s => (
                      <Radio key={s} value={s} label={SCOPE_LABEL[s]} />
                    ))}
                  </RadioGroup>
                </Field>
                {scope === 'global' && (
                  <Text size={200}>Global workflows are read by every workspace on this machine.</Text>
                )}
                {list}
                {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
              </div>
            )}
          </DialogContent>
          <DialogActions style={narrowDialog.actions}>
            {confirming ? (
              <>
                <Button
                  appearance="primary"
                  disabled={busy}
                  icon={busy ? <Spinner size="tiny" /> : undefined}
                  onClick={() => void restore()}
                >
                  {busy ? 'Restoring…' : 'Replace and restore'}
                </Button>
                <Button disabled={busy} onClick={() => setConfirming(false)}>Back</Button>
              </>
            ) : (
              <>
                <Button
                  appearance="primary"
                  disabled={busy || entries === null || names.length === 0}
                  icon={busy ? <Spinner size="tiny" /> : undefined}
                  onClick={() => void restore()}
                >
                  {busy ? 'Restoring…' : 'Restore'}
                </Button>
                <Button disabled={busy} onClick={onDismiss}>Cancel</Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
