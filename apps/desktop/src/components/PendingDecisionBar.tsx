/**
 * What the run page shows while a decision is parked and the review screen is
 * closed.
 *
 * The invariant it protects: the run is blocked until this is answered, so
 * the question must never be reachable only from behind a tab. Closing the
 * review is allowed — checking the terminal mid-review is a reasonable thing
 * to want — but it has to leave something on screen that says the run is
 * still waiting, and gets you back in one click.
 */
import { Button, Card, Text } from '@fluentui/react-components';
import { AttentionBadge } from './AttentionBadge.tsx';

export interface PendingDecisionBarProps {
  badge: string;
  title: string;
  onOpen: () => void;
}

export function PendingDecisionBar({ badge, title, onOpen }: PendingDecisionBarProps) {
  return (
    <Card
      data-testid="pending-decision-bar"
      style={{ borderColor: 'var(--colorPaletteDarkOrangeBorderActive)', width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <AttentionBadge label={badge} />
        <Text weight="semibold" style={{ flex: '1 1 12ch', minWidth: 0, overflowWrap: 'anywhere' }}>{title}</Text>
        <Button
          appearance="primary"
          data-testid="pending-decision-open"
          style={{ marginLeft: 'auto', flexShrink: 0 }}
          onClick={onOpen}
        >
          Review &amp; decide
        </Button>
      </div>
    </Card>
  );
}
