/**
 * What the run page shows while a decision is parked and the review screen is
 * closed.
 *
 * The invariant it protects is the one ManualStepCard used to carry in its
 * "Outside the tabs on purpose" comment: the run is blocked until this is
 * answered, so the question must never be reachable only from behind a tab.
 * Closing the review is allowed — checking the terminal mid-review is a
 * reasonable thing to want — but it has to leave something on screen that says
 * the run is still waiting, and gets you back in one click.
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
      style={{ borderColor: 'var(--colorPaletteDarkOrangeBorderActive)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <AttentionBadge label={badge} />
        <Text weight="semibold">{title}</Text>
        <Button
          appearance="primary"
          data-testid="pending-decision-open"
          style={{ marginLeft: 'auto' }}
          onClick={onOpen}
        >
          Review &amp; decide
        </Button>
      </div>
    </Card>
  );
}
