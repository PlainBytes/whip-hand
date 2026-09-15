/**
 * "Someone is waiting on you" — warning-coloured and filled, deliberately not
 * a StatusBadge (which falls back to grey).
 */
import { Badge } from '@fluentui/react-components';
import { WAITING_BADGE_COLOR } from '../lib/status-style.ts';

export interface AttentionBadgeProps {
  /** Badge register — from AWAIT_LABEL / manualLabel, never written inline. */
  label: string;
  /** Render as a bare dot with `label` as its accessible name. */
  compact?: boolean;
  'data-testid'?: string;
}

export function AttentionBadge({ label, compact, 'data-testid': testId }: AttentionBadgeProps) {
  if (compact) {
    return (
      <Badge
        color={WAITING_BADGE_COLOR}
        appearance="filled"
        size="tiny"
        aria-label={label}
        data-testid={testId}
        style={{ marginInlineStart: 6 }}
      />
    );
  }
  return (
    <Badge color={WAITING_BADGE_COLOR} appearance="filled" data-testid={testId}>
      {label}
    </Badge>
  );
}
