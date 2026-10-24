/**
 * Every warning bar in the app goes through this — a warning the reader has
 * already taken in should not keep costing them screen space.
 *
 * Dismissal lasts "until it changes": `dismissKey` names this occurrence, and
 * a different key shows the bar again. Call sites render the bar only while
 * its condition holds, so a condition that clears and recurs remounts it with
 * fresh state and it comes back too. `persist` is for static notes that would
 * otherwise reappear on every visit — those remember the dismissal across
 * restarts in localStorage.
 *
 * Errors deliberately do not get this: they report something that went wrong
 * and stays wrong, and hiding one leaves the reader with no explanation.
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  Button, MessageBar, MessageBarActions, MessageBarBody, type MessageBarProps,
} from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';

const STORAGE_PREFIX = 'whiphand.dismissed.';

function readPersisted(key: string): boolean {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key) === 'true';
  } catch {
    return false;
  }
}

function writePersisted(key: string): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, 'true');
  } catch {
    // Storage unavailable or full: the dismissal just lasts this session.
  }
}

type Props = Omit<MessageBarProps, 'intent' | 'children'> & {
  dismissKey: string;
  persist?: boolean;
  /** Extra buttons, rendered beside the dismiss button. */
  actions?: ReactNode;
  /** Optional hook for callers that hold their own dismissed state. */
  onDismiss?: () => void;
  children: ReactNode;
  'data-testid'?: string;
};

export function DismissibleWarning({ dismissKey, persist = false, actions, onDismiss, children, ...rest }: Props) {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const persisted = useMemo(() => persist && readPersisted(dismissKey), [persist, dismissKey]);

  if (persisted || dismissedKey === dismissKey) return null;

  const dismiss = (): void => {
    if (persist) writePersisted(dismissKey);
    setDismissedKey(dismissKey);
    onDismiss?.();
  };

  return (
    <MessageBar intent="warning" {...rest}>
      <MessageBarBody>{children}</MessageBarBody>
      <MessageBarActions
        containerAction={
          <Button appearance="transparent" aria-label="Dismiss" icon={<Dismiss20Regular />} onClick={dismiss} />
        }
      >
        {actions}
      </MessageBarActions>
    </MessageBar>
  );
}
